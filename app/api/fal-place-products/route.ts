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
function deduplicateByCategory(
  products: Array<{ title: string; category: string; imageUrl: string; productHandle?: string }>
) {
  const seen = new Set<string>();
  return products.filter((p) => {
    const cat = String(p.category || "furniture").toLowerCase();
    if (seen.has(cat)) return false;
    seen.add(cat);
    return true;
  });
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

// ─── Theme directive ──────────────────────────────────────────────────────────
// Returns specific colour, material and mood cues for each theme.
// These are injected into the generation prompt so FLUX applies the aesthetic
// through furniture and soft furnishings WITHOUT touching room architecture.
function buildThemeDirective(theme: string): string {
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
      directive: "Palette: warm whites, soft greys, natural birch and oak wood tones. Materials: light wood, linen, wool, muted cotton. Feel: minimal, airy, clean lines, functional. No heavy ornamentation.",
    },
    {
      keys: ["japandi"],
      directive: "Palette: warm stone, ash grey, deep charcoal, natural walnut. Materials: dark oak, bamboo, washi paper, matte ceramics, natural linen. Feel: wabi-sabi calm, low-profile furniture, negative space, organic forms.",
    },
    {
      keys: ["coastal", "beach", "nautical"],
      directive: "Palette: sandy beige, ocean blue, seafoam green, crisp white, natural rope tones. Materials: weathered wood, jute, rattan, linen, woven seagrass. Feel: relaxed, breezy, light-filled, nautical accents.",
    },
    {
      keys: ["luxury", "luxurious", "elegant", "opulent"],
      directive: "Palette: deep navy, champagne gold, ivory, charcoal, rich burgundy. Materials: velvet upholstery, polished brass hardware, marble surfaces, lacquered wood, silk. Feel: opulent, layered, statement pieces, Hollywood glamour.",
    },
    {
      keys: ["industrial"],
      directive: "Palette: dark grey, matte black, raw concrete tone, warm amber, burnt orange accents. Materials: exposed steel frames, reclaimed wood, concrete, leather, Edison bulb lighting. Feel: urban loft, raw edges, utilitarian but stylish.",
    },
    {
      keys: ["bohemian", "boho"],
      directive: "Palette: terracotta, saffron yellow, deep teal, burnt sienna, faded rose. Materials: macramé, kilim rug, rattan, mixed-pattern cushions, carved wood, woven baskets. Feel: layered, eclectic, worldly, maximalist warmth.",
    },
    {
      keys: ["mid_century", "mid century", "midcentury"],
      directive: "Palette: warm walnut, mustard yellow, avocado green, burnt orange, off-white. Materials: teak and walnut wood, hairpin legs, boucle fabric, geometric patterns, enamelled metal. Feel: 1950s–60s, tapered legs, organic curves, retro-modern.",
    },
    {
      keys: ["modern", "contemporary"],
      directive: "Palette: crisp white, warm greige, matte black accents, natural wood highlights. Materials: smooth upholstery, clean-line wood, brushed metal, glass. Feel: uncluttered, sleek surfaces, functional elegance, no excessive decoration.",
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
}: {
  roomType: string;
  theme: string;
  products: Array<{ title: string; category: string }>;
  attempt: number;
  previousValidation?: any;
  productDescriptions: string[];
}) {
  const room = roomType.replace(/_/g, " ");

  const productIndexOffset = 2; // @image1 = room, products start at @image2
  const productLines = products.map((p, i) => {
    const imgRef = `@image${productIndexOffset + i}`;
    const desc = productDescriptions[i] || `${p.title} — ${p.category}`;
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
      retryDirectives.push(
        `RETRY ${attempt}/${MAX_ATTEMPTS}: Geometry was good (${prevGeometry}%) — DO NOT change the room structure at all.`,
        `The previous attempt preserved the room shell correctly. Keep ALL architectural elements IDENTICAL to @image1: walls, windows, doors, ceiling, floor, archways, camera angle.`,
        `Your ONLY task is to improve the furniture styling to better match the catalogue products described above.`,
        `Do NOT widen the room, do NOT remove windows, do NOT change wall colour or floor material.`
      );
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
    `${buildThemeDirective(theme)}`,
    `IMPORTANT: Express the theme ONLY through:`,
    `  • Furniture colours, upholstery fabric and material finishes`,
    `  • Rug pattern, cushion colours and throw textures`,
    `  • Lamp shade style and light warmth`,
    `  • Decorative accessories (vases, plants, artwork framing)`,
    `Do NOT express the theme through: wall colour, floor material, ceiling, windows, doors — these are LOCKED.`,
    ``,
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
    `• A large statement rug anchoring the seating area — bold pattern or rich texture matching the theme`,
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
    `• FIREPLACE: If a fireplace is visible in @image1, it must remain FULLY VISIBLE. Do NOT place any chair, sofa, cabinet, console, TV stand, plant, or any other item in front of or adjacent to the fireplace. Minimum 100cm clearance in front of the fireplace at all times.`,
    `• TV STAND: If the TV in @image1 is wall-mounted with no stand beneath it, do NOT add a TV stand or media console under it. A wall-mounted TV needs no stand.`,
    `• NEVER place storage/cabinet items (shoe cabinet, hallway cabinet) in a living room — these belong in entryways only`,
    `• NEVER place bedroom-specific furniture (wardrobe, dresser) in a living room`,
    `• NEVER place an office desk in a living room`,
    `• All furniture must have clear floor clearance and look naturally accessible`,
    ``,
    `═══ FINAL GEOMETRY CHECK — before rendering ═══`,
    `Verify the output matches @image1 exactly on: wall positions · window locations · camera angle · room proportions · archway/entry frame framing · fireplace visibility.`,
    `If the original was shot through an archway or door frame, that frame MUST appear in the output in the same position.`,
    `If a fireplace is visible in @image1, it must remain fully visible in the output — no furniture placed in front of it.`,
    `If any of these have shifted, correct them. The furniture changes completely; the room shell does not change at all.`,
    ``,
    `OUTPUT: Photorealistic, editorial-quality interior photography. Dramatic transformation of the furniture and soft furnishings. Rich, warm, aspirational — like a luxury interior design magazine cover. Consistent lighting and shadows from @image1.`,
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
    `Placement rules (CRITICAL):`,
    `• The replacement MUST occupy the exact same floor footprint and position as the item it replaces.`,
    `• Scale the replacement to match the size of the existing ${cat} — do NOT make it larger or smaller.`,
    `• Orientation must match: if the original faces left, the replacement faces left.`,
    `• The replacement must cast natural shadows consistent with the lighting in @image1.`,
    `• Match the dominant colour, material and silhouette of @image2 as closely as possible.`,
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
• Fireplace — if present in image1: any change to surround, style, or material = -20 pts
• Archways and room entry frames — if removed or reshaped = -15 pts
• Windows: position, size, frame — any change = -10 pts
• Doors: position, size, frame — any change = -10 pts
• Curtains/blinds — if replaced or removed = -5 pts
• Ceiling height, cornices, beams — any change = -10 pts
• Ceiling fixtures (fan, chandelier, pendant) — if changed = -5 pts
• Camera angle, perspective vanishing points — any shift = -15 pts
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
    const sanitized = match[0].replace(/[\n\r\t]/g, " ");
    return JSON.parse(sanitized);
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
      console.log(`Targeted edit applied: ${product.category} → "${product.title}"`);
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
    const products = deduplicateByCategory(rawSlice).filter(
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

    // ── Resize and upload room ──────────────────────────────────────────────
    const resizedRoom = await resizeDataUri(originalImage, 1280);
    const roomUrl = await uploadToFal(resizedRoom.dataUri, "room_base.jpg");

    // Generate rich Gemini visual descriptions for each product in parallel.
    // These replace the product images in the FLUX prompt — FLUX generates furniture
    // that closely matches each catalogue item without causing geometry drift.
    console.log(`Products: ${products.length} — generating visual descriptions via Gemini...`);
    const productDescriptions = await Promise.all(
      products.map((p) => describeProductVisually(p.imageUrl, p.title, p.category))
    );
    console.log(`Visual descriptions ready: ${productDescriptions.length}`);

    // ── FLUX receives room image only — no product reference images ───────────
    // Passing product images to flux-2-pro/edit causes geometry drift (geometry
    // drops to 52–68). Products are described via text in the prompt instead.
    // Gemini validation still receives product images separately for room section scoring.
    const imageUrls: string[] = [roomUrl];
    console.log(`FLUX input: room-only. ${products.length} products described as text, scored by Gemini.`);

    // ── Pass 1: Generation + validation retry loop ──────────────────────────
    let pass1Result: any = null;
    let pass1Accepted = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const prompt = buildStrictEditPrompt({
        roomType,
        theme,
        products,
        attempt,
        previousValidation: pass1Result?.validation,
        productDescriptions,
      });

      const editResult = (await fal.subscribe("fal-ai/flux-2-pro/edit", {
        input: { prompt, image_urls: imageUrls },
      })) as any;

      const generatedUrl = editResult?.data?.images?.[0]?.url;
      if (!generatedUrl) throw new Error("FLUX.2 edit returned no image");

      const generatedImage = await falUrlToDataUri(generatedUrl);

      // Run rembg pixel-level geometry check and Gemini semantic validation in parallel
      const [backgroundGeometryScore, geminiValidation] = await Promise.all([
        buildBackgroundMaskScore(originalImage, generatedImage),
        validateWithGemini({ originalImage, generatedImage, roomType, theme, products }),
      ]);
      const validation = mergeValidationScores(geminiValidation, backgroundGeometryScore, products.length);
      console.log(`Pass1 attempt ${attempt}: geometry=${validation.geometryScore} (gemini=${validation.geminiGeometryScore} rembg=${backgroundGeometryScore}) catalogue=${validation.catalogueAverageScore} hallucination=${validation.hallucinationDetected}`);

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

      if (validation.accepted) {
        pass1Accepted = true;
        console.log(`Pass1 ACCEPTED on attempt ${attempt}`);
        break;
      }

      console.warn(
        `Pass1 attempt ${attempt}/${MAX_ATTEMPTS} rejected — geometry=${validation.geometryScore} catalogue=${validation.catalogueAverageScore}`
      );
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

    // Pick the single lowest-scoring product (sort ascending, take first)
    const lowScoringProducts = pass1Result
      ? products
          .map((p) => {
            const match = pass1Result.validation.products?.find((v: any) => fuzzyMatchProduct(p, v));
            return { product: p, score: Number(match?.similarityScore || 0) };
          })
          .filter(({ score }) => score < 60)
          .sort((a, b) => a.score - b.score) // worst first
          .slice(0, 1) // single edit only
          .map(({ product }) => product)
      : [];

    const shouldRunTargetedEdits =
      lowScoringProducts.length > 0 && pass1Catalogue < TARGETED_EDIT_CATALOGUE_THRESHOLD;

    if (shouldRunTargetedEdits) {
      console.log(
        `Pass2: editing single lowest-scoring product: ${lowScoringProducts[0].category} ("${lowScoringProducts[0].title}")`
      );
      try {
        const editedRoomDataUri = await runTargetedEditLoop(
          pass1Result.generatedImage,
          lowScoringProducts,
          roomType,
          theme
        );

        // Validate the targeted-edit result
        const [editedBgScore, editedGeminiVal] = await Promise.all([
          buildBackgroundMaskScore(originalImage, editedRoomDataUri),
          validateWithGemini({ originalImage, generatedImage: editedRoomDataUri, roomType, theme, products }),
        ]);
        const editedValidation = mergeValidationScores(editedGeminiVal, editedBgScore, products.length);

        // Log per-product after scores — key diagnostic: did the edited product improve?
        if (editedValidation.products?.length) {
          const perProduct = editedValidation.products
            .map((v: any) => `${v.category}=${v.similarityScore}`)
            .join(", ");
          console.log(`Targeted edit per-product scores: ${perProduct}`);
        }
        console.log(`Targeted edit result: geometry=${editedValidation.geometryScore} (gemini=${editedValidation.geminiGeometryScore} rembg=${editedBgScore}) catalogue=${editedValidation.catalogueAverageScore} hallucination=${editedValidation.hallucinationDetected}`);

        const editedInventedCrops = await cropInventedItems(editedRoomDataUri, editedValidation.inventedItemsBboxes || []);
        const editedPlacedProducts = buildPlacedProducts(products, editedValidation.products);

        // Adoption criterion: did the SPECIFICALLY edited product improve?
        // This avoids false negatives where Gemini noise on unedited products drags
        // the total average down even when the targeted swap worked correctly.
        const editedProductScoreBefore = pass1Result.validation.products
          ?.filter((v: any) => lowScoringProducts.some((p) => fuzzyMatchProduct(p, v)))
          .map((v: any) => Number(v.similarityScore || 0)) ?? [];
        const editedProductScoreAfter = editedValidation.products
          ?.filter((v: any) => lowScoringProducts.some((p) => fuzzyMatchProduct(p, v)))
          .map((v: any) => Number(v.similarityScore || 0)) ?? [];

        const avgBefore = editedProductScoreBefore.length ? average(editedProductScoreBefore) : 0;
        const avgAfter = editedProductScoreAfter.length ? average(editedProductScoreAfter) : 0;
        console.log(`Edited product score: ${avgBefore}% → ${avgAfter}%`);

        // Adopt if: edited product improved AND geometry stayed acceptable AND no hallucination
        const MAX_GEOMETRY_DROP = 8;
        const editedProductImproved = avgAfter > avgBefore;
        const geometryAcceptable =
          editedValidation.geometryScore >= MIN_GEOMETRY_SCORE &&
          editedValidation.geometryScore >= pass1Result.validation.geometryScore - MAX_GEOMETRY_DROP;
        const noHallucination = !editedValidation.hallucinationDetected;

        if (geometryAcceptable && editedProductImproved && noHallucination) {
          finalResult = {
            ...pass1Result,
            generatedImage: editedRoomDataUri,
            validation: editedValidation,
            placedProducts: editedPlacedProducts,
            inventedItemCrops: editedInventedCrops,
            debug: { ...pass1Result.debug, targetedEditApplied: true },
          };
          console.log(`Targeted edit adopted: edited product ${avgBefore}%→${avgAfter}%, catalogue ${pass1Catalogue}%→${editedValidation.catalogueAverageScore}%, geometry ${pass1Result.validation.geometryScore}%→${editedValidation.geometryScore}%`);
        } else {
          console.log(
            `Targeted edit discarded — edited product ${avgBefore}%→${avgAfter}% (improved=${editedProductImproved}), ` +
            `geometry=${editedValidation.geometryScore}% (need ≥${MIN_GEOMETRY_SCORE}, drop≤${MAX_GEOMETRY_DROP}), ` +
            `hallucination=${editedValidation.hallucinationDetected}`
          );
        }
      } catch (err) {
        console.warn("Targeted edit loop failed — using Pass 1 result:", err);
      }
    } else if (pass1Result) {
      console.log(`Pass2 skipped — no products below 60% or catalogue already at ${pass1Catalogue}%`);
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

    // All passes rejected — return best-effort result
    return NextResponse.json(
      {
        ok: false,
        error: `Validation rejected all attempts. Best: geometry=${finalResult?.validation?.geometryScore ?? 0}%, catalogue=${finalResult?.validation?.catalogueAverageScore ?? 0}%, hallucination=${finalResult?.validation?.hallucinationDetected ? "yes" : "no"}.`,
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
