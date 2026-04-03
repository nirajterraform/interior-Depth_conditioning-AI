import { NextRequest, NextResponse } from "next/server";

export async function POST(_req: NextRequest) {
  return NextResponse.json({
    ok: true,
    crops: [],
    skipped: true,
    message: "Deprecated route: fixed crop zones removed because they were not grounded in actual object detection.",
  });
}
