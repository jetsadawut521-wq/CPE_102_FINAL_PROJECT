// lib/password.ts
// เข้ารหัสรหัสผ่านด้วย scrypt (มีใน Node ในตัว ไม่ต้องติดตั้งเพิ่ม)
// ไม่เก็บรหัสผ่านจริงเด็ดขาด เก็บเฉพาะ "ค่าแฮช" + salt สุ่มของแต่ละคน
// รูปแบบที่เก็บใน DB: scrypt$N$r$p$salt$hash  (เก็บพารามิเตอร์ไว้ด้วย ภายหลังปรับความแรงได้โดยไม่พังบัญชีเก่า)
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 3;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

export const USERNAME_RE = /^[A-Za-z0-9_.]{3,30}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128; // กันคนส่งรหัสยาวมาก ๆ เพื่อให้เซิร์ฟเวอร์ทำงานหนัก

/** คืนข้อความ error ถ้าไม่ผ่าน, คืน null ถ้าผ่าน */
export function validateCredentials(username: string, password: string): string | null {
  if (!USERNAME_RE.test(username)) return "ชื่อผู้ใช้ต้องยาว 3-30 ตัว ใช้ได้เฉพาะ A-Z a-z 0-9 _ .";
  if (password.length < PASSWORD_MIN) return `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN} ตัวอักษร`;
  if (password.length > PASSWORD_MAX) return `รหัสผ่านยาวเกิน ${PASSWORD_MAX} ตัวอักษร`;
  return null;
}

function derive(password: string, salt: Buffer, opts: ScryptOptions, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, keylen, { ...opts, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P }, KEYLEN);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const key = await derive(password, Buffer.from(saltB64, "base64"), { N: Number(n), r: Number(r), p: Number(p) }, expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// ใช้ตอน "ไม่มีชื่อผู้ใช้นี้" เพื่อให้ใช้เวลาตอบเท่ากับกรณีรหัสผิด (กันคนเดาว่าชื่อไหนมีในระบบ)
let dummy: Promise<string> | null = null;
export async function burnTime(password: string): Promise<void> {
  dummy ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(password, await dummy);
}
