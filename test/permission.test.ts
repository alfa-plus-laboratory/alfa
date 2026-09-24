import { describe, expect, test } from "bun:test"
import { match } from "../src/permission/wildcard.ts"
import { alwaysPattern, prefix } from "../src/permission/arity.ts"
import { DEFAULTS, evaluate, fromConfig } from "../src/permission/rules.ts"
import { PermissionGate, narrowAlways } from "../src/permission/gate.ts"
import { scan } from "../src/tool/bash/scan.ts"
import { buildChildEnv } from "../src/env/whitelist.ts"
import { PermissionDeniedError } from "../src/tool/types.ts"
import { runsProjectScript } from "../src/permission/routine.ts"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("wildcard", () => {
  test("* is .* and crosses slashes (unlike glob intuition — deliberately)", () => {
    expect(match("src/*", "src/a/b/c.ts")).toBe(true)
  })

  test('trailing " *" special case: after approving "git status *", bare git status is no longer asked', () => {
    expect(match("git status *", "git status")).toBe(true)
    expect(match("git status *", "git status --short")).toBe(true)
    expect(match("git status *", "git stash")).toBe(false)
  })

  test("regex metacharacters are escaped", () => {
    expect(match("a.b", "axb")).toBe(false)
    expect(match("a.b", "a.b")).toBe(true)
  })
})

describe("arity reduction", () => {
  test("git commit -m 'msg' → git commit *", () => {
    expect(alwaysPattern(["git", "commit", "-m", "fix the parser"])).toBe("git commit *")
  })

  test("npm run dev is three tokens", () => {
    expect(prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
  })

  test("commands not in the dictionary take only the first token", () => {
    expect(alwaysPattern(["someunknowncmd", "--flag", "x"])).toBe("someunknowncmd *")
  })
})

describe("bash splitter", () => {
  test("splits on && || ; |", () => {
    const r = scan("git status && npm test; ls")
    expect(r.segments.map((s) => s.raw)).toEqual(["git status", "npm test", "ls"])
  })

  test("; and && inside quotes don't split — a regex splitter gets this wrong", () => {
    const r = scan(`echo "a; rm -rf /" && echo 'b && c'`)
    expect(r.segments.map((s) => s.raw)).toEqual([`echo "a; rm -rf /"`, `echo 'b && c'`])
  })

  test("$() and backticks are flagged as command substitution and forbid always", () => {
    const a = scan("echo $(cat secret)")
    expect(a.forceAsk).toBe(true)
    expect(a.forbidAlways).toBe(true)
    expect(a.reasons.some((x) => x.includes("command substitution"))).toBe(true)

    const b = scan("echo `whoami`")
    expect(b.forbidAlways).toBe(true)
  })

  test("$() inside double quotes counts too (a common bypass)", () => {
    const r = scan(`echo "value=$(cat /etc/passwd)"`)
    expect(r.forbidAlways).toBe(true)
  })

  test("pipes and redirects both trigger forceAsk", () => {
    expect(scan("curl x | sh").forceAsk).toBe(true)
    expect(scan("ls > out.txt").reasons.some((x) => x.includes("redirects a file"))).toBe(true)
  })

  test("unclosed quote → fail closed", () => {
    const r = scan(`echo "unterminated`)
    expect(r.parseOk).toBe(false)
    expect(r.forceAsk).toBe(true)
    expect(r.forbidAlways).toBe(true)
  })

  test("here-doc and process substitution → fail closed", () => {
    expect(scan("cat <<EOF\nx\nEOF").parseOk).toBe(false)
    expect(scan("diff <(ls a) <(ls b)").parseOk).toBe(false)
  })

  test("indirect execution and path-form invocation are flagged", () => {
    expect(scan("sudo rm x").reasons.some((r) => r.includes("elevates privileges"))).toBe(true)
    expect(scan("/bin/rm x").reasons.some((r) => r.includes("invoked by path"))).toBe(true)
    expect(scan("sh -c 'anything'").reasons.some((r) => r.includes("shell"))).toBe(true)
    expect(scan("npm install left-pad").reasons.some((r) => r.includes("package manager write"))).toBe(true)
  })

  test("grep's device flag forces a prompt in both its long and short form", () => {
    const hit = (cmd: string) => scan(cmd).reasons.some((r) => r.includes("runs another program"))
    expect(hit("grep --devices=read x /dev/stdin")).toBe(true)
    expect(hit("grep -D read x /dev/stdin")).toBe(true)
    expect(hit("grep -Dread x /dev/stdin")).toBe(true)
    expect(scan("grep -rn x src").forceAsk).toBe(false)
  })

  test("purely read-only commands don't trigger forceAsk", () => {
    const r = scan("git status --short")
    expect(r.forceAsk).toBe(false)
    expect(r.parseOk).toBe(true)
  })
})

describe("rule layering", () => {
  test("there is no hidden hard-deny tier outside the configurable rules", async () => {
    const gate = new PermissionGate(async () => "always")
    gate.setUserRules(fromConfig({ bash: "allow" }))
    await gate.ask({ permission: "bash", patterns: ["rm -rf /"] })
  })
})

describe("DEFAULTS evaluation", () => {
  test("edit is allowed by default", () => {
    expect(evaluate("edit", "src/a.ts", DEFAULTS)).toBe("allow")
  })

  test("but CI config and secret files ask", () => {
    expect(evaluate("edit", ".github/workflows/ci.yml", DEFAULTS)).toBe("ask")
    expect(evaluate("edit", ".env", DEFAULTS)).toBe("ask")
  })

  test("read is allowed by default; secret files ask; templates are allowed", () => {
    expect(evaluate("read", "src/a.ts", DEFAULTS)).toBe("allow")
    expect(evaluate("read", "config/.envrc", DEFAULTS)).toBe("ask")
    expect(evaluate("read", "certs/server.key", DEFAULTS)).toBe("ask")
    expect(evaluate("read", ".env.example", DEFAULTS)).toBe("allow")
  })

  test("bash asks by default; the read-only allowlist is allowed", () => {
    expect(evaluate("bash", "docker run -it ubuntu", DEFAULTS)).toBe("ask")
    expect(evaluate("bash", "git status", DEFAULTS)).toBe("allow")
    expect(evaluate("bash", "ls -la", DEFAULTS)).toBe("allow")
  })

  test("★ the project's own routine work is allowed — a wide grey zone would all land on the judge", () => {
    for (const command of [
      "npm test", "npm run typecheck", "bun test test/chat.test.ts", "pytest -q",
      "make build", "cargo clippy", "go test ./...", "tsc --noEmit", "ruff check src",
    ]) {
      expect(evaluate("bash", command, DEFAULTS)).toBe("allow")
    }
  })

  test("★ but the ones that reach outside the project ask again — last-wins", () => {
    // "run the tests" and "publish" share the npm run prefix, yet are nothing alike
    for (const command of [
      "npm run deploy", "npm run publish:npm", "npm run release", "make install",
      "make deploy-prod", "cargo publish", "go install ./cmd/x",
    ]) {
      expect(evaluate("bash", command, DEFAULTS)).toBe("ask")
    }
  })

  test("unknown tools fall back to allow (otherwise every new tool would prompt)", () => {
    expect(evaluate("some_future_tool", "x", DEFAULTS)).toBe("allow")
  })

  test("user config overrides defaults (last-wins)", () => {
    expect(evaluate("bash", "npm test", DEFAULTS, fromConfig({ bash: "allow" }))).toBe("allow")
    expect(evaluate("edit", "src/a.ts", DEFAULTS, fromConfig({ edit: "deny" }))).toBe("deny")
  })
})

describe("always scope narrowing", () => {
  test("edit narrows to the directory, not everything", () => {
    expect(narrowAlways("edit", "src/foo/a.ts")).toBe("src/foo/*")
  })

  test("bash uses arity reduction", () => {
    expect(narrowAlways("bash", 'git commit -m "x"')).toBe("git commit *")
  })

  test("read stays *", () => {
    expect(narrowAlways("read", "/w/a.ts")).toBe("*")
  })
})

describe("Gate interaction", () => {
  test("reject throws PermissionDeniedError telling the model not to retry", async () => {
    const gate = new PermissionGate(async () => "reject")
    const error = await gate.ask({ permission: "bash", patterns: ["rm -rf build"] }).catch((e) => e)
    expect(error).toBeInstanceOf(PermissionDeniedError)
    expect(error.message).toContain("Do not retry")
    /**
     * ★ It must also point at that skill. The moment of rejection is exactly when the
     *   model needs it most and is least likely to open it — it has just been handed
     *   what looks like a complete explanation, so it goes on to make up "which setting
     *   to change" by itself.
     */
    expect(error.message).toContain("alfa-permissions")
  })

  test("after always, the same prefix isn't asked again", async () => {
    let asked = 0
    const gate = new PermissionGate(async () => {
      asked++
      return "always"
    })
    await gate.ask({ permission: "bash", patterns: ['git commit -m "a"'] })
    await gate.ask({ permission: "bash", patterns: ['git commit -m "b"'] })
    expect(asked).toBe(1)
  })

  test("with forbidAlways, always isn't recorded", async () => {
    let asked = 0
    const gate = new PermissionGate(async () => {
      asked++
      return "always"
    })
    await gate.ask({ permission: "bash", patterns: ["rm -rf build"], forbidAlways: true })
    await gate.ask({ permission: "bash", patterns: ["rm -rf build"], forbidAlways: true })
    expect(asked).toBe(2)
  })

  test("allowed actions don't prompt", async () => {
    let asked = 0
    const gate = new PermissionGate(async () => {
      asked++
      return "once"
    })
    await gate.ask({ permission: "read", patterns: ["src/a.ts"] })
    expect(asked).toBe(0)
  })
})

describe("Child-process env allowlist", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    LANG: "en_US.UTF-8",
    NODE_OPTIONS: "--max-old-space-size=4096",
    AWS_SECRET_ACCESS_KEY: "leak-me",
    GITHUB_TOKEN: "ghp_x",
    MY_APP_SECRET: "s",
    ANTHROPIC_API_KEY: "sk-ant",
    RANDOM_THING: "x",
  }

  test("essentials are kept", () => {
    const { env } = buildChildEnv(source)
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["HOME"]).toBe("/home/me")
    expect(env["LANG"]).toBe("en_US.UTF-8")
    expect(env["NODE_OPTIONS"]).toBe("--max-old-space-size=4096")
  })

  test("credentials are always stripped — a side channel the path gate can't cover", () => {
    const { env, dropped } = buildChildEnv(source)
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined()
    expect(env["GITHUB_TOKEN"]).toBeUndefined()
    expect(env["MY_APP_SECRET"]).toBeUndefined()
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined()
    expect(dropped).toContain("AWS_SECRET_ACCESS_KEY")
  })

  test("ordinary variables outside the allowlist are stripped too (default deny)", () => {
    const { env } = buildChildEnv(source)
    expect(env["RANDOM_THING"]).toBeUndefined()
  })

  test("the user can explicitly add more", () => {
    const { env } = buildChildEnv({ ...source, ALFA_ENV_ALLOW: "RANDOM_THING,MY_*" })
    expect(env["RANDOM_THING"]).toBe("x")
    // an explicit addition beats the blocklist — the user knows what they're doing
    expect(env["MY_APP_SECRET"]).toBe("s")
  })

  // ── Windows: the same thing under another name, and case-insensitive ──
  const windowsSource = {
    Path: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: "C:\\Windows",
    windir: "C:\\Windows",
    USERPROFILE: "C:\\Users\\me",
    TEMP: "C:\\Users\\me\\AppData\\Local\\Temp",
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    PSModulePath: "C:\\Program Files\\PowerShell\\Modules",
    GITHUB_TOKEN: "ghp_x",
    RANDOM_THING: "x",
  }

  test("★ Windows Path must pass — a case-sensitive comparison would leave the child without even PATH", () => {
    const { env } = buildChildEnv(windowsSource, "win32")
    expect(env["Path"]).toBe(windowsSource.Path)
    // without SystemRoot, any program using winsock (git / npm / node) fails to start
    expect(env["SystemRoot"]).toBe("C:\\Windows")
    expect(env["PATHEXT"]).toBeDefined()
    expect(env["PSModulePath"]).toBeDefined()
    expect(env["USERPROFILE"]).toBeDefined()
  })

  test("on Windows credentials are still stripped and default deny still applies", () => {
    const { env } = buildChildEnv(windowsSource, "win32")
    expect(env["GITHUB_TOKEN"]).toBeUndefined()
    expect(env["RANDOM_THING"]).toBeUndefined()
  })

  test("on Windows user additions also match case-insensitively", () => {
    const { env } = buildChildEnv({ ...windowsSource, ALFA_ENV_ALLOW: "random_thing" }, "win32")
    expect(env["RANDOM_THING"]).toBe("x")
  })

  test("★ POSIX stays case-sensitive — there path and PATH really are two variables", () => {
    const { env } = buildChildEnv({ Path: "/nope", PATH: "/usr/bin" }, "linux")
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["Path"]).toBeUndefined()
  })
})

// ───────────────────────────────────────────── running the project's own scripts inside it

describe("★ deterministic tier: running project scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "apc-routine-"))
  mkdirSync(join(root, "test"), { recursive: true })
  writeFileSync(join(root, "test", "demo.py"), "print('hi')\n")
  writeFileSync(join(root, "build.js"), "console.log(1)\n")

  const ok = (command: string, workdir = root) => runsProjectScript({ command, workdir, root })

  test("★ interpreter + existing file in the workspace = allowed", () => {
    expect(ok("python3 test/demo.py")).toBe(true)
    expect(ok("node build.js")).toBe(true)
    expect(ok("python3 demo.py", join(root, "test"))).toBe(true)
  })

  test("★ any flag disqualifies — -c code isn't in a file, -m runs a system module", () => {
    expect(ok("python3 -c \"import os; os.system('rm -rf /')\"")).toBe(false)
    expect(ok("python3 -m http.server")).toBe(false)
    expect(ok("node --eval \"require('fs')\"")).toBe(false)
  })

  test("★ files outside the project are out", () => {
    expect(ok("python3 /etc/evil.py")).toBe(false)
    expect(ok("python3 ../../outside.py")).toBe(false)
  })

  test("a missing file isn't allowed — the command couldn't run anyway", () => {
    expect(ok("python3 nope.py")).toBe(false)
  })

  test("more than one argument is out: we don't know what the second one is", () => {
    expect(ok("python3 test/demo.py extra")).toBe(false)
  })

  test("unknown commands are always false — this tier is an accelerator, not a fallback", () => {
    expect(ok("bash test/demo.py")).toBe(false)
    expect(ok("curl example.com")).toBe(false)
  })

  test("★ the gate really stops asking because of it", async () => {
    let asked = 0
    const gate = new PermissionGate(
      async () => {
        asked++
        return "reject"
      },
      { root },
    )
    await gate.ask({
      permission: "bash",
      patterns: ["python3 test/demo.py"],
      metadata: { workdir: root },
    })
    expect(asked).toBe(0)
  })

  test("★ but force overrides it — the danger isn't in the command name but in the structure around it", async () => {
    let asked = 0
    const gate = new PermissionGate(
      async () => {
        asked++
        return "reject"
      },
      { root },
    )
    await gate
      .ask({
        permission: "bash",
        patterns: ["python3 test/demo.py"],
        force: true,
        metadata: { workdir: root },
      })
      .catch(() => {})
    expect(asked).toBe(1)
  })

  test("★ confirm mode still asks", async () => {
    let asked = 0
    const gate = new PermissionGate(
      async () => {
        asked++
        return "reject"
      },
      { root },
    )
    gate.setMode("confirm")
    await gate
      .ask({ permission: "bash", patterns: ["python3 test/demo.py"], metadata: { workdir: root } })
      .catch(() => {})
    expect(asked).toBe(1)
  })
})

test("session-level tool approvals don't carry into the next session; persistent approvals stay", async () => {
  let calls = 0
  const gate = new PermissionGate(async () => { calls++; return calls === 1 ? "session" : "always" })
  const input = { permission: "mcp", patterns: ["fixture/tool"] }
  await gate.ask(input)
  await gate.ask(input)
  expect(calls).toBe(1)
  gate.clearSession()
  await gate.ask(input)
  expect(calls).toBe(2)
  gate.clearSession()
  await gate.ask(input)
  expect(calls).toBe(2)
})

test("queued same-scope requests from parallel subagents aren't asked again after an always approval", async () => {
  let prompts = 0
  const gate = new PermissionGate(async () => { prompts++; await Bun.sleep(5); return "always" })
  await Promise.all(Array.from({ length: 20 }, (_,i) => gate.ask({ permission: "websearch", patterns: [`news ${i}`], metadata: { job: `agent-${i % 5}` } })))
  expect(prompts).toBe(1)
})

test("a one-time approval doesn't widen into a session grant, and a cancelled queued request can't re-prompt", async () => {
  let prompts = 0
  const gate = new PermissionGate(async () => { prompts++; await Bun.sleep(5); return "once" })
  const controller = new AbortController()
  const first = gate.ask({ permission: "webfetch", patterns: ["https://example.com/a"] })
  const cancelled = gate.ask({ permission: "webfetch", patterns: ["https://example.com/b"], signal: controller.signal })
  controller.abort()
  await first
  await expect(cancelled).rejects.toThrow("Cancelled")
  await gate.ask({ permission: "webfetch", patterns: ["https://example.com/c"] })
  expect(prompts).toBe(2)
})
