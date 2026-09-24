/**
 * Fuzzy replacement cascade — the heart of the edit tool, a pure function with zero IO.
 *
 * Ported from opencode's packages/opencode/src/tool/edit.ts (MIT License,
 * Copyright (c) 2025 opencode). Changes: Effect removed, 4 of the 9 levels cut (see the
 * notes near the end), and the assertions noUncheckedIndexedAccess needs added.
 *
 * ── What it solves ──
 * The model copies a chunk of code back from read's output to do search-and-replace, and
 * the usual deviations are: overall indentation eaten or added, whitespace inside a line
 * tidied into single spaces, an extra blank line at the start or end, or only the head and
 * tail of a function remembered with the middle lines rewritten from memory. Once an exact
 * indexOf misses, it has to read again and retry — a whole LLM round trip wasted. The
 * cascade catches these deviations by relaxing step by step.
 *
 * ── Key semantics (be sure you understand these before changing anything) ──
 * 1. A Replacer yields "real fragments of the original text", not indices. The outer loop
 *    re-locates every one with indexOf, so a candidate must appear verbatim in the
 *    original.
 * 2. The short-circuit rule is not "stop at whichever level found a unique match" but
 *    "return the whole result on the first usable candidate".
 * 3. notFound is **sticky**: once any candidate has ever been located (even if none was
 *    unique), the final error is "multiple matches", not "could not find". Those two error
 *    messages are self-correction signals for the model (add context vs re-read the file)
 *    and must not be mixed up.
 * 4. A hit on isDisproportionateMatch is a **throw that aborts**, not a continue — better
 *    to make the model start over than to silently delete dozens of lines.
 */

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65

export const ERR_IDENTICAL = "No changes to apply: oldString and newString are identical."
export const ERR_EMPTY_OLD =
  "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement."
export const ERR_NOT_FOUND =
  "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings."
export const ERR_MULTIPLE =
  "Found multiple matches for oldString. Provide more surrounding context to make the match unique."
export const ERR_DISPROPORTIONATE =
  "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement."

// ─────────────────────────────────────────────────────── Helpers

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length)
  const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    const rowPrev = matrix[i - 1]!
    const row = matrix[i]!
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row[j] = Math.min(rowPrev[j]! + 1, row[j - 1]! + 1, rowPrev[j - 1]! + cost)
    }
  }
  return matrix[a.length]![b.length]!
}

/**
 * Turn "lines startLine..endLine" back into the real substring of the original text.
 *
 * split("\n") followed by join("\n") over a contiguous range equals the original verbatim,
 * so there is no need to hand-compute byte offsets as the original implementation did —
 * that offset accumulation was only there to get indices, and what we want is the text
 * itself.
 */
function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine, endLine + 1).join("\n")
}

/** Strip the common minimum indentation from every non-blank line. */
function removeIndentation(text: string): string {
  const lines = text.split("\n")
  const indents = lines.filter((l) => l.trim().length > 0).map((l) => l.length - l.trimStart().length)
  const min = indents.length > 0 ? Math.min(...indents) : 0
  if (min === 0) return text
  return lines.map((l) => (l.trim().length > 0 ? l.slice(min) : l)).join("\n")
}

// ─────────────────────────────────────────────────────── The five Replacer levels

/** 1. Exact match. If it isn't in the original, the outer indexOf filters it out. */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

/**
 * 2. Compare line by line after trim. Handles wrong overall indentation and trailing
 *    spaces. May yield several candidates (the outer loop sifts them with the uniqueness
 *    check).
 */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  if (searchLines.at(-1) === "") searchLines.pop()
  if (searchLines.length === 0) return

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        matches = false
        break
      }
    }
    if (matches) yield sliceLines(originalLines, i, i + searchLines.length - 1)
  }
}

/**
 * 3. First and last lines as anchors + Levenshtein similarity on the middle lines.
 *    Handles "the model only remembers the head and tail of the function and rewrote the
 *    middle from memory". The strongest and also the most dangerous level — what holds
 *    its collateral damage in check is its own two gates, maxLineDelta and the 0.65
 *    similarity threshold. isDisproportionateMatch sits behind them but can't be reached
 *    under the current cascade (see its note).
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  // Note: the length check comes before the pop, so "a\nb\n", which splits into 3 parts,
  // gets through
  if (searchLines.length < 3) return
  if (searchLines.at(-1) === "") searchLines.pop()

  const firstLineSearch = searchLines[0]!.trim()
  const lastLineSearch = searchLines.at(-1)!.trim()
  const searchBlockSize = searchLines.length
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25))

  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i]!.trim() !== firstLineSearch) continue
    // j starts at i+2 — a candidate block is at least 3 lines
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j]!.trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j })
        }
        break // per starting point, take only the nearest closing anchor
      }
    }
  }
  if (candidates.length === 0) return

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]!
    const actualBlockSize = endLine - startLine + 1
    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j]!.trim()
        const searchLine = searchLines[j]!.trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) continue // blank line: in the denominator, not the numerator
        similarity += (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break // enough; stop here
      }
    } else {
      similarity = 1.0 // too small to have middle lines to compare; just accept
    }
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield sliceLines(originalLines, startLine, endLine)
    }
    return
  }

  // Several candidates: score them all and take the best, no early exit
  let best: { startLine: number; endLine: number } | undefined
  let bestSimilarity = 0
  for (const candidate of candidates) {
    const actualBlockSize = candidate.endLine - candidate.startLine + 1
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)
    let similarity = 0
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[candidate.startLine + j]!.trim()
        const searchLine = searchLines[j]!.trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) continue
        similarity += 1 - levenshtein(originalLine, searchLine) / maxLen
      }
      similarity /= linesToCheck
    } else {
      similarity = 1.0
    }
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity
      best = candidate
    }
  }
  if (best && bestSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD) {
    yield sliceLines(originalLines, best.startLine, best.endLine)
  }
}

/**
 * 4. Compare after collapsing all whitespace into single spaces. Handles "whitespace
 *    **within** a line got tidied" — `foo(  a,  b )` vs `foo( a, b )`. Level 2 only trims
 *    the ends and can't deal with the inside of a line.
 */
export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim()
  const normalizedFind = normalize(find)
  const originalLines = content.split("\n")

  // (a) Single line: equal once the whole line is normalized, or contained within the line
  for (const line of originalLines) {
    if (normalize(line) === normalizedFind) {
      yield line
      continue
    }
    if (normalize(line).includes(normalizedFind)) {
      const pattern = find
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+")
      const hit = line.match(new RegExp(pattern))
      if (hit) yield hit[0]
    }
  }

  // (b) Multi-line: compare a window of equal line count, normalized as a whole
  const searchLines = find.split("\n")
  if (searchLines.length > 1) {
    for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
      const block = originalLines.slice(i, i + searchLines.length).join("\n")
      if (normalize(block) === normalizedFind) yield block
    }
  }
}

/**
 * 5. Trim the whitespace off both ends of oldString and search again. Handles "the model
 *    brought along extra leading/trailing blank lines" — level 2 only pops **one**
 *    trailing blank line and can't deal with leading ones.
 */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmed = find.trim()
  if (trimmed === find) return // same as level 1; don't do useless work
  if (content.includes(trimmed)) yield trimmed

  const originalLines = content.split("\n")
  const searchLines = find.split("\n")
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    const block = originalLines.slice(i, i + searchLines.length).join("\n")
    if (block.trim() === trimmed) yield block
  }
}

/**
 * The "compare after removing the common indentation" level (opencode's
 * IndentationFlexibleReplacer) is **not installed**.
 *
 * Reason: it is completely shadowed by level 2, LineTrimmedReplacer. LineTrimmed compares
 * after a trim() on every line, so its tolerance for indentation strictly covers "remove
 * only the common minimum indentation", and it tolerates trailing whitespace on top. In
 * opencode this level also sits after LineTrimmed, and is just as unreachable.
 * removeIndentation() is kept for reuse when a level like ContextAware is inserted later.
 */

/**
 * Cascade order: strict → loose. Every level must cover a blind spot of the levels before
 * it, otherwise it is dead code.
 *
 * Not installed (insert them back in this order when needed):
 *   EscapeNormalized — the model writes "\n" as a literal backslash-n. Rare in real use,
 *                      so not installed for now.
 *   ContextAware     — line counts strictly equal + exact-match rate of middle lines
 *                      ≥ 0.5. It is stricter than BlockAnchor, but widens the collateral
 *                      damage surface; before it goes in, isDisproportionateMatch must
 *                      have test coverage first.
 *   IndentationFlexible — dead code, shadowed by level 2; see the note above. Don't add it.
 *   MultiOccurrence  — dead code. It yields `find` once per exact occurrence: the same
 *                      candidate level 1 already tried, and replaceAll already covers
 *                      every occurrence. Don't add it.
 */
const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  TrimmedBoundaryReplacer,
]

/**
 * Guard against large-scale accidental deletion: refuse the replacement when the matched
 * fragment is clearly bloated relative to oldString.
 *
 * ⚠ Under the **current** five-level cascade it is actually unreachable — don't mistake it
 *   for something that protects you:
 *   - Line-count branch: BlockAnchor's maxLineDelta (≤ 25% line-count difference) already
 *     stops line-count bloat at candidate collection; it never gets to the old+3 / old×2
 *     threshold.
 *   - Character-count branch: it first has to pass BlockAnchor's 0.65 similarity
 *     threshold, and a block bloated 4× in characters can't get through.
 * It is insurance prepared for a loose level like ContextAware, where "line counts are
 * equal but content may differ a lot". Before that level goes in, this function must have
 * coverage first — which is why it is kept + unit-tested now, rather than deleted.
 */
export function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length
  const searchLines = search.split("\n").length
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true
  if (oldLines === 1) return false // one line: no char-count test, or long lines get hit
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
}

export interface ReplaceResult {
  content: string
  /** Which level hit (0-based), for metadata and debugging. */
  replacerIndex: number
  replacements: number
}

export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ReplaceResult {
  // Order matters: the identical check must come before the empty one,
  // otherwise {oldString:"", newString:""} reports the wrong error
  if (oldString === newString) throw new Error(ERR_IDENTICAL)
  if (oldString === "") throw new Error(ERR_EMPTY_OLD)

  let notFound = true

  for (let index = 0; index < REPLACERS.length; index++) {
    const replacer = REPLACERS[index]!
    for (const search of replacer(content, oldString)) {
      // ★ Empty candidates must be blocked here, not left to the `oldString === ""` check
      //   at the entrance.
      //
      //   The entrance blocks **the user passing an empty string**; it can't block **the
      //   cascade producing an empty candidate on its own**: when LineTrimmedReplacer
      //   compares `"\t"` line by line after trim, `"\t".trim()` equals a blank line's
      //   `"".trim()` — so every blank line "matches", and the candidate string it hands
      //   over is `""`. Then `"".indexOf` is always 0 (looks like a find), and
      //   `replaceAll("", x)` inserts a copy of x **between every two characters**.
      //
      //   The real trigger path needs no malicious input at all: "replace tabs with
      //   spaces" + a file that has no tabs left but does have blank lines is enough. And
      //   edit is allowed by default, so what the user sees is
      //   "Edit applied successfully. Replacements: 18", with the file already shredded.
      if (search === "") continue
      const at = content.indexOf(search)
      if (at === -1) continue
      notFound = false

      if (isDisproportionateMatch(search, oldString)) throw new Error(ERR_DISPROPORTIONATE)

      if (replaceAll) {
        // Note: this replaces every occurrence of the **candidate string**, not of oldString
        const count = content.split(search).length - 1
        return { content: content.replaceAll(search, newString), replacerIndex: index, replacements: count }
      }

      // Not unique → on to the next candidate / next level; not a hard failure
      if (at !== content.lastIndexOf(search)) continue

      return {
        content: content.slice(0, at) + newString + content.slice(at + search.length),
        replacerIndex: index,
        replacements: 1,
      }
    }
  }

  throw new Error(notFound ? ERR_NOT_FOUND : ERR_MULTIPLE)
}
