#!/usr/bin/env python3
"""
chirp-collector.py - Host metrics and hardware reader for unprivileged chirp LXC containers.

Runs as host root on Proxmox VE. Gathers procfs, netdev, hwmon, rapl, and SMART data
(with standby preservation; never wakes a sleeping disk) and writes an atomic snapshot
to /run/chirp/host.json (0644).

Standard library only: Python 3.9+ compatible. No pip packages, no external jq needed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import signal
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple


def slug(s: str) -> str:
    """Format string into ^[a-z0-9_]+$ slug matching chirp-server diskIdentity.ts slug."""
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s.strip("_")


def load_env_file(path: str = "/etc/chirp/chirp.env") -> Optional[Dict[str, str]]:
    """Parse key=value pairs from an env file without shell evaluation. Returns None if file does not exist."""
    if not os.path.isfile(path):
        return None
    env: Dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith(";"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("\"'")
                    env[k] = v
    except OSError:
        return None
    return env


def read_config_var(
    cur_env_file: Optional[Dict[str, str]],
    key: str,
    default: str = "",
    initial_env_file: Optional[Dict[str, str]] = None,
) -> str:
    """
    Get configuration variable respecting explicit environment overrides while
    allowing runtime live reloads from /etc/chirp/chirp.env under systemd.
    - If key in os.environ is an explicit override (set via CLI or systemd drop-in Environment=),
      it takes highest precedence.
    - Otherwise, if cur_env_file is provided and has the key, the live file value is used.
    - If the key came from the env file at start but is gone from the live file, default is used.
    - Otherwise, falls back to os.environ or default.
    """
    init_file = initial_env_file or {}
    if key in os.environ:
        val = os.environ[key]
        if key not in init_file or val != init_file[key]:
            return val

    if cur_env_file is not None and key in cur_env_file:
        return cur_env_file[key]

    if key in init_file:
        # Loaded from the env file at start but removed from the live file: do not resurrect it.
        return default

    return os.environ.get(key, default)


def read_text(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def read_int(path: str) -> Optional[int]:
    txt = read_text(path)
    if not txt:
        return None
    try:
        return int(txt.strip())
    except ValueError:
        return None


def read_float(path: str) -> Optional[float]:
    txt = read_text(path)
    if not txt:
        return None
    try:
        return float(txt.strip())
    except ValueError:
        return None


def read_milli(path: str) -> Optional[float]:
    """Read millidegrees (e.g. 45000 -> 45.0)."""
    raw = read_float(path)
    return round(raw / 1000.0, 1) if raw is not None else None


def get_uptime_seconds(proc_root: str) -> Optional[float]:
    txt = read_text(os.path.join(proc_root, "uptime"))
    if not txt:
        return None
    parts = txt.split()
    if parts:
        try:
            return float(parts[0])
        except ValueError:
            pass
    return None


def get_cpu_model(proc_root: str) -> Optional[str]:
    txt = read_text(os.path.join(proc_root, "cpuinfo"))
    if not txt:
        return None
    m = re.search(r"^model name\s*:\s*(.+)$", txt, re.MULTILINE | re.IGNORECASE)
    if not m:
        m = re.search(r"^(?:Model|Hardware)\s*:\s*(.+)$", txt, re.MULTILINE | re.IGNORECASE)
    if m:
        return " ".join(m.group(1).split())
    return None


def collect_proc(proc_root: str) -> Dict[str, Optional[str]]:
    return {
        "meminfo": read_text(os.path.join(proc_root, "meminfo")),
        "stat": read_text(os.path.join(proc_root, "stat")),
        "loadavg": read_text(os.path.join(proc_root, "loadavg")),
        "cpuinfo": read_text(os.path.join(proc_root, "cpuinfo")),
    }


def determine_net_kind(iface_dir: str, name: str) -> str:
    if os.path.exists(os.path.join(iface_dir, "bridge")):
        return "bridge"
    if os.path.exists(os.path.join(iface_dir, "bonding")):
        return "bond"
    uevent = read_text(os.path.join(iface_dir, "uevent")) or ""
    m = re.search(r"^DEVTYPE=(.+)$", uevent, re.MULTILINE)
    if m:
        devtype = m.group(1).strip()
        if devtype in ("bridge", "bond", "vlan"):
            return devtype
    if os.path.exists(os.path.join(iface_dir, "device")):
        return "physical"
    if re.match(r"^(vmbr|br)", name) and "." not in name:
        return "bridge"
    if re.match(r"^bond\d+$", name):
        return "bond"
    if "." in name or re.match(r"^vlan\d+$", name):
        return "vlan"
    return "virtual"


def collect_net(sysfs_root: str) -> List[Dict[str, Any]]:
    net_dir = os.path.join(sysfs_root, "class", "net")
    if not os.path.isdir(net_dir):
        return []

    interfaces = []
    try:
        names = sorted(os.listdir(net_dir))
    except OSError:
        return []

    for name in names:
        iface_dir = os.path.join(net_dir, name)
        operstate = (read_text(os.path.join(iface_dir, "operstate")) or "").strip() or None
        carrier = read_int(os.path.join(iface_dir, "carrier"))
        up = operstate == "up" or (operstate == "unknown" and carrier == 1)
        speed = read_int(os.path.join(iface_dir, "speed")) if up else None
        if speed is not None and speed <= 0:
            speed = None

        stats_dir = os.path.join(iface_dir, "statistics")
        interfaces.append({
            "name": name,
            "kind": determine_net_kind(iface_dir, name),
            "operState": operstate,
            "up": up,
            "ifindex": read_int(os.path.join(iface_dir, "ifindex")),
            "speedMbps": speed,
            "rxBytes": read_int(os.path.join(stats_dir, "rx_bytes")),
            "txBytes": read_int(os.path.join(stats_dir, "tx_bytes")),
            "rxErrors": read_int(os.path.join(stats_dir, "rx_errors")),
            "txErrors": read_int(os.path.join(stats_dir, "tx_errors")),
            "rxDropped": read_int(os.path.join(stats_dir, "rx_dropped")),
            "txDropped": read_int(os.path.join(stats_dir, "tx_dropped")),
        })
    return interfaces


def read_thermal_zone(sysfs_root: str) -> Optional[Dict[str, Any]]:
    thermal_base = os.path.join(sysfs_root, "class", "thermal")
    if not os.path.isdir(thermal_base):
        return None
    for d in sorted(os.listdir(thermal_base)):
        if not d.startswith("thermal_zone"):
            continue
        zdir = os.path.join(thermal_base, d)
        ztype = (read_text(os.path.join(zdir, "type")) or "").strip()
        if ztype not in ("x86_pkg_temp", "cpu-thermal", "cpu_thermal"):
            continue
        t = read_milli(os.path.join(zdir, "temp"))
        if t is not None:
            return {
                "packageTemp": t,
                "maxTemp": t,
                "highTemp": None,
                "critTemp": None,
                "cores": [],
                "source": "thermal_zone",
            }
    return None


def hwmon_key(sysfs_root: str, chip_path: str) -> str:
    """Stable key that survives hwmonN renumbering (relative to sysfs root)."""
    try:
        root_path = os.path.realpath(sysfs_root)
    except OSError:
        root_path = sysfs_root
    try:
        device_path = os.path.realpath(os.path.join(chip_path, "device"))
    except OSError:
        try:
            device_path = os.path.realpath(chip_path)
        except OSError:
            device_path = chip_path
    rel_path = os.path.relpath(device_path, root_path).replace("\\", "/")
    if rel_path.startswith("devices/"):
        return re.sub(r"(?:/hwmon)?/hwmon\d+$", "", rel_path)
    return rel_path


def hwmon_label(chip_path: str, prefix: str, idx: Any) -> str:
    """Read sensor label matching server readText(path)?.trim() || `${prefix}${i}`."""
    txt = read_text(os.path.join(chip_path, f"{prefix}{idx}_label"))
    return (txt.strip() if txt else "") or f"{prefix}{idx}"


def hwmon_id(chip_name: str, chip_key: str, prefix: str, idx: int, display: str) -> str:
    """Construct deterministic sensor ID matching server power.ts."""
    base = slug(f"{chip_name}_{display}") or prefix
    h = hashlib.sha256(f"{chip_key}/{prefix}{idx}".encode("utf-8")).hexdigest()[:16]
    return f"{base}_{h}"


def hwmon_temp_id(chip_name: str, chip_key: str, idx: int | str) -> str:
    """Stable temperature sensor ID matching server hwmon.ts."""
    h = hashlib.sha256(f"{chip_key}/{chip_name}/temp{idx}".encode("utf-8")).hexdigest()[:16]
    return f"temp_{h}"


def is_gpu(chip_path: str, chip_name: str) -> bool:
    if chip_name in ("coretemp", "k10temp", "zenpower", "cpu_thermal"):
        return False
    gpu_drivers = ("amdgpu", "radeon", "nouveau", "nvidia", "i915", "xe")
    if chip_name in gpu_drivers:
        return True
    try:
        driver = os.path.basename(os.readlink(os.path.join(chip_path, "device", "driver")))
        return driver in gpu_drivers
    except OSError:
        return False


def is_suspended(chip_path: str, chip_name: str) -> bool:
    if not is_gpu(chip_path, chip_name):
        return False
    status = read_text(os.path.join(chip_path, "device", "power", "runtime_status"))
    return (status or "").strip() == "suspended"


def collect_hwmon(sysfs_root: str, proc_root: str) -> Dict[str, Any]:
    hwmon_base = os.path.join(sysfs_root, "class", "hwmon")
    sensors_list: List[Dict[str, Any]] = []
    power_list: List[Dict[str, Any]] = []
    fans_list: List[Dict[str, Any]] = []
    voltages_list: List[Dict[str, Any]] = []

    cpu_chips = ["coretemp", "k10temp", "zenpower", "cpu_thermal"]
    detected_cpu_chips: List[Tuple[int, str, List[Dict[str, Any]]]] = []

    if os.path.isdir(hwmon_base):
        chip_dirs: List[Dict[str, Any]] = []
        for d in os.listdir(hwmon_base):
            cpath = os.path.join(hwmon_base, d)
            cname = (read_text(os.path.join(cpath, "name")) or "").strip()
            if not cname:
                continue
            ckey = hwmon_key(sysfs_root, cpath)
            csuspended = is_suspended(cpath, cname)
            chip_dirs.append({
                "path": cpath,
                "name": cname,
                "key": ckey,
                "suspended": csuspended,
            })
        chip_dirs.sort(key=lambda c: (c["name"], c["key"], c["path"]))

        # Match server hwmon.ts: select first matching CPU driver name and filter to chips of that driver
        primary_cpu_driver = next(
            (c["name"] for c in chip_dirs if c["name"] in ("coretemp", "k10temp", "zenpower", "cpu_thermal")),
            None,
        )

        for chip_order, chip in enumerate(chip_dirs):
            path = chip["path"]
            name = chip["name"]
            key = chip["key"]
            suspended = chip["suspended"]
            files = sorted(os.listdir(path))

            # Temp sensors
            chip_temps: List[Dict[str, Any]] = []
            temp_indices = sorted(list({int(m.group(1)) for f in files if (m := re.match(r"^temp(\d+)_input$", f))}))
            for idx in temp_indices:
                t = read_milli(os.path.join(path, f"temp{idx}_input")) if not suspended else None
                t_max = read_milli(os.path.join(path, f"temp{idx}_max")) if not suspended else None
                t_crit = read_milli(os.path.join(path, f"temp{idx}_crit")) if not suspended else None
                label = hwmon_label(path, "temp", idx)
                entry = {"label": label, "temp": t, "max": t_max, "crit": t_crit, "index": idx}
                chip_temps.append(entry)

            if primary_cpu_driver and name == primary_cpu_driver:
                # Find package socket number (fallback to chip_order matching server's chipCpu)
                socket = chip_order
                for e in chip_temps:
                    sm = re.search(r"Package id (\d+)", e["label"], re.IGNORECASE)
                    if sm:
                        socket = int(sm.group(1))
                        break
                detected_cpu_chips.append((socket, name, chip_temps))
            else:
                for e in chip_temps:
                    sensor_id = hwmon_temp_id(name, key, e["index"])
                    sensors_list.append({"id": sensor_id, "chip": name, "label": e["label"], "temp": e["temp"]})

            # Fans
            fan_indices = sorted(list({int(m.group(1)) for f in files if (m := re.match(r"^fan(\d+)_input$", f))}))
            for idx in fan_indices:
                rpm = None
                if not suspended:
                    raw_rpm = read_int(os.path.join(path, f"fan{idx}_input"))
                    rpm = round(raw_rpm) if raw_rpm is not None else None
                label = hwmon_label(path, "fan", idx)
                sensor_id = hwmon_id(name, key, "fan", idx, label)
                fans_list.append({"id": sensor_id, "chip": name, "label": label, "rpm": rpm})

            # Voltages
            in_indices = sorted(list({int(m.group(1)) for f in files if (m := re.match(r"^in(\d+)_input$", f))}))
            for idx in in_indices:
                volts = None
                if not suspended:
                    raw_v = read_float(os.path.join(path, f"in{idx}_input"))
                    volts = round(raw_v / 1000.0, 3) if raw_v is not None else None
                label = hwmon_label(path, "in", idx)
                sensor_id = hwmon_id(name, key, "in", idx, label)
                voltages_list.append({"id": sensor_id, "chip": name, "label": label, "volts": volts})

            # Power
            power_indices = sorted(list({int(m.group(1)) for f in files if (m := re.match(r"^power(\d+)_(?:input|average)$", f))}))
            for idx in power_indices:
                watts = None
                if not suspended:
                    raw_p = read_float(os.path.join(path, f"power{idx}_input"))
                    if raw_p is None:
                        raw_p = read_float(os.path.join(path, f"power{idx}_average"))
                    watts = round(raw_p / 1000000.0, 1) if raw_p is not None else None
                label = hwmon_label(path, "power", idx)
                sensor_id = hwmon_id(name, key, "power", idx, label)
                power_list.append({"id": sensor_id, "chip": name, "label": label, "watts": watts})

    # Build CPU readout matching server hwmon.ts logic
    cpu_readout: Optional[Dict[str, Any]] = None
    if detected_cpu_chips:
        detected_cpu_chips.sort(key=lambda x: x[0])
        multi_socket = len(detected_cpu_chips) > 1
        all_cores: List[Dict[str, Any]] = []
        pkg_temps: List[float] = []
        high_limits: List[float] = []
        crit_limits: List[float] = []
        primary_source = detected_cpu_chips[0][1]

        for socket, _cname, entries in detected_cpu_chips:
            # Find package/die sensor matching server priority: Package id N > Tdie > Tctl > Package
            pkg_entry = None
            for pat in [r"^Package id \d+$", r"^Tdie$", r"^Tctl$", r"^Package"]:
                for e in entries:
                    if re.search(pat, e["label"], re.IGNORECASE) and e["temp"] is not None:
                        pkg_entry = e
                        break
                if pkg_entry:
                    break

            if pkg_entry and pkg_entry["temp"] is not None:
                pkg_temps.append(pkg_entry["temp"])

            # High & Crit limits
            for e in entries:
                if e["max"] is not None:
                    high_limits.append(e["max"])
                if e["crit"] is not None:
                    crit_limits.append(e["crit"])

            for e in entries:
                if e == pkg_entry or re.search(r"^(Package|Tctl|Tdie)", e["label"], re.IGNORECASE):
                    continue
                lbl = f"Package {socket} {e['label']}" if multi_socket else e["label"]
                all_cores.append({"label": lbl, "temp": e["temp"]})

        core_temps = [c["temp"] for c in all_cores if c["temp"] is not None]
        core_max = max(core_temps) if core_temps else None
        pkg_max = max(pkg_temps) if pkg_temps else None
        package_temp = pkg_max if pkg_max is not None else core_max
        overall_max = max([t for t in [core_max, pkg_max] if t is not None], default=None)

        cpu_readout = {
            "packageTemp": package_temp,
            "maxTemp": overall_max,
            "highTemp": min(high_limits) if high_limits else None,
            "critTemp": min(crit_limits) if crit_limits else None,
            "cores": all_cores,
            "source": primary_source,
        }
    else:
        cpu_readout = read_thermal_zone(sysfs_root)

    # RAPL zones
    rapl_zones: List[Dict[str, Any]] = []
    powercap_base = os.path.join(sysfs_root, "class", "powercap")
    if os.path.isdir(powercap_base):
        for d in sorted(os.listdir(powercap_base)):
            if re.match(r"^intel-rapl:\d+(:\d+)?$", d):
                zone_dir = os.path.join(powercap_base, d)
                name = (read_text(os.path.join(zone_dir, "name")) or d).strip()
                rapl_zones.append({
                    "zone": d,
                    "label": name,
                    "isPackage": "package" in name.lower() or ":" not in d.split(":", 1)[1],
                    "energyUj": read_int(os.path.join(zone_dir, "energy_uj")),
                    "maxEnergyRangeUj": read_int(os.path.join(zone_dir, "max_energy_range_uj")),
                })

    return {
        "cpuModel": get_cpu_model(proc_root),
        "cpu": cpu_readout,
        "sensors": sensors_list,
        "rapl": rapl_zones,
        "power": power_list,
        "fans": fans_list,
        "voltages": voltages_list,
    }


def scan_by_ids() -> Dict[str, List[str]]:
    by_ids: Dict[str, List[str]] = {}
    by_id_dir = "/dev/disk/by-id"
    if not os.path.isdir(by_id_dir):
        return by_ids

    try:
        entries = os.listdir(by_id_dir)
    except OSError:
        return by_ids

    for entry in sorted(entries):
        link_path = os.path.join(by_id_dir, entry)
        try:
            target = os.path.realpath(link_path)
            by_ids.setdefault(target, []).append(entry)
        except OSError:
            pass
    return by_ids


def parse_device_types(env_str: Optional[str]) -> Dict[str, str]:
    types: Dict[str, str] = {}
    if not env_str:
        return types
    # Commas can appear in device types (/dev/sda=megaraid,0)
    for token in env_str.split(","):
        token = token.strip()
        if not token:
            continue
        idx = token.rfind("=")
        if idx > 0:
            dev = token[:idx].strip()
            dtype = token[idx + 1:].strip()
            if dev and dtype:
                types[dev] = dtype
    return types


def resolve_device_type(
    dev_path: str,
    dev_types: Dict[str, str],
    by_ids: Optional[List[str]] = None,
) -> Optional[str]:
    """Resolve device type across raw paths, realpaths, and by-id symlinks."""
    if not dev_types:
        return None
    if dev_path in dev_types:
        return dev_types[dev_path]
    try:
        real = os.path.realpath(dev_path)
        if real in dev_types:
            return dev_types[real]
    except OSError:
        real = dev_path

    if by_ids:
        for bid in by_ids:
            if bid in dev_types:
                return dev_types[bid]
            bid_full = f"/dev/disk/by-id/{bid}"
            if bid_full in dev_types:
                return dev_types[bid_full]

    for k, v in dev_types.items():
        try:
            if os.path.realpath(k) == real:
                return v
        except OSError:
            pass
    return None


def collect_smart(
    smartctl_bin: str,
    configured_devices: Optional[List[str]] = None,
    device_types: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    by_id_map = scan_by_ids()
    target_devices: List[Tuple[str, Optional[str]]] = []
    dev_types = device_types or {}

    if configured_devices:
        for d in configured_devices:
            by_ids = by_id_map.get(os.path.realpath(d), [])
            dtype = resolve_device_type(d, dev_types, by_ids)
            target_devices.append((d, dtype))
    else:
        # Discover devices using smartctl --scan (never --scan-open)
        cmd = [smartctl_bin, "--scan"]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            lines = proc.stdout.splitlines()
        except (subprocess.SubprocessError, OSError):
            lines = []

        for line in lines:
            cleaned = line.split("#", 1)[0].strip()
            if not cleaned:
                continue
            parts = cleaned.split()
            if not parts:
                continue
            dev_path = parts[0]
            dev_type = None
            if len(parts) >= 3 and parts[1] == "-d":
                dev_type = parts[2]
                if dev_type == "scsi":
                    dev_type = None
            by_ids = by_id_map.get(os.path.realpath(dev_path), [])
            override_type = resolve_device_type(dev_path, dev_types, by_ids)
            if override_type:
                dev_type = override_type
            target_devices.append((dev_path, dev_type))

    devices: List[Dict[str, Any]] = []

    for dev_path, dev_type in target_devices:
        read_cmd = [smartctl_bin, "-a", "-j", "-n", "standby"]
        if dev_type:
            read_cmd.extend(["-d", dev_type])
        read_cmd.append(dev_path)

        raw_json: Optional[Dict[str, Any]] = None
        try:
            r = subprocess.run(read_cmd, capture_output=True, text=True, timeout=15)
            # Retain smartctl JSON output regardless of non-zero exit codes (such as
            # failing disk bit 8 or error log bit 64) so failing disks are not marked open_failed.
            out = r.stdout.strip()
            if out.startswith("{"):
                parsed = json.loads(out)
                if isinstance(parsed, dict) and ("device" in parsed or "smart_status" in parsed or "smartctl" in parsed):
                    raw_json = parsed
        except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
            raw_json = None

        by_ids = by_id_map.get(os.path.realpath(dev_path), [])
        wwn = None
        for bid in by_ids:
            if bid.startswith("wwn-"):
                wwn = bid[4:]
                break

        devices.append({
            "devicePath": dev_path,
            "type": dev_type,
            "byIds": by_ids,
            "wwn": wwn,
            "smartctl": raw_json,
        })

    return {
        "collectedAt": int(time.time() * 1000),
        "devices": devices,
    }


def js_round(x: float) -> int:
    """Math.round half-up parity with JavaScript."""
    return math.floor(x + 0.5)


def calc_percent(used: Optional[int], total: Optional[int]) -> Optional[float]:
    """Calculate percentage with 1 decimal place matching JavaScript storage.ts."""
    if used is None or total is None or total <= 0:
        return None
    val = (used / total) * 1000.0
    return js_round(val) / 10.0


def validate_filesystem_paths(raw: Optional[str]) -> List[str]:
    """Validate CHIRP_FILESYSTEM_PATHS matching server config rules. Raises ValueError on invalid input."""
    if not raw or not raw.strip():
        return []
    items = [p.strip() for p in raw.split(",") if p.strip()]
    unique_paths: List[str] = []
    seen = set()
    for p in items:
        if p not in seen:
            seen.add(p)
            unique_paths.append(p)

    if len(unique_paths) > 32 or any(
        not p.startswith("/") or "\0" in p or ".." in p.split("/") for p in unique_paths
    ):
        raise ValueError(
            "CHIRP_FILESYSTEM_PATHS (at most 32) must be absolute paths without '..'"
        )
    return unique_paths


STATVFS_SCRIPT = """
import os, sys, json
try:
    st = os.statvfs(sys.argv[1])
    bsize = st.f_frsize or st.f_bsize
    sys.stdout.write(json.dumps([bsize, st.f_blocks, st.f_bfree, st.f_bavail]))
except Exception:
    sys.exit(1)
"""


# statvfs children abandoned at a deadline that may still be alive (for example stuck in
# kernel D-state on a hung hard NFS mount, where SIGKILL stays pending). Keyed by path so
# at most one child per path exists at any time, mirroring pendingFs in storage.ts.
_PENDING_STATVFS: Dict[str, "subprocess.Popen[str]"] = {}


def _abandon_child(proc: "subprocess.Popen[str]") -> None:
    """
    Kill a child and close its pipes WITHOUT waiting.
    CRITICAL: never call wait()/communicate() without a timeout here. A child blocked in
    uninterruptible sleep ignores SIGKILL until the syscall returns, so wait() would hang.
    """
    try:
        proc.kill()
    except OSError:
        pass
    for pipe in (proc.stdout, proc.stderr):
        try:
            if pipe:
                pipe.close()
        except OSError:
            pass


def _spawn_statvfs(path: str) -> Optional["subprocess.Popen[str]"]:
    try:
        return subprocess.Popen(
            [sys.executable, "-I", "-c", STATVFS_SCRIPT, path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except (subprocess.SubprocessError, OSError, ValueError):
        return None


def _parse_statvfs(stdout: Optional[str]) -> Optional[Tuple[int, int, int, int]]:
    """Validate the child's JSON output: [bsize, blocks, bfree, bavail] with sane ordering."""
    if not stdout:
        return None
    try:
        data = json.loads(stdout)
    except (json.JSONDecodeError, ValueError):
        return None
    if not (isinstance(data, list) and len(data) == 4 and all(isinstance(x, int) for x in data)):
        return None
    bsize, blocks, bfree, bavail = data
    if bsize > 0 and bfree <= blocks and bavail <= bfree:
        return (bsize, blocks, bfree, bavail)
    return None


def collect_filesystems(paths: List[str], timeout: float = 5.0) -> List[Dict[str, Any]]:
    """
    Collect filesystem stats for all paths concurrently with an overall timeout.
    Each path is probed by an isolated child process. Children that miss the deadline
    are killed and abandoned (never waited on) and remembered in _PENDING_STATVFS; while
    such a child is still alive, no new child is spawned for that path and the path is
    reported with null values. Even if several remote mounts are hung in D-state, the
    batch finishes within timeout seconds and never starves other metrics.
    """
    if not paths:
        return []

    # Reap children from previous rounds that have exited; skip paths whose child is still alive.
    for p in list(_PENDING_STATVFS):
        if _PENDING_STATVFS[p].poll() is not None:
            del _PENDING_STATVFS[p]

    procs: List[Tuple[str, "subprocess.Popen[str]"]] = []
    for p in paths:
        if p in _PENDING_STATVFS:
            continue
        proc = _spawn_statvfs(p)
        if proc is not None:
            procs.append((p, proc))

    t_deadline = time.monotonic() + timeout
    raw_outputs: Dict[str, Optional[str]] = {}

    while time.monotonic() < t_deadline:
        all_finished = True
        for p, proc in procs:
            if p in raw_outputs:
                continue
            ret = proc.poll()
            if ret is not None:
                try:
                    stdout, _ = proc.communicate()
                    raw_outputs[p] = stdout if ret == 0 else None
                except Exception:
                    raw_outputs[p] = None
            else:
                all_finished = False
        if all_finished:
            break
        time.sleep(0.02)

    # Abandon unfinished children without blocking wait() and remember them.
    for p, proc in procs:
        if p not in raw_outputs:
            raw_outputs[p] = None
            _abandon_child(proc)
            _PENDING_STATVFS[p] = proc

    results: List[Dict[str, Any]] = []
    for p in paths:
        fs_id = f"fs_{hashlib.sha256(p.encode('utf-8')).hexdigest()[:16]}"
        entry: Dict[str, Any] = {
            "id": fs_id,
            "path": p,
            "totalBytes": None,
            "usedBytes": None,
            "availableBytes": None,
            "usedPercent": None,
        }
        parsed = _parse_statvfs(raw_outputs.get(p))
        if parsed is not None:
            bsize, blocks, bfree, bavail = parsed
            used = (blocks - bfree) * bsize
            available = bavail * bsize
            entry.update({
                "totalBytes": blocks * bsize,
                "usedBytes": used,
                "availableBytes": available,
                "usedPercent": calc_percent(used, used + available),
            })
        results.append(entry)

    return results


def collect_filesystem(path: str, timeout: float = 5.0) -> Dict[str, Any]:
    """Collect statistics for a single path; thin wrapper over collect_filesystems."""
    return collect_filesystems([path], timeout=timeout)[0]


def parse_zpool(text: str) -> Optional[List[Dict[str, Any]]]:
    """Parse zpool list output matching server parseZpool. Returns None on any corrupt/invalid line."""
    stripped = text.strip()
    if not stripped or stripped == "no pools available":
        return []

    pools: List[Dict[str, Any]] = []
    for line in stripped.splitlines():
        fields = line.split("\t")
        if len(fields) != 6:
            return None
        guid, name, health, size, allocated, free = fields
        if not re.match(r"^\d+$", guid) or not name or not health:
            return None

        # Size, allocated, free must be '-' or an unsigned integer within safe integer range
        for val in (size, allocated, free):
            if val != "-":
                if not re.match(r"^\d+$", val):
                    return None
                n = int(val)
                if n < 0 or n > 9007199254740991:
                    return None

        total_bytes = int(size) if size != "-" else None
        used_bytes = int(allocated) if allocated != "-" else None
        free_bytes = int(free) if free != "-" else None
        used_pct = calc_percent(used_bytes, total_bytes)

        pools.append({
            "id": guid,
            "name": name,
            "health": health,
            "totalBytes": total_bytes,
            "usedBytes": used_bytes,
            "freeBytes": free_bytes,
            "usedPercent": used_pct,
        })
    return pools


def collect_zfs_pools(zpool_bin: str = "zpool") -> Optional[List[Dict[str, Any]]]:
    """Collect ZFS pool health and space usage via zpool list."""
    try:
        proc = subprocess.run(
            [zpool_bin, "list", "-Hp", "-o", "guid,name,health,size,allocated,free"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5.0,
            check=False,
            env={**os.environ, "LC_ALL": "C"},
        )
    except (subprocess.SubprocessError, OSError):
        return None

    if proc.returncode != 0:
        return None

    return parse_zpool(proc.stdout)


def collect_storage(
    filesystem_paths: Optional[List[str]],
    zfs_enabled: bool,
    zpool_bin: str = "zpool",
) -> Optional[Dict[str, Any]]:
    """Collect opt-in host filesystem and ZFS pool statistics."""
    has_fs = bool(filesystem_paths)
    if not has_fs and not zfs_enabled:
        return None

    now_ms = int(time.time() * 1000)
    filesystems = collect_filesystems(filesystem_paths, timeout=5.0) if has_fs else None
    zfs_pools = collect_zfs_pools(zpool_bin) if zfs_enabled else None

    return {
        "collectedAt": now_ms,
        "filesystems": filesystems,
        "zfsPools": zfs_pools,
    }


def write_snapshot_atomic(data: Dict[str, Any], output_path: str) -> None:
    parent = os.path.dirname(output_path)
    if parent:
        os.makedirs(parent, mode=0o755, exist_ok=True)

    tmp_path = f"{output_path}.tmp.{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())

    os.chmod(tmp_path, 0o644)
    os.replace(tmp_path, output_path)


def run_collection(
    smartctl_bin: str,
    sysfs_root: str,
    proc_root: str,
    last_smart: Optional[Dict[str, Any]],
    last_storage: Optional[Dict[str, Any]] = None,
    configured_devices: Optional[List[str]] = None,
    device_types: Optional[Dict[str, str]] = None,
    filesystem_paths: Optional[List[str]] = None,
    zfs_enabled: bool = False,
    collect_smart_now: bool = False,
    collect_storage_now: bool = False,
    zpool_bin: str = "zpool",
) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    now_ms = int(time.time() * 1000)
    uname = os.uname()

    smart_data = last_smart
    if collect_smart_now:
        smart_data = collect_smart(smartctl_bin, configured_devices, device_types)

    storage_data = last_storage
    if collect_storage_now:
        storage_data = collect_storage(filesystem_paths, zfs_enabled, zpool_bin)

    snapshot = {
        "version": 1,
        "timestamp": now_ms,
        "host": {
            "hostname": uname.nodename,
            "kernel": uname.release,
            "uptimeSeconds": get_uptime_seconds(proc_root),
        },
        "proc": collect_proc(proc_root),
        "net": {"interfaces": collect_net(sysfs_root)},
        "hwmon": collect_hwmon(sysfs_root, proc_root),
        "smart": smart_data,
        "storage": storage_data,
    }
    return snapshot, smart_data, storage_data


running = True


def handle_signal(sig: int, _frame: Any) -> None:
    global running
    running = False


def main() -> int:
    parser = argparse.ArgumentParser(description="chirp Host Collector for unprivileged containers")
    parser.add_argument("--output-dir", default="/run/chirp", help="Directory where host.json is stored")
    parser.add_argument("--output-file", default="host.json", help="Filename of the snapshot")
    parser.add_argument("--daemon", action="store_true", help="Run continuously in background")
    parser.add_argument("--once", action="store_true", help="Run once and exit")
    parser.add_argument("--metric-interval", type=int, default=10, help="Seconds between metric snapshots (default: 10)")
    parser.add_argument("--smart-interval", type=int, default=300, help="Seconds between SMART queries (default: 300)")
    parser.add_argument("--storage-interval", type=int, default=60, help="Seconds between storage queries (default: 60)")
    parser.add_argument("--smartctl", default="smartctl", help="Path to smartctl binary")
    parser.add_argument("--zpool", default="zpool", help="Path to zpool binary")
    parser.add_argument("--sysfs-root", default="/sys", help="Sysfs mount path")
    parser.add_argument("--proc-root", default="/proc", help="Procfs mount path")

    args = parser.parse_args()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    # Load configuration from environment, falling back to /etc/chirp/chirp.env
    initial_env_file = load_env_file("/etc/chirp/chirp.env")
    raw_devices = read_config_var(initial_env_file, "CHIRP_DEVICES", initial_env_file=initial_env_file)
    env_devices = [d.strip() for d in raw_devices.split(",") if d.strip()]
    configured_devices = env_devices if env_devices else None

    raw_types = read_config_var(initial_env_file, "CHIRP_DEVICE_TYPES", initial_env_file=initial_env_file)
    device_types = parse_device_types(raw_types)

    raw_fs = read_config_var(initial_env_file, "CHIRP_FILESYSTEM_PATHS", initial_env_file=initial_env_file)
    last_fs_error: Optional[str] = None
    try:
        filesystem_paths = validate_filesystem_paths(raw_fs)
    except ValueError as err:
        last_fs_error = str(err)
        print(f"chirp-collector: config error: {err} (filesystem storage collection disabled until fixed)", file=sys.stderr)
        filesystem_paths = []

    raw_zfs = read_config_var(initial_env_file, "CHIRP_ZFS_ENABLED", initial_env_file=initial_env_file).strip().lower()
    zfs_enabled = raw_zfs in ("1", "true", "yes", "on")

    output_path = os.path.join(args.output_dir, args.output_file)

    if args.once or not args.daemon:
        snapshot, _, _ = run_collection(
            args.smartctl,
            args.sysfs_root,
            args.proc_root,
            None,
            None,
            configured_devices=configured_devices,
            device_types=device_types,
            filesystem_paths=filesystem_paths,
            zfs_enabled=zfs_enabled,
            collect_smart_now=True,
            collect_storage_now=True,
            zpool_bin=args.zpool,
        )
        write_snapshot_atomic(snapshot, output_path)
        print(f"chirp-collector: written snapshot to {output_path}")
        return 0

    print(f"chirp-collector: starting daemon (output: {output_path}, metrics: {args.metric_interval}s, smart: {args.smart_interval}s, storage: {args.storage_interval}s)")

    last_smart: Optional[Dict[str, Any]] = None
    last_smart_time = 0.0
    has_collected_smart = False

    last_storage: Optional[Dict[str, Any]] = None
    last_storage_time = 0.0
    has_collected_storage = False

    while running:
        t0 = time.time()
        need_smart = (t0 - last_smart_time) >= args.smart_interval or not has_collected_smart
        need_storage = (t0 - last_storage_time) >= args.storage_interval or not has_collected_storage

        # Periodically re-check /etc/chirp/chirp.env so runtime config changes are picked up live
        cur_env_file = load_env_file("/etc/chirp/chirp.env")
        cur_raw_devs = read_config_var(cur_env_file, "CHIRP_DEVICES", initial_env_file=initial_env_file)
        cur_env_devs = [d.strip() for d in cur_raw_devs.split(",") if d.strip()]
        cur_configured = cur_env_devs if cur_env_devs else None

        cur_raw_types = read_config_var(cur_env_file, "CHIRP_DEVICE_TYPES", initial_env_file=initial_env_file)
        cur_dev_types = parse_device_types(cur_raw_types)

        cur_raw_fs = read_config_var(cur_env_file, "CHIRP_FILESYSTEM_PATHS", initial_env_file=initial_env_file)
        try:
            cur_fs_paths = validate_filesystem_paths(cur_raw_fs)
            if last_fs_error is not None:
                print("chirp-collector: config recovered: filesystem paths valid", file=sys.stderr)
                last_fs_error = None
            filesystem_paths = cur_fs_paths
        except ValueError as err:
            err_msg = str(err)
            if err_msg != last_fs_error:
                print(f"chirp-collector: config error: {err_msg}", file=sys.stderr)
                last_fs_error = err_msg
            cur_fs_paths = filesystem_paths

        cur_raw_zfs = read_config_var(cur_env_file, "CHIRP_ZFS_ENABLED", initial_env_file=initial_env_file).strip().lower()
        cur_zfs_enabled = cur_raw_zfs in ("1", "true", "yes", "on")

        try:
            snapshot, last_smart, last_storage = run_collection(
                args.smartctl,
                args.sysfs_root,
                args.proc_root,
                last_smart,
                last_storage,
                configured_devices=cur_configured,
                device_types=cur_dev_types,
                filesystem_paths=cur_fs_paths,
                zfs_enabled=cur_zfs_enabled,
                collect_smart_now=need_smart,
                collect_storage_now=need_storage,
                zpool_bin=args.zpool,
            )
            if need_smart:
                last_smart_time = t0
                has_collected_smart = True
            if need_storage:
                last_storage_time = t0
                has_collected_storage = True
            write_snapshot_atomic(snapshot, output_path)
        except Exception as e:
            print(f"chirp-collector: collection error: {e}", file=sys.stderr)

        elapsed = time.time() - t0
        sleep_dur = max(0.5, args.metric_interval - elapsed)

        # Sleep in small slices to respond promptly to SIGTERM
        sleep_until = time.time() + sleep_dur
        while running and time.time() < sleep_until:
            time.sleep(min(1.0, max(0.1, sleep_until - time.time())))

    print("chirp-collector: stopped cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
