"use client";
// components/playlist-panel.tsx
// หน้า playlist สไตล์คลังเพลง:
//   1) รายการ playlist ทั้งหมด (ปก + ชื่อ + จำนวนคลิป) กดเพื่อเข้าไปดู
//   2) หน้ารายละเอียด: เปลี่ยนปก/ชื่อ, เล่นทั้งหมด, เรียง/ลบเพลง
// ปก: ผู้ใช้อัปโหลดเองได้ ถ้าไม่ตั้งจะสุ่มใช้ภาพจากคลิปหนึ่งใน playlist (คงที่ ไม่เปลี่ยนทุกครั้งที่เปิดหน้า)

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import HeartButton from "@/components/heart-button";
import { formatTime, type VideoItem } from "@/lib/youtube";
import { DEFAULT_LIKED_COLOR, DEFAULT_PLAYLIST_COLOR, DEFAULT_PLAYLIST_ICON, isLikedId, type PlayMode, type Playlist } from "@/lib/playlist";
import "./playlist-panel.css";

interface Props {
  language?: string;
  playlists: Playlist[];
  selected: Playlist | null;
  /** Built-in recommendation playlists are playable, but cannot be edited by the user. */
  readOnly?: boolean;
  /** id คลิปที่กำลังเล่น ใช้ไฮไลต์เฉพาะเมื่อกำลังเล่นจาก playlist ที่เลือกอยู่ */
  playingId?: string;
  playingFromSelected: boolean;
  /** id คลิปที่กดหัวใจไว้แล้ว */
  likedIds: Set<string>;
  onToggleLike: (video: VideoItem) => void;
  mode: PlayMode;
  onModeChange: (mode: PlayMode) => void;
  onExitPlaylist: () => void;
  onDetailOpenChange?: (open: boolean) => void;
  onSelect: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSetAppearance: (id: string, appearance: { icon?: string; color?: string }) => void;
  /** ตั้งปก (data URL) หรือส่ง undefined เพื่อกลับไปใช้ปกสุ่ม */
  onSetCover: (id: string, cover?: string) => void;
  onDelete: (id: string) => void;
  onPlay: (video: VideoItem) => void;
  onPlayAll: (videos: VideoItem[]) => void;
  onRemove: (videoId: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
}

// ---------- ไอคอน ----------
const PlayIcon = ({ size = 28 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
);
const MinusIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
);
const HeartFilled = ({ size }: { size: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
  </svg>
);
const PLAYLIST_ICONS = ["✦", "♥", "ϟ", "♫", "★", "✿", "☾", "☼", "♛", "☁"];
const PLAYLIST_COLORS = ["#ff7738", "#c9f45b", "#b894ff", "#45d5ee", "#ff5a9d", "#4d8dff", "#ffd84d", "#63dba0"];

// ---------- ปก ----------
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/** เลือกคลิปที่ใช้เป็นปกสุ่ม: คงที่ตาม id ของ playlist (ไม่กระพริบเปลี่ยนทุกครั้งที่ render) */
function coverSource(p: Playlist): string | null {
  if (p.cover) return p.cover;
  if (p.items.length === 0) return null;
  return p.items[hash(p.id) % p.items.length].thumbnail || null;
}

function Cover({ playlist, size }: { playlist: Playlist; size: number }) {
  const box = { width: size, height: size };
  const liked = isLikedId(playlist.id);
  const src = coverSource(playlist);
  if (!src) {
    return (
      <span className={`pl-cover pl-cover--empty${liked ? " pl-cover--liked" : ""}`} style={{ ...box, background: liked ? playlist.color ?? DEFAULT_LIKED_COLOR : playlist.color }} aria-hidden="true">
        <span>{liked ? <HeartFilled size={Math.round(size * 0.45)} /> : playlist.icon ?? DEFAULT_PLAYLIST_ICON}</span>
        {liked && <span className="pl-cover-pin" title="Pinned favorite" aria-hidden="true">📌</span>}
      </span>
    );
  }
  return (
    <span className={`pl-cover${liked ? " pl-cover--liked" : ""}`} style={box}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" onLoad={(event) => {
        const image = event.currentTarget;
        if (image.closest(".pl-lib-row") && image.naturalWidth && image.naturalHeight) {
          image.parentElement?.style.setProperty("aspect-ratio", `${image.naturalWidth} / ${image.naturalHeight}`);
        }
      }} />
      {liked
        ? <span className="pl-cover-pin" title="Pinned favorite" aria-hidden="true">📌</span>
        : <span className="pl-cover-mark" style={{ backgroundColor: playlist.color ?? DEFAULT_PLAYLIST_COLOR }} aria-hidden="true">{playlist.icon ?? DEFAULT_PLAYLIST_ICON}</span>}
    </span>
  );
}

/** ย่อรูปที่ผู้ใช้เลือกเป็นสี่เหลี่ยมจัตุรัส 320px (ตัดกลางภาพ) เพื่อไม่ให้ localStorage เต็ม */
async function fileToCover(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("อ่านไฟล์รูปไม่สำเร็จ"));
      el.src = url;
    });
    const SIZE = 320;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("เบราว์เซอร์นี้ย่อรูปไม่ได้");
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function PlaylistPanel({
  language = "English",
  playlists,
  selected,
  readOnly = false,
  playingId,
  playingFromSelected,
  likedIds,
  onToggleLike,
  mode,
  onModeChange,
  onExitPlaylist,
  onDetailOpenChange,
  onSelect,
  onRename,
  onSetAppearance,
  onSetCover,
  onDelete,
  onPlay,
  onPlayAll,
  onRemove,
  onMove,
}: Props) {
  const th = language === "ไทย";
  const [open, setOpen] = useState(false); // false = หน้ารายการ playlist, true = หน้ารายละเอียดของ selected
  const fileRef = useRef<HTMLInputElement>(null);
  const editMenuRef = useRef<HTMLDetailsElement>(null);
  const dragTrackRef = useRef<{ pointerId: number; index: number } | null>(null);

  useEffect(() => {
    const syncPlaylistDetail = () => {
      const historyEntry = window.history.state as { playlistDetailOpen?: boolean } | null;
      const isOpen = historyEntry?.playlistDetailOpen === true;
      setOpen(isOpen);
      onDetailOpenChange?.(isOpen);
    };
    function closeEditMenu(event: PointerEvent) {
      const menu = editMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    }
    function closeEditMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && editMenuRef.current?.open) editMenuRef.current.open = false;
    }
    document.addEventListener("pointerdown", closeEditMenu);
    document.addEventListener("keydown", closeEditMenuOnEscape);
    window.addEventListener("popstate", syncPlaylistDetail);
    syncPlaylistDetail();
    return () => {
      document.removeEventListener("pointerdown", closeEditMenu);
      document.removeEventListener("keydown", closeEditMenuOnEscape);
      window.removeEventListener("popstate", syncPlaylistDetail);
    };
  }, [onDetailOpenChange]);

  const detail = open ? selected : null;
  const isLiked = isLikedId(detail?.id);

  async function handleCoverFile(file: File | undefined) {
    if (!file || !detail) return;
    try {
      onSetCover(detail.id, await fileToCover(file));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "ตั้งปกไม่สำเร็จ");
    }
  }

  function shuffleLikedCover() {
    if (!detail || !isLikedId(detail.id)) return;
    const covers = detail.items.map((video) => video.thumbnail).filter(Boolean);
    if (!covers.length) return;
    const choices = covers.length > 1 ? covers.filter((cover) => cover !== detail.cover) : covers;
    onSetCover(detail.id, choices[Math.floor(Math.random() * choices.length)]);
  }

  function startTrackDrag(event: ReactPointerEvent<HTMLButtonElement>, index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragTrackRef.current = { pointerId: event.pointerId, index };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTrackByDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragTrackRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !selected) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLLIElement>(".pl-row[data-track-index]");
    if (!target) return;
    const targetIndex = Number(target.dataset.trackIndex);
    if (!Number.isInteger(targetIndex) || targetIndex === drag.index) return;

    const rect = target.getBoundingClientRect();
    let destination = targetIndex + (event.clientY > rect.top + rect.height / 2 ? 1 : 0);
    if (drag.index < targetIndex) destination -= 1;
    destination = Math.max(0, Math.min(selected.items.length - 1, destination));

    while (drag.index < destination) {
      onMove(drag.index, 1);
      drag.index += 1;
    }
    while (drag.index > destination) {
      onMove(drag.index, -1);
      drag.index -= 1;
    }
  }

  function endTrackDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (dragTrackRef.current?.pointerId !== event.pointerId) return;
    dragTrackRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  // ---------- หน้ารายละเอียด ----------
  if (detail) {
    const totalSec = detail.items.reduce((sum, v) => sum + v.durationSec, 0);
    return (
      <section className="pl-playlist-detail">
        <button
          type="button"
          className="pl-back"
          aria-label={th ? "กลับไปหน้าเพลย์ลิสต์ทั้งหมด" : "Back to all playlists"}
          onClick={() => {
            setOpen(false);
            onDetailOpenChange?.(false);
            onExitPlaylist();
            const historyEntry = window.history.state as { playlistDetailOpen?: boolean } | null;
            if (historyEntry?.playlistDetailOpen) window.history.back();
          }}
        >
          ← {th ? "เพลย์ลิสต์ทั้งหมด" : "All playlists"}
        </button>

        <div className={"pl-head pl-hero " + (isLiked ? "pl-hero-liked" : "pl-hero-orange")} style={detail.color ? { backgroundColor: detail.color } : undefined}>
          <span className="pl-hero-mark" aria-hidden="true">{isLiked ? "♥" : detail.icon ?? DEFAULT_PLAYLIST_ICON}</span>
          <div className="pl-head-info">
            <h3>{detail.name}</h3>
            <small>{th ? "เพลย์ลิสต์" : "Playlist"} · {detail.items.length} {th ? "คลิป" : "clips"} · {detail.visibility === "public" ? (th ? "สาธารณะ" : "Public") : (th ? "ส่วนตัว" : "Private")}</small>
          </div>
        </div>

        <div className="pl-actions pl-detail-actions">
          <button type="button" className="pl-play-all" disabled={detail.items.length === 0} onClick={() => onPlayAll(detail.items)} aria-label={th ? "เล่นเพลย์ลิสต์" : "Play playlist"} title={th ? "เล่นเพลย์ลิสต์" : "Play playlist"}><PlayIcon size={26} /></button>
          <button type="button" className="pl-shuffle" aria-label={mode === "shuffle" ? (th ? "ปิดการสุ่ม" : "Turn shuffle off") : (th ? "สุ่มเพลย์ลิสต์" : "Shuffle playlist")} aria-pressed={mode === "shuffle"} onClick={() => onModeChange(mode === "shuffle" ? "sequential" : "shuffle")}>⤨</button>
          {!readOnly && <details ref={editMenuRef} className="pl-edit-menu">
            <summary aria-label={th ? "แก้ไขเพลย์ลิสต์" : "Edit playlist"} title={th ? "แก้ไขเพลย์ลิสต์" : "Edit playlist"}>✎</summary>
            <div className="pl-edit-popover">
              <strong>{th ? "ตัวเลือกเพลย์ลิสต์" : "Playlist options"}</strong>
              <span className="pl-menu-label">{th ? "โหมดเล่น" : "Playback mode"}</span>
              {([["sequential", th ? "วนซ้ำทั้งหมด" : "Repeat all"], ["shuffle", th ? "สุ่ม" : "Shuffle"], ["single", th ? "วนซ้ำคลิปเดียว" : "Repeat one"], ["random-dance", "Random Dance"]] as const).map(([value, label]) => <button key={value} type="button" className="pl-mode-choice" aria-pressed={mode === value} onClick={() => onModeChange(value)}>{label}</button>)}
              {!isLiked && <>
                <span className="pl-menu-label">{th ? "จัดการเพลย์ลิสต์" : "Manage playlist"}</span>
                <span className="pl-menu-label">{th ? "สัญลักษณ์" : "Symbol"}</span>
                <div className="pl-appearance-options" aria-label={th ? "เลือกสัญลักษณ์" : "Choose symbol"}>
                  {PLAYLIST_ICONS.map((icon) => <button key={icon} type="button" className="pl-appearance-symbol" aria-label={icon} aria-pressed={(detail.icon ?? DEFAULT_PLAYLIST_ICON) === icon} onClick={() => onSetAppearance(detail.id, { icon })}>{icon}</button>)}
                </div>
                <button type="button" onClick={() => fileRef.current?.click()}>{th ? "เปลี่ยนภาพปก" : "Change cover"}</button>
                {detail.cover && <button type="button" onClick={() => onSetCover(detail.id, undefined)}>{th ? "ใช้ภาพปกจากคลิป" : "Use a clip cover"}</button>}
                <button type="button" onClick={() => { const name = window.prompt(th ? "ชื่อเพลย์ลิสต์" : "Playlist name", detail.name); if (name) onRename(detail.id, name); }}>{th ? "เปลี่ยนชื่อเพลย์ลิสต์" : "Rename playlist"}</button>
                <button type="button" className="pl-menu-danger" onClick={() => { if (window.confirm(th ? `ลบเพลย์ลิสต์ “${detail.name}” หรือไม่?` : `Delete playlist “${detail.name}”?`)) { onDelete(detail.id); setOpen(false); onDetailOpenChange?.(false); onExitPlaylist(); } }}>{th ? "ลบเพลย์ลิสต์" : "Delete playlist"}</button>
              </>}
              {isLiked && <>
                <span className="pl-menu-label">{th ? "ภาพปกรายการโปรด" : "Liked clips cover"}</span>
                <button type="button" disabled={detail.items.length === 0} onClick={shuffleLikedCover}>{th ? "สุ่มหน้าปกจากคลิปที่ถูกใจ" : "Shuffle cover from liked clips"}</button>
                <button type="button" onClick={() => fileRef.current?.click()}>{th ? "อัปโหลดภาพปก" : "Upload a cover"}</button>
              </>}
              <span className="pl-menu-label">{th ? "สีเพลย์ลิสต์" : "Playlist color"}</span>
              <div className="pl-appearance-options" aria-label={th ? "เลือกสีเพลย์ลิสต์" : "Choose playlist color"}>
                {PLAYLIST_COLORS.map((color) => <button key={color} type="button" className="pl-appearance-color" style={{ "--playlist-swatch": color } as CSSProperties} aria-label={color} aria-pressed={(detail.color ?? (isLiked ? DEFAULT_LIKED_COLOR : DEFAULT_PLAYLIST_COLOR)) === color} onClick={() => onSetAppearance(detail.id, { color })} />)}
              </div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void handleCoverFile(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
          </details>}
          {mode === "random-dance" && <strong className="pl-random-mode-badge" role="status">{th ? "โหมด Random Dance" : "Random Dance mode"}</strong>}
          <button type="button" className="pl-random-dance" aria-pressed={mode === "random-dance"} onClick={() => onModeChange(mode === "random-dance" ? "sequential" : "random-dance")}>{mode === "random-dance" ? (th ? "ยกเลิก Random Dance" : "Cancel Random Dance") : (th ? "Random Dance · เลือกคลิปแรก" : "Random Dance · Choose first clip")}</button>
        </div>

        {detail.items.length === 0 ? (
          <p>{isLiked ? (th ? "ยังไม่มีคลิปที่กดถูกใจ กดหัวใจที่คลิปเพื่อบันทึกได้เลย" : "No liked clips yet. Tap the heart on a clip to save it.") : (th ? "เพลย์ลิสต์นี้ยังว่าง ค้นหาแล้วกด “+ playlist” ที่คลิปที่ต้องการ" : 'This playlist is empty. Search for a clip and click “+ playlist” to add it.')}</p>
        ) : (
          <ol className="pl-tracks">
            {detail.items.map((v, i) => {
              const isPlaying = playingFromSelected && v.id === playingId;
              return (
                <li key={v.id} data-track-index={i} className={"pl-row " + (isPlaying ? "is-playing" : "")}>
                  <button type="button" className="pl-num pl-drag-handle" disabled={readOnly} aria-label={th ? `ลากเพื่อย้าย ${v.title}` : `Drag to reorder ${v.title}`} title={th ? "กดค้างแล้วลากเพื่อสลับลำดับ" : "Hold and drag to reorder"} onPointerDown={(event) => startTrackDrag(event, i)} onPointerMove={moveTrackByDrag} onPointerUp={endTrackDrag} onPointerCancel={endTrackDrag}>⠿</button>
                  <span className="pl-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={v.thumbnail} alt="" loading="lazy" />
                  </span>
                  <span className="pl-title"><strong className="youtube-origin">{v.title}</strong><br /><span className="pl-meta youtube-origin">{v.channel}{v.durationSec > 0 ? ` · ${formatTime(v.durationSec)}` : ""}</span></span>
                  <span className="pl-row-actions">
                    <button type="button" className="pl-row-play" onClick={() => onPlay(v)} aria-label={`${th ? "เล่น" : "Play"} ${v.title}`} title={th ? "เล่น" : "Play"}><PlayIcon size={23} /></button>
                    <details className="pl-row-menu">
                      <summary aria-label={`${th ? "ตัวเลือกเพิ่มเติมสำหรับ" : "More options for"} ${v.title}`} title={th ? "ตัวเลือกเพิ่มเติม" : "More options"}>···</summary>
                      <div className="pl-row-menu-popover">
                        <strong>{th ? "ตัวเลือกคลิป" : "Clip options"}</strong>
                        {!readOnly && <><button type="button" disabled={i === 0} onClick={() => onMove(i, -1)}>{th ? "เลื่อนขึ้น" : "Move up"}</button>
                        <button type="button" disabled={i === detail.items.length - 1} onClick={() => onMove(i, 1)}>{th ? "เลื่อนลง" : "Move down"}</button></>}
                        <button type="button" onClick={() => onToggleLike(v)}>{likedIds.has(v.id) ? (th ? "นำออกจากคลิปที่ถูกใจ" : "Remove from liked clips") : (th ? "เพิ่มในคลิปที่ถูกใจ" : "Add to liked clips")}</button>
                        {!isLiked && !readOnly && <button type="button" className="pl-menu-danger" onClick={() => onRemove(v.id)}>{th ? "นำออกจากเพลย์ลิสต์" : "Remove from playlist"}</button>}
                      </div>
                    </details>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    );
  }

  // ---------- หน้ารายการ playlist ----------
  return (
    <section>
      {playlists.every((p) => isLikedId(p.id)) && (
        <p>{th ? "ยังไม่มีเพลย์ลิสต์ กด “สร้างเพลย์ลิสต์” เพื่อเริ่มต้น หรือกด “+ playlist” ที่คลิปเพื่อเพิ่มคลิป" : 'No playlists yet. Create one or click “+ playlist” on a clip to add it.'}</p>
      )}

      <ul className="pl-lib">
        {playlists.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="pl-lib-row"
              style={{ "--playlist-card-color": isLikedId(p.id) ? p.color ?? DEFAULT_LIKED_COLOR : p.color ?? DEFAULT_PLAYLIST_COLOR } as CSSProperties}
              onClick={() => {
                onSelect(p.id);
                window.history.pushState({ ...window.history.state, playlistDetailOpen: true }, "");
                setOpen(true);
                onDetailOpenChange?.(true);
              }}
            >
              <Cover playlist={p} size={64} />
              <span>
                <span className="pl-lib-name">{p.name}</span>
                <br />
                <span className="pl-lib-sub">{th ? "เพลย์ลิสต์" : "Playlist"} · {p.items.length} {th ? "คลิป" : "clips"} · {p.visibility === "public" ? (th ? "สาธารณะ" : "Public") : (th ? "ส่วนตัว" : "Private")}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
