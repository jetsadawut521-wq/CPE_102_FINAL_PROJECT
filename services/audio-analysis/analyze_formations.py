"""Build a stable, timestamped formation timeline from a YouTube practice clip."""
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from collections import Counter
from pathlib import Path

PERSON_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/float32/1/efficientdet_lite2.tflite"
POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
MAX_DURATION = 900
SAMPLE_FPS = 1


def set_stage(root, stage):
    (root / "stage").write_text(stage)


def cached_model(filename, url):
    root = Path(os.environ.get("FORMATION_MODEL_CACHE", str(Path.home() / ".cache" / "muverse-audio" / "models")))
    root.mkdir(parents=True, exist_ok=True)
    model = root / filename
    if not model.exists():
        temporary = model.with_suffix(".download")
        with urllib.request.urlopen(url, timeout=15) as response, temporary.open("wb") as destination:
            shutil.copyfileobj(response, destination)
        temporary.replace(model)
    return model


def person_model():
    return cached_model("efficientdet_lite2.tflite", PERSON_MODEL_URL)


def detector_frames(video_id, root):
    set_stage(root, "downloading")
    output = root / "clip.%(ext)s"
    command = [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress", "--no-warnings",
               "--ignore-config", *( ["--js-runtimes", "node"] if shutil.which("node") else [] ),
               "--socket-timeout", "15", "--retries", "1", "--extractor-retries", "1", "--fragment-retries", "1",
               "--max-filesize", "150M", "--match-filter", f"duration > 0 & duration <= {MAX_DURATION} & !is_live",
               "-f", "bestvideo[height<=360]+bestaudio/best[height<=360]/best",
               "-o", str(output), f"https://www.youtube.com/watch?v={video_id}"]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, timeout=180)
    videos = [path for path in root.glob("clip.*") if path.suffix not in (".part", ".ytdl", ".download")]
    if not videos:
        raise RuntimeError("download-rejected")
    video = videos[0]
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("tool-missing")
    set_stage(root, "extracting-frames")
    frames = root / "frames"
    frames.mkdir()
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(video), "-vf",
                    f"fps={SAMPLE_FPS},scale=640:360:force_original_aspect_ratio=decrease", "-q:v", "5",
                    "-threads", "1", str(frames / "%06d.jpg")], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    paths = sorted(frames.glob("*.jpg"))
    if not paths:
        raise RuntimeError("decode-failed")
    return paths


def point_distance(left, right):
    if len(left) != len(right):
        return 1.0
    if not left:
        return 0.0
    return sum(((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5 for a, b in zip(left, right)) / len(left)


def average_points(samples):
    size = len(samples[0])
    return [{"x": sum(sample[i]["x"] for sample in samples) / len(samples),
             "y": sum(sample[i]["y"] for sample in samples) / len(samples),
             "color": i % 6} for i in range(size)]


def collect_detections(paths, root):
    set_stage(root, "tracking-dancers")
    import mediapipe as mp
    import numpy as np
    from PIL import Image

    model = person_model()
    options = mp.tasks.vision.ObjectDetectorOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        max_results=16,
        # Dancers in wide practice-room shots can be small or partly occluded.
        # Keep lower-confidence person boxes, then reject implausibly small boxes
        # below before they affect the group-size estimate.
        score_threshold=0.15,
        category_allowlist=["person"],
    )
    samples = []
    with mp.tasks.vision.ObjectDetector.create_from_options(options) as detector:
        for index, path in enumerate(paths):
            with Image.open(path) as image:
                rgb = np.asarray(image.convert("RGB"))
            height, width = rgb.shape[:2]
            result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            candidates = []
            for detection in result.detections:
                category = detection.categories[0] if detection.categories else None
                box = detection.bounding_box
                if not category or (category.category_name or "").lower() != "person" or not box:
                    continue
                left = max(0, box.origin_x) / width
                top = max(0, box.origin_y) / height
                right = min(width, box.origin_x + box.width) / width
                bottom = min(height, box.origin_y + box.height) / height
                if right <= left or bottom <= top:
                    continue
                box_width = right - left
                box_height = bottom - top
                if box_height < 0.08 or box_width < 0.02:
                    continue
                # The bottom center approximates where the dancer meets the floor;
                # a fixed 92% offset floats dots above the floor by different
                # amounts as bounding-box heights change with pose and distance.
                candidates.append({"x": (left + right) / 2, "y": bottom,
                                   "score": category.score, "box": (left, top, right, bottom)})
            candidates.sort(key=lambda point: point["score"], reverse=True)
            detections = []
            for candidate in candidates:
                duplicate = False
                for accepted in detections:
                    a = candidate["box"]
                    b = accepted["box"]
                    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
                    area_a = (a[2] - a[0]) * (a[3] - a[1])
                    area_b = (b[2] - b[0]) * (b[3] - b[1])
                    iou = intersection / max(area_a + area_b - intersection, 1e-8)
                    if iou > 0.65:
                        duplicate = True
                        break
                if not duplicate:
                    detections.append(candidate)
            detections.sort(key=lambda point: point["x"])
            detections = [{"x": point["x"], "y": point["y"]} for point in detections]
            samples.append({"index": index, "time": index / SAMPLE_FPS, "points": detections})
    return samples


def build_timeline(samples):
    # Collapse frame-level jitter into stable layouts. A transition is accepted
    # only after three successive samples agree on dancer count and geometry.
    if not samples:
        return []
    frame_counts = [len(sample["points"]) for sample in samples]
    counts = Counter(count for count in frame_counts if count >= 2)
    if not counts:
        return []
    # Prefer the largest count that is repeatedly supported in nearby samples.
    # A clip-wide mode systematically undercounts when a dancer is often hidden
    # behind another dancer; requiring 3 detections within a 5-second window
    # avoids letting a one-frame false positive increase the roster.
    supported_counts = set()
    for start in range(max(1, len(frame_counts) - 4)):
        window = frame_counts[start:start + 5]
        window_counts = Counter(count for count in window if count >= 2)
        supported_counts.update(count for count, frequency in window_counts.items() if frequency >= 3)
    target_count = max(supported_counts) if supported_counts else max(counts, key=lambda count: (counts[count], count))
    print(json.dumps({"formation_counts": dict(sorted(counts.items())),
                      "persistent_counts": sorted(supported_counts), "selected_count": target_count}), file=sys.stderr, flush=True)
    layouts = []
    current = None
    candidate = []
    for sample in samples:
        points = sample["points"]
        if len(points) != target_count:
            continue
        if current is None:
            if candidate and point_distance(candidate[-1]["points"], points) <= 0.16:
                candidate.append(sample)
            else:
                candidate = [sample]
            if len(candidate) >= 2:
                current = candidate[:]
                layouts.append({"time": candidate[0]["time"], "points": average_points([item["points"] for item in candidate]),
                                "sample_indexes": [item["index"] for item in candidate]})
                candidate = []
            continue
        reference = average_points([item["points"] for item in current[-3:]])
        if point_distance(reference, points) <= 0.12:
            current.append(sample)
            candidate = []
        else:
            if candidate and point_distance(candidate[-1]["points"], points) <= 0.16:
                candidate.append(sample)
            else:
                candidate = [sample]
            if len(candidate) >= 3:
                current = candidate[:]
                layouts.append({"time": candidate[0]["time"], "points": average_points([item["points"] for item in candidate]),
                                "sample_indexes": [item["index"] for item in candidate]})
                candidate = []
    return layouts


def pose_positions(landmarks):
    points = []
    for pose in landmarks:
        hips = [pose[index] for index in (23, 24)
                if getattr(pose[index], "visibility", 1.0) is None or pose[index].visibility >= 0.2]
        ankles = [pose[index] for index in (27, 28, 29, 30, 31, 32)
                  if getattr(pose[index], "visibility", 1.0) is None or pose[index].visibility >= 0.2]
        if not hips or not ankles:
            continue
        points.append({"x": min(1.0, max(0.0, sum(item.x for item in hips) / len(hips))),
                       "y": min(1.0, max(0.0, max(item.y for item in ankles)))}
                      )
    return sorted(points, key=lambda point: point["x"])


def refine_formation_positions(formations, samples, paths, root):
    if not formations:
        return formations
    import mediapipe as mp
    import numpy as np
    from PIL import Image

    set_stage(root, "refining-positions")
    model = cached_model("pose_landmarker_lite.task", POSE_MODEL_URL)
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_poses=10,
        min_pose_detection_confidence=0.3,
        min_pose_presence_confidence=0.3,
    )
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as landmarker:
        for formation in formations:
            refined = []
            # Layouts are accepted after a few stable samples. Refine only those
            # representative frames instead of running pose inference on the clip.
            for index in formation.pop("sample_indexes", []):
                with Image.open(paths[index]) as image:
                    rgb = np.asarray(image.convert("RGB"))
                result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
                points = pose_positions(result.pose_landmarks)
                if len(points) == len(formation["points"]):
                    refined.append(points)
                else:
                    print(f"[formation-pose] pose-count-mismatch expected={len(formation['points'])} detected={len(points)} time={formation['time']}",
                          file=sys.stderr, flush=True)
                if len(refined) >= 3:
                    break
            if refined:
                formation["points"] = average_points(refined)
    return formations


def analyze(video_id, root):
    if os.name == "posix":
        try:
            os.nice(10)
        except OSError:
            pass
    frames = detector_frames(video_id, root)
    samples = collect_detections(frames, root)
    formations = build_timeline(samples)
    try:
        formations = refine_formation_positions(formations, frames, root)
    except Exception as error:
        print(f"[formation-pose] optional position refinement skipped: {error}", file=sys.stderr, flush=True)
        for formation in formations:
            formation.pop("sample_indexes", None)
    return {"engine": "formation-v1", "formations": formations}


if __name__ == "__main__":
    import re
    import traceback
    if len(sys.argv) != 3 or not re.fullmatch(r"[A-Za-z0-9_-]{11}", sys.argv[1]):
        raise SystemExit("Invalid video ID")
    root = Path(sys.argv[2])
    try:
        print(json.dumps(analyze(sys.argv[1], root), separators=(",", ":")))
    except subprocess.TimeoutExpired:
        print(json.dumps({"error": "download-timeout" if (root / "stage").read_text().strip() == "downloading" else "decode-failed"}))
        raise SystemExit(1)
    except subprocess.CalledProcessError:
        stage = (root / "stage").read_text().strip()
        print(json.dumps({"error": "download-failed" if stage == "downloading" else "decode-failed"}))
        raise SystemExit(1)
    except Exception as error:
        stage = (root / "stage").read_text().strip() if (root / "stage").exists() else "unknown"
        reason = "dependency-missing" if isinstance(error, (ImportError, ModuleNotFoundError)) else "analysis-failed"
        if str(error) in ("download-rejected", "tool-missing"):
            reason = str(error)
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": reason, "stage": stage}))
        raise SystemExit(1)
