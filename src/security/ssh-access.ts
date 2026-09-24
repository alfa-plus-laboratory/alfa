/**
 * SSH grants are keyed by the raw host alias and remembered only for the current session,
 * never written to disk; auto allows directly but records no grant, so switching back to
 * default mode cannot inherit invisible grants.
 * ★ The grant is re-checked after queueing, so concurrent calls cannot pop a prompt that
 * was computed before the first approval several times over.
 * Revoking / switching session bumps the version, so a pending approval cannot resurrect
 * an old grant; calls already running are interrupted by the host.
 */
import type { PromptFn, PromptRequest } from "../permission/gate.ts"
import type { AskDecision } from "../tool/types.ts"

export class SshHostAccess {
  private hosts = new Set<string>()
  private epoch = 0
  private queue: Promise<unknown> = Promise.resolve()
  list(): string[] { return [...this.hosts].sort() }
  revoke(host?: string): void {
    this.epoch++
    if (host === undefined) this.hosts.clear()
    else this.hosts.delete(host)
  }
  authorize(request: PromptRequest, prompt: PromptFn, auto: () => boolean = () => false): Promise<AskDecision> {
    const epoch = this.epoch
    const pending = this.queue.then(async (): Promise<AskDecision> => {
      if (request.signal?.aborted || epoch !== this.epoch) return "reject"
      const host = request.patterns[0]
      if (!host || request.patterns.length !== 1) return "reject"
      if (auto() || this.hosts.has(host)) return "once"
      const decision = await prompt(request)
      if (request.signal?.aborted || epoch !== this.epoch) return "reject"
      if (decision === "session") this.hosts.add(host)
      return decision === "always" ? "reject" : decision
    })
    this.queue = pending.catch(() => {})
    return pending
  }
}
