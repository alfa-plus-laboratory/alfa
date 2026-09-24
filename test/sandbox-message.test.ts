/** What `/sandbox` answers: the saved setting and whether it is in force, kept apart. */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { sandboxMessage, sandboxStartupMessage } from "../src/cli/sandbox-message.ts"
import { setInterfaceLanguage } from "../src/i18n/index.ts"

beforeAll(() => { setInterfaceLanguage("en") })
afterAll(() => { setInterfaceLanguage("auto") })

test("startup hides a disabled sandbox and reports an enabled one, in every mode", () => {
  expect(sandboxStartupMessage({ preference: false, active: false, backend: "seatbelt" })).toBeUndefined()
  expect(sandboxStartupMessage({ preference: true, active: true, backend: "seatbelt" })).toContain("including auto")
  expect(sandboxStartupMessage({ preference: true, active: true, backend: "unavailable" })).toContain("shell commands are blocked")
})

test("the effective state is reported, with the backend when on", () => {
  expect(sandboxMessage({ preference: true, active: true, backend: "seatbelt" })).toStartWith("OS sandbox: on (seatbelt)")
  expect(sandboxMessage({ preference: false, active: false, backend: "seatbelt" })).toStartWith("OS sandbox: off")
  expect(sandboxMessage({ preference: true, active: true, backend: "unavailable" })).toContain("no supported backend")
})

// Installed-but-refused needs a different fix than "install a backend", and says which
test("a bubblewrap blocked by AppArmor is reported as such, not as a missing backend", () => {
  const blocked = "bwrap: setting up uid map: Permission denied"
  for (const text of [sandboxMessage({ preference: true, active: true, backend: "unavailable", blocked }), sandboxStartupMessage({ preference: true, active: true, backend: "unavailable", blocked })!]) {
    expect(text).toContain("setting up uid map")
    expect(text).toContain("AppArmor")
    expect(text).not.toContain("no supported backend")
  }
})
