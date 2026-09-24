# alfa

A code agent for the terminal. Bun + TypeScript, shipped as a single-file binary.

All design notes live in `DESIGN.md` (it doubles as the design log) — **don't move them
into this file**. `README.md` is the landing page: install, get started, what it can do —
it holds no design rationale. This file holds only two things: the defaults that are
**reversed** in this repo, and the pitfalls that **fail silently**.

## Comments: this repo is the opposite of the default

The `DO NOT ADD ***ANY*** COMMENTS` line in the system prompt does not apply here. The
house rule is a note at the top of every file on **why it is this way, what was tried and
didn't work, and what breaks if you remove it**. `src/prompt/agentflow.ts` and
`src/tool/task.ts` are the models — the failed versions recorded there can't be seen
anywhere in the code.

- Write the "why", not the "what". Inline comments that restate what the code does are
  still unwanted.
- `★` marks the point in a block that most needs to be seen and is easiest to break; `⚠`
  marks a hard constraint that doesn't error when broken.
- When you change logic, **first check whether the comment above it has gone stale**. A
  comment explaining the old approach costs more than no comment at all.

## Language: English, except where Chinese is data

Comments, test titles and commit messages are English. Chinese/Japanese in code is
**data** and stays: the `src/i18n/` catalogs, tri-lingual `uiText(en, zh, ja)` / `tr(…)`
calls, the multilingual patterns in `permission/judge.ts` and `tool/untrusted.ts`, and
test inputs that exercise CJK handling.

⚠ Text the **model** reads (tool descriptions and errors) is always
English — the reply language is a separate instruction (`src/i18n/index.ts`). Text the
**user** reads goes through the catalogs or `uiText`, never a bare string.

## Commands

`bun test` / `bun run typecheck` / `bun run build`. The runtime is **bun ≥ 1.3, not node**
(text imports, `--compile` and `bun:test` all depend on it).

**This repo has no lint** — don't go looking for a config, and don't add one on the side.
Running the first two commands is enough before handing work back.

## Pitfalls that don't error

Before changing code, read "Architecture boundaries (read before changing code)" in
DESIGN.md. The four easiest to step on:

- `src/tool/**` must not import `ai` / `@ai-sdk/*`; `src/prompt/**` must not depend on
  `src/cli/**`.
- The tool list **must be sorted** (`tool/registry.ts`) — it is the earliest cache prefix;
  if the order jitters, every request misses.
- `parts[0]` holds only static content; anything that changes goes in `parts[1]`. Putting
  something that varies per session up front = turning the cache off.
- **Adding things takes two steps**: a tool must be registered in `src/tool/builtin.ts`,
  and a built-in skill needs a line in `src/prompt/builtin-skills.ts` (plus the list in
  `test/skills.test.ts`). Do only the first step and the symptom is that it **simply
  doesn't exist**.
- **Code, tests and CI must not depend on DESIGN.md or its entries** (see its header):
  the reason goes in the comment above the code, where it can't drift away from what it
  explains. Nothing checks this; a pointer into the log just quietly goes stale.

Whether a piece of knowledge belongs in the system prompt or in a skill comes down to one
test: "irreplaceable when it's needed, unused in nine turns out of ten → skill". And that
test only works for **knowledge**, not for **behavior shaping** — the model won't go and
open a skill that constrains itself. See the ★ in `src/prompt/builtin-skills.ts`.

## Tests

Titles say **what this test guards**. Put the reason above any counter-intuitive
assertion.

⚠ Several tests assert **specific sentences** in the templates and tool descriptions, and
what they guard is **the deletion itself** (in `test/prompt.test.ts`: "neither template
mentions tools we don't have" and "neither template may bring back the 'just stop when
done' line"). When a test goes red, first ask whether you deleted a sentence it guards.

## Commits

English, prefixed `feat:` / `fix:` / `docs:` / `release:`; the subject says what changed
and why. **No `Co-Authored-By`**, and no AI attribution of any kind. If the change carries
weight, add an entry to the status section of DESIGN.md (write down the criterion
and where the asymmetry lies, not a changelog). Bug fixes and copy tweaks only bump the
patch version.
