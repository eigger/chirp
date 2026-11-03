import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cliEnvironment, DEFAULT_ENV_FILE, parseEnvFile } from "../src/envFile.js";

const FILE = `# chirp.env
CHIRP_PORT=80
CHIRP_DATA_DIR=/srv/chirp-data
export CHIRP_API_KEY_FILE="/srv/chirp-data/key file"
CHIRP_DISPLAY_NAME='pve # one'
CHIRP_DEVICES=/dev/sda   # trailing comment
  # indented comment
not a line
CHIRP_EMPTY=
`;

describe("CLI env file", () => {
  it("parses KEY=VALUE lines, quotes, export and comments", () => {
    expect(parseEnvFile(FILE)).toEqual({
      CHIRP_PORT: "80",
      CHIRP_DATA_DIR: "/srv/chirp-data",
      CHIRP_API_KEY_FILE: "/srv/chirp-data/key file",
      CHIRP_DISPLAY_NAME: "pve # one",
      CHIRP_DEVICES: "/dev/sda",
      CHIRP_EMPTY: "",
    });
  });

  it("uses /etc/chirp/chirp.env when present, and the real environment wins", () => {
    const seen: string[] = [];
    const { env, args, file } = cliEnvironment(
      ["admin", "reset-password"],
      { CHIRP_PORT: "8080" },
      (p) => p === DEFAULT_ENV_FILE,
      (p) => (seen.push(p), FILE),
    );
    expect(file).toBe(DEFAULT_ENV_FILE);
    expect(seen).toEqual([DEFAULT_ENV_FILE]);
    expect(args).toEqual(["admin", "reset-password"]);
    expect(env.CHIRP_DATA_DIR).toBe("/srv/chirp-data");
    expect(env.CHIRP_PORT).toBe("8080");
    const config = loadConfig(env);
    expect(config.dataDir).toBe("/srv/chirp-data");
    expect(config.apiKeyFile).toBe("/srv/chirp-data/key file");
  });

  it("--env-file beats CHIRP_ENV_FILE beats the default; nothing found = process env only", () => {
    const read = (p: string) => `CHIRP_DATA_DIR=${p}\n`;
    const exists = () => true;
    expect(cliEnvironment(["key", "show", "--env-file", "/a.env"], { CHIRP_ENV_FILE: "/b.env" }, exists, read)).toMatchObject({
      file: "/a.env",
      args: ["key", "show"],
      env: { CHIRP_DATA_DIR: "/a.env" },
    });
    expect(cliEnvironment(["key", "show"], { CHIRP_ENV_FILE: "/b.env" }, exists, read).env.CHIRP_DATA_DIR).toBe("/b.env");
    const none = cliEnvironment(["key", "show"], { X: "1" }, () => false, read);
    expect(none).toEqual({ env: { X: "1" }, args: ["key", "show"], file: null });
    expect(() => cliEnvironment(["--env-file"], {}, exists, read)).toThrow(/needs a path/);
  });
});
