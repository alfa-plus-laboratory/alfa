/**
 * The slash command table and completion.
 *
 * ── Why completion exists ──
 * However few commands there are, users don't know they exist unless they're written out.
 * Listing everything available the moment `/` is typed beats hiding a paragraph in help —
 * nobody reads that paragraph twice.
 *
 * ── Only a slash at the start of the line counts ──
 * The `/` in `src/cli/main.ts` is a path, not a command. So completion only appears when
 * **the whole input starts with `/`** and the cursor is at the end. The cost of a looser
 * test would be a box popping up over what you're typing whenever you type a path — far
 * more annoying than one missing completion.
 *
 * ── `@` is different: it counts anywhere ──
 * A slash command must have a line to itself (it's a command, not content), whereas
 * `@src/foo.ts` is a word **in the middle** of a sentence. So it's decided by "the word
 * the cursor is in", regardless of line start or newlines. Where the files come from
 * isn't this module's business — the caller supplies a query function (see
 * cli/mentions.ts), and this module still knows nothing about the filesystem.
 *
 * ── Pure functions ──
 * This knows nothing about the terminal or the App. Give it text and a cursor position,
 * and it returns what to complete. But **hint text must be read fresh** (commands() is a
 * function, not a constant): the interface language can change at runtime, and a table
 * fixed at import time would still be in the old language after switching.
 *
 * ── Arguments can have a next level ──
 * `/language interface zh` is two levels. So the candidates form a tree, not a flat
 * list — list the candidates for whichever level you've reached.
 */
import { MAX_AGENT_JOBS } from "../agent/flow.ts"
import { t, uiText } from "../i18n/index.ts"
import { LANGUAGE_CHOICES } from "../i18n/index.ts"
import { MODES } from "../permission/mode.ts"

export interface CommandArg {
  value: string
  hint: string
  /** After picking at this level, there's another level */
  args?: CommandArg[]
}

/**
 * What "add nothing" looks like among the candidates.
 *
 * It's a candidate **with an empty value**: select it and that part of the input box stays
 * unchanged, and enter goes through — because "what was typed" and "the highlighted
 * value" are both empty at that point, so completion itself decides "already fully typed"
 * (see `exact` in Shell's onKey, cli/shell.ts). So it isn't a special-case branch; it's
 * one use of an existing rule.
 *
 * When drawn it needs something as a placeholder, or the row is blank. `↵` says exactly
 * what to press.
 */
export const BARE_LABEL = "↵"

export interface SlashCommand {
  /** Full name, including the slash */
  name: string
  hint: string
  /** Argument candidates. Only when present does completion continue after a space */
  args?: CommandArg[]
  /** Aliases still work but aren't in the candidate list — the shorter it is, the more useful */
  aliases?: string[]
  /**
   * What it does with no arguments. **Having this line amounts to saying "this command is
   * a complete command on its own"**, so "add nothing" appears as the first candidate (see
   * BARE_LABEL).
   *
   * ── Why this candidate has to exist ──
   * After completing the command name, completion adds a space (there's another level
   * after all), then immediately pops up the argument candidates, and enter at that point
   * picks **the first argument**. So for a command like `/upgrade`, where "no arguments" is
   * the most common usage, the one usage you can't get to is exactly the most common one —
   * the user has to press backspace first, then enter. Completion that hides the default
   * action and costs an extra key press to reach it is doing more harm than good.
   */
  bareHint?: string
}

/**
 * Candidates for `/model`.
 *
 * Injected by the host during wiring (see cli/main.ts), because this list has to ask the
 * registry — and this module doesn't know about providers, nor should it. Same approach as
 * i18n's setInterfaceLanguage: a pure-function module + data registered at runtime is
 * lighter than adding another parameter to complete() and threading it down layer by
 * layer, and this data is only injected once per session.
 *
 * Nothing injected (no candidates configured) is perfectly normal: `/model` still works,
 * and you can type any provider/model freely — all that's missing is the list tab pops up.
 */
let modelChoices: string[] = []

export function setModelChoices(specs: string[]): void {
  modelChoices = specs
}

/**
 * Language candidates. auto means different things for interface and reply, so the hints
 * are written separately.
 */
function languageArgs(kind: "interface" | "reply"): CommandArg[] {
  return LANGUAGE_CHOICES.map((choice) => ({
    value: choice,
    hint:
      choice === "auto"
        ? kind === "interface"
          ? t.languageAutoInterfaceHint
          : t.languageAutoReplyHint
        : choice === "en"
          ? t.languageEnglish
          : choice === "zh"
            ? t.languageChinese
            : t.languageJapanese,
  }))
}

export function commands(): SlashCommand[] {
  return [
    { name: "/access", hint: "Directory access grants", args: [] },
    {
      name: "/agents",
      hint: "Subagent status and output",
      bareHint: uiText("list them", "列出全部", "一覧"),
      args: [{ value: "kill", hint: uiText("kill every subagent for good", "彻底 kill 所有子代理", "すべてのサブエージェントを完全に kill") }],
    },
    { name: "/detail", hint: "Full tool output", args: [] },
    { name: "/jobs", hint: "Background processes", args: [] },
    {
      name: "/ssh",
      hint: uiText("SSH host session grants", "SSH 主机会话授权", "SSH ホストのセッション許可"),
      args: [{ value: "revoke", hint: "HOST|all" }],
    },
    {
      name: "/permission",
      hint: t.cmdPermission,
      bareHint: t.bareCurrent,
      args: [
        ...MODES.map((mode) => ({
          value: mode,
          hint: mode === "confirm" ? t.modeConfirmHint : mode === "default" ? t.modeDefaultHint : t.modeAutoHint,
        })),
        // Listed alongside the three modes because it answers the same question ("how are
        // tool calls approved"), and you can only revoke what you can see — a saved allow
        // rule with no visible way in is one you can't revoke
        { value: "forget", hint: t.modeForgetHint },
      ],
    },
    {
      name: "/view",
      hint: t.cmdView,
      bareHint: t.bareCurrent,
      args: [],
    },
    {
      name: "/language",
      hint: t.cmdLanguage,
      bareHint: t.bareCurrent,
      args: [
        { value: "interface", hint: t.languageInterfaceHint, args: languageArgs("interface") },
        { value: "reply", hint: t.languageReplyHint, args: languageArgs("reply") },
      ],
    },
    {
      name: "/think",
      hint: t.cmdThink,
      bareHint: t.bareToggle,
      // No argument means toggle. on/off are listed for people who want "to be sure whether
      // it's on or off now" — with a switch you can only check by flipping it, the user is
      // never sure they pressed the right thing
      args: [
        { value: "on", hint: t.thinkingHint },
        { value: "off", hint: t.thinkingOff },
      ],
    },
    {
      name: "/effort",
      hint: t.cmdEffort,
      bareHint: t.bareCurrent,
      // All five levels are listed, unlike /agentflow's numbers: which ones exist is
      // exactly what someone typing this doesn't remember, and there are only five
      args: [
        { value: "low", hint: t.effortLow },
        { value: "medium", hint: t.effortMedium },
        { value: "high", hint: t.effortHigh },
        { value: "xhigh", hint: t.effortXhigh },
        { value: "max", hint: t.effortMax },
        { value: "default", hint: t.effortDefault },
      ],
    },
    {
      name: "/agentflow",
      hint: t.cmdAgentflow,
      bareHint: t.bareToggle,
      // Only on/off are listed. The number (how many at once) can still be typed, but
      // listing all of 2-12 as candidates would make a binary switch look like a question
      // you have to think through first
      args: [
        { value: "on", hint: t.agentflowHint },
        { value: "off", hint: t.agentflowOffHint(MAX_AGENT_JOBS) },
      ],
    },
    {
      name: "/model",
      hint: t.cmdModel,
      bareHint: t.bareCurrent,
      // `/models` is an alias, for the same reason as `/context`+`/content`: this
      // command is **both** "list models" and "switch model", both phrasings are natural,
      // and neither is worth an "unknown command". Only one is listed
      aliases: ["/models"],
      // With none at all, **no args**: an empty array would pop up an empty box after
      // typing "/model ", which looks like "there are no models to choose from" when it
      // actually means "nobody configured candidates"
      ...(modelChoices.length > 0
        ? { args: modelChoices.map((spec) => ({ value: spec, hint: "" })) }
        : {}),
    },
    // First in this cluster of "change a setting" commands. It's the **master index** for
    // the others — people who can't remember what `/agentflow` is called can remember this
    {
      name: "/setting",
      hint: t.cmdSetting,
      // All three names are accepted. There's no name for this command everyone thinks
      // of first, and an "unknown command" for guessing one letter wrong trades the user's
      // time for us writing two fewer lines
      aliases: ["/settings", "/config"],
    },
    { name: "/resume", hint: t.cmdResume },
    // `/content` is an alias: what fills the window is called context, but fingers type
    // content often enough that it's not worth an "unknown command" — accept both, list one
    { name: "/cache-hit", hint: uiText("Cache usage for recent LLM calls", "近期 LLM 调用缓存情况", "最近の LLM 呼び出しのキャッシュ状況") },
    { name: "/debugger", hint: uiText("Cache diagnostics and request details", "缓存诊断与请求详情", "キャッシュ診断とリクエスト詳細") },
    { name: "/context", hint: t.cmdContext, aliases: ["/content"] },
    // The argument is **free text** (what to be sure to preserve this time), so the only
    // candidates are the `auto` branch and "add nothing". Without bareHint, enter after
    // completing the command name would pick auto — and the most common usage of this
    // command is precisely adding nothing
    {
      name: "/compact",
      hint: t.cmdCompact,
      bareHint: t.bareCompactNow,
      args: [{ value: "auto", hint: t.autoCompactHint }],
    },
    {
      name: "/check",
      hint: t.cmdCheck,
      bareHint: t.bareRunNow,
      // No argument = run once right now. on/off are listed for the same reason as /think:
      // with a switch you can only check by flipping it, the user is never sure they
      // pressed the right thing
      args: [
        { value: "on", hint: t.checkOnHint },
        { value: "off", hint: t.checkOffHint },
      ],
    },
    // After check, before help: like /check it's "do something to this project", not "do
    // something to this session"
    { name: "/init", hint: t.cmdInit },
    { name: "/mcp", hint: t.cmdMcp },
    // Right next to /mcp: the two are halves of the same thing — what this repo gets to
    // say to the model, and what processes it gets us to start
    {
      name: "/trust",
      hint: t.cmdTrust,
      bareHint: t.trustShowHint,
      args: [
        { value: "on", hint: t.trustOnHint },
        { value: "off", hint: t.trustOffHint },
        { value: "check", hint: t.trustCheckHint },
      ],
    },
    { name: "/skills", hint: t.cmdSkills },
    // Same thing as `alfa upgrade`. It needs an entry point inside the session too: the
    // "a new version is out" line on the startup banner is exactly when the user sees it,
    // and at that moment all they have is this window — make them open another terminal
    // just to upgrade and most people drop it on the spot
    {
      name: "/upgrade",
      hint: t.cmdUpgrade,
      // No argument is what the command itself is for, so borrow its own hint
      bareHint: t.cmdUpgrade,
      // Only force is listed. `check` is still accepted (muscle memory), but it's the same
      // as no argument — two identical candidates side by side just make the reader stop
      // and wonder how they differ
      args: [{ value: "force", hint: t.upgradeForceHint }],
    },
    // A pair with /resume (that one lists history, this one deletes it), but placed in
    // this small cluster of commands that delete things.
    // ★ The day counts get candidates, `confirm` **does not** — same rule as /reset: a
    //   confirmation must be typed out in full, letter by letter; a confirmation one tab
    //   can complete is no confirmation at all
    {
      name: "/history-clean",
      hint: t.cmdCleanHistory,
      // The old name is still accepted but not listed. It was once called
      // /clean-history, and that name shares a prefix with /clear: typing `/cl` popped up
      // two, one being "delete the better part of a year's history" and the other "start a
      // new conversation" — side by side in this list, with consequences an order of
      // magnitude apart
      aliases: ["/clean-history"],
      bareHint: t.bareListFirst,
      args: [
        { value: "7", hint: t.cleanDaysWeek },
        { value: "30", hint: t.cleanDaysMonth },
        { value: "90", hint: t.cleanDaysQuarter },
      ],
    },
    // In the last small cluster, and **with no argument candidates**: `confirm` / `all`
    // must not be tab-completable. This command's only safety boundary is "it must be
    // typed out in full, letter by letter"
    { name: "/reset", hint: t.cmdReset },
    { name: "/help", hint: t.cmdHelp },
    { name: "/clear", hint: t.cmdClear },
    { name: "/exit", hint: t.cmdExit, aliases: ["/quit"] },
  ]
}

export interface CompletionItem {
  /** What goes into the input box when selected */
  value: string
  /**
   * How it's drawn. If omitted, value is drawn — only the "add nothing" candidate needs
   * this, because its value is empty and without a placeholder the row is blank
   */
  label?: string
  hint: string
  /**
   * Add a space after completing.
   *
   * For a command it's "there's another level of arguments after this", for an `@`
   * reference it's "this one is complete, go on with the next sentence" — in both cases
   * the next character the user has to type isn't a space, so it's one and the same flag.
   */
  more?: boolean
}

export interface Completion {
  items: CompletionItem[]
  /** The [from, to) of text that the completion replaces */
  from: number
  to: number
}

/**
 * File candidate lookup. Implemented by the index in cli/mentions.ts — this module only
 * knows the signature.
 */
export type FileSource = (query: string) => CompletionItem[]

/**
 * What to complete at the cursor. Returns undefined when there's nothing to complete.
 *
 * Candidates only when the cursor is at the end: completion's sense of position relies
 * entirely on "what you're typing is the last word"; pop up a box with the cursor back in
 * the middle and, once selected, the content lands somewhere the user didn't expect.
 */
export function complete(text: string, cursor: number, files?: FileSource): Completion | undefined {
  if (cursor !== text.length) return undefined

  // Check `@` first: it can appear anywhere, including in a slash command's arguments
  const mention = mentionAt(text, cursor)
  if (mention !== undefined && files) {
    const items = files(mention.query)
    if (items.length === 0) return undefined
    return { items, from: mention.from, to: cursor }
  }

  if (!text.startsWith("/")) return undefined
  // A / in multi-line input isn't a command — a command is always a line of its own
  if (text.includes("\n")) return undefined

  const tokens = text.split(" ")
  const typed = tokens[tokens.length - 1] ?? ""
  const from = text.length - typed.length

  // ── Still typing the command name ──
  if (tokens.length === 1) {
    const prefix = typed.toLowerCase()
    const items = commands()
      .filter((command) => command.name.startsWith(prefix))
      .map((command) => ({ value: command.name, hint: command.hint, ...(command.args ? { more: true } : {}) }))
    if (items.length === 0) return undefined
    const only = items.length === 1 && items[0]!.value === text
    // Fully typed, and it takes no arguments: leaving the box up only blocks the view
    if (only && !lookup(text)?.args) return undefined
    return { items, from: 0, to: text.length }
  }

  // ── Typing arguments: first walk down through the segments already typed ──
  const command = lookup(tokens[0] ?? "")
  let level = command?.args
  for (const token of tokens.slice(1, -1)) {
    if (!level) return undefined
    level = level.find((arg) => arg.value === token.toLowerCase())?.args
  }
  if (!level) return undefined

  const prefix = typed.toLowerCase()
  const items: CompletionItem[] = level
    // Case-insensitive: the other candidates are all lowercase anyway, but model names
    // aren't necessarily — plenty of endpoints have uppercase in model names, and comparing
    // as-is, typing lowercase would match none of them
    .filter((arg) => arg.value.toLowerCase().startsWith(prefix))
    .map((arg) => ({ value: arg.value, hint: arg.hint, ...(arg.args ? { more: true } : {}) }))

  // ★ "Add nothing" goes first, and only **at the first level, with nothing typed yet**:
  //   typing anything means the user wants some argument (and an empty value matches no
  //   prefix anyway), and "add nothing" at the second level usually isn't a complete
  //   command (`/language interface` isn't)
  if (tokens.length === 2 && prefix.length === 0 && command?.bareHint) {
    items.unshift({ value: "", label: BARE_LABEL, hint: command.bareHint })
  }
  if (items.length === 0) return undefined
  return { items, from, to: text.length }
}

/**
 * Whether the word the cursor is in is an `@` reference.
 *
 * Scan back to the first whitespace — word boundaries are whitespace, not punctuation. The
 * hyphen and dot in `@src/a-b.ts` are part of the path; break words on punctuation and
 * halfway through typing it could never be completed again.
 */
function mentionAt(text: string, cursor: number): { from: number; query: string } | undefined {
  let at = cursor
  while (at > 0 && !/\s/.test(text[at - 1] ?? "")) at--
  const token = text.slice(at, cursor)
  if (!token.startsWith("@")) return undefined
  return { from: at, query: token.slice(1) }
}

/** Look up a command by full name or alias. */
export function lookup(name: string): SlashCommand | undefined {
  const key = name.toLowerCase()
  return commands().find((command) => command.name === key || command.aliases?.includes(key))
}

/** Put the picked candidate into the input box; returns the new text (cursor at the end). */
export function apply(text: string, completion: Completion, item: CompletionItem): string {
  const head = text.slice(0, completion.from)
  const tail = text.slice(completion.to)
  // If there's another level after it, add a space — one key press saved
  const suffix = item.more ? " " : ""
  return head + item.value + suffix + tail
}
