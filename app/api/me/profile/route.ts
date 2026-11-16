// PUT /api/me/profile  body: { displayName: string, avatar: string | null }
// บันทึกชื่อที่แสดง + รูปโปรไฟล์ของผู้ใช้ที่ล็อกอินอยู่ (ใช้ user จาก session เสมอ)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser, sameOrigin } from "@/lib/session";

export const runtime = "nodejs";

const NAME_MAX = 30;
const AVATAR_MAX = 200_000; // รูปที่ย่อเป็น 256x256 JPEG ปกติราว 15-40 KB
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/; // รับเฉพาะรูปจริง ไม่รับ svg/ลิงก์ภายนอก

export async function PUT(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 403 });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "ต้องเข้าสู่ระบบก่อน" }, { status: 401 });

  const text = await req.text();
  if (text.length > AVATAR_MAX + 1000) return NextResponse.json({ error: "รูปใหญ่เกินไป" }, { status: 413 });
  let body: { displayName?: unknown; avatar?: unknown } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* ตกไปที่ตรวจด้านล่าง */
  }
  if (!body) return NextResponse.json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 });

  const name = typeof body.displayName === "string" ? body.displayName.trim() : "";
  // eslint-disable-next-line no-control-regex
  if (name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    return NextResponse.json({ error: `ชื่อที่แสดงต้องไม่เกิน ${NAME_MAX} ตัวอักษร` }, { status: 400 });
  }

  let avatar: string | null = null;
  if (typeof body.avatar === "string") {
    if (body.avatar.length > AVATAR_MAX || !AVATAR_RE.test(body.avatar)) {
      return NextResponse.json({ error: "รูปไม่ถูกต้องหรือใหญ่เกินไป" }, { status: 400 });
    }
    avatar = body.avatar;
  } else if (body.avatar !== null && body.avatar !== undefined) {
    return NextResponse.json({ error: "รูปไม่ถูกต้อง" }, { status: 400 });
  }

  db.prepare(
    `INSERT INTO profiles (user_id, display_name, avatar, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, avatar = excluded.avatar, updated_at = excluded.updated_at`,
  ).run(user.id, name || null, avatar, Math.floor(Date.now() / 1000));

  return NextResponse.json({ ok: true, displayName: name || null, avatar });
}
