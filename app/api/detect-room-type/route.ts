import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { withGeminiRetry } from "@/lib/geminiRetry";

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT!,
  location: process.env.GOOGLE_CLOUD_LOCATION || "global",
});

type RoomType =
  | "living_room"
  | "bedroom"
  | "dining_room"
  | "kitchen"
  | "office"
  | "foyer"
  | "loft"
  | "hallway"
  | "frontyard"
  | "backyard"
  | "kids_room";

const VALID_ROOM_TYPES = new Set<RoomType>([
  "living_room",
  "bedroom",
  "dining_room",
  "kitchen",
  "office",
  "foyer",
  "loft",
  "hallway",
  "frontyard",
  "backyard",
  "kids_room",
]);

function stripDataUrlPrefix(input: string): string {
  const idx = input.indexOf(",");
  return idx >= 0 ? input.slice(idx + 1) : input;
}

const DETECTION_PROMPT = `
You are a space type classifier for an interior and exterior design app.

Look at the photograph and identify what type of space it is.

Choose exactly one of these space types:
- living_room: a lounge, sitting room, or family room — PRIMARY feature is a sofa/sectional clearly visible as the main piece
- bedroom: a room for sleeping — PRIMARY feature is a bed
- dining_room: a room for eating — PRIMARY feature is a dining table with chairs arranged around it
- kitchen: a room for cooking — PRIMARY feature is countertops, appliances, or a kitchen island
- office: a home office or study — PRIMARY feature is a desk
- foyer: the entryway / entrance hall directly at or near the front door of a home — visual cues: front door clearly visible or implied (just inside the entrance), console table or bench as the ONLY major decorative piece, mirror on the wall, rug runner near the door, wider than a corridor; this is a welcoming vignette at the building's entrance
- loft: an open architectural space AWAY from the front door — visual cues: mezzanine level above a staircase, open landing at the top of stairs, columns/pillars, railings; NOT near a front door; may have a console table but the dominant feature is the open vertical architecture or staircase
- hallway: a long narrow corridor or passage inside a home — visual cues: elongated narrow floor plan, doors along the sides, no large furniture (maybe a small table, mirror, or art on the wall)
- frontyard: the outdoor area in front of a home — visual cues: front door or garage visible, driveway, lawn, garden beds, pathway, fencing along the front of the property
- backyard: the outdoor area behind or to the side of a home — visual cues: patio, deck, grass lawn, garden, pool, outdoor furniture (chairs, tables, loungers), pergola, fencing enclosing a private outdoor space
- kids_room: a bedroom or playroom designed for children — visual cues: small-scale bed (toddler/single), colourful or themed décor, toys, play furniture, bunk beds, cartoon/character elements, bright colours, play mats, child-height storage

CRITICAL DISTINCTIONS:
- foyer vs loft: foyer is AT the front entrance (front door visible/implied, console + mirror vignette); loft is an open mezzanine/staircase landing AWAY from the front door
- foyer vs hallway: foyer is wider, near front door, with decorative console/bench/mirror; hallway is long and narrow with doors along the sides
- living_room vs loft: sofa clearly present → living_room; no sofa + open staircase/mezzanine architecture → loft
- hallway vs loft: hallway is a narrow elongated corridor; loft is an open architectural space (mezzanine, landing)
- frontyard vs backyard: front door / driveway visible → frontyard; patio / pool / enclosed private garden → backyard
- indoor vs outdoor: if you can see sky, grass, plants, or are clearly outside → frontyard or backyard, NOT a living room
- bedroom vs kids_room: adult bedroom with queen/king bed and neutral décor → bedroom; clearly child-themed room with small beds, toys, bright colours, or character décor → kids_room

Rules:
1. Return ONLY a JSON object — no explanation, no markdown, no extra text
2. If you are confident, set confidence to "high"
3. If the space is ambiguous or unclear, set confidence to "low" and still pick the closest match
4. If the image does not show a recognisable space at all, set room_type to null

Return this exact JSON shape:
{
  "room_type": "living_room",
  "confidence": "high",
  "reason": "one short sentence"
}
`.trim();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const imageBase64Input = body?.imageBase64;
    const mimeType = body?.mimeType || "image/jpeg";

    if (!imageBase64Input) {
      return NextResponse.json(
        { ok: false, error: "imageBase64 is required" },
        { status: 400 }
      );
    }

    const imageBase64 = stripDataUrlPrefix(imageBase64Input);

    const response = await withGeminiRetry(() =>
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { text: DETECTION_PROMPT },
              { inlineData: { mimeType, data: imageBase64 } },
            ],
          },
        ],
      })
    );

    const parts = response?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .filter((p: any) => typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("")
      .trim();

    // Parse the JSON response
    let parsed: { room_type: string | null; confidence: string; reason: string };
    try {
      const cleaned = text.replace(/```json|```/g, "").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : cleaned);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Failed to parse room detection response" },
        { status: 500 }
      );
    }

    const detectedType = parsed?.room_type;

    // Validate it's one of our known room types
    if (!detectedType || !VALID_ROOM_TYPES.has(detectedType as RoomType)) {
      return NextResponse.json({
        ok: true,
        roomType: null,
        confidence: "low",
        reason: parsed?.reason || "Could not identify a supported room type",
      });
    }

    return NextResponse.json({
      ok: true,
      roomType: detectedType as RoomType,
      confidence: parsed?.confidence || "high",
      reason: parsed?.reason || "",
    });
  } catch (error) {
    console.error("detect-room-type error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to detect room type",
      },
      { status: 500 }
    );
  }
}
