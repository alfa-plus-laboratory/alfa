/**
 * The ask tool: stop and ask the user one thing, offering a few options to pick from.
 *
 * ── Why this deserves a tool ──
 * The model can already ask questions in its reply, but only once **this turn ends**. So
 * at a fork it has just two choices: guess one and carry on (if wrong, a dozen-odd steps
 * wasted), or stop and spend a whole turn of conversation on "which one do you want?" —
 * and when the user replies "the second one", it has to pick the context back up from
 * scratch. As a tool, the question happens **in the middle of its work**: ask, take the
 * answer, keep going; one turn is enough.
 *
 * ── Why options rather than free-form questions ──
 * "How would you like to handle this?" makes the user compose a paragraph; "A or B?" is
 * one keypress. And nine times out of ten, where the model is really stuck converges to a
 * few options — it has already thought the possibilities through; all it lacks is
 * **which one**. Options have a side effect too: a question that can't be turned into
 * options usually means the model hasn't thought it through itself, and at that point it
 * should go read a couple more files, not come ask a person.
 *
 * ── But options are never enough, so there is always a type-your-own slot ──
 * The most realistic case in a terminal is "none of the three you gave is right". So the
 * UI always has a type-your-own row below the options (typing anything lands there, see
 * cli/ask.ts); what is typed goes back to the model as a **new instruction**, not as a
 * fourth option.
 *
 * ── When there is nobody to ask, say so immediately; no waiting ──
 * In `-p`, a pipe, or CI, nobody is going to press a key. Then the tool answers on the
 * spot "nobody is here", and lets the model decide for itself and state what it assumed
 * — hanging there waiting for an answer that will never come is the worst way for this
 * kind of tool to fail: it looks like a hang, and there is no error at all.
 */
import { z } from "zod"
import type { Answer, QuestionOption, ToolDef } from "./types.ts"

/**
 * Max number of options. Any more and it should narrow things down first — a terminal
 * screen can't fit them, and a person can't choose among them
 */
const MAX_OPTIONS = 6
/**
 * Max number of questions per call.
 *
 * ── Why several are allowed ──
 * With one tool call per question, three forks mean three rounds of "tool result →
 * resend the whole history → a new reply". In those three rounds the model does no work
 * at all, yet each one resends the entire context — three questions cost three times the
 * history, not three times the questions. Batched into one call, the user answers three
 * times in a row, and for the model it counts as one.
 *
 * ── Why 4 and not any number ──
 * Four prompts in one go is already the upper limit of an interruption. More importantly:
 * asking them together presupposes the questions are **independent of each other** — and
 * truly independent forks rarely number more than three or four; the filler ones are
 * mostly "no need to ask once the first is answered".
 */
const MAX_QUESTIONS = 4
/** Max length of an option itself. It is an "answer", not an explanation */
const MAX_LABEL = 80
/** Max length of the extra description line */
const MAX_DESCRIPTION = 120

const Parameters = z.object({
  questions: z
    .array(
      z.object({
        question: z
          .string()
          .describe('The question, as one sentence. e.g. "Which database should the new service use?"'),
        options: z
          .array(
            z.object({
              label: z.string().describe("The answer itself, a few words. This is what comes back to you."),
              description: z
                .string()
                .optional()
                .describe("One line: what picking this means, or what it costs. Omit it rather than padding."),
            }),
          )
          .describe(`Between 2 and ${MAX_OPTIONS} options, best first.`),
        multiple: z
          .boolean()
          .optional()
          .describe("True if the user may pick several. Default false (exactly one)."),
      }),
    )
    .describe(
      `1 to ${MAX_QUESTIONS} questions, asked one after another in a single interruption. ` +
        `Only batch questions that are independent of each other.`,
    ),
})

type Args = z.infer<typeof Parameters>

const DESCRIPTION = `Asks the user up to ${MAX_QUESTIONS} multiple-choice questions and waits for the answers.

Use it when you are at a fork you cannot resolve from the code or the request, and picking wrong would waste real work: which of two designs to follow, which of three files they meant, whether to include something with a cost. The user answers with one keypress each, and you keep going in the same turn.

Ask everything you need in ONE call. Each separate call is another round trip that resends the whole conversation, so three calls cost three times the history for three keypresses.

Do NOT use it for:
- Anything you can answer yourself by reading the repository. Go read it.
- Permission to do something. That has its own path; just do the thing and the user will be asked if it needs approving.
- "Shall I continue?" / "Does this look right?" — say what you did and continue.
- A question with no real options, or where every option is the same to the user.

Usage rules:
- Batch only questions that are INDEPENDENT. If the answer to one decides whether another matters — or changes its options — ask that one alone and come back with the rest. Answering a question that turned out to be moot is worse than a second call.
- Order them the way you would say them out loud: the most consequential first.
- ${MAX_OPTIONS} options per question at most, and each must be a real answer, not a placeholder like "other" — the user always has a free-text choice of their own.
- The user may type something else entirely, or dismiss a question. Both come back to you as such: a typed answer outranks the options you offered, and a dismissed question means move on with your best judgement, not ask again.
- In a non-interactive run (piped input, -p) there is nobody to answer. You will be told so; decide yourself and state the assumption you made.`

export const AskTool: ToolDef<Args> = {
  id: "ask",
  description: DESCRIPTION,
  parameters: Parameters,

  async execute(args, ctx) {
    const asked = (args.questions ?? []).slice(0, MAX_QUESTIONS).map((raw) => ({
      question: (raw.question ?? "").replaceAll(/\s+/g, " ").trim(),
      options: normalize(raw.options ?? []),
      multiple: raw.multiple === true,
    }))
    if (asked.length === 0) throw new Error("questions is required: at least one question with its options.")
    for (const item of asked) {
      if (item.question.length === 0) throw new Error("Every question needs its text.")
      if (item.options.length < 2) {
        throw new Error(
          `"${item.question}" has fewer than 2 options. A question with one answer is not a question — ` +
            `just do it, or say what you are about to do.`,
        )
      }
    }

    // Goes through the gatekeeper, for the same reason as todo: this tool has no side
    // effects, but "it can be denied" has to hold — some people will want an agent that
    // never interrupts them
    await ctx.ask({ permission: "ask", patterns: ["*"] })
    ctx.metadata({ questions: asked.map((item) => item.question) })

    if (!ctx.inquire) return unavailable(asked.map((item) => item.question))

    // ★ Asked one at a time, but **counted as one tool call**. Three prompts on screen at
    //   once are unreadable, and what is saved is three rounds of "tool result → resend
    //   the whole history → a new reply" — the expensive part was never the questions
    //
    // ── Why an index cursor and not for-of ──
    // Because you can **go back**. Reaching the third question and only then wondering
    // "what did I pick for the first one" used to leave one option: cancel the whole set
    // and start over. In the UI ← goes back one question (see cli/ask.ts), and that
    // revisit carries the previous answer (previous): what was ticked is still ticked,
    // what was typed is still there.
    //
    // ★ "Back to the previous question" **never flows to the model**: it is navigation,
    //   consumed right here in this loop. The model sees only the final answers — how
    //   many times the user changed their mind is none of its business.
    const given: Array<Answer | undefined> = new Array(asked.length).fill(undefined)
    let at = 0
    while (at < asked.length) {
      const item = asked[at]!
      const previous = given[at]
      const answer = await ctx.inquire({
        question: item.question,
        options: item.options,
        multiple: item.multiple,
        position: { index: at + 1, total: asked.length },
        ...(previous ? { previous } : {}),
      })
      // If there is nobody to ask, every remaining answer would be the same line; stop
      // asking
      if (answer.kind === "unavailable") {
        return unavailable(asked.slice(at).map((each) => each.question))
      }
      if (answer.kind === "back") {
        // The UI doesn't offer this key on the first question. If it arrives anyway, just
        // stay put; it must not go negative
        at = Math.max(0, at - 1)
        continue
      }
      given[at] = answer
      at++
      // The user interrupted this turn: don't pop the rest. Continuing would be fighting
      // someone who just pressed Ctrl-C
      if (ctx.abortSignal.aborted) break
    }

    // Gaps left by an interrupt are skipped by question number (not renumbered): the model
    // has to be able to match each answer to its question
    const answers = asked
      .map((item, index) => ({ question: item.question, answer: given[index], index }))
      .filter((each): each is { question: string; answer: Answer; index: number } => each.answer !== undefined)

    ctx.metadata({
      answer: answers.map((each) => describe(each.answer)).join(" · "),
      // Each question with its answer, for the rows the UI hangs under the result line —
      // the card that asked them is gone from the screen once answered (see cli/ask.ts)
      asked: answers.map((each) => ({ question: each.question, kind: each.answer.kind, answer: describe(each.answer) })),
    })
    const answered = answers.some((each) => each.answer.kind === "picked" || each.answer.kind === "typed")

    return {
      output: [
        answers.length === 1 ? "The user answered:" : `The user answered ${answers.length} questions:`,
        "",
        ...answers.map((each) => renderAnswer(each.question, each.answer, each.index + 1, asked.length)),
        ...(answers.some((each) => each.answer.kind === "typed")
          ? ["", "An answer in their own words is an instruction: it replaces the options you offered for that question."]
          : []),
        ...(answers.some((each) => each.answer.kind === "cancelled")
          ? [
              "",
              "A dismissed question means: do not ask it again. Continue with the most reasonable option and " +
                "say which one you took and why.",
            ]
          : []),
      ].join("\n"),
      title: summarize(answers),
      metadata: { truncated: false, answered, questions: answers.length },
    }
  },
}

/**
 * Two lines per question and answer. Numbered because several may have been asked at
 * once, and the model has to match up which is which
 */
function renderAnswer(question: string, answer: Answer, index: number, total: number): string {
  const mark = total > 1 ? `${index}. ` : ""
  switch (answer.kind) {
    case "picked":
      // Return the option text verbatim, not the index — an index makes the model look it
      // up again, and when it looks it up wrong there is no error; it just goes off and
      // works on a different option
      return `${mark}${question}\n   -> ${answer.choices.join(" / ")}`
    case "typed":
      return `${mark}${question}\n   -> (in their own words) ${answer.text}`
    default:
      return `${mark}${question}\n   -> (dismissed without answering)`
  }
}

/**
 * Card title: the first answer + how many more. One line can't hold three answers, and the
 * first one is the most important
 */
function summarize(answers: Array<{ answer: Answer }>): string {
  const first = answers[0]?.answer
  const head =
    first?.kind === "picked" ? first.choices.join(", ") : first?.kind === "typed" ? first.text : "dismissed"
  return answers.length > 1 ? `${firstLine(head)} +${answers.length - 1}` : firstLine(head)
}

/**
 * Nobody to ask. **Not an error** — an error would make the model think it used the tool
 * wrong, and then try again
 */
function unavailable(questions: string[]): {
  output: string
  title: string
  metadata: { truncated: boolean; answered: boolean; unavailable: boolean }
} {
  return {
    output:
      `There is nobody to answer this run (non-interactive: piped input, -p, or no terminal).\n` +
      `Decide it yourself, do the work, and state plainly which way you went and what you assumed.\n` +
      `Unanswered:\n${questions.map((question) => `- ${question}`).join("\n")}`,
    title: "nobody to ask",
    metadata: { truncated: false, answered: false, unavailable: true },
  }
}

/**
 * Tidy up the options.
 *
 * Deduplication is necessary: the model occasionally writes the same idea twice (with
 * slightly different wording), and two identical options on screen make the user think
 * they misread. Empty ones are simply dropped, no error — a wasted tool call costs more
 * than "one fewer obviously-filler option".
 */
function normalize(options: readonly { label: string; description?: string }[]): QuestionOption[] {
  const out: QuestionOption[] = []
  const seen = new Set<string>()
  for (const option of options) {
    const label = clamp(option.label ?? "", MAX_LABEL)
    if (label.length === 0) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const description = clamp(option.description ?? "", MAX_DESCRIPTION)
    out.push(description.length > 0 ? { label, description } : { label })
    if (out.length >= MAX_OPTIONS) break
  }
  return out
}

function clamp(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim()
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? ""
  return line.length > 60 ? line.slice(0, 59) + "…" : line
}

/**
 * One line for metadata — which is also what the screen keeps of the answer: the `↳`
 * result line, and the per-question rows under it (askedRows in cli/render.ts)
 */
function describe(answer: Answer): string {
  switch (answer.kind) {
    case "picked":
      return answer.choices.join(", ")
    case "typed":
      return answer.text
    default:
      return answer.kind
  }
}
