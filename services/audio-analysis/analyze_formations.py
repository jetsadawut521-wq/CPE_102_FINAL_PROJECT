"""Build a stable, timestamped formation timeline from a YouTube practice clip."""
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from collections import Counter
from pathlib import Path

YOLO_POSE_MODEL_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26s-pose.pt"
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
    set_stage(root, "projecting-floor")
    last_positions = {}
    for sample in samples:
        for point in sample["points"]:
            projected = project_point(point, transform)
            # Pose landmarks can be confident yet geometrically wrong. Don't
            # clamp an ankle projected outside the calibrated floor to an edge;
            # that creates dots at the very top/bottom of the map. Try the
            # person box's lower-leg anchor first, then retain an in-stage point.
            if projected and 0.03 <= projected["x"] <= 0.97 and 0.03 <= projected["y"] <= 0.97:
                point["x"], point["y"] = projected["x"], projected["y"]
            else:
                fallback = project_point(point.get("fallback", point), transform)
                track_id = point.get("track_id")
                if fallback:
                    point["x"], point["y"] = fallback["x"], fallback["y"]
                elif track_id in last_positions:
                    point["x"], point["y"] = last_positions[track_id]
                else:
                    point["x"], point["y"] = 0.5, 0.5
            if point.get("track_id") is not None:
                last_positions[point["track_id"]] = (point["x"], point["y"])
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


def point_inside_stage(x, y, corners):
    """Return whether an image-space floor anchor lies in the calibrated stage."""
    vertices = [(float(point["x"]), float(point["y"])) for point in corners]
    crosses = []
    for index, (start_x, start_y) in enumerate(vertices):
        end_x, end_y = vertices[(index + 1) % len(vertices)]
        crosses.append((end_x - start_x) * (y - start_y) - (end_y - start_y) * (x - start_x))
    return all(value >= -1e-6 for value in crosses) or all(value <= 1e-6 for value in crosses)


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


def collect_detections(paths, root, stage_corners):
    set_stage(root, "tracking-dancers")
    import numpy as np
    import torch
    from ultralytics import YOLO

    model_path = cached_model("yolo26s-pose.pt", YOLO_POSE_MODEL_URL)
    requested_threads = int(os.environ.get("FORMATION_THREADS", os.cpu_count() or 1))
    torch.set_num_threads(max(1, min(6, requested_threads)))
    torch.set_num_interop_threads(1)
    model = YOLO(str(model_path))
    samples = []
    batch_size = 4
    for batch_start in range(0, len(paths), batch_size):
        batch_paths = paths[batch_start:batch_start + batch_size]
        # Crowded choreography often produces overlapping person boxes. A
        # higher NMS IoU threshold keeps adjacent dancers instead of suppressing
        # one as a duplicate; a modestly lower confidence threshold helps with
        # partially occluded dancers. Stage-polygon filtering below still
        # rejects detections outside the calibrated performance area.
        results = model.predict([str(path) for path in batch_paths], imgsz=640, batch=batch_size,
                                conf=0.16, iou=0.7, max_det=24, device="cpu", verbose=False)
        for offset, result in enumerate(results):
            index = batch_start + offset
            # Ultralytics stores the decoded source frame in BGR order.
            rgb = np.asarray(result.orig_img)[:, :, ::-1]
            height, width = rgb.shape[:2]
            candidates = []
            if result.boxes is not None and result.keypoints is not None:
                boxes = result.boxes.xyxy.cpu().numpy()
                scores = result.boxes.conf.cpu().numpy()
                keypoints = result.keypoints.xy.cpu().numpy()
                keypoint_scores = result.keypoints.conf
                keypoint_scores = keypoint_scores.cpu().numpy() if keypoint_scores is not None else None
                for detection_index, (box, score, pose) in enumerate(zip(boxes, scores, keypoints)):
                    left_px, top_px, right_px, bottom_px = box
                    left, top = max(0.0, left_px / width), max(0.0, top_px / height)
                    right, bottom = min(1.0, right_px / width), min(1.0, bottom_px / height)
                    if right <= left or bottom <= top:
                        continue
                    box_width, box_height = right - left, bottom - top
                    if box_height < 0.07 or box_width < 0.018:
                        continue
                    confidence = keypoint_scores[detection_index] if keypoint_scores is not None else np.ones(len(pose))
                    # COCO keypoint order: hips 11/12, knees 13/14, ankles 15/16.
                    ankles = [pose[k] for k in (15, 16) if len(pose) > k and confidence[k] >= 0.3]
                    hips = [pose[k] for k in (11, 12) if len(pose) > k and confidence[k] >= 0.25]
                    legs = [pose[k] for k in (11, 12, 13, 14, 15, 16)
                            if len(pose) > k and confidence[k] >= 0.2]
                    # Pose models sometimes assign an occluded dancer the
                    # visible dancer's ankles, or put ankles around the torso.
                    # Accept ankle coordinates only when they lie in the lower
                    # part of this detection box; otherwise use the box floor
                    # edge. This prevents a hidden rear dancer's dot jumping
                    # toward the back wall because a knee/hip was used as a
                    # pretend foot.
                    box_top_px, box_bottom_px = top * height, bottom * height
                    ankle_y_px = float(np.mean([point[1] for point in ankles])) if ankles else None
                    ankle_is_plausible = (ankle_y_px is not None and
                                          box_top_px + box_height * height * 0.52 <= ankle_y_px <=
                                          box_bottom_px + box_height * height * 0.12)
                    usable_ankles = ankles if ankle_is_plausible else []
                    anchor_x = float(np.mean([point[0] for point in usable_ankles])) if len(usable_ankles) == 2 else (
                        float(np.mean([point[0] for point in hips])) if hips else (left + right) / 2)
                    # Average both plausible ankles to avoid a lunge/extended
                    # foot pulling the depth coordinate to one side.
                    anchor_y = (ankle_y_px / height if ankle_is_plausible else bottom)
                    anchor_x_normalized = anchor_x / width
                    if not point_inside_stage(anchor_x_normalized, anchor_y, stage_corners):
                        continue
                    fallback_x = float(np.mean([point[0] for point in hips])) / width if hips else (left + right) / 2
                    fallback_y = bottom
                    # A color histogram is more useful for identity than a
                    # single mean RGB value when dancers cross or overlap.
                    identity_crop = rgb[int(top * height + box_height * height * 0.16):int(top * height + box_height * height * 0.82),
                                        int(left * width + box_width * width * 0.2):int(left * width + box_width * width * 0.8)]
                    if identity_crop.size:
                        appearance = np.histogramdd(identity_crop.reshape(-1, 3), bins=(4, 4, 4),
                                                    range=((0, 256), (0, 256), (0, 256)))[0].astype(float).ravel()
                        appearance /= max(1.0, appearance.sum())
                    else:
                        appearance = np.full(64, 1 / 64, dtype=float)
                    candidates.append({"x": anchor_x_normalized, "y": anchor_y,
                                       "fallback": {"x": fallback_x, "y": fallback_y},
                                       "score": float(score), "box": (left, top, right, bottom),
                                       "shape": box_width / max(0.01, box_height),
                                       "appearance": appearance.tolist()})
            samples.append({"index": index, "time": index / SAMPLE_FPS, "points": candidates})
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
    # Prefer the largest count that is repeatedly visible in a local window.
    # A clip often spends more time in tight/occluded formations, so choosing
    # the global mode systematically drops dancers who are visible in the more
    # open formations. Requiring 3 of 5 neighboring samples avoids reacting to
    # a one-frame duplicate while allowing the group size to exceed the mode.
    persistent = [count for count in supported if count in counts]
    if persistent:
        target = max(persistent)
        selection = "largest-persistent-count"
    else:
        target = max(counts, key=lambda count: (counts[count], count))
        selection = "most-frequent-fallback"
    print(json.dumps({"formation_counts": dict(sorted(counts.items())),
                      "persistent_counts": sorted(supported), "selected_count": target,
                      "selection": selection}),
          file=sys.stderr, flush=True)
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
                               "shape": detection["shape"],
                               "fallback": detection["fallback"],
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
                        appearance = 0.5 * sum(abs(a - b) for a, b in zip(track["appearance"], detection["appearance"]))
                        if spatial <= min(0.48, 0.22 + dt * 0.09):
                            shape_delta = abs(track["shape"] - detection["shape"])
                            costs[track_index, detection_index] = spatial * 0.55 + appearance * 0.75 + min(0.25, shape_delta) * 0.12
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
                track["shape"] = detection["shape"]
                track["fallback"] = detection["fallback"]
                appearance_delta = 0.5 * sum(abs(a - b) for a, b in zip(track["appearance"], detection["appearance"]))
                # Keep a stable identity template; only adapt it when the match
                # is visually plausible so an ID switch cannot poison it.
                if appearance_delta < 0.5 and detection["score"] >= 0.3:
                    track["appearance"] = [0.9 * old + 0.1 * new
                                            for old, new in zip(track["appearance"], detection["appearance"])]
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

        points = [{"x": track["x"], "y": track["y"], "fallback": track["fallback"], "color": track["id"] % 10,
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


def analyze(video_id, root, stage_corners):
    transform = stage_projection(stage_corners)
    if os.name == "posix":
        try:
            os.nice(10)
        except OSError:
            pass
    frames = detector_frames(video_id, root)
    samples = collect_detections(frames, root, stage_corners)
    target_count = choose_target_count(samples)
    samples = track_people(samples, target_count)
    # Use the same floor-plane projection approach as GridStage: dancers' foot
    # locations are transformed using the calibrated four-corner quadrilateral.
    samples = project_samples(samples, transform, root)
    formations = build_timeline(samples)
    for formation in formations:
        formation.pop("sample_indexes", None)
    return {"engine": "formation-v15", "formations": formations}


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
