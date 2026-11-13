// middleware.ts  (วางที่รากโปรเจกต์ ข้าง package.json และโฟลเดอร์ app)
// ใครเข้าเว็บโดยไม่มีคุกกี้ session → ส่งไปหน้า /login ก่อนเสมอ
// หมายเหตุ: ตรงนี้ตรวจแค่ "มีคุกกี้ไหม" (เร็ว ทำบน Edge ได้) ส่วนการตรวจว่า session ยังใช้ได้จริงไหม
// ทำที่ฝั่งหน้าเว็บ (useAccount) และที่ API ทุกตัวอยู่แล้ว
import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "muverse_session"; // ต้องตรงกับชื่อใน lib/session.ts

export function middleware(req: NextRequest) {
  if (req.cookies.has(COOKIE)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // ใช้กับทุกหน้า ยกเว้น /login, /api/*, ไฟล์ของ Next และไฟล์ที่มีนามสกุล (รูป, favicon ฯลฯ)
  matcher: ["/((?!login|api|_next/static|_next/image|.*\\..*).*)"],
};
