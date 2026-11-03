import { Fragment, useState } from "react";
import type { Disk } from "@chirp/shared";
import { formatBytes, formatTemp, wearPercent } from "../format";
import { useT, type Lang } from "../i18n";
import { DiskDetail } from "./DiskDetail";
import { StatusBadge } from "./Summary";

const KIND = { hdd: "HDD", ssd: "SSD", nvme: "NVMe", unknown: "—" } as const;

export function DiskTable({ disks, lang }: { disks: Disk[]; lang: Lang }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  if (disks.length === 0)
    return (
      <section className="card">
        <h2>{t("disks.title")}</h2>
        <p className="muted">{t("disks.empty")}</p>
      </section>
    );
  return (
    <section className="card" aria-label="disks">
      <h2>{t("disks.title")}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("disks.model")}</th>
              <th>{t("disks.name")}</th>
              <th>{t("disks.kind")}</th>
              <th className="num">{t("disks.capacity")}</th>
              <th className="num">{t("disks.temp")}</th>
              <th className="num">{t("disks.poh")}</th>
              <th className="num">{t("disks.wear")}</th>
              <th>{t("disks.status")}</th>
            </tr>
          </thead>
          <tbody>
            {disks.map((d) => {
              const isOpen = open === d.id;
              const wear = wearPercent(d);
              return (
                <Fragment key={d.id}>
                  <tr
                    className={`row ${isOpen ? "open" : ""}`}
                    onClick={() => setOpen(isOpen ? null : d.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen(isOpen ? null : d.id);
                      }
                    }}
                    tabIndex={0}
                    aria-expanded={isOpen}
                  >
                    <td>{d.model ?? "—"}</td>
                    <td>{d.name}</td>
                    <td>{KIND[d.kind]}</td>
                    <td className="num">{formatBytes(d.capacityBytes)}</td>
                    <td className="num">{formatTemp(d.temperature)}</td>
                    <td className="num">
                      {d.powerOnHours == null ? "—" : t("unit.days", { n: Math.floor(d.powerOnHours / 24) })}
                    </td>
                    <td className="num">{wear == null ? "—" : `${wear}%`}</td>
                    <td>
                      <StatusBadge status={d.health.status} standby={d.standby} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="detail-row">
                      <td colSpan={8}>
                        <DiskDetail disk={d} lang={lang} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
