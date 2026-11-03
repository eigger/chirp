import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostMetrics } from "../src/hostMetrics.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

let root: string | undefined;
afterEach(() => {
  vi.mocked(realpathSync).mockReset();
  if (root) rmSync(root, { recursive: true, force: true });
});

it("keeps healthy sensors when another chip disappears after reading its name", async () => {
  root = mkdtempSync(join(tmpdir(), "chirp-power-race-"));
  for (const i of [0, 1]) {
    const chip = join(root, "class/hwmon", `hwmon${i}`);
    mkdirSync(chip, { recursive: true });
    for (const [file, value] of Object.entries({ name: "amdgpu", fan1_input: "1500", in0_input: "800", power1_average: "25000000" })) {
      writeFileSync(join(chip, file), value);
    }
  }
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const missing = join(root, "class/hwmon/hwmon0");
  vi.mocked(realpathSync).mockImplementation((...args) => {
    if (String(args[0]) === missing || String(args[0]) === join(missing, "device")) {
      throw Object.assign(new Error("device disappeared"), { code: "ENOENT" });
    }
    return Reflect.apply(actual.realpathSync, undefined, args);
  });
  const warnings: string[] = [];
  const hm = new HostMetrics({
    roots: { hostProc: root, hostSys: root, proc: root, sys: root, inContainer: false },
    sysfsRoot: root,
    netFilter: { include: [], exclude: [] },
    warn: (msg) => warnings.push(msg),
  });
  const sample = hm.sample(0);
  expect(sample.fans).toHaveLength(1);
  expect(sample.fans[0].rpm).toBe(1500);
  expect(sample.voltages).toHaveLength(1);
  expect(sample.voltages[0].volts).toBe(0.8);
  expect(sample.power?.sources).toHaveLength(1);
  expect(sample.power?.sources[0].watts).toBe(25);
  expect(warnings).toEqual([]);
});
