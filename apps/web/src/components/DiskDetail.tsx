import { useState } from "react";
import type { Disk } from "@chirp/shared";
import { formatBytes, formatTime, maskSerial } from "../format";
import { useT, type Lang, type MessageKey } from "../i18n";

export function DiskDetail({ disk, lang }: { disk: Disk; lang: Lang }) {
  const t = useT();
  const [showSerial, setShowSerial] = useState(false);

  const counters: [string, number | null][] = [
    ...Object.entries(disk.ata ?? {}),
    ...Object.entries(disk.nvme ?? {}),
  ].map(([k, v]) => [k, v as number | null]);

  return (
    <div className="detail">
      <div className="detail-col">
        <h3>{t("detail.reasons")}</h3>
        {disk.health.reasons.length === 0 ? (
          <p className="muted">{t("detail.noReasons")}</p>
        ) : (
          <ul>
            {disk.health.reasons.map((r) => (
              <li key={r.code}>
                {t(`reason.${r.code}` as MessageKey)}
                {r.value != null && <span className="muted"> ({r.value})</span>}
              </li>
            ))}
          </ul>
        )}
        {disk.error && (
          <p className="error">
            {t("detail.error")}: {disk.error}
          </p>
        )}
        <dl className="kv">
          <dt>{t("detail.serial")}</dt>
          <dd>
            <code data-testid="serial">{showSerial ? (disk.serial ?? "—") : maskSerial(disk.serial)}</code>{" "}
            {disk.serial && (
              <button type="button" className="link" onClick={() => setShowSerial((s) => !s)}>
                {showSerial ? t("detail.hide") : t("detail.show")}
              </button>
            )}
          </dd>
          <dt>{t("detail.firmware")}</dt>
          <dd>{disk.firmware ?? "—"}</dd>
          <dt>{t("detail.cycles")}</dt>
          <dd>{disk.powerCycleCount ?? "—"}</dd>
          <dt>{t("detail.lastRead")}</dt>
          <dd>{formatTime(disk.lastReadAt, lang)}</dd>
        </dl>
      </div>
      <div className="detail-col">
        <h3>{t("detail.counters")}</h3>
        <dl className="kv">
          {counters.map(([k, v]) => (
            <div key={k} className="kv-row">
              <dt>{t(`counter.${k}` as MessageKey)}</dt>
              <dd>{k === "bytesWritten" ? formatBytes(v) : (v ?? "—")}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
