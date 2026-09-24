/** Known credentials are masked once more at the last exit to the log and the UI; remote
 *  error bodies may also echo request headers. */
const secrets = new Set<string>()
export function registerSecret(value: string | undefined): void { if (value && value.length >= 12) secrets.add(value) }
export function redact(text: string): string {
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]")
  return text.replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
}
