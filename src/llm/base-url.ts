/**
 * Anthropic-compatible endpoints have no single convention for baseURL: some docs give
 * the host root, some give `/v1`, and the SDK only appends `/messages` on top. Adding the
 * version for the user statically would break a few gateways; doing nothing leaves the
 * most common 404 for the user to puzzle over.
 *
 * ★ This only produces an "alternate form" for one connection test; it never edits the
 *   config directly. If the original address succeeds first, it is kept as-is; only when
 *   the original 404s and the alternate succeeds does the CLI save the alternate.
 * ⚠ When a version segment is already present it may only be removed, never appended
 *   again, or the auto-fix would produce `/v1/v1`.
 */

/**
 * Returns the other common form of an Anthropic baseURL. The input must already have been
 * validated as a URL by the UI.
 */
export function alternateAnthropicBaseURL(input: string): string | undefined {
  const url = input.replace(/\/+$/, "")
  if (/\/messages$/i.test(url)) return url.slice(0, -"/messages".length)
  if (/\/v\d+$/i.test(url)) {
    const withoutVersion = url.replace(/\/v\d+$/i, "")
    return withoutVersion.length > 0 ? withoutVersion : undefined
  }
  return `${url}/v1`
}
