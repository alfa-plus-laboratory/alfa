/**
 * Paths whose edits auto mode always sends to the classifier, even inside the workspace.
 *
 * ── Why a workspace edit can still need review ──
 * "An edit inside the project can be undone with git" is what lets workspace edits skip
 * the classifier. These files break that argument. They are configuration that another
 * program executes or trusts later: git hooks and `core.hooksPath`, husky and lefthook,
 * shell rc files, package-manager rc files that can point at another registry or run
 * code on install, editor task files, alfa's own `.alfa/` (skills and mcp.json go into
 * the next session's prompt or start processes). Writing one plants something that runs
 * after the review is over, so git can't undo the harm.
 *
 * The list follows Claude Code's protected paths (permission-modes docs, "Protected
 * paths"), plus `.alfa`. Secret files are handled separately (secrets.ts) because reading
 * one matters too, while for these files only writes do.
 */
import { isAbsolute, relative } from "node:path"

const DIRECTORIES = [
  ".git", ".alfa", ".claude", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn",
]

/** Lower case; compared against case-folded names */
const FILES = new Set([
  ".gitconfig", ".gitmodules",
  ".bashrc", ".bash_profile", ".bash_login", ".bash_aliases", ".bash_logout",
  ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".profile", ".envrc",
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs", ".pnpmfile.cjs", "bunfig.toml", ".bunfig.toml",
  ".bazelrc", ".bazelversion", ".bazeliskrc",
  ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml",
  "gradle-wrapper.properties", "maven-wrapper.properties",
  ".devcontainer.json", ".ripgreprc", "pyrightconfig.json",
  ".mcp.json", ".claude.json",
])

/**
 * @param path Workspace-relative inside the workspace, absolute outside it (the shape
 *   permission patterns use; see permission/pattern.ts)
 */
export function isProtectedPath(path: string, root: string): boolean {
  const inside = isAbsolute(path) ? relative(root, path) : path
  // ★ Compared case-folded: macOS and Windows file systems are case-insensitive, and an
  //   edit to `.ALFA/mcp.json` in a folder that doesn't exist yet creates the very
  //   directory the next session loads as `.alfa`
  const parts = inside.split(/[\\/]/).filter((part) => part.length > 0 && part !== ".").map((part) => part.toLowerCase())
  if (FILES.has(parts.at(-1) ?? "")) return true
  if (parts.some((part) => DIRECTORIES.includes(part))) return true
  // `~/.config/git` is git's XDG config directory (as a pair, so `.config/gitlab.yml` isn't)
  return parts.some((part, index) => part === ".config" && parts[index + 1] === "git")
}
