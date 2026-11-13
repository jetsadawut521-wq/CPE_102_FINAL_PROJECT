// POST /api/auth/logout
import { NextRequest, NextResponse } from "next/server";
import { endSession, sameOrigin } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 403 });
  await endSession();
  return NextResponse.json({ ok: true });
}
