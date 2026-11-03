import { render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";
import { App } from "../src/App";
import {
  formatBytesIEC,
  formatLinkSpeed,
  formatLoad,
  formatPercent,
  formatRate,
  formatVolts,
  formatWatts,
  usageLevel,
} from "../src/format";

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(process.cwd(), `../../packages/shared/fixtures/${name}`), "utf8"));

function serve(status: unknown) {
  const fn = vi.fn(async (url: string) => {
    if (url.startsWith("/api/v1/status")) return new Response(JSON.stringify(status), { status: 200 });
    if (url.startsWith("/api/v1/history"))
      return new Response(JSON.stringify({ metric: "x", points: [[1, 10], [2, 20], [3, 15]] }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  sessionStorage.setItem("chirp.apiKey", "chp_good");
  return fn;
}

beforeEach(() => localStorage.setItem("chirp.lang", "en"));
afterEach(() => vi.unstubAllGlobals());

describe("host metric cards", () => {
  it("renders memory, load, network and power from the full sample", async () => {
    const fn = serve(fixture("status.sample.json"));
    render(<App />);
    expect(await screen.findByTestId("mem-used")).toHaveTextContent("37.6%");
    expect(screen.getByTestId("mem-swap")).toHaveTextContent("3.1%");
    expect(screen.getByTestId("load-cpu")).toHaveTextContent("6.4%");
    expect(screen.getByTestId("load-avg")).toHaveTextContent("0.84 / 0.71 / 0.65");
    const eno1 = screen.getByTestId("net-eno1");
    expect(within(eno1).getByText("1 Gbit/s")).toBeInTheDocument();
    expect(within(eno1).getByText("1.2 Mbit/s")).toBeInTheDocument();
    expect(within(screen.getByTestId("net-enp3s0")).getByText("Down")).toBeInTheDocument();
    expect(screen.getByText("vmbr0.100")).toBeInTheDocument();
    expect(screen.getByTestId("power-package")).toHaveTextContent("18.4 W");
    expect(screen.getByText("nct6798 CPU Fan")).toBeInTheDocument();
    expect(screen.getByText("1180 RPM")).toBeInTheDocument();
    expect(screen.getByText("3.344 V")).toBeInTheDocument();
    expect(screen.queryByTestId("scope-container")).toBeNull();
    expect(fn).toHaveBeenCalledWith(expect.stringContaining("metric=load.cpuUsagePercent"), expect.anything());
  });

  it("labels container-scope sections", async () => {
    serve(fixture("status.container-scope.json"));
    render(<App />);
    await screen.findByTestId("mem-used");
    // memory, load and network are container scope
    expect(screen.getAllByTestId("scope-container")).toHaveLength(3);
    expect(screen.getAllByText("container view").length).toBe(3);
    expect(screen.getAllByTestId("scope-container")[0]).toHaveAttribute("title", expect.stringContaining("container's own"));
    expect(screen.getByTestId("load-cpu")).toHaveTextContent("—");
    expect(screen.getByTestId("power-package")).toHaveTextContent("—");
  });

  it("hides the cards for an old server and for null sections", async () => {
    for (const name of ["status.legacy.json", "status.null-sections.json"]) {
      const fn = serve(fixture(name));
      const view = render(<App />);
      expect(await screen.findByTestId("cpu-package")).toBeInTheDocument();
      for (const region of ["memory", "load", "network", "power"]) {
        expect(screen.queryByRole("region", { name: region })).toBeNull();
      }
      expect(fn).not.toHaveBeenCalledWith(expect.stringContaining("load.cpuUsagePercent"), expect.anything());
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("uses the Korean dictionary", async () => {
    localStorage.setItem("chirp.lang", "ko");
    serve(fixture("status.container-scope.json"));
    render(<App />);
    await screen.findByTestId("mem-used");
    expect(screen.getByRole("heading", { name: "메모리" })).toBeInTheDocument();
    expect(screen.getAllByText("컨테이너 관점").length).toBe(3);
  });
});

describe("review fixes", () => {
  it("shows a raw operstate other than up/down next to the badge", async () => {
    const status = fixture("status.sample.json");
    status.network.interfaces[1] = { ...status.network.interfaces[1], up: true, operState: "unknown" };
    serve(status);
    render(<App />);
    const row = await screen.findByTestId("net-eno1");
    expect(within(row).getByText("Up")).toBeInTheDocument();
    expect(within(row).getByTestId("operstate-eno1")).toHaveTextContent("unknown");
    expect(screen.queryByTestId("operstate-enp3s0")).toBeNull();
  });

  it("shows a neutral badge when the state is unknown (/proc/net/dev fallback)", async () => {
    const status = fixture("status.sample.json");
    status.network.interfaces[1] = { ...status.network.interfaces[1], up: false, operState: null };
    serve(status);
    render(<App />);
    const row = await screen.findByTestId("net-eno1");
    const badge = within(row).getByTestId("state-unknown-eno1");
    expect(badge).toHaveTextContent("—");
    expect(badge).toHaveAttribute("title", "state unknown");
    expect(within(row).queryByText("Down")).toBeNull();
    expect(within(screen.getByTestId("net-enp3s0")).getByText("Down")).toBeInTheDocument();
  });

  it("drops the CPU usage history when the server stops sending load", async () => {
    const full = fixture("status.sample.json");
    let status: Record<string, unknown> = full;
    const fn = vi.fn(async (url: string) => {
      if (url.startsWith("/api/v1/status")) return new Response(JSON.stringify(status), { status: 200 });
      return new Response(JSON.stringify({ metric: "x", points: [[1, 10], [2, 20], [3, 15]] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);
    sessionStorage.setItem("chirp.apiKey", "chp_good");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      await screen.findByRole("region", { name: "load" });
      expect(await screen.findByText("CPU usage, last 24 hours")).toBeInTheDocument();
      status = { ...full, load: null };
      await vi.advanceTimersByTimeAsync(30_000);
      await waitFor(() => expect(screen.queryByRole("region", { name: "load" })).toBeNull());
      // load returns: no stale sparkline from before until a fresh history arrives
      fn.mockImplementation(async (url: string) => {
        if (url.startsWith("/api/v1/status")) return new Response(JSON.stringify(full), { status: 200 });
        return new Promise<Response>(() => {}); // history still loading
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await screen.findByRole("region", { name: "load" });
      expect(screen.queryByText("CPU usage, last 24 hours")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatters", () => {
  it("bytes, rates and link speeds", () => {
    expect(formatBytesIEC(null)).toBe("—");
    expect(formatBytesIEC(512)).toBe("512 B");
    expect(formatBytesIEC(1536)).toBe("1.5 KiB");
    expect(formatBytesIEC(67108864000)).toBe("62.5 GiB");
    expect(formatRate(null)).toBe("—");
    expect(formatRate(0)).toBe("0 bit/s");
    expect(formatRate(100)).toBe("800 bit/s");
    expect(formatRate(152340.5)).toBe("1.2 Mbit/s");
    expect(formatRate(125_000_000)).toBe("1.0 Gbit/s");
    expect(formatLinkSpeed(null)).toBe("—");
    expect(formatLinkSpeed(100)).toBe("100 Mbit/s");
    expect(formatLinkSpeed(1000)).toBe("1 Gbit/s");
    expect(formatLinkSpeed(2500)).toBe("2.5 Gbit/s");
  });
  it("percent, load, watts, volts and usage levels", () => {
    expect(formatPercent(37.64)).toBe("37.6%");
    expect(formatPercent(undefined)).toBe("—");
    expect(formatLoad(0.5)).toBe("0.50");
    expect(formatWatts(18.44)).toBe("18.4 W");
    expect(formatVolts(1.0321)).toBe("1.032 V");
    expect(usageLevel(null)).toBe("unknown");
    expect(usageLevel(50)).toBe("ok");
    expect(usageLevel(90)).toBe("warning");
    expect(usageLevel(99)).toBe("failing");
  });
});
