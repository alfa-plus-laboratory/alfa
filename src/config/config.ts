/**
 * Non-secret configuration.
 *
 * Keeping it separate from auth.json is deliberate: this file contains **not a single
 * byte of a secret**, so it can go into a dotfiles repo, be pasted to a colleague, be
 * diffed. Mix the two and the whole file has to be treated as a secret, and "my model
 * setup" can never be shared again.
 *
 * Editing this file by hand is a supported use, so errors must speak plainly: point at
 * which field it is and what value was expected, instead of spitting out zod's error as
 * is.
 */
import type { ExtensionEntry } from "../extension/api.ts"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { dirname, join } from "node:path"
import { FLOW_WINDOW, FLOW_WINDOW_MAX, FLOW_WINDOW_MIN, isFlowWindow } from "../agent/flow.ts"
import { isLanguageChoice, LANGUAGE_CHOICES, type LanguageChoice } from "../i18n/index.ts"
import { MODES, normalizeMode, type PermissionMode } from "../permission/mode.ts"
import { configDir } from "../util/xdg.ts"
import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "../llm/types.ts"

/** The three built-in integration shapes. Extend this when adding a provider type. */
export const PROVIDER_TYPES = ["anthropic", "openai-responses", "openai-chat"] as const
export type ProviderType = (typeof PROVIDER_TYPES)[number]

/**
 * A broken provider type is the only config error that can be safely fixed without
 * knowing the model.
 * ★ Carry structured fields instead of having the CLI pick apart the error text: the text
 *   gets translated and edited, and a slightly loose regex could route other config
 *   errors into the repair page too, ending up overwriting things the user never chose.
 */
export class InvalidProviderTypeError extends Error {
  constructor(
    readonly path: string,
    readonly providerID: string,
    readonly value: unknown,
  ) {
    super(`${path}: providers."${providerID}".type must be one of ${PROVIDER_TYPES.map((t) => `"${t}"`).join(" | ")}.`)
    this.name = "InvalidProviderTypeError"
  }
}

/**
 * A folder's trust state.
 *
 * ── Why it exists ──
 * When `alfa` starts in an unfamiliar repo, that repo can talk to it: `AGENTS.md` /
 * `CLAUDE.md` go into the system prompt, `.alfa/mcp.json` can name processes to run.
 * Both take effect with "clone, type one command" — and whose repo you clone is far too
 * casual a decision.
 *
 * On first entering a non-empty directory we ask first; choosing "take a look first"
 * runs a review while the project text is quarantined. This gate must not be mixed up
 * with permission modes: it governs whether text in the repo may influence the model,
 * not tool permissions.
 *
 *   trusted   — business as usual. The project's instruction files go into the system
 *               prompt
 *   checking  — the user chose "take a look first". A subagent is dispatched to read
 *               through those files and, if they are clean, turns it trusted by itself
 *               (see cli/trust.ts). Until then it is treated as untrusted
 *   concerns  — the review explicitly found potential injection. Project text stays
 *               quarantined, but the finding is kept for the user and the main agent to
 *               clean up; only the user confirming the source or a clean re-check turns
 *               it trusted
 *   untrusted — the user ran `/trust off` themselves, or the review gave no readable
 *               verdict. **Not one word** of the project's instruction files goes into
 *               the system prompt
 */
export const TRUST_STATES = ["trusted", "checking", "concerns", "untrusted"] as const
export type TrustState = (typeof TRUST_STATES)[number]

export function isTrustState(value: string): value is TrustState {
  return (TRUST_STATES as readonly string[]).includes(value)
}

/**
 * A folder's own few settings: its trust state, the review summary, and two dates.
 * **Stored in this machine's config, never in the repo.**
 *
 * ── Why not in the repo ──
 * Trust is this person's judgement of the repo, not a property of it — a file that can
 * declare "I am trustworthy" by itself might as well say nothing.
 */
export interface FolderConfig {
  trust?: TrustState
  /**
   * Review summary kept in the concerns state; it is material, not instructions, and
   * must still be wrapped in the untrusted envelope before going to the model.
   */
  concern?: string
  /** The day it was marked trusted. `YYYY-MM-DD`, for humans */
  trustedAt?: string
  /**
   * The day we first ran here. If this key exists, the opening card has already asked;
   * don't ask a second time
   */
  seenAt?: string
}

export interface LanguageConfig {
  /** UI text */
  interface?: LanguageChoice
  /** The model's replies */
  reply?: LanguageChoice
}

export interface ModelLimit {
  context: number
  output: number
}

export interface ModelConfig {
  disabled?: boolean
  /** Opt-in Responses profile for controlled evaluations; unknown models stay generic. */
  promptProfile?: "generic" | "openai-codex"
  /**
   * This model's own window. If unset, fall back to the provider's limit, and only then
   * to the built-in default.
   *
   * It has to be settable per model: small and full model variants, from the
   * same provider often differ several-fold in window size, and the window is the only
   * basis for **when compaction triggers** — estimate too big and the symptom is the
   * provider suddenly rejecting requests mid-conversation; too small and you compact
   * over and over for no reason.
   */
  limit?: ModelLimit
  /**
   * Whether this model takes image input. Unset = the provider's `images`, then **yes**,
   * on every protocol.
   *
   * ── Why default yes, when a wrong yes is the sticky mistake ──
   * The first version defaulted to yes only for Claude models and OpenAI's own endpoint:
   * a text-only endpoint that gets an image 400s, and since the image stays in history,
   * so does every later turn. It was reversed on the user's call — most models now take
   * images, and a wrong **no** fails silently: the image is replaced by a note and the
   * model answers "I can't see it" about a picture it could have read. A wrong yes at
   * least fails loudly, and the failed turn says which switch to flip (see runTurn in
   * cli/main.ts). With false the image is kept but sent as a one-line note (see
   * toModelMessages in llm/to-model-messages.ts), so flipping it later loses nothing.
   */
  images?: boolean
}

export interface ProviderConfig {
  disabled?: boolean
  noKey?: boolean
  keyHeader?: string
  discovery?: "models" | "none"
  type: ProviderType
  /** Not needed for the official endpoint */
  baseURL?: string
  /**
   * This provider's **default** window — only takes effect when a model has no limit of
   * its own.
   *
   * Keeping it isn't laziness: every model on a self-hosted gateway having the same 128k
   * is a common reality, and making the user copy the same number under ten models means
   * getting one wrong sooner or later.
   */
  limit?: ModelLimit
  /**
   * Which models this provider can switch to (the `/model` candidates), and each one's
   * window.
   *
   * Two forms, the latter a superset of the former:
   *   "models": ["gpt-4o", "gpt-4o-mini"]
   *   "models": { "gpt-4o": { "limit": { "context": 128000, "output": 16000 } },
   *               "gpt-4o-mini": {} }
   * Use the array if you just want them to show up as candidates; the object is only
   * needed to give a particular model its own window.
   *
   * Must be written by the user: apart from anthropic's hard-coded table (which only
   * counts when talking to the official endpoint), we don't guess which model names a
   * third-party endpoint accepts — guessed candidates are worse than none, because they
   * look selectable.
   *
   * Switching works without it too; `/model <provider>/<any-model-name>` is always free
   * input — this list only decides what pops up on tab, and how big the window is taken
   * to be.
   */
  models?: Record<string, ModelConfig>
  /**
   * Whether to send the model's own thinking back to it within one tool loop
   * (openai-chat only).
   *
   * On by default. The only reason to turn it off is that this endpoint errors when it
   * receives `reasoning_content` — it's not a standard field and every provider does it
   * differently. The anthropic path ignores this key: it goes by signatures, there is no
   * choice (see ReasoningReplay in llm/registry.ts).
   */
  replayReasoning?: boolean
  /** Default for this provider's models. See ModelConfig.images */
  images?: boolean
}

export interface Config {
  /**
   * Experimental OS shell isolation is opt-in because platform support is incomplete.
   * An omitted setting is off; explicit choices survive restarts independently of tool
   * approval and of the permission mode (auto keeps it; see security/access.ts).
   */
  sandbox?: boolean
  /**
   * true = auto mode may read files outside the workspace without asking first. Written
   * when the user answers "always" to auto's first outside read; omitted = ask.
   */
  autoOutsideReads?: boolean
  appearance?: {
    theme?: "terminal" | "dark" | "light"
    toolOutput?: "compact" | "expanded"
    /** Robot and clock on the running line. Absent = on. */
    animation?: "on" | "off"
    /** How the model's thinking is shown: not at all, a live tail + receipt, or streamed in full. Absent = preview. */
    reasoning?: "off" | "preview" | "full"
  }
  extensions?: ExtensionEntry[]
  /** Default model, like "anthropic/claude-sonnet-4-5" */
  model?: string
  /**
   * auto mode's classifier (permission/auto/). `model` unset = use the conversation's
   * model. An object rather than a bare string so a dedicated backend (a System-One
   * classifier such as Jev) can be added beside it without a migration.
   */
  classifier?: { model?: string }
  providers?: Record<string, ProviderConfig>
  /**
   * Per-folder settings, keyed by the **absolute path of the workspace root**.
   *
   * ⚠ This table keeps growing with every repo you use. **No automatic cleanup**, on
   *   purpose — a repo that was moved away for a while, or a mount point that isn't
   *   mounted, would make the "directory doesn't exist" test delete the user's
   *   accumulated preferences and trust dates along with it, irreversibly. A few dozen
   *   bytes per entry; after a year of growth nobody could tell.
   */
  folders?: Record<string, FolderConfig>
  language?: LanguageConfig
  /**
   * Is extended thinking on (`/think`). Off by default.
   *
   * It is persisted because it **isn't a one-off choice**: someone who wants to see how
   * the model thinks wants to see it every turn, and `--thinking` is a switch you'd have
   * to retype on every launch — a switch like that might as well not exist.
   */
  thinking?: boolean
  /**
   * How hard the model thinks (`/effort`). Absent = send nothing, each provider's default
   * applies. Kept apart from `thinking` because the two answer different questions —
   * "do I get to see it think" vs "how much should it think" — and on Responses and
   * Chat Completions only the second one reaches the model at all.
   */
  effort?: ReasoningEffort
  /**
   * Compact on its own when the window is nearly full (see AUTO_COMPACT_AT in main.ts).
   * **On by default.**
   *
   * On by default is a considered decision: with it off, a long session ends by hitting
   * the full window and then failing every turn — and at that point the user's only
   * move is /compact, while they are most likely in the middle of something half done.
   * Lossy beats hitting the wall, and besides, not a word of the original is deleted.
   *
   * It is persisted because it is a preference rather than a one-off choice, and it
   * **costs money** (every automatic trigger is a real model call) — people who don't
   * want it acting on its own must be able to turn it off once and never be asked again.
   */
  autoCompact?: boolean
  /**
   * Global MCP server definitions:
   * `{ "mcp": { "servers": { "github": { "command": … } } } }`.
   *
   * Here we **only check as far as "it's an object"**; whether each definition is valid
   * is judged one by one in mcp/config.ts — that side also has to merge with the
   * project's `.alfa/mcp.json`, and both places must use the same code for the judgment,
   * or the same entry would meet two different fates in the two files. Also, one broken
   * server definition shouldn't stop the whole program from starting (every other field
   * in this file throws; the MCP section deliberately doesn't).
   */
  mcp?: { servers?: Record<string, unknown>; library?: Record<string, unknown> }
  /**
   * agentflow (`/agentflow`). A number = on, and at most that many subagents at once;
   * false = off. Off by default.
   *
   * ── Why "on" is a number rather than true ──
   * This switch has exactly one parameter, and that parameter is its entire cost: N at
   * once means N bills at once, N streams hitting the provider's rate limit together. A
   * config file that says `"agentflow": 6` spells that out on its own; with true, the
   * number actually in effect is hidden in the code, and it's the thing the user most
   * needs to see.
   *
   * ★ It is persisted, so the startup banner **must spell it out** (see the banner in
   *   main.ts) — the same rule as the permission mode: you can forget what was saved,
   *   you can't forget what's written on screen. Someone who doesn't remember turning
   *   flow on just sees "why did it suddenly dispatch sixteen people".
   */
  agentflow?: number | false
  /**
   * The permission mode used last time (`/permission`, shift-tab). With nothing saved,
   * startup picks auto (see cli/main.ts).
   *
   * ★ This key was once **deliberately not saved**: it is a security boundary, and "the
   *   auto I turned on last week is still on this week" is exactly invisible automation.
   *   Now it is saved, and the price must be paid back on the spot — an active non-default
   *   mode **must be spelled out** on the startup banner together with how to change it.
   */
  permission?: PermissionMode
  /**
   * The automatic check before wrapping up (see agent/check.ts).
   *
   *   unset     — detected per project (tsconfig + local tsc / Cargo.toml / go.mod)
   *   false     — off
   *   "command" — your own instead, e.g. "bun run typecheck && bun run lint"
   *
   * The string form **still goes through the permission gatekeeper**. The config file is
   * not a back door around authorization — a config option that lets arbitrary commands
   * quietly run differs from a remote code execution hole only in wording.
   */
  check?: string | false
}

export function configPath(): string {
  return join(configDir(), "config.json")
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new Error(`${path} is not valid JSON. Fix it, or delete it to start over.`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`)
  }

  const source = parsed as Record<string, unknown>
  const config: Config = {}
  if (source.extensions !== undefined) {
    if (!Array.isArray(source.extensions) || source.extensions.some(e => !e || typeof e.path !== "string" || typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256))) throw new Error("extensions must contain path and sha256")
    config.extensions = source.extensions
  }

  if (source["model"] !== undefined) {
    if (typeof source["model"] !== "string") throw new Error(`${path}: "model" must be a string like "anthropic/claude-sonnet-4-5".`)
    config.model = source["model"]
  }

  if (source["classifier"] !== undefined) {
    const value = source["classifier"] as Record<string, unknown> | null
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: "classifier" must be an object like { "model": "provider/model" }.`)
    if (value.model !== undefined && (typeof value.model !== "string" || !value.model.includes("/"))) throw new Error(`${path}: "classifier.model" must be a string like "anthropic/claude-haiku-4-5".`)
    config.classifier = value.model === undefined ? {} : { model: value.model as string }
  }

  if (source["providers"] !== undefined) {
    const raw = source["providers"]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${path}: "providers" must be an object keyed by provider name.`)
    }
    const providers: Record<string, ProviderConfig> = {}
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      providers[id] = parseProvider(path, id, value)
    }
    config.providers = providers
  }

  if (source["sandbox"] !== undefined) {
    if (typeof source["sandbox"] !== "boolean") throw new Error(`${path}: sandbox must be boolean`)
    config.sandbox = source["sandbox"]
  }

  if (source["autoOutsideReads"] !== undefined) {
    if (typeof source["autoOutsideReads"] !== "boolean") throw new Error(`${path}: autoOutsideReads must be boolean`)
    config.autoOutsideReads = source["autoOutsideReads"]
  }

  // The 0.9 view/panels keys are retired; ignored on read, dropped naturally on the next
  // normal save.
  if (source["appearance"] !== undefined) {
    const value = source["appearance"] as Record<string, unknown> | null
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: "appearance" must be an object.`)
    if (value.theme !== undefined && !["terminal", "dark", "light"].includes(String(value.theme))) throw new Error(`${path}: "appearance.theme" must be terminal, dark or light.`)
    if (value.toolOutput !== undefined && !["compact", "expanded"].includes(String(value.toolOutput))) throw new Error(`${path}: "appearance.toolOutput" must be compact or expanded.`)
    if (value.animation !== undefined && !["on", "off"].includes(String(value.animation))) throw new Error(`${path}: "appearance.animation" must be on or off.`)
    if (value.reasoning !== undefined && !["off", "preview", "full"].includes(String(value.reasoning))) throw new Error(`${path}: "appearance.reasoning" must be off, preview or full.`)
    config.appearance = {
      ...(value.theme === undefined ? {} : { theme: value.theme as "terminal" | "dark" | "light" }),
      ...(value.toolOutput === undefined ? {} : { toolOutput: value.toolOutput as "compact" | "expanded" }),
      ...(value.animation === undefined ? {} : { animation: value.animation as "on" | "off" }),
      ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning as "off" | "preview" | "full" }),
    }
  }

  if (source["folders"] !== undefined) {
    const raw = source["folders"]
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${path}: "folders" must be an object keyed by absolute folder path.`)
    }
    const folders: Record<string, FolderConfig> = {}
    for (const [dir, value] of Object.entries(raw as Record<string, unknown>)) {
      folders[dir] = parseFolder(path, dir, value)
    }
    config.folders = folders
  }

  if (source["thinking"] !== undefined) {
    const thinking = source["thinking"]
    if (typeof thinking !== "boolean") {
      throw new Error(`${path}: "thinking" must be true or false.`)
    }
    config.thinking = thinking
  }
  if (source["effort"] !== undefined) {
    const effort = source["effort"]
    if (!isReasoningEffort(effort)) {
      throw new Error(`${path}: "effort" must be one of ${REASONING_EFFORTS.join(", ")}.`)
    }
    config.effort = effort
  }
  if (source["autoCompact"] !== undefined) {
    const autoCompact = source["autoCompact"]
    if (typeof autoCompact !== "boolean") {
      throw new Error(`${path}: "autoCompact" must be true or false.`)
    }
    config.autoCompact = autoCompact
  }
  if (source["mcp"] !== undefined) {
    const mcp = source["mcp"]
    if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) {
      throw new Error(`${path}: "mcp" must be an object with a "servers" key.`)
    }
    const servers = (mcp as { servers?: unknown }).servers
    if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
      throw new Error(`${path}: "mcp.servers" must be an object of name → definition.`)
    }
    // The shelf. Looks just like servers; the only difference is **nobody connects to
    // it automatically** — it starts only when the project's `.alfa/mcp.json` names it
    // in `use: [...]` (see mcp/config.ts)
    const library = (mcp as { library?: unknown }).library
    if (library !== undefined && (library === null || typeof library !== "object" || Array.isArray(library))) {
      throw new Error(`${path}: "mcp.library" must be an object of name → definition.`)
    }
    config.mcp = {
      ...(servers === undefined ? {} : { servers: servers as Record<string, unknown> }),
      ...(library === undefined ? {} : { library: library as Record<string, unknown> }),
    }
  }
  if (source["agentflow"] !== undefined) {
    const flow = source["agentflow"]
    // true is accepted too: people hand-writing config will write true like for the
    // other switches, and "on" itself is unambiguous — erroring so they can't open the
    // program, just to force them to write a number, is out of proportion
    const value = flow === true ? FLOW_WINDOW : flow
    if (value !== false && !isFlowWindow(value)) {
      throw new Error(
        `${path}: "agentflow" must be false, or how many subagents may run at once (${FLOW_WINDOW_MIN}-${FLOW_WINDOW_MAX}).`,
      )
    }
    config.agentflow = value
  }

  if (source["permission"] !== undefined) {
    const mode = source["permission"]
    // ★ Unknown old names in a string are all migrated to auto. The permission modes
    //   were renamed, and an old config must not stop the program from starting because
    //   of that; auto is the main path of this product line. A non-string is still
    //   broken.
    if (typeof mode !== "string") {
      throw new Error(`${path}: "permission" must be one of ${MODES.map((m) => `"${m}"`).join(" | ")}.`)
    }
    config.permission = normalizeMode(mode) ?? "auto"
  }

  if (source["check"] !== undefined) {
    const check = source["check"]
    if (check !== false && (typeof check !== "string" || check.trim().length === 0)) {
      throw new Error(`${path}: "check" must be false, or a command string like "bun run typecheck".`)
    }
    config.check = check === false ? false : check
  }

  if (source["language"] !== undefined) {
    config.language = parseLanguage(path, source["language"])
  }

  return config
}

function parseLanguage(path: string, value: unknown): LanguageConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: "language" must be an object like { "interface": "en", "reply": "auto" }.`)
  }
  const source = value as Record<string, unknown>
  const config: LanguageConfig = {}
  for (const key of ["interface", "reply"] as const) {
    const raw = source[key]
    if (raw === undefined) continue
    if (typeof raw !== "string" || !isLanguageChoice(raw)) {
      throw new Error(
        `${path}: language."${key}" must be one of ${LANGUAGE_CHOICES.map((l) => `"${l}"`).join(" | ")}.`,
      )
    }
    config[key] = raw
  }
  return config
}

function parseFolder(path: string, dir: string, value: unknown): FolderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: folders."${dir}" must be an object.`)
  }
  const source = value as Record<string, unknown>
  const config: FolderConfig = {}

  const trust = source["trust"]
  if (trust !== undefined) {
    if (typeof trust !== "string" || !isTrustState(trust)) {
      throw new Error(`${path}: folders."${dir}".trust must be one of ${TRUST_STATES.map((s) => `"${s}"`).join(" | ")}.`)
    }
    config.trust = trust
  }

  const concern = source["concern"]
  if (concern !== undefined) {
    if (typeof concern !== "string") throw new Error(`${path}: folders."${dir}".concern must be a string.`)
    config.concern = concern
  }

  // The two dates are just notes for humans and play no part in any decision — so the
  // format is loose: any string is accepted. Strict validation of a field nobody has
  // ever parsed would buy nothing but "mistype one letter and the program won't open"
  for (const key of ["trustedAt", "seenAt"] as const) {
    const raw = source[key]
    if (raw === undefined) continue
    if (typeof raw !== "string") throw new Error(`${path}: folders."${dir}".${key} must be a date string like "2026-08-31".`)
    config[key] = raw
  }

  return config
}

function parseProvider(path: string, id: string, value: unknown): ProviderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: providers."${id}" must be an object.`)
  }
  const source = value as Record<string, unknown>

  const type = source["type"]
  if (typeof type !== "string" || !PROVIDER_TYPES.includes(type as ProviderType)) {
    throw new InvalidProviderTypeError(path, id, type)
  }

  const config: ProviderConfig = { type: type as ProviderType }
  for (const key of ["disabled", "noKey"] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== "boolean") throw new Error(`${path}: ${key} must be boolean`)
      config[key] = source[key]
    }
  }
  if (source.keyHeader !== undefined) {
    if (typeof source.keyHeader !== "string" || !/^[a-zA-Z0-9-]+$/.test(source.keyHeader)) throw new Error("Invalid keyHeader")
    config.keyHeader = source.keyHeader
  }
  if (source.discovery !== undefined) {
    if (source.discovery !== "models" && source.discovery !== "none") throw new Error("Invalid discovery mode")
    config.discovery = source.discovery
  }

  const baseURL = source["baseURL"]
  if (baseURL !== undefined) {
    if (typeof baseURL !== "string" || baseURL.length === 0) {
      throw new Error(`${path}: providers."${id}".baseURL must be a non-empty string.`)
    }
    config.baseURL = baseURL
  }

  const images = source["images"]
  if (images !== undefined) {
    if (typeof images !== "boolean") throw new Error(`${path}: providers."${id}".images must be true or false.`)
    config.images = images
  }

  const replay = source["replayReasoning"]
  if (replay !== undefined) {
    if (typeof replay !== "boolean") {
      throw new Error(`${path}: providers."${id}".replayReasoning must be true or false.`)
    }
    config.replayReasoning = replay
  }

  const models = source["models"]
  if (models !== undefined) {
    config.models = parseModels(path, id, models)
    if (config.type !== "openai-responses" && Object.values(config.models).some(model => model.promptProfile !== undefined)) {
      throw new Error(`${path}: providers."${id}".models.promptProfile requires the openai-responses protocol`)
    }
  }

  const limit = source["limit"]
  if (limit !== undefined) {
    config.limit = parseLimit(limit, `${path}: providers."${id}".limit`)
  }

  return config
}

const MODELS_SHAPE = 'must be either ["name", …] or { "name": { "limit": { "context": …, "output": … } }, … }'

/**
 * Accepts both the array and the object form, normalized internally to an object —
 * downstream only knows one shape
 */
function parseModels(path: string, id: string, value: unknown): Record<string, ModelConfig> {
  const where = `${path}: providers."${id}".models`
  const out: Record<string, ModelConfig> = {}

  if (Array.isArray(value)) {
    for (const name of value) {
      if (typeof name !== "string" || name.length === 0) throw new Error(`${where} ${MODELS_SHAPE}.`)
      out[name] = {}
    }
    return out
  }

  if (!value || typeof value !== "object") throw new Error(`${where} ${MODELS_SHAPE}.`)
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (name.length === 0) throw new Error(`${where} ${MODELS_SHAPE}.`)
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} ${MODELS_SHAPE}.`)
    const declared = (raw as Record<string, unknown>)["limit"]
    out[name] = declared === undefined ? {} : { limit: parseLimit(declared, `${where}."${name}".limit`) }
    const disabled = (raw as Record<string, unknown>).disabled
    const profile = (raw as Record<string, unknown>).promptProfile
    if (profile !== undefined) {
      if (profile !== "generic" && profile !== "openai-codex") throw new Error(`${where}."${name}".promptProfile must be "generic" or "openai-codex"`)
      out[name]!.promptProfile = profile
    }
    if (disabled !== undefined) {
      if (typeof disabled !== "boolean") throw new Error(`${where}: disabled must be boolean`)
      out[name]!.disabled = disabled
    }
    const images = (raw as Record<string, unknown>).images
    if (images !== undefined) {
      if (typeof images !== "boolean") throw new Error(`${where}."${name}".images must be true or false`)
      out[name]!.images = images
    }
  }
  return out
}

function parseLimit(value: unknown, where: string): ModelLimit {
  const record = value as Record<string, unknown>
  if (!value || typeof value !== "object" || typeof record["context"] !== "number" || typeof record["output"] !== "number") {
    throw new Error(`${where} must be { "context": number, "output": number }.`)
  }
  return { context: record["context"], output: record["output"] }
}

export function saveConfig(config: Config, path = configPath()): void {
  saveJSON(config, path)
}

function saveJSON(value: unknown, path: string): void {
  ensureDirSync(dirname(path))
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  renameSync(tmp, path)
}

/**
 * The startup repair page changes only the type the user picked by hand; the rest of
 * the JSON is kept as is.
 * ⚠ Can't loadConfig first: we're called precisely because this file currently fails
 *   loadConfig.
 */
export function repairProviderType(id: string, type: ProviderType, path = configPath()): void {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  const providers = parsed["providers"] as Record<string, unknown> | undefined
  const provider = providers?.[id]
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error(`${path}: providers."${id}" is no longer available to repair.`)
  }
  providers![id] = { ...(provider as Record<string, unknown>), type }
  saveJSON(parsed, path)
}

/** Put one entry into providers and write it to disk. */
export function setProvider(id: string, provider: ProviderConfig, path = configPath()): Config {
  const config = loadConfig(path)
  config.providers = { ...config.providers, [id]: provider }
  saveConfig(config, path)
  return config
}

export function removeProvider(id: string, path = configPath()): boolean {
  const config = loadConfig(path)
  if (!config.providers || !(id in config.providers)) return false
  delete config.providers[id]
  // If the default model points at the provider being removed, clear it too, otherwise
  // the next launch fails right away with unknown model
  if (config.model && config.model.split("/")[0] === id) delete config.model
  saveConfig(config, path)
  return true
}

export function setDefaultModel(model: string, path = configPath()): void {
  const config = loadConfig(path)
  config.model = model
  saveConfig(config, path)
}

/** undefined = back to "same as the conversation's model" (the key is removed, not blanked) */
export function rememberClassifierModel(model: string | undefined, path = configPath()): void {
  update(path, (config) => {
    if (model === undefined) delete config.classifier
    else config.classifier = { ...config.classifier, model }
  })
}

export function rememberAutoOutsideReads(path = configPath()): void {
  update(path, (config) => {
    config.autoOutsideReads = true
  })
}

export function rememberThinking(value: boolean, path = configPath()): void {
  update(path, (config) => {
    config.thinking = value
  })
}

/** undefined = back to the provider default (the key is removed, not blanked) */
export function rememberEffort(value: ReasoningEffort | undefined, path = configPath()): void {
  update(path, (config) => {
    if (value === undefined) delete config.effort
    else config.effort = value
  })
}

export function rememberAutoCompact(value: boolean, path = configPath()): void {
  update(path, (config) => {
    config.autoCompact = value
  })
}

/**
 * Off = write a false, not delete the key: a deleted key reads as "never set", but it
 * was set
 */
export function rememberAgentflow(value: number | false, path = configPath()): void {
  update(path, (config) => {
    config.agentflow = value
  })
}

/**
 * On = delete this key (back to auto-detect), rather than writing a true.
 *
 * If we stored true, then the day the user writes a custom command in the config, a
 * true pressed from the UI would overwrite it — and they'd have no idea when that
 * happened.
 */
export function rememberCheck(value: string | false | undefined, path = configPath()): void {
  update(path, (config) => {
    if (value === undefined) delete config.check
    else config.check = value
  })
}

/** See the star on Config.permission: it may be saved only if startup says it out loud. */
export function rememberPermission(mode: PermissionMode, path = configPath()): void {
  update(path, (config) => {
    config.permission = mode
  })
}

export function rememberLanguage(kind: keyof LanguageConfig, choice: LanguageChoice, path = configPath()): void {
  update(path, (config) => {
    config.language = { ...config.language, [kind]: choice }
  })
}

/**
 * Writes one remembered preference for the remember* functions above.
 *
 * A failed write **does not throw** — what the user pressed was "turn thinking on", not
 * "write the config file". When the config directory is read-only (a read-only volume
 * mounted in a container is common), the setting still takes effect, it just won't be
 * remembered next launch; interrupting the running session over that is completely out
 * of proportion.
 */
function update(path: string, mutate: (config: Config) => void): void {
  try {
    const config = loadConfig(path)
    mutate(config)
    saveConfig(config, path)
  } catch {
    // See above: not remembering beats interrupting the current operation
  }
}
