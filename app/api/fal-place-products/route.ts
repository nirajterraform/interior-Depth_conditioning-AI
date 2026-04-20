// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { fal, uploadToFal, falUrlToDataUri } from "@/lib/falClient";
import { withGeminiRetry } from "@/lib/geminiRetry";

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});

// Thresholds calibrated to what FLUX can actually achieve after Fix 4 stricter Gemini prompt.
// rembg=91/84 on passing visual tests → geometry merged at 81 with old weights.
// MIN_GEOMETRY_SCORE lowered to 72: large rug changes can lower rembg background score even when
// walls/ceiling/fireplace are intact. Gemini architectural scoring is the real gate.
const MIN_GEOMETRY_SCORE = 72;
// Minimum raw Gemini geometry score — prevents rembg from inflating the merged score past the
// acceptance threshold when Gemini detects a major structural change (floor material, wall repaint,
// camera shift). Example: gemini=46, rembg=89 → merged=74 (passes!) but floor clearly changed.
// At 55 threshold, ~45pts of deductions are allowed (roughly 1 critical + 1 minor issue).
// Was 68 but that over-penalised intentional style material changes (carpet→natural rug for Japandi)
// where rembg confirms structural geometry is preserved. 55 gates out true failures (gemini<50)
// while accepting runs where only surface materials shifted.
const MIN_GEMINI_GEOMETRY = 55;
const MIN_CATALOGUE_AVG = 50; // recalibrated: relaxed scoring means 50-70 is achievable for text-only FLUX style matches
const MAX_ATTEMPTS = 3;
// Run targeted edit loop when Pass 1 catalogue is below this — product images are then used per-item
const TARGETED_EDIT_CATALOGUE_THRESHOLD = 65;

// ─── Utilities ────────────────────────────────────────────────────────────────

function stripDataUrlPrefix(input: string): string {
  const idx = input.indexOf(",");
  return idx >= 0 ? input.slice(idx + 1) : input;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

async function resizeDataUri(
  dataUri: string,
  maxSide = 1280
): Promise<{ dataUri: string; width: number; height: number }> {
  const raw = Buffer.from(stripDataUrlPrefix(dataUri), "base64");
  const meta = await sharp(raw).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 768;
  const scale = Math.min(maxSide / width, maxSide / height, 1);
  const outW = Math.max(512, Math.round((width * scale) / 16) * 16);
  const outH = Math.max(512, Math.round((height * scale) / 16) * 16);
  const resized = await sharp(raw)
    .resize(outW, outH, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
  return {
    dataUri: `data:image/jpeg;base64,${resized.toString("base64")}`,
    width: outW,
    height: outH,
  };
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) {
        if (attempt < 3) continue;
        return null;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch {
      if (attempt < 3) continue;
      return null;
    }
  }
  return null;
}

async function fetchRemoteImageAsDataUri(imageUrl: string): Promise<string | null> {
  // Retry up to 3 times with 45s timeout — GCP VM may be slower to reach Shopify CDN
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(imageUrl, { signal: AbortSignal.timeout(45000) });
      if (!res.ok) {
        console.warn(`Failed to fetch product image (attempt ${attempt}): ${imageUrl} (${res.status})`);
        if (attempt < 3) continue;
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const mimeType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      return `data:${mimeType};base64,${buf.toString("base64")}`;
    } catch (err) {
      console.warn(`Failed to fetch product image (attempt ${attempt}): ${imageUrl}`, err);
      if (attempt < 3) continue;
      return null;
    }
  }
  return null;
}

// FIX: was slice(0, 4) — silently dropped products when user selected up to 6.
// Normalizes DB category values to a canonical dedup key so that variant spellings
// of the same furniture type are treated as the same slot (e.g. "area_rug" === "rug").
// This prevents two rugs (or two lamps) with different DB category names from both
// passing through dedup and wasting product slots.
// Maps theme name variants to the canonical style_tag stored in the DB.
// This allows "Bohemian" (from detect-room-type) to match style_tag "boho",
// and custom themes (e.g. "Spanish", "coastal", "japandi") to fall through without a match.
// Tag values must exactly match the style_tags_json values stored in the DB.
// "coastal" and "japandi" tags are created by data-fixes-v2.sql — must match those exact strings.
const THEME_TO_STYLE_TAG: [RegExp, string][] = [
  [/\bboho\b|bohemian/i,                 "boho"],
  [/\bmid[\s_-]?century\b|\bmcm\b/i,     "mid_century"],
  [/\bscandinavian\b|\bscandi\b/i,        "scandinavian"],
  [/\bindustrial\b/i,                     "industrial"],
  [/\bluxury\b|\bglam\b/i,               "luxury"],
  [/\bcoastal\b|\bhamptons\b/i,          "coastal"],
  [/\bjapandi\b/i,                        "japandi"],
  [/\bfarmhouse\b|\bcottage\b/i,          "farmhouse"],
  [/\bclassic\b|\btraditional\b/i,        "classic"],
  [/\bminimalist\b|minimalism/i,          "minimalist"],
  [/\bmodern\b|\bcontemporary\b/i,        "modern"],
];

function normalizeThemeToStyleTag(theme: string): string | null {
  for (const [pattern, tag] of THEME_TO_STYLE_TAG) {
    if (pattern.test(theme)) return tag;
  }
  return null; // custom/unknown theme — no style_tag match
}

function normalizeForDedup(cat: string): string {
  const c = cat.toLowerCase().replace(/[_\s]+/g, " ").trim();
  if (/\brug\b|carpet|flatweave|kilim|runner\b|area rug/.test(c)) return "rug";
  if (/\bsofa\b|couch|sectional|loveseat/.test(c)) return "sofa";
  if (/\bchair\b|armchair|accent chair/.test(c)) return "chair";
  if (/\blamp\b|lighting\b|sconce|chandelier|pendant/.test(c)) return "lamp";
  if (/\btable\b|desk\b/.test(c)) return "table";
  if (/\bcabinet\b|shelf\b|sideboard|tv stand|bookcase/.test(c)) return "cabinet";
  if (/\bbed\b|mattress|headboard/.test(c)) return "bed";
  return c;
}

function deduplicateByCategory(
  products: Array<{ title: string; category: string; imageUrl: string; productHandle?: string; styleTags?: string[] }>,
  theme = ""
) {
  // Group by normalized category, keeping the best style-match per slot.
  // Scoring priority:
  //   1. style_tags_json match (curated DB data) — score 10, beats any title keyword
  //   2. Title keyword match — score 1 per word (fallback for custom themes like "Spanish")
  // When scores tie (e.g. both lamps have style_tag "boho"), retrieval order wins —
  // the first item was ranked higher by embedding similarity to the query.
  // For unknown themes, neither product gets a style_tag hit so embedding order decides.
  const normalizedStyleTag = normalizeThemeToStyleTag(theme);
  const themeWords = theme.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const byCategory = new Map<string, typeof products[number]>();
  const collisions: Array<{ cat: string; kept: string; dropped: string; keptScore: number; droppedScore: number }> = [];

  const scoreItem = (item: typeof products[number]) => {
    const tags = (item.styleTags || []).map((s) => s.toLowerCase());
    const styleScore = normalizedStyleTag && tags.includes(normalizedStyleTag) ? 10 : 0;
    // Title keywords only count when there's no style_tag match — avoids gaming by
    // products that embed the theme name in their title (e.g. "Bohemian Wooden Lamp")
    const titleScore = styleScore === 0
      ? themeWords.reduce((s, w) => s + (item.title.toLowerCase().includes(w) ? 1 : 0), 0)
      : 0;
    return styleScore + titleScore;
  };

  for (const p of products) {
    const cat = normalizeForDedup(String(p.category || "furniture"));
    const existing = byCategory.get(cat);
    if (!existing) {
      byCategory.set(cat, p);
    } else {
      const newScore = scoreItem(p);
      const existingScore = scoreItem(existing);
      if (newScore > existingScore) {
        collisions.push({ cat, kept: p.title, dropped: existing.title, keptScore: newScore, droppedScore: existingScore });
        byCategory.set(cat, p);
      } else {
        collisions.push({ cat, kept: existing.title, dropped: p.title, keptScore: existingScore, droppedScore: newScore });
      }
    }
  }

  for (const c of collisions) {
    console.log(`Dedup [${c.cat}]: kept "${c.kept}" (score=${c.keptScore}) over "${c.dropped}" (score=${c.droppedScore})`);
  }

  return [...byCategory.values()];
}

// ─── Step 1: Depth map extraction ─────────────────────────────────────────────
// Extracts a depth map from the room image using fal-ai depth estimation.
// This map is passed as an extra reference to flux-2-pro/edit, giving the model
// an explicit 3-D structure signal and dramatically reducing geometry drift.
// Fails gracefully — if the model is unavailable we continue without it.
async function extractDepthMap(roomUrl: string): Promise<string | null> {
  try {
    const result = (await fal.subscribe("fal-ai/imageutils/depth", {
      input: { image_url: roomUrl },
    })) as any;
    const url = result?.data?.image?.url || null;
    if (url) console.log("Depth map extracted:", url);
    return url;
  } catch (err) {
    console.warn("Depth extraction failed — proceeding without depth conditioning:", err);
    return null;
  }
}

// ─── Step 2: Gemini visual product descriptions ───────────────────────────────
// For each product we use Gemini Vision to write a concise visual description
// (material, colour, silhouette, style) that is injected into the generation
// prompt. This compensates for the fact that a depth-conditioned model takes
// only one control image, not multiple reference product images.
async function describeProductVisually(
  imageUrl: string,
  title: string,
  category: string
): Promise<string> {
  try {
    const buffer = await fetchBuffer(imageUrl);
    if (!buffer) return `${title} — ${category}`;

    const response = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  `Describe this ${category} furniture product in 1–2 sentences for use as a text-to-image generation reference.`,
                  `Focus ONLY on: material, dominant colour, silhouette/shape, surface texture, and key style cues.`,
                  `Product name for context: "${title}".`,
                  `Return only the description — no title, no prefix, no explanation.`,
                ].join(" "),
              },
              { inlineData: { mimeType: "image/jpeg", data: buffer.toString("base64") } },
            ],
          },
        ],
      })
    );

    const text = (response?.candidates?.[0]?.content?.parts || [])
      .filter((p: any) => typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("")
      .trim();

    return text || `${title} — ${category}`;
  } catch (err) {
    console.warn(`Product description failed for "${title}":`, err);
    return `${title} — ${category}`;
  }
}

// ─── Known-theme detection ───────────────────────────────────────────────────
// All theme keywords recognised by the predefined directive map below.
// If a user-supplied theme string does NOT match any of these, it is "custom"
// and we generate a rich directive via Gemini instead of using the generic fallback.
const KNOWN_THEME_KEYS = [
  "cozy", "cosy", "warm cozy", "cozy beautiful", "comfortable",
  "scandi", "scandinavian",
  "japandi",
  "coastal", "beach", "nautical",
  "luxury", "luxurious", "elegant", "opulent",
  "industrial",
  "bohemian", "boho",
  "mid_century", "mid century", "midcentury",
  "modern", "contemporary",
  "farmhouse", "rustic",
  "minimalist", "minimal",
];

// Themes that have predefined keywords but lack full bedroom protections
// (no skipInspire, no curtain lock, no scope restriction). For bedroom,
// these are treated as custom so Gemini generates a proper directive.
// For other rooms they remain "known" and use the predefined directive.
const BEDROOM_INCOMPLETE_THEMES = ["cozy", "cosy", "warm cozy", "cozy beautiful", "comfortable", "industrial", "farmhouse", "rustic", "minimalist", "minimal"];

function isKnownTheme(theme: string, roomType?: string): boolean {
  const lower = theme.toLowerCase();
  if (roomType === "bedroom" && BEDROOM_INCOMPLETE_THEMES.some((k) => lower.includes(k))) {
    return false; // treat as custom for bedroom — Gemini will generate a richer directive
  }
  return KNOWN_THEME_KEYS.some((k) => lower.includes(k));
}

// ─── Gemini custom-theme interpreter ─────────────────────────────────────────
// For free-text themes ("indian", "tropical", "art deco", etc.) that don't match
// any predefined keyword, we ask Gemini to produce a rich directive in the same
// format as the hand-crafted ones. This runs once, early in the pipeline, and the
// result is injected into the FLUX prompt.
// Also returns the closest predefined theme name for catalogue slot-query mapping.
const CLOSEST_THEMES = ["modern", "scandi", "japandi", "coastal", "luxury", "boho", "mid_century", "industrial", "farmhouse", "minimalist", "cozy"] as const;

async function interpretCustomTheme(
  theme: string,
  roomType: string
): Promise<{ directive: string; closestTheme: string }> {
  try {
    const room = roomType.replace(/_/g, " ");
    const response = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  `You are an expert interior designer. A user wants to style their ${room} in the theme: "${theme}".`,
                  ``,
                  `Task 1 — Theme Directive (for a text-to-image AI):`,
                  `Write a detailed furniture-and-decor directive in 3-5 sentences covering:`,
                  `• Colour palette (specific colours, applied ONLY to furniture, upholstery, soft furnishings, and decorative accents)`,
                  `• Materials and textures (wood type, fabric, metal finish, etc.)`,
                  `• Furniture silhouette and style cues`,
                  `• Mood and feel`,
                  ``,
                  `CRITICAL RULES for the directive:`,
                  `• The palette must ONLY apply to movable furniture, upholstery, soft furnishings, and decorative accessories`,
                  `• Do NOT apply any colour or material change to walls, ceiling, floor, curtains, or blinds — those are LOCKED to match the original room`,
                  `• End with: "CRITICAL: Walls stay their original colour. Floor stays its original material. Curtains stay unchanged. The theme palette is applied ONLY to movable furniture and soft furnishings."`,
                  ``,
                  `Task 2 — Closest Predefined Theme:`,
                  `Pick the single closest match from this list: ${CLOSEST_THEMES.join(", ")}`,
                  ``,
                  `Return EXACTLY this JSON format (no markdown, no explanation):`,
                  `{"directive": "...", "closestTheme": "..."}`,
                ].join("\n"),
              },
            ],
          },
        ],
      })
    );

    const text = (response?.candidates?.[0]?.content?.parts || [])
      .filter((p: any) => typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("")
      .trim();

    // Parse JSON — strip markdown fences if present
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const directive = typeof parsed.directive === "string" ? parsed.directive : "";
    const closestTheme = CLOSEST_THEMES.includes(parsed.closestTheme) ? parsed.closestTheme : "modern";

    if (!directive) throw new Error("Empty directive from Gemini");

    console.log(`[Custom theme] "${theme}" → directive (${directive.length} chars), closest="${closestTheme}"`);
    return { directive, closestTheme };
  } catch (err) {
    console.warn(`[Custom theme] Gemini interpretation failed for "${theme}":`, err);
    // Fallback: generic directive + modern catalogue
    return {
      directive: `Apply a ${theme} aesthetic through furniture material, colour palette and soft furnishing textures. Express the theme ONLY through movable furniture, upholstery, and decorative accessories. CRITICAL: Walls stay their original colour. Floor stays its original material. Curtains stay unchanged. The theme palette is applied ONLY to movable furniture and soft furnishings.`,
      closestTheme: "modern",
    };
  }
}

// ─── Theme directive ──────────────────────────────────────────────────────────
// Returns specific colour, material and mood cues for each theme.
// These are injected into the generation prompt so FLUX applies the aesthetic
// through furniture and soft furnishings WITHOUT touching room architecture.
function buildThemeDirective(theme: string, customDirective?: string): string {
  // If a pre-computed custom directive was provided (from Gemini), use it directly
  if (customDirective) return customDirective;
  const lower = theme.toLowerCase();

  // Keyword map — checked against the full theme string so multi-word custom
  // themes like "cozy beautiful living room" or "warm japandi with oak tones"
  // still get the right directive. First match wins.
  const keywords: Array<{ keys: string[]; directive: string }> = [
    {
      keys: ["cozy", "cosy", "warm cozy", "cozy beautiful", "comfortable"],
      directive: "Palette: warm terracotta, burnt amber, creamy ivory, soft caramel, dusty rose accents. Materials: chunky knit throws, plush velvet cushions, warm oak wood, shearling, soft boucle upholstery, woven wool rug. Feel: snug, inviting, lived-in warmth — layered textures, soft lighting, oversized cushions, nothing sharp or cold. Every surface should feel touchable and warm.",
    },
    {
      keys: ["scandi", "scandinavian"],
      directive: "Palette: warm white, soft oat, pale birch, light ash grey — applied ONLY to furniture upholstery, soft furnishings, and decorative accents. Do NOT apply warm white, oat, or any Scandinavian tonal shift to walls, ceiling, or floor — those are LOCKED to match @image1 exactly. Sofa: clean straight-arm profile, warm white or oat upholstery in textured linen or soft wool bouclé, solid light birch or ash wood legs. Coffee table: light birch or ash wood, rectangular with simple clean edges, no dark finishes. Rug: natural wool in oat, ivory or soft grey, simple texture or very subtle stripe pattern — no bold prints — placed ON TOP of the existing floor (floor material itself does NOT change). Lamp: natural birch wood base or brushed matte white metal, white linen drum shade — simple upright silhouette with no ornamentation. Cabinet/TV stand: light birch or ash veneer, flat-front doors, minimal recessed or bar pulls in matte white or brushed nickel. Curtains/blinds: LOCKED — keep the exact same curtains or blinds visible in @image1, do NOT change their colour, material, or style. Feel: hygge warmth, light-filled, every piece functional and gentle — pale natural wood throughout, never dark or heavy. CRITICAL: Walls stay their original colour. Floor stays its original material. Curtains stay unchanged. The theme palette is applied ONLY to movable furniture and soft furnishings.",
    },
    {
      keys: ["japandi"],
      directive: "Palette: warm stone beige, soft ivory, ash grey, natural walnut brown — NO bright colours, NO pastels, NO dark floors. Furniture upholstery: warm stone or charcoal linen/bouclé — applied ONLY to fabric surfaces on furniture, NEVER to the floor. Sofa/seating: low-profile, straight tight arms, warm stone upholstery in linen or bouclé, short solid wood legs in walnut or oak. Coffee table/side table: solid walnut or light oak, rectangular with clean straight edges. Rug: natural jute, ivory wool or simple geometric pattern in muted tones — placed ON TOP of the existing floor (floor material itself does NOT change). Lamp/lighting: ceramic base or washi paper shade, warm soft glow, simple minimal silhouette. Dresser/storage: light oak or walnut veneer, flat-front drawers, minimal hardware. Bedding: natural linen, ivory or soft grey. Curtains/blinds: LOCKED — keep the exact same curtains or blinds visible in @image1, do NOT change their colour, material, or style. Feel: wabi-sabi calm, low-profile furniture, generous negative space, every piece intentional and understated. CRITICAL: Walls stay their original colour. Floor stays its original material. Curtains stay unchanged. The theme palette applies ONLY to movable furniture pieces and soft furnishings.",
    },
    {
      keys: ["coastal", "beach", "nautical"],
      directive: "Palette: crisp white, sandy beige, soft ocean blue, seafoam green — applied ONLY to furniture upholstery, soft furnishings, and decorative accents. Do NOT apply white, sandy beige, or any coastal tonal shift to walls, ceiling, or floor — those are LOCKED to match @image1 exactly. Sofa: white or sandy linen upholstery, slipcovered or tight back, natural wood legs in whitewashed or driftwood finish — the whitewashed/driftwood finish applies ONLY to furniture legs, NOT to the floor. Coffee table: round or rectangular, whitewashed oak or rattan base with glass top. Rug: natural jute, woven seagrass or blue-and-white stripe pattern — placed ON TOP of the existing floor (floor material itself does NOT change — carpet stays carpet, wood stays wood, tile stays tile). Lamp: whitewashed wood base or rattan weave base, white linen drum shade. Cabinet/TV stand: white painted wood or whitewashed finish, simple panelled doors, brushed nickel hardware. Curtains/blinds: LOCKED — keep the exact same curtains or blinds visible in @image1, do NOT change their colour, material, or style. Feel: relaxed, sun-bleached, breezy — every piece should look like it belongs in a beach house. CRITICAL: Walls stay their original colour. Floor stays its original material. Curtains stay unchanged. The theme palette is applied ONLY to movable furniture and soft furnishings.",
    },
    {
      keys: ["luxury", "luxurious", "elegant", "opulent"],
      directive: "Palette: champagne gold, ivory, rich jewel tones (burgundy, deep navy) — applied ONLY to furniture upholstery, soft furnishings, and decorative accents. Do NOT apply dark or rich colours to walls, ceiling, or floor — those are LOCKED to match @image1 exactly. Materials: velvet or silk upholstery on furniture, polished brass or gold accents, lacquered or mirrored furniture surfaces, marble-top accessories. Rug: any opulent pile rug placed ON TOP of the existing floor (floor material itself does NOT change — carpet stays carpet, wood stays wood, tile stays tile). Curtains/blinds: LOCKED — keep the exact same curtains or blinds visible in @image1, do NOT change their colour, material, or style. Feel: opulent, layered, statement pieces, Hollywood glamour — every piece feels expensive and intentional. CRITICAL: Walls stay their original colour. Floor stays its original material. Curtains stay unchanged. The theme palette is applied ONLY to movable furniture and soft furnishings.",
    },
    {
      keys: ["industrial"],
      directive: "Palette: dark grey, matte black, raw concrete tone, warm amber, burnt orange accents. Materials: exposed steel frames, reclaimed wood, concrete, leather, Edison bulb lighting. Feel: urban loft, raw edges, utilitarian but stylish.",
    },
    {
      keys: ["bohemian", "boho"],
      directive: "Palette: terracotta, warm ochre, dusty rose, deep teal, camel and natural linen — rich and earthy throughout, applied ONLY to furniture, rugs, cushions, and decorative accessories. Do NOT apply earthy tones to walls, ceiling, or floor — those are LOCKED to match @image1 exactly. Sofa: low-profile with loose cushions, terracotta or camel upholstery in textured linen or cotton, solid mango wood or rattan-wrapped legs. Coffee table: round or irregular, natural rattan, wicker or solid mango wood top, no glass. Rug: large patterned kilim or flatweave in terracotta, ochre and teal — bold geometric or tribal pattern, placed ON TOP of the existing floor (floor material itself does NOT change — carpet stays carpet, wood stays wood, tile stays tile). Lamp: rattan weave or woven seagrass base, off-white or terracotta fabric shade — organic handcrafted look. Cabinet/TV stand: solid mango wood or distressed teak, open shelving or cane-front panels, antique brass or iron hardware. Curtains/blinds: LOCKED — keep the exact same curtains or blinds visible in @image1, do NOT change their colour, material, or style. Feel: globally inspired, handcrafted and layered — every piece looks collected over time, warm and inviting. CRITICAL: Walls stay their original colour. Floor stays its original material. Curtains stay unchanged. The theme palette is applied ONLY to movable furniture and soft furnishings.",
    },
    {
      keys: ["mid_century", "mid century", "midcentury"],
      directive: "Palette: warm walnut brown, mustard yellow, burnt orange, olive green, off-white — saturated retro tones applied ONLY to furniture upholstery, soft furnishings, and decorative accents. Do NOT apply mustard, orange, olive, walnut, or any warm golden tint to walls, ceiling, or floor — those surfaces are LOCKED to match @image1 exactly (if walls are cool grey in @image1, they MUST stay cool grey — do NOT warm-shift them). Sofa: low-profile with tight back, mustard yellow or burnt orange upholstery in velvet or textured wool, solid walnut or teak wood legs tapered at 45°. Coffee table: solid walnut or teak top, tapered solid wood legs — no hairpin legs, no glass top. Rug: low-pile in warm ivory or ochre, simple geometric or abstract pattern — placed ON TOP of the existing floor (floor material itself does NOT change — carpet stays carpet, wood stays wood, tile stays tile). Lamp: solid walnut wood base or brushed brass tripod, drum or cone shade in warm off-white or mustard fabric. Cabinet/TV stand: solid walnut or teak veneer, long low sideboard profile with tapered legs, simple bar pulls in brushed brass. Curtains/blinds: LOCKED — keep the exact same curtains or blinds visible in @image1, do NOT change their colour, material, or style. Feel: 1950s–60s American modernism — every piece has tapered legs, organic warmth, and confident retro character. CRITICAL: Walls stay their EXACT original colour (no warm-shifting). Floor stays its original material. Curtains stay unchanged. The theme palette is applied ONLY to movable furniture and soft furnishings.",
    },
    {
      keys: ["modern", "contemporary"],
      directive: "Palette: warm white, greige, soft taupe, matte black accents, natural oak or walnut highlights — applied ONLY to furniture, upholstery, and decorative accents. Do NOT apply greige, taupe, or any tonal shift to walls, ceiling, or floor — those are LOCKED to match @image1 exactly. NO grey-on-grey, NO cold tones on furniture. Sofa: clean straight lines, track arms or low tight arms, white/cream/greige upholstery in smooth fabric or performance linen, solid wood or metal legs. Coffee table: rectangular with lower shelf, natural oak top with matte black metal frame, or solid white lacquered top. Rug: low-pile in warm ivory, soft grey or subtle geometric pattern — no busy prints, placed ON TOP of the existing floor (floor material itself does NOT change — carpet stays carpet, wood stays wood, tile stays tile). Lamp: matte black metal base, white or off-white drum shade, clean silhouette with no ornamentation. Cabinet/TV stand: flat-front white or oak veneer, long low profile, simple bar pulls in matte black or brushed brass. Curtains/blinds: LOCKED — keep the exact same curtains or blinds visible in @image1, do NOT change their colour, material, or style. Feel: refined simplicity, every piece purposeful — warm and liveable, not cold or sterile. CRITICAL: Walls stay their original colour. Floor stays its original material. Curtains stay unchanged. The theme palette is applied ONLY to movable furniture and soft furnishings.",
    },
    {
      keys: ["farmhouse", "rustic"],
      directive: "Palette: warm white, natural linen, barn red accents, distressed wood tones. Materials: shiplap-inspired textures, galvanized metal, weathered timber, cotton, wicker. Feel: country warmth, handcrafted, unpretentious, relaxed family living.",
    },
    {
      keys: ["minimalist", "minimal"],
      directive: "Palette: pure white, soft off-white, nude, warm light grey. Materials: smooth concrete, pale oak, linen, glass. Feel: extreme restraint, only essential pieces, generous empty space, calming silence.",
    },
  ];

  for (const { keys, directive } of keywords) {
    if (keys.some((k) => lower.includes(k))) return directive;
  }

  return `Apply a ${theme} aesthetic through furniture material, colour palette and soft furnishing textures.`;
}

// ─── Room-specific furniture/staging section ──────────────────────────────────
// Returns the FURNITURE RESTYLE + staging richness + placement + scale + lamp +
// strict rules + final geometry check + OUTPUT line for a given room type.
// Called from buildStrictEditPrompt so each room gets purpose-built guidance
// instead of the generic living-room prompt.
function buildRoomFurnitureSection(
  roomType: string,
  theme: string,
  productLines: string[]
): string[] {
  // ── Kitchen ────────────────────────────────────────────────────────────────
  if (roomType === "kitchen") {
    return [
      `═══ KITCHEN STYLING — dramatic transformation ═══`,
      `Replace the existing movable items in @image1 with freshly styled, theme-appropriate kitchen pieces.`,
      `Stage the kitchen as a professional interior design shoot — dramatic, rich, aspirational.`,
      `IMPORTANT: Replace movable items only. Do NOT touch built-in cabinetry, countertops, appliances, splashback, or any fixed element.`,
      ``,
      `Furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must contribute to the wow factor:`,
      `• Bar stools: place at the kitchen island or breakfast bar counter — stools pushed up to the counter, seat height level with the counter overhang. Do NOT place stools randomly on the floor away from any surface.`,
      `• Pendant light / lamp: hang directly above the island or counter — centred, 60–80cm above the counter surface. Do NOT place as a floor lamp or table lamp.`,
      `• Counter decor: place vase, plant, tray, or decorative object ON the countertop surface — not on the floor, not floating. One or two tasteful pieces only.`,
      `• Kitchen chair: place at a small table or breakfast nook if one exists — if no table is visible, omit the chair rather than placing it randomly.`,
      `• Storage unit / open shelf: place against a wall, fully freestanding, NOT built-in. Max height 150cm.`,
      `• Rich lighting atmosphere — warm, inviting kitchen feel. Pendant light over island is the lighting hero.`,
      `• Every visible surface should feel intentionally styled — clean, curated, beautiful.`,
      ``,
      `Placement guidance:`,
      `• Island / breakfast bar: primary anchor — stools go HERE, pendant hangs ABOVE here`,
      `• Countertops: secondary surface — decor objects placed here sparingly`,
      `• Wall: storage unit or open shelf placed flat against a wall`,
      `• Do NOT place any item in front of appliances (fridge, oven, dishwasher) — must remain accessible`,
      `• Do NOT add a rug to a kitchen — kitchens have hard flooring only`,
      `• Do NOT place sofas, coffee tables, or living room furniture in a kitchen`,
      ``,
      `═══ SCALE HIERARCHY — kitchen proportions ═══`,
      `Use the counter height in @image1 as scale anchor (standard counter = 90cm tall).`,
      `• Bar stools: seat height 60–75cm — must NOT be taller than the counter`,
      `• Pendant light: shade 30–50cm wide, hanging 60–80cm above counter — do NOT make oversized`,
      `• Counter decor (vase, plant): max 40cm tall — must sit clearly ON the counter`,
      `• Storage unit: max 150cm tall, 60–90cm wide — freestanding against wall`,
      `• When in doubt, render an item slightly SMALLER rather than larger`,
      `• Violating these scale rules will cause rejection`,
      ``,
      `═══ KITCHEN LAMP PLACEMENT RULES — strictly enforced ═══`,
      `• Pendant: MUST hang from the ceiling above the island or counter. Not on a surface. Not on the floor.`,
      `• The pendant cord/chain must visibly connect to the ceiling — do NOT show it floating.`,
      `• A pendant placed anywhere other than above a counter/island will cause immediate rejection.`,
      ``,
      `STRICT KITCHEN PLACEMENT RULES — violations will cause rejection:`,
      `• DOOR & PASSAGE: No furniture in front of any door or walkway`,
      `• APPLIANCES: Fridge, oven, dishwasher must remain fully visible and unobstructed`,
      `• COUNTERTOP: Do NOT cover or replace the countertop — decor sits ON TOP of it`,
      `• CABINETRY: Built-in upper and lower cabinets are LOCKED — do NOT replace, restyle, or remove them`,
      `• SPLASHBACK / BACKSPLASH: tile, stone, or pattern is LOCKED — do NOT change it`,
      `• Do NOT add a kitchen island if one does not exist in @image1`,
      `• All movable items must have clear floor or surface contact and look naturally accessible`,
      ``,
      `═══ FINAL GEOMETRY CHECK — before rendering ═══`,
      `Verify output matches @image1 exactly on: wall positions · window locations · camera angle · room proportions · built-in cabinetry · appliance positions.`,
      `Only movable items change; the kitchen structure does not change at all.`,
      ``,
      `OUTPUT: Photorealistic, editorial-quality kitchen photography. Dramatic transformation of movable pieces and counter styling. Rich, warm, aspirational — like a luxury kitchen design magazine. Consistent lighting from @image1.`,
    ];
  }

  // ── Bedroom ────────────────────────────────────────────────────────────────
  if (roomType === "bedroom") {
    const isLuxury     = /luxury|luxurious|elegant|opulent/i.test(theme);
    const isBoho       = /bohemian|boho/i.test(theme);
    const isMidCentury = /mid[\s_-]?century|midcentury/i.test(theme);
    const isModern     = /modern|contemporary/i.test(theme);
    const isCoastal    = /coastal|beach|nautical/i.test(theme);
    const isJapandi    = /japandi/i.test(theme);
    const isScandi     = /scandi|scandinavian|nordic/i.test(theme);
    return [
      `═══ BEDROOM STYLING — dramatic transformation ═══`,
      `Replace the existing movable furniture in @image1 with freshly styled, theme-appropriate bedroom pieces.`,
      `Stage as a professional interior design shoot — luxurious, restful, aspirational.`,
      `IMPORTANT: Replace furniture only. Do NOT touch walls, windows, floor, ceiling, or any fixed element.`,
      ``,
      `═══ CAMERA & FRAMING LOCK — ABSOLUTE ═══`,
      `The camera position, angle, and framing of @image1 are FIXED and must be reproduced EXACTLY.`,
      `• If @image1 is shot THROUGH A DOORWAY, the output MUST also show the doorway frame, door edges, and hallway walls in the same positions.`,
      `• If @image1 shows partial wall obstruction from the camera's vantage point, the output MUST show the same obstruction.`,
      `• The viewer's position does NOT move — do NOT "step into" the room or recompose the shot.`,
      `• Window positions relative to walls must remain IDENTICAL — do NOT move a window from one wall to another.`,
      `• Violating camera position or framing will cause IMMEDIATE REJECTION.`,
      ``,
      `Furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must contribute to the wow factor:`,
      `• Hero bed: centre on the main wall, headboard flush against wall. Layer with 3–5 pillows, a throw blanket, and duvet/comforter. The bed is the visual anchor of the entire room.`,
      `• Nightstands: one on each side of the bed at mattress height (~55–65cm). Each nightstand holds a table lamp.`,
      `• Bedside table lamps: sitting ON the nightstands — warm ambient glow, shade max 40cm wide.`,
      `• Dresser or chest: against a side or opposite wall — styled with a decorative tray, perfume, or small plant on top.`,
      `• Rug: placed at the foot of the bed, extending under the lower third of the bed frame only. Do NOT cover the entire floor — floor outside the rug boundary must remain visible.`,
      `• Decorative accessories: vase, plant, or sculptural object on nightstand or dresser top. Layered, curated.`,
      `• Rich, warm, calming atmosphere — soft lighting, layered textiles, serene and beautiful.`,
      ``,
      `Placement guidance:`,
      `• Bed: against the main wall, headboard flush to wall, centred in the room's focal zone`,
      `• Nightstands: flanking both sides of the bed`,
      `• Dresser: side wall or opposite wall — never blocking a window or door`,
      `• Rug: foot-of-bed position, partially under the bed frame`,
      `• Do NOT add a sofa, coffee table, or dining furniture to a bedroom`,
      `• Do NOT add a desk unless it is in the product list`,
      ``,
      `═══ SCALE HIERARCHY — bedroom proportions ═══`,
      `Use the door frame as scale anchor (standard door = 200cm tall).`,
      `• Bed: approx 50–70cm tall (mattress + frame) — the largest piece`,
      `• Nightstands: approx 55–65cm tall — level with or just below the mattress top`,
      `• Dresser: approx 80–100cm tall, 90–120cm wide`,
      `• Table lamp on nightstand: shade max 40cm wide, lamp max 70cm above the nightstand surface`,
      `• Floor lamp: max 180cm total height — place in a corner`,
      `• Rug: large enough to extend 30–50cm beyond each side of the bed`,
      `• When in doubt, render an item slightly SMALLER rather than larger`,
      `• Violating these scale rules will cause rejection`,
      ``,
      `═══ LAMP PLACEMENT RULES — bedroom ═══`,
      `• Table lamp: MUST sit ON a nightstand or dresser. NEVER on the floor.`,
      `• Floor lamp: base rests on the floor — place beside the dresser or in a corner.`,
      `• A table lamp placed on the floor will cause immediate rejection.`,
      ``,
      `STRICT BEDROOM PLACEMENT RULES — violations will cause rejection:`,
      `• FLOOR ABSOLUTE LOCK: The floor material visible in @image1 is COMPLETELY LOCKED. Carpet stays carpet. Wood stays wood. Tile stays tile. Do NOT change the floor material or colour for ANY reason — not for theme, not for style. The theme palette applies ONLY to furniture, upholstery, and soft furnishings. A rug sits ON TOP of the existing floor — the floor beneath does NOT change. Changing the floor material will cause IMMEDIATE REJECTION.`,
      `• CURTAIN & BLIND ABSOLUTE LOCK: The curtains, drapes, or blinds visible in @image1 are COMPLETELY LOCKED. Keep their exact colour, material, opacity, and style. Do NOT change sheer curtains to dark curtains. Do NOT change the curtain colour to match the theme. Curtains are part of the room architecture, not furniture. Changing curtains will cause IMMEDIATE REJECTION.`,
      ...(isLuxury ? [
        `• WALL ABSOLUTE LOCK [LUXURY]: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply dark, jewel-toned, or rich colours (burgundy, deep navy, emerald, charcoal, dark grey) to any wall or ceiling. The luxury palette applies ONLY to furniture upholstery, soft furnishings, and decorative accessories. Walls stay their original colour from @image1. Changing any wall colour will cause IMMEDIATE REJECTION.`,
      ] : []),
      ...(isBoho ? [
        `• WALL ABSOLUTE LOCK [BOHO]: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply terracotta, ochre, teal, dusty rose, or any earthy/warm tone to any wall or ceiling. The bohemian palette applies ONLY to furniture, rugs, cushions, and decorative accessories. Walls stay their original colour from @image1. Changing any wall colour will cause IMMEDIATE REJECTION.`,
      ] : []),
      ...(isMidCentury ? [
        `• WALL ABSOLUTE LOCK [MID-CENTURY]: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply mustard, orange, olive, walnut, warm beige, golden tint, or any retro/warm tone to any wall or ceiling. If the walls in @image1 are cool grey, they MUST remain cool grey — do NOT warm-shift them to beige or golden. The mid-century palette applies ONLY to furniture upholstery, soft furnishings, and decorative accessories. Walls stay their EXACT original colour from @image1. Changing any wall colour or temperature will cause IMMEDIATE REJECTION.`,
      ] : []),
      ...(isModern ? [
        `• WALL ABSOLUTE LOCK [MODERN]: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply greige, taupe, warm white, or any tonal shift to any wall or ceiling. The modern palette applies ONLY to furniture upholstery, soft furnishings, and decorative accessories. Walls stay their EXACT original colour from @image1. Changing any wall colour or temperature will cause IMMEDIATE REJECTION.`,
      ] : []),
      ...(isCoastal ? [
        `• WALL ABSOLUTE LOCK [COASTAL]: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply white, sandy beige, seafoam, ocean blue, or any coastal-palette tonal shift to any wall or ceiling. If the walls in @image1 are grey, they MUST stay grey — do NOT lighten or whiten them. The coastal palette applies ONLY to furniture upholstery, soft furnishings, and decorative accessories. Walls stay their EXACT original colour from @image1. Changing any wall colour or temperature will cause IMMEDIATE REJECTION.`,
      ] : []),
      ...(isJapandi ? [
        `• WALL ABSOLUTE LOCK [JAPANDI]: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply warm beige, stone, ivory, or any wabi-sabi tonal shift to any wall or ceiling. If the walls in @image1 are grey, they MUST stay grey — do NOT warm-shift them to beige or ivory. The Japandi palette applies ONLY to furniture upholstery, soft furnishings, and decorative accessories. Walls stay their EXACT original colour from @image1. Changing any wall colour or temperature will cause IMMEDIATE REJECTION.`,
      ] : []),
      ...(isScandi ? [
        `• WALL ABSOLUTE LOCK [SCANDI]: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply warm white, oat, cream, or any Nordic tonal shift to any wall or ceiling. If the walls in @image1 are grey, they MUST stay grey — do NOT lighten or whiten them. The Scandinavian palette applies ONLY to furniture upholstery, soft furnishings, and decorative accessories. Walls stay their EXACT original colour from @image1. Changing any wall colour or temperature will cause IMMEDIATE REJECTION.`,
      ] : []),
      ...(!isLuxury && !isBoho && !isMidCentury && !isModern && !isCoastal && !isJapandi && !isScandi ? [
        `• WALL ABSOLUTE LOCK [GENERAL]: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply any theme-inspired colour, tint, or tonal shift to any wall or ceiling. The theme palette applies ONLY to furniture upholstery, soft furnishings, and decorative accessories. Walls and ceiling must stay their EXACT original colour from @image1. Changing any wall colour or temperature will cause IMMEDIATE REJECTION.`,
      ] : []),
      `• ARCHITECTURAL HALLUCINATION BAN: Do NOT add doors, windows, mirrors, archways, or any architectural element that does not exist in @image1. If @image1 shows a blank wall, it MUST remain a blank wall — do NOT insert a door, mirror, or window into it. Adding non-existent architectural elements will cause IMMEDIATE REJECTION.`,
      `• DOOR & PASSAGE: No furniture in front of any door or walkway`,
      `• BED: Must be against a wall — never floating in the centre of the room`,
      `• NIGHTSTANDS: Must flank the bed — never placed randomly away from it`,
      `• DRESSER: Max 100cm tall — never floor-to-ceiling, never built-in`,
      `• Do NOT place office desks, dining chairs, or sofas in a bedroom`,
      `• All furniture must have clear floor contact and look naturally accessible`,
      ``,
      `═══ FINAL GEOMETRY CHECK — before rendering ═══`,
      `Verify output matches @image1 exactly on: wall positions · window locations · door locations · camera angle · room proportions.`,
      `Count doors and windows in @image1 — the output MUST have the SAME count. Do NOT add or remove any.`,
      `The furniture changes completely; the room shell does not change at all.`,
      ``,
      `OUTPUT: Photorealistic, editorial-quality bedroom photography. Luxurious, restful, aspirational — like a high-end bedroom design magazine. Rich textiles, warm lighting, beautifully layered. Consistent lighting from @image1.`,
    ];
  }

  // ── Kids Room ──────────────────────────────────────────────────────────────
  if (roomType === "kids_room") {
    const t = theme.toLowerCase();

    const isScandi   = /scandi|scandinavian|nordic/i.test(t);
    const isCoastal  = /coastal|beach|nautical/i.test(t);
    const isBoho     = /boho|bohemian/i.test(t);
    // modern = default

    const themeVibe = isScandi
      ? "calm, serene, minimal Nordic — white pine furniture, natural textures, soft warm light, muted palette with gentle natural accents"
      : isCoastal
      ? "breezy, light-filled coastal — white and natural wood, blue-teal accents, rattan textures, sandy warmth, relaxed and fresh"
      : isBoho
      ? "eclectic, layered bohemian — rattan, macramé, warm terracotta and earthy tones, colourful pattern-mix bedding, abundant texture"
      : "clean, bold contemporary — crisp whites and greys with one strong colour accent, geometric shapes, modern materials, graphic rug";

    const bedStyling = isScandi
      ? "Layer with white linen bedding, a natural cotton knit throw, and simple woodland-animal cushions."
      : isCoastal
      ? "Layer with blue-stripe cotton bedding, a sandy linen throw, and seashell or ocean-themed cushions."
      : isBoho
      ? "Layer with rich patterned boho bedding, a woven blanket, macramé cushions, and a colourful lumbar pillow."
      : "Layer with a bold colour-block duvet, a geometric cushion, and a contrasting throw.";

    const rugStyling = isScandi
      ? "A round cream or grey cotton play rug — soft underfoot, defines the activity zone."
      : isCoastal
      ? "A blue-teal stripe or jute rug — brings the coastal palette to the floor, adds texture."
      : isBoho
      ? "A large, colourful patterned boho rug — the most eye-catching element on the floor."
      : "A bold geometric or colour-blocked rug — makes the floor a design statement.";

    const atmosphereDirective = isScandi
      ? "Atmosphere: calm, light-filled Nordic sanctuary — like a page from a Scandinavian children's design book. Soft daylight, white walls enhanced, natural wood grain visible, peaceful and beautiful."
      : isCoastal
      ? "Atmosphere: sun-drenched coastal retreat — like a premium beach-house kids room. Bright natural light, fresh blue-and-white palette, airy and relaxed yet beautifully styled."
      : isBoho
      ? "Atmosphere: warm, vibrant bohemian paradise — like an editorial shoot for a luxury boho children's brand. Rich layered textures, amber lamp glow, eclectic but curated, deeply inviting."
      : "Atmosphere: sharp, confident contemporary — like a high-end modern kids design studio shoot. Crisp light, bold accent colour pops, graphic shapes, impeccably clean lines.";

    const outputLine = isScandi
      ? `OUTPUT: Photorealistic, editorial-quality Scandinavian kids room. Calm, minimal, beautifully serene — like a top Nordic children's interior magazine. Soft light, natural textures, white and warm wood palette. Wow factor through restraint and perfection of detail. Consistent lighting from @image1.`
      : isCoastal
      ? `OUTPUT: Photorealistic, editorial-quality coastal kids room. Fresh, breezy, sun-filled — like a premium beach-house design spread. Blue-teal and white palette, rattan and natural textures. Wow factor through lightness and effortless coastal charm. Consistent lighting from @image1.`
      : isBoho
      ? `OUTPUT: Photorealistic, editorial-quality bohemian kids room. Rich, layered, full of character — like a luxury boho children's interior editorial. Warm tones, abundant texture, pattern-mix mastery. Wow factor through depth, warmth, and joyful eclecticism. Consistent lighting from @image1.`
      : `OUTPUT: Photorealistic, editorial-quality modern kids room. Bold, crisp, confident — like a leading contemporary children's design magazine. Strong colour accent, geometric forms, impeccable styling. Wow factor through clarity, boldness, and design precision. Consistent lighting from @image1.`;

    return [
      `═══ KIDS ROOM STYLING — ${theme.toUpperCase()} transformation ═══`,
      `Replace the existing movable furniture in @image1 with freshly styled ${theme} kids room pieces.`,
      `Stage as a professional children's interior design editorial — imaginative, safe, aspirational.`,
      `THEME IDENTITY: ${themeVibe}`,
      `IMPORTANT: Replace furniture only. Do NOT touch walls, windows, floor, ceiling, or any fixed element.`,
      ``,
      `═══ CAMERA & FRAMING LOCK — ABSOLUTE ═══`,
      `The camera position, angle, and framing of @image1 are FIXED and must be reproduced EXACTLY.`,
      `• If @image1 is shot THROUGH A DOORWAY, the output MUST also show the doorway frame, door edges, and hallway walls in the same positions.`,
      `• If @image1 shows partial wall obstruction from the camera's vantage point, the output MUST show the same obstruction.`,
      `• The viewer's position does NOT move — do NOT "step into" the room or recompose the shot.`,
      `• Window positions relative to walls must remain IDENTICAL — do NOT move a window from one wall to another.`,
      `• Violating camera position or framing will cause IMMEDIATE REJECTION.`,
      ``,
      `Furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must deliver wow factor:`,
      `• Hero bed: kids single bed against the main wall, headboard flush. ${bedStyling}`,
      `• Storage: bookshelf or toy storage unit against a side wall — styled with books, small toys, and decor objects at child-accessible height. Make shelves look curated, not cluttered.`,
      `• ${rugStyling}`,
      `• Lamp: warm-glowing bedside table lamp on a nightstand — adds intimacy and coziness. If a floor lamp, place in corner, not blocking any path.`,
      `• Wall art or framed print: hang on the wall above the bed or on a side wall — adds personality and completes the look.`,
      `• Accessories: 2–3 decorative objects (plush toy, small plant, ceramic figure) on the bookshelf or nightstand — styled, not random.`,
      ``,
      `${atmosphereDirective}`,
      ``,
      `Placement guidance:`,
      `• Bed: against the main wall, headboard flush to wall`,
      `• Storage / bookshelf: against a side wall, child-accessible height`,
      `• Rug: play area in front of storage or foot-of-bed zone`,
      `• Lamp: on nightstand beside the bed`,
      `• Wall art: centred above the bed or on the accent wall`,
      `• Do NOT add sofas, coffee tables, or dining furniture`,
      `• Keep all pathways clear — children need space to move freely`,
      ``,
      `═══ SCALE HIERARCHY — kids room proportions ═══`,
      `Use the door frame as scale anchor (standard door = 200cm tall).`,
      `• Kids bed: approx 40–60cm tall`,
      `• Bookshelf / storage: approx 80–120cm tall — child-accessible, never above 130cm`,
      `• Nightstand or small table: approx 45–55cm tall`,
      `• Table lamp: shade max 35cm wide, total height max 65cm above surface`,
      `• Floor lamp: max 140cm total height — corner only, away from bed`,
      `• Rug: sized to cover the main activity area`,
      `• When in doubt, render an item slightly SMALLER rather than larger`,
      `• Violating these scale rules will cause rejection`,
      ``,
      `═══ LAMP PLACEMENT RULES — kids room ═══`,
      `• Table lamp: MUST sit ON a nightstand or shelf. NEVER on the floor.`,
      `• Floor lamp: base on floor, placed safely in a corner away from the bed.`,
      `• A table lamp placed on the floor will cause immediate rejection.`,
      ``,
      `STRICT PLACEMENT RULES — violations will cause rejection:`,
      `• FLOOR ABSOLUTE LOCK: The floor material visible in @image1 is COMPLETELY LOCKED. Carpet stays carpet. Wood stays wood. Tile stays tile. Do NOT change the floor material or colour for ANY reason — not for theme, not for style. The theme palette applies ONLY to furniture, upholstery, and soft furnishings. A rug sits ON TOP of the existing floor — the floor beneath does NOT change. Changing the floor material will cause IMMEDIATE REJECTION.`,
      `• CURTAIN & BLIND ABSOLUTE LOCK: The curtains, drapes, or blinds visible in @image1 are COMPLETELY LOCKED. Keep their exact colour, material, opacity, and style. Do NOT change sheer curtains to dark curtains. Do NOT change the curtain colour to match the theme. Curtains are part of the room architecture, not furniture. Changing curtains will cause IMMEDIATE REJECTION.`,
      `• WALL ABSOLUTE LOCK: The wall colour in @image1 is COMPLETELY LOCKED — do NOT apply any theme-inspired colour, tint, or tonal shift to any wall or ceiling. The theme palette applies ONLY to furniture, upholstery, soft furnishings, and decorative accessories. Walls and ceiling must stay their EXACT original colour from @image1. Changing any wall colour or temperature will cause IMMEDIATE REJECTION.`,
      `• ARCHITECTURAL HALLUCINATION BAN: Do NOT add doors, windows, mirrors, archways, or any architectural element that does not exist in @image1. If @image1 shows a blank wall, it MUST remain a blank wall — do NOT insert a door, mirror, or window into it. Adding non-existent architectural elements will cause IMMEDIATE REJECTION.`,
      `• DOOR & PASSAGE: No furniture in front of any door or walkway`,
      `• BED: Must be against a wall — never floating in the centre`,
      `• STORAGE: Low and child-accessible — never above 130cm tall`,
      `• Do NOT place adult furniture (sofas, dining tables, office desks) in a kids room`,
      `• All furniture must look safe, proportionate, and child-appropriate`,
      ``,
      `═══ FINAL GEOMETRY CHECK — before rendering ═══`,
      `Verify output matches @image1 exactly on: wall positions · window locations · door locations · camera angle · room proportions.`,
      `Count doors and windows in @image1 — the output MUST have the SAME count. Do NOT add or remove any.`,
      `The furniture changes completely; the room shell does not change at all.`,
      ``,
      outputLine,
    ];
  }

  // ── Office ─────────────────────────────────────────────────────────────────
  if (roomType === "office") {
    return [
      `═══ HOME OFFICE STYLING — dramatic transformation ═══`,
      `Replace the existing movable furniture in @image1 with freshly styled, theme-appropriate home office pieces.`,
      `Stage as a professional interior design shoot — productive, sophisticated, aspirational.`,
      `IMPORTANT: Replace furniture only. Do NOT touch walls, windows, floor, ceiling, or any fixed element.`,
      ``,
      `Furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must contribute to the wow factor:`,
      `• Hero desk: the centrepiece — large, well-proportioned, positioned facing the room or angled toward a window. Style the desktop with a desk lamp, small plant, and 1–2 tasteful objects (notebook, pen holder, small frame).`,
      `• Office chair: at the desk, pushed up to it as if ready to sit — chair and desk are always together.`,
      `• Bookshelf / storage: against a side wall — styled with books, plants, and decorative objects.`,
      `• Desk lamp: ON the desk surface, casting focused warm light. This is essential — never omit it.`,
      `• Rug: under the desk and chair, grounding the workspace zone. Do NOT cover the entire floor.`,
      `• Decorative accessories: framed art, plant, or vase on shelf or desk corner. Clean and purposeful.`,
      `• Sophisticated, focused, warm atmosphere — professional but beautiful.`,
      ``,
      `Placement guidance:`,
      `• Desk: primary position — facing the room or angled toward a window. Chair directly in front of it.`,
      `• Bookshelf: against a side wall, easily accessible from the desk`,
      `• Rug: under desk and chair, grounding the workspace`,
      `• Do NOT place sofas, beds, or dining furniture in an office`,
      `• One hero desk only — do NOT place multiple desks`,
      ``,
      `═══ SCALE HIERARCHY — office proportions ═══`,
      `Use the door frame as scale anchor (standard door = 200cm tall).`,
      `• Desk: approx 75cm tall, 120–160cm wide — substantial and commanding`,
      `• Office chair: seat height approx 45–55cm, total back height approx 90–110cm`,
      `• Bookshelf: approx 150–180cm tall, 60–90cm wide`,
      `• Desk lamp: shade 25–40cm wide, positioned on the desk — NOT oversized`,
      `• Floor lamp: max 180cm total height — beside the bookshelf or in a corner`,
      `• Rug: sized to fit under desk and chair, extending 30–50cm beyond each side`,
      `• When in doubt, render an item slightly SMALLER rather than larger`,
      `• Violating these scale rules will cause rejection`,
      ``,
      `═══ LAMP PLACEMENT RULES — office ═══`,
      `• Desk lamp: MUST sit ON the desk surface. NEVER on the floor.`,
      `• Floor lamp: base on floor — beside the bookshelf or in a corner.`,
      `• A desk lamp placed on the floor will cause immediate rejection.`,
      ``,
      `STRICT OFFICE PLACEMENT RULES — violations will cause rejection:`,
      `• DOOR & PASSAGE: No furniture in front of any door or walkway`,
      `• DESK: Must have clear space in front for the chair — do NOT push flush to a wall with no chair room`,
      `• CHAIR: Must be at the desk — never placed randomly away from it`,
      `• Do NOT place bedroom furniture (bed, dresser, wardrobe) in an office`,
      `• Do NOT place dining tables or sofas in an office`,
      `• All furniture must have clear floor contact and look naturally accessible`,
      ``,
      `═══ FINAL GEOMETRY CHECK — before rendering ═══`,
      `Verify output matches @image1 exactly on: wall positions · window locations · camera angle · room proportions.`,
      `The furniture changes completely; the room shell does not change at all.`,
      ``,
      `OUTPUT: Photorealistic, editorial-quality home office photography. Sophisticated, productive, aspirational — like a premium workspace design magazine. Clean lines, warm focused lighting, beautifully styled. Consistent lighting from @image1.`,
    ];
  }

  // ── Hallway / Entryway ─────────────────────────────────────────────────────
  if (roomType === "hallway") {
    const t = theme.toLowerCase();
    const isScandi  = /scandi|scandinavian|nordic/i.test(t);
    const isJapandi = /japandi/i.test(t);
    const isCoastal = /coastal|beach|nautical/i.test(t);
    const isLuxury  = /luxury|glam/i.test(t);
    const isMidCen  = /mid[\s_-]?century|midcentury/i.test(t);

    const themeVibe = isScandi  ? "calm Nordic sanctuary — white oak console, round mirror, linen runner, warm minimal lamp. Pure, serene, effortlessly beautiful."
      : isJapandi              ? "wabi-sabi Japanese calm — walnut console, oval wooden mirror, washi paper lamp, natural jute runner. Still, intentional, quietly stunning."
      : isCoastal              ? "breezy coastal welcome — white rattan console, driftwood mirror, ceramic lamp, jute runner. Fresh, light, instantly relaxed."
      : isLuxury               ? "dramatic luxury statement — marble-top console, oversized gold arch mirror, crystal lamp, plush wool runner. Opulent, commanding, unforgettable first impression."
      : isMidCen               ? "retro-modern sophistication — walnut tapered-leg console, sunburst mirror, brass lamp, geometric runner. Warm, characterful, design-forward."
      : "crisp contemporary edge — slim white console, large black-framed mirror, geometric lamp, graphic runner. Bold, clean, impressively modern.";

    const outputLine = isScandi  ? `OUTPUT: Photorealistic, editorial-quality Scandinavian entryway. Calm, white, and warmly minimal — like a top Nordic interior magazine spread. Soft natural light, white oak and linen, round mirror above console. Wow factor through serene perfection. Consistent lighting from @image1.`
      : isJapandi              ? `OUTPUT: Photorealistic, editorial-quality Japandi entryway. Quietly breathtaking — like a Japanese design editorial. Walnut, washi, natural textures, nothing wasted. Wow factor through meditative stillness and material beauty. Consistent lighting from @image1.`
      : isCoastal              ? `OUTPUT: Photorealistic, editorial-quality coastal entryway. Breezy and sun-kissed — like a premium beach-house interior shoot. White rattan, jute, ceramic, natural warmth. Wow factor through effortless lightness. Consistent lighting from @image1.`
      : isLuxury               ? `OUTPUT: Photorealistic, editorial-quality luxury entryway. Jaw-dropping opulence — like a five-star hotel lobby editorial. Marble, gold, crystal, plush wool. Wow factor through commanding scale and material richness. Consistent lighting from @image1.`
      : isMidCen               ? `OUTPUT: Photorealistic, editorial-quality Mid-Century entryway. Warm and characterful — like a design magazine celebrating 1960s modernism. Walnut, brass, sunburst mirror, geometric rug. Wow factor through timeless retro sophistication. Consistent lighting from @image1.`
      : `OUTPUT: Photorealistic, editorial-quality modern entryway. Sharp and confident — like a leading contemporary interior design shoot. Slim console, oversized mirror, graphic runner. Wow factor through precision, boldness, and immaculate styling. Consistent lighting from @image1.`;

    return [
      `═══ ENTRYWAY / HALLWAY STYLING — ${theme.toUpperCase()} transformation ═══`,
      `Replace the existing movable furniture in @image1 with freshly styled ${theme} entryway pieces.`,
      `Stage as a professional interior design editorial — welcoming, elegant, aspirational.`,
      `THEME IDENTITY: ${themeVibe}`,
      `IMPORTANT: Replace furniture only. Do NOT touch walls, floor, ceiling, or doors.`,
      `CRITICAL: A hallway is a narrow passage — ALL furniture must be slim and wall-hugging. NEVER block the walkway.`,
      ``,
      `Furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must deliver wow factor:`,
      `• Console / entry table: slim, flat against the main wall. Top styled with lamp + a curated vase or plant + one small sculptural object. Make the console vignette magazine-worthy.`,
      `• Mirror: hung above the console — round, oval, or arch, proportional and dramatic. The mirror doubles the light and makes the space feel larger and more beautiful.`,
      `• Bench: against a wall (below console or opposite wall) — slim profile, never obstructing passage. Add a folded throw or cushion for warmth.`,
      `• Rug runner: long, narrow, centred along the hallway — adds warmth, colour and direction. Must NOT be wider than 80cm.`,
      `• Table lamp: on the console surface, casting warm golden welcome light — the hero accent.`,
      `• Accessories: 2–3 tasteful objects on the console top — vase, plant, tray, small sculpture. Curated, not cluttered.`,
      ``,
      `Placement guidance:`,
      `• Console: flat against main wall — MAX 40cm deep, never jutting into the walkway`,
      `• Mirror: centred above console on the wall`,
      `• Bench: against a wall — NEVER freestanding in the centre`,
      `• Runner rug: centred lengthwise along the hallway floor — narrow, not a square rug`,
      `• Clear walking path of at least 80cm MUST remain at ALL times`,
      `• Do NOT add sofas, coffee tables, dining furniture, beds, or office desks`,
      ``,
      `═══ SCALE HIERARCHY — hallway proportions ═══`,
      `Use the door frame as scale anchor (standard door = 200cm tall).`,
      `• Console table: approx 80–90cm tall, 90–120cm wide, MAX 40cm deep`,
      `• Bench: approx 45–50cm tall, 90–120cm wide, MAX 40cm deep`,
      `• Mirror: max 100cm wide, 80–150cm tall`,
      `• Table lamp on console: shade max 35cm wide, max 65cm above the console surface`,
      `• Runner rug: 60–80cm wide, full hallway length`,
      `• When in doubt, render slightly SMALLER and SLIMMER`,
      `• Violating these scale rules will cause rejection`,
      ``,
      `═══ LAMP PLACEMENT — hallway ═══`,
      `• Table lamp: MUST sit ON the console surface. NEVER on the floor.`,
      `• If no console in @image1, use a slim wall-adjacent floor lamp in a corner.`,
      ``,
      `STRICT PLACEMENT RULES — violations cause rejection:`,
      `• WALKWAY: Min 80cm clear path at ALL times`,
      `• DOORS: No furniture blocking any door`,
      `• CONSOLE: MAX 40cm depth`,
      `• BENCH: Against wall only — never centre of hallway`,
      `• RUNNER: Narrow max 80cm — never a square room rug`,
      ``,
      `═══ FINAL GEOMETRY CHECK ═══`,
      `Verify output matches @image1 exactly on: wall positions · door locations · camera angle · hallway proportions · floor material.`,
      `The furniture changes completely; the hallway shell does not change at all.`,
      ``,
      outputLine,
    ];
  }

  // ── Foyer / Entryway ────────────────────────────────────────────────────────
  if (roomType === "foyer") {
    const t = theme.toLowerCase();
    const isScandi     = /scandi|scandinavian|nordic/i.test(t);
    const isJapandi    = /japandi/i.test(t);
    const isCoastal    = /coastal|beach|nautical/i.test(t);
    const isLuxury     = /luxury|glam/i.test(t);
    const isIndustrial = /industrial/i.test(t);
    const isMidCen     = /mid[\s_-]?century|midcentury/i.test(t);

    const themeVibe = isScandi     ? "calm Nordic entryway — white oak console, large round mirror, tall arc floor lamp, abstract nature wall art. Pure, airy, beautifully sparse."
      : isJapandi                 ? "Japandi entryway — walnut low console, oval wooden mirror, rattan floor lamp, ink-wash wall art. Serene, intentional, quietly stunning."
      : isCoastal                 ? "coastal entryway vignette — white rattan console, driftwood mirror, rattan floor lamp, ocean-inspired art. Fresh, breezy, sun-drenched."
      : isLuxury                  ? "grand luxury entryway — marble console, oversized gold arch mirror, crystal arc floor lamp, large statement art. Opulent, dramatic, unforgettable."
      : isIndustrial              ? "industrial entryway — black steel reclaimed-wood console, pipe-framed mirror, Edison arc lamp, urban art. Raw, bold, design-forward."
      : isMidCen                  ? "mid-century entryway — walnut tapered console, sunburst mirror, brass arc floor lamp, geometric art. Warm, characterful, timeless."
      : "modern entryway — slim white console, large black-framed mirror, geometric arc floor lamp, bold abstract art. Sharp, confident, contemporary.";

    const outputLine = isScandi     ? `OUTPUT: Photorealistic, editorial-quality Scandinavian foyer / entryway. Calm and minimal — like a top Nordic design magazine. White oak, soft arc lamp, round mirror, nature art. Wow factor through serene restraint and beauty. Consistent lighting from @image1.`
      : isJapandi                 ? `OUTPUT: Photorealistic, editorial-quality Japandi foyer / entryway. Quietly breathtaking — like a Japanese interiors editorial. Walnut, rattan, washi, ink art. Wow factor through stillness and material mastery. Consistent lighting from @image1.`
      : isCoastal                 ? `OUTPUT: Photorealistic, editorial-quality coastal foyer / entryway. Breezy and luminous — like a premium beach-house design spread. White rattan, driftwood, ocean art. Wow factor through lightness and effortless coastal charm. Consistent lighting from @image1.`
      : isLuxury                  ? `OUTPUT: Photorealistic, editorial-quality luxury foyer / entryway. Grand and opulent — like a five-star hotel lobby editorial. Marble, gold, crystal, oversized art. Wow factor through commanding scale and material extravagance. Consistent lighting from @image1.`
      : isIndustrial              ? `OUTPUT: Photorealistic, editorial-quality industrial foyer / entryway. Raw and bold — like an architectural digest feature on industrial design. Steel, reclaimed wood, Edison lighting, urban art. Wow factor through unapologetic material honesty. Consistent lighting from @image1.`
      : isMidCen                  ? `OUTPUT: Photorealistic, editorial-quality Mid-Century foyer / entryway. Warm and sophisticated — like a design magazine celebrating 1960s modernism. Walnut, brass arc lamp, sunburst mirror, geometric art. Wow factor through timeless retro-modern elegance. Consistent lighting from @image1.`
      : `OUTPUT: Photorealistic, editorial-quality modern foyer / entryway. Bold and architectural — like a leading contemporary design magazine. Slim console, oversized mirror, arc lamp, abstract art. Wow factor through precision, drama, and impeccable contemporary styling. Consistent lighting from @image1.`;

    return [
      `═══ FOYER / ENTRYWAY STYLING — ${theme.toUpperCase()} transformation ═══`,
      `Replace the existing movable furniture in @image1 with freshly styled ${theme} foyer / entryway pieces.`,
      `Stage as a professional interior design editorial — dramatic, sophisticated, aspirational.`,
      `THEME IDENTITY: ${themeVibe}`,
      `IMPORTANT: Replace furniture only. Do NOT touch walls, windows, floor, ceiling, or any fixed structural element.`,
      ``,
      `Furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must deliver wow factor:`,
      `• Console / accent table: the anchor piece — styled beautifully with lamp, vase, and 1–2 decorative objects on top. Makes the space feel curated and intentional.`,
      `• Arc floor lamp or tall floor lamp: sweeping over or beside the console, casting warm ambient light. The dramatic statement of the space.`,
      `• Large wall art: hung prominently on the main wall — fills the vertical space, adds personality and depth. Choose scale over timidity.`,
      `• Mirror: large and dramatic — bounces light, makes the space feel expansive and luxurious.`,
      `• Bench or accent chair: against a side wall — adds function and layers the composition.`,
      `• Accessories on console: vase, plant, tray, sculptural object — magazine-worthy vignette.`,
      ``,
      `Placement guidance:`,
      `• Console: against the main or side wall — anchor of the composition`,
      `• Arc lamp: beside or behind the console, arcing over it`,
      `• Wall art: centred on the main wall, hung at eye level (centre at 150cm from floor)`,
      `• Mirror: on a side wall or above the console`,
      `• Bench: against a wall, clear of traffic flow`,
      `• Keep clear walking path through the entryway at all times`,
      `• Do NOT add sofas, dining tables, beds, or kitchen furniture`,
      ``,
      `═══ SCALE HIERARCHY — foyer / entryway proportions ═══`,
      `Use the door frame as scale anchor (standard door = 200cm tall).`,
      `• Console / accent table: 75–90cm tall, 90–140cm wide`,
      `• Arc floor lamp: 150–180cm total height — arc should extend at least 120cm from base`,
      `• Wall art: minimum 80cm wide — large, filling the wall confidently`,
      `• Mirror: minimum 70cm wide, 90–160cm tall`,
      `• Bench: 45–50cm tall, 90–120cm wide`,
      `• When in doubt, go LARGER on art and mirror — timidity reads as unfinished`,
      ``,
      `STRICT PLACEMENT RULES — violations cause rejection:`,
      `• WALKWAY: Clear path must be maintained through the entryway`,
      `• DOORS: No furniture blocking any door`,
      `• WALL ART: Must be hung on the wall — never propped on furniture`,
      `• MIRROR: Must be hung or leaned intentionally — never floating`,
      `• Do NOT place sofas, dining tables, or bedroom furniture in a foyer`,
      ``,
      `═══ FINAL GEOMETRY CHECK ═══`,
      `Verify output matches @image1 exactly on: wall positions · window locations · camera angle · room proportions.`,
      `The furniture changes completely; the room shell does not change at all.`,
      ``,
      outputLine,
    ];
  }

  // ── Loft / Mezzanine ────────────────────────────────────────────────────────
  if (roomType === "loft") {
    const t = theme.toLowerCase();
    const isScandi     = /scandi|scandinavian|nordic/i.test(t);
    const isJapandi    = /japandi/i.test(t);
    const isCoastal    = /coastal|beach|nautical/i.test(t);
    const isLuxury     = /luxury|glam/i.test(t);
    const isIndustrial = /industrial/i.test(t);
    const isMidCen     = /mid[\s_-]?century|midcentury/i.test(t);

    const themeVibe = isScandi     ? "calm Nordic loft — white oak console, large round mirror, tall arc floor lamp, abstract nature wall art. Pure, airy, beautifully sparse."
      : isJapandi                 ? "Japandi loft landing — walnut low console, oval wooden mirror, rattan floor lamp, ink-wash wall art. Serene, intentional, quietly stunning."
      : isCoastal                 ? "coastal loft vignette — white rattan console, driftwood mirror, rattan floor lamp, ocean-inspired art. Fresh, breezy, sun-drenched."
      : isLuxury                  ? "grand luxury loft — marble console, oversized gold arch mirror, crystal arc floor lamp, large statement art. Opulent, dramatic, unforgettable."
      : isIndustrial              ? "industrial loft — black steel reclaimed-wood console, pipe-framed mirror, Edison arc lamp, urban art. Raw, bold, design-forward."
      : isMidCen                  ? "mid-century loft — walnut tapered console, sunburst mirror, brass arc floor lamp, geometric art. Warm, characterful, timeless."
      : "modern loft — slim white console, large black-framed mirror, geometric arc floor lamp, bold abstract art. Sharp, confident, contemporary.";

    const outputLine = isScandi     ? `OUTPUT: Photorealistic, editorial-quality Scandinavian loft / mezzanine. Calm and minimal — like a top Nordic design magazine. White oak, soft arc lamp, round mirror, nature art. Wow factor through serene restraint and beauty. Consistent lighting from @image1.`
      : isJapandi                 ? `OUTPUT: Photorealistic, editorial-quality Japandi loft / mezzanine. Quietly breathtaking — like a Japanese interiors editorial. Walnut, rattan, washi, ink art. Wow factor through stillness and material mastery. Consistent lighting from @image1.`
      : isCoastal                 ? `OUTPUT: Photorealistic, editorial-quality coastal loft / mezzanine. Breezy and luminous — like a premium beach-house design spread. White rattan, driftwood, ocean art. Wow factor through lightness and effortless coastal charm. Consistent lighting from @image1.`
      : isLuxury                  ? `OUTPUT: Photorealistic, editorial-quality luxury loft / mezzanine. Grand and opulent — like a five-star hotel lobby editorial. Marble, gold, crystal, oversized art. Wow factor through commanding scale and material extravagance. Consistent lighting from @image1.`
      : isIndustrial              ? `OUTPUT: Photorealistic, editorial-quality industrial loft / mezzanine. Raw and bold — like an architectural digest feature on industrial design. Steel, reclaimed wood, Edison lighting, urban art. Wow factor through unapologetic material honesty. Consistent lighting from @image1.`
      : isMidCen                  ? `OUTPUT: Photorealistic, editorial-quality Mid-Century loft / mezzanine. Warm and sophisticated — like a design magazine celebrating 1960s modernism. Walnut, brass arc lamp, sunburst mirror, geometric art. Wow factor through timeless retro-modern elegance. Consistent lighting from @image1.`
      : `OUTPUT: Photorealistic, editorial-quality modern loft / mezzanine. Bold and architectural — like a leading contemporary design magazine. Slim console, oversized mirror, arc lamp, abstract art. Wow factor through precision, drama, and impeccable contemporary styling. Consistent lighting from @image1.`;

    return [
      `═══ LOFT / MEZZANINE STYLING — ${theme.toUpperCase()} transformation ═══`,
      `Replace the existing movable furniture in @image1 with freshly styled ${theme} loft / mezzanine pieces.`,
      `Stage as a professional interior design editorial — dramatic, sophisticated, aspirational.`,
      `THEME IDENTITY: ${themeVibe}`,
      `IMPORTANT: Replace furniture only. Do NOT touch walls, windows, floor, ceiling, staircase railings, or any fixed structural element.`,
      ``,
      `Furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must deliver wow factor:`,
      `• Console / accent table: the anchor piece — styled beautifully with lamp, vase, and 1–2 decorative objects on top. Makes the space feel curated and intentional.`,
      `• Arc floor lamp or tall floor lamp: sweeping over or beside the console, casting warm ambient light. The dramatic statement of the space.`,
      `• Large wall art: hung prominently on the main wall — fills the vertical space, adds personality and depth. Choose scale over timidity.`,
      `• Mirror: large and dramatic — bounces light, makes the space feel expansive and luxurious.`,
      `• Bench or accent chair: against a side wall — adds function and layers the composition.`,
      `• Accessories on console: vase, plant, tray, sculptural object — magazine-worthy vignette.`,
      ``,
      `Placement guidance:`,
      `• Console: against the main or side wall — anchor of the composition`,
      `• Arc lamp: beside or behind the console, arcing over it`,
      `• Wall art: centred on the main wall, hung at eye level (centre at 150cm from floor)`,
      `• Mirror: on a side wall or above the console`,
      `• Bench: against a wall, clear of traffic flow`,
      `• Keep clear walking path through the loft at all times`,
      `• Do NOT add sofas, dining tables, beds, or kitchen furniture`,
      ``,
      `═══ SCALE HIERARCHY — loft / mezzanine proportions ═══`,
      `Use the staircase or railing as scale anchor where visible.`,
      `• Console / accent table: 75–90cm tall, 90–140cm wide`,
      `• Arc floor lamp: 150–180cm total height — arc should extend at least 120cm from base`,
      `• Wall art: minimum 80cm wide — large, filling the wall confidently`,
      `• Mirror: minimum 70cm wide, 90–160cm tall`,
      `• Bench: 45–50cm tall, 90–120cm wide`,
      `• When in doubt, go LARGER on art and mirror — timidity reads as unfinished`,
      ``,
      `STRICT PLACEMENT RULES — violations cause rejection:`,
      `• WALKWAY: Clear path must be maintained through the loft`,
      `• STAIRCASE: Do NOT block staircase or railing access`,
      `• WALL ART: Must be hung on the wall — never propped on furniture`,
      `• MIRROR: Must be hung or leaned intentionally — never floating`,
      `• Do NOT place sofas, dining tables, or bedroom furniture in a loft`,
      ``,
      `═══ FINAL GEOMETRY CHECK ═══`,
      `Verify output matches @image1 exactly on: wall positions · window locations · camera angle · room proportions.`,
      `The furniture changes completely; the room shell does not change at all.`,
      ``,
      outputLine,
    ];
  }

  // ── Front Yard / Porch ─────────────────────────────────────────────────────
  if (roomType === "frontyard") {
    const t = theme.toLowerCase();
    const isCoastal = /coastal|beach|nautical/i.test(t);
    const isBoho    = /boho|bohemian/i.test(t);
    const isLuxury  = /luxury|glam/i.test(t);

    const themeVibe = isCoastal ? "breezy coastal porch — white rattan seating, natural side table, solar lanterns, terracotta planters. Fresh, welcoming, sun-drenched."
      : isBoho                 ? "earthy boho porch — rattan wicker chairs, macramé accents, terracotta planters, hanging lanterns. Warm, eclectic, inviting."
      : isLuxury               ? "premium luxury porch — white teak lounge seating, marble-top table, brass lanterns, oversized ceramic planters. Elegant, refined, aspirational."
      : "clean modern porch — black metal bench, concrete planters, contemporary lanterns, geometric accents. Bold, crisp, architectural.";

    const outputLine = isCoastal ? `OUTPUT: Photorealistic, editorial-quality coastal front porch. Sun-soaked and breezy — like a premium beach-house exterior shoot. White rattan, natural textures, lush planters. Wow factor through effortless coastal warmth and welcome. Consistent lighting from @image1.`
      : isBoho                 ? `OUTPUT: Photorealistic, editorial-quality bohemian front porch. Warm, layered, full of character — like a luxury boho home exterior editorial. Rattan, terracotta, macramé, abundant greenery. Wow factor through rich texture and inviting eclecticism. Consistent lighting from @image1.`
      : isLuxury               ? `OUTPUT: Photorealistic, editorial-quality luxury front porch. Refined and aspirational — like a high-end real estate magazine cover. Teak, marble, brass, statement planters. Wow factor through commanding elegance and premium materials. Consistent lighting from @image1.`
      : `OUTPUT: Photorealistic, editorial-quality modern front porch. Bold and architectural — like a contemporary home design magazine. Black metal, concrete, clean geometry, lush greenery. Wow factor through precision and confident contemporary design. Consistent lighting from @image1.`;

    return [
      `═══ FRONT YARD / PORCH STYLING — ${theme.toUpperCase()} transformation ═══`,
      `Replace the existing outdoor furniture in @image1 with freshly styled ${theme} outdoor porch pieces.`,
      `Stage as a professional exterior design editorial — welcoming, beautiful, aspirational.`,
      `THEME IDENTITY: ${themeVibe}`,
      `IMPORTANT: Replace movable outdoor furniture only. Do NOT touch the building facade, path, driveway, lawn, trees, sky, or fixed structural elements.`,
      ``,
      `Outdoor furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must deliver wow factor:`,
      `• Seating: outdoor bench, chairs, or small sofa set — the hero of the porch composition. Style with weather-resistant cushions and a folded throw.`,
      `• Side / accent table: beside or in front of seating — styled with a lantern or small plant on top.`,
      `• Outdoor lighting: lantern(s) on the table or beside the door — warm glow, welcoming atmosphere.`,
      `• Planters: 2–3 lush planters with greenery or flowering plants — vary heights (tall + short). Make them full and abundant, not sparse.`,
      `• Accessories: outdoor rug under seating, decorative objects — layers the composition.`,
      ``,
      `Placement guidance:`,
      `• Seating: centred or to one side of the porch — facing outward, welcoming`,
      `• Table: beside seating, accessible`,
      `• Lanterns: on table, flanking the door, or on the floor beside seating`,
      `• Planters: flanking the door, at the edges of the porch, or beside steps`,
      `• Keep the path to the door CLEAR — minimum 90cm walking path`,
      `• Do NOT add indoor furniture (sofas, beds, dining tables, kitchen items)`,
      ``,
      `═══ SCALE HIERARCHY — porch proportions ═══`,
      `Use the door frame as scale anchor (standard door = 200cm tall).`,
      `• Bench / chairs: approx 80–90cm tall back, 45cm seat height`,
      `• Side table: approx 55–70cm tall`,
      `• Lantern: 30–60cm tall — proportional to the table`,
      `• Tall planter: 60–90cm tall — lush, full greenery`,
      `• Short planter: 30–45cm tall — grouped with tall planter`,
      `• When in doubt, make planters FULLER and TALLER — sparse looks neglected`,
      ``,
      `STRICT PLACEMENT RULES — violations cause rejection:`,
      `• PATH: Keep the door approach clear — minimum 90cm walkway`,
      `• DOOR: No furniture blocking the front door`,
      `• INDOOR FURNITURE: NEVER place indoor items outdoors`,
      `• PLANTERS: Must look lush and well-maintained, not bare or wilting`,
      ``,
      `═══ FINAL GEOMETRY CHECK ═══`,
      `Verify output matches @image1 exactly on: building facade · path · ground surface · camera angle · proportions.`,
      `Outdoor furniture changes completely; the building and landscape do not change at all.`,
      ``,
      outputLine,
    ];
  }

  // ── Backyard / Outdoor Patio ───────────────────────────────────────────────
  if (roomType === "backyard") {
    const t = theme.toLowerCase();
    const isCoastal = /coastal|beach|nautical/i.test(t);
    const isBoho    = /boho|bohemian/i.test(t);
    const isLuxury  = /luxury|glam/i.test(t);

    const themeVibe = isCoastal ? "relaxed coastal outdoor living — rattan sofa set or dining set, natural side table, solar string lights, terracotta planters. Breezy, sun-drenched, effortlessly beautiful."
      : isBoho                 ? "boho outdoor sanctuary — rattan sofa, eclectic mix of planters, macramé lanterns, patterned outdoor rug, fire pit. Warm, layered, abundantly inviting."
      : isLuxury               ? "luxury outdoor living room — premium teak sofa or dining set, marble-top table, brass lanterns, oversized statement planters, fire pit. Opulent, elegant, resort-quality."
      : "modern outdoor living — black metal dining or lounge set, concrete side table, geometric planters, sleek outdoor string lights, fire pit bowl. Bold, architectural, impressively designed.";

    const outputLine = isCoastal ? `OUTPUT: Photorealistic, editorial-quality coastal backyard/patio. Sun-drenched outdoor paradise — like a premium coastal living magazine editorial. Rattan, natural textures, string lights, lush planters. Wow factor through relaxed abundance and coastal warmth. Consistent lighting from @image1.`
      : isBoho                 ? `OUTPUT: Photorealistic, editorial-quality bohemian backyard/patio. Rich, layered, deeply inviting — like a luxury boho outdoor living editorial. Rattan, terracotta, macramé, fire pit glow. Wow factor through texture, warmth and eclectic abundance. Consistent lighting from @image1.`
      : isLuxury               ? `OUTPUT: Photorealistic, editorial-quality luxury backyard/patio. Resort-grade outdoor elegance — like a five-star hotel terrace editorial. Teak, marble, brass, statement planters, fire pit. Wow factor through opulence, scale and premium materials. Consistent lighting from @image1.`
      : `OUTPUT: Photorealistic, editorial-quality modern backyard/patio. Bold and architectural outdoor space — like a leading contemporary design magazine. Black metal, concrete, geometric forms, dramatic lighting. Wow factor through precision, boldness, and outdoor design confidence. Consistent lighting from @image1.`;

    return [
      `═══ BACKYARD / OUTDOOR PATIO STYLING — ${theme.toUpperCase()} transformation ═══`,
      `Replace the existing outdoor furniture in @image1 with freshly styled ${theme} outdoor living pieces.`,
      `Stage as a professional outdoor interior design editorial — dramatic, luxurious, aspirational.`,
      `THEME IDENTITY: ${themeVibe}`,
      `IMPORTANT: Replace movable outdoor furniture only. Do NOT touch fences, walls, lawn, garden beds, trees, sky, or fixed structural elements.`,
      ``,
      `Outdoor furniture and accessories to include (use these as style guidance):`,
      ...productLines,
      ``,
      `Staging richness — every element must deliver wow factor:`,
      `• Hero seating: outdoor sofa set, sectional, or dining set — the centrepiece of the patio. Add weather-resistant cushions, an outdoor throw, decorative outdoor pillows.`,
      `• Coffee / dining table: in front of or beside seating — styled with a lantern, small plant, or tray on top.`,
      `• Outdoor string lights or lanterns: warm ambient glow — draped above or placed around the seating area. Essential for atmosphere.`,
      `• Planters: 3–4 planters with lush greenery — vary heights dramatically. Tall architectural plants + low flowering plants. Make the space feel like a garden oasis.`,
      `• Fire pit: if present, place as a focal feature in front of the seating — adds warmth, drama, and gathering atmosphere.`,
      `• Outdoor rug: under the seating area — grounds the composition and adds pattern.`,
      ``,
      `Placement guidance:`,
      `• Hero seating: facing toward the garden or centred on the patio`,
      `• Table: in front of or beside seating — easily accessible`,
      `• String lights: overhead or draped — covering the seating zone`,
      `• Planters: at the perimeter, beside seating, and at the corners of the patio`,
      `• Fire pit: centred in front of seating — safe distance from combustibles`,
      `• Outdoor rug: under and slightly beyond the seating area`,
      `• Keep walkways and access paths clear`,
      `• Do NOT add indoor furniture (sofas with fabric, indoor beds, kitchen items)`,
      ``,
      `═══ SCALE HIERARCHY — outdoor patio proportions ═══`,
      `Use the door frame or fence as scale anchor.`,
      `• Outdoor sofa: approx 80–90cm tall back, 45cm seat height`,
      `• Coffee table: approx 40–50cm tall`,
      `• Dining table: approx 75cm tall`,
      `• Tall planter: 80–120cm tall — dramatic and architectural`,
      `• Short planter: 35–50cm tall — grouped in clusters`,
      `• Fire pit: 40–60cm tall — bowl shape, clearly a fire feature`,
      `• String lights: hung 220–280cm above ground over seating area`,
      `• When in doubt, make planters TALLER and FULLER — abundance is key outdoors`,
      ``,
      `STRICT PLACEMENT RULES — violations cause rejection:`,
      `• WALKWAYS: Keep access paths clear through the garden/patio`,
      `• INDOOR FURNITURE: NEVER place fabric indoor items outdoors`,
      `• PLANTERS: Must look lush and full — never bare or wilting`,
      `• FIRE PIT: Must have clear space around it — never hemmed in by furniture`,
      ``,
      `═══ FINAL GEOMETRY CHECK ═══`,
      `Verify output matches @image1 exactly on: fence/wall positions · ground surface · garden beds · camera angle · proportions.`,
      `Outdoor furniture changes completely; the garden structure does not change at all.`,
      ``,
      outputLine,
    ];
  }

  // ── Default: Living Room / Dining Room / everything else ───────────────────
  return [
    `═══ FURNITURE RESTYLE — dramatic transformation ═══`,
    `Replace the existing movable furniture in @image1 with freshly styled, theme-appropriate pieces.`,
    `The sofa, chairs, tables, rug, lamps, and accessories should all be replaced to match the ${theme.toUpperCase()} theme.`,
    `Stage the room as a professional interior design shoot — dramatic, rich, aspirational, and fully furnished.`,
    `IMPORTANT: Replace furniture only. Do NOT move, cover, or obscure any fixed element (fireplace, TV, windows, walls).`,
    ``,
    `Furniture categories to include in the scene (use these as style guidance):`,
    ...productLines,
    ``,
    `Staging richness — every element must contribute to the wow factor:`,
    `• A statement rug placed ON TOP OF the existing floor WITHIN the seating area only — do NOT change the floor material anywhere. The floor surface outside the rug boundary must remain completely unchanged and fully visible.`,
    `• Hero seating (sofa or sectional) — plush, well-proportioned, with layered cushions and a throw`,
    `• Side tables flanking the sofa with table lamps casting warm ambient light`,
    `• A coffee table styled with books, a tray, candles, and a small plant or vase`,
    `• Decorative accessories layered throughout — vases, artwork, plants, sculptural objects`,
    `• Rich lighting atmosphere — warm, layered, inviting, not flat overhead light`,
    `• Every surface should feel intentionally and beautifully styled`,
    ``,
    `Placement guidance:`,
    `• Hero pieces (sofa, bed, dining table) — place in the room's natural focal zone`,
    `• Secondary pieces (armchair, side tables, lamps) — flank and complement hero pieces`,
    `• Accent pieces (rug, mirror, artwork, decor) — layer for depth and visual richness`,
    `• Choose ONE hero seating piece — do NOT place two competing sofas or sectionals`,
    `• Do NOT place any furniture in front of or covering the fireplace — fireplace must remain fully visible`,
    ``,
    `═══ SCALE HIERARCHY — real-world proportions, strictly enforced ═══`,
    `Use the door frame visible in @image1 as the scale anchor (standard door = 200cm tall).`,
    `• Hero pieces (sofa, bed, dining table): largest items, approx 70–90cm tall`,
    `• Secondary pieces (armchair, side table, desk lamp): medium, approx 45–75cm tall`,
    `• Accent pieces (bench, ottoman, stool, floor lamp base): smaller, approx 40–55cm tall`,
    `• A bench or ottoman must NEVER appear as large as or larger than a sofa or bed`,
    `• A lamp shade must NEVER be wider than 50cm — lamp total height must NEVER exceed 80cm for table lamps or 180cm for floor lamps`,
    `• A table lamp shade must appear SMALLER than a sofa cushion when viewed from the camera angle`,
    `• Wall art must be sized proportionally to the wall — not oversized`,
    `• When in doubt, render an item slightly SMALLER rather than larger`,
    `• Violating these scale rules will cause rejection`,
    ``,
    `═══ LAMP PLACEMENT RULES — strictly enforced ═══`,
    `• "Table lamp" or "desk lamp": MUST be placed ON a solid surface — side table, console table, shelf, or fireplace mantel. NEVER on the floor.`,
    `• "Floor lamp": base MUST rest on the floor. May stand beside a sofa or in a corner.`,
    `• If no side table exists in the scene and a table lamp must be placed, use the fireplace mantel or an existing shelf.`,
    `• A table lamp placed on the floor will cause immediate rejection.`,
    ``,
    `STRICT PLACEMENT RULES — violations will cause rejection:`,
    `• DOOR & PASSAGE: Already stated above — no furniture in front of any door or walkway`,
    `• FIREPLACE: If a fireplace is visible in @image1, it must remain FULLY VISIBLE. Do NOT place any chair, sofa, cabinet, console, TV stand, sideboard, plant, or any other item in front of or adjacent to the fireplace. Minimum 100cm clearance in front of the fireplace at all times.`,
    `• SIDEBOARD / TV CONSOLE / MEDIA CONSOLE: If the room has a fireplace on the main wall, place any sideboard, console, or media unit on a SIDE WALL — never on the fireplace wall, never blocking or adjacent to the fireplace.`,
    `• TV STAND: If the TV in @image1 is wall-mounted with no stand beneath it, do NOT add a TV stand or media console under it. A wall-mounted TV needs no need.`,
    `• NEVER place storage/cabinet items (shoe cabinet, hallway cabinet) in a living room — these belong in entryways only`,
    `• NEVER place bedroom-specific furniture (wardrobe, dresser) in a living room`,
    `• NEVER place an office desk in a living room`,
    `• CABINETS & TV STANDS must be FREESTANDING furniture pieces placed on the floor against a wall — do NOT create built-in closets, recessed wall units, floor-to-ceiling wardrobes, or structural wall modifications of any kind. Cabinets must be LOW (max 120cm / waist height) — never floor-to-ceiling, never taller than the sofa back.`,
    `• All furniture must have clear floor clearance and look naturally accessible`,
    ``,
    `═══ FINAL GEOMETRY CHECK — before rendering ═══`,
    `Verify the output matches @image1 exactly on: wall positions · window locations · camera angle · room proportions · archway/entry frame framing · fireplace visibility.`,
    `If the original was shot through an archway or door frame, that frame MUST appear in the output in the same position.`,
    `If a fireplace is visible in @image1, it must remain fully visible in the output — no furniture placed in front of it.`,
    `If any of these have shifted, correct them. The furniture changes completely; the room shell does not change at all.`,
    ``,
    `OUTPUT: Photorealistic, editorial-quality interior photography. Dramatic transformation of the furniture and soft furnishings. Rich, warm, aspirational — like a luxury interior design magazine cover. Consistent lighting and shadows from @image1.`,
  ];
}

// ─── Step 3: Generation prompt ────────────────────────────────────────────────
// Builds a strict, structured prompt that:
//  • References the depth map (when available) to lock 3-D geometry.
//  • Embeds Gemini-generated visual descriptions for each product.
//  • Escalates anti-hallucination directives on each retry.
function buildStrictEditPrompt({
  roomType,
  theme,
  products,
  attempt,
  previousValidation,
  productDescriptions,
  geometryAnchorRef,
  inspireStyleRef,
  customDirective,
}: {
  roomType: string;
  theme: string;
  products: Array<{ title: string; category: string }>;
  attempt: number;
  previousValidation?: any;
  productDescriptions: string[];
  geometryAnchorRef?: string; // e.g. "@image2" — fal URL uploaded as geometry reference
  inspireStyleRef?: string;   // e.g. "@image2" — inspire image as aesthetic target
  customDirective?: string;   // pre-computed Gemini directive for custom/free-text themes
}) {
  const room = roomType.replace(/_/g, " ");

  // When a geometry anchor is active, @image2 is the anchor — do NOT use @imageN labels
  // for products (they have no actual uploaded images in Pass 1 anyway).
  const productLines = products.map((p, i) => {
    let desc = productDescriptions[i] || `${p.title} — ${p.category}`;
    // Headboard in the bed slot: clarify it's the bed's headboard panel, not a standalone object
    const normCat = normalizeForDedup(p.category);
    if (normCat === "bed" && /headboard/i.test(p.title)) {
      desc = `This is the HEADBOARD (vertical back panel) of the hero bed — it is NOT a standalone object. Place it as the bed's headboard, flush against the wall behind the bed. ${desc}`;
    }
    if (geometryAnchorRef) {
      return `- ${p.category}: "${p.title}". ${desc}.`;
    }
    const imgRef = `@image${2 + i}`; // @image1 = room, products start at @image2
    return `- ${imgRef} → ${p.category}: "${p.title}". ${desc}. Match the colour, shape, silhouette and material of ${imgRef} as closely as possible.`;
  });

  const retryDirectives: string[] = [];
  if (attempt > 1) {
    const prevGeometry = Number(previousValidation?.geometryScore || 0);
    const prevCatalogue = Number(previousValidation?.catalogueAverageScore || 0);
    const geometryWasGood = prevGeometry >= MIN_GEOMETRY_SCORE;
    const catalogueWasLow = prevCatalogue < MIN_CATALOGUE_AVG;

    if (geometryWasGood && catalogueWasLow) {
      // Geometry was fine — only improve catalogue, do NOT touch room structure
      if (geometryAnchorRef) {
        retryDirectives.push(
          `RETRY ${attempt}/${MAX_ATTEMPTS}: GEOMETRY ANCHOR ACTIVE.`,
          `${geometryAnchorRef} is a geometrically correct version of this room — its walls, windows, floor, ceiling, camera angle and room proportions are exactly right.`,
          `You MUST preserve the exact room structure shown in ${geometryAnchorRef}. Do NOT change any architectural element.`,
          `Your ONLY task is to restyle the furniture and soft furnishings to better match the theme and product descriptions listed below.`,
          `The furniture positions, room structure and camera angle from ${geometryAnchorRef} must be maintained in the output.`
        );
      } else {
        retryDirectives.push(
          `RETRY ${attempt}/${MAX_ATTEMPTS}: Geometry was good (${prevGeometry}%) — DO NOT change the room structure at all.`,
          `The previous attempt preserved the room shell correctly. Keep ALL architectural elements IDENTICAL to @image1: walls, windows, doors, ceiling, floor, archways, camera angle.`,
          `Your ONLY task is to improve the furniture styling to better match the catalogue products described above.`,
          `Do NOT widen the room, do NOT remove windows, do NOT change wall colour or floor material.`
        );
      }
    } else if (!geometryWasGood) {
      // Geometry drifted — pull back hard
      retryDirectives.push(
        `RETRY ${attempt}/${MAX_ATTEMPTS}: Previous attempt REJECTED for geometry drift (${prevGeometry}%). Pull back significantly.`,
        `You MUST preserve: walls, windows, doors, curtains, ceiling, floor material/colour, fireplace, archways, room entry frames, and camera angle — ALL exactly as in @image1.`,
        `Do NOT change any architectural element. Keep furniture changes but preserve the room shell exactly.`
      );
    } else {
      retryDirectives.push(
        `RETRY ${attempt}/${MAX_ATTEMPTS}: Be more conservative than before.`,
        `Preserve all negative space and keep total object count realistic.`
      );
    }
  }

  return [
    `@image1 is the base ${room} photograph.`,
    ...(inspireStyleRef ? [
      `${inspireStyleRef} is the STYLE TARGET — a beautifully styled version of this room showing the ideal ${theme} aesthetic.`,
      `Your goal: reproduce the aesthetic feel, colour palette, furniture style, and mood of ${inspireStyleRef} while placing the specific catalogue products listed below.`,
      `GEOMETRY comes from @image1 ONLY — walls, windows, floor, ceiling, camera angle must match @image1 exactly.`,
      `STYLE comes from ${inspireStyleRef} — furniture colours, textures, rug pattern, lighting warmth, and overall mood should match ${inspireStyleRef}.`,
      `When ${inspireStyleRef} conflicts with @image1 on any architectural element, @image1 ALWAYS wins.`,
    ] : []),
    ``,
    `═══ FIREPLACE ABSOLUTE RULE — check this before anything else ═══`,
    `If a fireplace is visible in @image1:`,
    `• Its surround colour, material, style, and position are LOCKED — do NOT change any part of it`,
    `• The fireplace opening and its entire surround must remain FULLY VISIBLE and UNOBSTRUCTED in the output`,
    `• Do NOT place ANY item (chair, sofa, table, cabinet, TV stand, plant) within 100cm in front of the fireplace`,
    `• Seating must face the fireplace from a distance — never block it`,
    `This rule overrides all other placement instructions. Violating it will cause immediate rejection.`,
    ``,
    `═══ GEOMETRY LOCK — READ THIS FIRST, OBEY IT THROUGHOUT ═══`,
    `The room structure in @image1 is FIXED and must be pixel-perfect in the output:`,
    `• Every wall surface, wall panel, wall colour — unchanged. Do NOT paint, panel, or recolour any wall.`,
    `• TV feature wall, fireplace surround wall, accent wall — colour and material are LOCKED. Do NOT add panelling, paint, or any treatment to any wall.`,
    `• Every window: position, size, shape, glass, frame — unchanged`,
    `• Every door: position, size, frame — unchanged`,
    `• Curtains, blinds, drapes — unchanged`,
    `• Ceiling: height, cornices, beams, light fixtures — unchanged`,
    `• Floor: material, colour, texture, boundaries — UNCHANGED. Tile stays tile. Wood stays wood. Carpet stays carpet. DO NOT change floor material under any circumstances.`,
    `• Fireplace: if visible in @image1, its surround, style, material, and position are LOCKED — do NOT replace, restyle, or remove it. Do NOT place any furniture or product in front of the fireplace — it must remain fully visible and unobstructed.`,
    `• Archways and room entry frames — CRITICAL: if the camera is shooting THROUGH an archway or entry frame in @image1, that archway MUST remain fully visible and frame the output image in EXACTLY the same position. Do NOT crop it out, do NOT remove it, do NOT widen the camera angle.`,
    `• Ceiling fixtures: fan blades, chandelier, pendant lights — preserve exactly`,
    `• Camera: angle, height, focal length, perspective vanishing points — IDENTICAL to @image1`,
    `• Room proportions and spatial dimensions — unchanged`,
    `You may ONLY touch: movable furniture pieces and their associated soft furnishings.`,
    `DO NOT widen the room, DO NOT change the viewpoint, DO NOT add windows or doors.`,
    `CABINETS AND TV STANDS: These are freestanding furniture pieces placed on the floor — do NOT render them as built-in closets, recessed wall units, or floor-to-ceiling wardrobes. A storage cabinet is a piece of furniture with visible legs or a solid base sitting on the floor against a wall. Storage cabinets must be LOW and COMPACT — maximum 120cm (waist height) — never floor-to-ceiling, never taller than the sofa back.`,
    ``,
    `═══ DOOR & PASSAGE RULE — ABSOLUTE, NO EXCEPTIONS ═══`,
    `BEFORE placing any piece of furniture, identify every door, doorway, and walkway visible in @image1.`,
    `• NO furniture of any kind may be placed in front of a door or within its swing arc`,
    `• NO furniture may block, narrow, or obstruct any walkway, corridor, or passage through the room`,
    `• If a product cannot be placed without blocking a door or passage, place it against a wall or in a corner instead`,
    `• A clear path of at least 90cm must remain through every doorway and walkway visible in the image`,
    `This rule overrides all other placement instructions. Violating it will cause immediate rejection.`,
    ``,
    `═══ INTERIOR DIRECTION ═══`,
    `Style theme: ${theme.toUpperCase()}.`,
    `${buildThemeDirective(theme, customDirective)}`,
    `IMPORTANT: Express the theme ONLY through:`,
    `  • Furniture colours, upholstery fabric and material finishes`,
    `  • Rug pattern, cushion colours and throw textures`,
    `  • Lamp shade style and light warmth`,
    `  • Decorative accessories (vases, plants, artwork framing)`,
    `Do NOT express the theme through: wall colour, floor material, ceiling, windows, doors — these are LOCKED.`,
    ``,
    ...buildRoomFurnitureSection(roomType, theme, productLines),
    ...retryDirectives,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n");
}

// ─── Step 3b: Targeted product swap prompt ───────────────────────────────────
// Used in the targeted edit loop (Pass 2). Each call swaps ONE furniture
// category with the actual catalogue product image (@image2).
// @image1 = current room, @image2 = product reference image.
function buildTargetedSwapPrompt(
  product: { title: string; category: string },
  roomType: string,
  theme: string
): string {
  const room = roomType.replace(/_/g, " ");
  const cat = product.category.replace(/_/g, " ");
  return [
    `@image1 is a styled ${room} photograph.`,
    `@image2 is a product reference image: "${product.title}" (${cat}).`,
    ``,
    `═══ FIREPLACE ABSOLUTE RULE ═══`,
    `If a fireplace is visible in @image1: its surround, style, material and position are LOCKED.`,
    `Do NOT place any item in front of the fireplace. It must remain fully visible.`,
    ``,
    `═══ GEOMETRY LOCK — ABSOLUTE, NO EXCEPTIONS ═══`,
    `@image1 is the base. The room shell must be pixel-perfect in the output. Do NOT change:`,
    `• Walls, wall colour, wall panels, TV feature wall, accent wall — UNCHANGED`,
    `• Windows: position, size, glass, frame — UNCHANGED`,
    `• Doors: position, size, frame — UNCHANGED`,
    `• Curtains, blinds — UNCHANGED`,
    `• Floor material, colour, texture — UNCHANGED. Tile stays tile. Carpet stays carpet.`,
    `• Fireplace surround — LOCKED`,
    `• Archways and room entry frames — UNCHANGED, do NOT remove or crop out`,
    `• Ceiling: height, cornices, texture, light fixtures — UNCHANGED`,
    `• Ambient lighting, brightness, colour temperature — IDENTICAL to @image1`,
    `• Camera angle, perspective, vanishing points, room proportions — IDENTICAL to @image1`,
    `• DO NOT widen the room. DO NOT change the viewpoint. DO NOT add windows or doors.`,
    `• ALL other furniture and décor NOT being replaced — pixel-identical to @image1`,
    ``,
    `═══ SINGLE TARGETED SWAP — the ONLY change allowed ═══`,
    `Identify the existing ${cat} in @image1. Replace it with the product shown in @image2.`,
    ``,
    `Placement rules (CRITICAL — violations cause rejection):`,
    `• POSITION LOCK: The center of the replacement must be at the exact same (x, y) position in the frame as the ${cat} in @image1. Do NOT shift it left, right, forward, or backward.`,
    `• SIZE LOCK: The replacement must be scaled to match the bounding box of the existing ${cat} in @image1. If @image2 shows a larger or differently-shaped product, compress or crop the view of it to fit the same footprint — do NOT expand the footprint.`,
    `• ORIENTATION LOCK: The facing direction of the replacement must match the existing ${cat} exactly. If the original faces toward the camera at an angle, the replacement faces the same angle.`,
    `• Use @image2 only as a visual reference for colour, material, texture and silhouette — the geometry (size, position, angle) is dictated by @image1.`,
    `• The replacement must cast natural shadows consistent with the lighting in @image1.`,
    `• Do NOT move, resize, or remove any other object in the scene.`,
    ``,
    `═══ PHYSICAL GROUNDING ═══`,
    `• Sofas, chairs, tables: legs or base must visibly contact the floor`,
    `• Floor lamps: base must rest on the floor`,
    `• Table lamps: base must sit on a side table, console, shelf, or mantel — NEVER on the floor`,
    `• Wall art: mounted flat and flush against a wall`,
    ``,
    `═══ FINAL CHECK — before rendering ═══`,
    `Verify: walls · windows · ceiling · floor · archway frame · camera angle are IDENTICAL to @image1.`,
    `Verify: all furniture except the replaced ${cat} is IDENTICAL to @image1.`,
    `Verify: room brightness and lighting feel are IDENTICAL to @image1.`,
    `If anything has shifted, correct it before outputting.`,
    ``,
    `OUTPUT: Photorealistic, professional interior photography. ONLY the ${cat} changes.`,
  ].join("\n");
}

// ─── Step 4: Pixel-level geometry score ──────────────────────────────────────
// Uses rembg to isolate the background (non-furniture) pixels, then computes
// how similar those pixels are between original and generated images.
// A high score means the walls / floor / windows are largely unchanged.
async function buildBackgroundMaskScore(
  originalDataUri: string,
  generatedDataUri: string
): Promise<number> {
  try {
    const { dataUri: resizedOriginal, width, height } = await resizeDataUri(originalDataUri, 1024);
    const { dataUri: resizedGenerated } = await resizeDataUri(generatedDataUri, 1024);
    const originalUrl = await uploadToFal(resizedOriginal, "validation_original.jpg");

    const rembgResult = (await fal.subscribe("fal-ai/imageutils/rembg", {
      input: { image_url: originalUrl },
    })) as any;

    const rembgUrl = rembgResult?.data?.image?.url;
    if (!rembgUrl) return 0;

    const [maskBuf, originalBuf, generatedBuf] = await Promise.all([
      fetchBuffer(rembgUrl),
      sharp(Buffer.from(stripDataUrlPrefix(resizedOriginal), "base64")).resize(width, height).png().toBuffer(),
      sharp(Buffer.from(stripDataUrlPrefix(resizedGenerated), "base64")).resize(width, height).png().toBuffer(),
    ]);
    if (!maskBuf || !originalBuf || !generatedBuf) return 0;

    const alpha = await sharp(maskBuf).resize(width, height).extractChannel("alpha").raw().toBuffer();
    const orig = await sharp(originalBuf).removeAlpha().raw().toBuffer();
    const gen = await sharp(generatedBuf).removeAlpha().raw().toBuffer();

    let compared = 0;
    let diffSum = 0;
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] > 40) continue; // skip furniture-foreground pixels
      const r = i * 3;
      diffSum += (Math.abs(orig[r] - gen[r]) + Math.abs(orig[r + 1] - gen[r + 1]) + Math.abs(orig[r + 2] - gen[r + 2])) / 3;
      compared++;
    }
    if (!compared) return 0;
    return Math.max(0, Math.min(100, Math.round(100 - diffSum / compared / 2.55)));
  } catch {
    return 0;
  }
}

// ─── Step 5: Gemini validation with bounding boxes ───────────────────────────
// Validates geometry, catalogue similarity and hallucination.
// NEW: Also asks Gemini to return bounding boxes (y1,x1,y2,x2 normalized 0–1000)
// for each invented item so we can crop them from the generated image.
async function validateWithGemini({
  originalImage,
  generatedImage,
  roomType,
  theme,
  products,
}: {
  originalImage: string;
  generatedImage: string;
  roomType: string;
  theme: string;
  products: Array<{ title: string; category: string; imageUrl: string }>;
}) {
  const productCount = products.length;

  const prompt = `
You are a strict quality validator for a commercial interior design AI tool.

image1 = original room photograph.
image2 = AI-generated room (to be validated).
image3 .. image${productCount + 2} = catalogue product reference images (one per product).

TASK — return a strict JSON validation report. Be conservative and strict — do NOT be lenient.

━━━ 1. geometryScore (0–100) ━━━
How faithfully image2 preserves the EXACT room structure of image1.
Check EACH of the following individually and deduct points for ANY change:
• Wall surfaces, wall colour, wall panels — any repaint or restyle = -15 pts
• Floor material and colour — tile→wood, carpet→tile etc. = -20 pts (this is a critical failure)
• Fireplace — if present in image1: any change to surround, style, material, OR if removed/obscured = -35 pts (critical failure)
• Archways and room entry frames — if removed or reshaped = -15 pts
• Windows: position, size, frame — any change = -10 pts; window ADDED where none existed in image1 = -20 pts
• Doors: position, size, frame — any change = -10 pts; door ADDED where none existed in image1 = -20 pts
• Curtains/blinds — if replaced or removed = -5 pts
• Ceiling height, cornices, beams — any change = -10 pts
• Ceiling fixtures (fan, chandelier, pendant) — if changed = -5 pts
• Camera angle, perspective vanishing points — any shift = -15 pts
• Camera position: if image1 is shot THROUGH a doorway but image2 is shot from INSIDE the room (or vice versa), this is a CRITICAL camera change = -30 pts
• Window moved to a different wall (e.g. from far wall to side wall) = -20 pts
• ARCHITECTURAL HALLUCINATION CHECK — CRITICAL, do this step by step:
  Step 1: Count EVERY door (open or closed, including closet doors) visible in image1. Write the count.
  Step 2: Count EVERY door visible in image2. Write the count.
  Step 3: If image2 count > image1 count, deduct -30 pts per EXTRA door. This is the single most severe penalty.
  Step 4: Repeat for windows. Extra window = -20 pts each.
  Step 5: Repeat for mirrors. Extra mirror = -20 pts each.
  Any architectural element ADDED that does not exist in image1 is a hallucination and must be heavily penalised.
100 = pixel-perfect room shell. A score below 88 means the room structure has significantly changed.

━━━ 2. Products (one entry per reference image) ━━━
For each product reference image (image3..image${productCount + 2}):
- title: product name
- category: product category
- presentInFinal (bool): Is there ANY furniture or décor item of this category visibly present in image2?
  Set true if an item of the same type/category can be seen anywhere in image2, even if its specific appearance differs from the reference image.
  Only set false if that entire category is completely absent from image2 (e.g. no sofa at all, no rug at all).
- similarityScore (0–100): How well is this category and style represented in image2 relative to the reference?
  The AI generates furniture inspired by a text description, not an exact copy of the reference image — score accordingly.
  Scoring guide:
  • 85–100: Nearly identical to the reference — same dominant colour, material, silhouette, and style.
  • 65–84: Very similar — same category, same style direction, colour and form are close with minor differences.
  • 45–64: Same category, style theme is roughly aligned, but colour or exact form differs noticeably.
  • 25–44: Same category, but style, colour, and form are clearly different from the reference.
  • 0–24: Wrong category entirely, or the item is completely unrelated to the reference.
  Do NOT penalise heavily for minor colour or proportion differences — the generation is text-guided, not a pixel-exact copy.
- notes: one-line observation.

━━━ 3. hallucinationDetected (bool) ━━━
true ONLY if image2 contains a LARGE furniture piece with NO visually matching reference.
Large items: sofa, sectional, bed, dining table, large cabinet, wardrobe, TV stand, media console, desk, bookcase, sideboard.
Do NOT set true for: small accessories, cushions, books, small plants, candles, trays.
Style variations of a referenced item do NOT count. A TV stand/cabinet with no reference IS hallucination.

━━━ 4. inventedItems (string[]) ━━━
List ALL furniture and décor visible in image2 with NO clear visual match in any reference image.
Include both large pieces AND small additions (vase, cushion set, plant, decorative object).
An item is invented if it is not visually similar to any reference — even if the category is represented.

━━━ 5. inventedItemsBboxes ━━━
For EACH item in inventedItems, provide a bounding box in image2.
Format: [y_min, x_min, y_max, x_max] normalised 0–1000.
Every inventedItems entry MUST have a corresponding bbox entry.

━━━ 6. scaleIssues (string[]) ━━━
List any furniture items in image2 that appear at an unrealistic scale, e.g.:
- A bench or ottoman that appears as large as a sofa or bed
- A lamp that appears wider or taller than the sofa
- Any item that looks disproportionately large relative to the door frame or room

━━━ 7. notes (string[]) ━━━
Up to 3 short reviewer notes on overall quality.

Return ONLY this exact JSON — no markdown, no extra text:
{
  "geometryScore": 0,
  "hallucinationDetected": false,
  "inventedItems": [],
  "inventedItemsBboxes": [
    { "name": "extra lamp", "bbox": [120, 340, 450, 780] }
  ],
  "scaleIssues": [],
  "notes": [],
  "products": [
    {
      "title": "",
      "category": "",
      "presentInFinal": true,
      "similarityScore": 0,
      "notes": ""
    }
  ]
}

Product reference list (in order, matching image3..image${productCount + 2}):
${products.map((p, i) => `  image${i + 3}: title="${p.title}", category="${p.category}"`).join("\n")}

Use these EXACT category values in your output — do NOT rename or reclassify them.

Context: roomType=${roomType}; theme=${theme}.
`.trim();

  const contents: any[] = [
    { text: prompt },
    { inlineData: { mimeType: "image/jpeg", data: stripDataUrlPrefix(originalImage) } },
    { inlineData: { mimeType: "image/jpeg", data: stripDataUrlPrefix(generatedImage) } },
  ];

  for (const p of products) {
    const buf = await fetchBuffer(p.imageUrl);
    if (!buf) continue;
    contents.push({ inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") } });
  }

  const response = await withGeminiRetry(() =>
    ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: contents }],
    })
  );

  const text = (response?.candidates?.[0]?.content?.parts || [])
    .filter((p: any) => typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("")
    .trim();

  const cleaned = text.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Could not parse validation JSON from Gemini.");
  // Gemini occasionally emits literal newline/tab characters inside JSON string values
  // which makes JSON.parse throw. Sanitize by replacing control characters with spaces.
  try {
    return JSON.parse(match[0]);
  } catch {
    // Stage 1: strip control characters that break JSON strings
    const stage1 = match[0].replace(/[\n\r\t]/g, " ");
    try {
      return JSON.parse(stage1);
    } catch {
      // Stage 2: fix unquoted property names — Gemini occasionally emits {title: "x"}
      // instead of {"title": "x"}. Only replace bare identifiers after { or , delimiters.
      const stage2 = stage1.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
      try {
        return JSON.parse(stage2);
      } catch {
        // Stage 3: char-by-char failed (inner quotes in string values confuse peek logic).
        // Fall back to regex-based field extraction using the known schema structure.
        // This is safe because numeric/boolean fields never contain quotes.
        const extractNum = (key: string, src: string, def = 0): number => {
          const m = src.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
          return m ? Number(m[1]) : def;
        };
        const extractBool = (key: string, src: string, def = false): boolean => {
          const m = src.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
          return m ? m[1] === "true" : def;
        };
        const extractStringArray = (key: string, src: string): string[] => {
          const m = src.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`));
          if (!m) return [];
          return m[1].split(",").map((s: string) => s.replace(/["\s]/g, "").trim()).filter(Boolean);
        };
        // Extract products array: find all blocks between { } after "products": [
        const productsMatch = stage2.match(/"products"\s*:\s*\[([\s\S]*?)\]\s*[,}]/);
        const productsRaw = productsMatch ? productsMatch[1] : "";
        const productBlocks: string[] = [];
        let depth = 0, blockStart = -1;
        for (let i = 0; i < productsRaw.length; i++) {
          if (productsRaw[i] === "{") { if (depth === 0) blockStart = i; depth++; }
          else if (productsRaw[i] === "}") { depth--; if (depth === 0 && blockStart >= 0) { productBlocks.push(productsRaw.slice(blockStart, i + 1)); blockStart = -1; } }
        }
        const products = productBlocks.map((block: string) => {
          const titleM = block.match(/"title"\s*:\s*"([^"]*)"/);
          const catM = block.match(/"category"\s*:\s*"([^"]*)"/);
          return {
            title: titleM ? titleM[1] : "",
            category: catM ? catM[1] : "",
            presentInFinal: extractBool("presentInFinal", block, true),
            similarityScore: extractNum("similarityScore", block, 0),
            notes: "",
          };
        });
        return {
          geometryScore: extractNum("geometryScore", stage2, 70),
          hallucinationDetected: extractBool("hallucinationDetected", stage2, false),
          inventedItems: extractStringArray("inventedItems", stage2),
          inventedItemsBboxes: [],
          scaleIssues: extractStringArray("scaleIssues", stage2),
          notes: extractStringArray("notes", stage2),
          products,
        };
      }
    }
  }
}

// ─── Step 6: Crop invented items from generated image ─────────────────────────
// For each invented item with a bounding box, extracts a JPEG crop from the
// generated image. This is shown in the "AI Invented" panel so the user can
// visually inspect what the model hallucinated.
async function cropInventedItems(
  generatedDataUri: string,
  bboxes: Array<{ name: string; bbox: [number, number, number, number] }>
): Promise<Array<{ name: string; imageUrl: string }>> {
  if (!bboxes || !bboxes.length) return [];

  const raw = Buffer.from(stripDataUrlPrefix(generatedDataUri), "base64");
  const meta = await sharp(raw).metadata();
  const imgW = meta.width ?? 1024;
  const imgH = meta.height ?? 768;

  const crops: Array<{ name: string; imageUrl: string }> = [];

  for (const item of bboxes) {
    try {
      // Gemini may return bbox as array [y1,x1,y2,x2] or object {y_min,x_min,y_max,x_max}
      let y1n: number, x1n: number, y2n: number, x2n: number;
      if (Array.isArray(item.bbox)) {
        [y1n, x1n, y2n, x2n] = item.bbox.map(Number);
      } else if (item.bbox && typeof item.bbox === "object") {
        const b = item.bbox as any;
        y1n = Number(b.y_min ?? b.y1 ?? 0);
        x1n = Number(b.x_min ?? b.x1 ?? 0);
        y2n = Number(b.y_max ?? b.y2 ?? 1000);
        x2n = Number(b.x_max ?? b.x2 ?? 1000);
      } else {
        continue; // skip malformed bbox
      }
      // Skip if any coordinate is NaN or out of expected range
      if ([y1n, x1n, y2n, x2n].some((v) => !isFinite(v))) continue;

      // Add 8% padding around the crop so context is visible
      const padX = Math.round(((x2n - x1n) * 0.08 * imgW) / 1000);
      const padY = Math.round(((y2n - y1n) * 0.08 * imgH) / 1000);

      const left = Math.max(0, Math.round((x1n * imgW) / 1000) - padX);
      const top = Math.max(0, Math.round((y1n * imgH) / 1000) - padY);
      const right = Math.min(imgW, Math.round((x2n * imgW) / 1000) + padX);
      const bottom = Math.min(imgH, Math.round((y2n * imgH) / 1000) + padY);

      const cropW = right - left;
      const cropH = bottom - top;

      // Skip crops that are too small to be meaningful
      if (cropW < 80 || cropH < 80) continue;

      // Extract the crop first so we can check brightness
      const extracted = sharp(raw).extract({ left, top, width: cropW, height: cropH });

      // Check average brightness — skip very dark crops (score < 30/255)
      const { dominant } = await extracted.clone().stats();
      const brightness = (dominant.r + dominant.g + dominant.b) / 3;
      if (brightness < 30) continue;

      // Upscale small crops to at least 300px wide for clear display
      const targetW = Math.max(300, cropW);
      const cropBuf = await extracted
        .resize(targetW, null, { fit: "inside", withoutEnlargement: false })
        .jpeg({ quality: 90 })
        .toBuffer();

      crops.push({
        name: item.name,
        imageUrl: `data:image/jpeg;base64,${cropBuf.toString("base64")}`,
      });
    } catch (err) {
      console.warn(`Crop failed for invented item "${item.name}":`, err);
    }
  }

  return crops;
}

// ─── Score merging ────────────────────────────────────────────────────────────
function mergeValidationScores(geminiValidation: any, backgroundGeometryScore: number, productCount?: number) {
  const geminiGeometry = Number(geminiValidation?.geometryScore || 0);
  // rembg is objective pixel measurement — weight it more heavily than Gemini's subjective score
  const geometryScore =
    backgroundGeometryScore > 0
      ? Math.round(geminiGeometry * 0.35 + backgroundGeometryScore * 0.65)
      : geminiGeometry;

  // Slice to productCount so Gemini's extra entries for hallucinated furniture
  // don't drag down the catalogue average (e.g. 3rd entry at 15% giving 60% instead of 82%)
  const allGeminiProducts = Array.isArray(geminiValidation?.products) ? geminiValidation.products : [];
  const products = productCount ? allGeminiProducts.slice(0, productCount) : allGeminiProducts;
  const catalogueAverageScore = average(
    products
      .filter((p: any) => p.presentInFinal)
      .map((p: any) => Number(p.similarityScore || 0))
  );

  const inventedItems: string[] = Array.isArray(geminiValidation?.inventedItems)
    ? geminiValidation.inventedItems
    : [];
  const inventedItemsBboxes: Array<{ name: string; bbox: [number, number, number, number] }> =
    Array.isArray(geminiValidation?.inventedItemsBboxes)
      ? geminiValidation.inventedItemsBboxes
      : [];

  // Use only Gemini's own hallucinationDetected flag for the acceptance gate.
  // inventedItems may contain minor AI additions (small plant, cushion) which
  // are acceptable and shown in the panel — they should not block acceptance.
  // Only a deliberate hallucinationDetected:true from Gemini (major furniture
  // invented without a catalogue reference) hard-fails the validation.
  const hallucinationDetected = Boolean(geminiValidation?.hallucinationDetected);
  const notes: string[] = Array.isArray(geminiValidation?.notes) ? geminiValidation.notes : [];
  const scaleIssues: string[] = Array.isArray(geminiValidation?.scaleIssues) ? geminiValidation.scaleIssues : [];

  return {
    accepted:
      geometryScore >= MIN_GEOMETRY_SCORE &&
      geminiGeometry >= MIN_GEMINI_GEOMETRY && // hard gate: rembg must not override a clear structural failure
      catalogueAverageScore >= MIN_CATALOGUE_AVG,
    // Note: hallucinationDetected is NOT in the acceptance gate — Gemini flags small accessories
    // (vases, books, plants) as hallucinations even though the prompt says large furniture only.
    // This was causing catalogue=90% results to be rejected. Hallucination is logged and shown
    // in the UI panel but does not block acceptance.
    geometryScore,
    geminiGeometryScore: geminiGeometry, // exposed for logging and diagnosis
    catalogueAverageScore,
    hallucinationDetected,
    inventedItems,
    inventedItemsBboxes,
    scaleIssues,
    notes,
    products,
  };
}

function normalizeForMatch(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

function fuzzyMatchProduct(
  catalogueProduct: any,
  validationProduct: any
): boolean {
  const catTitle = normalizeForMatch(catalogueProduct.title);
  const valTitle = normalizeForMatch(validationProduct.title || "");
  const catCat = normalizeForMatch(catalogueProduct.category);
  const valCat = normalizeForMatch(validationProduct.category || "");

  // Exact category match
  if (catCat && valCat && catCat === valCat) return true;

  // Category substring match (e.g. "sofa" in "seating" or "seating" in "sofa")
  if (catCat && valCat && (catCat.includes(valCat) || valCat.includes(catCat))) return true;

  // Title: check if first 3 meaningful words of either title appear in the other
  const catWords = catTitle.split(" ").filter((w) => w.length > 3).slice(0, 4);
  const valWords = valTitle.split(" ").filter((w) => w.length > 3).slice(0, 4);
  const titleOverlap = catWords.filter((w) => valTitle.includes(w)).length;
  if (titleOverlap >= 2) return true;
  const titleOverlap2 = valWords.filter((w) => catTitle.includes(w)).length;
  if (titleOverlap2 >= 2) return true;

  return false;
}

function buildPlacedProducts(products: any[], validationProducts: any[]) {
  return products
    .map((p) => {
      // Use fuzzy matching so Gemini's paraphrased titles/categories still link correctly
      const match = validationProducts.find((v: any) => fuzzyMatchProduct(p, v));
      const score = Number(match?.similarityScore || 0);
      return {
        title: p.title,
        category: p.category,
        imageUrl: p.imageUrl,
        similarityScore: score,
      };
    })
    // Lower threshold: Gemini scores conservatively; 30+ means it genuinely sees the item
    .filter((p) => Number(p.similarityScore || 0) >= 30);
}

// ─── Step 7: Targeted edit loop (Pass 2) ─────────────────────────────────────
// After Pass 1 generates a WOW base room (text-only, geometry safe), this loop
// iterates through each catalogue product and swaps that furniture category in
// the room with the actual product image. Each edit is isolated to one category
// so geometry drift is minimised. The room evolves sequentially — each edit
// builds on the previous result.
async function runTargetedEditLoop(
  baseRoomDataUri: string,
  products: Array<{ title: string; category: string; imageUrl: string }>,
  roomType: string,
  theme: string
): Promise<string> {
  let currentRoomDataUri = baseRoomDataUri;

  for (const product of products) {
    const t0 = Date.now();
    try {
      // Fetch product image as data URI (handles both data: and remote URLs)
      const productDataUri = product.imageUrl.startsWith("data:")
        ? product.imageUrl
        : await fetchRemoteImageAsDataUri(product.imageUrl);
      if (!productDataUri) {
        console.warn(`Targeted edit: skipping "${product.title}" — could not fetch product image`);
        continue;
      }

      const { dataUri: resizedRoom } = await resizeDataUri(currentRoomDataUri, 1280);
      const roomUrl = await uploadToFal(resizedRoom, "targeted_base.jpg");
      const productUrl = await uploadToFal(productDataUri, "targeted_product.jpg");

      const prompt = buildTargetedSwapPrompt(product, roomType, theme);

      const editResult = (await fal.subscribe("fal-ai/flux-2-pro/edit", {
        input: { prompt, image_urls: [roomUrl, productUrl] },
      })) as any;

      const resultUrl = editResult?.data?.images?.[0]?.url;
      if (!resultUrl) {
        console.warn(`Targeted edit: FLUX returned no image for "${product.title}" — keeping previous room`);
        continue;
      }

      currentRoomDataUri = await falUrlToDataUri(resultUrl);
      console.log(`Targeted edit [${Math.round((Date.now() - t0) / 1000)}s]: ${product.category} → "${product.title}"`);
    } catch (err) {
      console.warn(`Targeted edit failed for "${product.title}" — keeping previous room:`, err);
      // On any error keep the previous (un-edited) room and continue
    }
  }

  return currentRoomDataUri;
}

// ─── Exported test helpers (not HTTP routes) ──────────────────────────────────
// These are exported so unit tests can import them without spinning up the server.
export const _test = {
  deduplicateByCategory,
  mergeValidationScores,
  buildPlacedProducts,
  stripDataUrlPrefix,
  average,
};

// ─── POST handler ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const originalImage = body?.originalImage as string;
    const styledBaseImage = body?.styledBaseImage as string | undefined;
    const rawProducts = Array.isArray(body?.products) ? body.products : [];
    const theme = String(body?.theme || "modern");
    const roomType = String(body?.roomType || "living_room");

    if (!originalImage) {
      return NextResponse.json({ ok: false, error: "originalImage is required" }, { status: 400 });
    }
    if (!rawProducts.length) {
      return NextResponse.json({ ok: false, error: "At least one product is required" }, { status: 400 });
    }

    // Allow up to 8 products — more references = richer, more fully-furnished room.
    const rawSlice = rawProducts.slice(0, 8);
    const products = deduplicateByCategory(rawSlice, theme).filter(
      (p) => Boolean(p?.imageUrl)
    );

    // Log what deduplication kept vs dropped — helps diagnose when fewer products than
    // expected reach FLUX (e.g. user selects 4 bed frames → only 1 passes through)
    const droppedByDedup = rawSlice.filter(
      (r) => !products.some((p) => p.title === r.title)
    );
    console.log(
      `Products received: ${rawSlice.length} → after dedup: ${products.length}` +
      (droppedByDedup.length
        ? ` (dropped: ${droppedByDedup.map((p) => `"${p.title}" [${p.category}]`).join(", ")})`
        : "")
    );
    if (!products.length) {
      return NextResponse.json({ ok: false, error: "No valid product images found" }, { status: 400 });
    }

    // ── Custom theme interpretation ───────────────────────────────────────
    // For free-text themes not in the predefined list, ask Gemini to generate
    // a rich directive and identify the closest predefined theme for catalogue.
    const themeIsCustom = !isKnownTheme(theme, roomType);
    let customDirective: string | undefined;
    let catalogueTheme = theme; // theme used for catalogue slot queries (may differ for custom)

    // ── Resize and upload room ──────────────────────────────────────────────
    // Bedroom + boho experiment: use original room as @image1 (geometry anchor) and
    // inspire image as @image2 (style reference) so FLUX preserves room structure
    // while matching the inspire aesthetic.
    const useInspireAsStyleRef = roomType === "bedroom" && /bohemian|boho|mid[\s_-]?century|midcentury/i.test(theme) && !!styledBaseImage;
    // Skip inspire entirely — use original room as base.
    // These themes produce strong results from text-only prompts; inspire causes geometry drift.
    // Custom themes also skip inspire since we have no predefined inspire style for them.
    // Kids room: always skip inspire — inspire introduces hallucinated doors, changed ceiling fans,
    // and other geometry drift. The text-only directive + product descriptions are sufficient.
    const skipInspire =
      roomType === "kids_room" ||
      (roomType === "bedroom" && (
        /modern|contemporary|luxury|luxurious|elegant|opulent|coastal|beach|nautical|japandi|scandi|scandinavian|nordic/i.test(theme)
        || themeIsCustom
      ));
    const baseImage = useInspireAsStyleRef ? originalImage : (skipInspire ? originalImage : (styledBaseImage || originalImage));
    const resizedRoom = await resizeDataUri(baseImage, 1280);
    const roomUrl = await uploadToFal(resizedRoom.dataUri, "room_base.jpg");

    // Upload inspire image as style reference when using the two-image approach
    let inspireStyleUrl: string | null = null;
    if (useInspireAsStyleRef && styledBaseImage) {
      const resizedInspire = await resizeDataUri(styledBaseImage, 1280);
      inspireStyleUrl = await uploadToFal(resizedInspire.dataUri, "inspire_style_ref.jpg");
    }

    // Generate rich Gemini visual descriptions for each product in parallel.
    // For custom themes, also run Gemini theme interpretation concurrently.
    console.log(`Products: ${products.length} — generating visual descriptions via Gemini...`);
    const descriptionPromises = products.map((p) => describeProductVisually(p.imageUrl, p.title, p.category));
    const customThemePromise = themeIsCustom ? interpretCustomTheme(theme, roomType) : null;

    const [productDescriptions, customThemeResult] = await Promise.all([
      Promise.all(descriptionPromises),
      customThemePromise,
    ]);
    if (customThemeResult) {
      customDirective = customThemeResult.directive;
      catalogueTheme = customThemeResult.closestTheme;
    }
    console.log(`Visual descriptions ready: ${productDescriptions.length}${themeIsCustom ? ` | custom theme → closest="${catalogueTheme}"` : ""}`);

    // ── FLUX receives room image only — no product reference images ───────────
    // Passing product images to flux-2-pro/edit causes geometry drift (geometry
    // drops to 52–68). Products are described via text in the prompt instead.
    // Gemini validation still receives product images separately for room section scoring.
    const imageUrls: string[] = inspireStyleUrl ? [roomUrl, inspireStyleUrl] : [roomUrl];
    console.log(`FLUX input: ${inspireStyleUrl ? "room + inspire style ref" : "room-only"}. ${products.length} products described as text, scored by Gemini.`);

    // ── Pass 1: Generation + validation retry loop ──────────────────────────
    let pass1Result: any = null;
    let pass1Accepted = false;
    // Geometry anchor: fal URL of the best-geometry rejected attempt.
    // When available, passed as @image2 to anchor room structure on the next attempt.
    let geometryAnchorUrl: string | null = null;
    let geometryAnchorGeminiScore = 0;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Build image list — add geometry anchor after existing images
      // When inspire style ref is active, it occupies @image2, so geometry anchor is @image3
      let attemptImageUrls: string[];
      let geometryAnchorRef: string | undefined;
      if (geometryAnchorUrl && inspireStyleUrl) {
        attemptImageUrls = [roomUrl, inspireStyleUrl, geometryAnchorUrl];
        geometryAnchorRef = "@image3";
      } else if (geometryAnchorUrl) {
        attemptImageUrls = [roomUrl, geometryAnchorUrl];
        geometryAnchorRef = "@image2";
      } else {
        attemptImageUrls = imageUrls;
        geometryAnchorRef = undefined;
      }

      const prompt = buildStrictEditPrompt({
        roomType,
        theme,
        products,
        attempt,
        previousValidation: pass1Result?.validation,
        productDescriptions,
        geometryAnchorRef,
        inspireStyleRef: inspireStyleUrl ? "@image2" : undefined,
        customDirective,
      });

      const fluxT0 = Date.now();
      const editResult = (await fal.subscribe("fal-ai/flux-2-pro/edit", {
        input: { prompt, image_urls: attemptImageUrls },
      })) as any;
      console.log(`Pass1 FLUX [${Math.round((Date.now() - fluxT0) / 1000)}s]`);

      const generatedUrl = editResult?.data?.images?.[0]?.url;
      if (!generatedUrl) throw new Error("FLUX.2 edit returned no image");

      const generatedImage = await falUrlToDataUri(generatedUrl);

      // Run rembg pixel-level geometry check and Gemini semantic validation in parallel
      const valT0 = Date.now();
      const [backgroundGeometryScore, geminiValidation] = await Promise.all([
        buildBackgroundMaskScore(originalImage, generatedImage),
        validateWithGemini({ originalImage, generatedImage, roomType, theme, products }),
      ]);
      const validation = mergeValidationScores(geminiValidation, backgroundGeometryScore, products.length);
      console.log(`Pass1 attempt ${attempt} [validation ${Math.round((Date.now() - valT0) / 1000)}s]: geometry=${validation.geometryScore} (gemini=${validation.geminiGeometryScore} rembg=${backgroundGeometryScore}) catalogue=${validation.catalogueAverageScore} hallucination=${validation.hallucinationDetected}`);

      const inventedItemCrops = await cropInventedItems(
        generatedImage,
        validation.inventedItemsBboxes || []
      );
      const placedProducts = buildPlacedProducts(products, validation.products);

      // Keep the best attempt so far (highest combined score)
      const combinedScore = validation.geometryScore * 0.5 + validation.catalogueAverageScore * 0.5;
      const lastCombined = pass1Result
        ? pass1Result.validation.geometryScore * 0.5 + pass1Result.validation.catalogueAverageScore * 0.5
        : -1;

      if (combinedScore > lastCombined) {
        pass1Result = {
          attempt,
          generatedImage,
          validation,
          placedProducts,
          inventedItemCrops,
          debug: {
            model: "fal-ai/flux-2-pro/edit",
            generatedUrl,
            backgroundGeometryScore,
            attemptsUsed: attempt,
          },
        };
      }

      // Accept immediately if geometry ≥ 80 — no point retrying when the room
      // shell is solid. Catalogue score is handled by Pass 2 targeted edits.
      const geometryStrong = validation.geometryScore >= 80;
      if (validation.accepted || geometryStrong) {
        pass1Accepted = true;
        if (geometryStrong && !validation.accepted) {
          console.log(`Pass1 ACCEPTED on attempt ${attempt} (geometry=${validation.geometryScore}% ≥ 80 — catalogue handled by Pass 2)`);
        } else {
          console.log(`Pass1 ACCEPTED on attempt ${attempt}`);
        }
        break;
      }

      console.warn(
        `Pass1 attempt ${attempt}/${MAX_ATTEMPTS} rejected — geometry=${validation.geometryScore} catalogue=${validation.catalogueAverageScore}`
      );

      // If this attempt had good geometry but low catalogue, save it as geometry anchor
      // for the next attempt — FLUX will use it as a structural reference.
      if (
        attempt < MAX_ATTEMPTS &&
        validation.geminiGeometryScore >= MIN_GEMINI_GEOMETRY &&
        validation.geminiGeometryScore > geometryAnchorGeminiScore
      ) {
        try {
          geometryAnchorUrl = await uploadToFal(generatedImage, "geometry_anchor.jpg");
          geometryAnchorGeminiScore = validation.geminiGeometryScore;
          console.log(`Geometry anchor saved (gemini=${validation.geminiGeometryScore}) for attempt ${attempt + 1}`);
        } catch (err) {
          console.warn("Failed to upload geometry anchor — continuing without it:", err);
        }
      }
    }

    // ── Pass 2: Targeted edit loop ─────────────────────────────────────────────
    // Edit only the SINGLE lowest-scoring product from Pass 1.
    // Rationale: editing 3 products sequentially causes cumulative noise in Gemini
    // re-scoring (unedited products shift ±5pts), masking whether the swap worked.
    // One edit = one clear before/after signal with minimal interference.
    let finalResult = pass1Result;

    const pass1Catalogue = pass1Result?.validation?.catalogueAverageScore ?? 0;

    // Log per-product Pass 1 scores for diagnosis
    if (pass1Result?.validation?.products?.length) {
      const perProduct = pass1Result.validation.products
        .map((v: any) => `${v.category}=${v.similarityScore}`)
        .join(", ");
      console.log(`Pass1 per-product scores: ${perProduct}`);
    }

    // Pass 2: targeted edits for products that scored below 65 in Pass 1.
    // Threshold raised from 80→65: only genuinely poor placements get a targeted edit.
    // Pass 2 is also skipped if Pass 1 geometry < 80 — a marginal base makes geometry
    // regression from targeted edits too likely (Scandi nightstand case: geometry 83→76,
    // hallucination introduced, Pass 2 correctly discarded but wasted 23s).
    const pass1HadHallucination = pass1Result?.validation?.hallucinationDetected ?? false;
    const pass1GeometryStrong = (pass1Result?.validation?.geometryScore ?? 0) >= 80;
    const productsToEdit = pass1Result
      ? products.filter((p) => {
          const match = pass1Result.validation.products?.find((v: any) => fuzzyMatchProduct(p, v));
          const score = Number(match?.similarityScore || 0);
          return score < 65; // only edit genuinely poor placements
        })
      : products;

    if (pass1Accepted && pass1Result && pass1GeometryStrong && productsToEdit.length > 0) {
      console.log(
        `Pass2: targeting ${productsToEdit.length} products (score<80): ${productsToEdit.map((p) => `${p.category}`).join(", ")}`
      );
      const pass2T0 = Date.now();
      try {
        const editedRoomDataUri = await runTargetedEditLoop(
          pass1Result.generatedImage,
          productsToEdit,
          roomType,
          theme
        );
        console.log(`Pass2 edits complete [${Math.round((Date.now() - pass2T0) / 1000)}s total]`);

        // Validate the targeted-edit result — geometry must stay intact
        const valT0 = Date.now();
        const [editedBgScore, editedGeminiVal] = await Promise.all([
          buildBackgroundMaskScore(originalImage, editedRoomDataUri),
          validateWithGemini({ originalImage, generatedImage: editedRoomDataUri, roomType, theme, products }),
        ]);
        const editedValidation = mergeValidationScores(editedGeminiVal, editedBgScore, products.length);
        console.log(`Pass2 validation [${Math.round((Date.now() - valT0) / 1000)}s]`);

        if (editedValidation.products?.length) {
          const perProduct = editedValidation.products
            .map((v: any) => `${v.category}=${v.similarityScore}`)
            .join(", ");
          console.log(`Pass2 per-product scores: ${perProduct}`);
        }
        console.log(`Pass2 result: geometry=${editedValidation.geometryScore} catalogue=${editedValidation.catalogueAverageScore} hallucination=${editedValidation.hallucinationDetected}`);

        const editedInventedCrops = await cropInventedItems(editedRoomDataUri, editedValidation.inventedItemsBboxes || []);
        const editedPlacedProducts = buildPlacedProducts(products, editedValidation.products);

        // Adopt Pass 2 if:
        //   1. geometry stays acceptable (≥ MIN_GEOMETRY_SCORE)
        //   2. geometry did not regress by more than 5 points vs Pass 1 — prevents targeted
        //      edits from drifting room structure even if still above the minimum threshold
        //   3. hallucination not introduced — if Pass 1 already had hallucination, Pass 2
        //      is not penalised for it (we're already returning a hallucinated room otherwise)
        //   4. catalogue did not regress by more than 5 points vs Pass 1
        const geometryAcceptable = editedValidation.geometryScore >= MIN_GEOMETRY_SCORE;
        const geometryNotRegressed = editedValidation.geometryScore >= pass1Result.validation.geometryScore - 5;
        const hallucinationOk = !editedValidation.hallucinationDetected || pass1HadHallucination;
        const catalogueNotRegressed = editedValidation.catalogueAverageScore >= pass1Catalogue - 5;

        if (geometryAcceptable && geometryNotRegressed && hallucinationOk && catalogueNotRegressed) {
          finalResult = {
            ...pass1Result,
            generatedImage: editedRoomDataUri,
            validation: editedValidation,
            placedProducts: editedPlacedProducts,
            inventedItemCrops: editedInventedCrops,
            debug: { ...pass1Result.debug, targetedEditApplied: true },
          };
          console.log(`Pass2 adopted: catalogue ${pass1Catalogue}%→${editedValidation.catalogueAverageScore}%, geometry ${pass1Result.validation.geometryScore}%→${editedValidation.geometryScore}%`);
        } else {
          console.log(
            `Pass2 discarded — geometry=${editedValidation.geometryScore}% (need ≥${MIN_GEOMETRY_SCORE}, was ${pass1Result.validation.geometryScore}%, max drop=5), ` +
            `hallucination=${editedValidation.hallucinationDetected} (pass1Had=${pass1HadHallucination}), ` +
            `catalogue=${editedValidation.catalogueAverageScore}% (was ${pass1Catalogue}%, max drop=5). Keeping Pass 1 result.`
          );
        }
      } catch (err) {
        console.warn("Targeted edit loop failed — using Pass 1 result:", err);
      }
    } else if (pass1Accepted && pass1Result && productsToEdit.length === 0) {
      console.log(`Pass2 skipped — all products scored ≥65 in Pass 1, no edits needed.`);
    } else if (pass1Accepted && pass1Result && !pass1GeometryStrong) {
      console.log(`Pass2 skipped — Pass 1 geometry=${pass1Result.validation.geometryScore}% (<80), too risky to edit.`);
    } else if (pass1Result) {
      console.log(`Pass2 skipped — Pass 1 not accepted yet (geometry not confirmed).`);
    }

    // ── Final response ─────────────────────────────────────────────────────────
    if (finalResult?.validation?.accepted || pass1Accepted) {
      return NextResponse.json({
        ok: true,
        generatedImage: finalResult.generatedImage,
        validation: { ...finalResult.validation, attemptsUsed: pass1Result?.attempt ?? MAX_ATTEMPTS },
        placedProducts: finalResult.placedProducts,
        inventedItemCrops: finalResult.inventedItemCrops,
        debug: finalResult.debug,
      });
    }

    // All passes rejected — return best-effort when the result is usable enough.
    // Threshold: catalogue ≥ 35 AND geometry ≥ 65 (looser than acceptance gate).
    // Rationale: hard 422 shows the user an error and discards a potentially good image.
    // For difficult themes (Boho, MCM) where gemini geometry consistently lands at 65
    // (just below the 68 hard gate), the best attempt is often visually acceptable.
    // The frontend receives lowConfidence=true and can display a visual warning.
    const MIN_BESTFFORT_CATALOGUE = 35;
    const MIN_BESTFFORT_GEOMETRY = 65;
    const bestEffortUsable = finalResult &&
      (finalResult.validation?.catalogueAverageScore ?? 0) >= MIN_BESTFFORT_CATALOGUE &&
      (finalResult.validation?.geometryScore ?? 0) >= MIN_BESTFFORT_GEOMETRY;

    if (bestEffortUsable) {
      console.log(
        `Returning best-effort result (all attempts rejected): ` +
        `geometry=${finalResult.validation.geometryScore}%, catalogue=${finalResult.validation.catalogueAverageScore}%`
      );
      return NextResponse.json({
        ok: true,
        lowConfidence: true,
        generatedImage: finalResult.generatedImage,
        validation: { ...finalResult.validation, attemptsUsed: MAX_ATTEMPTS },
        placedProducts: finalResult.placedProducts,
        inventedItemCrops: finalResult.inventedItemCrops,
        debug: finalResult.debug,
      });
    }

    // Hard failure — no usable result at all
    return NextResponse.json(
      {
        ok: false,
        error: `Validation rejected all attempts. Best: geometry=${finalResult?.validation?.geometryScore ?? 0}%, catalogue=${finalResult?.validation?.catalogueAverageScore ?? 0}%.`,
        generatedImage: finalResult?.generatedImage || null,
        validation: { ...(finalResult?.validation || {}), attemptsUsed: MAX_ATTEMPTS },
        placedProducts: finalResult?.placedProducts || [],
        inventedItemCrops: finalResult?.inventedItemCrops || [],
        debug: finalResult?.debug || null,
      },
      { status: 422 }
    );
  } catch (err) {
    console.error("fal-place-products error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Generation failed" },
      { status: 500 }
    );
  }
}
