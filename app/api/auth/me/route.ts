// GET /api/auth/me → { user: {id, username} | null }  ใช้ตอนเปิดหน้าเว็บเพื่อรู้ว่าล็อกอินอยู่ไหม
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ user: await currentUser() });
}
