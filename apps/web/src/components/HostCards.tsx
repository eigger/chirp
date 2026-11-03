import type { Fan, Load, MetricScope, Memory, Network, Power, Voltage } from "@chirp/shared";
import {
  formatBytes,
  formatBytesIEC,
  formatLinkSpeed,
  formatLoad,
  formatPercent,
  formatRate,
  formatVolts,
  formatWatts,
  usageLevel,
} from "../format";
import { useT } from "../i18n";
import { Sparkline } from "./Sparkline";

/** Shown on sections read from the container's own /proc or network namespace. */
export function ScopeNote({ scope }: { scope: MetricScope }) {
  const t = useT();
  if (scope !== "container") return null;
  return (
    <span className="scope-note" data-testid="scope-container" title={t("scope.containerHint")}>
      {t("scope.container")}
    </span>
  );
}

function UsageBar({ percent }: { percent: number | null }) {
  const w = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <span className="bar bar-wide" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <span className={`bar-fill bar-${usageLevel(percent)}`} style={{ width: `${w}%` }} />
    </span>
  );
}

export function MemoryCard({ memory }: { memory: Memory }) {
  const t = useT();
  const hasSwap = (memory.swapTotalBytes ?? 0) > 0;
  return (
    <section className="card" aria-label="memory">
      <div className="card-head">
        <h2>{t("mem.title")}</h2>
        <ScopeNote scope={memory.scope} />
      </div>
      <div className="metric-row">
        <span className="big" data-testid="mem-used">
          {formatPercent(memory.usedPercent)}
        </span>
        <span className="muted">
          {t("mem.of", { used: formatBytesIEC(memory.usedBytes), total: formatBytesIEC(memory.totalBytes) })}
        </span>
      </div>
      <UsageBar percent={memory.usedPercent} />
      <dl className="kv">
        <div className="kv-row">
          <dt>{t("mem.available")}</dt>
          <dd>{formatBytesIEC(memory.availableBytes)}</dd>
        </div>
        <div className="kv-row">
          <dt>{t("mem.swap")}</dt>
          <dd data-testid="mem-swap">
            {hasSwap
              ? `${formatPercent(memory.swapUsedPercent)} · ${t("mem.of", {
                  used: formatBytesIEC(memory.swapUsedBytes),
                  total: formatBytesIEC(memory.swapTotalBytes),
                })}`
              : t("mem.noSwap")}
          </dd>
        </div>
      </dl>
      {hasSwap && <UsageBar percent={memory.swapUsedPercent} />}
    </section>
  );
}

export function LoadCard({ load, history }: { load: Load; history: [number, number][] }) {
  const t = useT();
  return (
    <section className="card" aria-label="load">
      <div className="card-head">
        <h2>{t("load.title")}</h2>
        <ScopeNote scope={load.scope} />
      </div>
      <div className="metric-row">
        <span className="big" data-testid="load-cpu">
          {formatPercent(load.cpuUsagePercent)}
        </span>
        <span className="muted">
          {t("load.cpu")}
          {load.cpuCount != null && ` · ${t("load.cpus", { n: load.cpuCount })}`}
        </span>
      </div>
      <UsageBar percent={load.cpuUsagePercent} />
      <div className="muted small">{t("load.avg")}</div>
      <div className="load-avg" data-testid="load-avg">
        {formatLoad(load.load1)} / {formatLoad(load.load5)} / {formatLoad(load.load15)}
      </div>
      {history.length >= 2 && (
        <>
          <div className="muted small">{t("load.history")}</div>
          <Sparkline points={history} height={40} label={t("load.history")} />
        </>
      )}
    </section>
  );
}

export function NetworkTable({ network }: { network: Network }) {
  const t = useT();
  return (
    <section className="card" aria-label="network">
      <div className="card-head">
        <h2>{t("net.title")}</h2>
        <ScopeNote scope={network.scope} />
      </div>
      {network.interfaces.length === 0 ? (
        <p className="muted">{t("net.empty")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("net.iface")}</th>
                <th>{t("net.kind")}</th>
                <th>{t("net.state")}</th>
                <th>{t("net.speed")}</th>
                <th className="num">{t("net.rx")}</th>
                <th className="num">{t("net.tx")}</th>
                <th className="num">{t("net.total")}</th>
                <th className="num">{t("net.errors")}</th>
              </tr>
            </thead>
            <tbody>
              {network.interfaces.map((i) => {
                const errs = (i.rxErrors ?? 0) + (i.txErrors ?? 0);
                const drops = (i.rxDropped ?? 0) + (i.txDropped ?? 0);
                return (
                  <tr key={i.id} data-testid={`net-${i.id}`}>
                    <td>{i.name}</td>
                    <td>{t(`net.kind.${i.kind}`)}</td>
                    <td>
                      {i.operState === null ? (
                        <span className="badge badge-unknown" title={t("net.unknownHint")} data-testid={`state-unknown-${i.id}`}>
                          {t("net.unknown")}
                        </span>
                      ) : (
                        <span className={`badge badge-${i.up ? "ok" : "unknown"}`}>{i.up ? t("net.up") : t("net.down")}</span>
                      )}
                      {i.operState && i.operState !== "up" && i.operState !== "down" && (
                        <span className="muted small" data-testid={`operstate-${i.id}`}>
                          {" "}
                          {i.operState}
                        </span>
                      )}
                    </td>
                    <td>{formatLinkSpeed(i.speedMbps)}</td>
                    <td className="num">{formatRate(i.rxBytesPerSec)}</td>
                    <td className="num">{formatRate(i.txBytesPerSec)}</td>
                    <td className="num">
                      {formatBytes(i.rxBytes)} / {formatBytes(i.txBytes)}
                    </td>
                    <td className={`num${errs > 0 ? " error" : ""}`}>
                      {errs} / {drops}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function PowerCard({ power, fans, voltages }: { power: Power | null; fans: Fan[]; voltages: Voltage[] }) {
  const t = useT();
  const sources = power?.sources ?? [];
  return (
    <section className="card" aria-label="power">
      <h2>{t("power.title")}</h2>
      {power && power.packageSource && (
        <div className="metric-row">
          <span className="big" data-testid="power-package">
            {formatWatts(power.packageWatts)}
          </span>
          <span className="muted">{t("power.package")}</span>
        </div>
      )}
      <div className="sensor-groups">
        {sources.length > 0 && (
          <SensorList title={t("power.sources")} items={sources.map((s) => [s.id, s.label, formatWatts(s.watts)])} />
        )}
        {fans.length > 0 && (
          <SensorList
            title={t("power.fans")}
            items={fans.map((f) => [f.id, `${f.chip} ${f.label}`, f.rpm == null ? "—" : `${f.rpm} RPM`])}
          />
        )}
        {voltages.length > 0 && (
          <SensorList title={t("power.voltages")} items={voltages.map((v) => [v.id, `${v.chip} ${v.label}`, formatVolts(v.volts)])} />
        )}
      </div>
    </section>
  );
}

function SensorList({ title, items }: { title: string; items: [string, string, string][] }) {
  return (
    <div>
      <h3>{title}</h3>
      <dl className="kv">
        {items.map(([id, label, value]) => (
          <div className="kv-row" key={id}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
