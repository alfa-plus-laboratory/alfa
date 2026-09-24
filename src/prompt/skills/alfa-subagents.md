---
name: alfa-subagents
description: running subagents well — chaining with after, waking with resume, picking model/effort/tools, keeping two from colliding, what job tells you
---

# Running subagents

The `task` tool's own description covers what a subagent is and what to do the moment you start one. This is the rest: what decides whether a fleet of them is cheaper than doing the work yourself.

## Chaining with `after`

`after: ["scout", "scout-2"]` holds a subagent until both have finished, then starts it with their reports already pasted at the top of its brief. So the brief only has to say what to *do* with them.

That lets you lay out the whole shape of the work in **one turn** — fan out, then have something check or merge what came back — instead of waking up between every stage to hand results along yourself.

The part that makes it affordable is easy to miss: **a subagent that something else is waiting on delivers its answer to that job, not to this conversation.** Twelve finders would otherwise dump twelve reports into your context, and keeping that out was the entire reason to send them. You can still read any of them with `job`.

Two constraints:

- `after` names only subagents you started earlier in *this* conversation.
- `after` is for new subagents. It does not combine with `resume`.

## Waking one up with `resume`

A finished subagent keeps its whole conversation — every file it read, every command it ran. `resume` wakes it, so the follow-up brief only says what is new ("also check whether anything calls it from the tests"). This never expires; one from an hour ago is still there. `job list` shows such a one as "suspended", and `job suspend` puts a working one in the same state. When you judge a subagent will not be needed again, `job kill` removes it for good — it leaves `job list` and can't be resumed; otherwise suspend it.

Its context is what makes it cheap, and it is also what makes it expensive: **every further round re-sends that whole conversation.** So:

- Resume when the follow-up is about the *same* work.
- For a different job, start a fresh one. A blank agent that reads three files costs less than a stale one that remembers thirty.
- Only a subagent that has **finished** can be resumed. One still working will answer on its own — wait for that answer first.

## Choosing model, effort and tools

All three default to yours. Change them when the job is plainly different from the conversation's:

- **tools** is the only hard limit. `["read", "grep", "glob"]` is an investigation that *cannot* edit or run anything, whatever the brief says; add `bash` only if it must run commands, `webfetch`/`websearch` only if it must go online. Leaving out `skill` means it cannot open a skill you named in the brief.
- **model**: a smaller, faster model for broad, mechanical work — scanning many files, listing call sites, summarising a directory. Keep the strong one for anything where the answer is a judgement: a review, a design, a root cause. A bare model name stays on your provider; `provider/model` picks another. If you don't know what is configured, a wrong name fails with the list — nothing is spent.
- **effort**: `low` for finding and listing, the conversation's level or higher for reasoning-heavy work. It does not change what it can do, only how long it thinks before each step.

Only set these when the user asked for it or the job clearly calls for it — a scout that misses the answer because it was cheap costs more than it saved. A resumed subagent keeps its setup; for a different one, start a new subagent.

## Territory, when they write

Subagents edit files and run commands through the same permission gate you do, and while one runs a permission prompt can appear in front of the user with its name on it.

Two of them editing the same file at the same time produce a mess, and **nothing merges anything for you**. Waiting on each other does not prevent it either — only the briefs do. So split by file or by directory, or do the editing yourself once they report back. Read-only briefs (find, read, summarise) are where a subagent pays for itself most clearly.

## What `job` adds

Their final answers arrive on their own, so you never *have* to read a subagent's output. Read it when the user asks how one is going, or to see whether one taking a very long time is still moving.

- `list` already answers "what is it doing" — a running subagent shows how long it has been going and the tool call it is on right now. Read it once, say it in a line, stop.
- Output is incremental: each read gives you only what is new, so repeated reads are cheap and never repeat themselves. For a subagent it is one line per tool call.
- `wait` is for **processes**, not subagents. There is nothing to wait for with a subagent — say one short line and stop, and you will be woken when the answer lands.
