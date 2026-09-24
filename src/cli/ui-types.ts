/**
 * The UI only passes structured content; with full-screen retired, the panel renderer
 * must not come back just for a few types.
 */
export interface UpgradeState {
  from: string
  to?: string
  phase: "checking" | "downloading" | "verifying" | "installing" | "done" | "failed" | "cancelled" | "current"
  received?: number
  total?: number
  detail?: string
}
export interface ProviderRow {
  id: string
  type: string
  source: "env" | "file" | "none"
  masked?: string
}
