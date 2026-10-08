/**
 * recall tool: read back what this session said and did, including what compaction folded.
 *
 * ── Why ──
 * A compaction summary is lossy by design, and before this the loss was final for the
 * model: the originals stayed in the store (`/resume` replays them for the user) but it
 * had no way to look. What the summarizer dropped — an exact error, an option the user
 * turned down, the command line that finally worked — had to be rediscovered or, worse,
 * reconstructed from memory and stated as fact. The summary now ends with an index of
 * folded turns (see withHistoryIndex in agent/compact.ts), and this reads them back.
 *
 * ── Two ways in ──
 * `turn` reads one turn whole, paged; `query` searches every turn for pieces holding all
 * its words. The index answers "which turn", the search answers "where was that said" when
 * the index line doesn't show it. No semantic search: the words the model remembers are
 * usually the exact ones it needs (a file name, an error code), and a miss says so plainly.
 *
 * ── Boundary ──
 * src/tool doesn't know the store. The history comes in through ctx.history, wired by the
 * CLI (cli/main.ts); turn cutting and rendering live in session/turns.ts, shared with the
 * index so a number in the index and a number here are always the same turn.
 * ⚠ Reads only this session. Another session's history is another user's conversation as
 *   far as this model knows; reaching it goes through `message`, not here.
 */
import { z } from "zod"
import { renderTurn, searchTurns, splitTurns, turnLine } from "../session/turns.ts"
import type { ToolDef } from "./types.ts"

/** One page of a read-back. A turn of a long build-out runs to hundreds of KB */
const PAGE = 24_000
const MAX_HITS = 12

const Parameters = z.object({
  turn: z.number().int().positive().optional().describe("Read this turn back in full (the number from the HISTORY INDEX)."),
  query: z.string().optional().describe("Search every turn for pieces containing all of these words, ignoring case. Newest first."),
  offset: z.number().int().nonnegative().optional().describe("With turn: where to continue a long turn, as the previous page said."),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Reads back this session's own history, including the turns a compaction folded out of your context. After a compaction the summary ends with a HISTORY INDEX of folded turns; their original messages are still stored.

- turn: N reads turn N in full — the user's words, your replies, every tool call with its result — in pages.
- query: "words" lists the pieces of any turn that contain all the words, newest first, with their turn numbers.
- With neither, it lists every turn of the session, one line each.

Use it when the summary leaves out something that was said, decided or seen: an exact error, what the user ruled out, a command that worked. It shows what was true then; for what is on disk now, read the file again.`

export const RecallTool: ToolDef<Args> = {
  id: "recall",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    // Reads only this session's own record. In the permission table like context, so
    // someone who wants it off has a place to write that (see permission/rules.ts)
    await ctx.ask({ permission: "recall", patterns: ["*"] })
    const history = ctx.history?.()
    if (!history) return { output: "Session history is not available in this run.", metadata: { truncated: false } }
    const turns = splitTurns(history)
    if (turns.length === 0) return { output: "This session has no history yet.", metadata: { truncated: false } }

    if (args.turn !== undefined) {
      const turn = turns.find(one => one.number === args.turn)
      if (!turn) throw new Error(`There is no turn ${args.turn}; this session has turns 1–${turns.length}.`)
      const text = renderTurn(turn)
      const offset = Math.min(args.offset ?? 0, text.length)
      const page = text.slice(offset, offset + PAGE)
      const next = offset + page.length
      const more = next < text.length
      return {
        output: page + (more ? `\n\n…(${text.length - next} more characters: recall turn ${turn.number} with offset ${next})` : ""),
        title: `turn ${turn.number}`,
        metadata: { truncated: more, turn: turn.number },
      }
    }

    const query = args.query?.trim() ?? ""
    if (query.length > 0) {
      const hits = searchTurns(turns, query)
      if (hits.length === 0) return { output: `Nothing in this session's ${turns.length} turns contains all of: ${query}`, title: query, metadata: { truncated: false, hits: 0 } }
      const shown = hits.slice(0, MAX_HITS)
      const lines = shown.map(hit => `turn ${hit.turn} · ${hit.where}: ${hit.snippet}`)
      if (hits.length > shown.length) lines.push(`…and ${hits.length - shown.length} more; narrow the query or read a turn whole.`)
      return { output: lines.join("\n"), title: query, metadata: { truncated: hits.length > shown.length, hits: hits.length } }
    }

    return { output: turns.map(turnLine).join("\n"), title: `${turns.length} turns`, metadata: { truncated: false } }
  },
}
