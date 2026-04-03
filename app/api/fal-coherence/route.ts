import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    return NextResponse.json({
      ok: true,
      finalImage: body?.imageBase64 || null,
      skipped: true,
      message: "Deprecated route: final coherence pass disabled to reduce geometry drift.",
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to bypass coherence route" },
      { status: 500 }
    );
  }
}
