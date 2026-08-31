# alfa 安装脚本(Windows / PowerShell)。
#
#   irm https://github.com/alfa-plus-laboratory/alfa/releases/latest/download/install.ps1 | iex
#
# 和 install.sh 同一套规矩:认平台、下、校验,**不改你的环境变量** —— 一个会往
# PATH 里塞东西的安装脚本,卸载时就没人说得清该删哪一段。装到的目录不在 PATH 上
# 的话,它只是把该跑的那行命令**打给你看**。
#
# ── 为什么整段包在一个函数里 ──
# `irm | iex` 是在**调用者的作用域**里跑的:直接写 $ErrorActionPreference = 'Stop'
# 会把用户这个会话的设置一并改掉,而他只是想装个东西。函数里改,出了函数就没了。
# 同理不用 `exit`:在交互式会话里那一句会把窗口关掉,而报错正是用户最需要看清
# 屏幕的时刻 —— 所以一律 throw。
#
# 可调(和 install.sh 同名):
#   $env:ALFA_VERSION     = 'v0.4.0'   装指定版本(默认最新)
#   $env:ALFA_INSTALL_DIR = '…'        装到别处(默认 %LOCALAPPDATA%\Programs\alfa)
#   $env:ALFA_BASE_URL    = '…'        从别处取(内网镜像、离线目录)。留这个口子
#                                        不只是为了测试:装不了东西的机器往往正是
#                                        出不了网的那些
function Install-Alfa {
    $ErrorActionPreference = 'Stop'
    # PS 5.1 的进度条会把一个九十多兆的下载拖慢到好几分钟。关掉它不是为了好看
    $ProgressPreference = 'SilentlyContinue'
    # 老一点的 Windows 上 PS 5.1 默认还在 TLS 1.0,而 GitHub 早就只收 1.2 —— 那时
    # 报出来的是一句"基础连接已关闭",里面没有任何线索指向协议版本
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch {
        # PS 7 走 .NET Core,这个开关不存在也不需要
    }

    $repo    = if ($env:ALFA_REPO) { $env:ALFA_REPO } else { 'alfa-plus-laboratory/alfa' }
    $version = if ($env:ALFA_VERSION) { $env:ALFA_VERSION } else { 'latest' }
    $dir     = if ($env:ALFA_INSTALL_DIR) { $env:ALFA_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\alfa' }

    # ── 认平台 ──
    # 只出 windows-x64 一个包(见 update/release.ts:没人验证过的 arm64 包比不出更糟)。
    # ARM64 的机器照样能装 —— Windows 自带 x64 模拟 —— 但这件事要说出来,不能让它
    # 装完之后以一种谁也复现不了的方式慢下来
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

        # ── 校验 ──
        # 拿不到 checksums.txt 就明说没验,而不是安静地跳过。一句没说出口的"我没验"
        # 和一次没做的校验后果一样,但前者还多骗了一次
        #
        # ⚠ checksums.txt **必须落盘再读**,不能用 `.Content`。
        #
        #   GitHub 发 release 资产用的是 `Content-Type: application/octet-stream`,
        #   而 Windows PowerShell 5.1 的 Invoke-WebRequest 在非 text/* 时把
        #   `.Content` 交出来的是 **Byte[]**,不是字符串。于是
        #   `$sums -split "`n"` 会把每个字节强转成十进制字符串再切 —— 得到的是
        #   一堆 "101" "48",`$parts[1]` 永远对不上资产名,$expected 一直是 null。
        #
        #   现场:二进制下载成功,紧接着报 "cannot verify … refusing to install"。
        #   也就是说**每一次 Windows 安装都必然失败**,而 Linux 那边(curl 落盘 +
        #   sha256sum)一直是好的 —— 所以这个洞在两个脚本里只有一边现形。
        #
        #   -OutFile 和下载二进制走的是同一条路,content-type 从此不参与判断。
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
        # ★ 验不了就停,不是"说一声然后照装"。理由和 install.sh 那边一字不差:
        #   把 checksums.txt 这一个请求打掉,就能把已校验的安装变成未校验的。
        #   逃生开关 ALFA_SKIP_CHECKSUM=1 必须由人显式打出来(内网镜像用)。
        if ($expected) {
            $actual = (Get-FileHash -Algorithm SHA256 -Path $downloaded).Hash.ToLower()
            if ($actual -ne $expected) { throw "checksum mismatch - expected $expected, got $actual" }
            Write-Host '  checksum ok'
        } elseif ($env:ALFA_SKIP_CHECKSUM -eq '1') {
            Write-Host '  ! ALFA_SKIP_CHECKSUM=1 - installing without verification'
        } else {
            throw "cannot verify $asset against checksums.txt - refusing to install unverified (set ALFA_SKIP_CHECKSUM=1 to override)"
        }

        # ── 装 ──
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $target = Join-Path $dir 'alfa.exe'
        # 正在跑的 exe 覆盖不掉(Windows 锁着它)。和自更新那边同一个办法:先把
        # 旧的挪成 .old,失败了再换回去 —— 别让用户手里连个能跑的都没有
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
            # 刚装上的东西跑不起来是件大事,但报出来的应该是它自己的话
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
        # 哪条退出路径都要清干净 —— 一次失败的安装不该在 temp 里留九十多兆
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Alfa
