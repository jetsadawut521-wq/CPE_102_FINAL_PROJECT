// app/api/youtube/search/route.ts
// ค้นหาวิดีโอจาก YouTube Data API v3 ฝั่งเซิร์ฟเวอร์ เพื่อไม่ให้ API key รั่วไปที่เบราว์เซอร์
import { NextRequest, NextResponse } from "next/server";
import type { VideoItem } from "@/lib/youtube";
import { rankSearchResults } from "@/lib/search_ranker";
import type { VideoMetadata } from "@/lib/search/types";

export const runtime = "nodejs";

const API = "https://www.googleapis.com/youtube/v3";

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseDuration(iso: string): number {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export async function GET(req: NextRequest) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY ในไฟล์ .env.local" },
      { status: 500 }
    );
  }

  const q = req.nextUrl.searchParams.get("q")?.trim();
  const mode = req.nextUrl.searchParams.get("mode") ?? "all";
  if (!["all", "follow", "tutorial"].includes(mode)) {
    return NextResponse.json({ error: "ประเภทการค้นหาไม่ถูกต้อง" }, { status: 400 });
  }
  if (!q) return NextResponse.json({ items: [] });

  try {
    // Query Expansion: เติมคำว่า dance ถ้าในคำค้นหายังไม่มี
    const expandedQuery = /dance|เต้น|안무/i.test(q) ? q : `${q} dance`;

    // 1) ค้นหา (กินโควตา 100 หน่วยต่อครั้ง)
    const searchUrl = new URL(`${API}/search`);
    searchUrl.search = new URLSearchParams({
      part: "id",
      type: "video",
      maxResults: "50",
      videoEmbeddable: "true", // เอาเฉพาะคลิปที่ฝังเล่นได้
      safeSearch: "moderate",
      q: expandedQuery,
      key,
    }).toString();

    const searchRes = await fetch(searchUrl, { next: { revalidate: 3600 } });
    const searchJson = await searchRes.json();
    if (!searchRes.ok) {
      return NextResponse.json(
        { error: searchJson?.error?.message ?? "ค้นหาไม่สำเร็จ" },
        { status: searchRes.status }
      );
    }

    const ids: string[] = (searchJson.items ?? [])
      .map((it: { id?: { videoId?: string } }) => it.id?.videoId)
      .filter((id): id is string => Boolean(id));

    if (ids.length === 0) return NextResponse.json({ items: [] });

    // 2) ดึง snippet (เอา tags + description เต็ม), ความยาวคลิป และสถานะ embeddable (กินโควตา 1 หน่วย)
    const detailUrl = new URL(`${API}/videos`);
    detailUrl.search = new URLSearchParams({
      part: "snippet,contentDetails,status",
      id: ids.join(","),
      key,
    }).toString();

    const detailRes = await fetch(detailUrl, { next: { revalidate: 3600 } });
    const detailJson = await detailRes.json();

    if (!detailRes.ok) {
      return NextResponse.json(
        { error: detailJson?.error?.message ?? "ดึงข้อมูลคลิปไม่สำเร็จ" },
        { status: detailRes.status }
      );
    }

    const detailById = new Map<string, any>();
    const candidates: VideoMetadata[] = [];

    for (const v of detailJson.items ?? []) {
      // กรองเฉพาะคลิปที่ฝังเล่นได้จริง
      if (!v.status?.embeddable) continue;

      detailById.set(v.id, v);
      candidates.push({
        id: v.id,
        title: decodeEntities(v.snippet?.title ?? ""),
        description: decodeEntities(v.snippet?.description ?? ""),
        tags: v.snippet?.tags ?? [],
      });
    }

    // 3) รัน 3-Stage Hybrid Search & Ranking (Regex -> Zero-Shot ML -> Naive Bayes)
    const ranked = await rankSearchResults(candidates);

    // 4) กรองตาม mode (all / follow / tutorial) และแปลงกลับเป็นรูปแบบ VideoItem ของหน้าเว็บ
    const items: VideoItem[] = ranked
      .filter((video) => {
        if (mode === "all") return true;
        return video.classification.category === mode;
      })
      .map((video) => {
        const raw = detailById.get(video.id);
        const snippet = raw?.snippet ?? {};
        const thumbs = snippet.thumbnails ?? {};

        return {
          id: video.id,
          title: video.title,
          channelTitle: decodeEntities(snippet.channelTitle ?? ""),
          thumbnail:
            thumbs.high?.url ??
            thumbs.medium?.url ??
            thumbs.default?.url ??
            "",
          publishedAt: snippet.publishedAt ?? "",
          durationSec: parseDuration(raw?.contentDetails?.duration ?? ""),
          category: video.classification.category,
        } as VideoItem;
      });

    return NextResponse.json({ items });
  } catch (err) {
    console.error("YouTube search error:", err);
    return NextResponse.json(
      { error: "เกิดข้อผิดพลาดในการค้นหาวิดีโอ" },
      { status: 500 }
    );
  }
}
