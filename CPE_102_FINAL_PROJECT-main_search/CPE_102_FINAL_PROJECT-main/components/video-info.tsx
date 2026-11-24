"use client";

import { useEffect, useState } from "react";

interface VideoInfoData {
  title: string;
  channel: string;
  description: string;
  publishedAt: string;
  viewCount: string | null;
  likeCount: string | null;
}

interface VideoInfoProps {
  videoId: string;
  fallbackTitle: string;
  fallbackChannel: string;
  language?: string;
}

const countFormat = new Intl.NumberFormat("th-TH");

export default function VideoInfo({ videoId, fallbackTitle, fallbackChannel, language = "English" }: VideoInfoProps) {
  const th = language === "ไทย";
  const [info, setInfo] = useState<VideoInfoData | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setInfo(null);
    setError("");
    setExpanded(false);

    fetch(`/api/youtube/metadata?id=${encodeURIComponent(videoId)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "โหลดข้อมูลคลิปไม่สำเร็จ");
        return data as VideoInfoData;
      })
      .then(setInfo)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "โหลดข้อมูลคลิปไม่สำเร็จ");
      });

    return () => controller.abort();
  }, [videoId]);

  const description = info?.description?.trim() ?? "";
  const hasMore = description.length > 260;

  return (
    <section className="video-info" aria-label={th ? "ข้อมูลคลิป" : "Video information"}>
      <div className="video-info-heading">
        <div>
          <span className="eyebrow">{th ? "ข้อมูลคลิป" : "VIDEO INFO"}</span>
          <h3 className="youtube-origin">{info?.title || fallbackTitle}</h3>
          <p className="youtube-origin">{info?.channel || fallbackChannel}</p>
        </div>
        <div className="video-info-stats" aria-label={th ? "สถิติคลิป" : "Video statistics"}>
          <span><strong>{info?.viewCount ? countFormat.format(Number(info.viewCount)) : "—"}</strong><small>{th ? "ยอดดู" : "Views"}</small></span>
          <span><strong>{info?.likeCount ? countFormat.format(Number(info.likeCount)) : "—"}</strong><small>{th ? "ถูกใจ" : "Likes"}</small></span>
        </div>
      </div>
      {error ? (
        <p className="video-info-note">{error}</p>
      ) : info ? (
        <>
          <p className={`video-info-description youtube-origin${expanded ? " is-expanded" : ""}`}>
            {description || (th ? "คลิปนี้ไม่มีคำอธิบาย" : "This video has no description.")}
          </p>
          {hasMore && <button className="video-info-more" type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? (th ? "ย่อน้อยลง" : "Show less") : (th ? "...เพิ่มเติม" : "...More")}</button>}
        </>
      ) : (
        <p className="video-info-note">{th ? "กำลังโหลดข้อมูลคลิป…" : "Loading video information…"}</p>
      )}
    </section>
  );
}
