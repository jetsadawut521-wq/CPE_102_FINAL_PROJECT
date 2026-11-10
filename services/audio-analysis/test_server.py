import importlib.util
import json
import threading
import tempfile
import time
import subprocess
import io
from contextlib import redirect_stdout
from pathlib import Path
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location("audio_worker", __file__.replace("test_server.py", "server.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class JobsTest(unittest.TestCase):
    def setUp(self):
        worker.JOBS.clear()
        self.cache = tempfile.TemporaryDirectory()
        patch.object(worker, "CACHE_DIR", Path(self.cache.name)).start()
        self.pool = patch.object(worker, "POOL", Mock()).start()
        self.token = patch.object(worker, "TOKEN", "test-secret").start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), worker.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        patch.stopall()
        self.cache.cleanup()

    def post(self, path, token="test-secret"):
        request = Request(f"http://127.0.0.1:{self.server.server_port}" + path,
                          data=b"", headers={"Authorization": "Bearer " + token}, method="POST")
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_validation_auth_dedup_and_queue_capacity(self):
        self.assertEqual(self.post("/jobs/RXQCY_zxz-E", token="wrong")[0], 401)
        self.assertEqual(self.post("/jobs/not-a-video")[0], 200)  # a valid 11-character ID
        self.assertEqual(self.post("/jobs/https://example.org")[0], 400)
        for _ in range(2):
            self.assertEqual(self.post("/jobs/RXQCY_zxz-E")[1]["status"], "queued")
        self.assertEqual(self.pool.submit.call_count, 2)
        for i in range(6):
            self.post(f"/jobs/clip{i:07d}")
        self.assertEqual(self.post("/jobs/u_vusNeo6xI")[0], 429)

    def test_completed_job_reused_and_failure_retried_after_ttl(self):
        import time
        worker.JOBS["RXQCY_zxz-E"] = {"status": "ready", "segments": [], "updated": time.time()}
        self.assertEqual(self.post("/jobs/RXQCY_zxz-E")[1]["status"], "ready")
        self.pool.submit.assert_not_called()
        worker.JOBS["RXQCY_zxz-E"] = {"status": "failed", "updated": time.time() - 301}
        self.assertEqual(self.post("/jobs/RXQCY_zxz-E")[1]["status"], "queued")
        self.pool.submit.assert_called_once()

    def test_runner_error_is_not_a_success_or_a_leaked_exception(self):
        with patch.object(worker.subprocess, "Popen", side_effect=OSError("sensitive path")):
            worker.run_job("RXQCY_zxz-E")
        self.assertEqual(worker.JOBS["RXQCY_zxz-E"]["status"], "failed")
        self.assertNotIn("sensitive", json.dumps(worker.JOBS))

    def test_persisted_audio_cache_is_not_used(self):
        worker.CACHE_DIR.mkdir(exist_ok=True)
        (worker.CACHE_DIR / "fast-repeat-v3-RXQCY_zxz-E.json").write_text(json.dumps({
            "updated": time.time(), "segments": [{"start": 64, "end": 80.9, "label": "chorus"}]
        }))
        status, data = self.post("/jobs/RXQCY_zxz-E")
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "queued")
        self.pool.submit.assert_called_once()

    def test_audio_cache_cleanup_keeps_formation_cache(self):
        worker.CACHE_DIR.mkdir(exist_ok=True)
        audio = worker.CACHE_DIR / "fast-repeat-v2-RXQCY_zxz-E.json"
        formation = worker.CACHE_DIR / "formation-v12-RXQCY_zxz-E.json"
        audio.write_text("old audio result")
        formation.write_text("formation result")
        worker.clear_audio_cache()
        self.assertFalse(audio.exists())
        self.assertTrue(formation.exists())

    def test_abandoned_queued_job_never_starts_download_or_model(self):
        worker.JOBS["RXQCY_zxz-E"] = {"status": "queued", "updated": time.time(), "lastRequested": time.time() - 31}
        with patch.object(worker.subprocess, "Popen") as spawn:
            worker.run_job("RXQCY_zxz-E")
        spawn.assert_not_called()
        self.assertEqual(worker.JOBS["RXQCY_zxz-E"]["reason"], "cancelled")

    def test_running_abandoned_job_is_terminated_and_does_not_cache_fake_success(self):
        process = Mock()
        process.communicate.side_effect = subprocess.TimeoutExpired("test", 1)
        with patch.object(worker, "abandoned", side_effect=[False, True]), \
             patch.object(worker.subprocess, "Popen", return_value=process), \
             patch.object(worker, "stop_process") as stop:
            worker.run_job("RXQCY_zxz-E")
        stop.assert_called_once_with(process)
        self.assertEqual(worker.JOBS["RXQCY_zxz-E"]["reason"], "cancelled")

    def test_hard_deadline_is_reported_as_timeout(self):
        process = Mock()
        process.communicate.side_effect = subprocess.TimeoutExpired("test", 1)
        with patch.object(worker, "abandoned", return_value=False), \
             patch.object(worker, "JOB_TIMEOUT", 0), \
             patch.object(worker.subprocess, "Popen", return_value=process), \
             patch.object(worker, "stop_process") as stop:
            worker.run_job("RXQCY_zxz-E")
        stop.assert_called_once()
        self.assertEqual(worker.JOBS["RXQCY_zxz-E"]["reason"], "timeout")

    def test_success_is_held_in_memory_only_and_threads_are_bounded(self):
        process = Mock(returncode=0)
        process.communicate.return_value = (b'{"segments":[{"start":64,"end":80.9,"label":"chorus"}]}', b'')
        with patch.object(worker.subprocess, "Popen", return_value=process) as spawn:
            worker.run_job("RXQCY_zxz-E")
        self.assertEqual(worker.JOBS["RXQCY_zxz-E"]["status"], "ready")
        self.assertEqual(list(worker.CACHE_DIR.glob("fast-repeat-*-RXQCY_zxz-E.json")), [])
        self.assertEqual(spawn.call_args.kwargs["env"]["OMP_NUM_THREADS"], str(worker.cpu_threads()))
        self.assertFalse(Path(spawn.call_args.args[0][-1]).exists())

    def test_cpu_budget_uses_six_on_twelve_and_respects_small_allocations(self):
        with patch.dict(worker.os.environ, {"AUDIO_ANALYSIS_THREADS": "6"}), \
             patch.object(worker.os, "sched_getaffinity", return_value=set(range(12)), create=True):
            self.assertEqual(worker.cpu_threads(), 6)
        with patch.dict(worker.os.environ, {"AUDIO_ANALYSIS_THREADS": "6"}), \
             patch.object(worker.os, "sched_getaffinity", return_value={0, 1}, create=True):
            self.assertEqual(worker.cpu_threads(), 2)
        with patch.dict(worker.os.environ, {"AUDIO_ANALYSIS_THREADS": "0"}):
            self.assertEqual(worker.cpu_threads(), 1)

    def test_fast_failure_keeps_specific_reason_and_stage_even_when_it_exits_immediately(self):
        process = Mock(returncode=1)
        process.communicate.return_value = (b'{"error":"decode-failed"}', b'')
        def spawn(args, **kwargs):
            (Path(args[-1]) / "stage").write_text("decoding")
            kwargs["stderr"].write(b'ERROR https://example.test/?token=private-test-secret\n')
            kwargs["stderr"].flush()
            return process
        output = io.StringIO()
        with patch.object(worker.subprocess, "Popen", side_effect=spawn), \
             patch.object(worker, "stop_process"), redirect_stdout(output):
            worker.run_job("RXQCY_zxz-E")
        self.assertEqual(worker.JOBS["RXQCY_zxz-E"]["reason"], "decode-failed")
        self.assertEqual(worker.JOBS["RXQCY_zxz-E"]["stage"], "decoding")
        self.assertNotIn("private-test-secret", output.getvalue())
        self.assertNotIn("traceback", worker.JOBS["RXQCY_zxz-E"])

    def test_transient_download_failure_can_retry_without_waiting_five_minutes(self):
        worker.JOBS["RXQCY_zxz-E"] = {"status": "failed", "reason": "download-timeout", "updated": time.time() - 16}
        self.assertEqual(self.post("/jobs/RXQCY_zxz-E")[1]["status"], "queued")
        self.pool.submit.assert_called_once()
        worker.JOBS["RXQCY_zxz-E"] = {"status": "failed", "reason": "download-timeout", "updated": time.time() - 2}
        self.assertEqual(self.post("/jobs/RXQCY_zxz-E")[1]["status"], "failed")
        self.pool.submit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
