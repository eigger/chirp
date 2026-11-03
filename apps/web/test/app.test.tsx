import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { App } from "../src/App";
import { overallStatus, maskSerial } from "../src/format";
import { detectLang, messages, translate } from "../src/i18n";
import { REFRESH_RELOAD_MS, Summary } from "../src/components/Summary";

const sample = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../packages/shared/fixtures/status.sample.json"), "utf8"),
);

function mockFetch(validKey = "chp_good") {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== `Bearer ${validKey}`) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (url.startsWith("/api/v1/status")) return new Response(JSON.stringify(sample), { status: 200 });
    if (url.startsWith("/api/v1/history"))
      return new Response(JSON.stringify({ metric: "cpu.packageTemp", points: [[1, 40], [2, 50], [3, 45]] }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  localStorage.setItem("chirp.lang", "en");
});
afterEach(() => vi.unstubAllGlobals());

describe("KeyGate flow", () => {
  it("shows gate, accepts a key, renders the dashboard", async () => {
    const fn = mockFetch();
    render(<App />);
    await userEvent.type(screen.getByLabelText("API key"), "chp_good");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("pve")).toBeInTheDocument();
    expect(sessionStorage.getItem("chirp.apiKey")).toBe("chp_good");
    expect(fn).toHaveBeenCalledWith("/api/v1/status", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer chp_good" }) }));
  });

  it("returns to the gate on 401", async () => {
    mockFetch();
    sessionStorage.setItem("chirp.apiKey", "chp_stale");
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid");
    expect(sessionStorage.getItem("chirp.apiKey")).toBeNull();
  });
});

describe("fixture rendering", () => {
  it("renders cpu, disks, badges and detail", async () => {
    mockFetch();
    sessionStorage.setItem("chirp.apiKey", "chp_good");
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
  it("has identical i18n keys in ko and en", () => {
    expect(Object.keys(messages.ko).sort()).toEqual(Object.keys(messages.en).sort());
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
        <Summary data={sample} apiKey="chp_good" lang="en" onRefreshed={onRefreshed} onUnauthorized={() => {}} />,
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
      render(<Summary data={sample} apiKey="chp_good" lang="en" onRefreshed={onRefreshed} onUnauthorized={() => {}} />);
      await userEvent.click(screen.getByRole("button", { name: "Refresh SMART now" }));
      await screen.findByRole("status");
      vi.advanceTimersByTime(REFRESH_RELOAD_MS);
      expect(onRefreshed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
