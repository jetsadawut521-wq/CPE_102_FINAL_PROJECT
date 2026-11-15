"use client";
// components/youtube-search.tsx
// ช่องค้นหา + ตัวกรองประเภท (ทั้งหมด / เต้นตาม / สอนเต้น) + รายการผลลัพธ์

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import HeartButton from "@/components/heart-button";
import { formatTime, type SearchMode, type VideoItem } from "@/lib/youtube";

interface Props {
  language?: string;
  inline?: boolean;
  inlineActive?: boolean;
  inlineResultsOnPage?: boolean;
  onInlineQueryChange?: (query: string | null) => void;
  activeId?: string;
  onSelect: (video: VideoItem) => void;
  /** กดปุ่ม “+ playlist” ที่ผลลัพธ์ */
  onAdd?: (video: VideoItem) => void;
  /** id คลิปที่กดหัวใจไว้แล้ว */
  likedIds?: Set<string>;
  /** กดหัวใจที่ผลลัพธ์ (เข้า/ออกจาก playlist “ถูกใจ”) */
  onToggleLike?: (video: VideoItem) => void;
}

const MODES: { value: SearchMode; label: string }[] = [
  { value: "all", label: "All" },
  { value: "follow", label: "Dance Performance" },
  { value: "tutorial", label: "Practice" },
];

export default function YouTubeSearch({ language = "English", inline = false, inlineActive = true, inlineResultsOnPage = false, onInlineQueryChange, activeId, onSelect, onAdd, likedIds, onToggleLike }: Props) {
  const th = language === "ไทย";
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("all");
  const [results, setResults] = useState<VideoItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [inlineResultsTarget, setInlineResultsTarget] = useState<HTMLElement | null>(null);
  const visibleResults = results;

  const rootRef = useRef<HTMLElement>(null);
  const inlineResultsTargetRef = useRef<HTMLElement | null>(null);
  const inlineResultsOnPageRef = useRef(inlineResultsOnPage);
  inlineResultsOnPageRef.current = inlineResultsOnPage;
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!inline) return;
    const target = document.getElementById("practice-search-results-host");
    inlineResultsTargetRef.current = target;
    setInlineResultsTarget(target);
  }, [inline, inlineActive]);
  const closeResults = useCallback(() => {
    setResultsOpen(false);
    onInlineQueryChange?.(null);
    if (inline && window.history.state?.mv) {
      window.history.replaceState({
        ...window.history.state,
        mv: { ...window.history.state.mv, practiceSearchQuery: null },
      }, "");
    }
  }, [inline, onInlineQueryChange]);
  useEffect(() => () => controller.current?.abort(), []);

  useEffect(() => {
    if (!inline) return;
    const onPopState = () => {
      const activeQuery = window.history.state?.mv?.practiceSearchQuery ?? null;
      setResultsOpen(Boolean(activeQuery));
      onInlineQueryChange?.(activeQuery);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [inline, onInlineQueryChange]);

  useEffect(() => {
    if (!resultsOpen || (inline && !inlineActive)) return;
    const onPointerDown = (event: PointerEvent) => {
      // Results rendered as part of the practice page stay visible when the
      // user clicks elsewhere on that page; only the close button/Escape hides them.
      if (inline && inlineResultsOnPageRef.current) return;
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !inlineResultsTargetRef.current?.contains(event.target)) {
        closeResults();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeResults();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [resultsOpen, inline, inlineActive, closeResults]);

  async function search(nextMode: SearchMode = mode) {
    const q = query.trim();
    if (!q) return;
    setResultsOpen(true);
    if (inline) {
      onInlineQueryChange?.(q);
      if (window.history.state?.mv) {
        const nextState = { ...window.history.state, mv: { ...window.history.state.mv, practiceSearchQuery: q } };
        if (window.history.state.mv.practiceSearchQuery) window.history.replaceState(nextState, "");
        else window.history.pushState(nextState, "");
      }
    }
    const requestId = ++request.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setResults(null);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}&mode=${nextMode}`, { signal: ac.signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "ค้นหาไม่สำเร็จ");
      if (requestId === request.current) setResults(json.items);
    } catch (err) {
      if (requestId !== request.current || ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : "ค้นหาไม่สำเร็จ");
      setResults(null);
    } finally {
      if (requestId === request.current) setLoading(false);
    }
  }

  const resultsPanel = resultsOpen && (!inline || inlineActive) ? <div className={inline ? (inlineResultsOnPage ? "practice-page-results" : "header-search-results practice-search-results") : "header-search-results"}>
    {inline && <div className="practice-results-heading"><span className="eyebrow">{th ? "ผลการค้นหา" : "SEARCH RESULTS"}</span><p>{th ? `ผลลัพธ์สำหรับ “${query.trim()}”` : `Results for “${query.trim()}”`}</p></div>}
    <div className={inline ? "practice-results-filters" : "header-search-results__top"}>
      <fieldset aria-label={th ? "ประเภทวิดีโอ" : "Video type"}>
        {MODES.map((m) => (
          <label key={m.value}>
            <input
              type="radio"
              name="mode"
              checked={mode === m.value}
              onChange={() => {
                setMode(m.value);
                if (results !== null || loading) search(m.value);
              }}
            />{" "}{th ? ({ all: "ทั้งหมด", follow: "เต้นตาม", tutorial: "สอนเต้น" }[m.value]) : m.label}
          </label>
        ))}
      </fieldset>
      <button className="header-search-results__close" type="button" onClick={closeResults} aria-label={th ? "ปิดผลการค้นหา" : "Close search results"} title={th ? "ปิดผลการค้นหา" : "Close search results"}>×</button>
    </div>

    {loading && <p>{th ? "กำลังค้นหา…" : "Searching…"}</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && visibleResults?.length === 0 && <p>{th ? "ไม่พบคลิปที่ตรงกับตัวกรองนี้ ลองเลือกประเภทอื่นหรือเปลี่ยนคำค้นหา" : "No videos match this filter. Try another category or search term."}</p>}

    {onAdd && results && results.length > 0 && !inline && <p><small>{th ? "กด “+ playlist” แล้วเลือกเพลย์ลิสต์ที่จะเพิ่มคลิป" : 'Click “+ playlist” and choose where to add the clip.'}</small></p>}

    {inline && visibleResults && visibleResults.length > 0 && <ul className="practice-result-grid" style={{ listStyle: "none", padding: 0 }}>
      {visibleResults.map((v) => <li className="practice-result-card" key={v.id}>
        <div className="practice-result-thumb">
          <button className="practice-result-play" type="button" onClick={() => { onSelect(v); closeResults(); }} aria-label={`Play ${v.title}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={v.thumbnail} alt="" loading="lazy" />
            <i aria-hidden="true">▶</i>
          </button>
          {onToggleLike && <span className="practice-result-heart"><HeartButton liked={likedIds?.has(v.id) ?? false} onClick={() => onToggleLike(v)} /></span>}
        </div>
        <div className="practice-result-info"><strong className="youtube-origin" title={v.title}>{v.title}</strong><small className="youtube-origin">{v.channel}{v.durationSec > 0 ? ` · ${formatTime(v.durationSec)}` : ""}</small>
          {onAdd && <button type="button" onClick={() => onAdd(v)}>+ playlist</button>}
        </div>
      </li>)}
    </ul>}

    {!inline && results && results.length > 0 && <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: "0.5rem" }}>
      {results.map((v) => (
        <li key={v.id} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
          <button type="button" onClick={() => { onSelect(v); setResultsOpen(false); }} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", textAlign: "left", flex: 1, fontWeight: v.id === activeId ? 700 : 400 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={v.thumbnail} alt="" width={120} height={68} loading="lazy" />
            <span className="youtube-origin">{v.title}<br /><small>{v.channel}{v.durationSec > 0 ? ` · ${formatTime(v.durationSec)}` : ""}</small></span>
          </button>
          {onToggleLike && <HeartButton liked={likedIds?.has(v.id) ?? false} onClick={() => onToggleLike(v)} />}
          {onAdd && <button type="button" onClick={() => onAdd(v)} style={{ whiteSpace: "nowrap" }}>+ playlist</button>}
        </li>
      ))}
    </ul>}
  </div> : null;

  return (
    <section ref={rootRef} className={inline ? "practice-search-widget" : undefined}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (!loading) void search();
          }}
          placeholder={th ? "ค้นหาเพลง ศิลปิน หรือวิดีโอเต้น" : "Search songs, artists, or dance videos"}
          aria-label={th ? "ค้นหาเพลง ศิลปิน หรือวิดีโอเต้น" : "Search songs, artists, or dance videos"}
          style={{ width: "min(420px, 70%)" }}
        />{" "}
        <button type="submit" disabled={loading || !query.trim()}>
          {th ? "ค้นหา" : "Search"}
        </button>
      </form>

      {(!inline || !inlineResultsOnPage) && resultsPanel}
      {inline && inlineResultsOnPage && inlineActive && inlineResultsTarget && resultsPanel && createPortal(resultsPanel, inlineResultsTarget)}
    </section>
  );
}
