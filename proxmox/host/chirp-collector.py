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
import glob
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


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


def collect_hwmon(sysfs_root: str, proc_root: str) -> Dict[str, Any]:
    hwmon_base = os.path.join(sysfs_root, "class", "hwmon")
    chips: List[Dict[str, Any]] = []

    sensors_list: List[Dict[str, Any]] = []
    power_list: List[Dict[str, Any]] = []
    fans_list: List[Dict[str, Any]] = []
    voltages_list: List[Dict[str, Any]] = []

    cpu_readout: Optional[Dict[str, Any]] = None
    cpu_chips = ["coretemp", "k10temp", "zenpower", "cpu_thermal"]

    if os.path.isdir(hwmon_base):
        for d in sorted(os.listdir(hwmon_base)):
            path = os.path.join(hwmon_base, d)
            name = (read_text(os.path.join(path, "name")) or "").strip()
            if not name:
                continue

            # Read temp sensors
            temps = []
            for f in sorted(os.listdir(path)):
                m = re.match(r"^temp(\d+)_input$", f)
                if m:
                    idx = m.group(1)
                    raw_val = read_float(os.path.join(path, f))
                    val = round(raw_val / 1000.0, 1) if raw_val is not None else None
                    lbl = (read_text(os.path.join(path, f"temp{idx}_label")) or f"temp{idx}").strip()
                    temps.append({"label": lbl, "temp": val})
                    sensors_list.append({"chip": name, "label": lbl, "temp": val})

                # Fans
                mf = re.match(r"^fan(\d+)_input$", f)
                if mf:
                    idx = mf.group(1)
                    rpm = read_int(os.path.join(path, f))
                    lbl = (read_text(os.path.join(path, f"fan{idx}_label")) or f"fan{idx}").strip()
                    fans_list.append({"id": f"{name}_{lbl}", "chip": name, "label": lbl, "rpm": rpm})

                # Voltages
                mv = re.match(r"^in(\d+)_input$", f)
                if mv:
                    idx = mv.group(1)
                    raw_v = read_float(os.path.join(path, f))
                    v = round(raw_v / 1000.0, 3) if raw_v is not None else None
                    lbl = (read_text(os.path.join(path, f"in{idx}_label")) or f"in{idx}").strip()
                    voltages_list.append({"id": f"{name}_{lbl}", "chip": name, "label": lbl, "volts": v})

                # Power
                mp = re.match(r"^power(\d+)_average$", f) or re.match(r"^power(\d+)_input$", f)
                if mp:
                    idx = mp.group(1)
                    raw_p = read_float(os.path.join(path, f))
                    p = round(raw_p / 1000000.0, 1) if raw_p is not None else None
                    lbl = (read_text(os.path.join(path, f"power{idx}_label")) or f"power{idx}").strip()
                    power_list.append({"id": f"{name}_{lbl}", "chip": name, "label": lbl, "watts": p})

            if name in cpu_chips and not cpu_readout:
                temp_vals = [t["temp"] for t in temps if t["temp"] is not None]
                pkg_temp = max(temp_vals) if temp_vals else None
                cpu_readout = {
                    "packageTemp": pkg_temp,
                    "maxTemp": pkg_temp,
                    "highTemp": None,
                    "critTemp": None,
                    "cores": temps,
                    "source": name,
                }

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


def collect_smart(smartctl_bin: str) -> Dict[str, Any]:
    # 1. Discover devices using smartctl --scan (never --scan-open)
    cmd = [smartctl_bin, "--scan"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        lines = proc.stdout.splitlines()
    except (subprocess.SubprocessError, OSError):
        return {"collectedAt": int(time.time() * 1000), "devices": []}

    by_id_map = scan_by_ids()
    devices: List[Dict[str, Any]] = []

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
            # Drop generic 'scsi' type to let smartctl auto-detect SAT
            if dev_type == "scsi":
                dev_type = None

        # Run smartctl -a -j -n standby
        read_cmd = [smartctl_bin, "-a", "-j", "-n", "standby"]
        if dev_type:
            read_cmd.extend(["-d", dev_type])
        read_cmd.append(dev_path)

        try:
            r = subprocess.run(read_cmd, capture_output=True, text=True, timeout=15)
            # Standby exit code 2 still contains valid JSON
            raw_json = json.loads(r.stdout) if r.stdout.strip().startswith("{") else {}
        except (subprocess.SubprocessError, OSError, json.JSONDecodeError):
            raw_json = {}

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
    force_smart: bool = False,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    now_ms = int(time.time() * 1000)
    uname = os.uname()

    smart_data = last_smart
    if force_smart or smart_data is None:
        smart_data = collect_smart(smartctl_bin)

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
    }
    return snapshot, smart_data


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
    parser.add_argument("--smartctl", default="smartctl", help="Path to smartctl binary")
    parser.add_argument("--sysfs-root", default="/sys", help="Sysfs mount path")
    parser.add_argument("--proc-root", default="/proc", help="Procfs mount path")

    args = parser.parse_args()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    output_path = os.path.join(args.output_dir, args.output_file)

    if args.once or not args.daemon:
        snapshot, _ = run_collection(args.smartctl, args.sysfs_root, args.proc_root, None, force_smart=True)
        write_snapshot_atomic(snapshot, output_path)
        print(f"chirp-collector: written snapshot to {output_path}")
        return 0

    print(f"chirp-collector: starting daemon (output: {output_path}, metrics: {args.metric_interval}s, smart: {args.smart_interval}s)")

    last_smart: Optional[Dict[str, Any]] = None
    last_smart_time = 0.0

    while running:
        t0 = time.time()
        need_smart = (t0 - last_smart_time) >= args.smart_interval or last_smart is None

        try:
            snapshot, last_smart = run_collection(
                args.smartctl,
                args.sysfs_root,
                args.proc_root,
                last_smart,
                force_smart=need_smart,
            )
            if need_smart:
                last_smart_time = t0
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
