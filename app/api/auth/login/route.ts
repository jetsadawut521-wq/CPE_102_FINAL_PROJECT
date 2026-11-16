// POST /api/auth/login  body: { username, password }
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { burnTime, verifyPassword } from "@/lib/password";
import { clearLoginFailures, loginBlocked, loginKey, recordLoginFailure, sameOrigin, startSession } from "@/lib/session";

export const runtime = "nodejs";

const BAD = "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"; // ข้อความเดียวกันทุกกรณี ไม่บอกว่าผิดที่ชื่อหรือรหัส

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 200) : "";
  if (!username || !password) return NextResponse.json({ error: BAD }, { status: 400 });

  const key = loginKey(req, username);
  if (loginBlocked(key)) {
    return NextResponse.json({ error: "ลองผิดหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่" }, { status: 429 });
  }

  const user = db.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").get(username) as
    | { id: number; username: string; password_hash: string }
    | undefined;

  const ok = user ? await verifyPassword(password, user.password_hash) : (await burnTime(password), false);
  if (!user || !ok) {
    recordLoginFailure(key);
    return NextResponse.json({ error: BAD }, { status: 401 });
  }

  clearLoginFailures(key);
  await startSession(user.id);
  return NextResponse.json({ user: { id: user.id, username: user.username } });
}
