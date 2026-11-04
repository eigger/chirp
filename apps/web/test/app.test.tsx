import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { MAX_PASSWORD_LENGTH as SHARED_MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH as SHARED_MIN_PASSWORD_LENGTH, Username } from "@chirp/shared";
import { USERNAME_RE } from "../src/components/AuthForms";
import { App } from "../src/App";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../src/api";
import { overallStatus, maskSerial } from "../src/format";
import { detectLang, messages, translate } from "../src/i18n";
import { REFRESH_RELOAD_MS, Summary } from "../src/components/Summary";

const sample = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../packages/shared/fixtures/status.sample.json"), "utf8"),
);

/**
 * A tiny in-memory chirp server: one admin, a session flag standing in for the
 * HttpOnly cookie, and the API key. Non-GET requests must carry the CSRF header.
 */
function fakeServer(opts: { admin?: boolean; signedIn?: boolean; envKey?: boolean; setupToken?: string | null } = {}) {
  const state = {
    admin: opts.admin === false ? null : { username: "admin", password: "correct horse" },
    session: opts.signedIn ?? false,
    key: "chp_firstkey" + "a".repeat(32),
    source: (opts.envKey ? "env" : "file") as "env" | "file",
    regenerated: 0,
    setupToken: opts.setupToken ?? null,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method !== "GET" && headers["X-Chirp-Csrf"] !== "1") return json({ error: "forbidden" }, 403);
    if (url === "/api/v1/bootstrap/status") {
      return json({
        needsBootstrap: !state.admin,
        ...(!state.admin && state.setupToken ? { setupTokenRequired: true } : {}),
      });
    }
    if (url === "/api/v1/bootstrap/admin") {
      if (state.admin) return json({ error: "conflict" }, 409);
      if (state.setupToken && body?.setupToken !== state.setupToken) {
        return json({ error: "unauthorized" }, 403);
      }
      if (body.password !== body.passwordConfirm) return json({ error: "password_mismatch" }, 400);
      state.admin = { username: body.username, password: body.password };
      state.session = true;
      return json({ username: body.username }, 201);
    }
    if (url === "/api/v1/auth/login") {
      if (!state.admin || body.username !== state.admin.username || body.password !== state.admin.password) {
        return json({ error: "unauthorized" }, 401);
      }
      state.session = true;
      return json({ username: state.admin.username });
    }
    if (url === "/api/v1/auth/logout") {
      state.session = false;
      return new Response(null, { status: 204 });
    }
    if (!state.session) return json({ error: "unauthorized" }, 401);
    if (url === "/api/v1/auth/me") return json({ username: state.admin!.username });
    if (url === "/api/v1/auth/password") {
      if (body.newPassword !== body.newPasswordConfirm) return json({ error: "password_mismatch" }, 400);
      if (body.currentPassword !== state.admin!.password) return json({ error: "invalid_credentials" }, 400);
      state.admin!.password = body.newPassword;
      return new Response(null, { status: 204 });
    }
    if (url === "/api/v1/admin/api-key") return json({ key: state.key, source: state.source });
    if (url === "/api/v1/admin/api-key/regenerate") {
      if (state.source === "env") return json({ error: "conflict" }, 409);
      state.regenerated += 1;
      state.key = `chp_newkey${state.regenerated}` + "b".repeat(32);
      return json({ key: state.key });
    }
    if (url.startsWith("/api/v1/status")) return json(sample);
    if (url.startsWith("/api/v1/history")) return json({ metric: "cpu.packageTemp", points: [[1, 40], [2, 50], [3, 45]] });
    return json({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return { fn, state };
}

beforeEach(() => {
  localStorage.setItem("chirp.lang", "en");
});
afterEach(() => vi.unstubAllGlobals());

async function openSettings() {
  await screen.findByText("pve");
  await userEvent.click(screen.getByRole("button", { name: "Settings" }));
  return screen.findByRole("region", { name: "api-key" });
}

describe("sign-in flow", () => {
  it("shows the login form, rejects a wrong password, then renders the dashboard", async () => {
    const { fn } = fakeServer();
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "wrong one");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password");
    await userEvent.type(screen.getByLabelText("Password"), "correct horse");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("pve")).toBeInTheDocument();
    // Cookie auth only: no Authorization header, nothing stored in the browser.
    for (const [, init] of fn.mock.calls) {
      expect((init?.headers as Record<string, string>)?.Authorization).toBeUndefined();
      expect(init?.credentials).toBe("same-origin");
    }
    expect(sessionStorage.length).toBe(0);
    expect(Object.keys(localStorage)).toEqual(["chirp.lang"]);
  });

  it("an existing session goes straight to the dashboard; a 401 returns to the login form", async () => {
    const { state } = fakeServer({ signedIn: true });
    render(<App />);
    expect(await screen.findByText("pve")).toBeInTheDocument();
    state.session = false;
    await userEvent.click(screen.getByRole("button", { name: "Refresh SMART now" }));
    expect(await screen.findByText(/session has ended/)).toBeInTheDocument();
  });

  it("log out returns to the login form", async () => {
    const { state } = fakeServer({ signedIn: true });
    render(<App />);
    await screen.findByText("pve");
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(state.session).toBe(false);
  });

  it.each(["network", "server"])("keeps the session visible after a %s logout failure and allows retry", async (failure) => {
    const { fn, state } = fakeServer({ signedIn: true });
    const handle = fn.getMockImplementation()!;
    let failLogout = true;
    fn.mockImplementation(async (url, init) => {
      if (url === "/api/v1/auth/logout" && failLogout) {
        failLogout = false;
        if (failure === "network") throw new TypeError("Failed to fetch");
        return new Response('{"error":"internal_error"}', { status: 500 });
      }
      return handle(url, init);
    });
    render(<App />);
    await screen.findByText("pve");
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not log out");
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(state.session).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(state.session).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("first-run registration", () => {
  it("without an admin the first visitor creates it (password twice) and is signed in", async () => {
    const { state } = fakeServer({ admin: false });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Create the admin account" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Password \(at least/), "a long password");
    await userEvent.type(screen.getByLabelText("Repeat password"), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByText("pve")).toBeInTheDocument();
    expect(state.admin).toEqual({ username: "admin", password: "a long password" });
  });

  it("checks length and confirmation in the browser before sending anything", async () => {
    const { fn } = fakeServer({ admin: false });
    render(<App />);
    await userEvent.type(await screen.findByLabelText(/^Password \(at least/), "short");
    await userEvent.type(screen.getByLabelText("Repeat password"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 10 characters");
    await userEvent.clear(screen.getByLabelText(/^Password \(at least/));
    await userEvent.type(screen.getByLabelText(/^Password \(at least/), "a long password");
    await userEvent.clear(screen.getByLabelText("Repeat password"));
    await userEvent.type(screen.getByLabelText("Repeat password"), "a long passw0rd");
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(fn.mock.calls.some(([u]) => u === "/api/v1/bootstrap/admin")).toBe(false);
  });

  it("rejects an invalid username with a specific message (client and server)", async () => {
    const { fn, state } = fakeServer({ admin: false });
    render(<App />);
    const user = await screen.findByLabelText("Username");
    await userEvent.clear(user);
    await userEvent.type(user, "my admin");
    await userEvent.type(screen.getByLabelText(/^Password \(at least/), "a long password");
    await userEvent.type(screen.getByLabelText("Repeat password"), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("may only contain letters, digits");
    expect(calls(fn, "/api/v1/bootstrap/admin", "POST")).toBe(0);
    // A server bad_request with a valid username is not blamed on the username.
    fn.mockImplementationOnce(async () => new Response('{"error":"bad_request"}', { status: 400 }));
    await userEvent.clear(user);
    await userEvent.type(user, "admin");
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The request failed.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("may only contain");
    expect(state.admin).toBeNull();
  });

  it("checks the password maximum in the browser and explains a common password from the server", async () => {
    const { fn } = fakeServer({ admin: false });
    render(<App />);
    const pw = await screen.findByLabelText(/^Password \(at least/);
    const again = screen.getByLabelText("Repeat password");
    const long = "x".repeat(257);
    await userEvent.click(pw);
    await userEvent.paste(long);
    await userEvent.click(again);
    await userEvent.paste(long);
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at most 256 characters");
    expect(calls(fn, "/api/v1/bootstrap/admin", "POST")).toBe(0);

    fn.mockImplementationOnce(async () => new Response('{"error":"weak_password","reason":"common"}', { status: 400 }));
    await userEvent.clear(pw);
    await userEvent.type(pw, "password123!");
    await userEvent.clear(again);
    await userEvent.type(again, "password123!");
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("too common or easy to guess");
  });

  it("keeps the dashboard's password maximum equal to the shared contract", () => {
    expect(MAX_PASSWORD_LENGTH).toBe(SHARED_MAX_PASSWORD_LENGTH);
  });

  it("the client username rule matches the shared contract", () => {
    for (const name of ["admin", "a.b_c@d-e", "x".repeat(64), "", "my admin", "x".repeat(65), "관리자", "a/b"]) {
      expect(USERNAME_RE.test(name), name).toBe(Username.safeParse(name).success);
    }
  });

  it("someone else was faster: falls back to the login form", async () => {
    const { state } = fakeServer({ admin: false });
    render(<App />);
    await screen.findByRole("heading", { name: "Create the admin account" });
    state.admin = { username: "other", password: "their password" };
    await userEvent.type(screen.getByLabelText(/^Password \(at least/), "a long password");
    await userEvent.type(screen.getByLabelText("Repeat password"), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("requires a setup token when the server requests it", async () => {
    const { state } = fakeServer({ admin: false, setupToken: "secret123" });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Create the admin account" })).toBeInTheDocument();
    const tokenInput = screen.getByLabelText("Setup token");
    expect(tokenInput).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^Password \(at least/), "a long password");
    await userEvent.type(screen.getByLabelText("Repeat password"), "a long password");
    // Button is disabled until token is entered
    expect(screen.getByRole("button", { name: "Create admin account" })).toBeDisabled();

    // Enter wrong token
    await userEvent.type(tokenInput, "wrongtoken");
    expect(screen.getByRole("button", { name: "Create admin account" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("setup token is invalid or missing");

    // Enter correct token
    await userEvent.clear(tokenInput);
    await userEvent.type(tokenInput, "secret123");
    await userEvent.click(screen.getByRole("button", { name: "Create admin account" }));
    expect(await screen.findByText("pve")).toBeInTheDocument();
    expect(state.admin).toEqual({ username: "admin", password: "a long password" });
  });
});

const settle = () => new Promise((r) => setTimeout(r, 500));
const calls = (fn: ReturnType<typeof fakeServer>["fn"], url: string, method = "GET") =>
  fn.mock.calls.filter(([u, i]) => u === url && (i?.method ?? "GET") === method).length;

describe("each screen fetches once on mount (no render loops)", () => {
  it("login screen: one /auth/me and one /bootstrap/status", async () => {
    const { fn } = fakeServer();
    render(<App />);
    await screen.findByRole("button", { name: "Sign in" });
    await settle();
    expect(calls(fn, "/api/v1/auth/me")).toBe(1);
    expect(calls(fn, "/api/v1/bootstrap/status")).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("dashboard: one status and one request per history metric until the 30 s poll", async () => {
    const { fn } = fakeServer({ signedIn: true });
    render(<App />);
    await screen.findByText("pve");
    await settle();
    expect(calls(fn, "/api/v1/auth/me")).toBe(1);
    expect(calls(fn, "/api/v1/status")).toBe(1);
    for (const metric of ["cpu.packageTemp", "load.cpuUsagePercent"]) {
      expect(fn.mock.calls.filter(([u]) => String(u).includes(`metric=${metric}`)).length).toBe(1);
    }
  });

  it("settings: exactly one GET /admin/api-key, also after re-renders (language switch, show/hide)", async () => {
    const { fn } = fakeServer({ signedIn: true });
    render(<App />);
    const section = await openSettings();
    await within(section).findByTestId("api-key");
    await settle();
    expect(calls(fn, "/api/v1/admin/api-key")).toBe(1);
    await userEvent.click(within(section).getByRole("button", { name: "Show" }));
    await userEvent.click(screen.getByRole("button", { name: "한국어" }));
    await settle();
    expect(calls(fn, "/api/v1/admin/api-key")).toBe(1);
  });
});

describe("settings: API key", () => {
  it("is masked until shown, copies, and regenerates only after confirmation", async () => {
    const { state } = fakeServer({ signedIn: true });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<App />);
    const section = await openSettings();
    const first = state.key;
    const shown = await within(section).findByTestId("api-key");
    expect(shown).not.toHaveTextContent(first);
    expect(shown).toHaveTextContent(first.slice(0, 8));
    await userEvent.click(within(section).getByRole("button", { name: "Show" }));
    expect(shown).toHaveTextContent(first);
    await userEvent.click(within(section).getByRole("button", { name: "Hide" }));
    expect(shown).not.toHaveTextContent(first);
    expect(within(section).getByText(/Paste this key into Home Assistant/)).toHaveTextContent("host localhost and port");

    await userEvent.click(within(section).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(first);

    await userEvent.click(within(section).getByRole("button", { name: "Regenerate" }));
    const dialog = screen.getByRole("alertdialog", { name: "regenerate-confirm" });
    expect(dialog).toHaveTextContent("stops working immediately");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(state.regenerated).toBe(0);

    await userEvent.click(within(section).getByRole("button", { name: "Regenerate" }));
    await userEvent.click(screen.getByRole("button", { name: "Regenerate key" }));
    expect(await within(section).findByText(/previous key no longer works/)).toBeInTheDocument();
    expect(state.regenerated).toBe(1);
    expect(within(section).getByTestId("api-key")).toHaveTextContent(state.key);
  });

  it("a key from CHIRP_API_KEY is read-only", async () => {
    fakeServer({ signedIn: true, envKey: true });
    render(<App />);
    const section = await openSettings();
    await within(section).findByTestId("api-key");
    expect(within(section).getByRole("button", { name: "Regenerate" })).toBeDisabled();
    expect(within(section).getByText(/set by CHIRP_API_KEY/)).toBeInTheDocument();
  });

  it("changes the password (entered twice) and reports errors", async () => {
    const { state } = fakeServer({ signedIn: true });
    render(<App />);
    await openSettings();
    const form = screen.getByRole("form", { name: "change-password" });
    const cur = within(form).getByLabelText("Current password");
    const next = within(form).getByLabelText(/^New password \(at least/);
    const again = within(form).getByLabelText("Repeat new password");
    await userEvent.type(cur, "correct horse");
    await userEvent.type(next, "brand new password");
    await userEvent.type(again, "brand new passw0rd");
    await userEvent.click(within(form).getByRole("button", { name: "Change password" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("do not match");
    expect(state.admin?.password).toBe("correct horse");

    await userEvent.clear(again);
    await userEvent.type(again, "brand new password");
    await userEvent.clear(cur);
    await userEvent.type(cur, "nope");
    await userEvent.click(within(form).getByRole("button", { name: "Change password" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("current password is wrong");

    await userEvent.clear(cur);
    await userEvent.type(cur, "correct horse");
    await userEvent.click(within(form).getByRole("button", { name: "Change password" }));
    expect(await within(form).findByRole("status")).toHaveTextContent("Password changed");
    expect(state.admin?.password).toBe("brand new password");
  });
});

describe("fixture rendering", () => {
  it("renders cpu, disks, badges and detail", async () => {
    fakeServer({ signedIn: true });
    render(<App />);
    expect(await screen.findByTestId("cpu-package")).toHaveTextContent("47°C");
    expect(screen.getByText("ST4000VN008-2DR166")).toBeInTheDocument();
    expect(screen.getByText("Samsung SSD 980 PRO 1TB")).toBeInTheDocument();
    expect(screen.getAllByText("Warning").length).toBeGreaterThan(0);
    // overall = worst disk = warning
    const summary = screen.getByRole("region", { name: "summary" });
    expect(within(summary).getByText("Warning")).toBeInTheDocument();

    await userEvent.click(screen.getByText("ST4000VN008-2DR166"));
    expect(screen.getAllByText(/Reallocated sectors/).length).toBeGreaterThan(1);
    expect(screen.getByTestId("serial")).toHaveTextContent("ZD****");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(screen.getByTestId("serial")).toHaveTextContent("ZDH1ABCD"));
  });
});

describe("helpers", () => {
  const d = (s: "ok" | "warning" | "failing" | "unknown") => ({ health: { status: s, reasons: [] } });
  it("computes overall status from the worst disk", () => {
    expect(overallStatus([])).toBe("unknown");
    expect(overallStatus([d("ok"), d("ok")])).toBe("ok");
    expect(overallStatus([d("ok"), d("warning")])).toBe("warning");
    expect(overallStatus([d("warning"), d("failing"), d("unknown")])).toBe("failing");
    expect(overallStatus([d("ok"), d("unknown")])).toBe("unknown");
  });
  it("masks serials", () => {
    expect(maskSerial("ZDH1ABCD")).toBe("ZD****");
    expect(maskSerial(null)).toBe("—");
  });
  it("has identical i18n keys in ko and en, with the same placeholders", () => {
    expect(Object.keys(messages.ko).sort()).toEqual(Object.keys(messages.en).sort());
    const vars = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
    for (const k of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
      expect(vars(messages.ko[k]), k).toBe(vars(messages.en[k]));
    }
  });
  it("keeps the dashboard's password minimum equal to the shared contract", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(SHARED_MIN_PASSWORD_LENGTH);
  });
  it("uses the browser language and falls back to English", () => {
    localStorage.removeItem("chirp.lang");
    const spy = vi.spyOn(navigator, "language", "get");
    spy.mockReturnValue("ko-KR");
    expect(detectLang()).toBe("ko");
    spy.mockReturnValue("de-DE");
    expect(detectLang()).toBe("en");
    spy.mockReturnValue("");
    expect(detectLang()).toBe("en");
    spy.mockRestore();
  });
  it("falls back to the English string for a missing translation", () => {
    const ko = messages.ko as Record<string, string>;
    const saved = ko["common.retry"];
    delete ko["common.retry"];
    expect(translate("ko", "common.retry")).toBe("Retry");
    ko["common.retry"] = saved;
  });
});

describe("Summary refresh timer", () => {
  it("clears the pending reload when unmounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response('{"queued":true}', { status: 202 })));
      const onRefreshed = vi.fn();
      const view = render(
        <Summary data={sample} lang="en" onRefreshed={onRefreshed} onUnauthorized={() => {}} />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Refresh SMART now" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Refresh requested");
      view.unmount();
      vi.advanceTimersByTime(REFRESH_RELOAD_MS * 2);
      expect(onRefreshed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reloads after the delay while mounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response('{"queued":true}', { status: 202 })));
      const onRefreshed = vi.fn();
      render(<Summary data={sample} lang="en" onRefreshed={onRefreshed} onUnauthorized={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: "Refresh SMART now" }));
      await screen.findByRole("status");
      vi.advanceTimersByTime(REFRESH_RELOAD_MS);
      expect(onRefreshed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
