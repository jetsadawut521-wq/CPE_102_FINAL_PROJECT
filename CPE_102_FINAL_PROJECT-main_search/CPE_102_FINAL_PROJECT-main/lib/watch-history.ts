import type { VideoItem } from "./youtube";

export interface WatchHistoryEntry {
  video: VideoItem;
  openedAt: number;
  /** Number of times this clip has been opened in this browser. */
  playCount: number;
}

export const HISTORY_LIMIT = 100;
export const HISTORY_KEY = "muverse:watch-history";

export function readWatchHistory(raw: string | null): WatchHistoryEntry[] {
  try {
    const data: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(data)) return [];
    const entries: WatchHistoryEntry[] = [];
    for (const entry of data) {
      const video = entry?.video;
      if (!video || typeof video.id !== "string" || !/^[\w-]{11}$/.test(video.id) ||
        typeof video.title !== "string" || !video.title.trim() ||
        typeof entry.openedAt !== "number" || !Number.isFinite(entry.openedAt) || entry.openedAt <= 0 || entry.openedAt > 8.64e15) continue;
      const playCount = typeof entry.playCount === "number" && Number.isFinite(entry.playCount)
        ? Math.max(1, Math.min(1_000_000, Math.floor(entry.playCount))) : 1;
      entries.push({ openedAt: entry.openedAt, playCount, video: {
        id: video.id, title: video.title.slice(0, 500),
        channel: typeof video.channel === "string" ? video.channel.slice(0, 200) : "",
        thumbnail: typeof video.thumbnail === "string" ? video.thumbnail : "",
        durationSec: typeof video.durationSec === "number" && Number.isFinite(video.durationSec) && video.durationSec >= 0 ? video.durationSec : 0,
      } });
    }
    const seen = new Set<string>();
    return entries.sort((a, b) => b.openedAt - a.openedAt).filter(({ video }) => {
      if (seen.has(video.id)) return false;
      seen.add(video.id); return true;
    }).slice(0, HISTORY_LIMIT);
  } catch { return []; }
}

export function recordVisit(entries: WatchHistoryEntry[], video: VideoItem, now = Date.now()): WatchHistoryEntry[] {
  const previous = entries.find((entry) => entry.video.id === video.id);
  return [{ video, openedAt: now, playCount: Math.min(1_000_000, (previous?.playCount ?? 0) + 1) },
    ...entries.filter((entry) => entry.video.id !== video.id)].slice(0, HISTORY_LIMIT);
}
