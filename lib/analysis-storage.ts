import type { AutoSegment } from "@/lib/highlight-analysis";
import recommendedSeed from "@/data/recommended-playlists.json";

export interface FormationPoint {
  x: number;
  y: number;
  color: number;
  track_id?: number;
  name?: string;
}

export interface FormationSnapshot {
  time: number;
  points: FormationPoint[];
}

const HIGHLIGHT_KEY = "muverse:analyzed-highlights:v1";
const FORMATION_KEY = "muverse:saved-formations:v1";
const CALIBRATION_KEY = "muverse:stage-calibration:v1";
const bundledAnalysis = recommendedSeed as {
  highlights: Record<string, { segments: AutoSegment[]; manuallyEdited?: boolean }>;
  formations: Record<string, { formations: FormationSnapshot[] }>;
};

function readMap<T>(key: string): Record<string, T> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, T> : {};
  } catch {
    return {};
  }
}

function writeMap<T>(key: string, map: Record<string, T>) {
  try {
    window.localStorage.setItem(key, JSON.stringify(map));
    window.dispatchEvent(new Event("muverse:analysis-updated"));
  } catch { /* storage may be full/disabled */ }
}

export function readSavedHighlights(videoId: string): AutoSegment[] | null {
  const saved = readMap<{ segments?: AutoSegment[] }>(HIGHLIGHT_KEY);
  const value = Object.prototype.hasOwnProperty.call(saved, videoId) ? saved[videoId] : bundledAnalysis.highlights[videoId];
  return value && Array.isArray(value.segments) ? value.segments : null;
}

export function saveAnalyzedHighlights(videoId: string, segments: AutoSegment[]) {
  const map = readMap<{ segments: AutoSegment[]; savedAt: number }>(HIGHLIGHT_KEY);
  map[videoId] = { segments, savedAt: Date.now() };
  writeMap(HIGHLIGHT_KEY, map);
}

export function hasEditedHighlights(videoId: string): boolean {
  const saved = readMap<{ manuallyEdited?: boolean }>(HIGHLIGHT_KEY);
  const value = Object.prototype.hasOwnProperty.call(saved, videoId) ? saved[videoId] : bundledAnalysis.highlights[videoId];
  return value?.manuallyEdited === true;
}

export function saveEditedHighlights(videoId: string, segments: AutoSegment[]) {
  const map = readMap<{ segments: AutoSegment[]; savedAt: number; manuallyEdited?: boolean }>(HIGHLIGHT_KEY);
  map[videoId] = { segments, savedAt: Date.now(), manuallyEdited: true };
  writeMap(HIGHLIGHT_KEY, map);
}

export function readSavedFormations(videoId: string): FormationSnapshot[] | null {
  const saved = readMap<{ formations?: FormationSnapshot[] }>(FORMATION_KEY);
  const value = Object.prototype.hasOwnProperty.call(saved, videoId) ? saved[videoId] : bundledAnalysis.formations[videoId];
  if (!value || !Array.isArray(value.formations)) return null;
  return value.formations.filter((entry) => Number.isFinite(entry?.time) && Array.isArray(entry.points) &&
    entry.points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y) &&
      Number.isFinite(point?.color) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
}

export function saveFormations(videoId: string, formations: FormationSnapshot[]) {
  const map = readMap<{ formations: FormationSnapshot[]; savedAt: number }>(FORMATION_KEY);
  map[videoId] = { formations, savedAt: Date.now() };
  writeMap(FORMATION_KEY, map);
}

export interface StageCorner { x: number; y: number }

export function readStageCalibration(videoId: string): StageCorner[] | null {
  const corners = readMap<StageCorner[]>(CALIBRATION_KEY)[videoId];
  return Array.isArray(corners) && corners.length === 4 && corners.every((point) =>
    Number.isFinite(point?.x) && Number.isFinite(point?.y)) ? corners : null;
}

export function saveStageCalibration(videoId: string, corners: StageCorner[]) {
  const map = readMap<StageCorner[]>(CALIBRATION_KEY);
  map[videoId] = corners;
  writeMap(CALIBRATION_KEY, map);
}

export function removeVideoAnalysis(videoId: string) {
  const highlights = readMap<{ segments: AutoSegment[]; savedAt: number; manuallyEdited?: boolean }>(HIGHLIGHT_KEY);
  if (bundledAnalysis.highlights[videoId]) highlights[videoId] = { segments: [], savedAt: Date.now(), manuallyEdited: true };
  else delete highlights[videoId];
  writeMap(HIGHLIGHT_KEY, highlights);

  const formations = readMap<{ formations: FormationSnapshot[]; savedAt: number }>(FORMATION_KEY);
  if (bundledAnalysis.formations[videoId]) formations[videoId] = { formations: [], savedAt: Date.now() };
  else delete formations[videoId];
  writeMap(FORMATION_KEY, formations);

  const calibrations = readMap<unknown>(CALIBRATION_KEY);
  delete calibrations[videoId];
  writeMap(CALIBRATION_KEY, calibrations);
}
