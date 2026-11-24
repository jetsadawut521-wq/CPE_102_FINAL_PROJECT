"use client";
// Muverse home: discovery, playback, saved collections, and practice tools.

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import HeartButton from "@/components/heart-button";
import PlaylistPanel from "@/components/playlist-panel";
import recommendedSeed from "@/data/recommended-playlists.json";
import YouTubePlayer from "@/components/youtube-player";
import VideoInfo from "@/components/video-info";
import YouTubeSearch from "@/components/youtube-search";
import { useWatchHistory } from "@/lib/use-watch-history";
import { useAutoHighlights } from "@/lib/auto-highlights";
import { classifyVideo } from "@/lib/search-category";
import { readSavedFormations, readSavedHighlights } from "@/lib/analysis-storage";
import { DEFAULT_LIKED_COLOR, DEFAULT_PLAYLIST_COLOR, DEFAULT_PLAYLIST_ICON, isLikedId, usePlaylists, type PlayMode, type Playlist } from "@/lib/playlist";
import type { VideoItem } from "@/lib/youtube";

const MODE_KEY = "muverse:playmode";
const PLAYLIST_COLORS = ["#ff7738", "#c9f45b", "#b894ff", "#45d5ee", "#ff5a9d", "#4d8dff", "#ffd84d", "#63dba0"];
const BUILT_IN_RECOMMENDED = recommendedSeed.playlists as Playlist[];
const HERO_VIDEO: VideoItem = {
  id: "-q_S27LbNKU",
  title: "ATEEZ(에이티즈) - 'BAD' Official MV",
  channel: "KQ ENTERTAINMENT",
  thumbnail: "https://img.youtube.com/vi/-q_S27LbNKU/maxresdefault.jpg",
  durationSec: 225,
  category: "other",
};

type NavIconName = "home" | "random" | "practice" | "playlists" | "account";

function fallbackHeroThumbnail(image: HTMLImageElement, videoId: string) {
  const quality = image.dataset.thumbnailQuality ?? "maxresdefault";
  const nextQuality = quality === "maxresdefault" ? "sddefault" : quality === "sddefault" ? "hqdefault" : null;
  if (!nextQuality) return;
  image.dataset.thumbnailQuality = nextQuality;
  image.src = `https://img.youtube.com/vi/${videoId}/${nextQuality}.jpg`;
}

function NavIcon({ name }: { name: NavIconName }) {
  const common = { className: "nav-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, focusable: false as const };
  switch (name) {
    case "home": return <svg {...common}><path d="M3.5 10.5 12 3.8l8.5 6.7v9.2h-6v-6h-5v6h-6z" /></svg>;
    case "random": return <svg {...common}><path d="M3 7h2.5c1.2 0 2.2.5 3 1.4l7 8.2c.8.9 1.8 1.4 3 1.4H21" /><path d="m17 14 4 4-4 4" /><path d="M3 17h2.5c1.2 0 2.2-.5 3-1.4l7-8.2c.8-.9 1.8-1.4 3-1.4H21" /><path d="m17 2 4 4-4 4" /></svg>;
    case "practice": return <svg {...common}><path d="M3 4.5h18v15H3z" /><path d="m10 8 6 4-6 4z" /></svg>;
    case "playlists": return <svg {...common}><path d="M3 5h12M3 11h12M3 17h8" /><path d="m15 15 6 3.5-6 3.5z" /></svg>;
    case "account": return <svg {...common}><circle cx="12" cy="7.5" r="3.5" /><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2" /></svg>;
  }
}

// สถานะการสุ่มของ playlist ที่กำลังเล่น (เก็บใน ref เพราะไม่ต้องให้หน้า re-render)
interface ShuffleSession {
  sourceId: string | null;
  history: string[]; // ลำดับเพลงที่เล่นไปแล้ว ใช้กด “ก่อนหน้า” ย้อนกลับได้ตรงกับที่เล่นจริง
  cursor: number; // ตำแหน่งปัจจุบันใน history
  round: Set<string>; // เพลงที่เล่นไปแล้วในรอบนี้ จะไม่ถูกสุ่มซ้ำจนกว่าจะครบทุกเพลง
}

// ข้อความบอกผู้ใช้ว่าทำไมคลิปนี้ไม่มีท่อนฮุคให้ (เพื่อให้รู้ว่าระบบทำงานแล้ว ไม่ใช่พัง)
const NO_HIGHLIGHT_REASON: Record<string, string> = {
  tutorial: "ไม่แสดงท่อนฮุค: เป็นคลิปสอนเต้น (ฟีเจอร์นี้ใช้กับคลิปเต้นตาม)",
  aerobic: "ไม่แสดงท่อนฮุค: เป็นคลิปแอโรบิก/ออกกำลังกาย",
  "not-dance-along": "ไม่แสดงท่อนฮุค: ระบบไม่เห็นว่าเป็นคลิปเต้นตาม",
  duration: "ไม่แสดงท่อนฮุค: ยังไม่ทราบความยาวคลิป (อาจเป็นไลฟ์)",
  "not-found": "ไม่แสดงท่อนฮุค: ไม่พบข้อมูลคลิปจาก YouTube",
  "no-lyrics": "ยังไม่พบข้อมูลที่ใช้ตรวจจับท่อนฮุคอัตโนมัติของคลิปนี้",
  "untimed-lyrics": "พบเนื้อเพลงแล้ว แต่ไม่มีเวลาประกอบแต่ละบรรทัด จึงยังระบุช่วงฮุคอัตโนมัติไม่ได้",
  "alignment-required": "ยังไม่แสดงท่อนฮุค: ระบบยืนยันตำแหน่งเพลงในคลิปนี้ไม่ได้",
  "duration-mismatch": "ไม่แสดงท่อนฮุค: เพลงที่พบมีความยาวไม่ตรงกับคลิป (คลิปอาจมีอินโทรหรือตัดต่อ) จึงไม่เดาตำแหน่ง",
  "fast-no-repeat": "โหมดเร็วไม่พบช่วงเสียงซ้ำที่มีหลักฐานเพียงพอ จึงยังไม่เสนอท่อนฮุค",
  "no-chorus": "ไม่แสดงท่อนฮุค: ไม่พบท่อนที่เนื้อเพลงวนซ้ำ",
  default: "ยังไม่พบท่อนฮุคอัตโนมัติของคลิปนี้",
};

const AUDIO_FAILURE_REASON: Record<string, string> = {
  "worker-unreachable": "ติดต่อบริการวิเคราะห์เสียงไม่ได้ กรุณาตรวจว่าตัววิเคราะห์ใน Ubuntu ยังเปิดอยู่",
  "worker-configuration": "การตั้งค่าบริการวิเคราะห์เสียงไม่ถูกต้อง",
  "worker-auth": "บริการวิเคราะห์เสียงปฏิเสธการเชื่อมต่อ กรุณาตรวจการตั้งค่า",
  "download-timeout": "ดึงเสียงจาก YouTube ไม่ทันเวลา กรุณาลองคลิปนี้อีกครั้ง",
  "download-failed": "YouTube ไม่สามารถส่งไฟล์เสียงของคลิปนี้ให้ตัววิเคราะห์ได้",
  "download-rejected": "ไฟล์เสียงของคลิปนี้ไม่ผ่านเงื่อนไขการดาวน์โหลด",
  "decode-failed": "อ่านรูปแบบไฟล์เสียงของคลิปนี้ไม่สำเร็จ",
  "decode-timeout": "การอ่านไฟล์เสียงใช้เวลานานเกินไป",
  "dependency-missing": "ตัววิเคราะห์ขาดแพ็กเกจที่จำเป็น กรุณาดูข้อความใน Ubuntu",
  "tool-missing": "ตัววิเคราะห์หาเครื่องมืออ่านเสียงไม่พบ กรุณาดูข้อความใน Ubuntu",
  "analysis-failed": "ตัววิเคราะห์เกิดข้อผิดพลาดหลังรับเสียง กรุณาส่งข้อความผิดพลาดจาก Ubuntu",
};

type AppView = "home" | "random" | "practice" | "playlists" | "account";

// Store enough app state in each browser history entry to restore the actual prior screen.
interface NavEntry {
  mv: { video: VideoItem | null; sourceId: string | null; view?: AppView; selectedId?: string | null; practiceSearchMode?: boolean; practiceSearchQuery?: string | null; randomPickerMode?: boolean };
  playlistDetailOpen?: boolean;
}

export default function Page() {
  const pl = usePlaylists();
  const [current, setCurrent] = useState<VideoItem | null>(null);
  const [activeView, setActiveView] = useState<AppView>("home");
  const [practiceSearchMode, setPracticeSearchMode] = useState(false);
  const [randomPickerMode, setRandomPickerMode] = useState(false);
  const [practiceSearchQuery, setPracticeSearchQuery] = useState<string | null>(null);
  const [accountMode, setAccountMode] = useState<"login" | "create" | "reset">("login");
  const [accountNotice, setAccountNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [appDark, setAppDark] = useState(false);
  const [displayLanguage, setDisplayLanguage] = useState("English");
  const th = displayLanguage === "ไทย";
  const tr = (english: string, thai: string) => th ? thai : english;
  const visits = useWatchHistory();
  useEffect(() => {
    const savedTheme = window.localStorage.getItem("muverse:theme");
    const savedLanguage = window.localStorage.getItem("muverse:language");
    if (savedTheme === "dark") setAppDark(true);
    if (savedLanguage) setDisplayLanguage(savedLanguage);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = appDark ? "dark" : "light";
    window.localStorage.setItem("muverse:theme", appDark ? "dark" : "light");
  }, [appDark]);
  useEffect(() => { window.localStorage.setItem("muverse:language", displayLanguage); }, [displayLanguage]);
  useEffect(() => { document.documentElement.lang = th ? "th" : "en"; }, [th]);
  useEffect(() => {
    if (!settingsOpen) return;
    const close = () => { setSettingsOpen(false); setLanguageOpen(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [settingsOpen]);
  const recordVisit = visits.record;
  const [repeatEntries, setRepeatEntries] = useState(visits.entries);
  useEffect(() => {
    // Shuffle ties (including an all-once history), then rank frequent clips.
    // Running this after mount avoids random ordering differences during hydration.
    const shuffled = [...visits.entries];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    setRepeatEntries(shuffled.sort((a, b) => b.playCount - a.playCount));
  }, [visits.entries]);
  const [selectedId, setSelectedId] = useState<string | null>(null); // playlist ที่เปิดดู
  const [playlistDetailOpen, setPlaylistDetailOpen] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null); // playlist ที่กำลังเล่นต่อเนื่องอยู่ (null = เล่นคลิปเดี่ยวจากการค้นหา)
  const [pendingAddVideo, setPendingAddVideo] = useState<VideoItem | null>(null);
  const [addDestinationId, setAddDestinationId] = useState("");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [createPlaylistOpen, setCreatePlaylistOpen] = useState(false);
  const [createPlaylistName, setCreatePlaylistName] = useState("");
  const [newPlaylistIcon, setNewPlaylistIcon] = useState(DEFAULT_PLAYLIST_ICON);
  const [newPlaylistColor, setNewPlaylistColor] = useState(DEFAULT_PLAYLIST_COLOR);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [newPlaylistVisibility, setNewPlaylistVisibility] = useState<"private" | "public">("private");
  const [mode, setMode] = useState<PlayMode>("sequential");
  const [analysisRevision, setAnalysisRevision] = useState(0);
  const [focusSerial, setFocusSerial] = useState(0);
  const isTutorial = !!current && (current.category === "tutorial" || classifyVideo(current.title) === "tutorial");
  const auto = useAutoHighlights(isTutorial ? undefined : current?.id); // คลิปสอนเต้นไม่เรียกตัววิเคราะห์ท่อนฮุค
  const [homeKey, setHomeKey] = useState(0); // เปลี่ยนค่านี้เพื่อรีเซ็ตหน้าค้นหา/หน้า playlist กลับสู่สภาพเริ่มต้น
  const session = useRef<ShuffleSession>({ sourceId: null, history: [], cursor: -1, round: new Set() });
  const randomSkipGuard = useRef<string | null>(null);
  const repeatTrackRef = useRef<HTMLDivElement | null>(null);
  const repeatDragRef = useRef<{ startX: number; startScrollLeft: number; moved: boolean } | null>(null);
  const suppressRepeatClick = useRef(false);

  useEffect(() => {
    const track = repeatTrackRef.current;
    if (!track || activeView !== "home" || !visits.loaded) return;
    const onWheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (delta) {
        event.preventDefault();
        track.scrollLeft += delta;
      }
    };
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => track.removeEventListener("wheel", onWheel);
  }, [activeView, visits.loaded, repeatEntries.length]);

  useEffect(() => {
    const refresh = () => setAnalysisRevision((value) => value + 1);
    window.addEventListener("muverse:analysis-updated", refresh);
    return () => window.removeEventListener("muverse:analysis-updated", refresh);
  }, []);

  // จำวิธีเล่นที่เลือกไว้ (อ่านหลัง mount เพื่อกัน hydration ไม่ตรงกับฝั่งเซิร์ฟเวอร์)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MODE_KEY);
      if (saved === "sequential" || saved === "shuffle" || saved === "single" || saved === "random-dance") setMode(saved);
    } catch {
      /* ใช้ค่าเริ่มต้น */
    }
  }, []);

  // Restore the view and its selected clip/playlist when browser Back/Forward is used.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const mv = (e.state as Partial<NavEntry> | null)?.mv;
      const video = mv?.video ?? null;
      if (video) recordVisit(video);
      setCurrent(video);
      setSourceId(video ? mv?.sourceId ?? null : null);
      setActiveView(mv?.view ?? (video ? "practice" : "home"));
      setSelectedId(mv?.selectedId ?? null);
      setPlaylistDetailOpen((e.state as NavEntry | null)?.playlistDetailOpen === true);
      setPracticeSearchMode(mv?.practiceSearchMode ?? false);
      setPracticeSearchQuery(mv?.practiceSearchQuery ?? null);
      setRandomPickerMode(mv?.randomPickerMode ?? false);
    };
    const historyState = window.history.state as (Record<string, unknown> & Partial<NavEntry>) | null;
    const initial = historyState?.mv;
    if (!initial) {
      window.history.replaceState({ ...historyState, playlistDetailOpen: false, mv: { video: null, sourceId: null, view: "home", selectedId: null, practiceSearchMode: false, practiceSearchQuery: null, randomPickerMode: false } } satisfies NavEntry, "");
    }
    if (initial?.video) {
      setCurrent(initial.video);
      setSourceId(initial.sourceId ?? null);
      setActiveView(initial.view ?? "practice");
      setSelectedId(initial.selectedId ?? null);
      setPlaylistDetailOpen(historyState?.playlistDetailOpen === true);
      setPracticeSearchMode(initial.practiceSearchMode ?? false);
      setPracticeSearchQuery(initial.practiceSearchQuery ?? null);
      setRandomPickerMode(initial.randomPickerMode ?? false);
    } else if (initial?.view) {
      setActiveView(initial.view);
      setSelectedId(initial.selectedId ?? null);
      setPlaylistDetailOpen(historyState?.playlistDetailOpen === true);
      setPracticeSearchMode(initial.practiceSearchMode ?? false);
      setPracticeSearchQuery(initial.practiceSearchQuery ?? null);
      setRandomPickerMode(initial.randomPickerMode ?? false);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [recordVisit]);

  const selected = pl.playlists.find((p) => p.id === selectedId) ?? BUILT_IN_RECOMMENDED.find((p) => p.id === selectedId) ?? null;
  const source = pl.playlists.find((p) => p.id === sourceId) ?? BUILT_IN_RECOMMENDED.find((p) => p.id === sourceId) ?? null;

  // กดชื่อเว็บ: กลับหน้าหลัก หยุดเล่น ล้างผลค้นหา และกลับไปหน้ารายการ playlist (playlist และโหมดที่เลือกไว้ยังอยู่)
  function goHome(e: React.MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // เปิดแท็บใหม่ตามปกติ
    e.preventDefault();
    window.history.pushState({ ...window.history.state, playlistDetailOpen: false, mv: { video: null, sourceId: null, view: "home", selectedId, practiceSearchMode: false, practiceSearchQuery: null, randomPickerMode: false } } satisfies NavEntry, "");
    setCurrent(null);
    setSourceId(null);
    if (mode === "random-dance") changeMode("sequential");
    setActiveView("home");
    setPracticeSearchMode(false);
    setRandomPickerMode(false);
    setHomeKey((k) => k + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function play(video: VideoItem, fromPlaylistId: string | null, scroll = true, nav: "push" | "replace" = "push") {
    recordVisit(video);
    const nextView: AppView = mode === "random-dance" && fromPlaylistId ? "random" : "practice";
    const nextSearchQuery = fromPlaylistId ? null : practiceSearchQuery;
    const entry: NavEntry = { mv: { video, sourceId: fromPlaylistId, view: nextView, selectedId, practiceSearchMode: false, practiceSearchQuery: nextSearchQuery, randomPickerMode: false } };
    if (nav === "push") window.history.pushState({ ...window.history.state, playlistDetailOpen: false, ...entry }, "");
    else window.history.replaceState({ ...window.history.state, playlistDetailOpen: false, ...entry }, "");
    setCurrent(video);
    setSourceId(fromPlaylistId);
    setActiveView(nextView);
    setPlaylistDetailOpen(false);
    setPracticeSearchMode(false);
    if (fromPlaylistId) setPracticeSearchQuery(null);
    setRandomPickerMode(false);
    setFocusSerial((value) => value + 1);
    // เครื่องเล่นอยู่ด้านบน เลื่อนขึ้นไปให้เห็นทันทีหลังเลือกคลิป (ตอนเล่นเพลงถัดไปอัตโนมัติไม่เลื่อน)
    if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ให้ผู้ใช้เลือกปลายทางทุกครั้ง แทนที่จะเดา playlist ปัจจุบันหรือ playlist แรก
  function addToPlaylist(video: VideoItem) {
    setPendingAddVideo(video);
    setAddDestinationId("");
    setNewPlaylistName("");
  }

  function confirmAddToPlaylist() {
    if (!pendingAddVideo) return;
    const name = newPlaylistName.trim();
    if (name) {
      const id = pl.createPlaylist(name);
      pl.addTrack(id, pendingAddVideo);
    } else {
      const destination = pl.playlists.find((playlist) => playlist.id === addDestinationId && !isLikedId(playlist.id));
      if (!destination || destination.items.some((video) => video.id === pendingAddVideo.id)) return;
      pl.addTrack(destination.id, pendingAddVideo);
    }
    setPendingAddVideo(null);
  }

  const selectedAddDestination = pl.playlists.find((playlist) => playlist.id === addDestinationId);
  const addDestinationHasVideo = !!pendingAddVideo && !!selectedAddDestination?.items.some((video) => video.id === pendingAddVideo.id);
  const userPlaylists = pl.playlists.filter((playlist) => !isLikedId(playlist.id));
  const addablePlaylists = pendingAddVideo
    ? userPlaylists.filter((playlist) => !playlist.items.some((video) => video.id === pendingAddVideo.id))
    : userPlaylists;
  const playlistsAlreadyContainingVideo = pendingAddVideo
    ? userPlaylists.filter((playlist) => playlist.items.some((video) => video.id === pendingAddVideo.id))
    : [];

  // ---------- วิธีเล่นต่อเนื่อง ----------
  function startSession(sourceId: string, videoId: string) {
    session.current = { sourceId, history: [videoId], cursor: 0, round: new Set([videoId]) };
  }

  // ผู้ใช้เลือกเพลงเองจาก playlist: ต่อท้ายประวัติ (ตัดส่วนที่ย้อนกลับมาแล้วทิ้ง) และนับว่าเล่นแล้วในรอบนี้
  function recordManual(sourceId: string, videoId: string) {
    const s = session.current;
    if (s.sourceId !== sourceId) return startSession(sourceId, videoId);
    s.history = [...s.history.slice(0, s.cursor + 1), videoId];
    s.cursor = s.history.length - 1;
    s.round.add(videoId);
  }

  function changeMode(next: PlayMode, autoStartRandom = true) {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      /* ignore */
    }
    // เปลี่ยนมาโหมดสุ่มระหว่างเล่น: เริ่มรอบใหม่โดยนับเพลงที่กำลังเล่นว่าเล่นแล้ว
    if (next === "shuffle" && source && current) startSession(source.id, current.id);
    if (next === "random-dance" && autoStartRandom) {
      setFocusSerial((value) => value + 1);
      const playlist = selected ?? source;
      const eligible = playlist?.items.filter((video) =>
        !!readSavedHighlights(video.id)?.length && !!readSavedFormations(video.id)?.length) ?? [];
      if (playlist && eligible.length) {
        const start = current && eligible.some((video) => video.id === current.id)
          ? current : eligible[Math.floor(Math.random() * eligible.length)];
        startSession(playlist.id, start.id);
        if (start.id !== current?.id || source?.id !== playlist.id) play(start, playlist.id, false, "replace");
      }
    }
  }

  // สุ่มเพลงถัดไปจากเพลงที่ยังไม่ได้เล่นในรอบนี้ ถ้าครบทุกเพลงแล้วเริ่มรอบใหม่ (เพลงที่เพิ่งจบจะไม่มาซ้ำทันที)
  function pickShuffleNext(items: VideoItem[], currentId: string): VideoItem | null {
    if (items.length < 2) return items[0] ?? null;
    const s = session.current;
    let pool = items.filter((v) => !s.round.has(v.id));
    if (pool.length === 0) {
      s.round = new Set();
      pool = items.filter((v) => v.id !== currentId);
    }
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  function stepShuffle(src: Playlist, cur: VideoItem, delta: 1 | -1, scroll: boolean) {
    const s0 = session.current;
    if (s0.sourceId !== src.id || s0.history[s0.cursor] !== cur.id) startSession(src.id, cur.id);
    const s = session.current;
    const find = (id: string) => src.items.find((v) => v.id === id);

    if (delta < 0) {
      // ก่อนหน้า = ย้อนไปเพลงที่เพิ่งเล่นจริง (ข้ามเพลงที่ถูกลบออกจาก playlist ไปแล้ว)
      let c = s.cursor - 1;
      while (c >= 0 && !find(s.history[c])) c--;
      const prev = c >= 0 ? find(s.history[c]) : undefined;
      if (!prev) return;
      s.cursor = c;
      play(prev, src.id, scroll, "replace");
      return;
    }

    // ถัดไป: ถ้าเคยย้อนกลับมา เล่นตามประวัติเดิมก่อน หมดแล้วค่อยสุ่มเพลงใหม่
    let c = s.cursor + 1;
    while (c < s.history.length && !find(s.history[c])) c++;
    const forward = c < s.history.length ? find(s.history[c]) : undefined;
    if (forward) {
      s.cursor = c;
      play(forward, src.id, scroll, "replace");
      return;
    }
    const next = pickShuffleNext(src.items, cur.id);
    if (!next) return; // มีเพลงเดียว ไม่มีอะไรให้สุ่ม
    s.history.push(next.id);
    s.cursor = s.history.length - 1;
    s.round.add(next.id);
    play(next, src.id, scroll, "replace");
  }

  // ไปคลิปถัดไป (+1) / ก่อนหน้า (-1) ใน playlist ที่กำลังเล่น (ทั้งสองแบบวนซ้ำไม่จบ)
  function step(delta: 1 | -1, scroll: boolean) {
    if (!source || !current) return;
    const idx = source.items.findIndex((v) => v.id === current.id);
    if (idx < 0) return; // คลิปปัจจุบันถูกลบออกจาก playlist ไปแล้ว

    if (mode === "random-dance") {
      const eligible = source.items.filter((video) => {
        const highlights = readSavedHighlights(video.id);
        const formations = readSavedFormations(video.id);
        return !!highlights?.length && !!formations?.length;
      });
      if (!eligible.length) return;
      return stepShuffle({ ...source, items: eligible }, current, delta, scroll);
    }
    if (mode === "shuffle") return stepShuffle(source, current, delta, scroll);

    // วนซ้ำแบบเรียง: ตามลำดับที่นำเข้า จบเพลงสุดท้ายกลับไปเพลงแรก
    const n = source.items.length;
    const nextVideo = source.items[(idx + delta + n) % n];
    if (!nextVideo || nextVideo.id === current.id) return; // มีเพลงเดียว
    play(nextVideo, source.id, scroll, "replace");
  }

  function playAll(items: VideoItem[]) {
    if (mode === "random-dance") {
      const eligible = items.filter((video) => {
        const highlights = readSavedHighlights(video.id);
        const formations = readSavedFormations(video.id);
        return !!highlights?.length && !!formations?.length;
      });
      if (!eligible.length) {
        window.alert("ยังไม่มีคลิปที่บันทึกผลไฮไลท์และฟอร์เมชันครบทั้งสองอย่าง");
        return;
      }
      const first = eligible[Math.floor(Math.random() * eligible.length)];
      startSession(selected?.id ?? "", first.id);
      play(first, selected?.id ?? null);
      return;
    }
    const first = items[0];
    if (first) play(first, selected?.id ?? null);
  }

  function startRandomPlaylist(playlist: Playlist) {
    const eligible = playlist.items.filter((video) =>
      !!readSavedHighlights(video.id)?.length && !!readSavedFormations(video.id)?.length);
    if (!eligible.length) {
      window.alert("เพลย์ลิสต์นี้ยังไม่มีคลิปที่บันทึกผลไฮไลท์และฟอร์เมชันครบ");
      return;
    }
    const first = eligible[Math.floor(Math.random() * eligible.length)];
    setSelectedId(playlist.id);
    setPlaylistDetailOpen(false);
    startSession(playlist.id, first.id);
    play(first, playlist.id);
  }

  const randomDanceEligibleCount = (selected?.items ?? []).filter((video) =>
    !!readSavedHighlights(video.id)?.length && !!readSavedFormations(video.id)?.length).length;
  void analysisRevision;
  const currentHasSavedFormation = current ? !!readSavedFormations(current.id)?.length : false;
  const randomDanceSessionActive = activeView === "random" && mode === "random-dance" && sourceId !== null;
  const firstHighlight = randomDanceSessionActive && currentHasSavedFormation
    ? [...auto.segments].sort((a, b) => a.start - b.start)[0] : undefined;
  const focusRange = current && firstHighlight ? {
    start: Math.max(0, firstHighlight.start - 4),
    end: firstHighlight.end + 4,
    key: `${current.id}:${focusSerial}`,
  } : undefined;
  const heroVideo = HERO_VIDEO;
  const recentVideoIds = new Set(visits.entries.slice(0, 8).map((entry) => entry.video.id));
  const moreVideos = [...pl.playlists.flatMap((playlist) => playlist.items), ...visits.entries.slice(8).map((entry) => entry.video)]
    .filter((video, index, all) => !recentVideoIds.has(video.id) && all.findIndex((item) => item.id === video.id) === index);
  const discoverVideos = moreVideos.slice(0, 4);

  function navigate(view: AppView, nextSelectedId = selectedId) {
    if (view === "random" && mode !== "random-dance") changeMode("random-dance", false);
    if (view !== "random" && mode === "random-dance") changeMode("sequential");
    const nextSearchMode = view === "practice";
    const nextRandomPickerMode = view === "random";
    const nextSearchQuery = view === "practice" ? null : practiceSearchQuery;
    const shouldPush = view !== activeView || (view === "practice" && !practiceSearchMode) || nextSelectedId !== selectedId;
    if (shouldPush) {
      window.history.pushState({ ...window.history.state, playlistDetailOpen: false, mv: { video: current, sourceId, view, selectedId: nextSelectedId, practiceSearchMode: nextSearchMode, practiceSearchQuery: nextSearchQuery, randomPickerMode: nextRandomPickerMode } } satisfies NavEntry, "");
    }
    setActiveView(view);
    setSelectedId(nextSelectedId);
    setPlaylistDetailOpen(false);
    setPracticeSearchMode(nextSearchMode);
    setRandomPickerMode(nextRandomPickerMode);
    if (view === "practice") setPracticeSearchQuery(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openRandomPlaylist(playlist: Playlist) {
    if (mode !== "random-dance") changeMode("random-dance", false);
    window.history.pushState({ ...window.history.state, playlistDetailOpen: true, mv: {
      video: current, sourceId, view: "random", selectedId: playlist.id,
      practiceSearchMode: false, practiceSearchQuery, randomPickerMode: true,
    } } satisfies NavEntry, "");
    setSelectedId(playlist.id);
    setActiveView("random");
    setRandomPickerMode(true);
    setPlaylistDetailOpen(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    if (mode !== "random-dance" || !source || !current) return;
    const eligible = source.items.filter((video) =>
      !!readSavedHighlights(video.id)?.length && !!readSavedFormations(video.id)?.length);
    if (eligible.some((video) => video.id === current.id)) {
      randomSkipGuard.current = null;
      return;
    }
    const guardKey = `${source.id}:${current.id}:${analysisRevision}`;
    if (randomSkipGuard.current === guardKey) return;
    randomSkipGuard.current = guardKey;
    if (!eligible.length) {
      setCurrent(null);
      setSourceId(null);
      return;
    }
    const next = eligible[Math.floor(Math.random() * eligible.length)];
    startSession(source.id, next.id);
    play(next, source.id, false, "replace");
  }, [mode, source?.id, current?.id, analysisRevision]);

  return (
    <main className={"muverse-app " + (appDark ? "theme-dark" : "")}>
      <header className="site-header">
        <Link href="/" className="brand" onClick={goHome} aria-label="Muverse home">
          <span>MUVERSE</span><span className="brand-spark" aria-hidden="true">✦</span>
        </Link>
        <div className="header-actions">
          {activeView !== "account" && activeView !== "practice" && <div className="header-search">
            <YouTubeSearch language={displayLanguage} key={"search-" + homeKey} activeId={current?.id} onSelect={(video) => play(video, null)} onAdd={addToPlaylist} likedIds={pl.likedIds} onToggleLike={pl.toggleLike} />
          </div>}
          <div className={`practice-search practice-search--header${activeView === "practice" ? "" : " is-hidden"}`}><YouTubeSearch language={displayLanguage} key={"practice-search-" + homeKey} inline inlineActive={activeView === "practice" && practiceSearchQuery !== null} inlineResultsOnPage={activeView === "practice" && (practiceSearchMode || !current)} onInlineQueryChange={setPracticeSearchQuery} activeId={current?.id} onSelect={(video) => play(video, null)} onAdd={addToPlaylist} likedIds={pl.likedIds} onToggleLike={pl.toggleLike} /></div>
          <div className="settings-wrap" onClick={(event) => event.stopPropagation()}>
            <button className="settings-trigger" type="button" aria-label={tr("Settings", "การตั้งค่า")} aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.28 7.28 0 0 0-1.63-.95l-.36-2.54a.5.5 0 0 0-.5-.43h-3.84a.5.5 0 0 0-.5.43l-.36 2.54c-.59.22-1.13.55-1.63.95l-2.39-.96a.5.5 0 0 0-.61.22L2.73 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.7 7.7 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.4 1.04.72 1.63.95l.36 2.54a.5.5 0 0 0 .5.43h3.84a.5.5 0 0 0 .5-.43l.36-2.54c.59-.23 1.13-.55 1.63-.95l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64z"/></svg>
            </button>
            {settingsOpen && <section className="settings-popover" aria-label={tr("Account and display settings", "การตั้งค่าบัญชีและการแสดงผล")} onClick={(event) => event.stopPropagation()}>
              <h2>{tr("Account", "บัญชี")}</h2>
              <div className="settings-row"><span className="settings-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.1A8.6 8.6 0 0 1 8.9 3.5 8.7 8.7 0 1 0 20.5 15Z"/></svg>{tr("App theme", "ธีมแอป")}</span><button className={"settings-switch " + (appDark ? "is-on" : "")} type="button" role="switch" aria-checked={appDark} aria-label={tr("Toggle app theme", "สลับธีมแอป")} onClick={() => setAppDark((dark) => !dark)}><span>{appDark ? "☾" : "☀"}</span></button></div>
              <div className="settings-language">
                <button className="settings-row settings-language-trigger" type="button" aria-expanded={languageOpen} onClick={() => setLanguageOpen((open) => !open)}><span className="settings-label"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h11M9.5 3v2m2 0c-.7 4-3.5 7-7 8m1-5c1.2 2.5 3.5 4.5 6.5 5.5M14 19l4-10 4 10m-6.5-3h5"/></svg>{tr("Display language", "ภาษาที่แสดง")}</span><span className="settings-current">{displayLanguage}<b aria-hidden="true">›</b></span></button>
                {languageOpen && <div className="settings-language-options"><button type="button" lang="en" onClick={() => { setDisplayLanguage("English"); setLanguageOpen(false); }}>English {displayLanguage === "English" && <span>✓</span>}</button><button type="button" lang="th" onClick={() => { setDisplayLanguage("ไทย"); setLanguageOpen(false); }}>ไทย {displayLanguage === "ไทย" && <span>✓</span>}</button></div>}
              </div>
              <button className="settings-login" type="button" onClick={() => { navigate("account"); setSettingsOpen(false); setLanguageOpen(false); }}>{tr("Log in", "เข้าสู่ระบบ")}</button>
            </section>}
          </div>
        </div>
      </header>

      {activeView === "home" && <>
      <section className="welcome-panel" aria-labelledby="welcome-title">
        <div className="welcome-copy">
          <span className="eyebrow">{tr("YOUR DAILY DOSE OF DANCE / VOL. 02", "เติมพลังการเต้นประจำวัน / VOL. 02")}</span>
          <h1 id="welcome-title">{th ? <>ค้นหา<br /><em>ท่าเต้นถัดไป</em></> : <>FIND YOUR<br /><em>NEXT MOVE.</em></>}</h1>
          <p>{tr("Watch it. Break it down. Make it yours.", "ดูให้ครบ แยกท่า แล้วเต้นในแบบของคุณ")}</p>
          <div className="welcome-actions">
            <button className="welcome-cta" type="button" onClick={() => navigate("random")}>{tr("Random Dance", "สุ่มเต้น")}</button>
            <button className="welcome-secondary" type="button" onClick={() => navigate("practice")}>{tr("Dance Practice", "ฝึกเต้น")}</button>
          </div>
        </div>
        <div className="welcome-art" aria-hidden={!heroVideo}>
          {heroVideo && <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={heroVideo.thumbnail} alt="" data-thumbnail-quality="maxresdefault"
              onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth < 300) {
                  fallbackHeroThumbnail(image, heroVideo.id);
                  return;
                }
                image.parentElement?.style.setProperty("aspect-ratio", `${image.naturalWidth} / ${image.naturalHeight}`);
              }}
              onError={(event) => fallbackHeroThumbnail(event.currentTarget, heroVideo.id)} />
            <button className="hero-play" type="button" aria-label={`Play ${heroVideo.title}`} onClick={() => play(heroVideo, null)}>▶</button>
            <span className="hero-stamp">100%<br />YOUR VIBE</span>

          </>}
        </div>
      </section>
      <div className="ticker" aria-label="Muverse motto"><span>LESS SCROLLING. MORE DANCING.　 ✦　 REWIND. REPEAT. RELEASE.　 ✦　 FIND YOUR FREQUENCY.</span></div>
      {visits.loaded && visits.entries.length > 0 && <>
        <section className="home-collections jump-back-in" aria-labelledby="jump-back-in-title">
          <div className="section-heading"><div><h2 id="jump-back-in-title">{tr("JUMP BACK IN", "เล่นต่อ")}</h2></div></div>
          <div className="jump-cards">
            {visits.entries.slice(0, 6).map(({ video, playCount }) => <article className="jump-card" key={video.id}>
              <button className="jump-card-main" type="button" onClick={() => play(video, null)} aria-label={`Play ${video.title}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={video.thumbnail} alt="" />
                <span><strong className="youtube-origin">{video.title}</strong><small className="youtube-origin">{video.channel || "Dance video"}</small></span>
              </button>
              <span className="jump-count" title={`Opened ${playCount} times`}>▶ {playCount}</span>
            </article>)}
          </div>
        </section>
        <section className="home-collections on-repeat" aria-labelledby="on-repeat-title">
          <div className="section-heading"><div><h2 id="on-repeat-title">{tr("ON REPEAT", "เล่นซ้ำ")}</h2></div></div>
          <div className="home-cards" ref={repeatTrackRef}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            repeatDragRef.current = { startX:event.clientX, startScrollLeft:event.currentTarget.scrollLeft, moved:false };
          }}
          onMouseMove={(event) => {
            const drag = repeatDragRef.current;
            if (!drag) return;
            if (event.buttons !== 1) { repeatDragRef.current = null; return; }
            const distance = event.clientX - drag.startX;
            if (Math.abs(distance) > 4) drag.moved = true;
            if (drag.moved) event.currentTarget.scrollLeft = drag.startScrollLeft - distance;
          }}
          onMouseUp={() => {
            if (repeatDragRef.current?.moved) {
              suppressRepeatClick.current = true;
              window.setTimeout(() => { suppressRepeatClick.current = false; }, 0);
            }
            repeatDragRef.current = null;
          }}
          onMouseLeave={() => {
            if (repeatDragRef.current?.moved) {
              suppressRepeatClick.current = true;
              window.setTimeout(() => { suppressRepeatClick.current = false; }, 0);
            }
            repeatDragRef.current = null;
          }}
          onClickCapture={(event) => {
            if (!suppressRepeatClick.current) return;
            event.preventDefault();
            event.stopPropagation();
            suppressRepeatClick.current = false;
          }}
          onDragStart={(event) => event.preventDefault()}>
            {repeatEntries.slice(0, 8).map(({ video, playCount }) => <article className="repeat-card" key={video.id}>
              <button className="repeat-card-play" type="button" onClick={() => play(video, null)} aria-label={`Play ${video.title}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={video.thumbnail} alt="" onLoad={(event) => {
                  const image = event.currentTarget;
                  if (image.naturalWidth && image.naturalHeight) {
                    image.parentElement?.style.setProperty("aspect-ratio", `${image.naturalWidth} / ${image.naturalHeight}`);
                  }
                }} />
                <i aria-hidden="true">▶</i>
              </button>
              <div className="repeat-card-meta"><strong className="youtube-origin" title={video.title}>{video.title}</strong><small><span className="youtube-origin">{video.channel || "Dance video"}</span> · {playCount} {playCount === 1 ? tr("play", "ครั้ง") : tr("plays", "ครั้ง")}</small></div>
              <HeartButton liked={pl.likedIds.has(video.id)} onClick={() => pl.toggleLike(video)} size={23} />
            </article>)}
          </div>
        </section>
      </>}
      <section className="home-collections break-it-down" aria-labelledby="break-it-down-title">
        <div className="section-heading"><h2 id="break-it-down-title">{tr("BREAK IT DOWN.", "แยกท่าเต้น")}</h2></div>
        <div className="breakdown-options">
          <button className="breakdown-option groove" type="button" onClick={() => navigate("practice")}>{tr("Find your groove", "หาจังหวะของคุณ")}</button>
          <button className="breakdown-option chorus" type="button" onClick={() => navigate("practice")}>{tr("Learn the chorus", "ฝึกท่อนฮุก")}</button>
          <button className="breakdown-option challenge" type="button" onClick={() => navigate("random")}>{tr("Challenge yourself", "ท้าทายตัวเอง")}</button>
        </div>
      </section>
      <section className="home-collections next-mixtape" aria-labelledby="next-mixtape-title">
        <div className="section-heading"><h2 id="next-mixtape-title">{tr("YOUR NEXT MIXTAPE.", "มิกซ์เทปของคุณ")}</h2><button className="view-playlists" type="button" onClick={() => navigate("playlists")}>{tr("View playlists", "ดูเพลย์ลิสต์")} <span aria-hidden="true">→</span></button></div>
        <div className="next-mixtape-cards">
          {pl.playlists.filter((playlist) => playlist.items.length > 0).slice(0, 3).map((playlist) => {
            const cover = playlist.cover ?? playlist.items[0]?.thumbnail;
            return <button key={playlist.id} className="home-playlist-card" type="button" onClick={() => { setSelectedId(playlist.id); navigate("playlists"); }}>
              {cover && <img src={cover} alt="" loading="lazy" />}
              {playlist.id === "liked" && <span className="playlist-favorite-pin">📌 {tr("Pinned favorite", "รายการโปรด")}</span>}
              <span className="playlist-card-caption" style={{ backgroundColor: playlist.color ?? (playlist.id === "liked" ? DEFAULT_LIKED_COLOR : DEFAULT_PLAYLIST_COLOR) }}><strong>{playlist.id === "liked" ? "Liked clips" : playlist.name}</strong><small>{playlist.id === "liked" ? tr("Your saved favorites", "คลิปโปรดที่บันทึกไว้") : `${playlist.items.length} ${tr("clips · Private", "คลิป · ส่วนตัว")}`}</small></span>
              <i aria-hidden="true">{playlist.id === "liked" ? "♥" : playlist.icon ?? DEFAULT_PLAYLIST_ICON}</i>
            </button>;
          })}
          {!pl.playlists.some((playlist) => playlist.items.length > 0) && <button className="create-mixtape" type="button" onClick={() => navigate("playlists")}>{tr("Create your first playlist", "สร้างเพลย์ลิสต์แรกของคุณ")} <span aria-hidden="true">→</span></button>}
        </div>
      </section>
      <section className="home-collections discover-more" aria-labelledby="discover-more-title">
        <div className="section-heading"><h2 id="discover-more-title">{tr("DISCOVER MORE", "ค้นพบเพิ่มเติม")}</h2></div>
        {discoverVideos.length > 0 ? <div className="home-cards">
          {discoverVideos.map((video) => <article className="repeat-card" key={video.id}>
            <button className="repeat-card-play" type="button" onClick={() => play(video, null)} aria-label={`Play ${video.title}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={video.thumbnail} alt="" loading="lazy" onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth && image.naturalHeight) {
                  image.parentElement?.style.setProperty("aspect-ratio", `${image.naturalWidth} / ${image.naturalHeight}`);
                }
              }} />
              <i aria-hidden="true">▶</i>
            </button>
            <div className="repeat-card-meta"><strong className="youtube-origin" title={video.title}>{video.title}</strong><small className="youtube-origin">{video.channel || "Dance video"}</small></div>
            <HeartButton liked={pl.likedIds.has(video.id)} onClick={() => pl.toggleLike(video)} size={23} />
          </article>)}
        </div> : <p className="discover-empty">{tr("Search for a dance clip above and it will be ready to play here.", "ค้นหาคลิปเต้นด้านบน แล้วคลิปจะแสดงที่นี่")}</p>}
      </section>
      </>}

      {current && ((activeView === "practice" && !practiceSearchMode) || (activeView === "random" && !randomPickerMode)) && (
        <section id="practice" className={`current-video ${activeView === "random" ? "random-player" : ""}`}>
          <div className="practice-layout">
          <div className="player-column"><YouTubePlayer
            language={displayLanguage}
            videoId={current.id}
            showAnalysisTools={!isTutorial}
            onEnded={() => step(1, false)}
            enableFocusRange={randomDanceSessionActive}
            focusRange={focusRange}
            onFocusRangeEnd={() => step(1, false)}
            loopOne={!!source && mode === "single"}
            highlights={auto.segments}
            onHighlightsChange={auto.saveEdits}
            videoFooter={
              <div className="video-footer-actions">
                <button type="button" onClick={() => addToPlaylist(current)}>+ playlist</button>
                <HeartButton liked={pl.likedIds.has(current.id)} onClick={() => pl.toggleLike(current)} />
                {source && <>
                  <button type="button" onClick={() => step(-1, false)}>⏮ ก่อนหน้า</button>
                  <button type="button" onClick={() => step(1, false)}>ถัดไป ⏭</button>
                  <small className="video-source-note">กำลังเล่นจาก “{source.name}”</small>
                  <span className={"play-mode-pill " + (mode === "random-dance" ? "is-random" : "")}>{mode === "random-dance" ? tr("RANDOM DANCE", "สุ่มเต้น") : th ? ({ sequential: "วนซ้ำแบบเรียง", shuffle: "วนซ้ำแบบสุ่ม", single: "วนซ้ำคลิปเดียว" } as const)[mode] : ({ sequential: "Repeat in order", shuffle: "Shuffle repeat", single: "Repeat one" } as const)[mode]}</span>
                </>}
              </div>
            }
            videoInfo={<VideoInfo videoId={current.id} fallbackTitle={current.title} fallbackChannel={current.channel} language={displayLanguage} />}
          /></div>
          </div>
          {!isTutorial && <>
          {auto.status === "loading" && <p className="highlight-processing" role="status"><span className="status-pulse" /> กำลังประมวลผลเพื่อแสดงไฮไลท์อัตโนมัติ…</p>}
          {["queued", "busy"].includes(auto.audioStatus ?? "") && <p><small>กำลังรอคิววิเคราะห์เสียง สามารถเล่นคลิปต่อได้…</small></p>}
          {auto.audioStatus === "downloading" && <p><small>กำลังเตรียมเสียงของคลิปนี้…</small></p>}
          {auto.audioStatus === "decoding" && <p><small>กำลังอ่านไฟล์เสียงของคลิปนี้…</small></p>}
          {auto.audioStatus === "separating" && <p><small>กำลังแยกเสียงร้องและเครื่องดนตรี ขั้นตอนนี้ใช้ CPU มาก…</small></p>}
          {auto.audioStatus === "features" && <p><small>กำลังเตรียมข้อมูลเสียงสำหรับวิเคราะห์…</small></p>}
          {auto.audioStatus === "loading-model" && <p><small>กำลังโหลดโมเดลวิเคราะห์เสียง…</small></p>}
          {auto.audioStatus === "analyzing" && <p><small>กำลังวิเคราะห์เสียงของคลิปนี้ สามารถเล่นคลิปต่อได้…</small></p>}
          {auto.audioStatus === "timeout" && <p><small>วิเคราะห์เสียงใช้เวลานานเกินไป{auto.audioStage === "separating" ? "ในขั้นแยกเสียง" : ""} หยุดรอแล้วและใช้ข้อมูลไฮไลท์จากระบบเดิม</small></p>}
          {auto.audioStatus === "failed" && <p><small>{AUDIO_FAILURE_REASON[auto.audioFailure ?? ""] ?? "วิเคราะห์เสียงของคลิปนี้ไม่ได้"} · ใช้ข้อมูลไฮไลท์จากระบบเดิม</small></p>}
          {auto.status === "none" && !["failed", "timeout"].includes(auto.audioStatus ?? "") && <small>{NO_HIGHLIGHT_REASON[auto.reason ?? ""] ?? NO_HIGHLIGHT_REASON.default}</small>}
          {auto.status === "error" && <small>วิเคราะห์ท่อนฮุคไม่สำเร็จ: {auto.reason}</small>}
          </>}
        </section>
      )}

      {activeView === "account" && <>
        <section className="account-page" aria-labelledby="account-title">
          <div className="account-art" aria-hidden="true">
            <img src="/account-art.png" alt="" />
          </div>
          <div className="account-panel">
            <span className="eyebrow">MUVERSE ACCOUNT</span>
            <h1 id="account-title">{accountMode === "create" ? tr("JOIN THE DANCE.", "มาร่วมเต้นกัน") : accountMode === "reset" ? tr("RESET PASSWORD.", "ตั้งรหัสผ่านใหม่") : tr("WELCOME BACK.", "ยินดีต้อนรับกลับ")}</h1>
            <p>{accountMode === "create" ? tr("Create an account to keep your favorite clips and practice sessions in one place.", "สร้างบัญชีเพื่อเก็บคลิปโปรดและเซสชันฝึกเต้นไว้ในที่เดียว") : accountMode === "reset" ? tr("Enter your email and we’ll help you get back into your account.", "กรอกอีเมลเพื่อกู้คืนการเข้าใช้บัญชี") : tr("Keep your favorite clips and practice sessions in one place.", "เก็บคลิปโปรดและเซสชันฝึกเต้นไว้ในที่เดียว")}</p>
            <form className="account-form" onSubmit={(event) => { event.preventDefault(); setAccountNotice("Account sign-in is not connected to an authentication service yet."); }}>
              <label className="sr-only" htmlFor="account-email">{tr("Email", "อีเมล")}</label>
              <input id="account-email" type="email" autoComplete="email" placeholder={tr("Email", "อีเมล")} required />
              {accountMode !== "reset" && <><label className="sr-only" htmlFor="account-password">{tr("Password", "รหัสผ่าน")}</label><input id="account-password" type="password" autoComplete={accountMode === "create" ? "new-password" : "current-password"} placeholder={tr("Password", "รหัสผ่าน")} required /></>}
              {accountMode === "login" && <button className="account-link account-forgot" type="button" onClick={() => { setAccountMode("reset"); setAccountNotice(""); }}>{tr("Forgot password?", "ลืมรหัสผ่าน?")}</button>}
              <button className="account-submit" type="submit">{accountMode === "create" ? tr("Create account", "สร้างบัญชี") : accountMode === "reset" ? tr("Send reset link", "ส่งลิงก์ตั้งรหัสผ่านใหม่") : tr("Log in", "เข้าสู่ระบบ")}</button>
            </form>
            <div className="account-divider"><span />{accountMode === "reset" ? tr("or return to log in", "หรือกลับไปเข้าสู่ระบบ") : tr("or log in with", "หรือเข้าสู่ระบบด้วย")}<span /></div>
            {accountMode !== "reset" && <button className="account-google" type="button" onClick={() => setAccountNotice("Google sign-in is not connected to an authentication service yet.")}><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 20.1H42V20H24v8h11.3A12 12 0 0 1 24 36a12 12 0 1 1 8-20.9l5.7-5.7A20 20 0 1 0 44 24c0-1.3-.1-2.6-.4-3.9Z"/><path fill="#34A853" d="M6.3 14.7 13 19.6A12 12 0 0 1 32 15l5.7-5.7A20 20 0 0 0 6.3 14.7Z"/><path fill="#FBBC05" d="M24 44c5.4 0 10.3-2 13.7-5.4l-6.3-5.3A12 12 0 0 1 13 28.4l-6.8 5.2A20 20 0 0 0 24 44Z"/><path fill="#EA4335" d="M6.2 33.6 13 28.4a12 12 0 0 1 0-8.8l-6.7-4.9a20 20 0 0 0-.1 18.9Z"/></svg>Continue with Google</button>}
            <button className="account-create" type="button" onClick={() => { setAccountMode(accountMode === "login" ? "create" : "login"); setAccountNotice(""); }}>{accountMode === "login" ? tr("Create an account", "สร้างบัญชี") : tr("Back to log in", "กลับไปเข้าสู่ระบบ")}</button>
            {accountMode === "reset" && <button className="account-link account-back" type="button" onClick={() => { setAccountMode("login"); setAccountNotice(""); }}>{tr("Back to log in", "กลับไปเข้าสู่ระบบ")}</button>}
            {accountNotice && <p className="account-notice" role="status">{accountNotice}</p>}
          </div>
        </section>
      </>}

      {activeView === "random" && randomPickerMode && !playlistDetailOpen && <section className="random-landing content-section">
        <div className="random-landing-heading">
          <span className="eyebrow">{tr("THE NONSTOP DANCE FLOOR", "แดนซ์ฟลอร์เต้นไม่หยุด")}</span>
          <h1>{tr("RANDOM DANCE.", "เต้นแบบสุ่ม")}</h1>
          <p>{tr("Choose a playlist to start your random dance session.", "เลือกเพลย์ลิสต์เพื่อเริ่มเซสชันเต้นแบบสุ่ม")}</p>
        </div>
        <div className="random-section-heading">
          <h2>{tr("My Playlists", "เพลย์ลิสต์ของฉัน")}</h2>
          <button type="button" className="random-view-all" onClick={() => navigate("playlists")}>{tr("View all", "ดูทั้งหมด")} <span aria-hidden="true">→</span></button>
        </div>
        <div className="random-playlist-grid">
          {pl.playlists.filter((playlist) => playlist.items.length > 0).slice(0, 3).map((playlist, index) => {
            const cover = playlist.cover ?? playlist.items[0]?.thumbnail;
            const accent = playlist.color ?? ["#b99aff", "#c9ff25", "#ff7738"][index % 3];
            return <article className="random-playlist-card" key={playlist.id} style={{ "--random-card-accent": accent } as CSSProperties}>
              <div className="random-playlist-copy">
                <h3>{playlist.name}</h3>
                <p>{tr("Playlist · Highlights", "เพลย์ลิสต์ · ไฮไลท์")}</p>
                <div className="random-playlist-actions">
                  <button type="button" className="random-start-button" onClick={() => startRandomPlaylist(playlist)}><span aria-hidden="true">▶</span> {tr("Start", "เริ่ม")}</button>
                  <button type="button" className="random-list-button" onClick={() => openRandomPlaylist(playlist)} aria-label={`${tr("Open", "เปิด")} ${playlist.name}`} title={tr("Open playlist", "เปิดเพลย์ลิสต์")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18" cy="18" r="3"/><path d="M18 16.5v3M16.5 18h3"/></svg></button>
                </div>
              </div>
              {cover && <button type="button" className="random-playlist-cover" onClick={() => startRandomPlaylist(playlist)} aria-label={`${tr("Start", "เริ่ม")} ${playlist.name}`}><img src={cover} alt="" /></button>}
            </article>;
          })}
          {!pl.playlists.some((playlist) => playlist.items.length > 0) && <p className="random-empty">{tr("Add clips to a playlist to start a Random Dance session.", "เพิ่มคลิปลงเพลย์ลิสต์เพื่อเริ่มเซสชันเต้นแบบสุ่ม")}</p>}
        </div>
        <div className="random-section-heading random-recommended-heading"><h2>{tr("Recommended", "แนะนำ")}</h2></div>
        <div className="random-playlist-grid random-recommended-grid">
          {[
            { id: "recommended:trending", name: tr("Trending", "กำลังมาแรง"), subtitle: tr("Trending dance clips", "คลิปเต้นที่กำลังมาแรง") },
            { id: "recommended:tpop", name: "T-pop", subtitle: tr("T-pop dance clips", "คลิปเต้นเพลง T-pop") },
            { id: "recommended:kpop-mix", name: "K-pop Mix", subtitle: tr("K-pop dance clips", "คลิปเต้น K-pop") },
          ].map((recommendation) => {
            const playlist = BUILT_IN_RECOMMENDED.find((item) => item.id === recommendation.id)!;
            const cover = playlist.items[0]?.thumbnail;
            return <article className="random-playlist-card" key={recommendation.id} style={{ "--random-card-accent": playlist.color } as CSSProperties}>
              <div className="random-playlist-copy"><h3>{recommendation.name}</h3><p>{recommendation.subtitle}</p><div className="random-playlist-actions">
                <button type="button" className="random-start-button" onClick={() => startRandomPlaylist(playlist)}><span aria-hidden="true">▶</span> {tr("Start", "เริ่ม")}</button>
                <button type="button" className="random-list-button" onClick={() => openRandomPlaylist(playlist)} aria-label={`${tr("Open", "เปิด")} ${recommendation.name}`} title={tr("Open playlist", "เปิดเพลย์ลิสต์")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18" cy="18" r="3"/><path d="M18 16.5v3M16.5 18h3"/></svg></button>
              </div></div>{cover && <button type="button" className="random-playlist-cover" onClick={() => startRandomPlaylist(playlist)} aria-label={`${tr("Start", "เริ่ม")} ${recommendation.name}`}><img src={cover} alt="" /></button>}
            </article>;
          })}
        </div>
      </section>}

      {(activeView === "playlists" || (activeView === "random" && playlistDetailOpen)) && <section id="playlists" className="content-section playlist-section">
      <div className="section-heading"><div><span className="eyebrow">{activeView === "random" ? tr("RANDOM DANCE", "สุ่มเต้น") : tr("YOUR COLLECTION", "คอลเลกชันของคุณ")}</span><h2>{activeView === "random" ? tr("Choose a Playlist", "เลือกเพลย์ลิสต์") : tr("My Playlists", "เพลย์ลิสต์ของฉัน")}</h2></div>{activeView === "random" ? <span className="section-side-note">{tr("Choose a playlist to start a Random Dance session.", "เลือกเพลย์ลิสต์เพื่อเริ่มเซสชันเต้นแบบสุ่ม")}</span> : <button className="playlist-create-trigger" type="button" onClick={() => setCreatePlaylistOpen(true)}>{tr("Create playlist", "สร้างเพลย์ลิสต์")}</button>}</div>
      <PlaylistPanel
        language={displayLanguage}
        key={`pl-${homeKey}-${activeView}`}
        playlists={pl.playlists}
        selected={selected}
        readOnly={!!selected?.id.startsWith("recommended:")}
        playingId={activeView === "random" ? undefined : current?.id}
        playingFromSelected={false}
        likedIds={pl.likedIds}
        onToggleLike={pl.toggleLike}
        mode={mode}
        onModeChange={(nextMode) => changeMode(nextMode, false)}
        onExitPlaylist={() => { if (activeView !== "random" && mode === "random-dance") changeMode("sequential"); }}
        onDetailOpenChange={setPlaylistDetailOpen}
        onPlayAll={playAll}
        onSelect={(id) => navigate(activeView === "random" ? "random" : "playlists", id)}
        onRename={pl.renamePlaylist}
        onSetAppearance={pl.setAppearance}
        onSetCover={pl.setCover}
        onDelete={pl.deletePlaylist}
        onPlay={(video) => {
          if (!selected) return;
          if (mode === "random-dance" &&
            (!readSavedHighlights(video.id)?.length || !readSavedFormations(video.id)?.length)) {
            window.alert("คลิปนี้ยังไม่มีผลไฮไลท์และฟอร์เมชันที่บันทึกครบ จึงข้ามในโหมด Random Dance");
            return;
          }
          if (mode === "random-dance") startSession(selected.id, video.id);
          else recordManual(selected.id, video.id);
          play(video, selected.id);
        }}
        onRemove={(videoId) => selected && pl.removeTrack(selected.id, videoId)}
        onMove={(index, dir) => selected && pl.moveTrack(selected.id, index, dir)}
      />
      {mode === "random-dance" && activeView === "random" && playlistDetailOpen && selected && <p className="random-status"><span className="status-pulse" /> {th ? `โหมดสุ่มเต้น: พร้อมเล่น ${randomDanceEligibleCount}/${selected.items.length} คลิปที่บันทึกไฮไลท์และฟอร์เมชันแล้ว · จะสุ่มให้ครบก่อนเริ่มวนรอบใหม่` : `Random Dance: ${randomDanceEligibleCount}/${selected.items.length} eligible clips · shuffled before repeating`}</p>}
      </section>}

      {activeView === "practice" && (practiceSearchMode || !current) && <section id="discover" className={`content-section discover-section${practiceSearchQuery !== null ? " has-practice-results" : ""}`}>
      <div className="section-heading"><div><span className="eyebrow">{tr("DISCOVER YOUR NEXT PRACTICE", "ค้นหาคลิปฝึกเต้นถัดไป")}</span><h2>{tr("Find a Dance Video", "ค้นหาวิดีโอเต้น")}</h2></div><span className="section-side-note">{tr("Search by song, artist, or dance move", "ค้นหาจากเพลง ศิลปิน หรือท่าเต้น")}</span></div>
      <div id="practice-search-results-host" />
      {!practiceSearchQuery && <p className="empty-practice">{tr("Choose a dance video to practice. Search above or open one of your playlists.", "เลือกวิดีโอเต้นเพื่อฝึก ค้นหาด้านบนหรือเปิดจากเพลย์ลิสต์ของคุณ")}</p>}
      </section>}

      {createPlaylistOpen && (
        <div className="playlist-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreatePlaylistOpen(false); }}>
          <form className="playlist-create-modal" role="dialog" aria-modal="true" aria-labelledby="create-playlist-title" onSubmit={(event) => {
            event.preventDefault();
            if (!createPlaylistName.trim()) return;
            pl.createPlaylist(createPlaylistName, { icon: newPlaylistIcon, color: newPlaylistColor, visibility: newPlaylistVisibility });
            setCreatePlaylistName("");
            setNewPlaylistIcon(DEFAULT_PLAYLIST_ICON);
            setNewPlaylistColor(DEFAULT_PLAYLIST_COLOR);
            setNewPlaylistVisibility("private");
            setIconPickerOpen(false);
            setCreatePlaylistOpen(false);
          }}>
            <button className="playlist-create-back" type="button" onClick={() => setCreatePlaylistOpen(false)} aria-label="Back">←</button>
            <h2 id="create-playlist-title">{tr("Make it yours.", "สร้างเพลย์ลิสต์ในแบบคุณ")}</h2>
            <p>{tr("Give your playlist an icon and a name.", "เลือกไอคอนและตั้งชื่อเพลย์ลิสต์")}</p>
            <div className="playlist-create-name">
              <button className="playlist-icon-current" type="button" aria-label={tr("Choose playlist icon", "เลือกไอคอนเพลย์ลิสต์")} aria-expanded={iconPickerOpen} onClick={() => setIconPickerOpen((open) => !open)}>{newPlaylistIcon}</button>
              <input autoFocus value={createPlaylistName} onChange={(event) => setCreatePlaylistName(event.target.value)} placeholder={tr("My next obsession", "เพลย์ลิสต์โปรดของฉัน")} aria-label={tr("Playlist name", "ชื่อเพลย์ลิสต์")} maxLength={60} />
            </div>
            {iconPickerOpen && <div className="playlist-icon-options" aria-label="Playlist icon options">{["✦", "♥", "ϟ", "♫", "★", "✿"].map((icon) => <button key={icon} type="button" className={icon === newPlaylistIcon ? "selected" : ""} aria-pressed={icon === newPlaylistIcon} onClick={() => { setNewPlaylistIcon(icon); setIconPickerOpen(false); }}>{icon}</button>)}</div>}
            <div className="playlist-create-colors" role="group" aria-label={tr("Playlist color", "สีเพลย์ลิสต์")}>
              <span>{tr("COLOR", "สี")}</span>
              {PLAYLIST_COLORS.map((color) => <button key={color} type="button" style={{ "--playlist-swatch": color } as CSSProperties} aria-label={color} aria-pressed={newPlaylistColor === color} onClick={() => setNewPlaylistColor(color)} />)}
            </div>
            <fieldset className="playlist-visibility"><legend>{tr("VISIBILITY", "การมองเห็น")}</legend><div>
              <button type="button" className={newPlaylistVisibility === "private" ? "selected" : ""} aria-pressed={newPlaylistVisibility === "private"} onClick={() => setNewPlaylistVisibility("private")}>{tr("Private", "ส่วนตัว")} {newPlaylistVisibility === "private" ? "✓" : ""}</button>
              <button type="button" className={newPlaylistVisibility === "public" ? "selected" : ""} aria-pressed={newPlaylistVisibility === "public"} onClick={() => setNewPlaylistVisibility("public")}>{tr("Public", "สาธารณะ")} {newPlaylistVisibility === "public" ? "✓" : ""}</button>
            </div></fieldset>
            <button className="playlist-create-submit" type="submit" disabled={!createPlaylistName.trim()}>{tr("Create playlist", "สร้างเพลย์ลิสต์")} →</button>
          </form>
        </div>
      )}

      {pendingAddVideo && (
        <div
          className="add-playlist-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingAddVideo(null); }}
        >
          <section className="add-playlist-dialog" role="dialog" aria-modal="true" aria-labelledby="add-playlist-title">
            <h2 id="add-playlist-title">เลือก playlist ปลายทาง</h2>
            <p>{pendingAddVideo.title}</p>
            <label>
              เลือก playlist ที่มีอยู่
              <select value={addDestinationId} onChange={(event) => { setAddDestinationId(event.target.value); setNewPlaylistName(""); }}>
                <option value="">เลือก playlist</option>
                {addablePlaylists.map((playlist) => (
                  <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
                ))}
                {playlistsAlreadyContainingVideo.map((playlist) => (
                  <option key={playlist.id} value={playlist.id} disabled style={{ color: "#999" }}>
                    {playlist.name} — อยู่ในเพลย์ลิสต์แล้ว
                  </option>
                ))}
              </select>
            </label>
            {addDestinationHasVideo && <small role="status">คลิปนี้อยู่ใน playlist นี้แล้ว</small>}
            <label>
              หรือสร้าง playlist ใหม่
              <input value={newPlaylistName} onChange={(event) => { setNewPlaylistName(event.target.value); if (event.target.value) setAddDestinationId(""); }} placeholder="ชื่อ playlist ใหม่" />
            </label>
            <div>
              <button type="button" onClick={() => setPendingAddVideo(null)}>ยกเลิก</button>
              <button type="button" onClick={confirmAddToPlaylist} disabled={!newPlaylistName.trim() && (!addDestinationId || addDestinationHasVideo)}>เพิ่มคลิป</button>
            </div>
          </section>
        </div>
      )}
      <nav className="bottom-nav" aria-label={tr("Main navigation", "เมนูหลัก")}>
        {([["home", tr("Home", "หน้าหลัก")], ["random", tr("Random Dance", "สุ่มเต้น")], ["practice", tr("Practice", "ฝึกเต้น")], ["playlists", tr("Playlists", "เพลย์ลิสต์")], ["account", tr("Account", "บัญชี")]] as const).map(([view, label]) => <button type="button" key={view} className={activeView === view ? "active" : ""} onClick={() => navigate(view)} aria-current={activeView === view ? "page" : undefined}><span aria-hidden="true"><NavIcon name={view} /></span><small>{label}</small></button>)}
      </nav>
    </main>
  );
}
