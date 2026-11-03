import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskIdentity, idFromAtaWwid, idFromByIdNames, provisionalId } from "../src/diskIdentity.js";
import { diskId } from "../src/smartctl.js";
import { fixture } from "./helpers.js";

let root: string;
let dev: string;
let byId: string;
let sys: string;
let cacheFile: string;
/** fake device node -> major:minor */
const numbers = new Map<string, { type: "block" | "char"; major: number; minor: number }>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chirp-id-"));
  dev = join(root, "dev");
  byId = join(dev, "disk", "by-id");
  sys = join(root, "sys");
  cacheFile = join(root, "data", "disk-ids.json");
  mkdirSync(byId, { recursive: true });
  numbers.clear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function node(name: string, type: "block" | "char", major: number, minor: number): string {
  const p = join(dev, name);
  writeFileSync(p, "");
  numbers.set(realpathSync(p), { type, major, minor });
  return p;
}

function link(name: string, target: string): string {
  const p = join(byId, name);
  symlinkSync(target, p);
  return p;
}

/** /sys/dev/<type>/M:m -> /sys/devices/<dir>, with the given attribute files. */
function sysDev(type: "block" | "char", major: number, minor: number, dir: string, files: Record<string, string>) {
  const real = join(sys, "devices", dir);
  for (const [f, v] of Object.entries(files)) {
    mkdirSync(join(real, f, ".."), { recursive: true });
    writeFileSync(join(real, f), `${v}\n`);
  }
  mkdirSync(join(sys, "dev", type), { recursive: true });
  symlinkSync(real, join(sys, "dev", type, `${major}:${minor}`));
}

const make = (opts: { cache?: boolean; warn?: (m: string) => void } = {}) =>
  new DiskIdentity({
    byIdDir: byId,
    sysfsRoot: sys,
    cacheFile: opts.cache === false ? null : cacheFile,
    warn: opts.warn,
    // stat() follows symlinks, so resolve like the real implementation does
    devNumber: (p) => {
      try {
        return numbers.get(realpathSync(p)) ?? null;
      } catch {
        return null;
      }
    },
  });

describe("derivation helpers", () => {
  it("libata wwid: NAA-5 WWN, else T10 model+serial", () => {
    expect(idFromAtaWwid("naa.5000C500A1B2C3D4")).toBe("wwn_5000c500a1b2c3d4");
    // matches what smartctl's JSON produces for the same disk
    expect(idFromAtaWwid("naa.5000c500a1b2c3d4")).toBe(diskId(fixture("sata-hdd-ok.json") as Record<string, any>, "/dev/sda"));
    expect(idFromAtaWwid("t10.ATA     Samsung SSD 870 EVO 1TB                 FAKESSD0002")).toBe(
      diskId(fixture("sata-ssd-ok.json") as Record<string, any>, "/dev/sdb"),
    );
    expect(idFromAtaWwid("naa.600508b1001c4d5e6f7a8b9c0d1e2f30")).toBeNull(); // NAA-6: not reproducible
    expect(idFromAtaWwid("eui.0025385b21400001")).toBeNull();
  });

  it("by-id names: wwn only next to an ata- alias, ata model_serial, nvme model_serial", () => {
    expect(idFromByIdNames(["ata-ST4000VN008-2DR166_ZDH1ABCD", "wwn-0x5000c500a1b2c3d4"])).toBe("wwn_5000c500a1b2c3d4");
    expect(idFromByIdNames(["ata-Samsung_SSD_870_EVO_1TB_FAKESSD0002"])).toBe("samsung_ssd_870_evo_1tb_fakessd0002");
    // a lone wwn- link may be a SAS disk, whose smartctl ID is not the WWN
    expect(idFromByIdNames(["wwn-0x5000c500a1b2c3d4"])).toBeNull();
    expect(idFromByIdNames(["scsi-35000cca000000001"])).toBeNull();
    expect(idFromByIdNames(["nvme-Samsung_SSD_980_PRO_1TB_S5GXNX0R123456", "nvme-Samsung_SSD_980_PRO_1TB_S5GXNX0R123456_1", "nvme-eui.0025385b21400001"])).toBe(
      "samsung_ssd_980_pro_1tb_s5gxnx0r123456",
    );
    expect(idFromByIdNames(["nvme-eui.0025385b21400001"])).toBeNull();
    // only the namespace-suffixed name: the trailing _1 might be part of the serial
    expect(idFromByIdNames(["nvme-Model_SERIAL_1"])).toBeNull();
  });

  it("provisional ids never use more than the device name", () => {
    expect(provisionalId("/dev/sdb")).toBe("dev_sdb");
  });
});

describe("DiskIdentity", () => {
  it("derives a SATA WWN from sysfs for a disk that was never read (standby at boot)", () => {
    const sda = node("sda", "block", 8, 0);
    sysDev("block", 8, 0, "pci/ata1/host0/target0:0:0/0:0:0:0/block/sda", {
      "device/vendor": "ATA     ",
      "device/wwid": "naa.5000c500a1b2c3d4",
    });
    expect(make().known(sda)).toBe("wwn_5000c500a1b2c3d4");
  });

  it("derives NVMe model+serial from the controller (block namespace and char controller)", () => {
    const ns = node("nvme0n1", "block", 259, 0);
    const ctrl = node("nvme0", "char", 239, 0);
    sysDev("block", 259, 0, "pci/nvme/nvme0/nvme0n1", {
      "device/model": "WD_BLACK SN850X 1000GB                  ",
      "device/serial": "FAKENVME0003        ",
    });
    sysDev("char", 239, 0, "pci/nvme/nvme0", {
      model: "WD_BLACK SN850X 1000GB",
      serial: "FAKENVME0003",
    });
    const nvmeRead = diskId(fixture("nvme-ok.json") as Record<string, any>, "/dev/nvme0");
    const id = make({ cache: false });
    expect(id.known(ns)).toBe(nvmeRead);
    expect(id.known(ctrl)).toBe(nvmeRead);
  });

  it("does not guess for SAS/USB disks (vendor is not ATA)", () => {
    const sdc = node("sdc", "block", 8, 32);
    sysDev("block", 8, 32, "pci/sas/block/sdc", { "device/vendor": "SEAGATE", "device/wwid": "naa.5000c500deadbeef" });
    expect(make().known(sdc)).toBeNull();
  });

  it("falls back to by-id names and resolves /dev/sdX through the by-id symlinks", () => {
    const sdb = node("sdb", "block", 8, 16);
    link("ata-ST4000VN008-2DR166_ZDH1ABCD", sdb);
    link("wwn-0x5000c500a1b2c3d4", sdb);
    link("ata-ST4000VN008-2DR166_ZDH1ABCD-part1", sdb);
    const id = make();
    expect(id.aliases(sdb)).toEqual(["ata-ST4000VN008-2DR166_ZDH1ABCD", "wwn-0x5000c500a1b2c3d4"]);
    expect(id.stableKey(sdb)).toBe(join(byId, "wwn-0x5000c500a1b2c3d4"));
    expect(id.known(sdb)).toBe("wwn_5000c500a1b2c3d4");
  });

  it("pins a read ID in the cache file so it survives a restart while the disk sleeps", () => {
    const sdb = node("sdb", "block", 8, 16);
    const p = link("usb-WD_Elements_25A2_575834314131-0:0", sdb); // nothing derivable
    const first = make();
    expect(first.known(p)).toBeNull();
    expect(first.confirm(p, "wd_elements_25a2_wx41a1")).toBe("wd_elements_25a2_wx41a1");
    const saved = JSON.parse(readFileSync(cacheFile, "utf8"));
    expect(saved).toEqual({ version: 1, ids: { [p]: "wd_elements_25a2_wx41a1" } });
    // no temp files left behind (atomic write = temp + rename)
    expect(readdirSync(join(root, "data"))).toEqual(["disk-ids.json"]);

    const restarted = make();
    expect(restarted.known(p)).toBe("wd_elements_25a2_wx41a1");
    // reached through an unstable /dev/sdX name as well
    expect(restarted.known(sdb)).toBe("wd_elements_25a2_wx41a1");
  });

  it("keeps a pinned ID when a later read disagrees, and warns once", () => {
    const sda = node("sda", "block", 8, 0);
    const p = link("ata-Model_SER1", sda); // derived: model_ser1
    const warnings: string[] = [];
    const id = make({ warn: (m) => warnings.push(m) });
    expect(id.known(p)).toBe("model_ser1");
    expect(id.confirm(p, "wwn_5000000000000001")).toBe("model_ser1");
    expect(id.confirm(p, "wwn_5000000000000001")).toBe("model_ser1");
    expect(warnings).toHaveLength(1);
  });

  it("does not pin provisional IDs and ignores a corrupt cache", () => {
    const sda = node("sda", "block", 8, 0);
    const p = link("usb-X", sda);
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(cacheFile, "{not json");
    const warnings: string[] = [];
    const id = make({ warn: (m) => warnings.push(m) });
    expect(warnings[0]).toMatch(/unreadable disk id cache/);
    expect(id.confirm(p, "dev_usb_x")).toBe("dev_usb_x");
    expect(id.known(p)).toBeNull();
  });

  it("works without a cache file or a by-id directory", () => {
    const id = DiskIdentity.none();
    expect(id.known("/dev/sda")).toBeNull();
    expect(id.confirm("/dev/sda", "wwn_5000c500a1b2c3d4")).toBe("wwn_5000c500a1b2c3d4");
  });
});
