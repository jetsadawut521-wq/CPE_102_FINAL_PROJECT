"use client";
// components/youtube-player.tsx
// เครื่องเล่น YouTube IFrame API พร้อมฟีเจอร์:
// เล่น/หยุด, Seekbar, แตะสองครั้งข้าม/ย้อน 10 วิ, ปรับเสียง (จำค่าไว้), กลับด้านซ้าย-ขวา,
// คีย์ลัด (Space / ← → / ↑ ↓), เต็มจอ

import { useCallback, useEffect, useRef, useState } from "react";
import { YT_STATE, formatTime, loadYouTubeApi, type YTEvent, type YTPlayer } from "@/lib/youtube";
import type { AutoSegment } from "@/lib/highlight-analysis";
import { readSavedFormations, readStageCalibration, saveFormations, saveStageCalibration,
  type FormationPoint as SavedFormationPoint, type FormationSnapshot as SavedFormationSnapshot, type StageCorner as SavedStageCorner } from "@/lib/analysis-storage";
import "./youtube-player.css";

interface Props {
  videoId: string;
  autoPlay?: boolean;
  onEnded?: () => void;
  onError?: (code: number) => void; // รหัส error จาก YouTube (เช่น 101/150 = ฝังไม่ได้)
  loopOne?: boolean; // เล่นคลิปนี้ซ้ำไปเรื่อย ๆ: จบแล้วเริ่มใหม่เองและไม่เรียก onEnded
  highlights?: AutoSegment[]; // ท่อนยอดนิยมที่ระบบวิเคราะห์ให้ แสดงบนแถบกรอ (ว่าง = ไม่แสดง)
  onHighlightsChange?: (segments: AutoSegment[]) => void;
  focusRange?: { start: number; end: number; key: string };
  onFocusRangeEnd?: () => void;
}

const NO_HIGHLIGHTS: AutoSegment[] = [];

const SKIP_SECONDS = 10; // แตะสองครั้งบนจอ
const KEY_SKIP_SECONDS = 5; // ปุ่มลูกศรซ้าย/ขวา
const VOLUME_STEP = 5; // ปุ่มลูกศรขึ้น/ลง ต่อครั้ง (ปรับเลขนี้ได้)
const DEFAULT_VOLUME = 80;
const DOUBLE_TAP_MS = 280;
const IDLE_MS = 3000; // ไม่ขยับเมาส์นานเท่านี้ตอนเต็มจอ → ซ่อนทุกอย่างบนจอ
const VOLUME_KEY = "muverse:volume";
const RATE_KEY = "muverse:rate";
const QUALITY_KEY = "muverse:quality";
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const QUALITY_LABELS: Record<string, string> = {
  auto: "อัตโนมัติ",
  highres: "สูงกว่า 4K",
  hd2880: "2880p",
  hd2160: "2160p (4K)",
  hd1440: "1440p",
  hd1080: "1080p",
  hd720: "720p",
  large: "480p",
  medium: "360p",
  small: "240p",
  tiny: "144p",
};

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
type FormationPoint = Omit<SavedFormationPoint, "color"> & { color: string };
type FormationSnapshot = SavedFormationSnapshot;
type StageCorner = SavedStageCorner;
const FORMATION_COLORS = ["#ffe600", "#ff5b9a", "#4de1ff", "#a78bfa", "#ff9f43", "#68e39a", "#ff6b6b", "#5eead4", "#c084fc", "#facc15"];

export default function YouTubePlayer({ videoId, autoPlay = true, onEnded, onError, loopOne = false, highlights = NO_HIGHLIGHTS,
  onHighlightsChange, focusRange, onFocusRangeEnd }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
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

  const onErrorRef = useRef(onError);
  const playingRef = useRef(false);
  const focusEndRef = useRef(onFocusRangeEnd);
  const focusRangeRef = useRef(focusRange);
  const focusEndHandledRef = useRef(false);
  const loadedFocusKeyRef = useRef("");
  const countdownAudioRef = useRef<AudioContext | null>(null);
  const rateRef = useRef(1);
  const qualityRef = useRef("auto");
  const pauseAfterLoadRef = useRef(false); // เปลี่ยนความละเอียดตอนหยุดอยู่ → โหลดใหม่แล้วหยุดต่อ
  const qualityTimer = useRef<number | undefined>(undefined);
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
  const [quality, setQuality] = useState("auto");
  const [qualityLevels, setQualityLevels] = useState<string[]>([]);
  const [qualityNote, setQualityNote] = useState<string | null>(null);
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
  const [calibrationMarks, setCalibrationMarks] = useState<StageCorner[]>([]);
  const [stageCorners, setStageCorners] = useState<StageCorner[]>([]);
  const [editingFormation, setEditingFormation] = useState(false);
  const [selectedFormationIndex, setSelectedFormationIndex] = useState(0);
  const [formationDirty, setFormationDirty] = useState(false);
  const draggingPointRef = useRef<number | null>(null);

  useEffect(() => {
    onEndedRef.current = onEnded;
    onErrorRef.current = onError;
    loopOneRef.current = loopOne;
    focusEndRef.current = onFocusRangeEnd;
    focusRangeRef.current = focusRange;
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
  }, [videoId, highlights]);

  useEffect(() => {
    setFormationPoints([]);
    const saved = readSavedFormations(videoId);
    const corners = readStageCalibration(videoId);
    setFormationTimeline(saved ?? []);
    setFormationStatus(saved?.length ? "ready" : "off");
    setFormationStage(null);
    setFormationError(null);
    setCalibrationArmed(false);
    setCalibrationMarks([]);
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

  // ดึงรายการความละเอียดที่คลิปนี้มีให้เลือก (รู้ได้หลังคลิปเริ่มเล่น)
  const refreshQualityLevels = useCallback(() => {
    const levels = playerRef.current?.getAvailableQualityLevels?.() ?? [];
    setQualityLevels(levels.filter((l) => l !== "auto"));
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
      const savedQuality = window.localStorage.getItem(QUALITY_KEY);
      if (savedQuality && savedQuality in QUALITY_LABELS) {
        qualityRef.current = savedQuality;
        setQuality(savedQuality);
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

  // เปลี่ยนความละเอียด: YouTube เลิกรับประกันคำสั่ง setPlaybackQuality แล้ว
  // จึงโหลดคลิปเดิมใหม่ที่เวลาเดิมพร้อม suggestedQuality แล้วตรวจว่า YouTube ยอมทำตามหรือไม่
  const changeQuality = useCallback((next: string) => {
    const p = playerRef.current;
    qualityRef.current = next;
    setQuality(next);
    setQualityNote(null);
    try {
      window.localStorage.setItem(QUALITY_KEY, next);
    } catch {
      /* ignore */
    }
    const id = loadedIdRef.current;
    if (!p || !id) return;
    const at = safe(p.getCurrentTime());
    pauseAfterLoadRef.current = !playingRef.current;
    p.setPlaybackQuality(next);
    p.loadVideoById({
      videoId: id,
      startSeconds: at,
      suggestedQuality: next === "auto" ? undefined : next,
    });
    window.clearTimeout(qualityTimer.current);
    if (next !== "auto") {
      qualityTimer.current = window.setTimeout(() => {
        const actual = playerRef.current?.getPlaybackQuality?.();
        if (actual && actual !== next) {
          setQualityNote(`YouTube เลือก ${QUALITY_LABELS[actual] ?? actual} ให้แทน (เน็ตหรือคลิปอาจไม่รองรับ)`);
        }
      }, 3000);
    }
  }, []);

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
                refreshQualityLevels();
                if (pauseAfterLoadRef.current) {
                  pauseAfterLoadRef.current = false;
                  playerRef.current?.pauseVideo();
                }
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
                setError("เจ้าของคลิปไม่อนุญาตให้เล่นนอก YouTube ลองเลือกคลิปอื่น");
              } else if (e.data === 153) {
                setError("เบราว์เซอร์นี้ไม่ส่งข้อมูลต้นทางให้ YouTube ลองเปิดหน้านี้ใน Chrome หรือ Edge โดยตรง");
              } else {
                setError(`เล่นคลิปนี้ไม่ได้ (รหัส ${e.data}) ลองเลือกคลิปอื่น`);
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
      suggestedQuality: qualityRef.current === "auto" ? undefined : qualityRef.current,
    });
    applyVolume();
    applyRate();
    hideCaptions();
  }, [videoId, ready, applyVolume, applyRate, hideCaptions]);

  const focusRangeKey = focusRange ? `${focusRange.key}:${focusRange.start}:${focusRange.end}` : "";
  useEffect(() => {
    const range = focusRangeRef.current;
    if (!ready || !range || loadedFocusKeyRef.current === focusRangeKey) return;
    loadedFocusKeyRef.current = focusRangeKey;
    focusEndHandledRef.current = false;
    setTime(range.start);
    const player = playerRef.current;
    const currentTime = safe(player?.getCurrentTime());
    if (Math.abs(currentTime - range.start) > 1.5) {
      player?.loadVideoById({
        videoId: videoIdRef.current,
        startSeconds: range.start,
        suggestedQuality: qualityRef.current === "auto" ? undefined : qualityRef.current,
      });
    } else {
      player?.seekTo(range.start, true);
    }
    player?.playVideo();
  }, [focusRangeKey, ready]);

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

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (playing) p.pauseVideo();
    else p.playVideo();
    showFlash(playing ? "⏸ หยุด" : "▶ เล่น", "center");
  }, [playing, showFlash]);

  const skip = useCallback(
    (delta: number) => {
      const p = playerRef.current;
      if (!p) return;
      const max = safe(p.getDuration()) || Infinity;
      const next = Math.min(Math.max(safe(p.getCurrentTime()) + delta, 0), max);
      p.seekTo(next, true);
      setTime(next);
      showFlash(`${delta < 0 ? "−" : "+"}${Math.abs(delta)} วิ`, delta < 0 ? "left" : "right");
    },
    [showFlash],
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
          showFlash(`เสียง ${volumeRef.current}%`, "center");
          break;
        case "ArrowDown":
          e.preventDefault();
          changeVolume(volumeRef.current - VOLUME_STEP);
          showFlash(`เสียง ${volumeRef.current}%`, "center");
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
  }, [ready, togglePlay, skip, changeVolume, showFlash]);

  // แตะครั้งเดียว = เล่น/หยุด, แตะสองครั้ง = ข้าม/ย้อน 10 วิ (ขวา = ข้าม, ซ้าย = ย้อน)
  const handleTap = (e: React.PointerEvent<HTMLDivElement>) => {
    if (calibrationArmed) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const next = [...calibrationMarks, {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
      }];
      setCalibrationMarks(next);
      if (next.length === 4) {
        // Convert the visible corner order to the original, unmirrored frame.
        const ordered = mirrored ? [next[1], next[0], next[3], next[2]] : next;
        const corners = ordered.map((point) => ({ x: mirrored ? 1 - point.x : point.x, y: point.y }));
        setStageCorners(corners);
        saveStageCalibration(videoId, corners);
        setCalibrationArmed(false);
      }
      return;
    }
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
    formationAbortRef.current?.abort();
    formationAbortRef.current = null;
    playerRef.current?.pauseVideo();
    setFormationError(null);
    setFormationStatus("off");
    setFormationTimeline([]);
    setFormationPoints([]);
    setCalibrationMarks([]);
    setStageCorners([]);
    setCalibrationArmed(true);
  }, []);

  const startFormationAnalysis = useCallback(async () => {
    if (stageCorners.length !== 4) {
      setFormationError("ตั้งค่ามุมพื้นเวทีให้ครบ 4 จุดก่อน");
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
        if (!response.ok && response.status !== 429) throw new Error("ติดต่อระบบวิเคราะห์คลิปไม่ได้");
        setFormationStage(result.stage ?? null);
        if (result.status === "processing" || result.status === "queued") setFormationStatus("running");
        if (result.status === "busy") throw new Error("มีคลิปอื่นกำลังวิเคราะห์อยู่ ลองอีกครั้งภายหลัง");
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
        const messages: Record<string, string> = {
          "worker-unavailable": "ติดต่อบริการวิเคราะห์ใน Ubuntu ไม่ได้",
          "download-timeout": "รับวิดีโอไม่ทันเวลาที่กำหนด ลองใหม่อีกครั้ง",
          "download-failed": "ดาวน์โหลดวิดีโอเพื่อวิเคราะห์ไม่สำเร็จ",
          "download-rejected": "คลิปนี้เป็นไลฟ์ คลิปยาวเกิน 15 นาที หรือ YouTube ไม่อนุญาตให้ดึงวิดีโอ",
          "decode-failed": "อ่านเฟรมวิดีโอไม่สำเร็จ ตรวจว่าติดตั้ง FFmpeg แล้ว",
          "dependency-missing": "ยังไม่ได้ติดตั้ง MediaPipe สำหรับวิเคราะห์แถว",
          "tool-missing": "ไม่พบ FFmpeg ใน Ubuntu",
          "invalid-stage-corners": "มุมพื้นเวทีซ้อนกันหรือเรียงผิดลำดับ ลองตั้งค่า 4 มุมใหม่",
        };
        throw new Error(messages[result.reason ?? ""] ?? "วิเคราะห์แถวไม่สำเร็จ");
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
      setFormationError(error instanceof Error ? error.message : "วิเคราะห์แถวไม่สำเร็จ");
      setFormationStatus("error");
    }
  }, [stageCorners, videoId]);

  useEffect(() => () => stopFormationAnalysis(), [stopFormationAnalysis]);

  const settings = (
    <>
          <label>
            เสียง{" "}
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => changeVolume(Number(e.target.value))}
            />
          </label>

          <label>
            <input type="checkbox" checked={mirrored} onChange={(e) => setMirrored(e.target.checked)} /> กลับด้านซ้าย-ขวา
          </label>

          <label>
            ความเร็ว{" "}
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
                  {r === 1 ? "ปกติ" : `${r}x`}
                </option>
              ))}
            </select>
          </label>

          <label>
            ความละเอียด{" "}
            <select
              value={quality}
              disabled={!ready}
              onChange={(e) => {
                changeQuality(e.target.value);
                e.currentTarget.blur();
              }}
            >
              <option value="auto">{QUALITY_LABELS.auto}</option>
              {qualityLevels.map((q) => (
                <option key={q} value={q}>
                  {QUALITY_LABELS[q] ?? q}
                </option>
              ))}
              {/* ค่าที่จำไว้แต่คลิปนี้ไม่มีให้ ยังต้องแสดงใน select ให้ตรงกับ state */}
              {quality !== "auto" && !qualityLevels.includes(quality) && (
                <option value={quality}>{QUALITY_LABELS[quality] ?? quality}</option>
              )}
            </select>
          </label>
      {qualityNote && <div className="yp-note">{qualityNote}</div>}
    </>
  );

  return (
    <div ref={rootRef} className={`yp-root ${isFullscreen ? "is-fullscreen" : ""} ${isFullscreen && idle ? "is-idle" : ""}`}>
      <div className={`yp-view-layout ${["loading", "running", "ready"].includes(formationStatus) ? "has-formation" : ""}`}>
        <div className={`yp-stage ${mirrored ? "is-mirrored" : ""} ${calibrationArmed ? "is-calibrating" : ""}`}>
        {/* yp-frame ถูกขยายให้สูงกว่าเวที แล้วตัดส่วนเกินทิ้ง เพื่อซ่อนแถบชื่อคลิปของ YouTube
            (ตัวอักษรนั้นอยู่ใน iframe ข้ามโดเมน จึงกลับด้านเฉพาะตัวอักษรไม่ได้ ต้องซ่อนแทน) */}
        <div className="yp-frame" ref={hostRef} />

        {/* ชั้นรับการแตะ อยู่เหนือ iframe และไม่ถูกกลับด้าน ซ้าย/ขวาจึงตรงกับที่ผู้ใช้เห็นเสมอ */}
        <div className="yp-tap" onPointerUp={handleTap} aria-hidden="true">
          {flash && <span className={`yp-flash yp-flash--${flash.pos}`}>{flash.text}</span>}
        </div>
        {focusCountdown !== null && (
          <div className="yp-focus-countdown" aria-live="assertive" aria-label={`คลิปถัดไปใน ${focusCountdown} วินาที`}>
            {focusCountdown}
          </div>
        )}
        {calibrationMarks.map((point, index) => (
          <span key={`cal-${index}`} className="yp-calibration-mark" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
            {index + 1}
          </span>
        ))}

        {/* ปุ่มเต็มจอ: จางๆ มุมขวาล่างของจอ ชัดขึ้นเมื่อเอาเมาส์ไปจ่อ (อยู่นอก yp-frame จึงไม่ถูกกลับด้าน) */}
        <button
          type="button"
          className="yp-fs"
          onClick={toggleFullscreen}
          disabled={!ready}
          aria-label={isFullscreen ? "ออกจากเต็มจอ" : "เต็มจอ"}
          title={isFullscreen ? "ออกจากเต็มจอ" : "เต็มจอ"}
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
            <button
              type="button"
              className="yp-more"
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="ตั้งค่า"
              aria-expanded={menuOpen}
              title="ตั้งค่า"
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

        {!ready && !error && <div className="yp-msg">กำลังโหลดเครื่องเล่น…</div>}
        {error && (
          <div className="yp-msg" role="alert">
            {error}
          </div>
        )}
        </div>

        {["loading", "running", "ready"].includes(formationStatus) && (
          <aside className="yp-formation-map" aria-label="แผนผังแถว">
            <strong>แผนผังแถวตามเวลาในคลิป</strong>
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
                  title={point.name || `นักเต้น ${index + 1}`}
                >{point.name && <span className="yp-formation-map__name">{point.name}</span>}</span>
              ))}
              {formationPoints.length === 0 && <span className="yp-formation-map__empty">···</span>}
            </div>
            <small>
              {formationStatus === "loading" ? "กำลังเริ่มงานวิเคราะห์… คลิปยังเล่นต่อได้" : formationStatus === "running"
                ? formationStage === "downloading" ? "กำลังเตรียมวิดีโอ · คลิปเล่นต่อได้ตามปกติ"
                : formationStage === "extracting-frames" ? "กำลังเลือกภาพตัวอย่างจากคลิป · คลิปเล่นต่อได้ตามปกติ"
                  : formationStage === "projecting-floor" ? "กำลังแปลงตำแหน่งเท้าบนพื้นเวที · คลิปเล่นต่อได้ตามปกติ"
                    : "กำลังวิเคราะห์ตำแหน่งนักเต้น · คลิปเล่นต่อได้ตามปกติ"
                : formationTimeline.length === 0 ? "ยังไม่พบรูปแบบแถวที่มั่นใจพอ"
                  : `แถว ${formationTimeline.filter((item) => item.time <= time).length} / ${formationTimeline.length} · ${formationPoints.length} คน · เปลี่ยนตามเวลา ${formatTime(time)}`}
            </small>
            {formationStatus === "ready" && formationTimeline.length > 0 && (
              <div className="yp-formation-editor">
                <label>ฟอร์เมชันที่แก้ไข
                  <select value={selectedFormationIndex} onChange={(event) => {
                    const index = Number(event.target.value);
                    setSelectedFormationIndex(index);
                    const targetTime = formationTimeline[index]?.time ?? 0;
                    setTime(targetTime);
                    playerRef.current?.seekTo(targetTime, true);
                    playerRef.current?.pauseVideo();
                  }}>
                    {formationTimeline.map((item, index) => <option key={`${item.time}-${index}`} value={index}>แถว {index + 1} · {formatTime(item.time)}</option>)}
                  </select>
                </label>
                <button type="button" onClick={() => setEditingFormation((value) => !value)}>
                  {editingFormation ? "เสร็จสิ้นการแก้ไข" : "แก้ไขจุดและชื่อคน"}
                </button>
                {editingFormation && <>
                  <small>ชื่อจะผูกกับนักเต้นคนเดิมและใช้ร่วมกันทุกฟอร์เมชันในคลิปนี้</small>
                  <div className="yp-formation-editor__people">
                  {activeFormationPoint.map((point, index) => (
                    <label key={point.track_id ?? index}>
                      <span style={{ color: FORMATION_COLORS[point.color % FORMATION_COLORS.length] }}>●</span>
                      <input aria-label={`ชื่อนักเต้นจุด ${index + 1}`} placeholder={`นักเต้น ${index + 1}`} value={point.name ?? ""}
                        onChange={(event) => updateFormationPoint(index, { name: event.target.value })} />
                      <small>{Math.round(point.x * 100)}%, {Math.round(point.y * 100)}%</small>
                    </label>
                  ))}
                  </div>
                </>}
                <button type="button" onClick={saveFormationEdits} disabled={!formationDirty}>
                  {formationDirty ? "บันทึกฟอร์เมชันที่แก้แล้ว" : "บันทึกแล้ว"}
                </button>
              </div>
            )}
          </aside>
        )}
      </div>

      {!isFullscreen && (
        <div className="yp-formation-tools">
          <button type="button" onClick={() => {
            if (calibrationArmed) {
              setCalibrationArmed(false);
              setCalibrationMarks([]);
            } else beginStageCalibration();
          }}>
            {calibrationArmed ? `คลิกมุมพื้นเวที ${calibrationMarks.length}/4` : stageCorners.length === 4 ? "ตั้งค่าพื้นเวทีใหม่" : "ตั้งค่าพื้นเวที (4 จุด)"}
          </button>
          <button
            type="button"
            onClick={["loading", "running"].includes(formationStatus) ? stopFormationAnalysis : startFormationAnalysis}
            disabled={!stageCorners.length && !["loading", "running"].includes(formationStatus)}
          >
            {formationStatus === "loading" ? "กำลังเริ่มวิเคราะห์… (ยกเลิก)" : formationStatus === "running" ? "หยุดรอผลวิเคราะห์" : formationStatus === "ready" ? "วิเคราะห์แถวอีกครั้ง" : "วิเคราะห์แถวทั้งคลิป"}
          </button>
          <small>
            {calibrationArmed
              ? "หยุดคลิปไว้ คลิกบนพื้นเท่านั้น: 1 ไกลซ้ายตรงรอยต่อผนัง-พื้น → 2 ไกลขวาตรงรอยต่อผนัง-พื้น → 3 ใกล้ขวา → 4 ใกล้ซ้าย (อย่าคลิกบนผนัง)"
              : stageCorners.length !== 4 && formationStatus === "off"
                ? "ตั้งค่าพื้นเวที 4 มุมก่อน เพื่อแปลงตำแหน่งเท้าเป็นแผนผังมองจากด้านบน"
              : ["loading", "running"].includes(formationStatus)
              ? "วิเคราะห์เบื้องหลัง ไม่หยุดหรือหน่วงคลิป · เมื่อเสร็จ แผนผังจะตามตำแหน่งเวลาในคลิป"
              : "วิเคราะห์ใน Ubuntu เครื่องนี้ ไม่ต้องแชร์หน้าจอ · จุดคำนวณจากตำแหน่งเท้าบนพื้นเวที"}
          </small>
          {formationError && <small className="yp-formation-error" role="status">วิเคราะห์ตำแหน่งไม่ได้: {formationError}</small>}
        </div>
      )}

      <div className="yp-controls">
        <div className="yp-seek">
          <span>{formatTime(time)}</span>
          <div className="yp-track">
            {/* แถบสีบอกช่วงท่อนยอดนิยม (ไม่รับเมาส์ ให้คลิกกรอที่แถบกรอได้ตามปกติ) */}
            {duration > 0 && highlights.length > 0 && (
              <div className="yp-hl-lane" aria-hidden="true">
                {highlights.map((h, i) =>
                  h.start < duration ? (
                    <span
                      key={`${h.start}-${i}`}
                      className={`yp-hl ${h.confidence === "high" ? "is-high" : ""} ${activeHl === i ? "is-active" : ""}`}
                      style={{
                        left: `${(h.start / duration) * 100}%`,
                        width: `${((Math.min(h.end, duration) - h.start) / duration) * 100}%`,
                      }}
                      title={`${h.label} (${formatTime(h.start)}–${formatTime(h.end)})`}
                    />
                  ) : null,
                )}
              </div>
            )}
            <input
              type="range"
              min={0}
              max={Math.max(duration, 1)}
              step={0.1}
              value={Math.min(time, Math.max(duration, 1))}
              disabled={!ready}
              aria-label="กรอวิดีโอ"
              onChange={(e) => {
                setSeeking(true);
                setTime(Number(e.target.value));
              }}
              onPointerUp={commitSeek}
            />
          </div>
          <span>{formatTime(duration)}</span>
        </div>

        {highlights.length > 0 && (
          <div className="yp-hls" role="group" aria-label="ท่อนยอดนิยม">
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
                title={h.evidence}
              >
                ▶ {formatTime(h.start)}–{formatTime(h.end)} · {h.label}
              </button>
            ))}
            <label className="yp-hl-loop">
              <input
                type="checkbox"
                checked={loopHl}
                disabled={activeHl === null}
                onChange={(e) => {
                  setLoopHl(e.target.checked);
                  e.currentTarget.blur();
                }}
              />{" "}
              วนซ้ำท่อนที่เลือก
            </label>
            {/* หลักฐานที่ระบบใช้เสนอท่อนนี้ ให้ผู้ใช้ตรวจสอบเองได้ */}
            <small className="yp-hl-evidence">
              {highlights[activeHl ?? 0]?.evidence}
            </small>
          </div>
        )}

        <HighlightEditor
          key={`highlight-editor-${videoId}`}
          highlights={highlights}
          duration={duration}
          currentTime={time}
          onSave={onHighlightsChange}
        />

        {/* ปกติแสดงเป็นแถวใต้จอ แต่ตอนเต็มจอจะไปอยู่ในเมนูจุดสามจุดแทน */}
        {!isFullscreen && <div className="yp-row">{settings}</div>}
      </div>
    </div>
  );
}

function HighlightEditor({ highlights, duration, currentTime, onSave }: {
  highlights: AutoSegment[];
  duration: number;
  currentTime: number;
  onSave?: (segments: AutoSegment[]) => void;
}) {
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
    setDraft(items => [...items, { origin: "manual", kind: "chorus", start, end, label: "ท่อนที่เพิ่มเอง",
      confidence: "medium", evidence: "เพิ่มโดยผู้ใช้" }]);
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
          <button type="button" onClick={beginEditing}>แก้ไขไฮไลท์</button>
          {saved && <small role="status">บันทึกไฮไลท์แล้ว</small>}
        </>
      ) : (
        <div className="yp-highlight-editor__panel">
          <strong>แก้ไขท่อนไฮไลท์</strong>
          {draft.length === 0 && <small>ยังไม่มีท่อนไฮไลท์ กด “เพิ่มท่อน” เพื่อสร้างเอง</small>}
          {draft.map((segment, index) => (
            <div className="yp-highlight-editor__row" key={`${index}-${segment.start}`}>
              <label>ชื่อ
                <input value={segment.label} onChange={event => update(index, { label: event.target.value })} />
              </label>
              <label>เริ่ม (วินาที)
                <input type="number" min={0} max={duration || undefined} step={0.1} value={Number.isFinite(segment.start) ? segment.start : ""}
                  onChange={event => update(index, { start: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
              </label>
              <label>จบ (วินาที)
                <input type="number" min={0} max={duration || undefined} step={0.1} value={Number.isFinite(segment.end) ? segment.end : ""}
                  onChange={event => update(index, { end: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
              </label>
              <button type="button" onClick={() => setDraft(items => items.filter((_, i) => i !== index))}>ลบท่อน</button>
            </div>
          ))}
          <div className="yp-highlight-editor__actions">
            <button type="button" onClick={addSegment} disabled={!duration}>เพิ่มท่อน ณ เวลาปัจจุบัน</button>
            <button type="button" onClick={() => setOpen(false)}>ยกเลิก</button>
            <button type="button" onClick={save} disabled={!valid}>บันทึกการแก้ไข</button>
            {!valid && <small role="alert">ตรวจเวลาเริ่มและเวลาจบ: ต้องไม่ติดลบ เวลาจบต้องมากกว่าเวลาเริ่มและไม่เกินความยาวคลิป</small>}
          </div>
        </div>
      )}
    </div>
  );
}
