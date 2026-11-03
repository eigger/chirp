import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StatusSnapshot } from "../src/schema.js";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"));

describe("status fixtures", () => {
  it("full sample carries every host section", () => {
    const s = StatusSnapshot.parse(read("status.sample.json"));
    expect(s.memory?.scope).toBe("host");
    expect(s.load?.scope).toBe("host");
    expect(s.network?.interfaces.length).toBeGreaterThan(0);
    expect(s.power?.packageSource).toBe("rapl");
    expect(s.fans?.length).toBeGreaterThan(0);
    expect(s.voltages?.length).toBeGreaterThan(0);
  });

  it("container-scope variant (some values null)", () => {
    const s = StatusSnapshot.parse(read("status.container-scope.json"));
    expect(s.memory?.scope).toBe("container");
    expect(s.network?.scope).toBe("container");
    expect(s.load?.cpuUsagePercent).toBeNull();
    expect(s.power?.packageWatts).toBeNull();
  });

  it("null-sections variant", () => {
    const s = StatusSnapshot.parse(read("status.null-sections.json"));
    expect([s.memory, s.load, s.network, s.power]).toEqual([null, null, null, null]);
  });

  it("legacy (pre host metrics) payload still parses", () => {
    const raw = read("status.legacy.json") as Record<string, unknown>;
    for (const k of ["memory", "load", "network", "power", "fans", "voltages"]) expect(k in raw).toBe(false);
    const s = StatusSnapshot.parse(raw);
    expect(s.memory).toBeUndefined();
  });

  it("rejects a section that is present but malformed", () => {
    const raw = read("status.sample.json") as Record<string, unknown>;
    expect(StatusSnapshot.safeParse({ ...raw, memory: { scope: "vm" } }).success).toBe(false);
    expect(StatusSnapshot.safeParse({ ...raw, network: { scope: "host", interfaces: [{ id: "Bad.Id" }] } }).success).toBe(false);
  });
});
