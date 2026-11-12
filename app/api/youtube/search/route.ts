// app/api/youtube/search/route.tshttps://github.com/jetsadawut521-wq/CPE_102_FINAL_PROJECT/blob/search_ml/app/api/youtube/search/route.ts
// ค้นหาวิดีโอจาก YouTube Data API v3 ฝั่งเซิร์ฟเวอร์ เพื่อไม่ให้ API key รั่วไปที่เบราว์เซอร์
import { NextRequest, NextResponse } from "next/server";
import { classifyVideo } from "@/lib/search-category";
import { classifyVideosWithML } from "@/lib/search/ml-classifier";
import type {
  VideoMetadata,
  VideoClassification,
  VideoCategory,
} from "@/lib/search/types";

export const runtime = "nodejs";
import type { VideoItem } from "@/lib/youtube";

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
  if (!["all", "follow", "tutorial"].includes(mode)) return NextResponse.json({ error: "ประเภทการค้นหาไม่ถูกต้อง" }, { status: 400 });
  if (!q) return NextResponse.json({ items: [] });

  try {
    // 1) ค้นหา (กินโควตา 100 หน่วยต่อครั้ง)
    const searchUrl = new URL(`${API}/search`);
    searchUrl.search = new URLSearchParams({
      part: "snippet",
      type: "video",
      maxResults: mode === "all" ? "12" : "50",
      videoEmbeddable: "true", // เอาเฉพาะคลิปที่ฝังเล่นได้
      safeSearch: "moderate",
      q,
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

    const ids: string[] = (searchJson.items ?? []).map(
      (it: { id: { videoId: string } }) => it.id.videoId
    );
    if (ids.length === 0) return NextResponse.json({ items: [] });

    // 2) ดึงความยาวคลิป (กินโควตา 1 หน่วย)
    const detailUrl = new URL(`${API}/videos`);
    detailUrl.search = new URLSearchParams({
      part: "snippet,contentDetails,status",
      id: ids.join(","),
      key,
    }).toString();
    const detailRes = await fetch(detailUrl, { next: { revalidate: 3600 } });
    const detailJson = await detailRes.json();

    if (!detailRes.ok) return NextResponse.json({ error: detailJson?.error?.message ?? "ดึงข้อมูลคลิปไม่สำเร็จ" }, { status: detailRes.status });

    
const durations = new Map<string, number>();
const embeddable = new Set<string>();
const detailById = new Map<string, any>();

for (const v of detailJson.items || []) {
  detailById.set(v.id, v);

  durations.set(
    v.id,
    parseDuration(v.contentDetails.duration)
  );

  if (v.status.embeddable) {
    embeddable.add(v.id);
  }
}

const searchItems = searchJson.items || [];

const mlEnabled = process.env.MUVERSE_ML_ENABLED === "true";

const classifications = new Map<
  string,
  VideoClassification
>();

// ML classification
if (mlEnabled) {
  const metadata: VideoMetadata[] = searchItems.map((it: any) => {
    const details = detailById.get(it.id.videoId);

    return {
      id: it.id.videoId,
      title: decodeEntities(it.snippet.title || ""),
      description: decodeEntities(
        details?.snippet?.description ||
        it.snippet.description ||
        ""
      ),
      tags: details?.snippet?.tags || [],
    };
  });

  try {
    const mlResults = await classifyVideosWithML(metadata);

    for (const [id, result] of mlResults) {
      classifications.set(id, result);
    }
  } catch (error) {
    console.error("ML classification failed:", error);

    return NextResponse.json(
      { error: "ระบบวิเคราะห์วิดีโอด้วย ML ยังไม่พร้อมใช้งาน" },
      { status: 503 }
    );
  }
}

// Legacy regex fallback when ML is disabled
else {
  for (const it of searchItems) {
    const id = it.id.videoId;
    const details = detailById.get(id);

    const category = classifyVideo(
      decodeEntities(it.snippet.title || ""),
      details?.snippet?.tags || [],
      decodeEntities(
        details?.snippet?.description ||
        it.snippet.description ||
        ""
      )
    );

    // Legacy classifier cannot reliably distinguish
    // relevant "other" videos from irrelevant videos.
    classifications.set(id, {
      relevant: true,
      category,
      relevanceScore: 0,
      irrelevantScore: 0,
      categoryScore: 0,
    });
  }
}

const items: VideoItem[] = searchItems
  .filter((it: any) => {
    const id = it.id.videoId;
    const prediction = classifications.get(id);

    if (!embeddable.has(id) || !prediction) {
      return false;
    }

    // ML determines relevance when enabled.
    if (mlEnabled && !prediction.relevant) {
      return false;
    }

    // Apply the requested category filter.
    if (mode !== "all" && prediction.category !== mode) {
      return false;
    }

    return true;
  })
  .slice(0, 12)
  .map((it: any) => {
    const id = it.id.videoId;
    const prediction = classifications.get(id)!;

    return {
      id,
      title: decodeEntities(it.snippet.title),
      channel: decodeEntities(it.snippet.channelTitle),
      thumbnail:
        it.snippet.thumbnails.medium?.url ||
        it.snippet.thumbnails.default?.url ||
        "",
      durationSec: durations.get(id) || 0,
      category: prediction.category,
    };
  });

return NextResponse.json({ items });
