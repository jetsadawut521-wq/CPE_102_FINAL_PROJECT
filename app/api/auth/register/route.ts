// POST /api/auth/register  body: { username, password }
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, validateCredentials } from "@/lib/password";
import { sameOrigin, startSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 403 });
  const body = await req.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  const problem = validateCredentials(username, password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  try {
    const hash = await hashPassword(password);
    const result = db
      .prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username, hash, Math.floor(Date.now() / 1000));
    const id = Number(result.lastInsertRowid);
    await startSession(id);
    return NextResponse.json({ user: { id, username } }, { status: 201 });
  } catch (err) {
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      return NextResponse.json({ error: "ชื่อผู้ใช้นี้ถูกใช้แล้ว" }, { status: 409 });
    }
    return NextResponse.json({ error: "สมัครสมาชิกไม่สำเร็จ" }, { status: 500 });
  }
}
