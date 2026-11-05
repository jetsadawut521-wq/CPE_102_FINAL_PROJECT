import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reasons = new Set(["timeout", "download-timeout", "download-failed", "download-rejected", "decode-failed",
  "dependency-missing", "tool-missing", "analysis-failed", "invalid-result"]);

export async function POST(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return NextResponse.json({ error: "id คลิปไม่ถูกต้อง" }, { status: 400 });
  const service = process.env.AUDIO_ANALYSIS_URL;
  if (!service) return NextResponse.json({ status: "failed", reason: "worker-unavailable", formations: [] });
  try {
    const url = new URL(service);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!["http:", "https:"].includes(url.protocol) || (!local && (url.protocol !== "https:" || !process.env.AUDIO_ANALYSIS_TOKEN))) {
      throw new Error("Invalid service configuration");
    }
    url.pathname = `/formations/${videoId}`;
    url.search = "";
    const response = await fetch(url, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(5000), redirect: "error",
      headers: process.env.AUDIO_ANALYSIS_TOKEN ? { Authorization: `Bearer ${process.env.AUDIO_ANALYSIS_TOKEN}` } : {} });
    if (response.status === 429) return NextResponse.json({ status: "busy", engine: "formation-v1", formations: [] });
    if (!response.ok) throw new Error("Formation service unavailable");
    const data = await response.json();
    if (!["queued", "processing", "ready", "failed"].includes(data.status)) throw new Error("Invalid formation job response");
    const formations = data.status === "ready" && Array.isArray(data.formations) ? data.formations : [];
    return NextResponse.json({ status: data.status, engine: "formation-v1",
      ...(data.stage ? { stage: data.stage } : {}),
      ...(data.status === "failed" && reasons.has(data.reason) ? { reason: data.reason } : {}), formations });
  } catch {
    return NextResponse.json({ status: "failed", reason: "worker-unavailable", formations: [] });
  }
}
