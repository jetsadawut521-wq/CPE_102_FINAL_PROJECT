import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reasons = new Set(["timeout", "download-timeout", "download-failed", "download-rejected", "decode-failed",
  "dependency-missing", "tool-missing", "analysis-failed", "invalid-result", "invalid-stage-corners"]);

export async function POST(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v") ?? "";
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return NextResponse.json({ error: "id คลิปไม่ถูกต้อง" }, { status: 400 });
  let body: { stageCorners?: Array<{ x: number; y: number }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "ต้องกำหนดมุมพื้นเวที 4 จุดก่อนวิเคราะห์" }, { status: 400 });
  }
  const corners = body?.stageCorners;
  if (!Array.isArray(corners) || corners.length !== 4 || !corners.every((point) =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) {
    return NextResponse.json({ error: "ตำแหน่งมุมพื้นเวทีไม่ถูกต้อง" }, { status: 400 });
  }
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
      headers: { "Content-Type": "application/json", ...(process.env.AUDIO_ANALYSIS_TOKEN ? { Authorization: `Bearer ${process.env.AUDIO_ANALYSIS_TOKEN}` } : {}) },
      body: JSON.stringify({ stageCorners: corners }) });
    if (response.status === 429) return NextResponse.json({ status: "busy", engine: "formation-v15", formations: [] });
    if (!response.ok) throw new Error("Formation service unavailable");
    const data = await response.json();
    if (!["queued", "processing", "ready", "failed"].includes(data.status)) throw new Error("Invalid formation job response");
    const formations = data.status === "ready" && Array.isArray(data.formations) ? data.formations : [];
    return NextResponse.json({ status: data.status, engine: "formation-v15",
      ...(data.stage ? { stage: data.stage } : {}),
      ...(data.status === "failed" && reasons.has(data.reason) ? { reason: data.reason } : {}), formations });
  } catch {
    return NextResponse.json({ status: "failed", reason: "worker-unavailable", formations: [] });
  }
}
