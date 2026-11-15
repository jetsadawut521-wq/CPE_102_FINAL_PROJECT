import { NextRequest, NextResponse } from "next/server";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3/videos";

export async function GET(request: NextRequest) {
  const videoId = request.nextUrl.searchParams.get("id")?.trim();
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "รหัสคลิป YouTube ไม่ถูกต้อง" }, { status: 400 });
  }

  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    return NextResponse.json({ error: "ยังไม่ได้ตั้งค่า YOUTUBE_API_KEY ใน .env.local" }, { status: 503 });
  }

  const url = new URL(YOUTUBE_API);
  url.search = new URLSearchParams({ part: "snippet,statistics", id: videoId, key }).toString();

  try {
    const response = await fetch(url, { next: { revalidate: 3600 } });
    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json({ error: data?.error?.message ?? "โหลดข้อมูลคลิปไม่สำเร็จ" }, { status: response.status });
    }

    const video = data.items?.[0];
    if (!video) return NextResponse.json({ error: "ไม่พบข้อมูลคลิปนี้" }, { status: 404 });

    return NextResponse.json({
      title: video.snippet?.title ?? "",
      channel: video.snippet?.channelTitle ?? "",
      description: video.snippet?.description ?? "",
      publishedAt: video.snippet?.publishedAt ?? "",
      viewCount: video.statistics?.viewCount ?? null,
      likeCount: video.statistics?.likeCount ?? null,
    });
  } catch {
    return NextResponse.json({ error: "เชื่อมต่อ YouTube เพื่อโหลดข้อมูลคลิปไม่ได้" }, { status: 502 });
  }
}
