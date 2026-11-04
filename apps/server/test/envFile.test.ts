import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cliEnvironment, DEFAULT_ENV_FILE, parseEnvFile, removeEnvVar } from "../src/envFile.js";

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
      CHIRP_DEVICES: "/dev/sda   # trailing comment", // systemd keeps it: no inline comments
      CHIRP_EMPTY: "",
    });
  });

  it("follows systemd EnvironmentFile semantics", () => {
    const text = [
      "; semicolon comment",
      "# hash comment",
      "UNQUOTED=a b # not a comment",
      'DQ="say \\"hi\\" \\\\ back\\nslash"',
      "SQ='literal \\n and \\\\'",
      'AFTER="value" # dropped',
      "SPACED = padded value  ",
      "CONT=one\\",
      "  two",
      'MULTI="line one',
      'line two"',
      "export EXPORTED=yes",
    ].join("\n");
    expect(parseEnvFile(text)).toEqual({
      UNQUOTED: "a b # not a comment",
      DQ: 'say "hi" \\ back\nslash',
      SQ: "literal \\n and \\\\",
      AFTER: "value",
      SPACED: "padded value",
      CONT: "onetwo",
      MULTI: "line one\nline two",
      EXPORTED: "yes",
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

  it("removeEnvVar removes a key atomically (mode 0600) and preserves others", () => {
    const dir = mkdtempSync(join(tmpdir(), "chirp-env-test-"));
    const file = join(dir, "chirp.env");
    try {
      const content = [
        "# chirp.env",
        "CHIRP_PORT=80",
        "CHIRP_SETUP_TOKEN=secret_token_123",
        "CHIRP_HOST=0.0.0.0",
      ].join("\n");
      writeFileSync(file, content, { mode: 0o600 });

      expect(removeEnvVar(file, "CHIRP_SETUP_TOKEN")).toBe(true);
      const after = readFileSync(file, "utf8");
      expect(after).not.toContain("CHIRP_SETUP_TOKEN");
      expect(after).toContain("CHIRP_PORT=80");
      expect(after).toContain("CHIRP_HOST=0.0.0.0");
      expect(statSync(file).mode & 0o777).toBe(0o600);

      // Second removal returns false because key is already gone
      expect(removeEnvVar(file, "CHIRP_SETUP_TOKEN")).toBe(false);
      // Non-existent file returns false
      expect(removeEnvVar(join(dir, "missing.env"), "FOO")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
