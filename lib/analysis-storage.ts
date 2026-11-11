import type { AutoSegment } from "@/lib/highlight-analysis";

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
  const value = readMap<{ segments?: AutoSegment[] }>(HIGHLIGHT_KEY)[videoId];
  return value && Array.isArray(value.segments) ? value.segments : null;
}

export function saveAnalyzedHighlights(videoId: string, segments: AutoSegment[]) {
  const map = readMap<{ segments: AutoSegment[]; savedAt: number }>(HIGHLIGHT_KEY);
  map[videoId] = { segments, savedAt: Date.now() };
  writeMap(HIGHLIGHT_KEY, map);
}

export function hasEditedHighlights(videoId: string): boolean {
  return readMap<{ manuallyEdited?: boolean }>(HIGHLIGHT_KEY)[videoId]?.manuallyEdited === true;
}

export function saveEditedHighlights(videoId: string, segments: AutoSegment[]) {
  const map = readMap<{ segments: AutoSegment[]; savedAt: number; manuallyEdited?: boolean }>(HIGHLIGHT_KEY);
  map[videoId] = { segments, savedAt: Date.now(), manuallyEdited: true };
  writeMap(HIGHLIGHT_KEY, map);
}

export function readSavedFormations(videoId: string): FormationSnapshot[] | null {
  const value = readMap<{ formations?: FormationSnapshot[] }>(FORMATION_KEY)[videoId];
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
  for (const key of [HIGHLIGHT_KEY, FORMATION_KEY, CALIBRATION_KEY]) {
    const map = readMap<unknown>(key);
    delete map[videoId];
    writeMap(key, map);
  }
}
