import { useState, type FormEvent } from "react";
import { ApiError, bootstrapAdmin, login, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordLengthProblem } from "../api";
import { useT } from "../i18n";

type T = ReturnType<typeof useT>;

/** Message for a password rule violation (client check or the server's weak_password reason). */
export function passwordRuleText(t: T, problem: string | null): string {
  if (problem === "too_long") return t("password.tooLong", { n: MAX_PASSWORD_LENGTH });
  if (problem === "common") return t("password.common");
  return t("password.weak", { n: MIN_PASSWORD_LENGTH });
}

function errorText(t: T, e: unknown, on401: string): string {
  if (e instanceof ApiError && e.status === 401) return on401;
  if (e instanceof ApiError && e.status === 429) return t("common.rateLimited", { n: e.retryAfter ?? "?" });
  if (e instanceof ApiError && e.code === "weak_password") return passwordRuleText(t, e.reason);
  if (e instanceof ApiError && e.code === "password_mismatch") return t("password.mismatch");
  return t("common.failed");
}

export function LoginForm({
  notice,
  onLoggedIn,
}: {
  notice?: "expired" | "taken";
  onLoggedIn: (username: string) => void;
}) {
  const t = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await login(username.trim(), password);
      onLoggedIn(me.username);
    } catch (err) {
      setError(errorText(t, err, t("login.invalid")));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card gate" onSubmit={submit}>
      <h1>{t("login.title")}</h1>
      <p className="muted">{t("login.desc")}</p>
      {notice && !error && <p className="muted">{t(notice === "expired" ? "login.expired" : "bootstrap.taken")}</p>}
      <label htmlFor="login-username">{t("login.username")}</label>
      <input id="login-username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
      <label htmlFor="login-password">{t("login.password")}</label>
      <input
        id="login-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy || !username.trim() || !password}>
        {busy ? t("login.busy") : t("login.submit")}
      </button>
      <div className="muted small forgot">
        <p>{t("login.forgot")}</p>
        <p>
          {t("login.forgotProxmox")}{" "}
          <code>pct exec &lt;CTID&gt; -- node /opt/chirp/current/apps/server/dist/cli.js admin reset-password</code>
        </p>
        <p>
          {t("login.forgotDocker")} <code>docker exec chirp node apps/server/dist/cli.js admin reset-password</code>
        </p>
      </div>
    </form>
  );
}

/** Mirrors `Username` in @chirp/shared (a test keeps them in sync). */
export const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/** First-run registration: shown while the server has no admin account. */
export function BootstrapForm({
  setupTokenRequired,
  onDone,
  onTaken,
}: {
  setupTokenRequired?: boolean;
  onDone: (username: string) => void;
  onTaken: () => void;
}) {
  const t = useT();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (setupTokenRequired && !setupToken.trim()) return setError(t("bootstrap.invalidToken"));
    if (!USERNAME_RE.test(username.trim())) return setError(t("bootstrap.badUsername"));
    const problem = passwordLengthProblem(password);
    if (problem) return setError(passwordRuleText(t, problem));
    if (password !== confirm) return setError(t("password.mismatch"));
    setBusy(true);
    setError(null);
    try {
      const me = await bootstrapAdmin(
        username.trim(),
        password,
        confirm,
        setupTokenRequired ? setupToken.trim() : undefined,
      );
      onDone(me.username);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return onTaken();
      if (err instanceof ApiError && (err.status === 403 || err.code === "unauthorized")) {
        return setError(t("bootstrap.invalidToken"));
      }
      // bad_request: a field broke the shared schema. Name the username only when it is the culprit.
      if (err instanceof ApiError && err.code === "bad_request" && !USERNAME_RE.test(username.trim())) {
        return setError(t("bootstrap.badUsername"));
      }
      setError(errorText(t, err, t("common.failed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card gate" onSubmit={submit}>
      <h1>{t("bootstrap.title")}</h1>
      <p className="muted">{t("bootstrap.desc")}</p>
      {setupTokenRequired && (
        <>
          <label htmlFor="bootstrap-token">{t("bootstrap.setupToken")}</label>
          <input
            id="bootstrap-token"
            autoComplete="off"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            placeholder={t("bootstrap.setupTokenPlaceholder")}
          />
        </>
      )}
      <label htmlFor="bootstrap-username">{t("login.username")}</label>
      <input
        id="bootstrap-username"
        autoComplete="username"
        autoFocus={!setupTokenRequired}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <label htmlFor="bootstrap-password">{t("password.new", { n: MIN_PASSWORD_LENGTH })}</label>
      <input
        id="bootstrap-password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <label htmlFor="bootstrap-confirm">{t("password.confirm")}</label>
      <input
        id="bootstrap-confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="primary"
        disabled={busy || !username.trim() || !password || !confirm || (Boolean(setupTokenRequired) && !setupToken.trim())}
      >
        {t("bootstrap.submit")}
      </button>
    </form>
  );
}
