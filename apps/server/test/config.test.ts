import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { discoverDevices, readDisk, SmartctlError } from "../src/smartctl.js";

describe("CHIRP_DEVICES / CHIRP_DEVICE_TYPES validation", () => {
  it("keeps absolute device paths and well-formed -d types", () => {
    const c = loadConfig({
      CHIRP_DEVICES: "/dev/sda, /dev/disk/by-id/wwn-0x5000c500a1b2c3d4,/dev/nvme0",
      CHIRP_DEVICE_TYPES: "/dev/sda=sat,/dev/sdb=sat+megaraid,1,/dev/sdc=areca,1/2",
    });
    expect(c.devices).toEqual(["/dev/sda", "/dev/disk/by-id/wwn-0x5000c500a1b2c3d4", "/dev/nvme0"]);
    // types that themselves contain commas (HBA / RAID pass-through) must survive the list split
    expect(c.deviceTypes).toEqual({ "/dev/sda": "sat", "/dev/sdb": "sat+megaraid,1", "/dev/sdc": "areca,1/2" });
    expect(c.rejected).toEqual([]);
  });

  it("drops entries smartctl could parse as options", () => {
    const c = loadConfig({
      CHIRP_DEVICES: "-s on,--set=standby\\,now,/dev/sda,sda,/dev/sd a",
      CHIRP_DEVICE_TYPES: "/dev/sda=-t long,--x=sat,/dev/sdb=sat",
    });
    expect(c.devices).toEqual(["/dev/sda"]);
    expect(c.deviceTypes).toEqual({ "/dev/sdb": "sat" });
    expect(c.rejected).toContain("-s on");
    expect(c.rejected).toContain("sda");
    expect(c.rejected).toContain("/dev/sda=-t long,--x=sat");
  });
});

describe("smartctl argv", () => {
  let dir: string;
  let bin: string;
  let argsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chirp-smartctl-"));
    bin = join(dir, "smartctl");
    argsFile = join(dir, "args");
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n` +
        `case "$1" in --scan-open) echo '{"devices":[{"name":"/dev/sda","type":"sat"},{"name":"-s","type":"x"},{"name":"/dev/sdb","type":"-t"}]}';;\n` +
        `*) echo '{"smartctl":{"exit_status":2,"messages":[{"string":"Device is in STANDBY mode, exit(2)"}]},"device":{"name":"/dev/sda"}}';; esac\n`,
    );
    chmodSync(bin, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cfg = () => ({ smartctl: bin, tempWarn: { hdd: 55, ssd: 70, nvme: 75 }, deviceTypes: {}, devices: [] as string[] });

  it("always passes -n standby and the -d type as separate argv entries", async () => {
    const r = await readDisk(cfg(), "/dev/sda", "sat");
    expect(r.disk.standby).toBe(true);
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["-j", "-a", "-n", "standby", "-d", "sat", "/dev/sda"]);
  });

  it("refuses an option-like device or type without running smartctl", async () => {
    await expect(readDisk(cfg(), "-s", undefined)).rejects.toBeInstanceOf(SmartctlError);
    await expect(readDisk(cfg(), "/dev/sda", "-t")).rejects.toBeInstanceOf(SmartctlError);
    expect(() => readFileSync(argsFile)).toThrow();
  });

  it("discovery ignores option-like names/types from --scan-open", async () => {
    expect(await discoverDevices(cfg())).toEqual([
      { path: "/dev/sda", type: "sat" },
      { path: "/dev/sdb", type: undefined },
    ]);
  });
});
