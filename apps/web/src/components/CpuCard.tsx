import type { Cpu } from "@chirp/shared";
import { formatTemp, tempLevel } from "../format";
import { useT } from "../i18n";
import { Sparkline } from "./Sparkline";

interface Props {
  cpu: Cpu;
  history: [number, number][];
}

export function CpuCard({ cpu, history }: Props) {
  const t = useT();
  const level = tempLevel(cpu.packageTemp, cpu.highTemp, cpu.critTemp);
  const max = cpu.critTemp ?? cpu.highTemp ?? 100;
  return (
    <section className="card cpu" aria-label="cpu">
      <h2>{t("cpu.title")}</h2>
      {cpu.model && <p className="muted">{cpu.model}</p>}
      <div className="cpu-top">
        <div>
          <div className="muted small">{t("cpu.package")}</div>
          <div className={`big temp-${level}`} data-testid="cpu-package">
            {formatTemp(cpu.packageTemp)}
          </div>
        </div>
        <div className="cpu-spark">
          <div className="muted small">{t("cpu.history")}</div>
          {history.length >= 2 ? <Sparkline points={history} /> : <div className="muted small">{t("cpu.noData")}</div>}
        </div>
      </div>
      {cpu.cores.length > 0 && (
        <>
          <div className="muted small">{t("cpu.cores")}</div>
          <ul className="cores">
            {cpu.cores.map((c) => {
              const lv = tempLevel(c.temp, cpu.highTemp, cpu.critTemp);
              const pct = c.temp == null ? 0 : Math.min(100, Math.max(0, (c.temp / max) * 100));
              return (
                <li key={c.label}>
                  <span className="core-label">{c.label}</span>
                  <span className="bar">
                    <span className={`bar-fill bar-${lv}`} style={{ width: `${pct}%` }} />
                  </span>
                  <span className="core-temp">{formatTemp(c.temp)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
