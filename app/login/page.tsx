"use client";
// app/login/page.tsx — หน้าเข้าสู่ระบบ / สมัครสมาชิก (ยังไม่มีดีไซน์ ส่วนหน้าตาเป็นงานของคนทำ UI)
import Link from "next/link";
import { useState } from "react";

type Mode = "login" | "register";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirm) {
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

  const isRegister = mode === "register";

  return (
    <main style={{ maxWidth: 360 }}>
      <h1>
        <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
          Muverse
        </Link>
      </h1>
      <h2>{isRegister ? "สมัครสมาชิก" : "เข้าสู่ระบบ"}</h2>

      <form onSubmit={submit} style={{ display: "grid", gap: "0.75rem" }}>
        <label>
          ชื่อผู้ใช้
          <br />
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            style={{ width: "100%" }}
          />
          {isRegister && <small>3-30 ตัว ใช้ A-Z a-z 0-9 _ . ได้</small>}
        </label>

        <label>
          รหัสผ่าน
          <br />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? "new-password" : "current-password"}
            required
            style={{ width: "100%" }}
          />
          {isRegister && <small>อย่างน้อย 8 ตัวอักษร</small>}
        </label>

        {isRegister && (
          <label>
            ยืนยันรหัสผ่าน
            <br />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              style={{ width: "100%" }}
            />
          </label>
        )}

        {error && <p role="alert" style={{ color: "#c00", margin: 0 }}>{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "กำลังดำเนินการ…" : isRegister ? "สมัครสมาชิก" : "เข้าสู่ระบบ"}
        </button>
      </form>

      <p>
        {isRegister ? "มีบัญชีอยู่แล้ว? " : "ยังไม่มีบัญชี? "}
        <button
          type="button"
          onClick={() => {
            setMode(isRegister ? "login" : "register");
            setError(null);
          }}
        >
          {isRegister ? "เข้าสู่ระบบ" : "สมัครสมาชิก"}
        </button>
      </p>
    </main>
  );
}
