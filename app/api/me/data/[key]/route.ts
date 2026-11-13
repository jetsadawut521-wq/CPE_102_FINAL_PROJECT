// GET /api/me/data/playlists   → { value: [...] | null }
// PUT /api/me/data/playlists   body: { value: [...] }   (บันทึกทั้งก้อนทับของเดิม)
// key ที่รองรับ: playlists, history  (ตรงกับข้อมูลที่ frontend เก็บใน localStorage อยู่ตอนนี้)
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser, sameOrigin } from "@/lib/session";

export const runtime = "nodejs";

const KEYS = new Set(["playlists", "history"]);
const MAX_BYTES = 2_000_000; // playlist มีรูปปก (data URL) จึงเผื่อไว้ 2 MB

type Ctx = { params: Promise<{ key: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { key } = await params;
  if (!KEYS.has(key)) return NextResponse.json({ error: "ไม่รู้จักข้อมูลนี้" }, { status: 404 });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "ต้องเข้าสู่ระบบก่อน" }, { status: 401 });

  const row = db.prepare("SELECT value FROM user_data WHERE user_id = ? AND key = ?").get(user.id, key) as { value: string } | undefined;
  return NextResponse.json({ value: row ? JSON.parse(row.value) : null });
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { key } = await params;
  if (!KEYS.has(key)) return NextResponse.json({ error: "ไม่รู้จักข้อมูลนี้" }, { status: 404 });
  if (!sameOrigin(req)) return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 403 });
  const user = await currentUser(); // ใช้ user จาก session เสมอ ไม่รับ user id จากผู้ส่ง
  if (!user) return NextResponse.json({ error: "ต้องเข้าสู่ระบบก่อน" }, { status: 401 });

  const text = await req.text();
  if (text.length > MAX_BYTES) return NextResponse.json({ error: "ข้อมูลใหญ่เกินไป" }, { status: 413 });
  let value: unknown;
  try {
    value = JSON.parse(text)?.value;
  } catch {
    return NextResponse.json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }
  if (!Array.isArray(value)) return NextResponse.json({ error: "value ต้องเป็นอาร์เรย์" }, { status: 400 });

  db.prepare(
    `INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(user.id, key, JSON.stringify(value), Math.floor(Date.now() / 1000));
  return NextResponse.json({ ok: true });
}
