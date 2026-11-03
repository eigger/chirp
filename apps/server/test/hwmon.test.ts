import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSensors } from "../src/hwmon.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fakeSys(chips: Record<string, Record<string, string>> | [string, Record<string, string>][]): string {
  const root = mkdtempSync(join(tmpdir(), "chirp-sys-"));
  roots.push(root);
  let i = 0;
  for (const [name, files] of Array.isArray(chips) ? chips : Object.entries(chips)) {
    const dir = join(root, "class", "hwmon", `hwmon${i++}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "name"), `${name}\n`);
    for (const [f, v] of Object.entries(files)) writeFileSync(join(dir, f), `${v}\n`);
  }
  return root;
}

describe("readSensors", () => {
  it("coretemp: package id 0, cores, limits; other chips go to sensors[]", () => {
    const root = fakeSys({
      coretemp: {
        temp1_label: "Package id 0",
        temp1_input: "47000",
        temp1_max: "80000",
        temp1_crit: "100000",
        temp2_label: "Core 0",
        temp2_input: "45000",
        temp3_label: "Core 1",
        temp3_input: "52500",
      },
      nvme: { temp1_label: "Composite", temp1_input: "41850" },
    });
    const { cpu, sensors } = readSensors(root);
    expect(cpu.source).toBe("coretemp");
    expect(cpu.packageTemp).toBe(47);
    expect(cpu.maxTemp).toBe(52.5);
    expect(cpu.highTemp).toBe(80);
    expect(cpu.critTemp).toBe(100);
    expect(cpu.cores).toEqual([
      { label: "Core 0", temp: 45 },
      { label: "Core 1", temp: 52.5 },
    ]);
    expect(sensors).toEqual([{ chip: "nvme", label: "Composite", temp: 41.9 }]);
  });

  it("coretemp without a package sensor falls back to the hottest core", () => {
    const root = fakeSys({
      coretemp: {
        temp2_label: "Core 0",
        temp2_input: "40000",
        temp3_label: "Core 1",
        temp3_input: "60000",
      },
    });
    expect(readSensors(root).cpu.packageTemp).toBe(60);
  });

  it("k10temp: prefers Tdie over Tctl, Tccd as cores", () => {
    const root = fakeSys({
      k10temp: {
        temp1_label: "Tctl",
        temp1_input: "62000",
        temp2_label: "Tdie",
        temp2_input: "52000",
        temp2_crit: "95000",
        temp3_label: "Tccd1",
        temp3_input: "50000",
      },
    });
    const { cpu } = readSensors(root);
    expect(cpu.source).toBe("k10temp");
    expect(cpu.packageTemp).toBe(52);
    expect(cpu.critTemp).toBe(95);
    expect(cpu.cores).toEqual([{ label: "Tccd1", temp: 50 }]);
  });

  it("k10temp with only Tctl uses Tctl", () => {
    const root = fakeSys({ k10temp: { temp1_label: "Tctl", temp1_input: "62000" } });
    expect(readSensors(root).cpu.packageTemp).toBe(62);
  });

  it("missing sysfs yields empty readout", () => {
    const { cpu, sensors } = readSensors("/nonexistent-chirp-sys");
    expect(cpu.packageTemp).toBeNull();
    expect(cpu.source).toBeNull();
    expect(sensors).toEqual([]);
  });

  it("multi-socket coretemp: hottest package, all cores prefixed by package, lowest limits", () => {
    const root = fakeSys([
      // hwmon order does not have to match socket order
      [
        "coretemp",
        {
          temp1_label: "Package id 1",
          temp1_input: "61000",
          temp1_max: "82000",
          temp1_crit: "102000",
          temp2_label: "Core 0",
          temp2_input: "64000",
        },
      ],
      [
        "coretemp",
        {
          temp1_label: "Package id 0",
          temp1_input: "55000",
          temp1_max: "80000",
          temp1_crit: "100000",
          temp2_label: "Core 0",
          temp2_input: "50000",
          temp3_label: "Core 1",
          temp3_input: "52000",
        },
      ],
      ["nvme", { temp1_label: "Composite", temp1_input: "40000" }],
    ]);
    const { cpu, sensors } = readSensors(root);
    expect(cpu.source).toBe("coretemp");
    expect(cpu.packageTemp).toBe(61);
    expect(cpu.maxTemp).toBe(64);
    expect(cpu.highTemp).toBe(80);
    expect(cpu.critTemp).toBe(100);
    expect(cpu.cores).toEqual([
      { label: "Package 0 Core 0", temp: 50 },
      { label: "Package 0 Core 1", temp: 52 },
      { label: "Package 1 Core 0", temp: 64 },
    ]);
    // neither coretemp chip leaks into the generic sensor list
    expect(sensors).toEqual([{ chip: "nvme", label: "Composite", temp: 40 }]);
  });
});
