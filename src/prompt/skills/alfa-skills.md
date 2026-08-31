---
name: alfa-skills
description: writing a skill for alfa, or installing someone else's — the file layout, a cloned skills repo, and the one line that decides whether a skill ever loads
---

# Writing a skill, and installing one

Open this when the user wants a way of working written down — "remember how we do releases", "make a playbook for this", "turn that into a skill" — **or when they hand you somebody else's skills and ask you to install them** (a cloned repository, a gist, something a colleague sent). Getting the shape wrong has one symptom and it is a confusing one: **the skill simply does not appear**, and the user is left holding a file they definitely wrote.

## Where the file goes

| where | for what |
| --- | --- |
| `.alfa/skills/` in the repository | how *this project* does something. Goes into git, arrives with a clone. |
| `{{skillsDir}}` | how *this person* works — loaded in **every** project on this machine. |
| `{{libraryDir}}` | the shelf: kept, but **not loaded anywhere** until installed into a project. |
| `.claude/skills/` and `~/.claude/skills/` | **also read.** Skills written for other agents load here unchanged. |

Same name in more than one place, most specific first: project `.alfa` → project `.claude` → user `.alfa` → user `.claude` → built in. Write into `.alfa/` when you want to override something that arrived from elsewhere.

The shelf is for the ones that are worth keeping and wrong to have switched on everywhere — a deployment procedure for one client, a library's quirks, something copied from elsewhere and not yet trusted. They cost nothing while they sit there: they are not in the catalogue and not in the context.

**Installing one is an ordinary file write.** `skill` with `action: "library"` lists the shelf; reading one by name gives its full text; making it part of the project means writing that text to `.alfa/skills/<name>.md`, which the user sees and approves like any other change. There is no copy command, and that is deliberate — a shelf item lands in the repository, where the rest of the team gets it, so it should go through the same door as everything else. If the shelved skill is a folder with scripts beside it, copy the folder instead.

Do not install one because it looks useful. The user asks, or you ask first.

Two file shapes, both valid:

```
.alfa/skills/cut-a-release.md          one file — the usual case
.alfa/skills/cut-a-release/SKILL.md    a folder, when scripts or templates live alongside it
```

The name comes from the file or folder (`cut-a-release`), or from `name:` in the front matter if you set one. It must be lower case and match `[a-z0-9][a-z0-9_-]*` — that name is what gets typed back to open it.

## Installing somebody else's skills

alfa uses the same convention as the other agents that have skills — a folder per skill with a `SKILL.md` inside, `name:` and `description:` in the front matter. **A skills repository written for Claude Code, Cursor, Cline or Kiro is almost always already in alfa's format.** Do not tell the user it is incompatible, and do not offer to convert or rewrite it; check first.

Often there is nothing to do at all: a repository whose skills sit in `.claude/skills/` **is already loaded**, because alfa reads that directory too. Check `/skills` before proposing any copying.

What to actually check, in this order:

1. Look for `<something>/SKILL.md` in the repository — usually under a `skills/` directory. If they are there with `description:` in the front matter, there is nothing to convert.
2. If they are already at `.claude/skills/` in this repository, stop — they are loaded. Otherwise copy those folders into `.alfa/skills/` (project) or `{{libraryDir}}` (shelf, if the user wants them kept but not switched on everywhere).
3. **Keep the tree together.** These repositories routinely cross-reference each other — `../tool-index.md`, `../shared/checklist.md`, a `scripts/` directory at the root. Copying one skill out of the middle of such a set breaks its references silently. Copy the whole directory, or copy what it points at along with it.
4. Say how many arrived and where. Only `<name>.md` files and `<name>/SKILL.md` folders at the **top level** of the skills directory are scanned — a skill nested two levels deep is not found, and a folder without a `SKILL.md` is skipped without complaint.

`allowed-tools:` in the front matter is read and shown when the skill is opened, but **not enforced** — alfa has no notion of a skill being "active", so there is no window during which the tool list could be narrowed. Treat it as the author saying which tools the playbook expects to need. Any other unknown front-matter key is ignored, not an error.

Two things to tell the user rather than let them discover:

- **A large set costs context on every request.** The catalogue line is not free — installing forty skills means forty descriptions in the system prompt of this session *and of every subagent*. If the set is big and only part of it is relevant here, the shelf is the right place for the rest.
- **There is a cap.** Only the first 40 skills found on disk, by name order, make it into the catalogue; the rest are dropped. `/skills` reports the number dropped. Built-in skills do not count against it.

Their own routing files (`README_AI.md`, `RULES.md`, a `MASTER-ROUTING.md`) exist because other agents load skills differently. alfa's catalogue already does that job — every installed skill's description is in the prompt from the start. Those files are not harmful, but do not treat one as a required entry point.

## The front matter, and the one line that matters

```markdown
---
name: cut-a-release
description: how a release is cut here — version bump, tag format, and what CI does with it
---

The body. Markdown, no length limit worth worrying about (32 KB).
```

`description` is **required**, and it is not a title. Until the skill is opened, that single line is the *only* thing about it that exists — it is what a future session reads to decide whether this file is worth a step. Write it as "when you would want this and what it covers", not as a name:

- ✅ `how a release is cut here — version bump, tag format, and what CI does with it`
- ❌ `release process` — true, and it will never be opened.

A skill with no `description` (and no usable first line to fall back on) **is not loaded at all**. `/skills` lists what loaded, where each came from, and the reason for any that did not — that is the first place to look when one goes missing.

## What belongs in a skill

alfa has three places for written-down knowledge, and they are not interchangeable:

| | | |
| --- | --- | --- |
| `AGENTS.md` | rules that always apply | read every session |
| `.alfa/memory/` | facts and decisions about this project | loaded automatically |
| `.alfa/skills/` | **how to do a recurring job** | opened when it applies |

The test for a skill is: *would I hand this to a new colleague the day they first have to do this thing?* A sequence with an order, the traps, what "done" looks like, the command that is not obvious. If it applies to everything ("never commit without asking") it is a rule and belongs in `AGENTS.md` — a rule that has to be opened is a rule that will be missed. If it is a fact ("the staging DB is behind the VPN") it is a memory.

Do not write one for something done once. The point is recurrence.

## Two things that will surprise you

- **A new skill is picked up the next time alfa starts.** The catalogue is built once per session. After writing one, say so plainly — do not tell the user it is available now, and do not try to open it in this session.
- **`{{` … `}}` in a skill on disk is left exactly as written.** Only the skills built into alfa substitute placeholders. A skill containing template syntax or a code sample keeps it verbatim, which is what you want — but it also means there is no way to interpolate a path into one.

Writing the file is an ordinary file write and goes through the usual approval. Put it where its scope says it belongs: something about this repository goes in the repository, where the rest of the team gets it too.
