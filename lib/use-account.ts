// lib/use-account.ts — รู้ว่าตอนนี้ล็อกอินอยู่ไหม + ปุ่มออกจากระบบ
// requireLogin: true → ถ้า session ใช้ไม่ได้ (หมดอายุ/คุกกี้เก่าค้าง) จะพาไปหน้า /login
import { useEffect, useState } from "react";

export interface Account {
  id: number;
  username: string;
}

export function useAccount(options: { requireLogin?: boolean } = {}) {
  const { requireLogin = false } = options;
  const [user, setUser] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        const u: Account | null = d.user ?? null;
        setUser(u);
        if (!u && requireLogin) window.location.href = "/login";
      })
      .catch(() => setUser(null)) // เซิร์ฟเวอร์ล่ม = ไม่รีไดเรกต์ กันวนลูป
      .finally(() => setLoaded(true));
  }, [requireLogin]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  return { user, loaded, logout };
}