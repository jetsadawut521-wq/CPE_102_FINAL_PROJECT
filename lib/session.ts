// lib/session.ts — session ผ่านคุกกี้ + ตัวช่วยความปลอดภัยเล็ก ๆ
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { db } from "./db";

export const COOKIE = "muverse_session";
const TTL_SEC = 60 * 60 * 24 * 30; // 30 วัน
const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const nowSec = () => Math.floor(Date.now() / 1000);

export interface SessionUser {
  id: number;
  username: string;
}

export async function startSession(userId: number): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha(token), userId, nowSec() + TTL_SEC);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowSec()); // เก็บกวาด session หมดอายุ
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, // JavaScript ฝั่งเบราว์เซอร์อ่านไม่ได้ กัน XSS ขโมย token
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_SEC,
  });
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const row = db
    .prepare("SELECT u.id AS id, u.username AS username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
    .get(sha(token), nowSec()) as SessionUser | undefined;
  return row ?? null;
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
  jar.delete(COOKIE);
}

/** กัน CSRF: คำขอที่เปลี่ยนข้อมูลต้องมาจากหน้าเว็บของเราเอง (เบราว์เซอร์ส่ง Origin มาเสมอ) */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

// ---------- กันเดารหัสผ่าน: ผิด 5 ครั้งติด ล็อก 15 นาที (เก็บในหน่วยความจำ รีสตาร์ทเซิร์ฟเวอร์แล้วรีเซ็ต) ----------
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map<string, { n: number; until: number }>();

export const loginKey = (req: NextRequest, username: string) =>
  `${req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "local"}|${username.toLowerCase()}`;
export const loginBlocked = (key: string) => (fails.get(key)?.until ?? 0) > Date.now();
export function recordLoginFailure(key: string) {
  const prev = fails.get(key);
  const n = (prev && prev.until <= Date.now() && prev.n < MAX_FAILS ? prev.n : 0) + 1;
  fails.set(key, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
}
export const clearLoginFailures = (key: string) => void fails.delete(key);
