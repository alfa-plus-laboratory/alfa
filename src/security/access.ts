/**
 * auto reads live from the host and allows directly; it never quietly turns access into a
 * persistent grant.
 * The working root is a starting point, not a permanent wall. ★ A file approval grants
 * only that exact file; a directory approval must state its recursive scope explicitly.
 * The real path goes into both the authorization prompt and the ledger, so a symlink
 * cannot widen a one-file grant into some other directory.
 * Shell and file tools share the session temp directory; the real path is still checked
 * first, so a symlink cannot use it to escape.
 * Revoking bumps the epoch, so a pending approval cannot resurrect a revoked grant either.
 * Processes already running are terminated by the host.
 *
 * ── auto and the two boundaries it keeps (they follow Claude Code's auto mode) ──
 * · The OS sandbox is independent of the permission mode. auto used to switch it off,
 *   which removed the one boundary that holds even when the classifier is fooled or an
 *   approved command does more than its name says. A user who turned the sandbox on
 *   keeps it in auto; the shell then stays inside the workspace and /access grants.
 * · The first file-tool read outside the workspace asks once whether auto may keep
 *   reading outside it. The answer can be remembered (config `autoOutsideReads`).
 *   Without it, auto read anything the account could read, and nobody saw the moment the
 *   agent left the project.
 * Writes outside the workspace aren't asked here: in auto they go to the classifier as
 * edits outside the workspace (permission/auto/fastpath.ts).
 */
import { tmpdir } from "node:os"
import { configDir, dataDir } from "../util/xdg.ts"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { canonicalPath, within } from "../fs/guard.ts"
import { ensureDirSync } from "../fs/dir.ts"
import { PermissionDeniedError } from "../tool/types.ts"
import type { PromptFn } from "../permission/gate.ts"
import { uiText } from "../i18n/index.ts"

/** Where "auto may read outside the workspace" is remembered; wired to config by the host */
export interface OutsideReads {
  allowed(): boolean
  remember(): void
}

export interface Grant { path: string; mode: "read" | "write"; directory: boolean; persistent: boolean }
export class AccessManager {
  /** The saved preference. It applies in every permission mode (see the file header) */
  sandboxEnabled = false
  get unrestricted(): boolean { return this.auto() }
  get sandboxActive(): boolean { return this.sandboxEnabled }
  private grants: Grant[] = []
  private epoch = 0
  private scratchPath?: string
  /** Allowed for this session by a "session" answer; see outsideRead */
  private outsideAllowed = false
  private outsideAsking?: Promise<void>
  scratch(): string { return this.scratchPath ??= canonicalPath(mkdtempSync(join(tmpdir(), "alfa-shell-"))) }
  dispose(): void { if (this.scratchPath) rmSync(this.scratchPath, { recursive: true, force: true }) }
  constructor(readonly root: string, private prompt: PromptFn, private file?: string, private auto: () => boolean = () => false, private outside?: OutsideReads) {
    this.root = canonicalPath(root)
    if (file && existsSync(file)) {
      const entries: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(entries)) throw new Error(`Invalid access grants: ${file}`)
      for (const entry of entries) {
        if (entry && typeof entry.path === "string" && ["read", "write"].includes(entry.mode) && typeof entry.directory === "boolean") {
          this.grants.push({ path: canonicalPath(entry.path), mode: entry.mode, directory: entry.directory, persistent: true })
        }
      }
    }
  }
  clearSession(): void { this.epoch++; this.grants = this.grants.filter(g => g.persistent) }
  list(): Grant[] { return this.grants.map(g => ({ ...g })) }
  add(path: string, mode: Grant["mode"], persistent = false, directory = true): Grant {
    const real = canonicalPath(path)
    this.check(real, mode)
    if (directory && (!existsSync(real) || !statSync(real).isDirectory())) throw new Error(`Directory does not exist: ${real}`)
    const grant = { path: real, mode, directory, persistent }
    this.grants = this.grants.filter(g => !(g.path === real && g.mode === mode))
    this.grants.push(grant)
    this.save()
    return grant
  }
  revoke(path?: string): void {
    this.epoch++
    this.grants = path ? this.grants.filter(g => g.path !== canonicalPath(path)) : []
    this.save()
  }
  private save(): void {
    if (!this.file) return
    ensureDirSync(dirname(this.file), { mode: 0o700 })
    const tmp = `${this.file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(this.grants.filter(g => g.persistent)), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
  private check(path: string, mode: Grant["mode"]): void {
    if (this.unrestricted) return
    if (within(path, canonicalPath(configDir())) || (within(path, canonicalPath(dataDir())) && !within(path, canonicalPath(join(dataDir(), "tool-output"))))) {
      throw new PermissionDeniedError(`path.${mode}`, path, "Alfa configuration, credentials and session database are protected.")
    }
    if (mode === "write" && ["/", "/etc", "/System", "/usr", "/bin", "/sbin", "/Library"].some(p => p === "/" ? path === p : within(path, canonicalPath(p)))) {
      throw new PermissionDeniedError("path.write", path, `System path is protected: ${path}`)
    }
  }
  private inScope(path: string, mode: Grant["mode"]): boolean {
    if (this.scratchPath && within(path, this.scratchPath)) return true
    return within(path, this.root) || this.grants.some(g => (g.mode === "write" || mode === "read") && (g.directory ? within(path, g.path) : g.path === path))
  }
  /**
   * auto's one question about leaving the workspace. once = this read; session = every
   * outside read until alfa exits; always = remembered in config; reject = this read is
   * refused and the next one asks again. Parallel reads wait for the one question in
   * flight instead of each opening a box.
   */
  private async outsideRead(path: string, signal?: AbortSignal, owner?: string): Promise<void> {
    while (this.outsideAsking) await this.outsideAsking.catch(() => {})
    if (this.outsideAllowed || this.outside?.allowed()) return
    const asking = (async () => {
      const decision = await this.prompt({
        permission: "path.read", patterns: [path], alwaysPatterns: [path], forbidAlways: false, signal,
        reasons: [uiText(
          "auto mode wants to read outside the workspace for the first time. Session or always lets auto keep reading outside it; once allows only this file.",
          "auto 模式第一次要读取工作区外的文件。选「本会话」或「始终」后，auto 可以继续读取工作区外的文件；「仅此一次」只允许这个文件。",
          "auto モードが初めてワークスペース外を読み取ろうとしています。セッションまたは常に許可すると以後も読み取りを続けます。1 回だけはこのファイルのみです。",
        )],
        metadata: { ...(owner ? { job: owner } : {}), filePath: path },
      })
      if (signal?.aborted || decision === "reject") {
        throw new PermissionDeniedError("path.read", path, "The user declined this read outside the workspace. Work inside the workspace, or ask the user for what you need.")
      }
      if (decision === "session" || decision === "always") this.outsideAllowed = true
      if (decision === "always") this.outside?.remember()
    })()
    this.outsideAsking = asking
    try { await asking } finally { if (this.outsideAsking === asking) this.outsideAsking = undefined }
  }
  async authorize(target: string, cwd: string, mode: Grant["mode"], signal?: AbortSignal, owner?: string): Promise<string> {
    const path = canonicalPath(resolve(cwd, target))
    if (signal?.aborted) throw new PermissionDeniedError(`path.${mode}`, path, "Cancelled")
    if (this.unrestricted) {
      // alfa's own overflow logs: bash tells the model to read them, so asking would be
      // a question about alfa's plumbing, not about leaving the project
      const ownOutput = within(path, canonicalPath(join(dataDir(), "tool-output")))
      if (mode === "read" && !ownOutput && !this.inScope(path, mode)) await this.outsideRead(path, signal, owner)
      return path
    }
    this.check(path, mode)
    if (this.inScope(path, mode)) return path
    const epoch = this.epoch
    const decision = await this.prompt({
      permission: `path.${mode}`, patterns: [path], alwaysPatterns: [path], forbidAlways: false, signal,
      reasons: ["This authorization changes filesystem scope, independently of tool approval."],
      metadata: { ...(owner ? { job: owner } : {}), filePath: path, directory: existsSync(path) && statSync(path).isDirectory(), reasons: [existsSync(path) && statSync(path).isDirectory() ? "Outside initial workspace. Recursive directory access to this resolved directory; /access lists and revokes retained grants." : "Outside initial workspace. Exact file only; no parent directory access is granted."] },
    })
    if (signal?.aborted || epoch !== this.epoch || decision === "reject") throw new PermissionDeniedError(`path.${mode}`, path)
    if (decision === "session" || decision === "always") this.add(path, mode, decision === "always", existsSync(path) && statSync(path).isDirectory())
    return path
  }
}
