import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, changePassword, fetchApiKey, MIN_PASSWORD_LENGTH, regenerateApiKey, type ApiKeyState } from "../api";
import { useT } from "../i18n";

interface Props {
  onUnauthorized: () => void;
}

export function Settings({ onUnauthorized }: Props) {
  return (
    <>
      <ApiKeyPanel onUnauthorized={onUnauthorized} />
      <ChangePassword onUnauthorized={onUnauthorized} />
    </>
  );
}

/** Host and port the browser used to reach chirp: the same values Home Assistant needs. */
function serverAddress(): { host: string; port: string } {
  const { hostname, port, protocol } = window.location;
  return { host: hostname, port: port || (protocol === "https:" ? "443" : "80") };
}

/** `chp_abcd••••••••` — enough to recognise the key without revealing it. */
function masked(key: string): string {
  return `${key.slice(0, 8)}${"•".repeat(Math.max(8, Math.min(32, key.length - 8)))}`;
}

export function ApiKeyPanel({ onUnauthorized }: Props) {
  const t = useT();
  const [state, setState] = useState<ApiKeyState | null>(null);
  const [visible, setVisible] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown, fallback: string) => {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setMessage(fallback);
    },
    [onUnauthorized],
  );

  useEffect(() => {
    fetchApiKey()
      .then(setState)
      .catch((e) => fail(e, t("key.loadFailed")));
  }, [fail, t]);

  const copy = async () => {
    if (!state) return;
    try {
      await navigator.clipboard.writeText(state.key);
      setMessage(t("key.copied"));
    } catch {
      setVisible(true);
      setMessage(t("key.copyFailed"));
    }
  };

  const regenerate = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { key } = await regenerateApiKey();
      setState({ key, source: "file" });
      setVisible(true); // the new key is shown so it can be copied right away
      setMessage(t("key.regenerated"));
    } catch (e) {
      fail(e, t("common.failed"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const { host, port } = serverAddress();
  const fromEnv = state?.source === "env";

  return (
    <section className="card" aria-label="api-key">
      <h2>{t("key.title")}</h2>
      <p className="muted">{t("key.desc")}</p>
      {state && (
        <>
          <code className="issued-key" data-testid="api-key">
            {visible ? state.key : masked(state.key)}
          </code>
          <div className="row-actions">
            <button type="button" onClick={() => setVisible((v) => !v)}>
              {visible ? t("key.hide") : t("key.show")}
            </button>
            <button type="button" className="primary" onClick={() => void copy()}>
              {t("key.copy")}
            </button>
            {!confirming && (
              <button type="button" disabled={fromEnv || busy} onClick={() => setConfirming(true)}>
                {t("key.regenerate")}
              </button>
            )}
          </div>
          <p className="muted">{t("key.haHint", { host, port })}</p>
          {fromEnv && <p className="muted small">{t("key.envReadOnly")}</p>}
          {confirming && (
            <div className="confirm-box" role="alertdialog" aria-label="regenerate-confirm">
              <p>{t("key.regenerateConfirm")}</p>
              <div className="row-actions">
                <button type="button" className="danger" disabled={busy} onClick={() => void regenerate()}>
                  {t("key.regenerateYes")}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  {t("key.cancel")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

export function ChangePassword({ onUnauthorized }: Props) {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if ([...next].length < MIN_PASSWORD_LENGTH) return setMsg({ ok: false, text: t("password.weak", { n: MIN_PASSWORD_LENGTH }) });
    if (next !== confirm) return setMsg({ ok: false, text: t("password.mismatch") });
    setBusy(true);
    setMsg(null);
    try {
      await changePassword(current, next, confirm);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: t("pw.done") });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onUnauthorized();
      const code = err instanceof ApiError ? err.code : null;
      const text =
        code === "invalid_credentials"
          ? t("pw.wrongCurrent")
          : code === "weak_password"
            ? t("password.weak", { n: MIN_PASSWORD_LENGTH })
            : code === "password_mismatch"
              ? t("password.mismatch")
              : err instanceof ApiError && err.status === 429
                ? t("common.rateLimited", { n: err.retryAfter ?? "?" })
                : t("common.failed");
      setMsg({ ok: false, text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card settings-form" aria-label="change-password" onSubmit={submit}>
      <h2>{t("pw.title")}</h2>
      <label htmlFor="pw-current">{t("pw.current")}</label>
      <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <label htmlFor="pw-new">{t("pw.new", { n: MIN_PASSWORD_LENGTH })}</label>
      <input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      <label htmlFor="pw-confirm">{t("pw.confirm")}</label>
      <input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "muted" : "error"}>
          {msg.text}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy || !current || !next || !confirm}>
        {busy ? t("pw.busy") : t("pw.submit")}
      </button>
    </form>
  );
}
