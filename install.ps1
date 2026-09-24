# The alfa install script (Windows / PowerShell).
#
#   irm https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.ps1 | iex
#
# Same rules as install.sh: detect the platform, download, verify, and **don't change your
# environment variables** — with an install script that stuffs things into PATH, nobody
# can say which part to delete when uninstalling. If the install directory isn't on PATH,
# it just **prints the command to run** for you.
#
# ── Why the whole thing is wrapped in a function ──
# `irm | iex` runs in **the caller's scope**: writing $ErrorActionPreference = 'Stop'
# directly would also change the setting for the user's session, when all they wanted was
# to install something. Changed inside a function, it's gone once the function returns.
# Likewise no `exit`: in an interactive session that line closes the window, and an error
# is exactly when the user most needs to read the screen — so it's always throw.
#
# Knobs (same names as install.sh):
#   $env:ALFA_VERSION     = 'v0.4.0'   install a specific version (default: latest)
#   $env:ALFA_INSTALL_DIR = '…'        install somewhere else (default
#                                        %LOCALAPPDATA%\Programs\alfa)
#   $env:ALFA_BASE_URL    = '…'        fetch from somewhere else (internal mirror, offline
#                                        directory). This hook isn't only for testing:
#                                        the machines that can't install things are
#                                        often exactly the ones that can't reach the
#                                        network
function Install-Alfa {
    $ErrorActionPreference = 'Stop'
    # PS 5.1's progress bar slows a ninety-something MB download down to several minutes.
    # Turning it off isn't about looks
    $ProgressPreference = 'SilentlyContinue'
    # On older Windows, PS 5.1 still defaults to TLS 1.0, while GitHub has long accepted
    # only 1.2 — what you get then is "The underlying connection was closed", with no clue
    # at all pointing to the protocol version
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
        # PS 7 runs on .NET Core, where this switch neither exists nor is needed
    }

    $repo    = if ($env:ALFA_REPO) { $env:ALFA_REPO } else { 'alfa-plus-laboratory/alfa' }
    $version = if ($env:ALFA_VERSION) { $env:ALFA_VERSION } else { 'latest' }
    $dir     = if ($env:ALFA_INSTALL_DIR) { $env:ALFA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\alfa' }

    # ── Detect the platform ──
    # Only one windows-x64 package is shipped (see update/release.ts: an arm64 package
    # nobody has verified is worse than none). ARM64 machines can still install it —
    # Windows has built-in x64 emulation — but that has to be said out loud, rather than
    # letting it run slow after install in a way nobody can reproduce
    $processor = $env:PROCESSOR_ARCHITEW6432
    if (-not $processor) { $processor = $env:PROCESSOR_ARCHITECTURE }
    switch ($processor) {
        'AMD64' { $note = $null }
        'ARM64' { $note = 'no arm64 build - installing the x64 one, Windows runs it under emulation' }
        default { throw "unsupported architecture: $processor" }
    }
    $asset = 'alfa-windows-x64.exe'

    if ($env:ALFA_BASE_URL) {
        $base = $env:ALFA_BASE_URL.TrimEnd('/')
    } elseif ($version -eq 'latest') {
        $base = "https://github.com/$repo/releases/latest/download"
    } else {
        $base = "https://github.com/$repo/releases/download/$version"
    }

    Write-Host '  alfa installer'
    Write-Host "  platform  windows-x64"
    Write-Host "  release   $version"
    if ($note) { Write-Host "  ! $note" }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('alfa-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
        Write-Host '  downloading ...'
        $downloaded = Join-Path $tmp $asset
        try {
            Invoke-WebRequest -Uri "$base/$asset" -OutFile $downloaded -UseBasicParsing
        } catch {
            throw "download failed: $base/$asset"
        }

        # ── Verify ──
        # If checksums.txt can't be fetched, or has no line for this asset, $expected stays
        # null and the install is refused below (see the ★) unless ALFA_SKIP_CHECKSUM=1.
        #
        # ⚠ checksums.txt **must be written to disk and then read**, not taken from
        # `.Content`.
        #
        #   GitHub serves release assets with `Content-Type: application/octet-stream`, and
        #   for anything not text/*, Windows PowerShell 5.1's Invoke-WebRequest hands over
        #   `.Content` as a **Byte[]**, not a string. So `$sums -split "`n"` coerces each
        #   byte into a decimal string and then splits — what you get is a pile of "101"
        #   "48", `$parts[1]` never matches the asset name, and $expected stays null.
        #
        #   What happened: the binary downloaded fine, immediately followed by "cannot
        #   verify … refusing to install". In other words **every single Windows install was
        #   bound to fail**, while the Linux side (curl to disk + sha256sum) was fine all
        #   along — so of the two scripts, this hole only showed up in one.
        #
        #   -OutFile goes the same way as the binary download, so content-type no longer
        #   plays any part.
        $expected = $null
        try {
            $sumsFile = Join-Path $tmp 'checksums.txt'
            Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile $sumsFile -UseBasicParsing
            foreach ($line in (Get-Content -LiteralPath $sumsFile)) {
                $parts = $line.Trim() -split '\s+'
                if ($parts.Count -ge 2 -and $parts[1] -eq $asset) { $expected = $parts[0].ToLower() }
            }
        } catch {
            $expected = $null
        }
        # ★ If it can't be verified, stop — not "mention it and install anyway". The reason
        #   is word for word the same as in install.sh: kill that one checksums.txt request
        #   and a verified install becomes an unverified one. The escape hatch
        #   ALFA_SKIP_CHECKSUM=1 must be typed out explicitly by a human (for internal
        #   mirrors).
        if ($expected) {
            $actual = (Get-FileHash -Algorithm SHA256 -Path $downloaded).Hash.ToLower()
            if ($actual -ne $expected) { throw "checksum mismatch - expected $expected, got $actual" }
            Write-Host '  checksum ok'
        } elseif ($env:ALFA_SKIP_CHECKSUM -eq '1') {
            Write-Host '  ! ALFA_SKIP_CHECKSUM=1 - installing without verification'
        } else {
            throw "cannot verify $asset against checksums.txt - refusing to install unverified (set ALFA_SKIP_CHECKSUM=1 to override)"
        }

        # ── Install ──
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $target = Join-Path $dir 'alfa.exe'
        # A running exe can't be overwritten (Windows locks it). Same approach as the
        # self-update: move the old one aside as .old first, and swap it back on failure —
        # don't leave the user without anything that runs
        $parked = "$target.old"
        if (Test-Path $target) {
            Remove-Item $parked -Force -ErrorAction SilentlyContinue
            try { Rename-Item -Path $target -NewName ([IO.Path]::GetFileName($parked)) -Force } catch {
                throw "$target is in use - close any running alfa and try again"
            }
        }
        try {
            Move-Item -Path $downloaded -Destination $target -Force
        } catch {
            if (Test-Path $parked) { Rename-Item -Path $parked -NewName 'alfa.exe' -Force }
            throw "cannot write to $dir"
        }
        Remove-Item $parked -Force -ErrorAction SilentlyContinue

        Write-Host ''
        Write-Host "  installed  $target"
        try { Write-Host "  version    $(& $target --version)" } catch {
            # A freshly installed binary that won't run is a big deal, but what gets
            # reported should be its own words
            Write-Host '  ! installed, but it would not run - try running it directly to see why'
        }

        $onPath = @($env:PATH -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ieq $dir.TrimEnd('\') }).Count -gt 0
        if (-not $onPath) {
            Write-Host ''
            Write-Host "  $dir is not on your PATH. Run this once, then reopen your terminal:"
            Write-Host ''
            Write-Host "    [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$dir', 'User')"
        }

        Write-Host ''
        Write-Host "  run 'alfa' to set it up, or 'alfa upgrade' later to update in place"
    } finally {
        # Every exit path must clean up — a failed install shouldn't leave ninety-something
        # MB behind in temp
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Alfa
