// @ts-nocheck
import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI, Modality } from "@google/genai";
import { withGeminiRetry } from "@/lib/geminiRetry";

const ai = new GoogleGenAI({
  vertexai: true,
  project:  process.env.GOOGLE_CLOUD_PROJECT!,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});

function stripDataUrlPrefix(input: string): string {
  const idx = input.indexOf(",");
  return idx >= 0 ? input.slice(idx + 1) : input;
}

function extractImageFromResponse(response: any): { data: string; mimeType: string } | null {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part?.inlineData?.data) {
      return { data: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" };
    }
  }
  return null;
}

function extractTextFromResponse(response: any): string {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p: any) => typeof p?.text === "string").map((p: any) => p.text).join("").trim();
}

// Step 1: Ask Gemini to describe exactly what furniture is in this specific room
const DETECT_PROMPT = `
Look at this room photo carefully.

List every single movable object you can see — be very specific about:
- The exact type of each piece of furniture (e.g. "large L-shaped grey velvet sectional sofa with chaise")
- Plants, flowers, vases
- Rugs, carpets
- Lamps
- Coffee tables, side tables
- Ottomans, poufs
- Cushions, throws
- Wall art, decorative items
- Any other movable objects

Return ONLY a comma-separated list of what you see. No explanation. No numbers. Just the items.
Example: large grey sectional sofa, round glass coffee table, white orchid plant, beige area rug, floor lamp
`.trim();

// Step 2: Use that exact list to tell Gemini what to remove
function buildRemovePrompt(furnitureList: string): string {
  return `
Edit this room photo. Remove ALL of the following items completely:
${furnitureList}

For each removed item, reveal what is naturally behind or beneath it — the floor, wall, or empty space that would be there.

Keep these EXACTLY unchanged — do not modify them at all:
- walls (colour, texture, wallpaper, paint)
- windows (exact position, size, curtains, frames)
- doors (exact position, size, frames)
- ceiling (structure, colour, all fixed light fixtures, chandelier)
- floor material and colour (just show it bare and clean)
- room proportions, perspective, and camera angle
- archways and any built-in architectural features

The result must be the exact same room with only the movable items removed.
Return one photorealistic image of the empty room.
`.trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const imageBase64Input = body?.imageBase64;
    const mimeType = body?.mimeType || "image/jpeg";

    if (!imageBase64Input)
      return NextResponse.json({ ok: false, error: "imageBase64 is required" }, { status: 400 });

    const imageBase64 = stripDataUrlPrefix(imageBase64Input);

    // ── Step 1: Detect what furniture is actually in THIS room ───────────────
    console.log("Step 1: Detecting furniture in room…");
    const detectResponse = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{
          role: "user",
          parts: [
            { text: DETECT_PROMPT },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        }],
      })
    );

    const furnitureList = extractTextFromResponse(detectResponse);
    console.log("Detected furniture:", furnitureList.slice(0, 200));

    if (!furnitureList) throw new Error("Could not detect furniture in room.");

    // ── Step 2: Remove exactly those items ───────────────────────────────────
    console.log("Step 2: Removing detected furniture…");
    const removePrompt = buildRemovePrompt(furnitureList);

    const removeResponse = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [{
          role: "user",
          parts: [
            { text: removePrompt },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        }],
        config: { responseModalities: [Modality.IMAGE, Modality.TEXT] },
      })
    );

    const image = extractImageFromResponse(removeResponse);
    if (!image) {
      const text = extractTextFromResponse(removeResponse);
      console.warn("Gemini returned no image. Text:", text.slice(0, 300));
      throw new Error("Gemini did not return an image. Try a clearer room photo.");
    }

    console.log("✅ Furniture removal complete");

    return NextResponse.json({
      ok:             true,
      emptyRoomImage: `data:${image.mimeType};base64,${image.data}`,
      mimeType:       image.mimeType,
      detectedFurniture: furnitureList,
    });

  } catch (error) {
    console.error("fal-remove-furniture error:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Furniture removal failed" },
      { status: 500 }
    );
  }
}
