// lib/playlist.ts
// จัดการ playlist ของผู้ใช้ เก็บใน localStorage ของเบราว์เซอร์ (ยังไม่มีระบบบัญชี/ฐานข้อมูล)
// ถ้าภายหลังมี backend แค่เปลี่ยนที่เก็บข้อมูลในไฟล์นี้ ส่วน UI ไม่ต้องแก้

import { useCallback, useEffect, useMemo, useState } from "react";
import type { VideoItem } from "./youtube";

export interface Playlist {
  id: string;
  name: string;
  items: VideoItem[];
  icon?: string;
  color?: string;
  visibility?: "private" | "public";
  /** รูปปกที่ผู้ใช้ตั้งเอง (data URL) ถ้าไม่มีจะใช้ปกสุ่มจากคลิปใน playlist */
  cover?: string;
}

export const DEFAULT_PLAYLIST_ICON = "✦";
export const DEFAULT_PLAYLIST_COLOR = "#ff7738";
export const DEFAULT_LIKED_COLOR = "#c9f45b";

const STORAGE_KEY = "muverse:playlists";

/** วิธีเล่น: เรียงตามลำดับที่นำเข้า (วนซ้ำ) / สุ่ม (วนซ้ำ ไม่ซ้ำจนกว่าจะครบทุกเพลง) / วนซ้ำคลิปเดียว */
export type PlayMode = "sequential" | "shuffle" | "single" | "random-dance";

/** Special Liked clips playlist: liked videos are saved here automatically. */
export const LIKED_ID = "liked";
export const isLikedId = (id: string | null | undefined) => id === LIKED_ID;
const emptyLiked = (): Playlist => ({ id: LIKED_ID, name: "Liked clips", items: [], color: DEFAULT_LIKED_COLOR });

function randomCoverFrom(items: VideoItem[]): string | undefined {
  const covers = items.map((video) => video.thumbnail).filter((thumbnail): thumbnail is string => !!thumbnail);
  return covers.length ? covers[Math.floor(Math.random() * covers.length)] : undefined;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isVideo(v: unknown): v is VideoItem {
  const o = v as VideoItem;
  return !!o && typeof o.id === "string" && typeof o.title === "string";
}

function isPlaylist(p: unknown): p is Playlist {
  const o = p as Playlist;
  return !!o && typeof o.id === "string" && typeof o.name === "string" && Array.isArray(o.items);
}

export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>(() => [emptyLiked()]);
  const [loaded, setLoaded] = useState(false);

  // อ่านครั้งเดียวหลัง mount (ไม่อ่านตอน render เพื่อกัน hydration ไม่ตรงกับฝั่งเซิร์ฟเวอร์)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const all = parsed.filter(isPlaylist).map((p) => ({
            ...p,
            items: p.items.filter(isVideo),
            ...(p.id === LIKED_ID
              ? { color: p.color ?? DEFAULT_LIKED_COLOR }
              : { icon: p.icon ?? DEFAULT_PLAYLIST_ICON, color: p.color ?? DEFAULT_PLAYLIST_COLOR }),
          }));
          // Keep the liked collection at the front and normalize its display name.
          const liked = all.find((p) => p.id === LIKED_ID) ?? emptyLiked();
          setPlaylists([{ ...liked, name: "Liked clips", color: liked.color ?? DEFAULT_LIKED_COLOR, cover: liked.cover ?? randomCoverFrom(liked.items) }, ...all.filter((p) => p.id !== LIKED_ID)]);
        }
      }
    } catch {
      /* ข้อมูลเสียหรือ localStorage ใช้ไม่ได้ → เริ่มจากว่าง */
    }
    setLoaded(true);
  }, []);

  // บันทึกทุกครั้งที่เปลี่ยน (รอให้อ่านเสร็จก่อน ไม่งั้นจะเขียนทับของเดิมด้วยค่าว่าง)
  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(playlists));
    } catch {
      /* ignore */
    }
  }, [playlists, loaded]);

  const createPlaylist = useCallback((name: string, options: { icon?: string; color?: string; visibility?: "private" | "public" } = {}): string => {
    const id = newId();
    setPlaylists((prev) => [...prev, { id, name: name.trim() || `Playlist ${prev.length}`, items: [], icon: options.icon ?? DEFAULT_PLAYLIST_ICON, color: options.color ?? DEFAULT_PLAYLIST_COLOR, visibility: options.visibility ?? "private" }]); // prev.length นับ “ถูกใจ” อยู่แล้ว จึงไม่ต้อง +1
    return id;
  }, []);

  const renamePlaylist = useCallback((id: string, name: string) => {
    const next = name.trim();
    if (!next || id === LIKED_ID) return;
    setPlaylists((prev) => prev.map((p) => (p.id === id ? { ...p, name: next } : p)));
  }, []);

  const setCover = useCallback((id: string, cover?: string) => {
    setPlaylists((prev) => prev.map((p) => {
      if (p.id !== id) return p;
      return { ...p, cover: cover ?? (id === LIKED_ID ? randomCoverFrom(p.items) : undefined) };
    }));
  }, []);

  const setAppearance = useCallback((id: string, appearance: { icon?: string; color?: string }) => {
    if (id === LIKED_ID && appearance.icon) return;
    setPlaylists((prev) => prev.map((p) => (p.id === id ? { ...p, ...appearance } : p)));
  }, []);

  const deletePlaylist = useCallback((id: string) => {
    if (id === LIKED_ID) return;
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // คลิปเดียวกันไม่ใส่ซ้ำใน playlist เดียวกัน
  const addTrack = useCallback((playlistId: string, video: VideoItem) => {
    setPlaylists((prev) =>
      prev.map((p) =>
        p.id === playlistId && !p.items.some((v) => v.id === video.id) ? { ...p, items: [...p.items, video] } : p,
      ),
    );
  }, []);

  const removeTrack = useCallback((playlistId: string, videoId: string) => {
    setPlaylists((prev) =>
      prev.map((p) => (p.id === playlistId ? { ...p, items: p.items.filter((v) => v.id !== videoId) } : p)),
    );
  }, []);

  const moveTrack = useCallback((playlistId: string, index: number, direction: -1 | 1) => {
    setPlaylists((prev) =>
      prev.map((p) => {
        const to = index + direction;
        if (p.id !== playlistId || to < 0 || to >= p.items.length) return p;
        const items = [...p.items];
        [items[index], items[to]] = [items[to], items[index]];
        return { ...p, items };
      }),
    );
  }, []);

  // กดหัวใจ: ยังไม่มี → เพิ่มเข้า “ถูกใจ”, มีแล้ว → เอาออก
  const toggleLike = useCallback((video: VideoItem) => {
    setPlaylists((prev) =>
      prev.map((p) => {
        if (p.id !== LIKED_ID) return p;
        if (p.items.some((v) => v.id === video.id)) return { ...p, items: p.items.filter((v) => v.id !== video.id) };
        const items = [...p.items, video];
        return { ...p, items, ...(p.id === LIKED_ID && !p.cover ? { cover: randomCoverFrom(items) } : {}) };
      }),
    );
  }, []);

  const likedIds = useMemo(
    () => new Set(playlists.find((p) => p.id === LIKED_ID)?.items.map((v) => v.id) ?? []),
    [playlists],
  );

  return {
    playlists,
    likedIds,
    createPlaylist,
    renamePlaylist,
    setCover,
    setAppearance,
    deletePlaylist,
    addTrack,
    removeTrack,
    moveTrack,
    toggleLike,
  };
}
