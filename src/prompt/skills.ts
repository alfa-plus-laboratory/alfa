/**
 * Skills — playbooks loaded on demand.
 *
 * ── How the work is split with the two things that already exist ──
 *   AGENTS.md  this repo's **conventions**. Read every session, because they govern
 *              "what must not break".
 *   memory/    this project's **facts and decisions**. Loaded into context automatically,
 *              because forgetting them means deriving them all over again.
 *   skills/    **how to do one thing**. Catalogue always loaded, body on demand —
 *              because any one specific playbook is useless in nine turns out of ten.
 *
 * ── Why the body does not go into the system prompt ──
 * Measured once: the "how to configure alfa itself" text (then `prompt/config.ts`, now the
 * alfa-config built-in skill) was 5268 chars ≈ 1300 tokens, unconditionally in every
 * session and every request. It hits the
 * prompt cache so it is cheap, but **cache-read tokens still take up the window**, and
 * the turns where it is actually useful are the one percent where "the user asks how to
 * configure a provider".
 *
 * Context reporting already applied the same yardstick (`context` was made a tool rather than
 * stuffed in every turn, the stated reason being "nine turns out of ten have no use for
 * this number"). Skills turn that yardstick into a pathway: **each piece of knowledge
 * takes one line in the catalogue, and the body only comes when it is named**.
 *
 * ── Three sources, and what each one means ──
 *   builtin  compiled into the binary. alfa's knowledge about **itself** lives here —
 *            how to write the config, how permissions work. Such things should not
 *            require the user to install something first.
 *   user     `~/.config/alfa/skills/`. The own playbooks of the person on this machine,
 *            **in effect everywhere**.
 *   project  `<repo>/.alfa/skills/`. This repo's playbooks; they travel with the repo and
 *            go into git.
 *
 * Plus one layer that is not in the catalogue: the **shelf** (`~/.config/alfa/library/`,
 * and `~/.claude/skills/` — see CLAUDE_SKILLS_DIR). Stored but **not in effect** — things
 * accumulated, copied from elsewhere, not necessarily useful for this project. They stay out of the catalogue (that section is
 * sent every turn; for someone who has hoarded fifty, the catalogue alone would be too
 * much), but they can be browsed and read, and **installing** one means writing it into
 * the project's `.alfa/skills/` — via the ordinary disk-write path, through the
 * gatekeeper, with a diff. "Copy one over" deliberately gets no internal privileged
 * channel: one more disk-write entry point that bypasses the user's eyes, just to save
 * one confirmation.
 * On a name clash the more specific wins: project > user > builtin. Same rule as the MCP
 * config, for the same reason — the reverse is hard to explain: the user clearly wrote
 * one in the repo, yet the one in effect is an invisible one somewhere else.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { configDir } from "../util/xdg.ts"
import { authPath } from "../config/auth.ts"
import { configPath } from "../config/config.ts"
import { ENV_PREFIX } from "../env/vars.ts"
import { ALFA_DIR } from "./init.ts"

/** Relative to the project root */
export const SKILLS_DIR = `${ALFA_DIR}/skills`

/** Directory name of the shelf (under the user config directory) */
export const LIBRARY_DIR = "library"

/**
 * Where another tool keeps skills, relative to the project root / relative to home.
 *
 * ── Why read someone else's directory ──
 * The skill format **is the same one to begin with**: `<name>/SKILL.md` + `name:` /
 * `description:` in the frontmatter, body loaded on demand. Every ready-made skill repo
 * in the ecosystem is published against `.claude/skills/`, and those run here without
 * changing a single character — if we don't read it, the user has to move each one over
 * by hand, and in the process comes to believe the two formats differ (this happened in
 * a real run).
 *
 * Nor is this a new opening: instructions.ts has long read `CLAUDE.md` and
 * `~/.claude/CLAUDE.md`, for exactly the same reason — what the user wrote for a repo
 * should not have to be written again just because they switched tools.
 *
 * ★ On a name clash **our own directory wins**. The reason is not territoriality but
 *   predictability: someone who writes an alfa-specific one in `.alfa/skills/` wants
 *   exactly that: for it to cover the one elsewhere.
 *
 * ★ Only the **project** `.claude/skills/` goes into the catalogue. The user-level
 *   `~/.claude/skills/` goes on the **shelf**. It used to be scanned as `user` (in effect
 *   everywhere), and on a real machine that meant 20 skills installed for another agent
 *   — video pipelines, a symlink into an unrelated game repo — appearing in the catalogue
 *   of a brand-new empty folder, every turn, with nothing in alfa's own config saying so.
 *   A directory another tool fills is by definition "accumulated elsewhere, not
 *   necessarily wanted here", which is exactly what the shelf means. Moving it back into
 *   `user` brings back the injection nobody asked for; to have one everywhere, put it in
 *   `~/.config/alfa/skills/`.
 */
export const CLAUDE_SKILLS_DIR = ".claude/skills"

/** Cap on a skill's body. Any longer and it is a manual, not "how to do one thing" */
export const MAX_SKILL_BYTES = 32 * 1024
/**
 * Max number of **on-disk** entries listed in the catalogue. The catalogue is the half
 * sent every turn; it has to stay small.
 *
 * ★ Built-in ones don't count toward it. They are compiled into the binary, we decide how
 *   many there are, and they explain alfa itself — sort everything together and cut once,
 *   and by the user's 37th installed skill "how to configure alfa" starts getting pushed
 *   out of the catalogue, which shows up as the model making up config formats on the
 *   spot. Who gets pushed out also depends on **alphabetical order of names**, the
 *   hardest kind of disappearance to explain to anyone. So the two sides are counted
 *   separately: at most 40 on disk, all built-ins present.
 */
export const MAX_SKILLS = 40
/** Cap on the one-line description in the catalogue. One line means one line */
export const MAX_DESCRIPTION = 160

export type SkillOrigin = "builtin" | "user" | "project" | "library"

export interface Skill {
  name: string
  description: string
  /** The body. A fixed string from the moment of discovery — see BuiltinSkill below */
  body: string
  origin: SkillOrigin
  /** Where it was read from. On-disk ones give the path, built-ins give "built in" */
  source: string
  /**
   * `allowed-tools` from the frontmatter (another tool's field; we **do not enforce it**).
   *
   * Over there it is hard: while the skill is in effect the tool list is narrowed. Here
   * there is no notion of "while the skill is in effect" — a skill is just a piece of
   * text returned by the `skill` tool, and once read it simply sits in the context. So
   * here it is only **carried through as is**, and on opening we say plainly "this was
   * declared, but it is not enforced here": pretending to enforce it is the worst option —
   * the user would believe there is a fence that does not exist.
   */
  allowedTools?: string
}

/**
 * Built-in skill: **the raw text of a skill file**, embedded into the binary at compile
 * time.
 *
 * ── Why a file and not a chunk of TypeScript ──
 * Built-in and user-written skills must be **the same kind of thing**. As functions there
 * would be two systems: users write `.md` + frontmatter, we write TS — so the frontmatter
 * parser would never be used by us (it would break for the first time on someone else's
 * file), the bar for adding built-in knowledge would be "change code" rather than "write a
 * skill", and the built-in ones could not be read as **examples**. Now they go through the
 * same parser and the same fields, and `src/prompt/skills/*.md` is a living sample of how
 * to write a skill.
 *
 * They may contain `{{program}}` `{{configFile}}` `{{authFile}}` `{{envPrefix}}`,
 * replaced at discovery time — the real paths on this machine and the command name the
 * user actually types are unknown at compile time, and they are precisely the things the
 * model cannot guess.
 */
export interface BuiltinSkill {
  /** Raw file text (frontmatter + body) */
  text: string
  /** So that a problem can be reported against the right one */
  source: string
}

/**
 * Replace the placeholders in a built-in skill's body. On-disk skills get **no**
 * substitution — see discoverSkills
 */
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([a-zA-Z]+)\}\}/g, (whole, key: string) => values[key] ?? whole)
}

export interface SkillInput {
  /**
   * The command name the user actually types (usually `alfa`, maybe a symlink/alias).
   * Built-in skills write their examples with it
   */
  program: string
  root: string
  /** For injection: tests pin the paths. Not given = the real paths on this machine */
  configFile?: string
  authFile?: string
  /** The user's global skills directory. The same-named field in DiscoverInput is this */
  userDir?: string
}

export interface SkillSet {
  skills: Skill[]
  /**
   * The ones on the shelf. **Not in the catalogue, not in context**; they only cost
   * anything when named and read.
   *
   * A field separate from skills rather than just another origin: they are treated
   * differently everywhere — not listed in the catalogue, not counted by `/context`, not
   * loaded. Mixed into one array, every one of those places would have to remember to
   * filter, and missing any of them shows up as "I never installed it, yet it's spending
   * my tokens".
   */
  library: Skill[]
  /** How many were kept out by hitting the cap */
  dropped: number
  /**
   * The ones that could not be read. **No throw** — one badly written skill should not
   * keep the program from starting
   */
  problems: Array<{ source: string; why: string }>
}

/**
 * Shape of a name: the model must be able to type it back from the catalogue verbatim,
 * so no spaces and no case ambiguity
 */
const NAME = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Build the catalogue. **This is the part sent every turn**, so one line per skill, no
 * body.
 *
 * Sorted by name, not by source: the same set of files yields the same text every time —
 * if the order jitters, the system prompt's cache prefix is invalidated (same as the note
 * in tool/registry.ts).
 */
export function skillCatalogue(set: SkillSet): string {
  if (set.skills.length === 0) return ""
  const lines = set.skills
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((one) => `- \`${one.name}\` — ${one.description}`)
  const shelf =
    set.library.length > 0
      ? [
          "",
          `${set.library.length} more sit on the user's shelf, not loaded here: \`skill\` with \`action: "library"\` lists them. A shelved one becomes part of this project by being written into \`.alfa/skills/\` — read it, then write it, the same as any other file.`,
        ]
      : []
  return [
    "# Skills",
    "",
    "Playbooks you can open when they apply. Each line is a name and what it covers; the text itself is not here. Call the `skill` tool with the name to read one — do that whenever the work at hand matches a line below, before working it out yourself. Reading one costs a step and some context, so open the one that fits, not the whole list.",
    "",
    ...lines,
    ...shelf,
  ].join("\n")
}

/**
 * Find one. Installed ones first, then the shelf if not found — on a name clash the
 * installed one wins (the shelf filters out same-named ones anyway), and "readable" and
 * "installed" are two different things.
 */
export function findSkill(set: SkillSet, name: string): Skill | undefined {
  const wanted = name.trim().toLowerCase()
  return set.skills.find((one) => one.name === wanted) ?? set.library.find((one) => one.name === wanted)
}

export interface DiscoverInput extends SkillInput {
  /** The user's global directory. Not given = only look in the project */
  userDir?: string
  /** Shelf directory. Not given = there is no shelf */
  libraryDir?: string
  /**
   * `~/.claude/skills`. Scanned onto the **shelf**, never into the catalogue (see
   * CLAUDE_SKILLS_DIR). Not given = skip the other tool's user-level directory
   */
  claudeUserDir?: string
  /** The built-in ones. Passed in by the caller; this file doesn't know their contents */
  builtin?: BuiltinSkill[]
}

/**
 * Gather the skills from all three places.
 *
 * One that fails to read is just one fewer (recorded in problems), not a throw — same
 * rule as the MCP config: when a file someone else wrote has a problem, the price cannot
 * be this program failing to start.
 */
export function discoverSkills(input: DiscoverInput): SkillSet {
  const problems: SkillSet["problems"] = []
  const byName = new Map<string, Skill>()

  for (const one of input.builtin ?? []) {
    // ★ Goes through **the same** parseSkill as the on-disk ones. The built-ins pass this
    //   gate themselves first, so a broken format gives itself away on our own files
    //   instead of surfacing when the user writes their first one
    const parsed = parseSkill(one.text, "", "builtin", one.source)
    if (typeof parsed === "string" || !parsed) {
      problems.push({ source: one.source, why: parsed || "is not a usable skill" })
      continue
    }
    byName.set(parsed.name, { ...parsed, body: substitute(parsed.body, placeholders(input)) })
  }

  const scan = (dir: string, origin: SkillOrigin): void => scanInto(dir, origin, byName, problems)

  // Order is priority; later scans override earlier ones. Ranked by "specific beats
  // general, ours beats theirs":
  // project .alfa > project .claude > user .alfa > built-in
  if (input.userDir) scan(input.userDir, "user")
  scan(join(input.root, CLAUDE_SKILLS_DIR), "project")
  scan(join(input.root, SKILLS_DIR), "project")

  // Set the built-ins aside first; the cap only cuts the on-disk ones (see MAX_SKILLS).
  // One overridden by a same-named project/user skill no longer has origin builtin — it
  // is something the user wrote, so of course it is counted with the rest
  const all = [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
  const compiled = all.filter((one) => one.origin === "builtin")
  const onDisk = all.filter((one) => one.origin !== "builtin")
  const skills = [...compiled, ...onDisk.slice(0, MAX_SKILLS)].toSorted((a, b) => a.name.localeCompare(b.name))

  // The shelf is scanned separately and **set aside once scanned** — it takes part in
  // neither the merge nor the cap: the catalogue's MAX_SKILLS limits "how much is sent
  // each turn", and the shelf sends nothing at all
  // Our own shelf is scanned second so it wins a name clash with ~/.claude/skills
  const shelf = new Map<string, Skill>()
  if (input.claudeUserDir) scanInto(input.claudeUserDir, "library", shelf, problems)
  if (input.libraryDir) scanInto(input.libraryDir, "library", shelf, problems)
  const library = [...shelf.values()]
    .filter((one) => !byName.has(one.name))
    .toSorted((a, b) => a.name.localeCompare(b.name))

  return { skills, library, dropped: Math.max(0, onDisk.length - MAX_SKILLS), problems }
}

function scanInto(
  dir: string,
  origin: SkillOrigin,
  into: Map<string, Skill>,
  problems: SkillSet["problems"],
): void {
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return // no such directory = no skills written yet, not an error
  }
  for (const entry of entries) {
    const found = readSkill(join(dir, entry), entry, origin)
    if (typeof found === "string") {
      problems.push({ source: join(dir, entry), why: found })
      continue
    }
    if (!found) continue
    into.set(found.name, found)
  }
}

/**
 * A skill can be `<name>.md` or `<name>/SKILL.md`.
 *
 * Both are accepted because each has its own legitimate use: a playbook of a few dozen
 * lines should be a single file, while one that brings scripts, templates, sample data
 * needs a folder to hold them. Accept only one and the other usage is either forced out
 * of shape or simply abandoned.
 */
function readSkill(path: string, entry: string, origin: SkillOrigin): Skill | undefined | string {
  let file = path
  let name = entry
  try {
    if (statSync(path).isDirectory()) {
      file = join(path, "SKILL.md")
      statSync(file)
    } else {
      if (!entry.endsWith(".md")) return undefined
      name = entry.slice(0, -3)
    }
  } catch {
    // No SKILL.md in the folder: most likely not a skill at all; skip it quietly
    return undefined
  }

  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    return `could not be read (${(error as Error).message})`
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) {
    text = text.slice(0, MAX_SKILL_BYTES)
  }

  return parseSkill(text, name, origin, file)
}

/**
 * Raw text → one skill. Built-in and on-disk ones both go through here.
 *
 * Returning a string = what is wrong (the sentence `/skills` displays).
 */
export function parseSkill(
  text: string,
  fallbackName: string,
  origin: SkillOrigin,
  source: string,
): Skill | string {
  const parsed = frontmatter(text)
  const finalName = (parsed.fields["name"] ?? fallbackName).trim().toLowerCase()
  if (!NAME.test(finalName)) {
    return `has an unusable name "${finalName}" — use lower-case letters, digits, - and _`
  }
  const description = clipDescription(parsed.fields["description"] ?? firstLine(parsed.body))
  if (description.length === 0) {
    // A skill with no description is a line of noise in the catalogue; the model will
    // never open it
    return `needs a description — that one line is the only thing the model sees until it opens the skill`
  }
  // Take other tools' fields as they come and ignore anything unknown — a skill written
  // for another agent carrying a few extra keys is normal, and rejecting the whole thing
  // over it is the least reasonable kind of failure
  const allowed = parsed.fields["allowed-tools"]?.trim()
  return {
    name: finalName,
    description,
    body: parsed.body,
    origin,
    source,
    ...(allowed ? { allowedTools: allowed } : {}),
  }
}

/**
 * Placeholder values.
 *
 * ★ Only fed to the **built-in** ones. On-disk skills get no substitution — that is text
 *   the user wrote, there are too many legitimate reasons for a pair of braces to appear
 *   in it (template syntax, code samples), and "what I wrote got silently changed" is
 *   one of the hardest kinds of problem to track down.
 */
function placeholders(input: SkillInput & { libraryDir?: string }): Record<string, string> {
  return {
    program: input.program,
    root: input.root,
    envPrefix: ENV_PREFIX,
    // The real absolute path is **fetched live**. It is the one thing the model cannot
    // guess, and a guessed answer sounds just as confident — the user follows it and ends
    // up with a config.json that won't start
    configFile: input.configFile ?? configPath(),
    authFile: input.authFile ?? authPath(),
    // The real path of the user's global directory. It changes whenever XDG changes, and
    // "where does it go" is the first question to get right when writing a skill —
    // getting it wrong shows up as the skill simply never appearing
    skillsDir: input.userDir ?? join(configDir(), "skills"),
    libraryDir: input.libraryDir ?? join(configDir(), LIBRARY_DIR),
  }
}

/** Tiny YAML subset: `key: value`, only between the leading `---` pair. Enough, no deps */
function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const normalized = text.replaceAll("\r\n", "\n")
  if (!normalized.startsWith("---\n")) return { fields: {}, body: normalized.trim() }
  const end = normalized.indexOf("\n---", 3)
  if (end < 0) return { fields: {}, body: normalized.trim() }
  const head = normalized.slice(4, end)
  const fields: Record<string, string> = {}
  for (const line of head.split("\n")) {
    const at = line.indexOf(":")
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) fields[key] = value
  }
  const rest = normalized.slice(end + 4)
  return { fields, body: rest.replace(/^\n+/, "").trim() }
}

/**
 * Clip to one line's length. **Cut at a word and leave an ellipsis** — half a word reads
 * like the program is broken, and this line is the model's entire basis for deciding
 * "should I open it": it has to be able to tell there is more.
 */
function clipDescription(text: string): string {
  const one = text.trim()
  if (one.length <= MAX_DESCRIPTION) return one
  const cut = one.slice(0, MAX_DESCRIPTION - 1)
  const space = cut.lastIndexOf(" ")
  return (space > MAX_DESCRIPTION / 2 ? cut.slice(0, space) : cut).trimEnd() + "…"
}

function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const text = line.replace(/^#+\s*/, "").trim()
    if (text.length > 0) return text
  }
  return ""
}
