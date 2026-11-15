"use client";
// components/youtube-player.tsx
// เครื่องเล่น YouTube IFrame API พร้อมฟีเจอร์:
// เล่น/หยุด, Seekbar, แตะสองครั้งข้าม/ย้อน 10 วิ, ปรับเสียง (จำค่าไว้), กลับด้านซ้าย-ขวา,
// คีย์ลัด (Space / ← → / ↑ ↓), เต็มจอ

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { YT_STATE, formatTime, loadYouTubeApi, type YTEvent, type YTPlayer } from "@/lib/youtube";
import type { AutoSegment } from "@/lib/highlight-analysis";
import { readSavedFormations, readStageCalibration, saveFormations, saveStageCalibration,
  type FormationPoint as SavedFormationPoint, type FormationSnapshot as SavedFormationSnapshot, type StageCorner as SavedStageCorner } from "@/lib/analysis-storage";
import "./youtube-player.css";

interface Props {
  language?: string;
  videoId: string;
  showAnalysisTools?: boolean;
  autoPlay?: boolean;
  onEnded?: () => void;
  onError?: (code: number) => void; // รหัส error จาก YouTube (เช่น 101/150 = ฝังไม่ได้)
  loopOne?: boolean; // เล่นคลิปนี้ซ้ำไปเรื่อย ๆ: จบแล้วเริ่มใหม่เองและไม่เรียก onEnded
  highlights?: AutoSegment[]; // ท่อนยอดนิยมที่ระบบวิเคราะห์ให้ แสดงบนแถบกรอ (ว่าง = ไม่แสดง)
  onHighlightsChange?: (segments: AutoSegment[]) => void;
  enableFocusRange?: boolean; // อนุญาตให้โหมด Random Dance ข้าม/หยุดตามช่วงที่กำหนด
  focusRange?: { start: number; end: number; key: string };
  onFocusRangeEnd?: () => void;
  videoInfo?: ReactNode;
  videoFooter?: ReactNode;
}

const NO_HIGHLIGHTS: AutoSegment[] = [];
const WAVEFORM_BARS = Array.from({ length: 64 }, (_, index) =>
  Math.round(20 + Math.abs(Math.sin(index * 1.37) * Math.sin(index * 0.21 + 1)) * 76),
);

const SKIP_SECONDS = 10; // แตะสองครั้งบนจอ
const KEY_SKIP_SECONDS = 5; // ปุ่มลูกศรซ้าย/ขวา
const VOLUME_STEP = 5; // ปุ่มลูกศรขึ้น/ลง ต่อครั้ง (ปรับเลขนี้ได้)
const DEFAULT_VOLUME = 80;
const DOUBLE_TAP_MS = 280;
const IDLE_MS = 3000; // ไม่ขยับเมาส์นานเท่านี้ตอนเต็มจอ → ซ่อนทุกอย่างบนจอ
const VOLUME_KEY = "muverse:volume";
const RATE_KEY = "muverse:rate";
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// YouTube อาจคืนค่า undefined/NaN ก่อนวิดีโอโหลดเสร็จ จึงแปลงเป็น 0 เสมอ
const safe = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);
const clampVolume = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

// ช่องกรอกข้อความ: ห้ามดักคีย์ลัด ไม่งั้นพิมพ์ค้นหาไม่ได้ (เว้นวรรค/ลูกศรต้องใช้งานปกติ)
function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["range", "checkbox", "radio", "button", "submit", "reset"].includes(el.type);
  }
  return false;
}

type FlashState = { text: string; pos: "left" | "right" | "center" };
type HighlightDrag = { index: number; pointerId: number; edge: "start" | "end" | "move"; originX: number; start: number; end: number };
type HighlightRange = { index: number; start: number; end: number };
type FormationPoint = Omit<SavedFormationPoint, "color"> & { color: string };
type FormationSnapshot = SavedFormationSnapshot;
type StageCorner = SavedStageCorner;
const FORMATION_COLORS = ["#ffe600", "#ff5b9a", "#4de1ff", "#a78bfa", "#ff9f43", "#68e39a", "#ff6b6b", "#5eead4", "#c084fc", "#facc15"];
const DEFAULT_CALIBRATION: StageCorner[] = [
  { x: 0.18, y: 0.34 }, { x: 0.82, y: 0.34 },
  { x: 0.82, y: 0.82 }, { x: 0.18, y: 0.82 },
];

export default function YouTubePlayer({ language = "English", videoId, showAnalysisTools = true, autoPlay = true, onEnded, onError, loopOne = false, highlights = NO_HIGHLIGHTS,
  onHighlightsChange, enableFocusRange = false, focusRange, onFocusRangeEnd, videoInfo, videoFooter }: Props) {
  const th = language === "ไทย";
  const tr = (english: string, thai: string) => th ? thai : english;
  const languageRef = useRef(language);
  useEffect(() => { languageRef.current = language; }, [language]);
  const rootRef = useRef<HTMLDivElement>(null);
  const waveformTrackRef = useRef<HTMLDivElement>(null);
  const highlightDragRef = useRef<HighlightDrag | null>(null);
  const highlightRangeRef = useRef<HighlightRange | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const videoIdRef = useRef(videoId);
  const loadedIdRef = useRef<string | null>(null);
  const onEndedRef = useRef(onEnded);
  const loopOneRef = useRef(loopOne);
  const hlRef = useRef(highlights);
  const activeHlRef = useRef<number | null>(null);
  const loopHlRef = useRef(false);
  const [activeHl, setActiveHl] = useState<number | null>(null); // ท่อนที่ผู้ใช้เลือกอยู่
  const [loopHl, setLoopHl] = useState(false); // วนซ้ำเฉพาะท่อนที่เลือก
  const [highlightRangePreview, setHighlightRangePreview] = useState<HighlightRange | null>(null);
  const [showPracticePanel, setShowPracticePanel] = useState(true);

  const onErrorRef = useRef(onError);
  const playingRef = useRef(false);
  const focusEndRef = useRef(onFocusRangeEnd);
  const focusRangeRef = useRef(focusRange);
  // Keep the active range in sync during render so a stale Random Dance range
  // cannot pause a clip after the parent has left that mode.
  focusRangeRef.current = enableFocusRange ? focusRange : undefined;
  const focusEndHandledRef = useRef(false);
  const loadedFocusKeyRef = useRef("");
  const countdownAudioRef = useRef<AudioContext | null>(null);
  const rateRef = useRef(1);
  const volumeRef = useRef(DEFAULT_VOLUME); // ค่าเสียงล่าสุด ใช้ได้ใน callback ของ YouTube โดยไม่ติดค่าเก่า
  const lastTap = useRef<{ side: "left" | "right"; at: number; timer?: number } | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [focusCountdown, setFocusCountdown] = useState<number | null>(null);
  const [seeking, setSeeking] = useState(false);

  // Beep once whenever the visible Random Dance countdown changes (3, 2, 1).
  useEffect(() => {
    if (focusCountdown === null) return;
    let cancelled = false;

    const playCountdownBeep = async () => {
      try {
        const context = countdownAudioRef.current ?? new AudioContext();
        countdownAudioRef.current = context;
        if (context.state === "suspended") await context.resume();
        if (cancelled) return;

        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const now = context.currentTime;
        const pitch = focusCountdown === 1 ? 1046 : focusCountdown === 2 ? 880 : 740;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(pitch, now);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(now + 0.21);
      } catch {
        // Browser audio policy may block the synthesized beep; playback continues normally.
      }
    };

    void playCountdownBeep();
    return () => { cancelled = true; };
  }, [focusCountdown]);
  const [volume, setVolume] = useState(DEFAULT_VOLUME);
  const [mirrored, setMirrored] = useState(false);
  const [flash, setFlash] = useState<FlashState | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rate, setRate] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const formationAbortRef = useRef<AbortController | null>(null);
  const [formationStatus, setFormationStatus] = useState<"off" | "loading" | "running" | "ready" | "error">("off");
  const [formationError, setFormationError] = useState<string | null>(null);
  const [formationPoints, setFormationPoints] = useState<FormationPoint[]>([]);
  const [formationTimeline, setFormationTimeline] = useState<FormationSnapshot[]>([]);
  const [formationStage, setFormationStage] = useState<string | null>(null);
  const [calibrationArmed, setCalibrationArmed] = useState(false);
  const [calibrationDraft, setCalibrationDraft] = useState<StageCorner[]>([]);
  const [stageCorners, setStageCorners] = useState<StageCorner[]>([]);
  const [editingFormation, setEditingFormation] = useState(false);
  const [selectedFormationIndex, setSelectedFormationIndex] = useState(0);
  const [formationDirty, setFormationDirty] = useState(false);
  const draggingPointRef = useRef<number | null>(null);
  const draggingCornerRef = useRef<number | null>(null);

  useEffect(() => {
    onEndedRef.current = onEnded;
    onErrorRef.current = onError;
    loopOneRef.current = loopOne;
    focusEndRef.current = onFocusRangeEnd;
    hlRef.current = highlights;
    activeHlRef.current = activeHl;
    loopHlRef.current = loopHl;
  }, [onEnded, onError, loopOne, highlights, activeHl, loopHl, focusRange, onFocusRangeEnd]);

  // เปลี่ยนคลิป: ล้างท่อนที่เลือกไว้
  useEffect(() => {
    setActiveHl(null);
    activeHlRef.current = null;
    loopHlRef.current = false;
    setLoopHl(false);
    highlightDragRef.current = null;
    highlightRangeRef.current = null;
    setHighlightRangePreview(null);
  }, [videoId]);

  useEffect(() => {
    if (activeHl === null && highlights.length > 0) setActiveHl(0);
    else if (activeHl !== null && activeHl >= highlights.length) setActiveHl(highlights.length ? highlights.length - 1 : null);
  }, [activeHl, highlights]);

  useEffect(() => {
    setFormationPoints([]);
    const saved = readSavedFormations(videoId);
    const corners = readStageCalibration(videoId);
    setFormationTimeline(saved ?? []);
    setFormationStatus(saved?.length ? "ready" : "off");
    setFormationStage(null);
    setFormationError(null);
    setCalibrationArmed(false);
    setCalibrationDraft([]);
    setStageCorners(corners ?? []);
    setEditingFormation(false);
    setFormationDirty(false);
    setSelectedFormationIndex(0);
    formationAbortRef.current?.abort();
    formationAbortRef.current = null;
  }, [videoId]);

  useEffect(() => {
    if (formationStatus !== "ready" || formationTimeline.length === 0) return;
    let snapshot: FormationSnapshot | undefined;
    let snapshotIndex = -1;
    for (let index = 0; index < formationTimeline.length; index++) {
      const item = formationTimeline[index];
      if (item.time > time) break;
      snapshot = item;
      snapshotIndex = index;
    }
    if (!editingFormation && snapshotIndex >= 0) setSelectedFormationIndex(snapshotIndex);
    setFormationPoints(snapshot?.points.map((point) => ({
      x: point.x,
      y: point.y,
      color: FORMATION_COLORS[point.color % FORMATION_COLORS.length],
      name: point.name,
      track_id: point.track_id,
    })) ?? []);
  }, [time, formationTimeline, formationStatus, editingFormation]);

  const showFlash = useCallback((text: string, pos: FlashState["pos"]) => {
    setFlash({ text, pos });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 600);
  }, []);

  // ใส่ค่าเสียงปัจจุบันให้ตัวเล่น (เรียกซ้ำได้ ไม่มีผลเสีย)
  const applyVolume = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    const v = volumeRef.current;
    p.setVolume(v);
    if (v === 0) p.mute();
    else p.unMute();
  }, []);

  // ปิดซับไตเติลของ YouTube (ซับอัตโนมัติ/ซับตามการตั้งค่าบัญชี) ซึ่ง cc_load_policy อย่างเดียวกันไม่ได้เสมอไป
  const hideCaptions = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      p.unloadModule("captions");
      p.unloadModule("cc");
    } catch {
      /* บางสถานะของตัวเล่นยังไม่รองรับ ลองใหม่ตอนเริ่มเล่น */
    }
  }, []);

  const applyRate = useCallback(() => {
    playerRef.current?.setPlaybackRate(rateRef.current);
  }, []);

  // อ่านค่าเสียงที่เคยตั้งไว้ (จำข้ามคลิปและข้ามการรีเฟรชหน้า)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VOLUME_KEY);
      if (saved !== null && Number.isFinite(Number(saved))) {
        const v = clampVolume(Number(saved));
        volumeRef.current = v;
        setVolume(v);
        applyVolume();
      }
      const savedRate = Number(window.localStorage.getItem(RATE_KEY));
      if (RATES.includes(savedRate)) {
        rateRef.current = savedRate;
        setRate(savedRate);
      }
    } catch {
      /* localStorage ใช้ไม่ได้ (เช่น โหมดส่วนตัว) ก็ใช้ค่าในหน่วยความจำต่อไป */
    }
  }, [applyVolume]);

  const changeVolume = useCallback(
    (next: number) => {
      const v = clampVolume(next);
      volumeRef.current = v;
      setVolume(v);
      try {
        window.localStorage.setItem(VOLUME_KEY, String(v));
      } catch {
        /* ignore */
      }
      applyVolume();
    },
    [applyVolume],
  );

  const changeRate = useCallback(
    (next: number) => {
      rateRef.current = next;
      setRate(next);
      try {
        window.localStorage.setItem(RATE_KEY, String(next));
      } catch {
        /* ignore */
      }
      applyRate();
    },
    [applyRate],
  );

  // สร้างเครื่องเล่นครั้งเดียว
  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi()
      .then(() => {
        if (cancelled || !hostRef.current || !window.YT) return;
        loadedIdRef.current = videoIdRef.current;
        const mount = document.createElement("div");
        hostRef.current.appendChild(mount);
        playerRef.current = new window.YT.Player(mount, {
          width: "100%",
          height: "100%",
          videoId: videoIdRef.current,
          playerVars: {
            autoplay: autoPlay ? 1 : 0,
            controls: 0, // ซ่อนตัวควบคุมของ YouTube ใช้ของเราแทน
            disablekb: 1,
            fs: 0,
            rel: 0,
            playsinline: 1,
            modestbranding: 1,
            iv_load_policy: 3,
            cc_load_policy: 0, // ไม่เปิดซับไตเติลของ YouTube
            start: Math.floor(focusRangeRef.current?.start ?? 0),
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              setReady(true);
              applyVolume();
              applyRate();
              hideCaptions();
              setDuration(safe(playerRef.current?.getDuration()));
            },
            onStateChange: (e: YTEvent) => {
              playingRef.current = e.data === YT_STATE.PLAYING;
              setPlaying(e.data === YT_STATE.PLAYING);
              if (e.data !== YT_STATE.PLAYING) setFocusCountdown(null);
              if (e.data === YT_STATE.PLAYING) {
                setDuration(safe(playerRef.current?.getDuration()));
                // YouTube บางครั้งรีเซ็ตเสียงตอนเริ่มคลิปใหม่ จึงใส่ค่าที่ผู้ใช้ตั้งไว้ซ้ำทุกครั้งที่เริ่มเล่น
                applyVolume();
                applyRate();
                hideCaptions();
              }
              if (e.data === YT_STATE.ENDED) {
                if (loopOneRef.current) {
                  // วนซ้ำคลิปเดียว: กลับไปต้นคลิปแล้วเล่นต่อ
                  playerRef.current?.seekTo(0, true);
                  playerRef.current?.playVideo();
                } else {
                  onEndedRef.current?.();
                }
              }
            },
            onError: (e: YTEvent) => {
              onErrorRef.current?.(e.data);
              if (e.data === 101 || e.data === 150) {
                setError(languageRef.current === "ไทย" ? "เจ้าของคลิปไม่อนุญาตให้เล่นนอก YouTube ลองเลือกคลิปอื่น" : "The video owner does not allow playback outside YouTube. Try another video.");
              } else if (e.data === 153) {
                setError(languageRef.current === "ไทย" ? "เบราว์เซอร์นี้ไม่ส่งข้อมูลต้นทางให้ YouTube ลองเปิดหน้านี้ใน Chrome หรือ Edge โดยตรง" : "This browser did not provide origin information to YouTube. Try opening this page directly in Chrome or Edge.");
              } else {
                setError(languageRef.current === "ไทย" ? `เล่นคลิปนี้ไม่ได้ (รหัส ${e.data}) ลองเลือกคลิปอื่น` : `This video cannot be played (error ${e.data}). Try another video.`);
              }
            },
          },
        });
      })
      .catch((err: Error) => setError(err.message));

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
      setReady(false);
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // เปลี่ยนคลิปเมื่อ videoId เปลี่ยน
  useEffect(() => {
    videoIdRef.current = videoId;
    if (!ready || !playerRef.current || loadedIdRef.current === videoId) return;
    loadedIdRef.current = videoId;
    setError(null);
    const startSeconds = focusRangeRef.current?.start ?? 0;
    focusEndHandledRef.current = false;
    setTime(startSeconds);
    setDuration(0);
    playerRef.current.loadVideoById({
      videoId,
      startSeconds,
    });
    applyVolume();
    applyRate();
    hideCaptions();
  }, [videoId, ready, applyVolume, applyRate, hideCaptions]);

  const focusRangeKey = enableFocusRange && focusRange ? `${focusRange.key}:${focusRange.start}:${focusRange.end}` : "";
  useEffect(() => {
    if (focusRangeKey) return;
    focusEndHandledRef.current = false;
    setFocusCountdown(null);
  }, [focusRangeKey]);

  useEffect(() => {
    const range = focusRangeRef.current;
    if (!ready || !enableFocusRange || !range || loadedFocusKeyRef.current === focusRangeKey) return;
    loadedFocusKeyRef.current = focusRangeKey;
    focusEndHandledRef.current = false;
    setTime(range.start);
    const player = playerRef.current;
    const currentTime = safe(player?.getCurrentTime());
    if (Math.abs(currentTime - range.start) > 1.5) {
      player?.loadVideoById({
        videoId: videoIdRef.current,
        startSeconds: range.start,
        });
    } else {
      player?.seekTo(range.start, true);
    }
    player?.playVideo();
  }, [focusRangeKey, ready, enableFocusRange]);

  // อัปเดตเวลาของ Seekbar ทุก 250ms
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p || seeking) return;
      const t = safe(p.getCurrentTime());
      setTime(t);
      setDuration(safe(p.getDuration()));

      const range = focusRangeRef.current;
      if (range && playingRef.current && !focusEndHandledRef.current && t >= range.end) {
        focusEndHandledRef.current = true;
        setFocusCountdown(null);
        p.pauseVideo();
        focusEndRef.current?.();
        return;
      }

      // แสดง 3–2–1 ในช่วงท้าย 3 วินาทีก่อนจบช่วง Random Dance
      const nextCountdown = range && playingRef.current && !focusEndHandledRef.current
        ? Math.ceil(range.end - t)
        : null;
      const visibleCountdown = nextCountdown !== null && nextCountdown >= 1 && nextCountdown <= 3
        ? nextCountdown
        : null;
      setFocusCountdown((current) => current === visibleCountdown ? current : visibleCountdown);

      // วนซ้ำเฉพาะท่อนที่เลือก: เล่นถึงท้ายท่อนแล้วกลับไปต้นท่อน (ถ้าผู้ใช้กรอข้ามไปไกลกว่านั้นเองจะไม่ดึงกลับ)
      const seg = activeHlRef.current !== null ? hlRef.current[activeHlRef.current] : undefined;
      if (loopHlRef.current && seg && playingRef.current && t >= seg.end - 0.1 && t < seg.end + 3) {
        p.seekTo(seg.start, true);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [ready, seeking]);

  // เลือกท่อน: กระโดดไปต้นท่อนแล้วเล่นเลย (กดซ้ำ = เริ่มท่อนใหม่ตั้งแต่ต้น)
  const selectHighlight = (i: number) => {
    const seg = highlights[i];
    const p = playerRef.current;
    if (!seg || !p) return;
    setActiveHl(i);
    p.seekTo(seg.start, true);
    setTime(seg.start);
    p.playVideo();
  };

  const beginHighlightDrag = (event: ReactPointerEvent<HTMLElement>, index: number, edge: HighlightDrag["edge"]) => {
    if (event.button !== 0 || !duration) return;
    const segment = highlights[index];
    if (!segment) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveHl(index);
    const range = highlightRangePreview?.index === index ? highlightRangePreview : { index, start: segment.start, end: segment.end };
    highlightDragRef.current = { index, pointerId: event.pointerId, edge, originX: event.clientX, start: range.start, end: range.end };
    highlightRangeRef.current = range;
    setHighlightRangePreview(range);
    try { waveformTrackRef.current?.setPointerCapture(event.pointerId); } catch { /* pointer capture may be unavailable in embedded browsers */ }
  };

  const moveHighlightDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = highlightDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !duration) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const innerWidth = Math.max(1, rect.width - 28);
    const delta = ((event.clientX - drag.originX) / innerWidth) * duration;
    const minGap = Math.min(0.5, duration);
    let start = drag.start;
    let end = drag.end;
    if (drag.edge === "move") {
      const length = end - start;
      start = Math.min(Math.max(0, drag.start + delta), Math.max(0, duration - length));
      end = start + length;
    } else if (drag.edge === "start") {
      start = Math.min(Math.max(0, drag.start + delta), Math.max(0, drag.end - minGap));
    } else {
      end = Math.max(Math.min(duration, drag.end + delta), Math.min(duration, drag.start + minGap));
    }
    const range = { index: drag.index, start, end };
    highlightRangeRef.current = range;
    setHighlightRangePreview(range);
  };

  const finishHighlightDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = highlightDragRef.current;
    const range = highlightRangeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    highlightDragRef.current = null;
    highlightRangeRef.current = null;
    setHighlightRangePreview(null);
    if (!range || (Math.abs(range.start - highlights[drag.index]?.start) < 0.05 && Math.abs(range.end - highlights[drag.index]?.end) < 0.05)) return;
    onHighlightsChange?.(highlights.map((segment, index) => index === drag.index ? { ...segment, start: range.start, end: range.end } : segment));
    setActiveHl(drag.index);
  };

  const cancelHighlightDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (highlightDragRef.current?.pointerId !== event.pointerId) return;
    highlightDragRef.current = null;
    highlightRangeRef.current = null;
    setHighlightRangePreview(null);
  };

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pauseVideo();
    else p.playVideo();
    showFlash(playing ? tr("⏸ Pause", "⏸ หยุด") : tr("▶ Play", "▶ เล่น"), "center");
  }, [playing, showFlash, language]);

  const skip = useCallback(
    (delta: number) => {
      const p = playerRef.current;
      if (!p) return;
      const max = safe(p.getDuration()) || Infinity;
      const next = Math.min(Math.max(safe(p.getCurrentTime()) + delta, 0), max);
      p.seekTo(next, true);
      setTime(next);
      showFlash(`${delta < 0 ? "−" : "+"}${Math.abs(delta)} ${tr("sec", "วิ")}`, delta < 0 ? "left" : "right");
    },
    [showFlash, language],
  );

  // ---- เต็มจอ ----
  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => void })
      | null;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    if (!el) return;
    const active = document.fullscreenElement ?? doc.webkitFullscreenElement;
    if (active) {
      (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
    } else {
      (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
    }
  }, []);

  useEffect(() => {
    const sync = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setIsFullscreen((document.fullscreenElement ?? doc.webkitFullscreenElement) === rootRef.current);
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // ---- เต็มจอ: ไม่ขยับเมาส์สักพัก → ซ่อนปุ่ม/แถบควบคุมทั้งหมด ขยับแล้วกลับมา ----
  useEffect(() => {
    if (!isFullscreen) {
      setIdle(false);
      setMenuOpen(false);
      return;
    }
    const wake = () => {
      setIdle(false);
      window.clearTimeout(idleTimer.current);
      if (!menuOpen) idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS); // เมนูเปิดอยู่ไม่ซ่อน
    };
    wake();
    const el = rootRef.current;
    el?.addEventListener("mousemove", wake);
    el?.addEventListener("pointerdown", wake);
    el?.addEventListener("touchstart", wake, { passive: true });
    window.addEventListener("keydown", wake);
    return () => {
      window.clearTimeout(idleTimer.current);
      el?.removeEventListener("mousemove", wake);
      el?.removeEventListener("pointerdown", wake);
      el?.removeEventListener("touchstart", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [isFullscreen, menuOpen]);

  // ---- คีย์ลัด ----
  useEffect(() => {
    if (!ready) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // ไม่ชนกับคีย์ลัดของเบราว์เซอร์
      if (isTextEntry(e.target)) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          if (!e.repeat) togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          skip(-KEY_SKIP_SECONDS);
          break;
        case "ArrowRight":
          e.preventDefault();
          skip(KEY_SKIP_SECONDS);
          break;
        case "ArrowUp":
          e.preventDefault();
          changeVolume(volumeRef.current + VOLUME_STEP);
          showFlash(`${tr("Volume", "เสียง")} ${volumeRef.current}%`, "center");
          break;
        case "ArrowDown":
          e.preventDefault();
          changeVolume(volumeRef.current - VOLUME_STEP);
          showFlash(`${tr("Volume", "เสียง")} ${volumeRef.current}%`, "center");
          break;
      }
    };

    // กันปุ่มที่โฟกัสอยู่ (เช่น ปุ่มผลลัพธ์ที่เพิ่งคลิก) ถูก "กด" ซ้ำตอนปล่อยปุ่มเว้นวรรค
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && !isTextEntry(e.target)) e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [ready, togglePlay, skip, changeVolume, showFlash, language]);

  // แตะครั้งเดียว = เล่น/หยุด, แตะสองครั้ง = ข้าม/ย้อน 10 วิ (ขวา = ข้าม, ซ้าย = ย้อน)
  const handleTap = (e: React.PointerEvent<HTMLDivElement>) => {
    if (menuOpen) {
      setMenuOpen(false); // แตะที่จอตอนเมนูเปิด = ปิดเมนูอย่างเดียว ไม่สลับเล่น/หยุด
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const side = e.clientX - rect.left < rect.width / 2 ? "left" : "right";
    const now = Date.now();
    const prev = lastTap.current;

    if (prev && prev.side === side && now - prev.at < DOUBLE_TAP_MS) {
      window.clearTimeout(prev.timer);
      lastTap.current = null;
      skip(side === "left" ? -SKIP_SECONDS : SKIP_SECONDS);
      return;
    }
    window.clearTimeout(prev?.timer);
    const timer = window.setTimeout(() => {
      lastTap.current = null;
      togglePlay();
    }, DOUBLE_TAP_MS);
    lastTap.current = { side, at: now, timer };
  };

  const updateFormationPoint = (pointIndex: number, patch: Partial<Omit<FormationPoint, "color">>) => {
    setFormationTimeline((timeline) => {
      const editedPoint = timeline[selectedFormationIndex]?.points[pointIndex];
      const isNameChange = Object.prototype.hasOwnProperty.call(patch, "name");
      if (isNameChange && editedPoint?.track_id !== undefined) {
        // A dancer keeps one track ID across the timeline, so one name edit
        // should label that dancer in every formation snapshot for this video.
        return timeline.map((snapshot) => ({
          ...snapshot,
          points: snapshot.points.map((point) => point.track_id === editedPoint.track_id
            ? { ...point, name: patch.name }
            : point),
        }));
      }
      return timeline.map((snapshot, index) => index !== selectedFormationIndex ? snapshot : {
        ...snapshot,
        points: snapshot.points.map((point, i) => i === pointIndex ? { ...point, ...patch } : point),
      });
    });
    setFormationDirty(true);
  };

  const moveFormationDot = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingPointRef.current === null || !editingFormation) return;
    const rect = e.currentTarget.getBoundingClientRect();
    updateFormationPoint(draggingPointRef.current, {
      x: mirrored ? 1 - Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    });
  };

  const activeFormation = formationTimeline[selectedFormationIndex];
  const activeFormationPoint = activeFormation?.points ?? [];
  const saveFormationEdits = () => {
    saveFormations(videoId, formationTimeline);
    setFormationDirty(false);
  };

  const commitSeek = () => {
    if (!seeking) return;
    playerRef.current?.seekTo(time, true);
    setSeeking(false);
  };

  const stopFormationAnalysis = useCallback(() => {
    formationAbortRef.current?.abort();
    formationAbortRef.current = null;
    setFormationStatus("off");
  }, []);

  const beginStageCalibration = useCallback(() => {
    // Calibration coordinates are measured against the video frame. Leave the
    // viewport-filling player first so letterboxing cannot shift the corners.
    if (document.fullscreenElement) void document.exitFullscreen();
    playerRef.current?.pauseVideo();
    setFormationError(null);
    // Edit a draft only. Existing calibration and analyzed formations remain
    // active until the user explicitly saves a replacement.
    const visibleCorners = stageCorners.length === 4
      ? (mirrored
        ? [stageCorners[1], stageCorners[0], stageCorners[3], stageCorners[2]].map((point) => ({ x: 1 - point.x, y: point.y }))
        : stageCorners.map((point) => ({ ...point })))
      : DEFAULT_CALIBRATION.map((point) => ({ ...point }));
    setCalibrationDraft(visibleCorners);
    setCalibrationArmed(true);
  }, [mirrored, stageCorners]);

  const moveCalibrationCorner = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!calibrationArmed || draggingCornerRef.current === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const point = {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
    setCalibrationDraft((draft) => draft.map((corner, index) => index === draggingCornerRef.current ? point : corner));
  };

  const cancelStageCalibration = () => {
    draggingCornerRef.current = null;
    setCalibrationArmed(false);
    setCalibrationDraft([]);
  };

  const saveStageCalibrationDraft = () => {
    if (calibrationDraft.length !== 4) return;
    const ordered = mirrored
      ? [calibrationDraft[1], calibrationDraft[0], calibrationDraft[3], calibrationDraft[2]]
      : calibrationDraft;
    const corners = ordered.map((point) => ({ x: mirrored ? 1 - point.x : point.x, y: point.y }));
    const changed = stageCorners.length !== 4 || corners.some((corner, index) =>
      Math.abs(corner.x - stageCorners[index].x) > 0.001 || Math.abs(corner.y - stageCorners[index].y) > 0.001);
    if (changed) {
      formationAbortRef.current?.abort();
      formationAbortRef.current = null;
      setFormationTimeline([]);
      setFormationPoints([]);
      setFormationDirty(false);
      setFormationStatus("off");
      saveFormations(videoId, []);
    }
    setStageCorners(corners);
    saveStageCalibration(videoId, corners);
    cancelStageCalibration();
  };

  const startFormationAnalysis = useCallback(async () => {
    if (stageCorners.length !== 4) {
      setFormationError(tr("Set all 4 floor corners first.", "ตั้งค่ามุมพื้นเวทีให้ครบ 4 จุดก่อน"));
      return;
    }
    formationAbortRef.current?.abort();
    const controller = new AbortController();
    formationAbortRef.current = controller;
    setFormationError(null);
    setFormationPoints([]);
    setFormationTimeline([]);
    setFormationStage("downloading");
    setFormationStatus("loading");
    try {
      let result: { status: string; stage?: string; reason?: string; formations?: FormationSnapshot[] };
      do {
        const response = await fetch(`/api/youtube/formations?v=${encodeURIComponent(videoId)}`, {
          method: "POST", cache: "no-store", signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stageCorners }),
        });
        result = await response.json();
        if (!response.ok && response.status !== 429) throw new Error(tr("Could not reach the video analysis service.", "ติดต่อระบบวิเคราะห์คลิปไม่ได้"));
        setFormationStage(result.stage ?? null);
        if (result.status === "processing" || result.status === "queued") setFormationStatus("running");
        if (result.status === "busy") throw new Error(tr("Another video is being analyzed. Try again later.", "มีคลิปอื่นกำลังวิเคราะห์อยู่ ลองอีกครั้งภายหลัง"));
        if (["processing", "queued"].includes(result.status)) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              window.clearTimeout(timer);
              reject(new DOMException("Cancelled", "AbortError"));
            };
            const timer = window.setTimeout(() => {
              controller.signal.removeEventListener("abort", onAbort);
              resolve();
            }, 2000);
            controller.signal.addEventListener("abort", onAbort, { once: true });
          });
        }
      } while (["processing", "queued"].includes(result.status) && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      if (result.status !== "ready") {
        const messages: Record<string, [string, string]> = {
          "worker-unavailable": ["Could not reach the Ubuntu analysis service.", "ติดต่อบริการวิเคราะห์ใน Ubuntu ไม่ได้"],
          "download-timeout": ["The video download timed out. Try again.", "รับวิดีโอไม่ทันเวลาที่กำหนด ลองใหม่อีกครั้ง"],
          "download-failed": ["Could not download the video for analysis.", "ดาวน์โหลดวิดีโอเพื่อวิเคราะห์ไม่สำเร็จ"],
          "download-rejected": ["This video is live, longer than 15 minutes, or unavailable for download from YouTube.", "คลิปนี้เป็นไลฟ์ คลิปยาวเกิน 15 นาที หรือ YouTube ไม่อนุญาตให้ดึงวิดีโอ"],
          "decode-failed": ["Could not read video frames. Check that FFmpeg is installed.", "อ่านเฟรมวิดีโอไม่สำเร็จ ตรวจว่าติดตั้ง FFmpeg แล้ว"],
          "dependency-missing": ["MediaPipe is not installed for formation analysis.", "ยังไม่ได้ติดตั้ง MediaPipe สำหรับวิเคราะห์แถว"],
          "tool-missing": ["FFmpeg was not found in Ubuntu.", "ไม่พบ FFmpeg ใน Ubuntu"],
          "invalid-stage-corners": ["The floor corners overlap or are out of order. Set all four again.", "มุมพื้นเวทีซ้อนกันหรือเรียงผิดลำดับ ลองตั้งค่า 4 มุมใหม่"],
        };
        const message = messages[result.reason ?? ""] ?? ["Formation analysis failed.", "วิเคราะห์แถวไม่สำเร็จ"];
        throw new Error(tr(message[0], message[1]));
      }
      const formations = result.formations ?? [];
      saveFormations(videoId, formations);
      setFormationTimeline(formations);
      setSelectedFormationIndex(0);
      setFormationDirty(false);
      setFormationStatus("ready");
    }
    catch (error) {
      if (controller.signal.aborted) return;
      setFormationError(error instanceof Error ? error.message : tr("Formation analysis failed.", "วิเคราะห์แถวไม่สำเร็จ"));
      setFormationStatus("error");
    }
  }, [stageCorners, videoId, language]);

  useEffect(() => () => stopFormationAnalysis(), [stopFormationAnalysis]);

  const settings = (
    <>
          <label>
            {tr("Volume", "เสียง")} {" "}
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
            />
          </label>

          <label>
            <input type="checkbox" checked={mirrored} onChange={(e) => setMirrored(e.target.checked)} /> {tr("Mirror", "กลับด้านซ้าย-ขว")}
          </label>

          <label>
            {tr("Speed", "ความเร็ว")} {" "}
            <select
              value={rate}
              disabled={!ready}
              onChange={(e) => {
                changeRate(Number(e.target.value));
                e.currentTarget.blur(); // คืนโฟกัสให้คีย์ลัดใช้ต่อได้
              }}
            >
              {RATES.map((r) => (
                <option key={r} value={r}>
                  {r === 1 ? tr("Normal", "ปกติ") : `${r}x`}
                </option>
              ))}
            </select>
          </label>

    </>
  );

  const selectedHighlight = activeHl === null ? undefined : highlights[activeHl];
  const activeHighlight = selectedHighlight && highlightRangePreview?.index === activeHl
    ? { ...selectedHighlight, start: highlightRangePreview.start, end: highlightRangePreview.end }
    : selectedHighlight;
  const seekPercent = duration > 0 ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0;
  const fullscreenHighlights = showAnalysisTools && (
    <section className="yp-fullscreen-highlights" aria-label={tr("Clip highlights", "ไฮไลท์คลิป")}>
      <div className="yp-highlight-heading">
        <strong>HIGHLIGHT / A–B</strong>
        <small>{tr("Auto highlights", "ไฮไลท์อัตโนมัติ")} · {highlights.length ? `${highlights.length} ${tr("saved", "รายการที่บันทึก")}` : tr("none saved", "ยังไม่มี")}</small>
      </div>
      <div className="yp-fullscreen-waveform" aria-hidden="true">
        {WAVEFORM_BARS.map((height, index) => {
          const at = (index / (WAVEFORM_BARS.length - 1)) * duration;
          const selected = !!activeHighlight && at >= activeHighlight.start && at <= activeHighlight.end;
          const automatic = highlights.some((segment) => at >= segment.start && at <= segment.end);
          return <span key={index} className={selected ? "is-selected" : automatic ? "is-auto" : ""} style={{ height: `${height}%` }} />;
        })}
      </div>
      <div className="yp-waveform-legend" aria-label={tr("Highlight color legend", "คำอธิบายสีไฮไลท์")}>
        <span><i className="is-auto" />{tr("Auto highlight", "ไฮไลท์อัตโนมัติ")}</span>
        <span><i className="is-selected" />{tr("Selected A–B", "ช่วงที่เลือก A–B")}</span>
      </div>
      {highlights.length > 0 && (
        <div className="yp-hls" role="group" aria-label={tr("Popular segments", "ท่อนยอดนิยม")}>
          {highlights.map((segment, index) => (
            <button key={`${segment.start}-${index}`} type="button" className="yp-hl-chip"
              aria-pressed={activeHl === index} onClick={() => selectHighlight(index)}>
              ▶ {formatTime(segment.start)}–{formatTime(segment.end)}
            </button>
          ))}
        </div>
      )}
      {activeHighlight && (
        <div className="yp-ab-range">
          <small>{tr("EDIT A–B · DRAG THE EDGES", "แก้ไข A–B · ลากขอบเพื่อปรับช่วง")}</small>
          <div className="yp-ab-values">
            <button type="button" aria-label={tr("Go to highlight start", "ไปยังจุดเริ่มของช่วงไฮไลท์")} onClick={() => { playerRef.current?.seekTo(activeHighlight.start, true); setTime(activeHighlight.start); }}>{formatTime(activeHighlight.start)}</button>
            <button type="button" aria-label={tr("Go to highlight end", "ไปยังจุดจบของช่วงไฮไลท์")} onClick={() => { playerRef.current?.seekTo(activeHighlight.end, true); setTime(activeHighlight.end); }}>{formatTime(activeHighlight.end)}</button>
          </div>
          <div className="yp-ab-labels"><span>{tr("A / START", "A / เริ่ม")}</span><span>{tr("B / END", "B / จบ")}</span></div>
        </div>
      )}
      {highlights.length > 0 && (
        <label className="yp-hl-loop">
          <input type="checkbox" checked={loopHl} disabled={activeHl === null} onChange={(event) => setLoopHl(event.target.checked)} />
          {" "}{tr("Loop selected range", "วนซ้ำท่อนที่เลือก")}
        </label>
      )}
      <HighlightEditor key={`fullscreen-highlight-editor-${videoId}`} highlights={highlights} duration={duration}
        currentTime={time} onSave={onHighlightsChange} language={language} />
    </section>
  );

  const controls = (
      <div className="yp-controls">
        <div className="yp-seek">
          <span>{formatTime(time)}</span>
          <div ref={waveformTrackRef} onPointerMove={moveHighlightDrag} onPointerUp={finishHighlightDrag} onPointerCancel={cancelHighlightDrag}
            className={`yp-track ${showAnalysisTools && !isFullscreen ? "yp-track--waveform" : ""}`}>
            {showAnalysisTools && !isFullscreen && duration > 0 && (
              <div className="yp-waveform-bars" aria-hidden="true">
                {WAVEFORM_BARS.map((height, index) => {
                  const barTime = (index / (WAVEFORM_BARS.length - 1)) * duration;
                  const selected = !!activeHighlight && barTime >= activeHighlight.start && barTime <= activeHighlight.end;
                  const automatic = highlights.some((segment) => barTime >= segment.start && barTime <= segment.end);
                  return <span key={index} className={selected ? "is-selected" : automatic ? "is-auto" : ""} style={{ height: `${height}%` }} />;
                })}
              </div>
            )}
            {showAnalysisTools && !isFullscreen && <span className="yp-wave-progress" aria-hidden="true">
              <span style={{ width: `${seekPercent}%` }} />
            </span>}
            {/* แถบสีบอกช่วงท่อนยอดนิยม (ไม่รับเมาส์ ให้คลิกกรอที่แถบกรอได้ตามปกติ) */}
            {showAnalysisTools && !isFullscreen && duration > 0 && highlights.length > 0 && (
              <div className="yp-hl-lane">
                {highlights.map((h, i) => {
                  const range = highlightRangePreview?.index === i ? highlightRangePreview : h;
                  return range.start < duration ? (
                    <span
                      key={`${h.start}-${i}`}
                      className={`yp-hl ${h.confidence === "high" ? "is-high" : ""} ${activeHl === i ? "is-active" : ""}`}
                      style={{
                        left: `${(range.start / duration) * 100}%`,
                        width: `${((Math.min(range.end, duration) - range.start) / duration) * 100}%`,
                      }}
                      title={tr(`${h.label} (${formatTime(range.start)}–${formatTime(range.end)}) · Drag the middle to move`, `${h.label} (${formatTime(range.start)}–${formatTime(range.end)}) · ลากตรงกลางเพื่อย้ายช่วง`)}
                      onPointerDown={!isFullscreen && activeHl === i ? (event) => beginHighlightDrag(event, i, "move") : undefined}
                    >
                      {!isFullscreen && activeHl === i && <>
                        <button type="button" className="yp-hl-handle yp-hl-handle--start" aria-label={tr("Drag to change highlight start", "ลากเพื่อเปลี่ยนเวลาเริ่มไฮไลท์")}
                          onPointerDown={(event) => beginHighlightDrag(event, i, "start")} />
                        <button type="button" className="yp-hl-handle yp-hl-handle--end" aria-label={tr("Drag to change highlight end", "ลากเพื่อเปลี่ยนเวลาจบไฮไลท์")}
                          onPointerDown={(event) => beginHighlightDrag(event, i, "end")} />
                      </>}
                    </span>
                  ) : null;
                })}
              </div>
            )}
            <input
              className={showAnalysisTools && !isFullscreen ? "yp-wave-seek" : ""}
              type="range"
              min={0}
              max={Math.max(duration, 1)}
              step={0.1}
              value={Math.min(time, Math.max(duration, 1))}
              disabled={!ready}
              aria-label={tr("Seek video", "กรอวิดีโอ")}
              onChange={(e) => {
                setSeeking(true);
                setTime(Number(e.target.value));
              }}
              onPointerUp={commitSeek}
            />
          </div>
          <span>{formatTime(duration)}</span>
        </div>

        {showAnalysisTools && !isFullscreen && <div className="yp-highlight-heading"><strong>HIGHLIGHT / A–B</strong><small>{tr("Auto highlights", "ไฮไลท์อัตโนมัติ")} · {highlights.length ? `${highlights.length} ${tr("saved", "รายการที่บันทึก")}` : tr("none saved", "ยังไม่มี")}</small></div>}

        {showAnalysisTools && !isFullscreen && highlights.length > 0 && (
          <div className="yp-waveform-legend" aria-label={tr("Highlight color legend", "คำอธิบายสีไฮไลท์")}>
            <span><i className="is-auto" />{tr("Auto highlight", "ไฮไลท์อัตโนมัติ")}</span>
            <span><i className="is-selected" />{tr("Selected A–B", "ช่วงที่เลือก A–B")}</span>
          </div>
        )}

        {showAnalysisTools && !isFullscreen && highlights.length > 0 && (
          <div className="yp-hls" role="group" aria-label={tr("Popular segments", "ท่อนยอดนิยม")} style={{ "--highlight-count": highlights.length } as React.CSSProperties}>
            {highlights.map((h, i) => (
              <button
                key={`${h.start}-${i}`}
                type="button"
                className="yp-hl-chip"
                aria-pressed={activeHl === i}
                onClick={(e) => {
                  selectHighlight(i);
                  e.currentTarget.blur(); // คืนโฟกัสให้คีย์ลัดใช้ต่อได้
                }}
              >
                ▶ {formatTime(h.start)}–{formatTime(h.end)}
              </button>
            ))}
          </div>
        )}

        {showAnalysisTools && !isFullscreen && activeHighlight && (
          <div className="yp-ab-range">
            <small>{tr("EDIT A–B · DRAG THE EDGES", "แก้ไข A–B · ลากขอบเพื่อปรับช่วง")}</small>
            <div className="yp-ab-values">
              <button type="button" aria-label={tr("Go to highlight start", "ไปยังจุดเริ่มของช่วงไฮไลท์")} onClick={() => { playerRef.current?.seekTo(activeHighlight.start, true); setTime(activeHighlight.start); }}>{formatTime(activeHighlight.start)}</button>
              <button type="button" aria-label={tr("Go to highlight end", "ไปยังจุดจบของช่วงไฮไลท์")} onClick={() => { playerRef.current?.seekTo(activeHighlight.end, true); setTime(activeHighlight.end); }}>{formatTime(activeHighlight.end)}</button>
            </div>
            <div className="yp-ab-labels"><span>{tr("A / START", "A / เริ่ม")}</span><span>{tr("B / END", "B / จบ")}</span></div>
          </div>
        )}

        {showAnalysisTools && !isFullscreen && highlights.length > 0 && (
          <button type="button" className="yp-hl-loop" aria-pressed={loopHl} disabled={activeHl === null}
            onClick={() => setLoopHl((value) => !value)}>
            Loop {loopHl ? "on" : "off"}
          </button>
        )}

        {showAnalysisTools && !isFullscreen && <HighlightEditor
          key={`highlight-editor-${videoId}`}
          highlights={highlights}
          duration={duration}
          currentTime={time}
          onSave={onHighlightsChange}
          language={language}
        />}

        {/* ปกติแสดงเป็นแถวใต้จอ แต่ตอนเต็มจอจะไปอยู่ในเมนูจุดสามจุดแทน */}
        {!isFullscreen && showAnalysisTools && <div className="yp-extra-settings">{settings}</div>}
      </div>
  );

  return (
    <div ref={rootRef} className={`yp-root ${isFullscreen ? "is-fullscreen" : ""} ${isFullscreen && idle ? "is-idle" : ""}`}>
      <div className={`yp-view-layout ${showAnalysisTools ? "has-formation" : ""} ${isFullscreen && !showPracticePanel ? "practice-panel-closed" : ""}`}>
        <div className="yp-video-column">
        <div className={`yp-stage ${mirrored ? "is-mirrored" : ""} ${calibrationArmed ? "is-calibrating" : ""}`}>
        {/* yp-frame ถูกขยายให้สูงกว่าเวที แล้วตัดส่วนเกินทิ้ง เพื่อซ่อนแถบชื่อคลิปของ YouTube
            (ตัวอักษรนั้นอยู่ใน iframe ข้ามโดเมน จึงกลับด้านเฉพาะตัวอักษรไม่ได้ ต้องซ่อนแทน) */}
        <div className="yp-frame" ref={hostRef} />

        {/* ชั้นรับการแตะ อยู่เหนือ iframe และไม่ถูกกลับด้าน ซ้าย/ขวาจึงตรงกับที่ผู้ใช้เห็นเสมอ */}
        <div className="yp-tap" onPointerUp={handleTap} aria-hidden="true">
          {flash && <span className={`yp-flash yp-flash--${flash.pos}`}>{flash.text}</span>}
        </div>
        {focusCountdown !== null && (
          <div className="yp-focus-countdown" aria-live="assertive" aria-label={tr(`Next video in ${focusCountdown} seconds`, `คลิปถัดไปใน ${focusCountdown} วินาที`)}>
            {focusCountdown}
          </div>
        )}
        {calibrationArmed && (
          <div className="yp-calibration-overlay" onPointerMove={moveCalibrationCorner}
            onPointerUp={() => { draggingCornerRef.current = null; }}
            onPointerCancel={() => { draggingCornerRef.current = null; }}>
            <svg className="yp-calibration-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <polygon points={calibrationDraft.map((point) => `${point.x * 100},${point.y * 100}`).join(" ")} />
            </svg>
            {calibrationDraft.map((point, index) => (
              <button key={`cal-${index}`} type="button" className="yp-calibration-mark"
                style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                onPointerDown={(event) => {
                  event.preventDefault(); event.stopPropagation();
                  draggingCornerRef.current = index;
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                aria-label={tr(`Drag floor corner ${index + 1}`, `ลากมุมเวที ${index + 1}`)} title={tr(`Floor corner ${index + 1}`, `มุมเวที ${index + 1}`)}>{index + 1}</button>
            ))}
          </div>
        )}
        {/* ปุ่มเต็มจอ: จางๆ มุมขวาล่างของจอ ชัดขึ้นเมื่อเอาเมาส์ไปจ่อ (อยู่นอก yp-frame จึงไม่ถูกกลับด้าน) */}
        <button
          type="button"
          className="yp-fs"
          onClick={toggleFullscreen}
          disabled={!ready}
          aria-label={isFullscreen ? tr("Exit fullscreen", "ออกจากเต็มจอ") : tr("Fullscreen", "เต็มจอ")}
          title={isFullscreen ? tr("Exit fullscreen", "ออกจากเต็มจอ") : tr("Fullscreen", "เต็มจอ")}
        >
          {isFullscreen ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
            </svg>
          )}
        </button>

        {isFullscreen && (
          <>
            {showAnalysisTools && <button type="button" className="yp-panel-toggle"
              onClick={() => setShowPracticePanel((visible) => !visible)}
              aria-label={showPracticePanel ? tr("Hide Practice Tools", "ซ่อนแถบ Practice Tools") : tr("Show Practice Tools", "แสดงแถบ Practice Tools")}
              aria-pressed={showPracticePanel}
              title={showPracticePanel ? tr("Hide Practice Tools", "ซ่อน Practice Tools") : tr("Show Practice Tools", "แสดง Practice Tools")}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {showPracticePanel ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
              </svg>
            </button>}
            <button
              type="button"
              className="yp-more"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label={tr("Settings", "ตั้งค่า")}
              aria-expanded={menuOpen}
              title={tr("Settings", "ตั้งค่า")}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="5" r="2" />
                <circle cx="12" cy="12" r="2" />
                <circle cx="12" cy="19" r="2" />
              </svg>
            </button>
            {menuOpen && <div className="yp-menu">{settings}</div>}
          </>
        )}

        {!ready && !error && <div className="yp-msg">{tr("Loading player…", "กำลังโหลดเครื่องเล่น…")}</div>}
        {error && (
          <div className="yp-msg" role="alert">
            {error}
          </div>
        )}
        </div>
        {!isFullscreen && (videoInfo || videoFooter) && <div className="yp-video-details">
          {videoInfo}
          {videoFooter && <div className="yp-video-footer">{videoFooter}</div>}
        </div>}
        </div>

        {showAnalysisTools && (
          <aside className="yp-formation-map" aria-label={tr("Formation map", "แผนผังแถว")}>
            <strong className="yp-practice-heading">{tr("PRACTICE TOOLS", "เครื่องมือฝึกเต้น")}</strong>
            <strong className="yp-formation-subheading">{tr("FORMATION TIMELINE", "ไทม์ไลน์ตำแหน่งนักเต้น")}</strong>
            <div className={`yp-formation-map__stage ${editingFormation ? "is-editing" : ""}`}
              onPointerMove={moveFormationDot}
              onPointerUp={() => { draggingPointRef.current = null; }}
              onPointerCancel={() => { draggingPointRef.current = null; }}>
              {(editingFormation ? activeFormationPoint.map((point) => ({ ...point, color: FORMATION_COLORS[point.color % FORMATION_COLORS.length] })) : formationPoints).map((point, index) => (
                <span
                  key={point.track_id ?? index}
                  className="yp-formation-map__dot"
                  style={{ left: `${(mirrored ? 1 - point.x : point.x) * 100}%`, top: `${point.y * 100}%`, background: point.color }}
                  onPointerDown={editingFormation ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    draggingPointRef.current = index;
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } : undefined}
                  title={point.name || tr(`Dancer ${index + 1}`, `นักเต้น ${index + 1}`)}
                >{point.name && <span className="yp-formation-map__name">{point.name}</span>}</span>
              ))}
              {formationPoints.length === 0 && <span className="yp-formation-map__empty">···</span>}
            </div>
            <small className="yp-formation-status">
              {formationStatus === "off" ? tr("Set all 4 floor corners to start formation analysis.", "ตั้งค่าพื้นเวที 4 มุมเพื่อเริ่มวิเคราะห์ฟอร์เมชัน") : formationStatus === "loading" ? tr("Starting analysis… The video can keep playing.", "กำลังเริ่มงานวิเคราะห์… คลิปยังเล่นต่อได้") : formationStatus === "running"
                ? formationStage === "downloading" ? tr("Preparing the video · Playback continues normally.", "กำลังเตรียมวิดีโอ · คลิปเล่นต่อได้ตามปกติ")
                : formationStage === "extracting-frames" ? tr("Selecting sample frames · Playback continues normally.", "กำลังเลือกภาพตัวอย่างจากคลิป · คลิปเล่นต่อได้ตามปกติ")
                  : formationStage === "projecting-floor" ? tr("Mapping foot positions to the floor · Playback continues normally.", "กำลังแปลงตำแหน่งเท้าบนพื้นเวที · คลิปเล่นต่อได้ตามปกติ")
                    : tr("Analyzing dancer positions · Playback continues normally.", "กำลังวิเคราะห์ตำแหน่งนักเต้น · คลิปเล่นต่อได้ตามปกติ")
                : formationTimeline.length === 0 ? tr("No confident formation patterns found yet.", "ยังไม่พบรูปแบบแถวที่มั่นใจพอ")
                  : tr(`Formation ${formationTimeline.filter((item) => item.time <= time).length} / ${formationTimeline.length} · ${formationPoints.length} dancers · ${formatTime(time)}`, `แถว ${formationTimeline.filter((item) => item.time <= time).length} / ${formationTimeline.length} · ${formationPoints.length} คน · เปลี่ยนตามเวลา ${formatTime(time)}`)}
            </small>
            {formationStatus === "ready" && formationTimeline.length > 0 && (
              <div className="yp-formation-editor">
                <label>{tr("Edit formation", "ฟอร์เมชันที่แก้ไข")}
                  <select value={selectedFormationIndex} onChange={(event) => {
                    const index = Number(event.target.value);
                    setSelectedFormationIndex(index);
                    const targetTime = formationTimeline[index]?.time ?? 0;
                    setTime(targetTime);
                    playerRef.current?.seekTo(targetTime, true);
                    playerRef.current?.pauseVideo();
                  }}>
                    {formationTimeline.map((item, index) => <option key={`${item.time}-${index}`} value={index}>{tr(`Formation ${index + 1}`, `แถว ${index + 1}`)} · {formatTime(item.time)}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => setEditingFormation((value) => !value)}>
                  {editingFormation ? tr("Finish editing", "เสร็จสิ้นการแก้ไข") : tr("Edit points and dancer names", "แก้ไขจุดและชื่อคน")}
                </button>
                {editingFormation && <>
                  <small>{tr("Names stay linked to the same dancer across all formations in this video.", "ชื่อจะผูกกับนักเต้นคนเดิมและใช้ร่วมกันทุกฟอร์เมชันในคลิปนี้")}</small>
                  <div className="yp-formation-editor__people">
                  {activeFormationPoint.map((point, index) => (
                    <label key={point.track_id ?? index}>
                      <span style={{ color: FORMATION_COLORS[point.color % FORMATION_COLORS.length] }}>●</span>
                      <input aria-label={tr(`Dancer ${index + 1} name`, `ชื่อนักเต้นจุด ${index + 1}`)} placeholder={tr(`Dancer ${index + 1}`, `นักเต้น ${index + 1}`)} value={point.name ?? ""}
                        onChange={(event) => updateFormationPoint(index, { name: event.target.value })} />
                      <small>{Math.round(point.x * 100)}%, {Math.round(point.y * 100)}%</small>
                    </label>
                  ))}
                  </div>
                </>}
                {formationDirty && <button type="button" onClick={saveFormationEdits}>
                  {tr("Save formation changes", "บันทึกฟอร์เมชันที่แก้แล้ว")}
                </button>}
              </div>
            )}
            <div className="yp-practice-settings">
              <div className="yp-practice-shortcuts">
                <label className="yp-tool-pill"><input type="checkbox" checked={mirrored} onChange={(e) => setMirrored(e.target.checked)} /> Mirror</label>
                <label className="yp-tool-pill">Speed
                  <select value={rate} disabled={!ready} onChange={(e) => changeRate(Number(e.target.value))}>
                    {RATES.map((r) => <option key={r} value={r}>{r === 1 ? "×1" : `×${r}`}</option>)}
                  </select>
                </label>
              </div>
              <label className="yp-volume-control">{tr("Volume", "เสียง")} <input type="range" min={0} max={100} value={volume} onChange={(e) => changeVolume(Number(e.target.value))} /></label>
            </div>
            <div className="yp-formation-tools">
              {!calibrationArmed ? <button type="button" className="yp-position-button" onClick={beginStageCalibration}>
                {stageCorners.length === 4 ? "Position · Edit floor corners" : "Position · Mark 4 points"}
              </button> : <>
                <button type="button" className="yp-position-button" onClick={saveStageCalibrationDraft}>{tr("Save floor corners", "บันทึกมุมพื้นเวที")}</button>
                <button type="button" className="yp-position-cancel" onClick={cancelStageCalibration}>{tr("Cancel", "ยกเลิก")}</button>
              </>}
              <small className="yp-position-help">
                {calibrationArmed
                  ? "Drag points 1–4 to the floor corners, then save your position."
                  : stageCorners.length !== 4 && formationStatus === "off"
                    ? "Mark 4 floor corners to show Position."
                  : ["loading", "running"].includes(formationStatus)
                  ? tr("Analyzing in the background · Playback continues.", "วิเคราะห์เบื้องหลัง คลิปยังเล่นต่อได้")
                  : tr("Set the 4 floor corners to start formation analysis.", "ตั้งค่าพื้นเวที 4 มุมเพื่อเริ่มวิเคราะห์ฟอร์เมชัน")}
              </small>
              <button
                type="button"
                className="yp-analyze-button"
                onClick={["loading", "running"].includes(formationStatus) ? stopFormationAnalysis : startFormationAnalysis}
                disabled={!stageCorners.length && !["loading", "running"].includes(formationStatus)}
              >
                {formationStatus === "loading" ? tr("Starting analysis… (Cancel)", "กำลังเริ่มวิเคราะห์… (ยกเลิก)") : formationStatus === "running" ? tr("Stop analysis", "หยุดรอผลวิเคราะห์") : formationStatus === "ready" ? tr("Analyze formations again", "วิเคราะห์แถวอีกครั้ง") : tr("Analyze the full video", "วิเคราะห์แถวทั้งคลิป")}
              </button>
              {formationError && <small className="yp-formation-error" role="status">{tr("Could not analyze positions:", "วิเคราะห์ตำแหน่งไม่ได้:")} {formationError}</small>}
            </div>
            {isFullscreen && fullscreenHighlights}
            {!isFullscreen && <div className="yp-right-media-controls">{controls}</div>}
          </aside>
        )}
      </div>

      {(isFullscreen || !showAnalysisTools) && controls}
    </div>
  );
}

function HighlightEditor({ highlights, duration, currentTime, onSave, language }: {
  highlights: AutoSegment[];
  duration: number;
  currentTime: number;
  onSave?: (segments: AutoSegment[]) => void;
  language: string;
}) {
  const th = language === "ไทย";
  const tr = (english: string, thai: string) => th ? thai : english;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AutoSegment[]>([]);
  const [saved, setSaved] = useState(false);
  const valid = draft.every(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) &&
    segment.start >= 0 && segment.end > segment.start && (!duration || segment.end <= duration));

  function beginEditing() {
    setDraft(highlights.map(segment => ({ ...segment })));
    setSaved(false);
    setOpen(true);
  }

  function update(index: number, changes: Partial<AutoSegment>) {
    setDraft(items => items.map((item, i) => i === index ? { ...item, ...changes } : item));
    setSaved(false);
  }

  function addSegment() {
    if (!duration) return;
    const start = Math.min(currentTime, Math.max(0, duration - 1));
    const end = Math.min(duration, start + 10);
    setDraft(items => [...items, { origin: "manual", kind: "chorus", start, end, label: tr("Added segment", "ท่อนที่เพิ่มเอง"),
      confidence: "medium", evidence: tr("Added by user", "เพิ่มโดยผู้ใช้") }]);
    setSaved(false);
  }

  function save() {
    if (!valid || !onSave) return;
    onSave(draft.map(segment => ({ ...segment })).sort((a, b) => a.start - b.start));
    setOpen(false);
    setSaved(true);
  }

  return (
    <div className="yp-highlight-editor">
      {!open ? (
        <>
          <button type="button" onClick={beginEditing}>{tr("Edit highlights", "แก้ไขไฮไลท์")}</button>
          {saved && <small role="status">{tr("Highlights saved.", "บันทึกไฮไลท์แล้ว")}</small>}
        </>
      ) : (
        <div className="yp-highlight-editor__panel">
          <strong>{tr("Edit highlight segments", "แก้ไขท่อนไฮไลท์")}</strong>
          {draft.length === 0 && <small>{tr("No highlights yet. Select Add segment to create one.", "ยังไม่มีท่อนไฮไลท์ กด “เพิ่มท่อน” เพื่อสร้างเอง")}</small>}
          {draft.map((segment, index) => (
            <div className="yp-highlight-editor__row" key={`${index}-${segment.start}`}>
              <label>{tr("Name", "ชื่อ")}
                <input value={segment.label} onChange={event => update(index, { label: event.target.value })} />
              </label>
              <label>{tr("Start (seconds)", "เริ่ม (วินาที)")}
                <input type="number" min={0} max={duration || undefined} step={0.1} value={Number.isFinite(segment.start) ? segment.start : ""}
                  onChange={event => update(index, { start: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
              </label>
              <label>{tr("End (seconds)", "จบ (วินาที)")}
                <input type="number" min={0} max={duration || undefined} step={0.1} value={Number.isFinite(segment.end) ? segment.end : ""}
                  onChange={event => update(index, { end: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
              </label>
              <button type="button" onClick={() => setDraft(items => items.filter((_, i) => i !== index))}>{tr("Remove segment", "ลบท่อน")}</button>
            </div>
          ))}
          <div className="yp-highlight-editor__actions">
            <button type="button" onClick={addSegment} disabled={!duration}>{tr("Add segment at current time", "เพิ่มท่อน ณ เวลาปัจจุบัน")}</button>
            <button type="button" onClick={() => setOpen(false)}>{tr("Cancel", "ยกเลิก")}</button>
            <button type="button" onClick={save} disabled={!valid}>{tr("Save changes", "บันทึกการแก้ไข")}</button>
            {!valid && <small role="alert">{tr("Check the start and end: values must be non-negative, end must be after start, and within the video duration.", "ตรวจเวลาเริ่มและเวลาจบ: ต้องไม่ติดลบ เวลาจบต้องมากกว่าเวลาเริ่มและไม่เกินความยาวคลิป")}</small>}
          </div>
        </div>
      )}
    </div>
  );
}
