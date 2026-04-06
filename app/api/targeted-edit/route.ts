// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { fal, uploadToFal, falUrlToDataUri } from "@/lib/falClient";

// ── Utilities ─────────────────────────────────────────────────────────────────

function stripDataUrlPrefix(input: string): string {
  const idx = input.indexOf(",");
  return idx >= 0 ? input.slice(idx + 1) : input;
}

async function resizeDataUri(
  dataUri: string,
  maxSide = 1280
): Promise<string> {
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
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
}

async function fetchRemoteImageAsDataUri(imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    return `data:${mimeType};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

const OUTDOOR_ROOMS = new Set(["frontyard", "backyard"]);

function buildGeometryLock(roomType: string): string[] {
  if (OUTDOOR_ROOMS.has(roomType)) {
    return [
      `═══ SCENE LOCK — ABSOLUTE ═══`,
      `The outdoor scene structure is FIXED. Do NOT change:`,
      `• Ground surface: lawn, paving, deck, soil — unchanged`,
      `• Sky, fencing, hedges, walls, pathways — unchanged`,
      `• House facade, garage, gates visible in the scene — unchanged`,
      `• Camera angle, perspective, and spatial proportions — IDENTICAL to @image1`,
      `• Ambient lighting and time-of-day feel — unchanged`,
    ];
  }
  if (roomType === "hallway") {
    return [
      `═══ GEOMETRY LOCK — ABSOLUTE ═══`,
      `The hallway structure is FIXED. Do NOT change:`,
      `• Walls, wall colour, panelling, skirting boards — unchanged`,
      `• Doors and doorways: position, size, frame — unchanged`,
      `• Floor material, colour, texture — unchanged`,
      `• Ceiling height, light fittings — unchanged`,
      `• Camera angle, perspective — IDENTICAL to @image1`,
    ];
  }
  if (roomType === "loft") {
    return [
      `═══ GEOMETRY LOCK — ABSOLUTE ═══`,
      `The loft/foyer structure is FIXED. Do NOT change:`,
      `• Walls, wall colour, architectural columns or pillars — unchanged`,
      `• Staircase, mezzanine railings — unchanged`,
      `• Floor material and ceiling — unchanged`,
      `• Camera angle, perspective — IDENTICAL to @image1`,
    ];
  }
  // Default — all indoor rooms (living_room, bedroom, dining_room, kitchen, office, kids_room)
  return [
    `═══ GEOMETRY LOCK — ABSOLUTE ═══`,
    `The room structure is FIXED. Do NOT change:`,
    `• Walls, wall colour, wall panels`,
    `• Windows: position, size, glass, frame`,
    `• Doors: position, size, frame`,
    `• Curtains, blinds`,
    `• Floor material, colour, texture — tile stays tile, wood stays wood, carpet stays carpet`,
    `• Fireplace: if visible, surround, style and material are LOCKED — do NOT replace or restyle`,
    `• Archways and room entry frames — preserve exactly, do NOT remove or reshape`,
    `• Ceiling, ceiling fixtures (fan, chandelier, pendant lights) — unchanged`,
    `• Camera angle, perspective, room proportions`,
  ];
}

function buildTextEditPrompt(instruction: string, roomType: string, theme: string): string {
  const room = roomType.replace(/_/g, " ");
  const isOutdoor = OUTDOOR_ROOMS.has(roomType);
  const itemsLabel = isOutdoor ? "outdoor furniture, planters, and accessories" : "furniture, decor, and accessories";
  return [
    `@image1 is a styled ${room} photograph.`,
    ``,
    ...buildGeometryLock(roomType),
    `You may ONLY modify the specific item described in the edit instruction below.`,
    `All other ${itemsLabel} in @image1 must remain exactly as-is.`,
    ``,
    `═══ TARGETED EDIT INSTRUCTION ═══`,
    `Apply ONLY this single change to the scene:`,
    `"${instruction}"`,
    ``,
    `Rules for the edit:`,
    `• Change ONLY what is explicitly mentioned. Everything else is untouched.`,
    `• The replacement item must fit naturally in the same position and scale as what it replaces.`,
    `• Match the ${theme} style theme.`,
    `• Lighting and shadows must remain consistent with @image1.`,
    `• Do NOT add new objects. Do NOT remove objects other than what is being replaced.`,
    ``,
    `═══ PHYSICAL GROUNDING — all items must obey gravity ═══`,
    `• Floor lamps: base must rest visibly on the floor — do NOT float or hang`,
    `• Table lamps / desk lamps: base MUST sit on a side table, console, shelf, or fireplace mantel — NEVER on the floor`,
    `• If no surface exists nearby for a table lamp, place it on the fireplace mantel or closest shelf`,
    `• Wall art: must be mounted flat and flush against a wall`,
    `• Sofas, chairs, benches, tables: legs or base must visibly contact the floor`,
    `• No item may appear hovering, floating, or suspended without visible physical support`,
    ``,
    `═══ LAMP SCALE — strictly enforced ═══`,
    `• A table lamp shade must appear SMALLER than a sofa cushion — max shade width ~40cm`,
    `• A floor lamp total height must not exceed the top of the sofa back`,
    `• If the lamp appears oversized, scale it DOWN — never scale it up`,
    ``,
    `OUTPUT: Photorealistic, professional ${isOutdoor ? "exterior" : "interior"} photography quality. Only the targeted item changes.`,
  ].join("\n");
}

function buildProductSwapPrompt(
  product: { title: string; category: string },
  roomType: string,
  theme: string
): string {
  const room = roomType.replace(/_/g, " ");
  const cat = product.category.replace(/_/g, " ");
  const isOutdoor = OUTDOOR_ROOMS.has(roomType);
  const itemsLabel = isOutdoor ? "outdoor furniture, planters, and accessories" : "furniture, decor, and accessories";
  return [
    `@image1 is a styled ${room} photograph.`,
    `@image2 is a product reference image: "${product.title}" (${cat}).`,
    ``,
    ...buildGeometryLock(roomType),
    `You may ONLY replace the existing ${cat} in the scene with the product shown in @image2.`,
    `All other ${itemsLabel} must remain exactly as-is.`,
    ``,
    `═══ TARGETED PRODUCT SWAP ═══`,
    `Find the existing ${cat} in @image1 and replace it with @image2.`,
    ``,
    `Rules:`,
    `• Place @image2 in the exact same position, orientation and scale as the existing ${cat}.`,
    `• Match the shape, silhouette, material and dominant colour of @image2 as closely as possible.`,
    `• The replacement must look naturally lit and shadow-consistent with @image1.`,
    `• Do NOT move any other item. Do NOT add or remove any other objects.`,
    `• The ${theme} theme must still feel cohesive.`,
    ``,
    `═══ PHYSICAL GROUNDING — the replacement item must obey gravity ═══`,
    `• Floor lamps: base must rest visibly on the floor — do NOT float or hang`,
    `• Table lamps / desk lamps: base MUST sit on a side table, console, shelf, or fireplace mantel — NEVER on the floor`,
    `• If no surface exists nearby for a table lamp, place it on the fireplace mantel or closest shelf`,
    `• Wall art: must be mounted flat and flush against a wall`,
    `• Sofas, chairs, benches, tables: legs or base must visibly contact the floor`,
    `• No item may appear hovering, floating, or suspended without visible physical support`,
    ``,
    `═══ LAMP SCALE — strictly enforced ═══`,
    `• A table lamp shade must appear SMALLER than a sofa cushion — max shade width ~40cm`,
    `• A floor lamp total height must not exceed the top of the sofa back`,
    `• If the lamp appears oversized, scale it DOWN — never scale it up`,
    ``,
    `OUTPUT: Photorealistic, professional ${isOutdoor ? "exterior" : "interior"} photography quality. Only the ${cat} changes.`,
  ].join("\n");
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const generatedImage: string = body?.generatedImage;
    const roomType: string = body?.roomType || "living_room";
    const theme: string = body?.theme || "modern";

    // Two modes: text edit OR product swap
    const editInstruction: string | null = body?.editInstruction || null;
    const product: { title: string; category: string; imageUrl: string } | null =
      body?.product || null;

    if (!generatedImage) {
      return NextResponse.json({ error: "generatedImage is required" }, { status: 400 });
    }
    if (!editInstruction && !product) {
      return NextResponse.json(
        { error: "Either editInstruction or product is required" },
        { status: 400 }
      );
    }

    // Upload the generated room image
    const resizedRoom = await resizeDataUri(generatedImage, 1280);
    const roomUrl = await uploadToFal(resizedRoom, "targeted_edit_base.jpg");

    const imageUrls: string[] = [roomUrl];
    let prompt: string;

    if (product) {
      // Product swap mode — upload product image as reference
      if (!product.imageUrl) {
        return NextResponse.json({ error: "product.imageUrl is required" }, { status: 400 });
      }
      const productDataUri = product.imageUrl.startsWith("data:")
        ? product.imageUrl
        : await fetchRemoteImageAsDataUri(product.imageUrl);

      if (!productDataUri) {
        return NextResponse.json(
          { error: "Could not fetch product image" },
          { status: 400 }
        );
      }
      const productUrl = await uploadToFal(productDataUri, "swap_product.jpg");
      imageUrls.push(productUrl);
      prompt = buildProductSwapPrompt(product, roomType, theme);
    } else {
      // Text edit mode
      prompt = buildTextEditPrompt(editInstruction!, roomType, theme);
    }

    const editResult = (await fal.subscribe("fal-ai/flux-2-pro/edit", {
      input: { prompt, image_urls: imageUrls },
    })) as any;

    const resultUrl = editResult?.data?.images?.[0]?.url;
    if (!resultUrl) {
      throw new Error("fal-ai/flux-2-pro/edit returned no image");
    }

    const resultImage = await falUrlToDataUri(resultUrl);

    return NextResponse.json({
      ok: true,
      generatedImage: resultImage,
      mode: product ? "product_swap" : "text_edit",
    });
  } catch (error) {
    console.error("targeted-edit error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Targeted edit failed" },
      { status: 500 }
    );
  }
}
