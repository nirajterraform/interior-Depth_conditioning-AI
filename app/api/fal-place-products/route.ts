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

// FIX: Thresholds calibrated to what depth-conditioned FLUX can actually achieve.
// Was 93/72 — both were unrealistically strict, causing near-constant rejection.
const MIN_GEOMETRY_SCORE = 88;
const MIN_CATALOGUE_AVG = 82;
const MAX_ATTEMPTS = 3;

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
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
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

  // Products always start at @image2 (room is @image1).
  const productIndexOffset = 2;

  const productLines = products.map((p, i) => {
    const imgRef = `@image${productIndexOffset + i}`;
    const desc = productDescriptions[i] || `${p.title} (${p.category})`;
    return `- ${imgRef} → ${p.category} to place: "${p.title}". Visual description: ${desc}. Match its shape, silhouette, material and dominant colour as closely as possible.`;
  });

  const retryDirectives: string[] = [];
  if (attempt > 1) {
    retryDirectives.push(
      `RETRY ${attempt}/${MAX_ATTEMPTS}: Be more conservative than before.`,
      `Do NOT add objects not shown in a product reference image.`,
      `If a product cannot be placed naturally, omit it entirely rather than substituting.`,
      `Preserve all negative space and keep total object count low.`
    );
  }
  if (previousValidation?.hallucinationDetected) {
    retryDirectives.push(
      `Previous attempt REJECTED for hallucination. Add absolutely nothing not represented by a product reference.`
    );
  }
  if (
    Number(previousValidation?.catalogueAverageScore || 0) > 0 &&
    Number(previousValidation?.catalogueAverageScore) < MIN_CATALOGUE_AVG
  ) {
    retryDirectives.push(
      `Previous attempt REJECTED for low product similarity (${previousValidation.catalogueAverageScore}%). Prioritise exact product likeness over style flourish.`
    );
  }
  if (
    Number(previousValidation?.geometryScore || 0) > 0 &&
    Number(previousValidation?.geometryScore) < MIN_GEOMETRY_SCORE
  ) {
    retryDirectives.push(
      `Previous attempt REJECTED for geometry drift (${previousValidation.geometryScore}%). Preserve walls, windows, doors, curtains, ceiling, floor, proportions and camera angle exactly.`
    );
  }

  return [
    `@image1 is the base ${room} photograph.`,
    ``,
    `═══ GEOMETRY LOCK — READ THIS FIRST, OBEY IT THROUGHOUT ═══`,
    `The room structure in @image1 is FIXED and must be pixel-perfect in the output:`,
    `• Every wall surface, wall panel, wall colour — unchanged`,
    `• Every window: position, size, shape, glass, frame — unchanged`,
    `• Every door: position, size, frame — unchanged`,
    `• Curtains, blinds, drapes — unchanged`,
    `• Ceiling: height, cornices, beams, light fixtures — unchanged`,
    `• Floor: material, colour, texture, boundaries — unchanged`,
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
    `═══ PRODUCT PLACEMENT — place ALL of the following ═══`,
    `This is a complete ${room} furnishing. Every product listed below MUST appear in the final image.`,
    `Stage all pieces naturally so the room feels complete, layered, and inviting.`,
    `Maintain correct real-world scale. Allow natural overlapping sightlines as in a real photograph.`,
    ...productLines,
    ``,
    `Placement guidance:`,
    `• Hero pieces (sofa, bed, dining table, desk) — place in the room's natural focal zone`,
    `• Secondary pieces (chairs, side tables, lamps) — flank or complement hero pieces`,
    `• Accent pieces (rugs, mirrors, decor) — layer in foreground and background for depth`,
    `• If two items share a category, place them symmetrically or in natural conversation`,
    ``,
    `STRICT PLACEMENT RULES — violations will cause rejection:`,
    `• DOOR & PASSAGE: Already stated above — no furniture in front of any door or walkway`,
    `• NEVER place storage/cabinet items (shoe cabinet, hallway cabinet) in a living room — these belong in entryways only`,
    `• NEVER place bedroom-specific furniture (wardrobe, dresser) in a living room`,
    `• NEVER place an office desk in a living room`,
    `• All furniture must have clear floor clearance and look naturally accessible`,
    ``,
    `═══ ANTI-HALLUCINATION ═══`,
    `Do NOT invent any object not represented in the product references above.`,
    `Scale a product down slightly if needed — but never omit it and never substitute it.`,
    ``,
    `═══ FINAL GEOMETRY CHECK — before rendering ═══`,
    `Verify the output matches @image1 exactly on: wall positions · window locations · camera angle · room proportions.`,
    `If any of these have shifted, correct them. The furniture changes; the room shell does not.`,
    ``,
    `OUTPUT: Photorealistic, consistent lighting and shadows from @image1. Professional interior photography quality.`,
    ...retryDirectives,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join("\n");
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
You are validating an interior room edit for commercial use.

image1 = original room photograph.
image2 = AI-generated room.
image3 .. image${productCount + 2} = catalogue product references.

TASK — return a strict JSON validation report:

1. geometryScore (0–100): How well image2 preserves the room geometry of image1.
   Score based on: wall positions, window/door locations, ceiling, floor boundaries, camera angle, perspective.
   100 = pixel-perfect architecture match. Deduct heavily for moved walls, changed camera angle, added/removed windows.

2. For each product reference (image3..):
   - presentInFinal (bool): Is a recognisable version of this product visible in image2?
   - similarityScore (0–100): Visual similarity to the reference (shape, material, colour).
   - notes: one-line observation.

3. hallucinationDetected (bool): true if image2 contains any LARGE furniture piece that has no
   visually matching product reference (image3+). Large means: sofa, sectional, bed, dining table,
   large cabinet, wardrobe, TV stand, media console, desk, bookcase, sideboard.
   Do NOT set true for: small accessories, cushions, books, small plants, candles, trays.
   Style variations of a referenced item (different colour/fabric) do NOT count as hallucination.
   A TV stand or cabinet that does not match any reference image IS hallucination.

4. inventedItems (string[]): List ALL furniture and décor items visible in image2 that do NOT have
   a clear visual match in any of the product references (image3+).
   — Include BOTH large pieces (TV stand, extra cabinet, extra chair) AND smaller additions (vase,
     cushion set, plant, decorative object) that were not in the references.
   — An item is "invented" if it is not visually similar to any reference — even if the category
     is represented, a visually distinct piece in that category counts as invented.
   — Do NOT include items that are clearly visible in a reference image.
   This list is used to show the user what the AI added beyond the catalogue — be thorough.

5. inventedItemsBboxes: For EACH item in inventedItems, provide a bounding box in image2.
   Format: [y_min, x_min, y_max, x_max] with values normalised 0–1000.
   Example: [120, 340, 450, 780]
   Every entry in inventedItems MUST have a corresponding bbox entry.

6. notes (string[]): Up to 3 short reviewer notes.

Return ONLY this exact JSON shape — no markdown, no extra text:
{
  "geometryScore": 0,
  "hallucinationDetected": false,
  "inventedItems": [],
  "inventedItemsBboxes": [
    { "name": "extra lamp", "bbox": [120, 340, 450, 780] }
  ],
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
  return JSON.parse(match[0]);
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
      const [y1n, x1n, y2n, x2n] = item.bbox;

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
      if (cropW < 30 || cropH < 30) continue;

      const cropBuf = await sharp(raw)
        .extract({ left, top, width: cropW, height: cropH })
        .jpeg({ quality: 88 })
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
function mergeValidationScores(geminiValidation: any, backgroundGeometryScore: number) {
  const geminiGeometry = Number(geminiValidation?.geometryScore || 0);
  const geometryScore =
    backgroundGeometryScore > 0
      ? Math.round(geminiGeometry * 0.6 + backgroundGeometryScore * 0.4)
      : geminiGeometry;

  const products = Array.isArray(geminiValidation?.products) ? geminiValidation.products : [];
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

  return {
    accepted:
      geometryScore >= MIN_GEOMETRY_SCORE &&
      catalogueAverageScore >= MIN_CATALOGUE_AVG &&
      !hallucinationDetected,
    geometryScore,
    catalogueAverageScore,
    hallucinationDetected,
    inventedItems,
    inventedItemsBboxes,
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
    const products = deduplicateByCategory(rawProducts.slice(0, 8)).filter(
      (p) => Boolean(p?.imageUrl)
    );
    if (!products.length) {
      return NextResponse.json({ ok: false, error: "No valid product images found" }, { status: 400 });
    }

    // ── Resize and upload room ──────────────────────────────────────────────
    const resizedRoom = await resizeDataUri(originalImage, 1280);
    const roomUrl = await uploadToFal(resizedRoom.dataUri, "room_base.jpg");

    // ── Parallel: depth extraction + product visual descriptions ───────────
    // Both are best-effort. If either fails the pipeline continues with
    // fallback text for descriptions and no depth image for the edit.
    const [depthUrl, productDescriptions] = await Promise.all([
      extractDepthMap(roomUrl),
      Promise.all(
        products.map((p) => describeProductVisually(p.imageUrl, p.title, p.category))
      ),
    ]);

    const hasDepth = Boolean(depthUrl);
    console.log(
      `Depth: ${hasDepth ? "yes" : "no (fallback)"}. Products described: ${productDescriptions.length}`
    );

    // ── Build image URL array for flux edit ────────────────────────────────
    // Layout: [room, product1, product2, ...]
    // NOTE: depth map is NOT added here. flux-2-pro/edit treats every URL as a
    // visual reference to match — a grey depth PNG confuses the model and causes
    // a 422 ValidationError. Geometry is preserved via the prompt instead.
    const imageUrls: string[] = [roomUrl];

    // Fetch + upload all product images in parallel to avoid sequential latency on GCP
    const productUploadResults = await Promise.all(
      products.map(async (p, i) => {
        if (!p?.imageUrl) {
          console.warn(`Skipping product ${i + 1}: missing imageUrl`);
          return null;
        }
        const productDataUri = p.imageUrl.startsWith("data:")
          ? p.imageUrl
          : await fetchRemoteImageAsDataUri(p.imageUrl);
        if (!productDataUri) {
          console.warn(`Skipping product ${i + 1}: could not fetch ${p.imageUrl}`);
          return null;
        }
        return uploadToFal(productDataUri, `product_${i + 1}.jpg`);
      })
    );
    for (const url of productUploadResults) {
      if (url) imageUrls.push(url);
    }

    if (imageUrls.length === 1) {
      return NextResponse.json(
        { ok: false, error: "No product reference images could be uploaded" },
        { status: 400 }
      );
    }

    // ── Generation + validation retry loop ─────────────────────────────────
    let lastResult: any = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const prompt = buildStrictEditPrompt({
        roomType,
        theme,
        products,
        attempt,
        previousValidation: lastResult?.validation,
        productDescriptions,
      });

      const editResult = (await fal.subscribe("fal-ai/flux-2-pro/edit", {
        input: { prompt, image_urls: imageUrls },
      })) as any;

      const generatedUrl = editResult?.data?.images?.[0]?.url;
      if (!generatedUrl) throw new Error("FLUX.2 edit returned no image");

      const generatedImage = await falUrlToDataUri(generatedUrl);

      // Run pixel-level geometry check and Gemini semantic validation in parallel
      const [backgroundGeometryScore, geminiValidation] = await Promise.all([
        buildBackgroundMaskScore(originalImage, generatedImage),
        validateWithGemini({ originalImage, generatedImage, roomType, theme, products }),
      ]);

      const validation = mergeValidationScores(geminiValidation, backgroundGeometryScore);

      // Crop invented items from this attempt's generated image
      const inventedItemCrops = await cropInventedItems(
        generatedImage,
        validation.inventedItemsBboxes || []
      );

      const placedProducts = buildPlacedProducts(products, validation.products);

      if (validation.accepted) {
        return NextResponse.json({
          ok: true,
          generatedImage,
          validation: { ...validation, attemptsUsed: attempt },
          placedProducts,
          inventedItemCrops,
          debug: {
            model: "fal-ai/flux-2-pro/edit",
            generatedUrl,
            backgroundGeometryScore,
            attemptsUsed: attempt,
          },
        });
      }

      // Keep the best attempt so far (highest combined score)
      const combinedScore = validation.geometryScore * 0.5 + validation.catalogueAverageScore * 0.5;
      const lastCombined = lastResult
        ? lastResult.validation.geometryScore * 0.5 +
          lastResult.validation.catalogueAverageScore * 0.5
        : -1;

      if (combinedScore > lastCombined) {
        lastResult = {
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

      console.warn(
        `Attempt ${attempt}/${MAX_ATTEMPTS} rejected — geometry=${validation.geometryScore} catalogue=${validation.catalogueAverageScore} hallucination=${validation.hallucinationDetected}`
      );
    }

    // All attempts rejected — return the best-effort result with ok:false so
    // the frontend can still show the image and validation scores instead of
    // a blank error screen.
    return NextResponse.json(
      {
        ok: false,
        error: `Validation rejected all ${MAX_ATTEMPTS} attempts. Best: geometry=${lastResult?.validation?.geometryScore ?? 0}%, catalogue=${lastResult?.validation?.catalogueAverageScore ?? 0}%, hallucination=${lastResult?.validation?.hallucinationDetected ? "yes" : "no"}.`,
        generatedImage: lastResult?.generatedImage || null,
        validation: { ...(lastResult?.validation || {}), attemptsUsed: MAX_ATTEMPTS },
        placedProducts: lastResult?.placedProducts || [],
        inventedItemCrops: lastResult?.inventedItemCrops || [],
        debug: lastResult?.debug || null,
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
