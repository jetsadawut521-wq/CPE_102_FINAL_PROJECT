// GET /api/auth/me → { user: {id, username, displayName, avatar} | null }  ใช้ตอนเปิดหน้าเว็บเพื่อรู้ว่าล็อกอินอยู่ไหม
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ user: null });
  const p = db.prepare("SELECT display_name, avatar FROM profiles WHERE user_id = ?").get(user.id) as
    | { display_name: string | null; avatar: string | null }
    | undefined;
  return NextResponse.json({ user: { ...user, displayName: p?.display_name ?? null, avatar: p?.avatar ?? null } });
}
