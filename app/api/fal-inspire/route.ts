// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { fal, uploadToFal, falUrlToDataUri } from "@/lib/falClient";

// ── Utilities ─────────────────────────────────────────────────────────────────

function stripDataUrlPrefix(input: string): string {
  const idx = input.indexOf(",");
  return idx >= 0 ? input.slice(idx + 1) : input;
}

async function resizeDataUri(dataUri: string, maxSide = 1280): Promise<string> {
  const raw = Buffer.from(stripDataUrlPrefix(dataUri), "base64");
  const meta = await sharp(raw).metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 768;
  const scale = Math.min(maxSide / width, maxSide / height, 1);
  const outW = Math.max(512, Math.round((width * scale) / 16) * 16);
  const outH = Math.max(512, Math.round((height * scale) / 16) * 16);
  const resized = await sharp(raw)
    .resize(outW, outH, { fit: "fill" })
    .jpeg({ quality: 90 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
}

// ── Per-theme vibes ───────────────────────────────────────────────────────────

const THEME_VIBES: Record<string, string> = {
  scandi:      "Scandinavian — warm white walls, light oak wood, linen textiles, hygge warmth, curated minimalism with soul",
  japandi:     "Japandi — wabi-sabi serenity, muted sage and clay tones, natural linen and bamboo textures, zen stillness, exquisite negative space",
  coastal:     "Coastal — sun-bleached whites and ocean blues, natural rattan and driftwood, breezy linen, relaxed seaside elegance",
  luxury:      "ultra-luxury — deep jewel tones, rich velvet upholstery, polished marble surfaces, brushed gold and brass hardware, dramatic statement lighting, hotel-suite opulence",
  industrial:  "Industrial loft — dark steel frames and metal accents on furniture, reclaimed warm oak tabletops and shelving, Edison filament bulbs in pendant shades, aged leather upholstery, urban sophistication expressed through furnishings only",
  bohemian:    "Bohemian — layered kilim rugs, macramé wall art, rattan and cane furniture, warm terracotta and amber tones, eclectic global artisan objects",
  mid_century: "Mid-Century Modern — warm walnut wood, tapered hairpin legs, amber and olive tones, retro geometric patterns, sculptural organic forms",
  modern:      "contemporary modern — crisp clean lines, refined neutral palette, bold sculptural accent pieces, sophisticated gallery-worthy curation",
};

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildInspirePrompt(roomType: string, theme: string): string {
  const roomLabel = roomType.replace(/_/g, " ");
  const vibe = THEME_VIBES[theme.toLowerCase()] || `${theme} interior design`;

  return [
    `@image1 is the base ${roomLabel} photograph.`,
    ``,
    `═══ GEOMETRY LOCK — READ THIS FIRST, OBEY IT THROUGHOUT ═══`,
    `The room structure in @image1 is FIXED and must be pixel-perfect in the output:`,
    `• Every wall surface, wall panel, wall colour — unchanged. Do NOT paint, panel, or recolour any wall.`,
    `• Every window: position, size, shape, glass, frame — unchanged`,
    `• Every door: position, size, frame — unchanged`,
    `• Curtains, blinds, drapes — unchanged`,
    `• Ceiling: height, cornices, beams, light fixtures — unchanged`,
    `• Floor: material, colour, texture, boundaries — UNCHANGED. Tile stays tile. Wood stays wood. Carpet stays carpet.`,
    `• Fireplace: if visible, its surround, style, material and position are LOCKED — do NOT replace, restyle or remove it`,
    `• Archways and room entry frames — if visible in @image1, they MUST remain fully visible and frame the output in EXACTLY the same position`,
    `• Camera: angle, height, focal length, perspective vanishing points — IDENTICAL to @image1`,
    `• Room proportions and spatial dimensions — unchanged`,
    `• Wall surface material — LOCKED. Do NOT add exposed brick, stone, wood panelling, concrete, shiplap, or any texture not in @image1.`,
    `• Ceiling material — LOCKED. Do NOT add exposed beams, concrete, timber, or any industrial/rustic ceiling treatment not already present.`,
    `You may ONLY touch: movable furniture pieces and their associated soft furnishings, rugs, cushions, lighting shades, and wall art.`,
    `DO NOT widen the room, DO NOT change the viewpoint, DO NOT add or remove windows or doors.`,
    `DO NOT change wall or ceiling materials to match the style theme — the theme is expressed ONLY through furniture and decor.`,
    ``,
    `═══ STYLE TRANSFORMATION ═══`,
    `Restyle the furniture, soft furnishings, lighting and decor as a ${vibe} interior.`,
    `Express the theme ONLY through:`,
    `  • Furniture colours, upholstery fabric and material finishes`,
    `  • Rug pattern, cushion colours and throw textures`,
    `  • Lamp shade style and light warmth`,
    `  • Decorative accessories (vases, plants, artwork framing)`,
    `Do NOT express the theme through: wall colour, floor material, ceiling, windows, or doors — these are LOCKED.`,
    ``,
    `OUTPUT: A well-styled ${theme} ${roomLabel} with the same room shell as @image1. No text, no watermarks, no borders.`,
  ].join("\n");
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { originalImage, roomType, theme } = await req.json();

    if (!originalImage || !roomType || !theme) {
      return NextResponse.json({ ok: false, error: "Missing required fields" }, { status: 400 });
    }

    const resizedDataUri = await resizeDataUri(originalImage, 1280);
    const roomUrl = await uploadToFal(resizedDataUri, "room_inspire.jpg");
    const prompt = buildInspirePrompt(roomType, theme);

    console.log(`[fal-inspire] room=${roomType} theme=${theme}`);
    const t0 = Date.now();

    const result = await fal.subscribe("fal-ai/flux-2-pro/edit", {
      input: { prompt, image_urls: [roomUrl] },
    }) as any;

    console.log(`[fal-inspire] FLUX done in ${Math.round((Date.now() - t0) / 1000)}s`);

    const generatedUrl = result?.data?.images?.[0]?.url;
    if (!generatedUrl) throw new Error("FLUX returned no image");

    const inspiredImage = await falUrlToDataUri(generatedUrl);
    return NextResponse.json({ ok: true, inspiredImage });
  } catch (err: any) {
    console.error("[fal-inspire] error:", err);
    return NextResponse.json({ ok: false, error: err?.message || "Style transfer failed" }, { status: 500 });
  }
}
