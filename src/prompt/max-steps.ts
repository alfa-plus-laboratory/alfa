/**
 * Step limit.
 *
 * This isn't the safety valve against "running amok" — the permission layer is. What it
 * guards against is **silent infinite loops**: the model editing the same file over and
 * over, grepping for the same word over and over; every step is legitimate, and
 * together they burn money.
 *
 * What happens at the limit matters: **not a hard cut-off**, but one last turn, with the
 * tools switched off (toolChoice: 'none') and the text below injected, so that it
 * reports its progress in plain text.
 * With a hard cut-off, the user sees a session broken off halfway, with no idea how far
 * the model got or what's still missing.
 */
export const MAX_STEPS = 100

export const MAX_STEPS_PROMPT = [
  "<system-reminder>",
  `You have reached the maximum number of tool-use steps (${MAX_STEPS}) for this turn.`,
  "No further tool calls are possible. Respond now with text only:",
  "- What you accomplished",
  "- What is left unfinished, and precisely where you stopped",
  "- The exact next step you would take, so the user can continue by simply saying so",
  "Do not apologize at length. Be specific and factual.",
  "</system-reminder>",
].join("\n")
