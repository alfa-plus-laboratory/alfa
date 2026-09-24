/**
 * Bun can start its CLI while JSC initialization traps before running any tests: macOS
 * keeps ICU timezone data outside /System. Exercise real Bun under Seatbelt so a missing
 * system-data read grant cannot masquerade as a model's failure to verify its changes.
 * All forbidden reads/writes use synthetic fixtures, never the host's actual credentials.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { AccessManager } from "../src/security/access.ts"
import { sandboxBackend, sandboxShell, seatbeltProfile } from "../src/security/sandbox.ts"
import { resolveShell } from "../src/env/shell.ts"
import { buildChildEnv } from "../src/env/whitelist.ts"

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

test.skipIf(sandboxBackend() !== "seatbelt")("Bun tests initialize with system timezone reads while external and credential data remain isolated", () => {
  const dir = mkdtempSync(join(tmpdir(), "alfa-bun-runtime-")), root = join(dir, "repo"), outside = join(dir, "outside")
  mkdirSync(root); mkdirSync(join(root, ".ssh"))
  const secret = join(root, ".ssh", "key"), envFile = join(root, ".env")
  writeFileSync(outside, "synthetic outside")
  writeFileSync(secret, "synthetic key")
  writeFileSync(envFile, "synthetic environment")
  writeFileSync(join(root, "runtime.test.ts"), `
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
test("runtime and locale initialize", () => expect(new Intl.DateTimeFormat("en", { timeZone: "UTC" }).format(new Date(0))).toBeTruthy());
test("synthetic protected fixtures stay unreadable and unwritable", () => {
  for (const path of ${JSON.stringify([outside, secret, envFile])}) {
    expect(() => readFileSync(path, "utf8")).toThrow();
    expect(() => writeFileSync(path, "changed")).toThrow();
  }
});
`)
  const access = new AccessManager(root, async () => "reject")
  access.sandboxEnabled = true
  try {
    const shell = sandboxShell(resolveShell(), access)
    const result = spawnSync(shell.file, shell.argsFor(`${quote(process.execPath)} test runtime.test.ts`), {
      cwd: root, env: { ...buildChildEnv(process.env).env, ...shell.env }, encoding: "utf8", timeout: 10_000,
    })
    expect({ status: result.status, signal: result.signal, error: result.error?.message }).toEqual({ status: 0, signal: null, error: undefined })
    expect(result.stderr).toContain("2 pass")
    expect(readFileSync(outside, "utf8")).toBe("synthetic outside")
    expect(readFileSync(secret, "utf8")).toBe("synthetic key")
    expect(readFileSync(envFile, "utf8")).toBe("synthetic environment")
    const profile = seatbeltProfile([])
    expect(profile).toContain('(subpath "/private/var/db/timezone")')
    expect(profile.split("\n").find(line => line.startsWith("(allow file-write*"))).not.toContain("timezone")
  } finally { access.dispose(); rmSync(dir, { recursive: true, force: true }) }
})
