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
# Two-second spacing roughly halves CPU inference for typical practice clips.
SAMPLE_FPS = 0.5


def set_stage(root, stage):
    (root / "stage").write_text(stage)


def stage_projection(corners):
    """Map four clicked floor corners to a normalized top-down stage plane."""
    import numpy as np

    source = np.asarray([[point["x"], point["y"]] for point in corners], dtype=float)
    target = np.asarray([[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]], dtype=float)
    # A correctly ordered convex quadrilateral is required; otherwise the
    # perspective transform can flip or collapse the floor map.
    edges = np.roll(source, -1, axis=0) - source
    cross = [edges[i, 0] * edges[(i + 1) % 4, 1] - edges[i, 1] * edges[(i + 1) % 4, 0] for i in range(4)]
    area = abs(sum(source[i, 0] * source[(i + 1) % 4, 1] - source[(i + 1) % 4, 0] * source[i, 1]
                   for i in range(4))) * 0.5
    if area < 0.02 or not (all(value > 1e-5 for value in cross) or all(value < -1e-5 for value in cross)):
        raise ValueError("invalid-stage-corners")
    equations = []
    values = []
    for (x, y), (u, v) in zip(source, target):
        equations.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        values.append(u)
        equations.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        values.append(v)
    try:
        matrix = np.linalg.solve(np.asarray(equations), np.asarray(values))
    except np.linalg.LinAlgError as error:
        raise ValueError("invalid-stage-corners") from error
    return np.append(matrix, 1).reshape(3, 3)


def project_samples(samples, transform, root):
    import numpy as np

    set_stage(root, "projecting-floor")
    for sample in samples:
        for point in sample["points"]:
            projected = transform @ np.asarray([point["x"], point["y"], 1.0])
            if abs(projected[2]) < 1e-8:
                continue
            point["x"] = min(1.0, max(0.0, float(projected[0] / projected[2])))
            point["y"] = min(1.0, max(0.0, float(projected[1] / projected[2])))
    return samples


def project_point(point, transform):
    import numpy as np

    projected = transform @ np.asarray([point["x"], point["y"], 1.0])
    if abs(projected[2]) < 1e-8:
        return None
    x, y = float(projected[0] / projected[2]), float(projected[1] / projected[2])
    # A bad ankle estimate outside the calibrated quadrilateral can explode
    # under perspective. Reject it and retain the detector-box fallback.
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        return None
    return {"x": x, "y": y}


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


def formation_distance(left, right):
    if len(left) != len(right):
        return 1.0
    distances = [((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5 for a, b in zip(left, right)]
    return 0.5 * (sum(distances) / len(distances)) + 0.5 * max(distances, default=0.0)


def average_points(samples):
    size = len(samples[0])
    return [{"x": sum(sample[i]["x"] for sample in samples) / len(samples),
             "y": sum(sample[i]["y"] for sample in samples) / len(samples),
             "color": samples[0][i].get("color", i % 10),
             "track_id": samples[0][i].get("track_id", i)} for i in range(size)]


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
                crop = rgb[int(top * height + box_height * height * 0.18):int(top * height + box_height * height * 0.65),
                           int(left * width + box_width * width * 0.25):int(left * width + box_width * width * 0.75)]
                appearance = crop.reshape(-1, 3).mean(axis=0).astype(float) / 255 if crop.size else np.zeros(3)
                # The bottom center approximates where the dancer meets the floor;
                # a fixed 92% offset floats dots above the floor by different
                # amounts as bounding-box heights change with pose and distance.
                candidates.append({"x": (left + right) / 2, "y": bottom,
                                   "score": category.score, "box": (left, top, right, bottom),
                                   "appearance": appearance.tolist()})
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
            samples.append({"index": index, "time": index / SAMPLE_FPS, "points": detections})
    return samples


def choose_target_count(samples):
    counts = Counter(len(sample["points"]) for sample in samples if len(sample["points"]) >= 2)
    if not counts:
        return 0
    supported = set()
    frame_counts = [len(sample["points"]) for sample in samples]
    for start in range(max(1, len(frame_counts) - 4)):
        window = Counter(count for count in frame_counts[start:start + 5] if count >= 2)
        supported.update(count for count, frequency in window.items() if frequency >= 3)
    target = max(counts, key=lambda count: (counts[count], count))
    print(json.dumps({"formation_counts": dict(sorted(counts.items())),
                      "persistent_counts": sorted(supported), "selected_count": target}), file=sys.stderr, flush=True)
    return target


def track_people(samples, target_count):
    from scipy.optimize import linear_sum_assignment
    import numpy as np

    tracks = []
    tracked_samples = []
    for sample in samples:
        detections = sample["points"]
        assignments = []
        if not tracks:
            if len(detections) < target_count:
                tracked_samples.append({**sample, "points": [], "assignments": []})
                continue
            initial = sorted(sorted(detections, key=lambda item: item["score"], reverse=True)[:target_count],
                             key=lambda item: item["x"])
            for track_id, detection in enumerate(initial):
                tracks.append({"id": track_id, "x": detection["x"], "y": detection["y"], "box": detection["box"],
                               "vx": 0.0, "vy": 0.0, "time": sample["time"],
                               "appearance": detection["appearance"], "missing": 0})
                assignments.append({"id": track_id, "point": {"x": detection["x"], "y": detection["y"]},
                                    "box": detection["box"], "observed": True})
        else:
            pairs = []
            if detections:
                costs = np.full((len(tracks), len(detections)), 1e3, dtype=float)
                for track_index, track in enumerate(tracks):
                    dt = max(0.1, sample["time"] - track["time"])
                    px = min(1.0, max(0.0, track["x"] + track["vx"] * dt))
                    py = min(1.0, max(0.0, track["y"] + track["vy"] * dt))
                    for detection_index, detection in enumerate(detections):
                        spatial = ((px - detection["x"]) ** 2 + (py - detection["y"]) ** 2) ** 0.5
                        appearance = sum((a - b) ** 2 for a, b in zip(track["appearance"], detection["appearance"])) ** 0.5
                        if spatial <= min(0.48, 0.22 + dt * 0.09):
                            costs[track_index, detection_index] = spatial + appearance * 0.18
                rows, columns = linear_sum_assignment(costs)
                pairs = [(row, column) for row, column in zip(rows, columns) if costs[row, column] < 1e3]
            matched_tracks = set()
            for track_index, detection_index in pairs:
                track = tracks[track_index]
                detection = detections[detection_index]
                dt = max(0.1, sample["time"] - track["time"])
                vx = (detection["x"] - track["x"]) / dt
                vy = (detection["y"] - track["y"]) / dt
                track["vx"] = max(-0.4, min(0.4, 0.55 * track["vx"] + 0.45 * vx))
                track["vy"] = max(-0.4, min(0.4, 0.55 * track["vy"] + 0.45 * vy))
                track["x"], track["y"], track["time"] = detection["x"], detection["y"], sample["time"]
                track["box"] = detection["box"]
                track["appearance"] = [0.7 * old + 0.3 * new for old, new in zip(track["appearance"], detection["appearance"])]
                track["missing"] = 0
                matched_tracks.add(track_index)
                assignments.append({"id": track["id"], "point": {"x": detection["x"], "y": detection["y"]},
                                    "box": detection["box"], "observed": True})
            for track_index, track in enumerate(tracks):
                if track_index in matched_tracks:
                    continue
                track["missing"] += 1
                track["vx"] *= 0.35
                track["vy"] *= 0.35
                if track["missing"] <= 1:
                    dt = max(0.1, sample["time"] - track["time"])
                    track["x"] = min(1.0, max(0.0, track["x"] + track["vx"] * dt))
                    track["y"] = min(1.0, max(0.0, track["y"] + track["vy"] * dt))
                track["time"] = sample["time"]
                assignments.append({"id": track["id"], "point": {"x": track["x"], "y": track["y"]},
                                    "box": track["box"], "observed": False})

        points = [{"x": track["x"], "y": track["y"], "color": track["id"] % 10,
                   "track_id": track["id"]} for track in tracks]
        tracked_samples.append({"index": sample["index"], "time": sample["time"],
                                "points": points, "assignments": assignments})
    return tracked_samples


def build_timeline(samples):
    # Collapse frame-level jitter into stable layouts. IDs remain fixed even
    # when dancers cross, so a transition moves each dancer's own dot.
    if not samples:
        return []
    frame_counts = [len(sample["points"]) for sample in samples]
    counts = Counter(count for count in frame_counts if count >= 2)
    if not counts:
        return []
    # Every tracked frame has the same number of identity slots. Ignore the
    # initial frames before tracking found a complete group.
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
                layouts.append({"time": candidate[0]["time"], "points": average_points([item["points"] for item in candidate]),
                                "sample_indexes": [item["index"] for item in candidate]})
                candidate = []
            continue
        # Compare against the last committed layout, not a sliding window. A
        # sliding reference gradually follows slow formation changes and can
        # absorb them without ever creating a new layout.
        reference = average_points([item["points"] for item in current[:2]])
        if formation_distance(reference, points) <= 0.1:
            current.append(sample)
            candidate = []
        else:
            if candidate and point_distance(candidate[-1]["points"], points) <= 0.16:
                candidate.append(sample)
            else:
                candidate = [sample]
            if len(candidate) >= 2:
                current = candidate[:]
                layouts.append({"time": candidate[0]["time"], "points": average_points([item["points"] for item in candidate]),
                                "sample_indexes": [item["index"] for item in candidate]})
                candidate = []
    return layouts


def pose_floor_positions(landmarks):
    positions = []
    for pose in landmarks:
        ankles = [pose[index] for index in (27, 28)
                  if getattr(pose[index], "visibility", 0.0) is not None and pose[index].visibility >= 0.55]
        # A single guessed ankle is not enough to correct a perspective map:
        # in dance poses the lifted/occluded leg is often hallucinated.
        if len(ankles) != 2:
            continue
        positions.append({"x": sum(point.x for point in ankles) / len(ankles),
                          # The lower visible ankle is the best available
                          # estimate of the dancer's floor contact.
                          "y": max(point.y for point in ankles)})
    return positions


def refine_formation_positions(formations, samples, paths, transform, root):
    """Replace detector-box bottoms with pose ankles at stable formation frames."""
    if not formations:
        return formations
    import mediapipe as mp
    import numpy as np
    from PIL import Image
    from scipy.optimize import linear_sum_assignment

    set_stage(root, "refining-positions")
    model = cached_model("pose_landmarker_lite.task", POSE_MODEL_URL)
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model)),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_poses=16,
        min_pose_detection_confidence=0.3,
        min_pose_presence_confidence=0.3,
    )
    # One representative frame per layout keeps the refinement bounded while
    # avoiding repeated pose inference for every sampled frame.
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as landmarker:
        for formation in formations:
            indexes = formation.get("sample_indexes", [])
            if not indexes:
                continue
            index = indexes[0]
            if index >= len(paths) or index >= len(samples):
                continue
            observed = [item for item in samples[index].get("assignments", []) if item["observed"]]
            if not observed:
                continue
            with Image.open(paths[index]) as image:
                rgb = np.asarray(image.convert("RGB"))
            result = landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            poses = pose_floor_positions(result.pose_landmarks)
            if not poses:
                continue
            costs = np.full((len(poses), len(observed)), 1e3, dtype=float)
            for pose_index, pose in enumerate(poses):
                for observed_index, item in enumerate(observed):
                    left, top, right, bottom = item["box"]
                    box_width = max(0.025, right - left)
                    box_height = max(0.08, bottom - top)
                    # Compare pose ankles to each detected person's lower box
                    # area, normalized by that person's size so depth changes
                    # and close dancers do not dominate the matching.
                    dx = abs(pose["x"] - (left + right) / 2) / box_width
                    dy = abs(bottom - pose["y"]) / box_height
                    if dx <= 0.65 and dy <= 0.4:
                        costs[pose_index, observed_index] = dx + 0.6 * dy
            rows, columns = linear_sum_assignment(costs)
            aligned = {}
            for row, column in zip(rows, columns):
                if costs[row, column] >= 1.0:
                    continue
                track_id = observed[column]["id"]
                projected = project_point(poses[row], transform)
                if projected:
                    aligned[track_id] = projected
            # Keep the box-derived position only for people whose ankles were
            # not visible or could not be matched confidently.
            for point in formation["points"]:
                refined = aligned.get(point.get("track_id"))
                if refined:
                    point["x"], point["y"] = refined["x"], refined["y"]
    return formations


def analyze(video_id, root, stage_corners):
    transform = stage_projection(stage_corners)
    if os.name == "posix":
        try:
            os.nice(10)
        except OSError:
            pass
    frames = detector_frames(video_id, root)
    samples = collect_detections(frames, root)
    target_count = choose_target_count(samples)
    samples = track_people(samples, target_count)
    # Use the same floor-plane projection approach as GridStage: dancers' foot
    # locations are transformed using the calibrated four-corner quadrilateral.
    samples = project_samples(samples, transform, root)
    formations = build_timeline(samples)
    try:
        formations = refine_formation_positions(formations, samples, frames, transform, root)
    except Exception as error:
        print(f"[formation-pose] ankle refinement skipped: {error}", file=sys.stderr, flush=True)
    for formation in formations:
        formation.pop("sample_indexes", None)
    return {"engine": "formation-v4", "formations": formations}


if __name__ == "__main__":
    import re
    import traceback
    if len(sys.argv) != 4 or not re.fullmatch(r"[A-Za-z0-9_-]{11}", sys.argv[1]):
        raise SystemExit("Invalid video ID")
    root = Path(sys.argv[2])
    try:
        corners = json.loads(sys.argv[3])
        if (not isinstance(corners, list) or len(corners) != 4 or
            not all(isinstance(point, dict) and isinstance(point.get("x"), (int, float)) and
                    isinstance(point.get("y"), (int, float)) and
                    0 <= point["x"] <= 1 and 0 <= point["y"] <= 1 for point in corners)):
            raise ValueError("invalid-stage-corners")
        print(json.dumps(analyze(sys.argv[1], root, corners), separators=(",", ":")))
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
        if str(error) in ("download-rejected", "tool-missing", "invalid-stage-corners"):
            reason = str(error)
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": reason, "stage": stage}))
        raise SystemExit(1)
