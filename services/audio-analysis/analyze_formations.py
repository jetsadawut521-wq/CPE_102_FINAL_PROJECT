"""Build a stable, timestamped formation timeline from a YouTube practice clip."""
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from collections import Counter
from pathlib import Path

POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
MAX_DURATION = 900
SAMPLE_FPS = 1


def set_stage(root, stage):
    (root / "stage").write_text(stage)


def pose_model():
    root = Path(os.environ.get("FORMATION_MODEL_CACHE", str(Path.home() / ".cache" / "muverse-audio" / "models")))
    root.mkdir(parents=True, exist_ok=True)
    model = root / "pose_landmarker_lite.task"
    if not model.exists():
        temporary = model.with_suffix(".download")
        with urllib.request.urlopen(POSE_MODEL_URL, timeout=30) as response, temporary.open("wb") as destination:
            shutil.copyfileobj(response, destination)
        temporary.replace(model)
    return model


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

    model = pose_model()
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_poses=12,
        min_pose_detection_confidence=0.45,
        min_pose_presence_confidence=0.45,
        min_tracking_confidence=0.45,
    )
    samples = []
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
        for index, path in enumerate(paths):
            with Image.open(path) as image:
                rgb = np.asarray(image.convert("RGB"))
            result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            detections = []
            for landmarks in result.pose_landmarks:
                # Use visible ankle keypoints as the dancer's floor anchor.
                # Bounding-box edges and swinging toes drift during dance moves.
                feet = [landmarks[i] for i in (27, 28)
                        if i < len(landmarks) and (getattr(landmarks[i], "visibility", 0) or 0) >= 0.35
                        and 0 <= landmarks[i].x <= 1 and 0 <= landmarks[i].y <= 1]
                if not feet:
                    continue
                detections.append({"x": max(0.02, min(0.98, sum(point.x for point in feet) / len(feet))),
                                   "y": max(0.04, min(0.96, sum(point.y for point in feet) / len(feet)))})
            detections.sort(key=lambda point: point["x"])
            samples.append({"time": index / SAMPLE_FPS, "points": detections})
    return samples


def build_timeline(samples):
    # Collapse frame-level jitter into stable layouts. A transition is accepted
    # only after three successive samples agree on dancer count and geometry.
    if not samples:
        return []
    counts = Counter(len(sample["points"]) for sample in samples if len(sample["points"]) >= 2)
    if not counts:
        return []
    # A practice group normally has a fixed roster. Use the most frequently
    # detected group size for the whole clip so a brief occlusion cannot add or
    # remove dots from the map.
    target_count = max(counts, key=lambda count: (counts[count], count))
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
                layouts.append({"time": candidate[0]["time"], "points": average_points([item["points"] for item in candidate])})
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
                layouts.append({"time": candidate[0]["time"], "points": average_points([item["points"] for item in candidate])})
                candidate = []
    return layouts


def analyze(video_id, root):
    if os.name == "posix":
        try:
            os.nice(10)
        except OSError:
            pass
    frames = detector_frames(video_id, root)
    samples = collect_detections(frames, root)
    return {"engine": "formation-v1", "formations": build_timeline(samples)}


if __name__ == "__main__":
    import re
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
        print(json.dumps({"error": reason, "stage": stage}))
        raise SystemExit(1)
