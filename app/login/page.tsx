"use client";
// app/login/page.tsx — หน้าเข้าสู่ระบบ / สมัครสมาชิก ใช้ดีไซน์ (class) เดียวกับหน้า account ของ app/page.tsx
// ต่อกับ API ของเรา: POST /api/auth/login และ /api/auth/register
import { useState } from "react";

type Mode = "login" | "register";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRegister = mode === "register";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isRegister && password !== confirm) {
      setError("รหัสผ่านสองช่องไม่ตรงกัน");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "ไม่สำเร็จ ลองใหม่อีกครั้ง");
      // โหลดหน้าใหม่ทั้งหน้า เพื่อให้ playlist ถูกดึงจากบัญชีที่เพิ่งเข้าสู่ระบบ
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "ไม่สำเร็จ ลองใหม่อีกครั้ง");
      setBusy(false);
    }
  }

  return (
    <main className="muverse-app">
      <section className="account-page" aria-labelledby="account-title">
        <div className="account-art" aria-hidden="true">
          <img src="/account-art.png" alt="" />
        </div>
        <div className="account-panel">
          <span className="eyebrow">MUVERSE ACCOUNT</span>
          <h1 id="account-title">{isRegister ? "มาร่วมเต้นกัน" : "ยินดีต้อนรับกลับ"}</h1>
          <p>
            {isRegister
              ? "สร้างบัญชีเพื่อเก็บคลิปโปรดและเพลย์ลิสต์ไว้ในที่เดียว"
              : "เก็บคลิปโปรดและเพลย์ลิสต์ไว้ในที่เดียว"}
          </p>

          <form className="account-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="account-username">ชื่อผู้ใช้</label>
            <input
              id="account-username"
              type="text"
              autoComplete="username"
              placeholder={isRegister ? "ชื่อผู้ใช้ (3-30 ตัว: A-Z a-z 0-9 _ .)" : "ชื่อผู้ใช้"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />

            <label className="sr-only" htmlFor="account-password">รหัสผ่าน</label>
            <input
              id="account-password"
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder={isRegister ? "รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)" : "รหัสผ่าน"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            {isRegister && (
              <>
                <label className="sr-only" htmlFor="account-confirm">ยืนยันรหัสผ่าน</label>
                <input
                  id="account-confirm"
                  type="password"
                  autoComplete="new-password"
                  placeholder="ยืนยันรหัสผ่าน"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
              </>
            )}

            <button className="account-submit" type="submit" disabled={busy}>
              {busy ? "กำลังดำเนินการ…" : isRegister ? "สร้างบัญชี" : "เข้าสู่ระบบ"}
            </button>
          </form>

          <button
            className="account-create"
            type="button"
            onClick={() => {
              setMode(isRegister ? "login" : "register");
              setError(null);
            }}
          >
            {isRegister ? "กลับไปเข้าสู่ระบบ" : "สร้างบัญชี"}
          </button>

          {error && <p className="account-notice" role="alert">{error}</p>}
        </div>
      </section>
    </main>
  );
}