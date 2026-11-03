import { useCallback, useEffect, useState } from "react";
import type { StatusSnapshot } from "@chirp/shared";
import { ApiError, fetchBootstrapStatus, fetchHistory, fetchMe, fetchStatus, logout } from "./api";
import { detectLang, LangContext, translate, type Lang } from "./i18n";
import { BootstrapForm, LoginForm } from "./components/AuthForms";
import { Settings } from "./components/Settings";
import { Summary } from "./components/Summary";
import { CpuCard } from "./components/CpuCard";
import { DiskTable } from "./components/DiskTable";

const POLL_MS = 30_000;

/** checking -> bootstrap (no admin yet) | login | signed in. */
type AuthState =
  | { kind: "checking" }
  | { kind: "bootstrap" }
  | { kind: "login"; notice?: "expired" | "taken" }
  | { kind: "in"; username: string };

type View = "dashboard" | "settings";

function Dashboard({ lang, onUnauthorized }: { lang: Lang; onUnauthorized: () => void }) {
  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);
  const [data, setData] = useState<StatusSnapshot | null>(null);
  const [history, setHistory] = useState<[number, number][]>([]);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await fetchStatus();
      setData(s);
      setFailed(false);
      fetchHistory("cpu.packageTemp")
        .then((h) => setHistory(h.points))
        .catch(() => setHistory([]));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setFailed(true);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!data) {
    return failed ? (
      <div className="card">
        <p className="error">{t("common.error")}</p>
        <button type="button" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </div>
    ) : (
      <p className="muted">{t("common.loading")}</p>
    );
  }
  return (
    <>
      {failed && <p className="error">{t("common.error")}</p>}
      <Summary data={data} lang={lang} onRefreshed={() => void load()} onUnauthorized={onUnauthorized} />
      <CpuCard cpu={data.cpu} history={history} />
      <DiskTable disks={data.disks} lang={lang} />
      <p className="muted small">{t("common.autoRefresh")}</p>
    </>
  );
}

export function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });
  const [view, setView] = useState<View>("dashboard");
  const [signingOut, setSigningOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);

  const t = (k: Parameters<typeof translate>[1]) => translate(lang, k);

  /** Ask the server who we are; without a session decide between first-run registration and login. */
  const check = useCallback(async (expired = false) => {
    try {
      const me = await fetchMe();
      setAuth({ kind: "in", username: me.username });
      return;
    } catch {
      /* not signed in */
    }
    try {
      const s = await fetchBootstrapStatus();
      setAuth(s.needsBootstrap ? { kind: "bootstrap" } : { kind: "login", notice: expired ? "expired" : undefined });
    } catch {
      setAuth({ kind: "login", notice: expired ? "expired" : undefined });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("chirp.lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const signedIn = (username: string) => {
    setLogoutFailed(false);
    setView("dashboard");
    setAuth({ kind: "in", username });
  };

  // A 401 anywhere means the session ended (expired, password changed elsewhere, server restarted).
  const unauthorized = useCallback(() => void check(true), [check]);

  const signOut = async () => {
    setSigningOut(true);
    setLogoutFailed(false);
    try {
      await logout();
      setAuth({ kind: "login" });
    } catch {
      setLogoutFailed(true);
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <LangContext.Provider value={lang}>
      <header className="topbar">
        <strong className="brand">🐤 {t("app.title")}</strong>
        <nav className="topbar-right">
          {auth.kind === "in" && (
            <>
              <button
                type="button"
                className="link"
                aria-current={view === "dashboard" ? "page" : undefined}
                onClick={() => setView("dashboard")}
              >
                {t("nav.dashboard")}
              </button>
              <button
                type="button"
                className="link"
                aria-current={view === "settings" ? "page" : undefined}
                onClick={() => setView("settings")}
              >
                {t("nav.settings")}
              </button>
              <span className="muted user">{auth.username}</span>
              <button type="button" className="link" disabled={signingOut} onClick={() => void signOut()}>
                {t("nav.logout")}
              </button>
            </>
          )}
          <button type="button" className="link" onClick={() => setLang(lang === "ko" ? "en" : "ko")}>
            {t("common.lang")}
          </button>
        </nav>
      </header>
      <main className="container">
        {auth.kind === "in" && logoutFailed && <p role="alert" className="error">{t("logout.failed")}</p>}
        {auth.kind === "checking" && <p className="muted">{t("common.loading")}</p>}
        {auth.kind === "bootstrap" && (
          <BootstrapForm onDone={signedIn} onTaken={() => setAuth({ kind: "login", notice: "taken" })} />
        )}
        {auth.kind === "login" && <LoginForm notice={auth.notice} onLoggedIn={signedIn} />}
        {auth.kind === "in" &&
          (view === "settings" ? (
            <Settings onUnauthorized={unauthorized} />
          ) : (
            <Dashboard lang={lang} onUnauthorized={unauthorized} />
          ))}
      </main>
    </LangContext.Provider>
  );
}
