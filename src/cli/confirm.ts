/**
 * The permission confirmation UI.
 *
 * ── This is the one place in the whole program where "the user presses before they've
 *    had a chance to read" costs the most ──
 * So there are three hard rules:
 *
 * 1. **No answer means no execution.** Esc, Ctrl-C and Ctrl-D reject. Missing interactive
 *    input throws an explicit unavailable error: it is not a decision the user made.
 *    Enter is the exception: at the user's request it means "allow once" — that's an
 *    **explicit statement**, not "no statement counts as consent"; when nobody's there
 *    (pipes, CI) no enter ever comes in, and that path still rejects everything.
 *
 * 2. ★ The approval reason, the operation and the keys share one fixed card; the full text
 *    can be expanded and scrolled. The draft stays visible and isn't cleared; an existing
 *    draft keeps the editing focus first, and only Tab switches to the approval, so a y
 *    being typed isn't mistaken for consent.
 *
 * 3. **With forbidAlways, the always option isn't shown.** Not shown-then-refused — when
 *    the sentence splitter is unsure, the user shouldn't even be given the idea of "don't
 *    ask again". SSH can separately allowSession; showing s doesn't mean opening up the
 *    persistent a. Key handling must use the same test as the options line.
 *
 * Approval authorizes the operation, not its filesystem reach. Both card views keep
 * this distinction visible; otherwise an approved command's OS denial looks like a
 * broken approval and invites unnecessarily disabling isolation.
 */
import { PermissionDeniedError, type AskDecision } from "../tool/types.ts"
import type { PromptRequest } from "../permission/gate.ts"
import type { Keyboard } from "./keyboard.ts"
import type { Key } from "./keys.ts"
import { Editor, renderBox } from "./editor.ts"
import type { LiveCursor } from "./live.ts"
import { terminalText } from "./terminal-text.ts"
import { t, uiText } from "../i18n/index.ts"
import { joinToWidth, wrapToWidth } from "./width.ts"
import { truncate } from "./render.ts"
import { theme } from "./theme.ts"

/**
 * A structural type spares tests a real live area. Only suspend/resume are required; the
 * optional members decide how the prompt is shown: overlay + refresh get the fixed card
 * (confirmCard), write + set keep the request inside the live area, and with neither the
 * area is suspended and the request printed plainly.
 */
export interface Suspendable {
  suspend(): void
  resume(): void
  write?(text: string): void
  set?(lines: string[]): void
  clear?(): void
  width?: number
  active?: boolean
  overlay?(render: (width: number, height: number) => { lines: string[]; cursor?: LiveCursor }): () => void
  refresh?(): void
}

export interface ApprovalDraft { editor: Editor; restore(): void }

export interface ConfirmDeps {
  draft?: ApprovalDraft
  /**
   * Commit the record through the main renderer, closing out any unfinished markdown first,
   * so background body text and the approval don't bleed into each other's lines.
   */
  print?(text: string): void
  /** The owner of stdin. Absent or unusable input denies execution with an unavailable-approval error. */
  keyboard?: Keyboard
  /** Defaults to process.stdout */
  output?: NodeJS.WriteStream
  /** The bottom live area, which gives up the screen while the question is asked */
  region?: Suspendable
  /** On interrupt, return reject immediately */
  signal?: AbortSignal
}

function approvalUnavailable(request: Pick<PromptRequest, "permission" | "patterns">): PermissionDeniedError {
  return new PermissionDeniedError(request.permission, request.patterns[0] ?? "", `Approval unavailable for ${request.permission}: no interactive input is available in this run. The operation was not executed. This is not a user rejection. Do not retry unchanged or bypass the permission gate; report that approval requires an interactive run.`)
}

/** Returns an approval decision; throws PermissionDeniedError when input is unavailable. */
export async function confirm(request: PromptRequest, deps: ConfirmDeps = {}): Promise<AskDecision> {
  const output = deps.output ?? process.stdout
  if (deps.keyboard?.usable && deps.region?.active !== false && deps.region?.overlay && deps.region.refresh) return confirmCard(request, deps)

  const live = deps.region?.write && deps.region?.set ? deps.region : undefined
  if (!live) deps.region?.suspend()
  try {
    if (!deps.keyboard?.usable) {
      output.write(renderRequest(request))
      output.write(theme.red(uiText("  no interactive input — approval unavailable; operation not executed\n\n", "  无交互输入 — 无法获取批准；操作未执行\n\n", "  対話入力なし — 承認を取得できないため未実行\n\n")))
      throw approvalUnavailable(request)
    }
    const emit = (text: string) => deps.print ? deps.print(text) : live!.write!(text)
    const sink = live ? { write: (text: string) => { if (text.trim()) emit("\n" + text + "\n"); return true } } as NodeJS.WriteStream : output
    // Take the keyboard first, then show the prompt. Background replies can still scroll,
    // but can't replace the approval keys at the bottom.
    const answer = readKey(deps.keyboard, sink, request, deps.signal)
    if (live) {
      emit("\n" + requestLines(request).map(line => "  " + line).join("\n") + "\n")
      live.set!([`${request.permission}${askingJob(request) ? ` · ${askingJob(request)}` : ""}`, ...wrapToWidth(request.patterns[0] ?? "", live.width ?? 80).slice(0, 2), ...wrapToWidth(optionsLine(request), live.width ?? 80)])
    } else output.write(renderRequest(request))
    const decision = await answer
    sink.write("\n")
    return decision
  } finally {
    if (live) live.clear?.()
    else deps.region?.resume()
  }
}

/**
 * The fixed card and the draft share the live area. The log still scrolls, but can't get
 * in between the command and the options.
 *
 * ── Why a cursor list and not a line of `[y] [s] [a] [n]` ──
 * The card used to be the scrollback prompt's options line pasted into the live area: a
 * yellow reason, the command, a help row and `[⏎ y] allow once  [s] …  [esc n] reject`,
 * all flush left and all the same weight. Which part was the operation and which part
 * was the question took reading twice. It now has the shape Claude Code's prompt taught
 * people: a rule, a header, the operation set off in bold, then "proceed?" with numbered
 * choices under a `❯` cursor.
 *
 * ★ The cursor starts on "allow once", so ⏎ still means exactly what it did — the key the
 *   IME can't eat still gets you through (see optionsLine). Moving the cursor first is
 *   the only way ⏎ can mean anything else, and that is a choice made on screen.
 * ⚠ `choices` is the one list both the rows and the keys read. Rule 3 in the header
 *   (with forbidAlways, no always) holds because a hidden row has no digit and no letter.
 */
async function confirmCard(request: PromptRequest, deps: ConfirmDeps): Promise<AskDecision> {
  const region = deps.region!, keyboard = deps.keyboard!
  const editor = deps.draft?.editor
  let editing = !!editor && !editor.empty
  let expanded = false, scroll = 0, cursor = 0, ime = false
  let release: (() => void) | undefined, close: (() => void) | undefined
  let settled = false
  const signal = deps.signal ?? request.signal
  const label = (en: string, zh: string, ja: string) => uiText(en, zh, ja)
  const repaint = () => region.refresh?.()
  const choices = approvalChoices(request)
  let onAbort = () => {}
  try {
    const answer = new Promise<AskDecision>((resolve, reject) => {
      const finish = (value: AskDecision) => {
        if (settled) return
        settled = true
        release?.()
        resolve(value)
      }
      onAbort = () => finish("reject")
      release = keyboard.push(key => {
        if (key.name === "escape" || key.ctrl && ["c", "d"].includes(key.name)) return finish("reject")
        if (key.name === "tab" && editor) { editing = !editing; repaint(); return }
        if (editing && editor) {
          // While the approval is pending, Enter neither submits the draft nor approves the
          // operation; other editing keys still act on the original Editor.
          if (key.name !== "enter") editor.handle(key, Math.max(1, (region.width ?? 80) - 2))
          repaint(); return
        }
        if (!key.ctrl && !key.meta && key.name === "d") { expanded = !expanded; scroll = 0; repaint(); return }
        // ↑↓ move the choice; in the details view there is nothing to choose that the
        // summary didn't show, and reading to the end is the point, so there they scroll
        if (key.name === "pageup" || key.name === "pagedown" || expanded && (key.name === "up" || key.name === "down")) {
          scroll = Math.max(0, scroll + (key.name === "up" ? -1 : key.name === "down" ? 1 : key.name === "pageup" ? -6 : 6)); repaint(); return
        }
        if (key.name === "up" || key.name === "down") {
          cursor = (cursor + (key.name === "up" ? choices.length - 1 : 1)) % choices.length
          repaint(); return
        }
        if (key.name === "enter") return finish(choices[cursor]!.decision)
        if (key.ctrl || key.meta || key.shift) return
        if (/^[1-9]$/.test(key.name)) {
          const choice = choices[Number(key.name) - 1]
          return choice ? finish(choice.decision) : undefined
        }
        const letter = choices.find(choice => choice.key === key.name)
        if (letter) return finish(letter.decision)
        // Say once why a key did nothing when it looks like the IME ate it; the card is
        // redrawn, so unlike the scrollback prompt this costs no lines
        if (!ime && looksLikeIme(key)) { ime = true; repaint() }
      })
      if (!keyboard.attached) { settled = true; release?.(); reject(approvalUnavailable(request)); return }
      if (signal?.aborted) return finish("reject")
      signal?.addEventListener("abort", onAbort, { once: true })
    })
    if (!settled) close = region.overlay!((width, height) => {
      const job = askingJob(request)
      const header = "  " + theme.yellow(theme.bold(label("⚠ Approve", "⚠ 需要确认", "⚠ 承認が必要")) + ` · ${request.permission}${job ? ` · ${terminalText(job)}` : ""}`)
      const metadata = request.metadata ?? {}
      const command = typeof metadata["command"] === "string" ? metadata["command"] : request.patterns.join("\n")
      const workdir = metadata["workdir"] ?? metadata["workdirLabel"]
      const boundary = approvalBoundary(request)
      // "confirm mode asks about everything" is not a finding about this command; only a
      // reason that is one keeps the warning colour
      const reason = request.cause === "mode" ? theme.muted(approvalReason(request)) : theme.yellow(approvalReason(request))
      const body = expanded ? requestLines(request) : [
        ...command.split("\n").map(line => theme.bold(line)),
        ...(typeof workdir === "string" ? [theme.muted(label("in ", "目录 ", "場所 ") + workdir)] : []),
        reason,
        ...(boundary ? [theme.muted(boundary)] : []),
      ]
      const wrapped = body.flatMap(line => wrapToWidth(terminalText(line), Math.max(1, width - 4)).map(piece => "    " + piece))
      const rows = choices.flatMap((choice, index) => {
        const active = !editing && index === cursor
        const lead = `  ${active ? theme.accent("❯") : " "} ${index + 1}. `
        // Reject is labelled with esc, not n: the key an IME can't swallow (see optionsLine)
        const text = (active ? theme.accent(choice.label) : choice.label) + theme.muted(` (${choice.decision === "reject" ? "esc" : choice.key})`)
        return wrapToWidth(text, Math.max(1, width - 7)).map((piece, at) => (at === 0 ? lead : "       ") + piece)
      })
      // An empty draft box only said "Draft preserved" about nothing; it shows when there
      // is a draft to keep or the user has switched to it
      const draft = editor && (editing || !editor.empty) && height >= 12 ? renderBox({ text: editor.text, cursor: editor.cursor, width, maxRows: Math.min(3, Math.max(1, height - 11)), framed: false, style: { border: theme.border, marker: theme.accent, placeholder: theme.muted }, placeholder: label("Draft preserved", "草稿保留", "下書きを保持") }) : undefined
      const keys = editing
        ? label("Editing draft · Tab to approve · Esc reject", "正在编辑草稿 · Tab 处理确认 · Esc 拒绝", "下書きを編集中 · Tab で承認へ · Esc 拒否").split(" · ")
        : [
          label("⏎ select", "⏎ 选择", "⏎ 選択"), label("↑↓ move", "↑↓ 移动", "↑↓ 移動"),
          `d ${expanded ? label("summary", "收起", "要約") : label("details", "详情", "詳細")}`,
          ...(editor ? [label("Tab draft", "Tab 草稿", "Tab 下書き")] : []),
          label("esc reject", "esc 拒绝", "esc 拒否"),
        ]
      const hint = [
        ...(ime && !editing ? wrapToWidth(t.promptImeHint, Math.max(1, width - 2)).map(line => "  " + theme.yellow(line)) : []),
        ...joinToWidth(keys, Math.max(1, width - 2)).map(line => "  " + theme.muted(line)),
      ]
      const ask = theme.bold("  " + label("Proceed?", "要执行吗？", "実行しますか？"))
      const fixed = 3 + 2 + rows.length + 1 + hint.length + (draft?.lines.length ?? 0)
      const room = Math.max(0, height - fixed)
      scroll = Math.min(scroll, Math.max(0, wrapped.length - Math.max(1, room)))
      const visible = wrapped.slice(scroll, scroll + room)
      if (scroll + room < wrapped.length && visible.length) visible[visible.length - 1] = theme.muted(label("    … more below · pgdn / d", "    … 下方还有内容 · pgdn / d", "    … 続きあり · pgdn / d"))
      const lines = [theme.border("─".repeat(Math.max(1, width))), header, "", ...visible, "", ask, ...rows, "", ...hint, ...(draft?.lines ?? [])]
      // On very narrow screens keep the action options first; the body can still be
      // expanded after enlarging the terminal.
      const clipped = lines.length > height ? lines.slice(-height) : lines
      return { lines: clipped, ...(editing && draft ? { cursor: { row: clipped.length - draft.lines.length + draft.cursor.row, col: draft.cursor.col } } : {}) }
    })
    const decision = await answer
    close?.(); close = undefined
    const word = choices.find(choice => choice.decision === decision)?.label ?? decision
    // Under the tool's `●` line, like its `↳`: the card is gone, and "what did I approve"
    // has to stay where it happened
    const mark = decision === "reject" ? theme.red("✗") : theme.green("✓")
    const receipt = `    ${mark} ${theme.muted(`${request.permission} · ${word}${request.callID ? ` · /detail ${request.callID}` : ""}`)}\n`
    if (deps.print) deps.print(receipt)
    else region.write?.("\n" + receipt)
    return decision
  } finally {
    signal?.removeEventListener("abort", onAbort)
    release?.(); close?.()
    deps.draft?.restore()
  }
}

/**
 * The card's choices, in order, with the letter each also answers to. Session and always
 * follow the same tests as the scrollback prompt's optionsLine.
 */
function approvalChoices(request: PromptRequest): Array<{ decision: AskDecision; label: string; key: string }> {
  const choices: Array<{ decision: AskDecision; label: string; key: string }> = [{ decision: "once", label: t.promptAllowOnce, key: "y" }]
  if (!request.forbidAlways || request.allowSession) {
    choices.push({ decision: "session", label: uiText("allow for this session", "本会话内都放行", "このセッション中は許可"), key: "s" })
  }
  if (!request.forbidAlways) {
    const scope = request.alwaysPatterns[0]
    const shown = scope ? ` · ${truncate(scope, SCOPE_WIDTH)}` : ""
    choices.push({ decision: "always", label: uiText(`always allow${shown}`, `以后不再问${shown}`, `以後は聞かない${shown}`), key: "a" })
  }
  choices.push({ decision: "reject", label: t.promptReject, key: "n" })
  return choices
}

export function approvalReason(request: PromptRequest): string {
  if (request.cause === "auto") return uiText(
    "auto paused: the classifier kept blocking actions, so this one is yours to decide. Approving resumes auto.",
    "auto 已暂停：分类器接连拦截操作，这一步交给你决定。批准后 auto 继续。",
    "auto 一時停止：分類器が続けてブロックしたため、この操作はあなたが判断します。承認すると auto を再開します。",
  ) + (request.reasons?.length ? " " + request.reasons.join("; ") : "")
  if (request.cause === "mode") return uiText("confirm mode: every gated operation needs approval; this is not a risk finding.", "confirm 模式：每次操作都要确认，并非判定这条命令危险。", "confirm モード：各操作を確認します。危険と判定されたわけではありません。")
  if (request.cause === "structure") return uiText("default mode: shell syntax requires confirmation.", "default 模式：命令结构触发确认。", "default モード：コマンド構造により確認が必要です。") + (request.reasons?.length ? " " + request.reasons.join("; ") : "")
  if (request.reasons?.length) return request.reasons.join("; ")
  return uiText("default mode: this operation has no automatic approval.", "default 模式：此操作未被规则自动放行。", "default モード：この操作は自動許可されていません。")
}

function approvalBoundary(request: PromptRequest): string | undefined {
  if (request.permission === "bash") return uiText(
    "Approval allows this operation; it does not grant paths or change the OS sandbox. /access manages path grants.",
    "确认只允许执行此操作，不会授予路径权限或改变 OS 沙箱。路径授权由 /access 管理。",
    "承認は操作を許可します。パス権限や OS サンドボックスは変更しません。パス権限は /access で管理します。",
  )
  return undefined
}

export function renderRequest(request: PromptRequest): string {
  return ["", ...requestLines(request).map((line) => "  " + line), "", "  " + optionsLine(request)].join("\n") + " "
}

/**
 * **Which subagent** is asking for this permission. Returns undefined when it's the main
 * agent's own request.
 *
 * ── Why a function, instead of reading metadata in two places ──
 * The fixed card and the full details share this one source, so the user can tell the
 * main conversation's requests from background ones. When one convention is used in two
 * places in opposite ways, it should have exactly one origin.
 */
export function askingJob(request: PromptRequest): string | undefined {
  const job = request.metadata?.["job"]
  return typeof job === "string" && job.length > 0 ? job : undefined
}

/**
 * The question itself, one item per line, **without** the options line or indentation.
 *
 * Split out because it has more than one home: the fixed card (confirmCard) draws it as
 * the expanded details **inside** the live area, wrapped and scrolled there — written to
 * stdout instead, it would land behind the live area's back and tear the frame (see
 * live.ts) — while the other paths print it into the scrollback next to the options line
 * (renderRequest). All of them sharing this one content is what prevents "the card and
 * the printed prompt asking different things".
 */
export function requestLines(request: PromptRequest): string[] {
  const lines: string[] = []
  lines.push(theme.yellow(theme.bold(`⚠ permission required: ${request.permission}`)))
  if (request.cause) lines.push(approvalReason(request))
  const boundary = approvalBoundary(request)
  if (boundary) lines.push(boundary)

  const metadata = request.metadata ?? {}
  // A permission requested by a background subagent. **Must be written first** — the user
  // is talking to the main agent at the time, and if a suddenly popped-up box doesn't say
  // who's asking, what they see is something they never told anyone to do
  // (see agent/subagent.ts)
  const job = askingJob(request)
  if (job) lines.push(theme.cyan(`asked by subagent ${job}`))
  const command = typeof metadata["command"] === "string" ? metadata["command"] : undefined
  const segments = Array.isArray(metadata["segments"]) ? (metadata["segments"] as unknown[]) : undefined

  if (command !== undefined) {
    // The full original text + each subcommand. Either one alone isn't enough:
    // original only → what's hidden in a long command is hard to see; subcommands only →
    // you can't see how they're chained.
    lines.push(theme.dim("command:"))
    for (const line of command.split("\n")) lines.push("  " + theme.bold(line))
    // The working directory is only present when it isn't the repo root (see bash.ts). The
    // same `rm -rf build` at the repo root and somewhere else are two different things,
    // and the command text itself doesn't show the difference
    const workdir = metadata["workdirLabel"]
    if (typeof workdir === "string" && workdir.length > 0) {
      lines.push(theme.dim("in: ") + theme.cyan(workdir))
    }
    if (segments && segments.length > 1) {
      lines.push(theme.dim(`runs ${segments.length} commands:`))
      for (const segment of segments) lines.push("  " + theme.cyan("• " + String(segment)))
    }
  } else {
    for (const pattern of request.patterns) lines.push("  " + theme.bold(pattern))
  }

  if (request.permission.startsWith("path.")) lines.push(`Resolved scope: ${metadata["directory"] ? "directory and descendants" : "exact file"}`)

  if (metadata["parseOk"] === false) {
    lines.push(theme.red(`! ${t.promptParseUnsure}`))
  }

  const reasons = request.reasons ?? []
  if (reasons.length > 0) {
    lines.push(theme.dim(uiText("Operation details:", "操作详情：", "操作の詳細：")))
    for (const reason of reasons) lines.push("  " + theme.yellow("• " + reason))
  }

  const preview = metadata["preview"]
  if (typeof preview === "string" && preview.length > 0) {
    lines.push("")
    for (const line of preview.split("\n")) lines.push(line)
  }
  return lines
}

/**
 * Max width of the scope shown after the always option. The whole options line is a single
 * line, and a long pattern would blow it apart
 */
const SCOPE_WIDTH = 28

export function optionsLine(request: PromptRequest): string {
  if (request.permission?.startsWith("path.")) return `[enter/y] ${t.promptAllowOnce}  [s] ${t.promptSession}  [a] ${t.promptAlways} (${request.alwaysPatterns[0]})  [esc/n] ${t.promptReject}`
  // ★ **Enter and esc are written before the letters**, and spelled out, not hinted at by
  // capitalization.
  //
  // This line used to be `[Y] allow once … [n] reject  esc`: the capitalized one = the one
  // enter picks, the common convention for terminal prompts. The problem is **a convention
  // only works for people who already know it**, and the person who most needs to know
  // "enter gets you through" is exactly the one who can't type `y` at all — with a CJK IME
  // on, the IME eats every letter key, and pressing y pops up the candidate window (see
  // the ⚠ in looksLikeIme). The only way out they can find on screen has to be **a key
  // the IME can't touch**, written as that key itself.
  //
  // ★ **Key names in brackets are not translated** (⏎ / y / a / n / esc) — they're things
  //   to press, and translated the user can't press them. Only the words after them are
  //   translated. See the i18n rule "key names are never translated"
  const parts = [theme.green(`[⏎ y] ${t.promptAllowOnce}`)]
  if (!request.forbidAlways || request.allowSession) parts.push(`[s] ${t.promptSession}`)
  if (!request.forbidAlways) {
    // Truncate the scope: it's a pattern that can be long, and when this line overflows,
    // what gets pushed off is "how to reject" on the right — exactly the half of this line
    // that can least be lost
    const scope = request.alwaysPatterns[0]
    parts.push(theme.cyan(`[a] ${t.promptAlways}${scope ? ` (${truncate(scope, SCOPE_WIDTH)})` : ""}`))
  }
  parts.push(theme.dim(`[esc n] ${t.promptReject}`))
  return parts.join("  ") + theme.dim("  › ")
}

/**
 * Whether this key press is "the IME committing text".
 *
 * ⚠ The test is **non-ASCII**, not "unrecognized key". A CJK character can't be typed
 *   directly on a keyboard — it can only be the result of an IME commit, which means none
 *   of the keys this person just pressed (most likely including a `y`) made it here. A
 *   mistyped `k`, on the other hand, is just a typo, and telling them "your IME is on"
 *   would be describing something that didn't happen.
 *
 * IME commits sometimes arrive as bracketed paste (the terminal sends the whole chunk at
 * once), so that path counts too.
 */
export function looksLikeIme(key: Key): boolean {
  const text = key.name === "paste" ? (key.text ?? "") : key.name
  // Tools like eslint will want to rewrite this as a Unicode property regex; don't —
  // what's wanted here is exactly "is any character outside ASCII", not "is it some
  // writing system"
  return [...text].some((char) => char.codePointAt(0)! > 0x7f)
}

/**
 * Read one key, no enter needed.
 *
 * The keyboard takeover must be released on **every** exit path, including throws and
 * interrupts — miss one and the input box underneath never gets key presses again; the
 * only fix is closing the window. So this uses the dispose returned by keyboard.push
 * rather than on/off-ing stdin itself.
 */
function readKey(
  keyboard: Keyboard,
  output: NodeJS.WriteStream,
  request: PromptRequest,
  signal?: AbortSignal,
): Promise<AskDecision> {
  const { forbidAlways, allowSession = false } = request
  return new Promise((resolve, reject) => {
    let settled = false
    let hinted = false
    let release: (() => void) | undefined

    const finish = (decision: AskDecision, echo: string) => {
      if (settled) return
      settled = true
      output.write(echo)
      signal?.removeEventListener("abort", onAbort)
      release?.()
      resolve(decision)
    }

    const onKey = (key: Key) => {
      if (key.ctrl && (key.name === "c" || key.name === "d")) return finish("reject", theme.dim("^C"))
      // Enter = allow once, the same rule as the fixed card (confirmCard) — the same key
      // meaning opposite things in the two prompts is the last thing this program should
      // have
      if (key.name === "enter") return finish("once", theme.green("y"))
      if (key.name === "escape") return finish("reject", theme.dim("n"))
      // Paste, function keys and modifier combos are all ignored — don't let a stray key
      // press decide the filesystem's fate.
      // ★ But the IME-commit path gets one line of explanation before being ignored; see
      // hint
      if (key.ctrl || key.meta || [...key.name].length !== 1) return hint(key)
      switch (key.name.toLowerCase()) {
        case "y":
          return finish("once", theme.green("y"))
        case "s":
          if (forbidAlways && !allowSession) return hint(key)
          return finish("session", theme.cyan("s"))
        case "a":
          // When the sentence splitter is unsure, that option isn't drawn at all. Give
          // **exactly the same response as a mistyped key** — a dedicated explanation would
          // tell the user "this key is useful in other situations", which is precisely the
          // idea this rule shouldn't give
          if (forbidAlways) return hint(key)
          return finish("always", theme.cyan("a"))
        case "n":
          return finish("reject", theme.dim("n"))
        default:
          return hint(key)
      }
    }

    /**
     * An unrecognized key press: say how to answer, then ignore it as usual.
     *
     * ★ Say it only once. This line is written into the scrollback, and an IME commit
     *   often sends several characters at once — one line per character and the user sees
     *   a screenful of spam, with the question itself pushed off the top
     */
    const hint = (key: Key) => {
      if (hinted) return
      hinted = true
      output.write("\n  " + theme.dim(looksLikeIme(key) ? t.promptImeHint : t.promptKeyHint) + "\n  ")
    }

    const onAbort = () => finish("reject", theme.dim("^C"))

    release = keyboard.push(onKey)
    // If raw mode isn't available, don't force it — line-by-line reading would take the
    // user's next line of input as the answer
    if (!keyboard.attached) {
      settled = true
      release?.()
      output.write(theme.red(`n (${t.promptNoKeyboard})`))
      reject(approvalUnavailable(request))
      return
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
