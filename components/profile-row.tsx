"use client";
// components/profile-row.tsx — แถวโปรไฟล์ในเมนูเฟือง: แสดงรูป + ชื่อ กดแล้วแก้ชื่อที่แสดง/เปลี่ยนรูปได้
import { useRef, useState } from "react";
import type { Account } from "@/lib/use-account";

type Tr = (en: string, th: string) => string;

const SIZE = 256; // ย่อรูปเป็นจัตุรัส 256x256 ก่อนส่ง ให้ไฟล์เล็กและไม่ต้องเก็บรูปต้นฉบับ

async function toSquareDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function Avatar({ src, name, size }: { src?: string | null; name: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "grid", placeItems: "center", flex: "none", width: size, height: size, overflow: "hidden",
        borderRadius: "50%", background: "#efefeb", color: "#171717", fontWeight: 800, fontSize: size * 0.45,
      }}
    >
      {src ? <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function ProfileRow({
  user, tr, onSaved,
}: {
  user: Account;
  tr: Tr;
  onSaved: (p: { displayName: string | null; avatar: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.displayName ?? "");
  const [avatar, setAvatar] = useState<string | null>(user.avatar ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const shown = user.displayName || user.username;

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setAvatar(await toSquareDataUrl(file));
      setError(null);
    } catch {
      setError(tr("Could not read this image.", "อ่านรูปนี้ไม่ได้"));
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, avatar }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "ไม่สำเร็จ");
      onSaved({ displayName: data.displayName ?? null, avatar: data.avatar ?? null });
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="settings-row" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="settings-label">
          <Avatar src={user.avatar} name={shown} size={28} />
          {shown}
        </span>
        <span className="settings-current">{tr("Edit profile", "แก้ไขโปรไฟล์")}<b aria-hidden="true">›</b></span>
      </button>

      {open && (
        <div style={{ display: "grid", gap: 12, padding: "8px 6px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Avatar src={avatar} name={name || user.username} size={64} />
            <div style={{ display: "grid", gap: 6, justifyItems: "start" }}>
              <button type="button" onClick={() => fileRef.current?.click()}>{tr("Choose photo", "เลือกรูป")}</button>
              {avatar && <button type="button" onClick={() => setAvatar(null)}>{tr("Remove photo", "ลบรูป")}</button>}
            </div>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
          </div>
          <input
            value={name}
            maxLength={30}
            onChange={(e) => setName(e.target.value)}
            placeholder={user.username}
            aria-label={tr("Display name", "ชื่อที่แสดง")}
            style={{ width: "100%", height: 46, padding: "0 14px", border: "1px solid #171717", borderRadius: 12, background: "#efefeb", font: "inherit" }}
          />
          <small style={{ opacity: 0.7 }}>{tr("Username", "ชื่อผู้ใช้")}: {user.username}</small>
          {error && <small role="alert" style={{ color: "#c00" }}>{error}</small>}
          <button className="settings-login" type="button" disabled={busy} onClick={save}>
            {busy ? tr("Saving…", "กำลังบันทึก…") : tr("Save", "บันทึก")}
          </button>
        </div>
      )}
    </div>
  );
}
