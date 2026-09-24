# Security policy

alfa runs commands and edits files on your machine, often inside repositories you didn't
write. Reports that show it doing more than the user allowed are the most useful ones we
get.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
**Security → Report a vulnerability** on the repository, or go to
<https://github.com/alfa-plus-laboratory/alfa/security/advisories/new>.

Include the alfa version (`alfa --version`), the OS, the permission mode, and the steps
or repository contents that reproduce it. Leave out real credentials; a synthetic key or
file works just as well.

Fixes ship in the next release and are credited in the advisory, unless you'd rather not
be named.

## Supported versions

Only the latest release. `alfa upgrade` installs it.

## What counts

- **Permission bypass**: an action that runs without the review or approval its mode
  requires. That includes skipping the auto-mode classifier through its fast path, or
  editing a protected path without review.
- **Untrusted repository content acting before trust**: files from a cloned repository
  reaching the system prompt, or starting a process, before the folder is trusted.
- **Sandbox escape**: with the OS sandbox on, a shell command reading or writing outside
  the workspace, the session temp directory and the `/access` grants.
- **Credential exposure**: provider keys (`auth.json`), the session database, or secret
  files reaching the model, logs or the network without the review auto mode applies to
  secrets.
- **Install and update integrity**: a way to get a modified binary installed.

## Known limits (not vulnerabilities on their own)

These are documented design limits. A report that goes past them is welcome; one that
restates them is not a vulnerability.

- Auto mode's classifier is a probabilistic risk screen, not an isolation boundary.
- The prompt-injection scanner recognizes injections written plainly. It flags them and
  doesn't block anything.
- The OS sandbox is experimental and off by default. It restricts the filesystem only,
  not the network. It exists only on macOS (Seatbelt) and on Linux with a bubblewrap that
  can create user namespaces (Ubuntu 23.10+ needs an AppArmor profile for it); there is
  none on Windows.
- MCP servers and explicitly trusted extensions run as host processes, outside the
  sandbox.
- Release checksums come from the same GitHub release as the binary. There is no separate
  signature yet.
