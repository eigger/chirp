#!/usr/bin/env python3
"""
Unit and regression tests for chirp-collector.py.
Run locally:
  python3 scripts/ci/test-collector.py
"""

import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
COLLECTOR_PATH = os.path.join(REPO_ROOT, "proxmox", "host", "chirp-collector.py")

# Import chirp-collector.py dynamically
spec = importlib.util.spec_from_file_location("chirp_collector", COLLECTOR_PATH)
if spec is None or spec.loader is None:
    raise ImportError(f"Could not load {COLLECTOR_PATH}")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class TestCollectorPaths(unittest.TestCase):
    def test_validate_filesystem_paths_empty(self):
        self.assertEqual(collector.validate_filesystem_paths(None), [])
        self.assertEqual(collector.validate_filesystem_paths(""), [])
        self.assertEqual(collector.validate_filesystem_paths("   "), [])

    def test_validate_filesystem_paths_valid(self):
        self.assertEqual(
            collector.validate_filesystem_paths("/,/data,/var/log"),
            ["/", "/data", "/var/log"],
        )
        # Deduplication
        self.assertEqual(
            collector.validate_filesystem_paths("/,/data,/data"),
            ["/", "/data"],
        )

    def test_validate_filesystem_paths_rejects_relative_or_invalid(self):
        with self.assertRaises(ValueError):
            collector.validate_filesystem_paths("relative/path")
        with self.assertRaises(ValueError):
            collector.validate_filesystem_paths("/data/../secret")
        with self.assertRaises(ValueError):
            collector.validate_filesystem_paths("/data\0bad")
        # Over 32 paths
        over_32 = ",".join(f"/p{i}" for i in range(33))
        with self.assertRaises(ValueError):
            collector.validate_filesystem_paths(over_32)


class TestCollectorMath(unittest.TestCase):
    def test_js_round_half_up_parity(self):
        # Python's round(2.5) == 2 (banker's rounding)
        # JS Math.round(2.5) === 3 (half-up)
        self.assertEqual(collector.js_round(2.5), 3)
        self.assertEqual(collector.js_round(3.5), 4)
        self.assertEqual(collector.js_round(12.5), 13)
        self.assertEqual(collector.js_round(12.4), 12)
        self.assertEqual(collector.js_round(12.6), 13)

    def test_calc_percent(self):
        # 1 / 80 * 1000 = 12.5 -> JS Math.round(12.5)/10 = 1.3 (Python round gives 1.2)
        self.assertEqual(collector.calc_percent(1, 80), 1.3)
        self.assertEqual(collector.calc_percent(40, 100), 40.0)
        self.assertEqual(collector.calc_percent(0, 100), 0.0)
        self.assertIsNone(collector.calc_percent(None, 100))
        self.assertIsNone(collector.calc_percent(10, None))
        self.assertIsNone(collector.calc_percent(10, 0))
        self.assertIsNone(collector.calc_percent(10, -5))


class TestCollectorStatvfs(unittest.TestCase):
    def test_isolated_statvfs_real_dir(self):
        stats = collector.isolated_statvfs(os.getcwd())
        self.assertIsNotNone(stats)
        self.assertEqual(len(stats), 4)
        bsize, blocks, bfree, bavail = stats
        self.assertGreater(bsize, 0)
        self.assertGreater(blocks, 0)
        self.assertGreaterEqual(bfree, 0)
        self.assertGreaterEqual(bavail, 0)

    def test_isolated_statvfs_missing_dir(self):
        stats = collector.isolated_statvfs("/path/that/does/not/exist/999999")
        self.assertIsNone(stats)

    @patch("subprocess.run")
    def test_isolated_statvfs_timeout_handled(self, mock_run):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd=["python3"], timeout=5.0)
        stats = collector.isolated_statvfs("/stalled/nfs/mount")
        self.assertIsNone(stats)

    def test_collect_filesystem_real_dir(self):
        res = collector.collect_filesystem(os.getcwd())
        self.assertTrue(res["id"].startswith("fs_"))
        self.assertEqual(res["path"], os.getcwd())
        self.assertIsInstance(res["totalBytes"], int)
        self.assertGreater(res["totalBytes"], 0)
        self.assertIsInstance(res["usedPercent"], float)

    def test_collect_filesystem_unreadable_dir(self):
        res = collector.collect_filesystem("/path/that/does/not/exist/999999")
        self.assertTrue(res["id"].startswith("fs_"))
        self.assertIsNone(res["totalBytes"])
        self.assertIsNone(res["usedBytes"])
        self.assertIsNone(res["availableBytes"])
        self.assertIsNone(res["usedPercent"])


class TestCollectorZpool(unittest.TestCase):
    def test_parse_zpool_empty(self):
        self.assertEqual(collector.parse_zpool(""), [])
        self.assertEqual(collector.parse_zpool("   \n"), [])
        self.assertEqual(collector.parse_zpool("no pools available\n"), [])

    def test_parse_zpool_valid(self):
        out = "1234567890123\ttank\tONLINE\t1000000000\t400000000\t600000000\n"
        pools = collector.parse_zpool(out)
        self.assertIsNotNone(pools)
        self.assertEqual(len(pools), 1)
        self.assertEqual(pools[0]["id"], "1234567890123")
        self.assertEqual(pools[0]["name"], "tank")
        self.assertEqual(pools[0]["health"], "ONLINE")
        self.assertEqual(pools[0]["totalBytes"], 1000000000)
        self.assertEqual(pools[0]["usedBytes"], 400000000)
        self.assertEqual(pools[0]["freeBytes"], 600000000)
        self.assertEqual(pools[0]["usedPercent"], 40.0)

    def test_parse_zpool_unavail_dashes(self):
        out = "99887766\tdeadpool\tUNAVAIL\t-\t-\t-\n"
        pools = collector.parse_zpool(out)
        self.assertIsNotNone(pools)
        self.assertEqual(len(pools), 1)
        self.assertEqual(pools[0]["health"], "UNAVAIL")
        self.assertIsNone(pools[0]["totalBytes"])
        self.assertIsNone(pools[0]["usedBytes"])
        self.assertIsNone(pools[0]["freeBytes"])
        self.assertIsNone(pools[0]["usedPercent"])

    def test_parse_zpool_corrupt_line_returns_none(self):
        # Parity with server parseZpool: an invalid line causes the whole result to be None
        # Wrong column count
        self.assertIsNone(collector.parse_zpool("123\ttank\tONLINE\t1000\n"))
        # Non-numeric GUID
        self.assertIsNone(collector.parse_zpool("not_a_guid\ttank\tONLINE\t1000\t400\t600\n"))
        # Non-numeric size
        self.assertIsNone(collector.parse_zpool("123\ttank\tONLINE\tinvalid_size\t400\t600\n"))


class TestCollectorConfigPrecedence(unittest.TestCase):
    def test_read_config_var_prefers_file_over_environ(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = os.path.join(tmpdir, "chirp.env")
            with open(env_path, "w") as f:
                f.write('CHIRP_FILESYSTEM_PATHS="/data,/mnt"\n')
                f.write('CHIRP_ZFS_ENABLED="true"\n')

            # os.environ has old/different values (e.g. from systemd startup)
            with patch.dict(os.environ, {
                "CHIRP_FILESYSTEM_PATHS": "/old",
                "CHIRP_ZFS_ENABLED": "false",
                "CHIRP_DEVICES": "/dev/sda",
            }):
                env_file = collector.load_env_file(env_path)
                # Defined in file: file wins!
                self.assertEqual(collector.read_config_var(env_file, "CHIRP_FILESYSTEM_PATHS"), "/data,/mnt")
                self.assertEqual(collector.read_config_var(env_file, "CHIRP_ZFS_ENABLED"), "true")
                # Removed/absent from file: returns default (empty), NOT stale os.environ!
                self.assertEqual(collector.read_config_var(env_file, "CHIRP_DEVICES"), "")

    def test_read_config_var_falls_back_when_file_absent(self):
        with patch.dict(os.environ, {"CHIRP_DEVICES": "/dev/sdb"}):
            self.assertEqual(collector.read_config_var(None, "CHIRP_DEVICES"), "/dev/sdb")


class TestCollectorStorageCollection(unittest.TestCase):
    def test_collect_storage_disabled(self):
        self.assertIsNone(collector.collect_storage([], False))
        self.assertIsNone(collector.collect_storage(None, False))

    def test_run_collection_reuses_storage_when_not_requested(self):
        # When collect_storage_now is False, last_storage (even if None) is reused without work
        with patch.object(collector, "collect_storage") as mock_storage:
            snap, smart, storage = collector.run_collection(
                smartctl_bin="smartctl",
                sysfs_root="/sys",
                proc_root="/proc",
                last_smart={"collectedAt": 100, "devices": []},
                last_storage=None,
                collect_smart_now=False,
                collect_storage_now=False,
            )
            mock_storage.assert_not_called()
            self.assertIsNone(storage)
            self.assertIsNone(snap["storage"])


class TestCollectorAtomicWrite(unittest.TestCase):
    def test_write_snapshot_atomic(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            out_file = os.path.join(tmpdir, "host.json")
            data = {"version": 1, "test": "ok"}
            collector.write_snapshot_atomic(data, out_file)

            self.assertTrue(os.path.isfile(out_file))
            mode = os.stat(out_file).st_mode & 0o777
            self.assertEqual(mode, 0o644)
            with open(out_file, "r") as f:
                loaded = json.load(f)
            self.assertEqual(loaded, data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
