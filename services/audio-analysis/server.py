"""Bounded background job service; bind to loopback, never expose publicly."""
import hmac
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import tempfile
import math
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TOKEN = os.environ.get("AUDIO_ANALYSIS_TOKEN", "")
JOBS = {}
LOCK = threading.Lock()
DOWNLOAD_LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=1)
FORMATION_POOL = ThreadPoolExecutor(max_workers=1)
RUNNER = Path(__file__).with_name("analyze.py")
FORMATION_RUNNER = Path(__file__).with_name("analyze_formations.py")
CACHE_DIR = Path(os.environ.get("AUDIO_ANALYSIS_CACHE", str(Path.home() / ".cache" / "muverse-audio")))
ENGINE = os.environ.get("AUDIO_ANALYSIS_ENGINE", "fast")
if ENGINE not in ("fast", "full"):
    raise ValueError("AUDIO_ANALYSIS_ENGINE must be fast or full")
LEASE_SECONDS = 8 if ENGINE == "fast" else 30
JOB_TIMEOUT = 27 if ENGINE == "fast" else 180
STAGES = {"downloading", "decoding", "separating", "features", "loading-model", "analyzing",
          "extracting-frames", "tracking-dancers", "projecting-floor"}
ERROR_CODES = {"dependency-missing", "tool-missing", "download-timeout", "decode-timeout",
               "download-failed", "decode-failed", "download-rejected", "analysis-failed"}
FORMATION_ERRORS = {"dependency-missing", "tool-missing", "download-timeout", "download-failed",
                    "download-rejected", "decode-failed", "analysis-failed", "invalid-result", "invalid-stage-corners", "timeout"}
FORMATION_JOBS = {}
FORMATION_CACHE_TTL = 30 * 86400
FORMATION_JOB_TIMEOUT = 900


def clear_audio_cache():
    """Remove persisted audio-analysis results; only formation timelines are retained."""
    for pattern in ("fast-repeat-v*-*.json", "fast-repeat-v*-*.tmp", "fold0-v1-*.json", "fold0-v1-*.tmp"):
        for path in CACHE_DIR.glob(pattern):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


def read_stage(root):
    try:
        stage = (root / "stage").read_text().strip()
        return stage if stage in STAGES else None
    except OSError:
        return None


def failure_ttl(job):
    if job.get("reason") == "cancelled":
        return 0
    return 60 if job.get("reason") in ("dependency-missing", "tool-missing") else 15



def cpu_threads():
    try:
        available = len(os.sched_getaffinity(0))
    except AttributeError:
        available = os.cpu_count() or 1
    try:
        requested = int(os.environ.get("AUDIO_ANALYSIS_THREADS", "6"))
    except ValueError:
        requested = 6
    return max(1, min(available, requested))


def valid_segments(value):
    if not isinstance(value, list) or len(value) > 200:
        return False
    return all(isinstance(s, dict) and isinstance(s.get("label"), str) and
               isinstance(s.get("start"), (int, float)) and isinstance(s.get("end"), (int, float)) and
               math.isfinite(s["start"]) and math.isfinite(s["end"]) and
               0 <= s["start"] < s["end"] <= 900 for s in value)


def formation_cache_path(video_id, calibration_key):
    # Keep calibrated floor projections separate from older algorithms and from
    # runs that use different stage corners.
    return CACHE_DIR / f"formation-v26-{video_id}-{calibration_key}.json"


def read_formation_cache(video_id, calibration_key):
    path = formation_cache_path(video_id, calibration_key)
    try:
        if time.time() - path.stat().st_mtime > FORMATION_CACHE_TTL:
            return None
        data = json.loads(path.read_text())
        return data if valid_formations(data.get("formations")) else None
    except (OSError, ValueError, TypeError):
        return None


def valid_formations(formations):
    if not isinstance(formations, list) or len(formations) > 1000:
        return False
    previous_time = -1
    for item in formations:
        if (not isinstance(item, dict) or not isinstance(item.get("time"), (int, float)) or
                not math.isfinite(item["time"]) or item["time"] < previous_time):
            return False
        points = item.get("points")
        if not isinstance(points, list) or not 2 <= len(points) <= 20:
            return False
        if not all(isinstance(point, dict) and isinstance(point.get("x"), (int, float)) and math.isfinite(point["x"]) and
                   isinstance(point.get("y"), (int, float)) and math.isfinite(point["y"]) and
                   0 <= point["x"] <= 1 and 0 <= point["y"] <= 1
                   for point in points):
            return False
        previous_time = item["time"]
    return True


def run_formation_job(video_id, job_key, stage_corners, calibration_key):
    with LOCK:
        job = FORMATION_JOBS.get(job_key, {})
        job.update(status="processing", stage="downloading", updated=time.time())
        FORMATION_JOBS[job_key] = job
    tempdir = tempfile.TemporaryDirectory(prefix="muverse-formation-")
    process = None
    errors = None
    download_lock_held = False
    began = time.monotonic()
    try:
        root = Path(tempdir.name)
        errors = (root / "worker.log").open("w+b")
        DOWNLOAD_LOCK.acquire()
        download_lock_held = True
        env = os.environ.copy()
        threads = str(cpu_threads())
        env["FORMATION_THREADS"] = threads
        for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
            env[name] = threads
        process = subprocess.Popen([sys.executable, str(FORMATION_RUNNER), video_id, str(root),
                                     json.dumps(stage_corners, separators=(",", ":"))],
                                   stdout=subprocess.PIPE, stderr=errors, env=env,
                                   start_new_session=(os.name != "nt"))
        while True:
            try:
                output, _ = process.communicate(timeout=1)
                break
            except subprocess.TimeoutExpired:
                stage = read_stage(root)
                if stage:
                    with LOCK:
                        FORMATION_JOBS[job_key]["stage"] = stage
                    if stage != "downloading" and download_lock_held:
                        DOWNLOAD_LOCK.release()
                        download_lock_held = False
                if time.monotonic() - began > FORMATION_JOB_TIMEOUT:
                    raise RuntimeError("timeout")
        if process.returncode:
            try:
                details = json.loads(output.decode().strip().splitlines()[-1])
                reason = details.get("error")
            except (ValueError, IndexError, UnicodeError, AttributeError):
                reason = None
            raise RuntimeError(reason if reason in FORMATION_ERRORS else "analysis-failed")
        result = json.loads(output.decode().strip().splitlines()[-1])
        if not valid_formations(result.get("formations")):
            raise RuntimeError("invalid-result")
        job = {"status": "ready", "engine": "formation-v15", "formations": result["formations"]}
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        formation_cache_path(video_id, calibration_key).write_text(json.dumps(job, separators=(",", ":")))
    except Exception as error:
        if process is not None:
            stop_process(process)
        reason = str(error) if str(error) in FORMATION_ERRORS else "analysis-failed"
        job = {"status": "failed", "reason": reason, "stage": read_stage(Path(tempdir.name)) or "unknown"}
    finally:
        if download_lock_held:
            DOWNLOAD_LOCK.release()
        if errors is not None:
            errors.seek(max(0, errors.seek(0, 2) - 4096))
            tail = errors.read().decode("utf-8", errors="replace")
            if job.get("status") == "failed":
                tail = re.sub(r"https?://\S+", "<url>", tail)
                for line in tail.splitlines()[-6:]:
                    print(f"[formation-error] {video_id}: {line[:500]}", flush=True)
            else:
                for line in tail.splitlines():
                    if '"formation_counts"' in line or "[formation-pose]" in line:
                        print(f"[formation] {video_id}: {line[:500]}", flush=True)
            errors.close()
        tempdir.cleanup()
    with LOCK:
        FORMATION_JOBS[job_key] = {**job, "updated": time.time()}
    print(f"[formation] {video_id}: {job['status']} ({time.monotonic() - began:.1f}s) {job.get('reason', '')}", flush=True)


def abandoned(video_id):
    with LOCK:
        return time.time() - JOBS.get(video_id, {}).get("lastRequested", time.time()) > LEASE_SECONDS


def stop_process(process):
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    elif process.poll() is None:
        process.kill()
    else:
        return
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.communicate()



def run_job(video_id):
    if abandoned(video_id):
        with LOCK:
            JOBS[video_id] = {"status": "failed", "reason": "cancelled", "updated": time.time()}
        return
    with LOCK:
        JOBS.setdefault(video_id, {})
        JOBS[video_id].update(status="processing", stage="downloading", updated=time.time())
    process = None
    errors = None
    download_lock_held = False
    began = time.monotonic()
    tempdir = tempfile.TemporaryDirectory(prefix="muverse-audio-")
    try:
        # Parent owns temporary audio, so even a hard-killed child leaves no files.
        root = Path(tempdir.name)
        env = os.environ.copy()
        env["AUDIO_ANALYSIS_ENGINE"] = ENGINE
        threads = str(cpu_threads())
        for name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "AUDIO_ANALYSIS_THREADS"):
            env[name] = threads
        errors = (root / "worker.log").open("w+b")
        DOWNLOAD_LOCK.acquire()
        download_lock_held = True
        process = subprocess.Popen([sys.executable, str(RUNNER), video_id, str(root)],
                                   stdout=subprocess.PIPE, stderr=errors, env=env,
                                   start_new_session=(os.name != "nt"))
        started = time.monotonic()
        with LOCK:
            queued_seconds = max(0, time.time() - JOBS[video_id].get("created", time.time()))
        remaining = max(0, JOB_TIMEOUT - queued_seconds)
        while True:
            try:
                output, _ = process.communicate(timeout=1)
                break
            except subprocess.TimeoutExpired:
                if abandoned(video_id):
                    raise RuntimeError("cancelled")
                if time.monotonic() - started > remaining:
                    raise RuntimeError("timeout")
                try:
                    stage = read_stage(root)
                    if stage:
                        # Keep temporary diagnostics bounded even for noisy models.
                        if errors.seek(0, 2) > 65536:
                            errors.seek(-16384, 2)
                            tail = errors.read()
                            errors.seek(0)
                            errors.write(tail)
                            errors.truncate()
                            errors.flush()
                        with LOCK:
                            previous = JOBS[video_id].get("stage")
                            JOBS[video_id]["stage"] = stage
                        if stage != "downloading" and download_lock_held:
                            DOWNLOAD_LOCK.release()
                            download_lock_held = False
                        if stage != previous:
                            print(f"[audio] {video_id}: {stage} (elapsed {time.monotonic() - began:.1f}s)", flush=True)
                except OSError:
                    pass
        stage = read_stage(root)
        if stage:
            with LOCK:
                JOBS[video_id]["stage"] = stage
        if process.returncode:
            try:
                detail = json.loads(output.decode().strip().splitlines()[-1])
                reason = detail.get("error")
            except (ValueError, IndexError, UnicodeError, AttributeError):
                reason = None
            raise RuntimeError(reason if reason in ERROR_CODES else "audio-analysis-unavailable")
        result = json.loads(output.decode().strip().splitlines()[-1])
        if not valid_segments(result["segments"]):
            raise RuntimeError("invalid-result")
        if ENGINE == "fast" and isinstance(result.get("diagnostics"), dict):
            summary = {k: v for k, v in result["diagnostics"].items()
                       if k in ("reason", "candidatePairs", "eligibleFamilies", "relaxedCandidatePairs", "relaxedEligibleFamilies")
                       and isinstance(v, (str, int))}
            print(f"[audio] {video_id}: fast summary {json.dumps(summary)}", flush=True)
        job = {"status": "ready", "engine": ENGINE, "segments": result["segments"]}
    except Exception as error:
        if process is not None:
            stop_process(process)
        stage = read_stage(Path(tempdir.name))
        if stage:
            with LOCK:
                JOBS[video_id]["stage"] = stage
        reason = str(error) if str(error) in ERROR_CODES | {"cancelled", "timeout"} else "audio-analysis-unavailable"
        job = {"status": "failed", "reason": reason, "stage": JOBS.get(video_id, {}).get("stage", "unknown")}
    finally:
        if download_lock_held:
            DOWNLOAD_LOCK.release()
        if errors is not None:
            if job.get("status") == "failed":
                errors.seek(max(0, errors.seek(0, 2) - 4096))
                tail = errors.read().decode("utf-8", errors="replace")
                # Local diagnostic only. Never send raw traceback/URLs to the UI.
                tail = re.sub(r"https?://\S+", "<url>", tail)
                for line in tail.splitlines()[-6:]:
                    print(f"[audio-error] {video_id}: {line[:500]}", flush=True)
            errors.close()
        try:
            timings = json.loads((Path(tempdir.name) / "timings.json").read_text())
            measured = {k: v for k, v in timings.items() if k in ("separating", "features", "loading-model", "analyzing") and isinstance(v, (int, float))}
            print(f"[audio] {video_id}: phase seconds {json.dumps(measured)}", flush=True)
        except (OSError, ValueError, AttributeError):
            pass
        tempdir.cleanup()
    with LOCK:
        JOBS[video_id] = {**job, "updated": time.time()}
    print(f"[audio] {video_id}: {job['status']} ({time.monotonic() - began:.1f}s) {job.get('reason', '')} stage={job.get('stage', 'complete')}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
            return self.respond(401, {"error": "unauthorized"})
        if self.path == "/health":
            return self.respond(200, {"status": "ok", "version": "fast-experiment-v3", "engine": ENGINE, "cpuThreads": cpu_threads()})
        return self.respond(404, {"error": "not-found"})

    def do_POST(self):
        if TOKEN and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
            return self.respond(401, {"error": "unauthorized"})
        path = urlparse(self.path).path
        formation_match = re.fullmatch(r"/formations/([A-Za-z0-9_-]{11})", path)
        if formation_match:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 2048:
                    return self.respond(400, {"error": "invalid-calibration"})
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    return self.respond(400, {"error": "invalid-calibration"})
                stage_corners = body.get("stageCorners")
                if (not isinstance(stage_corners, list) or len(stage_corners) != 4 or
                    not all(isinstance(point, dict) and isinstance(point.get("x"), (int, float)) and
                            isinstance(point.get("y"), (int, float)) and
                            math.isfinite(point["x"]) and math.isfinite(point["y"]) and
                            0 <= point["x"] <= 1 and 0 <= point["y"] <= 1 for point in stage_corners)):
                    return self.respond(400, {"error": "invalid-calibration"})
            except (ValueError, TypeError, UnicodeDecodeError):
                return self.respond(400, {"error": "invalid-calibration"})
            return self.handle_formation(formation_match[1], stage_corners)
        match = re.fullmatch(r"/jobs/([A-Za-z0-9_-]{11})", path)
        if not match:
            return self.respond(400, {"error": "invalid-video-id"})
        video_id = match[1]
        with LOCK:
            now = time.time()
            for key, job in list(JOBS.items()):
                ttl = failure_ttl(job) if job["status"] == "failed" else 300
                if job["status"] in ("ready", "failed") and now - job["updated"] > ttl:
                    del JOBS[key]
            if video_id not in JOBS:
                if sum(j["status"] in ("queued", "processing") for j in JOBS.values()) >= 8:
                    return self.respond(429, {"status": "busy", "engine": ENGINE})
                if len(JOBS) >= 128:
                    completed = [k for k, j in JOBS.items() if j["status"] in ("ready", "failed")]
                    if completed:
                        del JOBS[min(completed, key=lambda k: JOBS[k]["updated"])]
                JOBS[video_id] = {"status": "queued", "updated": now, "lastRequested": now, "created": now, "engine": ENGINE}
                POOL.submit(run_job, video_id)
            JOBS[video_id]["lastRequested"] = now
            result = {k: v for k, v in JOBS[video_id].items() if k not in ("lastRequested", "created")}
            result.setdefault("engine", ENGINE)
        self.respond(200, result)

    def handle_formation(self, video_id, stage_corners):
        calibration_key = hashlib.sha256(json.dumps(stage_corners, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]
        job_key = f"{video_id}:{calibration_key}"
        with LOCK:
            now = time.time()
            for key, job in list(FORMATION_JOBS.items()):
                ttl = 15 if job["status"] == "failed" else FORMATION_CACHE_TTL
                if job["status"] in ("ready", "failed") and now - job["updated"] > ttl:
                    del FORMATION_JOBS[key]
            if job_key not in FORMATION_JOBS:
                cached = read_formation_cache(video_id, calibration_key)
                if cached is not None:
                    FORMATION_JOBS[job_key] = {**cached, "updated": now}
            if job_key not in FORMATION_JOBS:
                if sum(job["status"] in ("queued", "processing") for job in FORMATION_JOBS.values()) >= 2:
                    return self.respond(429, {"status": "busy", "engine": "formation-v15"})
                FORMATION_JOBS[job_key] = {"status": "queued", "stage": "downloading", "updated": now}
                FORMATION_POOL.submit(run_formation_job, video_id, job_key, stage_corners, calibration_key)
            job = FORMATION_JOBS[job_key]
            result = {key: value for key, value in job.items() if key != "updated"}
        self.respond(200, result)


if __name__ == "__main__":
    clear_audio_cache()
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("AUDIO_ANALYSIS_PORT", "8765"))), Handler).serve_forever()
