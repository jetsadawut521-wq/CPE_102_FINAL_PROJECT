"use client";
// components/account-bar.tsx — แสดงชื่อผู้ใช้ + ปุ่มออกจากระบบ ลอยอยู่มุมขวาบนของจอ
// ใช้ position: fixed จึงอยู่มุมขวาบนเสมอ ไม่ว่าจะวาง <AccountBar /> ไว้ตรงไหนใน app/page.tsx
// ถ้าไม่มีบัญชีที่ใช้ได้ (session หมดอายุ) จะถูกส่งไปหน้า /login
import { useAccount } from "@/lib/use-account";

export default function AccountBar() {
  const { user, loaded, logout } = useAccount({ requireLogin: true });
  if (!loaded || !user) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: "0.75rem",
        right: "1rem",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.35rem 0.75rem",
        border: "1px solid #ccc",
        borderRadius: "999px",
        background: "#fff",
        color: "#222",
        fontSize: "0.9rem",
      }}
    >
      <span>
        👤 <strong>{user.username}</strong>
      </span>
      <button type="button" onClick={logout}>
        ออกจากระบบ
      </button>
    </div>
  );
}