/**
 * Approval must not promise broader access than execution actually gets. These checks
 * guard the distinction in both the model's runtime routing and the user's receipt of
 * a permission request; kernel enforcement is exercised separately in sandbox.test.ts.
 */
import { test, expect } from "bun:test"
import { approvalReason, renderRequest } from "../src/cli/confirm.ts"
import type { PromptRequest } from "../src/permission/gate.ts"
import { safetyBlock } from "../src/prompt/safety.ts"

const request = (cause: PromptRequest["cause"]): PromptRequest => ({
  permission: "bash", cause, patterns: ["cat /outside/value"],
  alwaysPatterns: ["cat *"], forbidAlways: false,
  reasons: ["shell redirection"],
})

test("shell approval distinguishes operation consent from path grants in every approval mode", () => {
  for (const cause of ["mode", "structure", "rule"] as const) {
    const text = renderRequest(request(cause))
    expect(text).toContain("does not grant paths or change the OS sandbox")
    expect(text).toContain("/access")
    expect(text).toContain("shell redirection")
    expect(text).not.toContain("flagged:")
  }
  expect(approvalReason(request("mode"))).toContain("not a risk finding")
  expect(approvalReason(request("structure"))).toContain("shell syntax")
})

test("runtime guidance refreshes facts and does not diagnose sandbox failure from errno alone", () => {
  const text = safetyBlock()
  expect(text).toContain("call environment before answering")
  expect(text).toContain("approving a command does not grant its paths")
  expect(text).toContain("EPERM or EACCES alone does not establish")
  expect(text).toContain("do not default to disabling the sandbox")
  expect(text).toContain("workspaceRoot includes its descendants")
})
