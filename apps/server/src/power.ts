import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { readText } from "./hostPaths.js";

/** One RAPL powercap zone (`/sys/class/powercap/intel-rapl:N[:M]`; AMD Zen uses the same driver). */
export interface RaplZone {
  /** Directory name, e.g. `intel-rapl:0:1`. */
  zone: string;
  /** Display label: `package-0`, `package-0 dram`, `psys`. */
  label: string;
  /** A top-level `package-N` zone (summed into packageWatts). */
  isPackage: boolean;
  energyUj: number | null;
  maxEnergyRangeUj: number | null;
}

export interface HwmonPower {
  chip: string;
  label: string;
  watts: number | null;
}

export interface HwmonFan {
  chip: string;
  label: string;
  rpm: number | null;
}

export interface HwmonVoltage {
  chip: string;
  label: string;
  volts: number | null;
}

export interface HwmonExtras {
  power: HwmonPower[];
  fans: HwmonFan[];
  voltages: HwmonVoltage[];
}

/** hwmon chips whose power readings describe the CPU package (fallback when RAPL is missing). */
export const CPU_POWER_CHIPS = ["zenpower", "fam15h_power", "k10temp", "coretemp"];

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function readNum(path: string): number | null {
  const text = readText(path)?.trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** RAPL zones; zones whose energy counter is unreadable (root-only since Linux 5.10) report energyUj null. */
export function readRaplZones(sysRoot: string): RaplZone[] {
  const base = join(sysRoot, "class", "powercap");
  const zones: RaplZone[] = [];
  const names = new Map<string, string>();
  const dirs = listDir(base)
    .filter((d) => /^intel-rapl:\d+(:\d+)?$/.test(d))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const dir of dirs) names.set(dir, readText(join(base, dir, "name"))?.trim() || dir);
  for (const dir of dirs) {
    const name = names.get(dir) ?? dir;
    const parent = /^(intel-rapl:\d+):\d+$/.exec(dir)?.[1];
    zones.push({
      zone: dir,
      label: parent ? `${names.get(parent) ?? parent} ${name}` : name,
      isPackage: !parent && /^package/.test(name),
      energyUj: readNum(join(base, dir, "energy_uj")),
      maxEnergyRangeUj: readNum(join(base, dir, "max_energy_range_uj")),
    });
  }
  return zones;
}

/** Average power between two energy samples (W, one decimal); handles one counter wrap at max_energy_range_uj. */
export function energyWatts(
  prevUj: number | null | undefined,
  curUj: number | null,
  maxRangeUj: number | null,
  dtSec: number,
): number | null {
  if (prevUj === null || prevUj === undefined || curUj === null || !(dtSec > 0)) return null;
  let delta = curUj - prevUj;
  if (delta < 0) {
    if (maxRangeUj === null || maxRangeUj <= 0) return null;
    delta += maxRangeUj;
    if (delta < 0) return null;
  }
  return Math.round((delta / 1e6 / dtSec) * 10) / 10;
}

interface ChipDir {
  path: string;
  name: string;
  /** Sort key that survives hwmonN renumbering: the device link target. */
  key: string;
}

function hwmonChips(sysRoot: string): ChipDir[] {
  const base = join(sysRoot, "class", "hwmon");
  const chips: ChipDir[] = [];
  for (const dir of listDir(base)) {
    const path = join(base, dir);
    const name = readText(join(path, "name"))?.trim();
    if (!name) continue;
    let key = dir;
    try {
      key = readlinkSync(join(path, "device"));
    } catch {
      /* no device link (virtual chip): keep the directory name */
    }
    chips.push({ path, name, key });
  }
  return chips.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key) || a.path.localeCompare(b.path));
}

function indexed(files: string[], re: RegExp): number[] {
  const out = new Set<number>();
  for (const f of files) {
    const m = re.exec(f);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** hwmon power (µW -> W), fans (RPM) and voltages (mV -> V), chips in a stable order. */
export function readHwmonExtras(sysRoot: string): HwmonExtras {
  const out: HwmonExtras = { power: [], fans: [], voltages: [] };
  for (const chip of hwmonChips(sysRoot)) {
    const files = listDir(chip.path);
    const label = (prefix: string, i: number) => readText(join(chip.path, `${prefix}${i}_label`))?.trim() || `${prefix}${i}`;

    for (const i of indexed(files, /^power(\d+)_(?:input|average)$/)) {
      const uw = readNum(join(chip.path, `power${i}_input`)) ?? readNum(join(chip.path, `power${i}_average`));
      out.power.push({ chip: chip.name, label: label("power", i), watts: uw === null ? null : round(uw / 1e6, 1) });
    }
    for (const i of indexed(files, /^fan(\d+)_input$/)) {
      const rpm = readNum(join(chip.path, `fan${i}_input`));
      out.fans.push({ chip: chip.name, label: label("fan", i), rpm: rpm === null ? null : Math.round(rpm) });
    }
    for (const i of indexed(files, /^in(\d+)_input$/)) {
      const mv = readNum(join(chip.path, `in${i}_input`));
      out.voltages.push({ chip: chip.name, label: label("in", i), volts: mv === null ? null : round(mv / 1000, 3) });
    }
  }
  return out;
}
