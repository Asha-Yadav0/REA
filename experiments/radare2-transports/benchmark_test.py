"""Real synthetic process trees; no Codex or reverse-engineering engine runs."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import psutil

from benchmark import CleanupIncomplete, measure, ownership_command


SLEEPER = "import time; time.sleep(30)"
TREE = f"""
import json, subprocess, sys, time
children = [subprocess.Popen([sys.executable, '-c', {SLEEPER!r}], start_new_session=detached)
            for detached in (False, True)]
print(json.dumps([p.pid for p in children]), flush=True)
time.sleep(.2)
memory = bytearray(128 * 1024**2) if sys.argv[1] == 'memory' else None
if sys.argv[1] != 'exit': time.sleep(30)
"""


class BenchmarkCleanupTest(unittest.TestCase):
    def test_limits_and_leader_exit_clean_children_including_detached_groups(self):
        for mode in ("timeout", "memory", "exit"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="rea-benchmark-test-") as root:
                directory = Path(root) / "trial"
                result = measure([sys.executable, "-c", TREE, mode], directory,
                                 timeout=1 if mode == "timeout" else 10,
                                 memory_limit=64 * 1024**2 if mode == "memory" else 6 * 1024**3)
                self.assertEqual(result["interrupted_by_limit"], mode != "exit")
                self.assertTrue(result["cleanup"]["cleaned"])
                self.assertEqual(result["remaining_observed_pids"], [])
                for pid in json.loads((directory / "stdout.log").read_text()):
                    self.assertFalse(psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE)

    def test_unverified_cleanup_retains_manifest_and_stops_subsequent_trials(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-denied-") as root:
            first = Path(root) / "first"
            second = Path(root) / "second"

            def deny_cleanup(node, operation, ownership=None):
                if operation == "cleanup":
                    return {"cleaned": False, "reason": "injected identity inspection denial"}
                return ownership_command(node, operation, ownership)

            try:
                with patch("benchmark.ownership_command", side_effect=deny_cleanup):
                    with self.assertRaises(CleanupIncomplete) as raised:
                        for directory in (first, second):
                            measure([sys.executable, "-c", SLEEPER], directory, timeout=.2)
                self.assertFalse(second.exists())
                self.assertFalse(json.loads((first / "resources.json").read_text())["cleanup"]["cleaned"])
            finally:
                self.assertEqual(raised.exception.ownership, json.loads((first / "ownership.json").read_text()))
                self.assertTrue(ownership_command("node", "cleanup", raised.exception.ownership)["cleaned"])
                raised.exception.child.wait(timeout=5)

    def test_failed_manifest_writes_preserve_cleanup_and_retry_without_files(self):
        for partial in (False, True):
            for denied in (False, True):
                with self.subTest(partial=partial, denied=denied), tempfile.TemporaryDirectory(prefix="rea-benchmark-write-") as root:
                    first, second = Path(root) / "first", Path(root) / "second"
                    write_text = Path.write_text
                    owner = None
                    cleanup_results = []
                    children = []
                    raised = None

                    def failed_write(path, data, *args, **kwargs):
                        if path.name == "ownership.json":
                            # Wait for acknowledged children before injecting the disk failure.
                            deadline = time.monotonic() + 5
                            while not children:
                                output = (first / "stdout.log").read_text()
                                if output.endswith("\n"):
                                    children.extend(json.loads(output))
                                elif time.monotonic() >= deadline:
                                    raise AssertionError("Synthetic process tree did not start")
                                else:
                                    time.sleep(.01)
                            if partial:
                                write_text(path, "{\"runId\":")
                            raise OSError("injected manifest write failure")
                        if path.name == "resources.json" and denied:
                            raise OSError("injected diagnostics write failure")
                        return write_text(path, data, *args, **kwargs)

                    def inspect_cleanup(node, operation, ownership=None):
                        nonlocal owner
                        if operation == "prepare":
                            owner = ownership_command(node, operation)
                            return owner
                        self.assertIs(ownership, owner)
                        result = ({"cleaned": False, "reason": "injected inspection denial"}
                                  if denied else ownership_command(node, operation, ownership))
                        cleanup_results.append(result)
                        return result

                    try:
                        with patch.object(Path, "write_text", failed_write), patch("benchmark.ownership_command", side_effect=inspect_cleanup):
                            with self.assertRaises(CleanupIncomplete if denied else OSError) as raised:
                                for directory in (first, second):
                                    measure([sys.executable, "-c", TREE, "timeout"], directory)
                        self.assertFalse(second.exists())
                        self.assertEqual(cleanup_results[0]["cleaned"], not denied)
                        if denied:
                            self.assertIs(raised.exception.ownership, owner)
                            self.assertRegex(str(raised.exception.__cause__), "manifest write failure")
                            self.assertIsNone(raised.exception.child.poll())
                        else:
                            self.assertRegex(str(raised.exception), "manifest write failure")
                            for pid in [owner["leaderPid"], *children]:
                                self.assertFalse(psutil.pid_exists(pid) and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE)
                        if partial:
                            with self.assertRaises(json.JSONDecodeError):
                                json.loads((first / "ownership.json").read_text())
                        else:
                            self.assertFalse((first / "ownership.json").exists())
                    finally:
                        # No manifest is needed for retry, even after both writes failed.
                        if owner is not None and "leaderPid" in owner:
                            self.assertTrue(ownership_command("node", "cleanup", owner)["cleaned"])
                        if denied and isinstance(getattr(raised, "exception", None), CleanupIncomplete):
                            raised.exception.child.wait(timeout=5)

    def test_large_prompt_does_not_block_limit_monitoring(self):
        with tempfile.TemporaryDirectory(prefix="rea-benchmark-stdin-") as root:
            result = measure([sys.executable, "-c", SLEEPER], Path(root) / "trial",
                             prompt="x" * 2 * 1024**2, timeout=.2)
            self.assertTrue(result["interrupted_by_limit"])
            self.assertTrue(result["cleanup"]["cleaned"])


if __name__ == "__main__":
    unittest.main()
