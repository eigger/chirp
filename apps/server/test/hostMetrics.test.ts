import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Fan, Load, Memory, Network, Power, Voltage } from "@chirp/shared";
import { afterEach, describe, expect, it } from "vitest";
import { detectContainer, readProc, type HostRoots } from "../src/hostPaths.js";
import { HostMetrics } from "../src/hostMetrics.js";
import { globToRegExp, isShown, kindFromName, readInterfaces } from "../src/netdev.js";
import { energyWatts, readHwmonExtras, readRaplZones } from "../src/power.js";
import { counterRate, cpuUsagePercent, parseLoadavg, parseMeminfo, parseNetDev, parseProcStat } from "../src/procfs.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      chmodSync(r, 0o755);
    } catch {
      /* ignore */
    }
    rmSync(r, { recursive: true, force: true });
  }
});

/** Create a temp tree from {"rel/path": "content"}. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "chirp-host-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const MEMINFO = (totalKb: number, availKb: number, swapTotalKb = 8_388_604, swapFreeKb = 8_000_000) =>
  `MemTotal:       ${totalKb} kB\nMemFree:         1000000 kB\nMemAvailable:   ${availKb} kB\nBuffers:          100 kB\nCached:          2000 kB\nSwapTotal:       ${swapTotalKb} kB\nSwapFree:        ${swapFreeKb} kB\nHugePages_Total:       0\n`;

const STAT = (user: number, idle: number, cpus = 4) =>
  `cpu  ${user} 0 0 ${idle} 0 0 0 0 0 0\n` +
  Array.from({ length: cpus }, (_, i) => `cpu${i} 1 0 0 1 0 0 0 0 0 0`).join("\n") +
  "\nintr 1 2 3\nctxt 4\n";

function nic(name: string, extra: Record<string, string> = {}, counters: Partial<Record<string, number>> = {}) {
  const base = `class/net/${name}`;
  const files: Record<string, string> = {
    [`${base}/operstate`]: "up\n",
    [`${base}/uevent`]: `INTERFACE=${name}\n`,
  };
  for (const [k, v] of Object.entries({ rx_bytes: 1000, tx_bytes: 2000, rx_errors: 0, tx_errors: 0, rx_dropped: 1, tx_dropped: 0, ...counters })) {
    files[`${base}/statistics/${k}`] = `${v}\n`;
  }
  for (const [k, v] of Object.entries(extra)) files[`${base}/${k}`] = v;
  return files;
}

const under = (dir: string, files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [`${dir}/${k}`, v]));

function rootsFor(host: string | null, local: string, inContainer = true): HostRoots {
  return {
    hostProc: host ? join(host, "proc") : join(local, "proc"),
    hostSys: host ? join(host, "sys") : join(local, "sys"),
    proc: join(local, "proc"),
    sys: join(local, "sys"),
    inContainer,
  };
}

describe("procfs parsers", () => {
  it("meminfo", () => {
    const m = parseMeminfo(MEMINFO(16_000_000, 12_000_000));
    expect(m).toEqual({
      totalBytes: 16_000_000 * 1024,
      availableBytes: 12_000_000 * 1024,
      swapTotalBytes: 8_388_604 * 1024,
      swapFreeBytes: 8_000_000 * 1024,
    });
    expect(parseMeminfo("garbage")).toBeNull();
    expect(parseMeminfo("")).toBeNull();
    // no MemAvailable (old kernels): MemFree + Buffers + Cached
    expect(parseMeminfo("MemTotal: 100 kB\nMemFree: 10 kB\nBuffers: 5 kB\nCached: 20 kB\n")?.availableBytes).toBe(35 * 1024);
  });

  it("loadavg", () => {
    expect(parseLoadavg("0.52 0.58 0.59 1/1234 5678\n")).toEqual({ load1: 0.52, load5: 0.58, load15: 0.59 });
    expect(parseLoadavg("")).toBeNull();
    expect(parseLoadavg("x y z")).toBeNull();
  });

  it("stat and cpu usage", () => {
    const a = parseProcStat(STAT(100, 900));
    const b = parseProcStat(STAT(150, 950));
    expect(a?.cpuCount).toBe(4);
    expect(cpuUsagePercent(null, a!)).toBeNull();
    expect(cpuUsagePercent(a, b!)).toBe(50);
    // counter went backwards (reset) -> null
    expect(cpuUsagePercent(b, a!)).toBeNull();
    expect(parseProcStat("intr 1\n")).toBeNull();
  });

  it("net/dev", () => {
    const text =
      "Inter-|   Receive                                                |  Transmit\n" +
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n" +
      "    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n" +
      "  eth0: 5000 10 1 2 0 0 0 0 7000 20 3 4 0 0 0 0\n";
    const m = parseNetDev(text);
    expect(m?.get("eth0")).toMatchObject({ rxBytes: 5000, rxErrors: 1, rxDropped: 2, txBytes: 7000, txErrors: 3, txDropped: 4 });
  });

  it("counter rate: first sample, normal, 32-bit wrap, reset", () => {
    expect(counterRate(undefined, 100, 10)).toBeNull();
    expect(counterRate(100, 1100, 10)).toBe(100);
    expect(counterRate(2 ** 32 - 1000, 1000, 10)).toBe(200);
    expect(counterRate(5_000_000, 100, 10)).toBeNull();
    expect(counterRate(2 ** 40, 100, 10)).toBeNull();
    expect(counterRate(100, 200, 0)).toBeNull();
  });
});

describe("host roots and scope", () => {
  it("prefers the host mount and reports host scope", () => {
    const host = tree({ "proc/meminfo": MEMINFO(64_000_000, 40_000_000) });
    const local = tree({ "proc/meminfo": MEMINFO(512_000, 400_000) });
    const r = readProc(rootsFor(host, local), "meminfo", parseMeminfo);
    expect(r?.scope).toBe("host");
    expect(r?.value.totalBytes).toBe(64_000_000 * 1024);
  });

  it("falls back to the container view when the host file is missing, empty or unparsable", () => {
    const local = tree({ "proc/meminfo": MEMINFO(512_000, 400_000) });
    for (const host of [tree({}), tree({ "proc/meminfo": "" })]) {
      const r = readProc(rootsFor(host, local), "meminfo", parseMeminfo);
      expect(r?.scope).toBe("container");
      expect(r?.value.totalBytes).toBe(512_000 * 1024);
    }
  });

  it("local /proc outside a container is the host", () => {
    const local = tree({ "proc/meminfo": MEMINFO(512_000, 400_000) });
    expect(readProc(rootsFor(null, local, false), "meminfo", parseMeminfo)?.scope).toBe("host");
    expect(readProc(rootsFor(null, local, true), "meminfo", parseMeminfo)?.scope).toBe("container");
  });

  it("nothing readable -> null", () => {
    expect(readProc(rootsFor(tree({}), tree({})), "meminfo", parseMeminfo)).toBeNull();
  });

  it("unreadable (permission denied) host file falls back", () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    const host = tree({ "proc/meminfo": MEMINFO(64_000_000, 40_000_000) });
    chmodSync(join(host, "proc/meminfo"), 0o000);
    const local = tree({ "proc/meminfo": MEMINFO(512_000, 400_000) });
    expect(readProc(rootsFor(host, local), "meminfo", parseMeminfo)?.scope).toBe("container");
  });

  it("detects containers", () => {
    expect(detectContainer(tree({}))).toBe(false);
    expect(detectContainer(tree({ "run/systemd/container": "lxc\n" }))).toBe(true);
    expect(detectContainer(tree({ ".dockerenv": "" }))).toBe(true);
    expect(detectContainer(tree({ "proc/1/environ": "PATH=/bin\0container=lxc\0" }))).toBe(true);
  });
});

describe("network interfaces", () => {
  const hostSys = () =>
    tree({
      ...nic("eno1", { device: "", speed: "1000\n" }),
      ...nic("vmbr0", { bridge: "", speed: "-1\n" }),
      ...nic("bond0", { bonding: "" }),
      ...nic("vmbr0.100", { uevent: "DEVTYPE=vlan\nINTERFACE=vmbr0.100\n" }),
      ...nic("lo", { operstate: "unknown\n" }),
      ...nic("veth100i0"),
      ...nic("tap101i0"),
      ...nic("fwbr101i0", { bridge: "" }),
      ...nic("fwpr101p0"),
      ...nic("fwln101i0"),
      ...nic("docker0", { bridge: "" }),
      ...nic("wg0"),
      ...nic("enp3s0", { device: "", operstate: "down\n", speed: "" }),
    });

  it("classifies and filters by default (host view)", () => {
    const sys = hostSys();
    const r = readInterfaces({ hostProc: "/nonexistent", hostSys: sys, proc: "/nonexistent2", sys: "/nonexistent3", inContainer: true });
    expect(r?.scope).toBe("host");
    const shown = r!.value.filter((i) => isShown(i.name, i.kind, { include: [], exclude: [] }, r!.scope));
    expect(shown.map((i) => [i.name, i.kind])).toEqual([
      ["bond0", "bond"],
      ["eno1", "physical"],
      ["enp3s0", "physical"],
      ["vmbr0", "bridge"],
      ["vmbr0.100", "vlan"],
    ]);
    const eno1 = r!.value.find((i) => i.name === "eno1")!;
    expect(eno1.speedMbps).toBe(1000);
    expect(r!.value.find((i) => i.name === "vmbr0")!.speedMbps).toBeNull();
    expect(r!.value.find((i) => i.name === "enp3s0")!.operState).toBe("down");
  });

  it("CHIRP_NET_INCLUDE / CHIRP_NET_EXCLUDE", () => {
    const f = { include: ["wg*", "tap101*"], exclude: ["eno1", "tap*"] };
    expect(isShown("wg0", "virtual", f, "host")).toBe(true);
    expect(isShown("eno1", "physical", f, "host")).toBe(false);
    // exclude wins over include
    expect(isShown("tap101i0", "virtual", f, "host")).toBe(false);
    expect(isShown("vmbr0", "bridge", f, "host")).toBe(true);
    // container view: the container's own veth eth0 is shown
    expect(isShown("eth0", "virtual", { include: [], exclude: [] }, "container")).toBe(true);
    expect(isShown("lo", "virtual", { include: [], exclude: [] }, "container")).toBe(false);
    expect(globToRegExp("vmbr0.1?").test("vmbr0.10")).toBe(true);
    expect(globToRegExp("vmbr0.1?").test("vmbr0x10")).toBe(false);
  });

  it("falls back to the local sysfs, then /proc/net/dev", () => {
    const local = tree(under("sys", nic("eth0")));
    const r = readInterfaces(rootsFor(tree({}), local));
    expect(r?.scope).toBe("container");
    expect(r?.value.map((i) => i.name)).toEqual(["eth0"]);

    const netdev =
      "Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n" +
      "  eno1: 5000 10 0 0 0 0 0 0 7000 20 0 0 0 0 0 0\n vmbr0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n";
    // whole host /proc mounted (Docker): PID 1's namespace is the host
    const docker = readInterfaces(rootsFor(tree({ "proc/1/net/dev": netdev }), tree({})));
    expect(docker?.scope).toBe("host");
    expect(docker?.value.map((i) => [i.name, i.kind])).toEqual([["eno1", "physical"], ["vmbr0", "bridge"]]);
    expect(docker?.value[0].operState).toBeNull();

    const own = readInterfaces(rootsFor(tree({}), tree({ "proc/net/dev": netdev })));
    expect(own?.scope).toBe("container");
    expect(readInterfaces(rootsFor(tree({}), tree({})))).toBeNull();
  });

  it("kind from name", () => {
    expect(kindFromName("vmbr0")).toBe("bridge");
    expect(kindFromName("bond1")).toBe("bond");
    expect(kindFromName("vmbr0.20")).toBe("vlan");
    expect(kindFromName("enp1s0")).toBe("physical");
    expect(kindFromName("wg0")).toBe("virtual");
  });
});

describe("power, fans, voltages", () => {
  const sys = (energy: number) =>
    tree({
      "class/powercap/intel-rapl:0/name": "package-0\n",
      "class/powercap/intel-rapl:0/energy_uj": `${energy}\n`,
      "class/powercap/intel-rapl:0/max_energy_range_uj": "262143328850\n",
      "class/powercap/intel-rapl:0:0/name": "core\n",
      "class/powercap/intel-rapl:0:0/energy_uj": `${Math.floor(energy / 2)}\n`,
      "class/powercap/intel-rapl:0:0/max_energy_range_uj": "262143328850\n",
      "class/powercap/intel-rapl-mmio:0/name": "package-0\n",
      "class/hwmon/hwmon0/name": "nct6798\n",
      "class/hwmon/hwmon0/fan1_input": "1200\n",
      "class/hwmon/hwmon0/fan1_label": "CPU Fan\n",
      "class/hwmon/hwmon0/fan2_input": "0\n",
      "class/hwmon/hwmon0/in0_input": "1032\n",
      "class/hwmon/hwmon0/in1_input": "3344\n",
      "class/hwmon/hwmon0/in1_label": "+3.3V\n",
      "class/hwmon/hwmon1/name": "nct6798\n",
      "class/hwmon/hwmon1/fan1_input": "900\n",
      "class/hwmon/hwmon1/fan1_label": "CPU Fan\n",
      "class/hwmon/hwmon2/name": "amdgpu\n",
      "class/hwmon/hwmon2/power1_average": "25000000\n",
    });

  it("reads RAPL zones (mmio duplicates skipped) and computes watts with wrap", () => {
    const zones = readRaplZones(sys(1_000_000));
    expect(zones.map((z) => [z.zone, z.label, z.isPackage])).toEqual([
      ["intel-rapl:0", "package-0", true],
      ["intel-rapl:0:0", "package-0 core", false],
    ]);
    expect(energyWatts(undefined, 100, 1000, 10)).toBeNull();
    expect(energyWatts(1_000_000, 51_000_000, null, 10)).toBe(5);
    // wrap at max_energy_range_uj
    expect(energyWatts(990_000_000, 40_000_000, 1_000_000_000, 10)).toBe(5);
    expect(energyWatts(990_000_000, 40_000_000, null, 10)).toBeNull();
  });

  it("hwmon fans/voltages/power with labels and units", () => {
    const x = readHwmonExtras(sys(0));
    expect(x.fans).toEqual([
      { chip: "nct6798", label: "CPU Fan", rpm: 1200 },
      { chip: "nct6798", label: "fan2", rpm: 0 },
      { chip: "nct6798", label: "CPU Fan", rpm: 900 },
    ]);
    expect(x.voltages).toEqual([
      { chip: "nct6798", label: "in0", volts: 1.032 },
      { chip: "nct6798", label: "+3.3V", volts: 3.344 },
    ]);
    expect(x.power).toEqual([{ chip: "amdgpu", label: "power1", watts: 25 }]);
    expect(readHwmonExtras(tree({}))).toEqual({ power: [], fans: [], voltages: [] });
  });

  it("HostMetrics: RAPL package watts after the second sample, stable unique ids", () => {
    const empty = tree({});
    const r = { hostProc: empty, hostSys: empty, proc: empty, sys: empty, inContainer: false };
    const root = sys(1_000_000);
    const hm = new HostMetrics({ roots: r, sysfsRoot: root, netFilter: { include: [], exclude: [] } });
    const first = hm.sample(0);
    expect(Power.parse(first.power)).toMatchObject({ packageWatts: null, packageSource: "rapl" });
    writeFileSync(join(root, "class/powercap/intel-rapl:0/energy_uj"), "101000000\n");
    writeFileSync(join(root, "class/powercap/intel-rapl:0:0/energy_uj"), "50500000\n");
    const second = hm.sample(10_000);
    expect(second.power?.packageWatts).toBe(10);
    expect(second.power?.sources).toEqual([
      { id: "rapl_package_0", label: "package-0", watts: 10 },
      { id: "rapl_package_0_core", label: "package-0 core", watts: 5 },
      { id: "amdgpu_power1", label: "amdgpu power1", watts: 25 },
    ]);
    expect(second.fans.map((f) => f.id)).toEqual(["nct6798_cpu_fan", "nct6798_fan2", "nct6798_cpu_fan_2"]);
    expect(second.voltages.map((v) => v.id)).toEqual(["nct6798_in0", "nct6798_3_3v"]);
    for (const f of second.fans) Fan.parse(f);
    for (const v of second.voltages) Voltage.parse(v);
    // no /proc data at all -> sections are null, not objects of nulls
    expect(second.memory).toBeNull();
    expect(second.load).toBeNull();
    expect(second.network).toBeNull();
  });

  it("hwmon CPU power is the package fallback without RAPL; nothing readable -> null", () => {
    const empty = tree({});
    const r = { hostProc: empty, hostSys: empty, proc: empty, sys: empty, inContainer: false };
    const zen = tree({
      "class/hwmon/hwmon0/name": "zenpower\n",
      "class/hwmon/hwmon0/power1_input": "40000000\n",
      "class/hwmon/hwmon0/power1_label": "SVI2_P_Core\n",
      "class/hwmon/hwmon0/power2_input": "12500000\n",
      "class/hwmon/hwmon0/power2_label": "SVI2_P_SoC\n",
    });
    const p = new HostMetrics({ roots: r, sysfsRoot: zen, netFilter: { include: [], exclude: [] } }).sample(0).power;
    expect(p).toMatchObject({ packageWatts: 52.5, packageSource: "hwmon" });
    expect(new HostMetrics({ roots: r, sysfsRoot: empty, netFilter: { include: [], exclude: [] } }).sample(0).power).toBeNull();
  });

  it("unreadable RAPL energy (root-only) is skipped quietly", () => {
    if (process.getuid?.() === 0) return;
    const root = sys(1_000_000);
    chmodSync(join(root, "class/powercap/intel-rapl:0/energy_uj"), 0o000);
    chmodSync(join(root, "class/powercap/intel-rapl:0:0/energy_uj"), 0o000);
    const warnings: string[] = [];
    const empty = tree({});
    const hm = new HostMetrics({
      roots: { hostProc: empty, hostSys: empty, proc: empty, sys: empty, inContainer: false },
      sysfsRoot: root,
      netFilter: { include: [], exclude: [] },
      warn: (m) => warnings.push(m),
    });
    const p = hm.sample(0).power;
    expect(p?.packageSource).toBeNull();
    expect(p?.sources.map((s) => s.id)).toEqual(["amdgpu_power1"]);
    expect(warnings).toEqual([]);
  });
});

describe("HostMetrics end to end", () => {
  function hostTree(rx: number, user: number) {
    return tree({
      "proc/meminfo": MEMINFO(16_000_000, 4_000_000, 0, 0),
      "proc/loadavg": "1.50 1.00 0.50 2/300 1234\n",
      "proc/stat": STAT(user, 1000),
      ...under("sys", {
        ...nic("eno1", { device: "", speed: "2500\n" }, { rx_bytes: rx, tx_bytes: rx * 2 }),
        ...nic("vmbr0", { bridge: "" }),
        ...nic("bond0.100", { uevent: "DEVTYPE=vlan\n" }),
        ...nic("veth100i0"),
      }),
    });
  }

  it("memory, load, network with rates and scope", () => {
    const host = hostTree(1000, 100);
    const local = tree({ "proc/meminfo": MEMINFO(512_000, 400_000) });
    const hm = new HostMetrics({ roots: rootsFor(host, local), sysfsRoot: tree({}), netFilter: { include: [], exclude: [] } });
    const a = hm.sample(0);
    const mem = Memory.parse(a.memory);
    expect(mem).toEqual({
      scope: "host",
      totalBytes: 16_000_000 * 1024,
      availableBytes: 4_000_000 * 1024,
      usedBytes: 12_000_000 * 1024,
      usedPercent: 75,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      swapUsedPercent: null,
    });
    expect(Load.parse(a.load)).toEqual({ scope: "host", load1: 1.5, load5: 1, load15: 0.5, cpuCount: 4, cpuUsagePercent: null });
    const net = Network.parse(a.network);
    expect(net.scope).toBe("host");
    expect(net.interfaces.map((i) => i.id)).toEqual(["bond0_100", "eno1", "vmbr0"]);
    expect(net.interfaces[1]).toMatchObject({ name: "eno1", kind: "physical", up: true, speedMbps: 2500, rxBytes: 1000, rxBytesPerSec: null });

    writeFileSync(join(host, "sys/class/net/eno1/statistics/rx_bytes"), "11000\n");
    writeFileSync(join(host, "sys/class/net/eno1/statistics/tx_bytes"), "22000\n");
    writeFileSync(join(host, "proc/stat"), STAT(200, 1100));
    const b = hm.sample(10_000);
    expect(b.load?.cpuUsagePercent).toBe(50);
    const eno1 = b.network!.interfaces.find((i) => i.id === "eno1")!;
    expect(eno1.rxBytesPerSec).toBe(1000);
    expect(eno1.txBytesPerSec).toBe(2000);

    // counter reset (interface re-created): null for one sample, then normal again
    writeFileSync(join(host, "sys/class/net/eno1/statistics/rx_bytes"), "10\n");
    expect(hm.sample(20_000).network!.interfaces.find((i) => i.id === "eno1")!.rxBytesPerSec).toBeNull();
    writeFileSync(join(host, "sys/class/net/eno1/statistics/rx_bytes"), "1010\n");
    expect(hm.sample(30_000).network!.interfaces.find((i) => i.id === "eno1")!.rxBytesPerSec).toBe(100);
  });

  it("container view when the host mounts are missing", () => {
    const local = tree({
      "proc/meminfo": MEMINFO(512_000, 400_000),
      "proc/loadavg": "0.1 0.2 0.3 1/10 5\n",
      "sys/class/net/eth0/operstate": "up\n",
    });
    const hm = new HostMetrics({ roots: rootsFor(tree({}), local), sysfsRoot: tree({}), netFilter: { include: [], exclude: [] } });
    const s = hm.sample(0);
    expect(s.memory?.scope).toBe("container");
    expect(s.load).toMatchObject({ scope: "container", load1: 0.1, cpuCount: null, cpuUsagePercent: null });
    expect(s.network).toMatchObject({ scope: "container", interfaces: [{ id: "eth0", rxBytes: null }] });
  });

  it("a throwing section is isolated and logged once", () => {
    const warnings: string[] = [];
    const host = hostTree(1000, 100);
    const hm = new HostMetrics({
      roots: rootsFor(host, tree({})),
      sysfsRoot: tree({}),
      netFilter: { include: [], exclude: [] },
      warn: (m) => warnings.push(m),
    });
    const broken = hm as unknown as { network: () => never };
    broken.network = () => {
      throw new Error("boom");
    };
    const a = hm.sample(0);
    hm.sample(10_000);
    expect(a.network).toBeNull();
    expect(a.memory?.usedPercent).toBe(75);
    expect(warnings).toEqual(["host metrics: reading network failed: boom"]);
  });
});
