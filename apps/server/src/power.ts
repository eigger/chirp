import { createHash } from "node:crypto";
import { readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { readText } from "./hostPaths.js";
import { slug } from "./diskIdentity.js";

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
  id: string;
  chip: string;
  label: string;
  watts: number | null;
}

export interface HwmonFan {
  id: string;
  chip: string;
  label: string;
  rpm: number | null;
}

export interface HwmonVoltage {
  id: string;
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
  /**
   * A GPU-class device (GPU_DRIVERS) that is runtime-suspended (an idle discrete GPU). Its
   * sensor inputs are not read (that could wake it); entries are listed with
   * null values so IDs stay stable.
   */
  suspended: boolean;
}

/**
 * GPU drivers whose sensor reads can wake a runtime-suspended card. Only these
 * are skipped while suspended: with PCI runtime PM on `auto` (powertop
 * --auto-tune) CPU-side devices may report "suspended" too, and their power and
 * temperature chips must keep reporting.
 */
export const GPU_DRIVERS = ["amdgpu", "radeon", "nouveau", "nvidia", "i915", "xe"];
const NEVER_SKIP = new Set([...CPU_POWER_CHIPS, "zenpower", "cpu_thermal"]);

function isGpu(path: string, name: string): boolean {
  if (NEVER_SKIP.has(name)) return false;
  if (GPU_DRIVERS.includes(name)) return true;
  try {
    return GPU_DRIVERS.includes(basename(readlinkSync(join(path, "device", "driver"))));
  } catch {
    return false;
  }
}

export function hwmonChips(sysRoot: string): ChipDir[] {
  const base = join(sysRoot, "class", "hwmon");
  const chips: ChipDir[] = [];
  let rootPath: string;
  try {
    rootPath = realpathSync(sysRoot);
  } catch {
    return chips;
  }
  for (const dir of listDir(base)) {
    const path = join(base, dir);
    const name = readText(join(path, "name"))?.trim();
    if (!name) continue;
    let devicePath: string;
    try {
      devicePath = realpathSync(join(path, "device"));
    } catch {
      try {
        devicePath = realpathSync(path);
      } catch {
        // Hot-unplug or driver reset after reading name: only skip this chip.
        continue;
      }
    }
    // The device path survives hwmonN renumbering. Keep it relative to the
    // mounted sysfs root so /sys and /host/sys produce identical identities.
    const relativePath = relative(rootPath, devicePath).replace(/\\/g, "/");
    const key = relativePath.startsWith("devices/") ? relativePath.replace(/(?:\/hwmon)?\/hwmon\d+$/, "") : relativePath;
    const suspended = isGpu(path, name) && readText(join(path, "device", "power", "runtime_status"))?.trim() === "suspended";
    chips.push({ path, name, key, suspended });
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
    const value = (file: string) => (chip.suspended ? null : readNum(join(chip.path, file)));
    const label = (prefix: string, i: number) => readText(join(chip.path, `${prefix}${i}_label`))?.trim() || `${prefix}${i}`;
    const id = (prefix: string, i: number, display: string) =>
      `${slug(`${chip.name}_${display}`) || prefix}_${createHash("sha256").update(`${chip.key}/${prefix}${i}`).digest("hex").slice(0, 16)}`;

    for (const i of indexed(files, /^power(\d+)_(?:input|average)$/)) {
      const uw = value(`power${i}_input`) ?? value(`power${i}_average`);
      const display = label("power", i);
      out.power.push({ id: id("power", i, display), chip: chip.name, label: display, watts: uw === null ? null : round(uw / 1e6, 1) });
    }
    for (const i of indexed(files, /^fan(\d+)_input$/)) {
      const rpm = value(`fan${i}_input`);
      const display = label("fan", i);
      out.fans.push({ id: id("fan", i, display), chip: chip.name, label: display, rpm: rpm === null ? null : Math.round(rpm) });
    }
    for (const i of indexed(files, /^in(\d+)_input$/)) {
      const mv = value(`in${i}_input`);
      const display = label("in", i);
      out.voltages.push({ id: id("in", i, display), chip: chip.name, label: display, volts: mv === null ? null : round(mv / 1000, 3) });
    }
  }
  return out;
}
