import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, MIN_API_KEY_LENGTH } from "../src/config.js";
import { healthUrl } from "../src/healthcheck.js";
import { newKeyLogMessage } from "../src/keyNotice.js";
import { classifyExecError, discoverDevices, parseScan, readDisk, resetDetectedDeviceTypes, SmartctlError } from "../src/smartctl.js";

describe("CHIRP_PORT / CHIRP_API_KEY / CHIRP_SCAN_MODE validation", () => {
  it("accepts integer ports 1-65535 and defaults to 80", () => {
    expect(loadConfig({}).port).toBe(80);
    expect(loadConfig({ CHIRP_PORT: " 8080 " }).port).toBe(8080);
    expect(loadConfig({ CHIRP_PORT: "65535" }).port).toBe(65535);
  });

  it.each(["0", "65536", "8080.5", "abc", "-1", "1e3", "80 81"])("rejects CHIRP_PORT=%s with a clear message", (v) => {
    expect(() => loadConfig({ CHIRP_PORT: v })).toThrowError(ConfigError);
    expect(() => loadConfig({ CHIRP_PORT: v })).toThrowError(/CHIRP_PORT must be an integer between 1 and 65535/);
  });

  it("rejects a CHIRP_API_KEY shorter than the minimum or containing whitespace", () => {
    expect(() => loadConfig({ CHIRP_API_KEY: "short" })).toThrowError(/CHIRP_API_KEY is too short \(5 characters, minimum 16\)/);
    expect(() => loadConfig({ CHIRP_API_KEY: "a".repeat(MIN_API_KEY_LENGTH - 1) })).toThrowError(ConfigError);
    expect(() => loadConfig({ CHIRP_API_KEY: "chp_abc def ghijklmnopq" })).toThrowError(/whitespace/);
    expect(loadConfig({ CHIRP_API_KEY: "a".repeat(MIN_API_KEY_LENGTH) }).apiKey).toBe("a".repeat(MIN_API_KEY_LENGTH));
    expect(loadConfig({ CHIRP_API_KEY: "  " }).apiKey).toBeNull();
  });

  it("scan mode defaults to the non-opening --scan; rescan interval has a floor", () => {
    expect(loadConfig({}).scanMode).toBe("scan");
    expect(loadConfig({ CHIRP_SCAN_MODE: "scan-open" }).scanMode).toBe("scan-open");
    expect(() => loadConfig({ CHIRP_SCAN_MODE: "open" })).toThrowError(/CHIRP_SCAN_MODE/);
    expect(loadConfig({}).rescanIntervalSec).toBe(3600);
    expect(loadConfig({ CHIRP_RESCAN_INTERVAL: "5" }).rescanIntervalSec).toBe(3600);
    expect(loadConfig({ CHIRP_RESCAN_INTERVAL: "600" }).rescanIntervalSec).toBe(600);
  });
});

describe("new API key log line", () => {
  const key = "chp_" + "x".repeat(43);
  it("names the key file, the dashboard and the CLI but not the key", () => {
    const msg = newKeyLogMessage({ apiKeyFile: "/var/lib/chirp/api-key", printKey: false }, key);
    expect(msg).not.toContain(key);
    expect(msg).toContain("/var/lib/chirp/api-key");
    expect(msg).toContain("Settings -> API key");
    expect(msg).toMatch(/cli\.js key show/);
    expect(msg).toContain("CHIRP_PRINT_KEY=true");
  });
  it("prints the key only with CHIRP_PRINT_KEY=true", () => {
    expect(loadConfig({ CHIRP_PRINT_KEY: "true" }).printKey).toBe(true);
    expect(newKeyLogMessage({ apiKeyFile: "/k", printKey: true }, key)).toContain(key);
  });
});

describe("CHIRP_ADMIN_* / CHIRP_COOKIE_SECURE", () => {
  it("seeds only when both are set and valid", () => {
    expect(loadConfig({}).adminUser).toBeNull();
    const c = loadConfig({ CHIRP_ADMIN_USER: " admin ", CHIRP_ADMIN_PASSWORD: " long enough pw " });
    expect(c.adminUser).toBe("admin");
    expect(c.adminPassword).toBe(" long enough pw ");
    expect(() => loadConfig({ CHIRP_ADMIN_USER: "admin" })).toThrowError(/set together/);
    expect(() => loadConfig({ CHIRP_ADMIN_PASSWORD: "0123456789" })).toThrowError(/set together/);
    expect(() => loadConfig({ CHIRP_ADMIN_USER: "admin", CHIRP_ADMIN_PASSWORD: "short" })).toThrowError(/10-256 characters/);
    expect(() => loadConfig({ CHIRP_ADMIN_USER: "bad user", CHIRP_ADMIN_PASSWORD: "0123456789" })).toThrowError(ConfigError);
  });
  it("CHIRP_TRUST_PROXY: false, true, a hop count or a proxy list", () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ CHIRP_TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ CHIRP_TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ CHIRP_TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ CHIRP_TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ CHIRP_TRUST_PROXY: "10.0.0.1, 192.168.0.0/16, fd00::/8" }).trustProxy).toEqual([
      "10.0.0.1",
      "192.168.0.0/16",
      "fd00::/8",
    ]);
    for (const bad of ["maybe", "11", "proxy.local", "10.0.0.1,nope", "::::", "10.0.0.0/99", "999.1.1.1", "fd00::/129", "10.0.0.1/", "1.2.3"]) {
      expect(() => loadConfig({ CHIRP_TRUST_PROXY: bad }), bad).toThrowError(ConfigError);
      expect(() => loadConfig({ CHIRP_TRUST_PROXY: bad }), bad).toThrowError(/CHIRP_TRUST_PROXY/);
    }
    expect(loadConfig({ CHIRP_TRUST_PROXY: "0.0.0.0/0,::/0,10.0.0.0/32,fd00::/128" }).trustProxy).toHaveLength(4);
  });
  it("a valid proxy list never crashes buildApp later", async () => {
    const { buildApp } = await import("../src/app.js");
    const { createAuth } = await import("../src/auth.js");
    const { ApiKeyStore } = await import("../src/apiKey.js");
    const { Collector } = await import("../src/scheduler.js");
    const config = { ...loadConfig({ CHIRP_TRUST_PROXY: "10.0.0.0/8, fd00::/8, 192.168.1.1" }), webDir: "/nonexistent" };
    const collector = new Collector(
      { readSensors: () => ({ cpu: { packageTemp: null, maxTemp: null, highTemp: null, critTemp: null, cores: [], source: null }, sensors: [] }), readCpuModel: () => null, discoverDevices: async () => [], readDisk: async () => { throw new Error("x"); }, now: () => new Date() },
      { instanceId: "x", version: "0", displayName: "x", sensorIntervalSec: 10, smartIntervalSec: 300 },
    );
    const app = await buildApp({ config, collector, auth: createAuth({ dataDir: "/nonexistent-chirp" }, new ApiKeyStore("chp_x".padEnd(30, "x"), null)) });
    expect((await app.inject("/health")).statusCode).toBe(200);
    await app.close();
  });
  it("CHIRP_LOGIN_DAILY_BUDGET: default 1000, 10..1000000", () => {
    expect(loadConfig({}).loginDailyBudget).toBe(1000);
    expect(loadConfig({ CHIRP_LOGIN_DAILY_BUDGET: "50" }).loginDailyBudget).toBe(50);
    for (const bad of ["5", "abc", "1.5", "-1", "2000000"]) {
      expect(() => loadConfig({ CHIRP_LOGIN_DAILY_BUDGET: bad }), bad).toThrowError(/CHIRP_LOGIN_DAILY_BUDGET/);
    }
  });
  it("CHIRP_ADMIN_PASSWORD must not be a common password", () => {
    expect(() => loadConfig({ CHIRP_ADMIN_USER: "admin", CHIRP_ADMIN_PASSWORD: "password123" })).toThrowError(/too common/);
    expect(() => loadConfig({ CHIRP_ADMIN_USER: "admin", CHIRP_ADMIN_PASSWORD: "admin2026!!" })).toThrowError(/too common/);
  });
  it("cookie Secure flag: auto by default, explicit true/false", () => {
    expect(loadConfig({}).cookieSecure).toBe("auto");
    expect(loadConfig({ CHIRP_COOKIE_SECURE: "true" }).cookieSecure).toBe(true);
    expect(loadConfig({ CHIRP_COOKIE_SECURE: "off" }).cookieSecure).toBe(false);
    expect(() => loadConfig({ CHIRP_COOKIE_SECURE: "maybe" })).toThrowError(/CHIRP_COOKIE_SECURE/);
  });
  it("CHIRP_SETUP_TOKEN is loaded and trimmed", () => {
    expect(loadConfig({}).setupToken).toBeNull();
    expect(loadConfig({ CHIRP_SETUP_TOKEN: "  secret-token  " }).setupToken).toBe("secret-token");
    expect(loadConfig({ CHIRP_SETUP_TOKEN: "" }).setupToken).toBeNull();
  });
  it("CHIRP_TLS_CERT and CHIRP_TLS_KEY must be set together", () => {
    expect(loadConfig({}).tlsCert).toBeNull();
    expect(loadConfig({}).tlsKey).toBeNull();
    expect(() => loadConfig({ CHIRP_TLS_CERT: "/path/cert.pem" })).toThrowError(/CHIRP_TLS_CERT and CHIRP_TLS_KEY must be set together/);
    expect(() => loadConfig({ CHIRP_TLS_KEY: "/path/key.pem" })).toThrowError(/CHIRP_TLS_CERT and CHIRP_TLS_KEY must be set together/);
    const tls = loadConfig({ CHIRP_TLS_CERT: "/path/cert.pem", CHIRP_TLS_KEY: "/path/key.pem" });
    expect(tls.tlsCert).toBe("/path/cert.pem");
    expect(tls.tlsKey).toBe("/path/key.pem");
    expect(tls.cookieSecure).toBe(true); // derived from TLS
    const overridden = loadConfig({
      CHIRP_TLS_CERT: "/path/cert.pem",
      CHIRP_TLS_KEY: "/path/key.pem",
      CHIRP_COOKIE_SECURE: "off",
    });
    expect(overridden.cookieSecure).toBe(false);
  });
});

describe("health probe URL follows CHIRP_HOST and TLS", () => {
  it.each([
    ["0.0.0.0", "http://127.0.0.1:80/health"],
    ["::", "http://127.0.0.1:80/health"],
    ["192.168.1.5", "http://192.168.1.5:80/health"],
    ["fd00::5", "http://[fd00::5]:80/health"],
    ["[fd00::5]", "http://[fd00::5]:80/health"],
    ["localhost", "http://localhost:80/health"],
  ])("%s -> %s", (host, url) => {
    expect(healthUrl({ host, port: 80 })).toBe(url);
  });
  it("uses https when TLS cert and key are configured", () => {
    expect(healthUrl({ host: "0.0.0.0", port: 443, tlsCert: "/c.pem", tlsKey: "/k.pem" })).toBe(
      "https://127.0.0.1:443/health",
    );
  });
});

describe("smartctl process errors", () => {
  it("a maxBuffer kill is an overflow, not a timeout", () => {
    const overflow = Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
    expect(classifyExecError(overflow)).toEqual({ overflow: true, timedOut: false, spawnFailed: false });
    const timeout = Object.assign(new Error("t"), { killed: true, signal: "SIGTERM" });
    expect(classifyExecError(timeout)).toEqual({ overflow: false, timedOut: true, spawnFailed: false });
    expect(classifyExecError(Object.assign(new Error("x"), { code: "ENOENT" })).spawnFailed).toBe(true);
    expect(classifyExecError(null)).toEqual({ overflow: false, timedOut: false, spawnFailed: false });
  });

  it("--scan drops the generic scsi type so smartctl auto-detects SAT per read", () => {
    const out = JSON.stringify({ devices: [{ name: "/dev/sda", type: "scsi" }, { name: "/dev/nvme0", type: "nvme" }] });
    expect(parseScan(out, {}, "scan")).toEqual([
      { path: "/dev/sda", type: undefined },
      { path: "/dev/nvme0", type: "nvme" },
    ]);
    expect(parseScan(out, { "/dev/sda": "sat" }, "scan")[0].type).toBe("sat");
    expect(parseScan(out, {}, "scan-open")[0].type).toBe("scsi");
    expect(parseScan("not json", {}, "scan")).toEqual([]);
  });
});

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
        `case "$1" in --scan|--scan-open) echo '{"devices":[{"name":"/dev/sda","type":"sat"},{"name":"-s","type":"x"},{"name":"/dev/sdb","type":"-t"}]}';;\n` +
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

  it("discovery uses the non-opening --scan by default and ignores option-like names/types", async () => {
    expect(await discoverDevices(cfg())).toEqual([
      { path: "/dev/sda", type: "sat" },
      { path: "/dev/sdb", type: undefined },
    ]);
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["--scan", "-j"]);
  });

  it("--scan-open only when configured", async () => {
    await discoverDevices({ ...cfg(), scanMode: "scan-open" });
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["--scan-open", "-j"]);
  });

  describe("device type fallback (LXC bind-mounted by-id nodes)", () => {
    const sataOk = readFileSync(new URL("./fixtures/sata-ssd-ok.json", import.meta.url), "utf8");
    const cannotDetect =
      '{"smartctl":{"exit_status":1,"messages":[{"string":"/dev/disk/by-id/ata-X: Unable to detect device type","severity":"error"}]}}';
    const countFile = () => join(dir, "calls");

    // Fails to detect the type unless `-d sat` is passed; records every invocation.
    const writeNeedsSat = () => {
      writeFileSync(join(dir, "ok.json"), sataOk);
      writeFileSync(join(dir, "fail.json"), cannotDetect);
      writeFileSync(
        bin,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${countFile()}"\n` +
          `case " $* " in *" -d sat "*) cat "${join(dir, "ok.json")}";; *) cat "${join(dir, "fail.json")}"; exit 1;; esac\n`,
      );
    };

    beforeEach(() => resetDetectedDeviceTypes());

    it("retries with -d sat when the type cannot be detected, then remembers it", async () => {
      writeNeedsSat();
      const dev = "/dev/disk/by-id/ata-X";
      const r = await readDisk(cfg(), dev);
      expect(r.disk.model).toBeTruthy();
      let calls = readFileSync(countFile(), "utf8").trim().split("\n");
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toContain("-d");
      expect(calls[1]).toContain("-d sat");

      await readDisk(cfg(), dev);
      calls = readFileSync(countFile(), "utf8").trim().split("\n");
      expect(calls).toHaveLength(3); // learned type: a single run, no fallback
      expect(calls[2]).toContain("-d sat");
    });

    it("does not retry when a type is configured explicitly", async () => {
      writeNeedsSat();
      const err = await readDisk({ ...cfg(), deviceTypes: { "/dev/disk/by-id/ata-X": "scsi" } }, "/dev/disk/by-id/ata-X").catch((e) => e);
      expect(err).toBeInstanceOf(SmartctlError);
      expect(readFileSync(countFile(), "utf8").trim().split("\n")).toHaveLength(1);
    });

    it("does not retry an ordinary open failure", async () => {
      writeFileSync(
        bin,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${countFile()}"\n` +
          `echo '{"smartctl":{"exit_status":2,"messages":[{"string":"Smartctl open device: /dev/sdz failed: No such device"}]}}'; exit 2\n`,
      );
      const err = await readDisk(cfg(), "/dev/sdz").catch((e) => e);
      expect(err).toBeInstanceOf(SmartctlError);
      expect(err.code).toBe("open_failed");
      expect(readFileSync(countFile(), "utf8").trim().split("\n")).toHaveLength(1);
    });

    it("reports open_failed when every fallback type fails too", async () => {
      writeFileSync(join(dir, "fail.json"), cannotDetect);
      writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${countFile()}"\ncat "${join(dir, "fail.json")}"; exit 1\n`);
      const err = await readDisk(cfg(), "/dev/disk/by-id/ata-X").catch((e) => e);
      expect(err.code).toBe("open_failed");
      expect(readFileSync(countFile(), "utf8").trim().split("\n")).toHaveLength(3); // none, sat, scsi
    });
  });

  it("output larger than maxBuffer is a parse_error, not a timeout", async () => {
    writeFileSync(bin, `#!/bin/sh\nhead -c 4096 /dev/zero | tr '\\0' 'x'\n`);
    const err = await readDisk(cfg(), "/dev/sda", undefined, 20_000, 1024).catch((e) => e);
    expect(err).toBeInstanceOf(SmartctlError);
    expect(err.code).toBe("parse_error");
    expect(err.detail).toMatch(/exceeded 1024 bytes/);
  });
});
