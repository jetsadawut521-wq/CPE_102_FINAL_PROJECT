"use client";
// components/account-bar.tsx — ชื่อผู้ใช้ + ปุ่มออกจากระบบ (วางใน header ของหน้าเว็บ)
import { useAccount } from "@/lib/use-account";

export default function AccountBar() {
  const { user, loaded, logout } = useAccount({ requireLogin: true });
  if (!loaded || !user) return null;

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        padding: "0.25rem 0.75rem",
        borderRadius: 999,
        border: "1px solid currentColor",
        fontSize: "0.85rem",
        whiteSpace: "nowrap",
      }}
    >
      <span>👤 <strong>{user.username}</strong></span>
      <button type="button" onClick={logout} style={{ font: "inherit", cursor: "pointer" }}>
        ออกจากระบบ
      </button>
    </div>
  );
}