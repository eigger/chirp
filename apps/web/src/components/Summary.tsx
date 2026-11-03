import { useEffect, useRef, useState } from "react";
import type { StatusSnapshot } from "@chirp/shared";
import { ApiError, postRefresh } from "../api";
import { formatTime, formatUptime, overallStatus } from "../format";
import { useT, type Lang } from "../i18n";

export function StatusBadge({ status, standby }: { status: "ok" | "warning" | "failing" | "unknown"; standby?: boolean }) {
  const t = useT();
  return (
    <span className="badge-group">
      <span className={`badge badge-${status}`}>{t(`status.${status}`)}</span>
      {standby && <span className="badge badge-standby">{t("status.standby")}</span>}
    </span>
  );
}

/** Reload the snapshot this long after a queued refresh. */
export const REFRESH_RELOAD_MS = 3000;

interface Props {
  data: StatusSnapshot;
  lang: Lang;
  onRefreshed: () => void;
  onUnauthorized: () => void;
}

export function Summary({ data, lang, onRefreshed, onUnauthorized }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { instance } = data;

  // Cancel a pending reload when the summary unmounts (e.g. logout, switching to Settings).
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );

  const refresh = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await postRefresh();
      setMsg(t("summary.queued"));
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(() => {
        reloadTimer.current = null;
        onRefreshed();
      }, REFRESH_RELOAD_MS);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else if (e instanceof ApiError && e.status === 429) setMsg(t("summary.cooldown", { n: e.retryAfter ?? "?" }));
      else setMsg(t("summary.refreshFailed"));
    } finally {
      setBusy(false);
    }
  };

  const items: [string, string][] = [
    [t("summary.host"), instance.hostname],
    [t("summary.kernel"), instance.kernel ?? "—"],
    [t("summary.uptime"), formatUptime(instance.uptimeSeconds)],
    [t("summary.version"), instance.version],
    [t("summary.collected"), formatTime(instance.collectedAt, lang)],
  ];

  return (
    <section className="card summary" aria-label="summary">
      <dl className="summary-grid">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div>
          <dt>{t("summary.overall")}</dt>
          <dd>
            <StatusBadge status={overallStatus(data.disks)} />
          </dd>
        </div>
      </dl>
      <div className="summary-actions">
        <button type="button" onClick={refresh} disabled={busy}>
          {busy ? t("summary.refreshing") : t("summary.refresh")}
        </button>
        {msg && (
          <span className="muted" role="status">
            {msg}
          </span>
        )}
      </div>
    </section>
  );
}
