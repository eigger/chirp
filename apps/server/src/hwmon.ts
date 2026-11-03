import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Cpu } from "@chirp/shared";

export interface SensorEntry {
  chip: string;
  label: string;
  temp: number | null;
  max: number | null;
  crit: number | null;
}

export interface HwmonChip {
  name: string;
  entries: SensorEntry[];
}

export interface SensorReadout {
  cpu: Omit<Cpu, "model" | "updatedAt">;
  sensors: { chip: string; label: string; temp: number | null }[];
}

type CpuSource = NonNullable<Cpu["source"]>;
const CPU_CHIPS: CpuSource[] = ["coretemp", "k10temp", "zenpower", "cpu_thermal"];

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function readMilli(path: string): number | null {
  const text = readText(path);
  if (text === null || text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) / 1000 : null;
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export function readHwmonChips(sysfsRoot: string): HwmonChip[] {
  const base = join(sysfsRoot, "class", "hwmon");
  const chips: HwmonChip[] = [];
  for (const dir of listDir(base).sort()) {
    const path = join(base, dir);
    const name = readText(join(path, "name"));
    if (!name) continue;
    const entries: SensorEntry[] = [];
    for (const file of listDir(path).sort()) {
      const m = /^temp(\d+)_input$/.exec(file);
      if (!m) continue;
      const idx = m[1];
      entries.push({
        chip: name,
        label: readText(join(path, `temp${idx}_label`)) || `temp${idx}`,
        temp: readMilli(join(path, file)),
        max: readMilli(join(path, `temp${idx}_max`)),
        crit: readMilli(join(path, `temp${idx}_crit`)),
      });
    }
    chips.push({ name, entries });
  }
  return chips;
}

function maxOf(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? Math.max(...nums) : null;
}

function round1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

const emptyCpu = (): SensorReadout["cpu"] => ({
  packageTemp: null,
  maxTemp: null,
  highTemp: null,
  critTemp: null,
  cores: [],
  source: null,
});

function readThermalZone(sysfsRoot: string): SensorReadout["cpu"] | null {
  const base = join(sysfsRoot, "class", "thermal");
  for (const dir of listDir(base).sort()) {
    if (!dir.startsWith("thermal_zone")) continue;
    const type = readText(join(base, dir, "type"));
    if (type !== "x86_pkg_temp" && type !== "cpu-thermal" && type !== "cpu_thermal") continue;
    const temp = readMilli(join(base, dir, "temp"));
    if (temp === null) continue;
    return { ...emptyCpu(), packageTemp: round1(temp), maxTemp: round1(temp), source: "thermal_zone" };
  }
  return null;
}

/** Parse /sys/class/hwmon (and thermal_zone as a fallback) into CPU + other sensors. */
export function readSensors(sysfsRoot: string): SensorReadout {
  const chips = readHwmonChips(sysfsRoot);
  const cpuChip = CPU_CHIPS.map((n) => chips.find((c) => c.name === n)).find(Boolean) ?? null;

  const sensors: SensorReadout["sensors"] = [];
  for (const chip of chips) {
    if (chip === cpuChip) continue;
    for (const e of chip.entries) sensors.push({ chip: chip.name, label: e.label, temp: round1(e.temp) });
  }

  if (!cpuChip) {
    return { cpu: readThermalZone(sysfsRoot) ?? emptyCpu(), sensors };
  }

  const entries = cpuChip.entries;
  const find = (re: RegExp) => entries.find((e) => re.test(e.label) && e.temp !== null);
  const pkgEntry = find(/^Package id 0$/i) ?? find(/^Tdie$/i) ?? find(/^Tctl$/i) ?? find(/^Package/i);

  const cores = entries
    .filter((e) => e !== pkgEntry && !/^(Package|Tctl|Tdie)/i.test(e.label))
    .map((e) => ({ label: e.label, temp: round1(e.temp) }));

  const coreMax = maxOf(cores.map((c) => c.temp));
  const packageTemp = pkgEntry?.temp ?? coreMax;
  const withLimits = pkgEntry ?? entries.find((e) => e.max !== null || e.crit !== null) ?? null;

  return {
    cpu: {
      packageTemp: round1(packageTemp),
      maxTemp: round1(maxOf([coreMax, pkgEntry?.temp ?? null])),
      highTemp: round1(withLimits?.max ?? null),
      critTemp: round1(withLimits?.crit ?? null),
      cores,
      source: cpuChip.name as CpuSource,
    },
    sensors,
  };
}

export function readCpuModel(procRoot = "/proc"): string | null {
  const text = readText(join(procRoot, "cpuinfo"));
  if (!text) return null;
  const m = /^model name\s*:\s*(.+)$/im.exec(text) ?? /^(?:Model|Hardware)\s*:\s*(.+)$/im.exec(text);
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
}
