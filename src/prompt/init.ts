/**
 * `/init`: turns "how this project gets work done" into a file.
 *
 * ── Why it's needed ──
 * The instructions.ts machinery (AGENTS.md / CLAUDE.md) is the **reading** half, and for
 * a long time it was the only half: if the file is there it goes into the prompt, if not
 * it's as if it didn't exist. And in the vast majority of repos it simply isn't there —
 * so every new session starts from scratch, guessing how this project builds, how it
 * tests, which conventions must not be broken, and the cost of guessing wrong repeats
 * itself more thoroughly with every session.
 *
 * `/init` is the **writing** half. In one go it pins down on disk what the last session
 * pieced together, so the next one already knows it from its first message. Only once
 * that loop is closed does the prompt start growing with the project, instead of being
 * reset to factory settings every time.
 *
 * ── Two jobs: one done by code, one by the model ──
 * The folder is created by code: it looks exactly the same every time and shouldn't be
 * laid out by a model that might change its mind halfway through.
 * AGENTS.md is written by the model: its content can only be answered by reading this
 * repo, and no template can stand in for that.
 *
 * ── Why the conventions file lives at the root and not in .alfa/ ──
 * AGENTS.md is a **cross-tool** convention; Cursor, Codex and Claude Code all read it.
 * Putting it in our own folder would make it private — whatever the user wrote for this
 * project would have to be written again the moment they switch tools. `.alfa/` only
 * holds what genuinely belongs to alfa itself.
 */
import { existsSync, writeFileSync } from "node:fs"
import { ensureDirSync } from "../fs/dir.ts"
import { join } from "node:path"

/** alfa's home base inside the project. */
export const ALFA_DIR = ".alfa"

/** Name of the conventions file. Same thing as PROJECT_FILENAMES[0] in instructions.ts. */
export const AGENTS_FILE = "AGENTS.md"

/**
 * The full text of `.alfa/README.md`.
 *
 * ── Why an empty folder isn't enough ──
 * An empty dot-directory that pops up out of nowhere in `git status` only gets deleted —
 * and rightly so. The folder has to explain for itself what it's for, and **what it
 * doesn't do**: `memory/`, `skills/` and `mcp.json` are read (prompt/memory.ts,
 * prompt/skills.ts, mcp/config.ts), while nothing reads `config.json` — there is no
 * project-level config (prompt/skills/alfa-config.md), and its row says "no" so it
 * reads as a roadmap entry, not a feature. Docs that describe what wasn't done as done
 * cost more than no docs at all.
 */
export const ALFA_README = `# .alfa

alfa's folder for this project, created by \`/init\`.

Project conventions do **not** live here — they live in \`AGENTS.md\` at the
repository root, because every other coding agent reads that file too. This
folder is only for the things that are alfa's own.

| path          | what goes here                                              | live? |
| ------------- | ----------------------------------------------------------- | ----- |
| \`memory/\`     | what alfa has worked out about this project over time      | yes   |
| \`skills/\`     | playbooks — how *this* project does a recurring job          | yes   |
| \`mcp.json\`    | which MCP servers this project uses                          | yes   |
| \`config.json\` | project-level settings (model, check command, and the like)  | no    |

\`memory/\` is one markdown file per note, written by alfa through its \`memory\`
tool and loaded automatically at the start of every later session in this project.
They are ordinary files: read them, and delete one you disagree with — that is the
intended way to correct it.

\`skills/\` is one playbook per file (\`<name>.md\`, or \`<name>/SKILL.md\` when it needs
to carry scripts or templates alongside it). Start each one with a \`---\` block giving
a one-line \`description\`: that line is all alfa sees until it opens the skill, and
opening it is a deliberate step it takes when the work matches. Write the playbook you
would give a new colleague — the sequence, the gotchas, what "done" looks like — not
things that belong in \`AGENTS.md\` (rules that always apply) or \`memory/\` (facts).

\`mcp.json\` names the MCP servers this project uses. A server defined here does not
start until you allow it once with \`/mcp trust <name>\` — it names a command to run.

\`config.json\` is listed so that a file appearing in \`git status\` is not a mystery.
Nothing reads it yet.

Commit this folder if you want your team to share what ends up in it.
`

export interface InitScaffold {
  /**
   * What was **actually created** this time, relative to the project root. Things that
   * already existed aren't listed.
   *
   * Reporting an action that didn't happen is lying: if a second `/init` says "created
   * .alfa/README.md", the user will think what they wrote in it has been overwritten.
   */
  created: string[]
  /** Why creation failed (read-only mount, no permission). If set, don't claim it's done */
  failed?: string
}

/**
 * Create `.alfa/`. Whatever is already there is left exactly as is.
 *
 * If the README exists it is **not overwritten** — the user having added text to it is
 * perfectly normal, and a command that wipes it out is one the user only meets once,
 * after which they never dare press it again.
 */
export function initScaffold(root: string): InitScaffold {
  const created: string[] = []
  try {
    const dir = join(root, ALFA_DIR)
    ensureDirSync(dir)
    const readme = join(dir, "README.md")
    if (!existsSync(readme)) {
      writeFileSync(readme, ALFA_README)
      created.push(`${ALFA_DIR}/README.md`)
    }
  } catch (error) {
    return { created, failed: (error as Error).message }
  }
  return { created }
}

export interface InitPromptInput {
  /** Project root. The conventions file is written under it */
  root: string
  /**
   * One already exists. The wording has to change with it — "write one" and "improve the
   * existing one" are two different jobs
   */
  existing: boolean
  /** The text following `/init`. What the user wants it to focus on */
  note?: string
}

/**
 * The text handed to the model.
 *
 * ── Why it's so long ──
 * Because there are many ways to write a bad AGENTS.md, and each one needs its own
 * block: copying out the directory tree, writing a pile of platitudes true of any repo,
 * guessing the script names in package.json wrong, wiping out paragraphs the user wrote
 * themselves in one sweep. Every prohibition in this text corresponds to a real bad
 * outcome.
 *
 * ── Why no template ──
 * Give it a template and the model fills in boxes: a project with no CI grows an empty
 * CI section. The value of this file lies entirely in "the few things specific to this
 * repo", and boxes are exactly what crowd those out.
 */
export function initPrompt(input: InitPromptInput): string {
  const agents = join(input.root, AGENTS_FILE)
  const lines = [
    `Write the project conventions file for this repository: ${agents}`,
    "",
    "That file is loaded into your system prompt at the start of every future session here, so it is the one place where what you work out about this project survives. Write it for a capable engineer who has never seen this repo.",
    "",
    input.existing
      ? "It already exists. Read it first and improve it in place: keep every line that is still true, fix the ones that are not, add what is missing. Do not delete something merely because you did not get around to checking it."
      : "It does not exist yet — you are writing it from scratch.",
    "",
    "Look before you write: the README, the build and test configuration (package.json scripts, Makefile, pyproject.toml, Cargo.toml, go.mod, CI workflows), the directory layout, and enough source to see the conventions the code actually follows rather than the ones it claims to. If instructions for other agents are lying around (CLAUDE.md, .cursorrules, .cursor/rules/, .github/copilot-instructions.md), read them and fold in what is worth keeping instead of duplicating it.",
    "",
    "Put in:",
    "- The exact commands to install, build, run, test, lint and typecheck — copied out of the configuration, not guessed. You will reach for these every session, and a wrong one costs a failed command every time.",
    "- What this project is, and the few structural facts the file tree does not already say.",
    "- The conventions a newcomer would otherwise break, especially the ones that are unusual here.",
    "- Anything sharp: a setup step that is easy to miss, something that looks broken but is not, a command that must not be run in this repo.",
    "",
    "Leave out: anything a glance at the file tree already answers, advice that would be true of any repository, and a directory listing. Length follows content — a small project deserves a short file.",
    "",
    `Two things to leave alone: the \`${ALFA_DIR}/\` folder (that one is alfa's own, not part of what you are documenting), and version control — do not commit anything.`,
  ]
  // The user's note goes last: it's the only part here that varies from person to
  // person, and the later something comes, the more likely it is to be followed
  if (input.note && input.note.length > 0) {
    lines.push("", `The user asked you to keep this in mind while writing it: ${input.note}`)
  }
  return lines.join("\n")
}
