import { useCallback, useEffect, useState } from "react";
import type { StatusSnapshot } from "@chirp/shared";
import { ApiError, clearKey, fetchHistory, fetchStatus, getKey, setKey } from "./api";
import { detectLang, LangContext, translate, type Lang } from "./i18n";
import { KeyGate } from "./components/KeyGate";
import { Summary } from "./components/Summary";
import { CpuCard } from "./components/CpuCard";
import { DiskTable } from "./components/DiskTable";
import { LoadCard, MemoryCard, NetworkTable, PowerCard } from "./components/HostCards";

const POLL_MS = 30_000;

export function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [apiKey, setApiKey] = useState<string | null>(getKey);
  const [invalid, setInvalid] = useState(false);
  const [data, setData] = useState<StatusSnapshot | null>(null);
  const [history, setHistory] = useState<[number, number][]>([]);
  const [cpuUsageHistory, setCpuUsageHistory] = useState<[number, number][]>([]);
  const [failed, setFailed] = useState(false);

  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);

  const load = useCallback(async () => {
    if (!apiKey) return;
    try {
      const s = await fetchStatus(apiKey);
      setData(s);
      setFailed(false);
      setInvalid(false);
      fetchHistory(apiKey, "cpu.packageTemp")
        .then((h) => setHistory(h.points))
        .catch(() => setHistory([]));
      if (s.load) {
        fetchHistory(apiKey, "load.cpuUsagePercent")
          .then((h) => setCpuUsageHistory(h.points))
          .catch(() => setCpuUsageHistory([]));
      } else {
        setCpuUsageHistory([]);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearKey();
        setApiKey(null);
        setData(null);
        setInvalid(true);
      } else {
        setFailed(true);
      }
    }
  }, [apiKey]);

  useEffect(() => {
    if (!apiKey) return;
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [apiKey, load]);

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("chirp.lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const unauthorized = () => {
    clearKey();
    setApiKey(null);
    setData(null);
    setInvalid(true);
  };

  return (
    <LangContext.Provider value={lang}>
      <header className="topbar">
        <strong className="brand">🐤 {t("app.title")}</strong>
        <div className="topbar-right">
          {apiKey && (
            <button type="button" className="link" onClick={unauthorized}>
              {t("common.logout")}
            </button>
          )}
          <button type="button" className="link" onClick={() => setLang(lang === "ko" ? "en" : "ko")}>
            {t("common.lang")}
          </button>
        </div>
      </header>
      <main className="container">
        {!apiKey ? (
          <KeyGate
            invalid={invalid}
            onSubmit={(k) => {
              setKey(k);
              setInvalid(false);
              setApiKey(k);
            }}
          />
        ) : !data ? (
          failed ? (
            <div className="card">
              <p className="error">{t("common.error")}</p>
              <button type="button" onClick={() => void load()}>
                {t("common.retry")}
              </button>
            </div>
          ) : (
            <p className="muted">{t("common.loading")}</p>
          )
        ) : (
          <>
            {failed && <p className="error">{t("common.error")}</p>}
            <Summary data={data} apiKey={apiKey} lang={lang} onRefreshed={() => void load()} onUnauthorized={unauthorized} />
            <CpuCard cpu={data.cpu} history={history} />
            {(data.memory || data.load) && (
              <div className="host-grid">
                {data.memory && <MemoryCard memory={data.memory} />}
                {data.load && <LoadCard load={data.load} history={cpuUsageHistory} />}
              </div>
            )}
            {data.network && <NetworkTable network={data.network} />}
            {(data.power || (data.fans?.length ?? 0) > 0 || (data.voltages?.length ?? 0) > 0) && (
              <PowerCard power={data.power ?? null} fans={data.fans ?? []} voltages={data.voltages ?? []} />
            )}
            <DiskTable disks={data.disks} lang={lang} />
            <p className="muted small">{t("common.autoRefresh")}</p>
          </>
        )}
      </main>
    </LangContext.Provider>
  );
}
