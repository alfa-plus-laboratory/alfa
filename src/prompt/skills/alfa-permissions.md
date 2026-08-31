---
name: alfa-permissions
description: how alfa decides what needs asking — the three modes, what the built-in rules allow, and how "don't ask again" is remembered
---

# How permission works in alfa

Every tool call passes a gate that answers one of three things: **allow** (run it), **ask** (put it in front of the user), **deny** (refuse, and never negotiable). When the user asks why they were interrupted — or why they were *not* — this is the machinery.

## The three modes

`/permission` shows the current one and switches it; **shift-tab** cycles. The choice is remembered across restarts, and the startup banner prints it when it is not the default, because a security boundary that survives a week without being visible is one nobody remembers setting.

| mode | what it means |
| --- | --- |
| `confirm` | ask before every tool call, including reads |
| `default` | the built-in rules below decide |
| `trust` | run everything the rules do not outright deny |

`trust` is worth naming precisely, because its old name (`auto`) was a lie: **nothing is judging on the user's behalf.** There is no model checking each command. Trust is something the user grants, not something the program works out — so in that mode the only thing still standing between a tool call and the machine is the `deny` list.

`{{program}} -p` (one-shot, non-interactive) has nobody to ask: a call that needs asking fails rather than hanging.

## What the built-in rules say

The table lives in the program (`permission/rules.ts`); **there is no way to edit it from `config.json` today** — do not invent a config key for it. Its shape is `permission` (a family, usually the tool name) plus a pattern (a path, a command, a URL, `server/tool`), and the first match in order wins. Anything not matched falls through to **ask**.

The parts worth knowing:

- **read** is allowed, with exceptions that ask: credential-shaped paths (`.env`, key material, shell history and the like). Reading is not free — a file read into the conversation is a file written to disk in the session store.
- **edit / write** are allowed, and that default is bought by something specific: **the diff is printed**. A change you cannot see is a change nobody approved. Two places still ask no matter what: `.git/` and `.github/workflows/` — one rewrites history, the other runs code on someone else's machine.
- **bash** asks by default, with a whitelist of read-only and project-local commands. It also asks *regardless* of any allow rule when the command's **structure** is risky rather than its name: a sub-shell, a redirect, privilege escalation, something reaching the network. Pipes are not in that list; each segment is judged on its own.
- **webfetch / websearch / mcp** always ask, and deliberately have no whitelist. For the network the risk is not *which site* but **who chose it** — a URL can come from a page, an issue, a README, and those are not the user's words. For MCP, what a tool does is known only to whoever wrote the server; its own `readOnlyHint`-style annotations are not used for this decision, because that would be letting the audited party write the audit.
- **ask / task / todo / context / skill** are allowed: they do not touch the disk, the network, or a process.

## "Don't ask again"

Choosing **always** in a prompt stores a rule that survives restarts. Three properties matter when explaining it:

- **Only `allow` is ever stored.** There is no remembered "no" — a refusal is about this moment, not forever.
- **It is per workspace**, keyed by the repository root, so an approval given in one project does not follow the user into another.
- **It is narrowed, not literal.** Approving a URL remembers the origin, not the exact page; approving a command remembers its shape. Storing the literal string would mean being asked again on the next page, and storing `*` would mean never being asked again at all.

`/permission` lists what has been remembered; `/permission forget` clears them for this workspace. That command is the answer to "why did it stop asking me about X" — and it is worth offering, because remembered approvals are exactly the kind of invisible automation people forget they set up.

## When a call is refused

A denial comes back as a tool result, not a crash: the work stops, the reason is stated, and the right move is to ask the user how they want to proceed — **not** to retry the same call, and not to find a way around it. Reaching for `bash` to do something a refused tool would have done is going around the user's decision, which is the one thing the gate cannot catch.
