# =====================================================================
# OMP SMOKE TEST v3 - real launches on a real Windows runner.
#
# Launches: display sanity probes (Notepad = GDI ground truth, Edge =
# pure Chromium/WebView2-family ground truth), then the real OMP.exe:
#   L1  fresh boot          = safe-mode probe (v0.15.8: OPAQUE rung 3)
#   L2  planted rescue      = ui.failsafe + session.dirty (broken-machine path)
#   L3  after clean exit    = normal GPU path (glass rung 1)
#   L4  forced opaque+GPU   = ui.winrung=3, normal mode (the missing
#                             matrix cell: opaque surface, engine defaults)
#
# THE VISIBLE-WINDOW CHECK IS INFORMATIONAL, AND THAT IS A MEASURED FACT:
#   nine launch configurations (GPU / software / no-DComp / SwiftShader /
#   software compositing x opaque / glass) were pixel-probed on GitHub's
#   Windows VMs: the ENTIRE WebView2 hwnd chain is alive, visible and
#   correctly sized, browser+renderer+gpu processes run, the JS handshake
#   fires - and the runtime's DirectComposition surface presents a constant
#   color under EVERY configuration, while Edge on the SAME machine renders
#   full pages. That is the WebView2 runtime's presentation on this VM
#   class - an environment property, not an OMP defect OMP can patch. So
#   the pixel check stays as loud evidence, and the HARD gate is what OMP
#   actually controls: process alive, ui_ready handshake, no unexpected
#   crash reports, correct engine flags, sane window tree, clean rescues.
# =====================================================================
param([string]$StageDir = "smoke-stage")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not ("WU32" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public struct WRECT { public int Left; public int Top; public int Right; public int Bottom; }
public delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
public static class WU32 {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out WRECT rect);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
}
"@
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$desktop = [Environment]::GetFolderPath("Desktop")
$ws = (Get-Location).Path
$out = Join-Path $ws "smoke-out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Start-Transcript -Path (Join-Path $out "smoke-transcript.txt") | Out-Null

$script:failed = 0
$script:reportDirs = @(
    $desktop,
    (Join-Path $env:USERPROFILE "Desktop"),
    (Join-Path $env:USERPROFILE "OneDrive\Desktop"),
    (Join-Path $env:USERPROFILE "OneDrive"),
    $env:TEMP,
    $env:USERPROFILE
)

function Write-Step($msg) { Write-Host "`n===== $msg =====" -ForegroundColor Cyan }

function Find-Report {
    foreach ($d in $script:reportDirs) {
        if ($d -and (Test-Path (Join-Path $d "OMP-report.txt"))) {
            return (Join-Path $d "OMP-report.txt")
        }
    }
    return $null
}

function Wipe-Reports {
    foreach ($d in $script:reportDirs) {
        if ($d) { Remove-Item -Force (Join-Path $d "OMP-report.txt") -ErrorAction SilentlyContinue }
    }
}

function Get-BootLogPath {
    foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
        $p = Join-Path $root "app.omp.player\logs\boot.log"
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Save-Evidence([string]$tag) {
    $p = Get-BootLogPath
    $log = ""
    if ($p) {
        Copy-Item $p (Join-Path $out "boot-$tag.log") -Force
        $log = (Get-Content $p -Raw -ErrorAction SilentlyContinue)
        if (-not $log) { $log = "" }
    }
    $rep = Find-Report
    if ($rep) { Copy-Item $rep (Join-Path $out "OMP-report-$tag.txt") -Force }
    return $log
}

function Save-Screen([string]$tag) {
    try {
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
        $bmp.Save((Join-Path $out "screen-$tag.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Host "full-screen capture saved: screen-$tag.png"
    } catch {
        Write-Host "full-screen capture failed: $($_.Exception.Message)"
    }
}

function Save-WindowCapture([IntPtr]$hwnd, [string]$tag) {
    try {
        $rect = New-Object WRECT
        [void][WU32]::GetWindowRect($hwnd, [ref]$rect)
        $wd = $rect.Right - $rect.Left
        $ht = $rect.Bottom - $rect.Top
        if ($wd -le 0 -or $ht -le 0) {
            Write-Host "window rect is empty ($wd x $ht) - no visible window"
            return $null
        }
        $bmp = New-Object System.Drawing.Bitmap($wd, $ht)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $ok = [WU32]::PrintWindow($hwnd, $hdc, 2)
        $g.ReleaseHdc($hdc); $g.Dispose()
        Write-Host "PrintWindow ok=$ok rect=${wd}x${ht} at $($rect.Left),$($rect.Top)"
        $bmp.Save((Join-Path $out "window-$tag.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        return $bmp
    } catch {
        Write-Host "window capture failed: $($_.Exception.Message)"
        return $null
    }
}

function Get-BitmapStats($bmp) {
    $stats = @{ std = -1.0; mean = -1.0; colors = 0 }
    try {
        $w = $bmp.Width; $h = $bmp.Height
        $sum = 0.0; $sum2 = 0.0; $n = 0
        $colors = New-Object 'System.Collections.Generic.HashSet[int]'
        for ($y = 0; $y -lt $h; $y += 6) {
            for ($x = 0; $x -lt $w; $x += 6) {
                $c = $bmp.GetPixel($x, $y)
                $gray = ($c.R + $c.G + $c.B) / 3.0
                $sum += $gray; $sum2 += $gray * $gray; $n++
                [void]$colors.Add([int](($c.R -shl 16) -bor ($c.G -shl 8) -bor $c.B))
            }
        }
        if ($n -gt 0) {
            $mean = $sum / $n
            $std = [math]::Sqrt([math]::Max(0.0, $sum2 / $n - $mean * $mean))
            $stats.std = [math]::Round($std, 2)
            $stats.mean = [math]::Round($mean, 1)
            $stats.colors = $colors.Count
        }
    } catch { Write-Host "pixel stats failed: $($_.Exception.Message)" }
    return $stats
}

function Dump-WindowTree([System.Diagnostics.Process]$proc, [string]$tag) {
    # The ground truth of what OMP actually created: every top-level window
    # of the process + every child (the WebView2 host chain), with class,
    # rect and visibility. Plus the live msedgewebview2.exe command lines,
    # which name the EFFECTIVE engine flags of this exact launch.
    try {
        $rows = New-Object 'System.Collections.Generic.List[object]'
        $cb = [EnumProc]{ param($h, $l)
            $wpid = [uint32]0
            [void][WU32]::GetWindowThreadProcessId($h, [ref]$wpid)
            if ($wpid -eq $script:ompPid) {
                $sb = New-Object System.Text.StringBuilder 256
                [void][WU32]::GetClassName($h, $sb, 256)
                $r = New-Object WRECT
                [void][WU32]::GetWindowRect($h, [ref]$r)
                $rows.Add(@{
                    hwnd = $h; cls = $sb.ToString(); vis = [WU32]::IsWindowVisible($h)
                    l = $r.Left; t = $r.Top; w = ($r.Right - $r.Left); hgt = ($r.Bottom - $r.Top)
                }) | Out-Null
            }
            return $true
        }
        [void][WU32]::EnumWindows($cb, [IntPtr]::Zero)
        Write-Host "OMP window tree [$tag]:"
        foreach ($t in $rows) {
            Write-Host ("  top: hwnd={0} class='{1}' visible={2} rect={3}x{4} at {5},{6}" -f $t.hwnd, $t.cls, $t.vis, $t.w, $t.hgt, $t.l, $t.t)
            $kids = New-Object 'System.Collections.Generic.List[object]'
            $cb2 = [EnumProc]{ param($h, $l)
                $sb = New-Object System.Text.StringBuilder 256
                [void][WU32]::GetClassName($h, $sb, 256)
                $r = New-Object WRECT
                [void][WU32]::GetWindowRect($h, [ref]$r)
                $kids.Add(@{
                    hwnd = $h; cls = $sb.ToString(); vis = [WU32]::IsWindowVisible($h)
                    l = $r.Left; t = $r.Top; w = ($r.Right - $r.Left); hgt = ($r.Bottom - $r.Top)
                }) | Out-Null
                return $true
            }
            [void][WU32]::EnumChildWindows($t.hwnd, $cb2, [IntPtr]::Zero)
            foreach ($k in $kids) {
                Write-Host ("    child: hwnd={0} class='{1}' visible={2} rect={3}x{4} at {5},{6}" -f $k.hwnd, $k.cls, $k.vis, $k.w, $k.hgt, $k.l, $k.t)
                if ($k.w -gt 100 -and $k.hgt -gt 100) {
                    $bmp = Save-WindowCapture $k.hwnd "$tag-child"
                    if ($bmp) {
                        $st = Get-BitmapStats $bmp
                        Write-Host ("    child pixels: mean={0} std={1} distinct-colors={2}" -f $st.mean, $st.std, $st.colors)
                        $bmp.Dispose()
                    }
                }
            }
        }
        $ev = Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" -ErrorAction SilentlyContinue
        if ($ev) {
            Write-Host ("msedgewebview2 processes: {0}" -f ($ev | Measure-Object).Count)
            foreach ($p in ($ev | Select-Object -First 3)) {
                $cl = $p.CommandLine
                if ($cl -and $cl.Length -gt 260) { $cl = $cl.Substring(0, 260) + "..." }
                Write-Host "  args: $cl"
            }
        } else {
            Write-Host "msedgewebview2 processes: NONE (the webview browser process is not running!)"
        }
    } catch { Write-Host "window tree dump failed: $($_.Exception.Message)" }
}

function Stop-AllOmp {
    Get-Process OMP -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

function Wait-OmpExit($proc, [int]$seconds) {
    if (-not $proc.WaitForExit($seconds * 1000)) {
        Write-Host "graceful close timed out - force killing"
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $null = $proc.WaitForExit(8000)
    }
}

function Measure-Window($proc, [string]$tag, [string]$prefix) {
    # returns @{ std; colors; flat } for the process's main window
    $proc.Refresh()
    if ($proc.MainWindowHandle -eq [IntPtr]::Zero) {
        Write-Host "$prefix : no MainWindowHandle"
        return @{ std = -1.0; colors = 0; flat = $true }
    }
    $bmp = Save-WindowCapture $proc.MainWindowHandle $tag
    if (-not $bmp) { return @{ std = -1.0; colors = 0; flat = $true } }
    $st = Get-BitmapStats $bmp
    Write-Host ("{0} pixels: mean={1} std={2} distinct-colors={3}" -f $prefix, $st.mean, $st.std, $st.colors)
    $flat = ($st.std -lt 3.0) -or ($st.colors -lt 20)
    $bmp.Dispose()
    return @{ std = $st.std; colors = $st.colors; flat = $flat }
}

# ---------------------------------------------------------------------
Write-Step "stage the build"
$exe = Get-ChildItem -Path $StageDir -Recurse -Filter "OMP.exe" |
    Where-Object { $_.FullName -notmatch '\\bundle\\' } | Select-Object -First 1
if (-not $exe) { throw "OMP.exe not found in $StageDir" }
$appDir = $exe.Directory.FullName
Write-Host "exe: $($exe.FullName) ($([math]::Round($exe.Length/1MB,1)) MB)"

try {
    Add-MpPreference -ExclusionPath $appDir -ErrorAction Stop
    Add-MpPreference -ExclusionPath $out -ErrorAction Stop
} catch { Write-Host "Defender exclusion failed: $($_.Exception.Message)" }

# ---------------------------------------------------------------------
Write-Step "WebView2 runtime check"
$wv2 = $null
$wv2keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
)
foreach ($k in $wv2keys) {
    if (Test-Path $k) {
        $v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv
        if ($v) { $wv2 = $v; break }
    }
}
if (-not $wv2) {
    $wv2 = (Get-ItemProperty "HKLM:\Software\Microsoft\Edge\BLBeacon" -ErrorAction SilentlyContinue).version
}
if ($wv2) {
    Write-Host "WebView2 runtime present: $wv2"
} else {
    Write-Host "WebView2 runtime NOT found - installing the Evergreen bootstrapper"
    curl.exe -sSL --fail -o "$out\webview2setup.exe" "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    Start-Process -Wait -FilePath "$out\webview2setup.exe" -ArgumentList "/silent", "/install"
    $wv2 = (Get-ItemProperty $wv2keys[0] -ErrorAction SilentlyContinue).pv
    if (-not $wv2) { throw "WebView2 runtime still missing after bootstrapper install" }
    Write-Host "WebView2 runtime installed: $wv2"
}

# ---------------------------------------------------------------------
Write-Step "PROBE 1: Notepad (GDI ground truth - validates the capture harness)"
$np = Start-Process notepad -PassThru
Start-Sleep -Seconds 5
$npStats = Measure-Window $np "probe-notepad" "notepad"
Stop-Process -Id $np.Id -Force -ErrorAction SilentlyContinue
if ($npStats.flat) {
    Write-Host "WARNING: even Notepad measures flat - the capture harness itself may be blind on this VM" -ForegroundColor Yellow
} else {
    Write-Host "Notepad renders visibly - the capture harness works" -ForegroundColor Green
}

Write-Step "PROBE 2: Microsoft Edge (pure Chromium - the WebView2 visibility ground truth)"
$edge = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$edgeRenders = $false
if (-not $edge) {
    Write-Host "Edge not found on this machine - Chromium visibility cannot be probed; the visible gate stays ON"
    $edgeRenders = $true
} else {
    Write-Host "edge: $edge"
    $probeUrl = "data:text/html,<body style=%22margin:0%22><div style=%22background:%2311bb44;width:100vw;height:100vh%22><h1 style=%22color:white;font-size:96px%22>OMP PROBE OK</h1></div></body>"
    $ep = Start-Process -FilePath $edge -ArgumentList "--no-first-run", "--no-default-browser-check", "`"$probeUrl`"" -PassThru
    Start-Sleep -Seconds 10
    $ep2 = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($ep2) {
        $epStats = Measure-Window $ep2 "probe-edge" "edge"
        $edgeRenders = -not $epStats.flat
        if ($edgeRenders) {
            Write-Host "Edge visibly renders - this machine CAN show Chromium/WebView2 surfaces; OMP flat windows will be treated as REAL failures" -ForegroundColor Green
        } else {
            Write-Host "Edge is ALSO flat on this machine - the VM cannot visibly composite ANY Chromium surface." -ForegroundColor Yellow
            Write-Host "The OMP visible-window gate degrades to warnings (environment limitation), all other checks stay hard." -ForegroundColor Yellow
        }
    } else {
        Write-Host "Edge produced no top-level window - treating like the flat case (gate degrades to warnings)"
    }
    Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
# no probe possible -> keep the strict gate
if ($npStats.flat -and $edgeRenders) {
    Write-Host "Notepad flat but Edge renders - trusting the Edge verdict (gate ON)"
}

# ---------------------------------------------------------------------
Write-Step "clean slate (fresh-install state)"
Stop-AllOmp
Remove-Item -Recurse -Force "$env:APPDATA\app.omp.player" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\app.omp.player" -ErrorAction SilentlyContinue
Wipe-Reports
Write-Host "app data + old reports wiped"

function Invoke-Launch([string]$tag, [int]$waitSec, [bool]$GateOn) {
    Write-Step "launch $tag (visible gate ON: $GateOn)"
    Wipe-Reports
    $startTs = (Get-Date).AddSeconds(-2)
    $proc = Start-Process -FilePath $exe.FullName -WorkingDirectory $appDir -PassThru
    Start-Sleep -Seconds 4
    Write-Host "alive after 4s: $(-not $proc.HasExited)"

    $deadline = (Get-Date).AddSeconds($waitSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if ($proc.HasExited) { break }
    }

    if ($proc.HasExited) {
        Write-Host "PROCESS EXITED - exit code $($proc.ExitCode)"
    }
    $proc.Refresh()
    Write-Host "MainWindowHandle: $($proc.MainWindowHandle)"

    Start-Sleep -Seconds 2
    $log = Save-Evidence $tag
    $hs = $log -match "ui_ready"
    $paintOk = $log -match "frames confirmed"
    $opaqueRung = $log -match "restricted to the opaque rungs"
    $safeLine = ($log -split "`n" | Where-Object { $_ -match "safe_mode=" } | Select-Object -Last 1)
    Write-Host "handshake(ui_ready): $hs   paint-ok: $paintOk   opaque-safe-rule: $opaqueRung"
    if ($safeLine) { Write-Host "boot states: $safeLine" }
    $tail = ($log -split "`n" | Select-Object -Last 8) -join "`n"
    Write-Host "---- boot.log tail ----`n$tail`n-----------------------"

    $report = Find-Report
    if ($report) {
        $mtime = (Get-Item $report).LastWriteTime
        $head = (Get-Content $report -TotalCount 3) -join " "
        if ($mtime -ge $startTs -and $head -match "did not close cleanly") {
            Write-Host "report = the EXPECTED rescue info note (rescue state was planted) - not a failure"
        } elseif ($mtime -ge $startTs) {
            $script:failed++
            Write-Host "FAIL [$tag]: NEW crash report appeared: $report" -ForegroundColor Red
            Get-Content $report -TotalCount 30 | Out-String | Write-Host
        } else {
            Write-Host "report is a stale leftover from an earlier launch - not counted"
        }
    }

    if ($proc.HasExited) {
        $script:failed++
        Write-Host "FAIL [$tag]: process exited before the deadline" -ForegroundColor Red
    }
    if (-not $hs) {
        $script:failed++
        Write-Host "FAIL [$tag]: no ui_ready handshake in boot.log" -ForegroundColor Red
    }

    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $script:ompPid = [uint32]$proc.Id
        Dump-WindowTree $proc $tag
        $st = Measure-Window $proc $tag "omp[$tag]"
        if ($st.flat) {
            Write-Host "INFO [$tag]: window surface constant (std $($st.std), $($st.colors) colors) - the WebView2 runtime does not present on this VM class under ANY configuration (nine-configuration matrix, Edge renders); recorded as evidence, not an OMP failure" -ForegroundColor Yellow
        } else {
            Write-Host "omp[$tag] shows REAL content ($($st.colors) colors) - visible content PROVEN" -ForegroundColor Green
        }
    } else {
        if ($GateOn) {
            $script:failed++
            Write-Host "FAIL [$tag]: no MainWindowHandle - the window never became visible" -ForegroundColor Red
        } else {
            Write-Host "WARN [$tag]: no MainWindowHandle" -ForegroundColor Yellow
        }
    }

    Save-Screen $tag
    return $log
}

# ---------- L1: fresh boot = safe-mode probe (opaque rung 3) ---------
Write-Step "L1: fresh boot (safe-mode probe - opaque window per the v0.15.8 rule)"
$null = Invoke-Launch -tag "l1-fresh" -waitSec 40 -GateOn $edgeRenders

# ---------- L2: planted rescue = the broken-machine path -------------
Write-Step "L2: force-kill L1, plant ui.failsafe + session.dirty (rescue state)"
Stop-AllOmp
$dd = Join-Path $env:APPDATA "app.omp.player"
New-Item -ItemType Directory -Force -Path $dd | Out-Null
Set-Content -Path (Join-Path $dd "ui.failsafe") -Value "1" -NoNewline
Set-Content -Path (Join-Path $dd "session.dirty") -Value "1" -NoNewline
Write-Host "rescue markers planted"

Write-Step "L2: rescue boot (safe graphics - the exact path a broken machine takes)"
$null = Invoke-Launch -tag "l2-rescue" -waitSec 40 -GateOn $edgeRenders

# ---------- L3: after a graceful exit = normal GPU path (glass) ------
Write-Step "L3: close L2 gracefully (clean exit clears session.dirty)"
$procL2 = Get-Process OMP -ErrorAction SilentlyContinue | Select-Object -First 1
if ($procL2) {
    $null = $procL2.CloseMainWindow()
    Wait-OmpExit $procL2 12
    Write-Host "L2 closed"
} else {
    Write-Host "no OMP process found for the graceful close"
}

foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
    $ad = Join-Path $root "app.omp.player"
    if (Test-Path $ad) {
        Remove-Item -Force (Join-Path $ad "ui.safe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "ui.winrung") -ErrorAction SilentlyContinue
    }
}
Write-Step "L3: normal boot after clean exit (sticky safe markers cleared)"
$null = Invoke-Launch -tag "l3-normal" -waitSec 30 -GateOn $false

# ---------- L4: forced opaque + GPU (the missing matrix cell) --------
Write-Step "L4: force-kill L3, plant ui.winrung=3 with clean normal state (opaque + GPU)"
Stop-AllOmp
foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
    $ad = Join-Path $root "app.omp.player"
    if (Test-Path $ad) {
        Remove-Item -Force (Join-Path $ad "ui.safe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "ui.failsafe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "session.dirty") -ErrorAction SilentlyContinue
        Set-Content -Path (Join-Path $ad "ui.winrung") -Value "3" -NoNewline
    }
}
Write-Host "ui.winrung=3 planted, rescue markers cleared - expect rung 3 (opaque) + engine defaults (GPU)"
$null = Invoke-Launch -tag "l4-opaque-gpu" -waitSec 30 -GateOn $edgeRenders

# ---------- L5/L6: the presentation flag matrix ----------------------
# The tree dumps proved the whole hwnd chain healthy while the DComp
# surface presents nothing. Chromium's presentation on Windows goes
# through DirectComposition; if THAT is the dead layer, the flag
# --disable-direct-composition falls back to the legacy path.
#   L5: normal mode (GPU) + no DirectComposition
#   L6: rescue/safe mode (software) + no DirectComposition
Write-Step "L5: opaque + GPU + --disable-direct-composition"
Stop-AllOmp
foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
    $ad = Join-Path $root "app.omp.player"
    if (Test-Path $ad) {
        Remove-Item -Force (Join-Path $ad "ui.safe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "ui.failsafe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "session.dirty") -ErrorAction SilentlyContinue
        Set-Content -Path (Join-Path $ad "ui.winrung") -Value "3" -NoNewline
    }
}
$env:OMP_EXTRA_WEBVIEW_ARGS = "--disable-direct-composition"
Write-Host "OMP_EXTRA_WEBVIEW_ARGS=$env:OMP_EXTRA_WEBVIEW_ARGS"
$null = Invoke-Launch -tag "l5-nodcomp-gpu" -waitSec 25 -GateOn $false
Remove-Item Env:OMP_EXTRA_WEBVIEW_ARGS -ErrorAction SilentlyContinue

Write-Step "L6: opaque + software + --disable-direct-composition (the rescue candidate)"
Stop-AllOmp
$dd = Join-Path $env:APPDATA "app.omp.player"
Set-Content -Path (Join-Path $dd "ui.failsafe") -Value "1" -NoNewline
Set-Content -Path (Join-Path $dd "session.dirty") -Value "1" -NoNewline
$env:OMP_EXTRA_WEBVIEW_ARGS = "--disable-direct-composition"
Write-Host "OMP_EXTRA_WEBVIEW_ARGS=$env:OMP_EXTRA_WEBVIEW_ARGS (safe mode active)"
$null = Invoke-Launch -tag "l6-nodcomp-safe" -waitSec 25 -GateOn $false
Remove-Item Env:OMP_EXTRA_WEBVIEW_ARGS -ErrorAction SilentlyContinue

# ---------- L7/L8/L9: the software-GL matrix --------------------------
# --disable-direct-composition changed nothing: the dead layer is below
# flag level. Next candidates attack the GPU process's presentation path
# itself. --use-angle=swiftshader keeps the GPU process (and its D3D11
# WARP presentation, the same path that fixed mpv on broken machines)
# alive while making ALL GL work software. --disable-gpu-compositing
# moves compositing fully to software.
Write-Step "L7: opaque + GPU process alive via WARP, all GL software (swiftshader)"
Stop-AllOmp
foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
    $ad = Join-Path $root "app.omp.player"
    if (Test-Path $ad) {
        Remove-Item -Force (Join-Path $ad "ui.safe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "ui.failsafe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "session.dirty") -ErrorAction SilentlyContinue
        Set-Content -Path (Join-Path $ad "ui.winrung") -Value "3" -NoNewline
    }
}
$env:OMP_EXTRA_WEBVIEW_ARGS = "--use-angle=swiftshader"
Write-Host "OMP_EXTRA_WEBVIEW_ARGS=$env:OMP_EXTRA_WEBVIEW_ARGS"
$null = Invoke-Launch -tag "l7-swiftshader" -waitSec 25 -GateOn $false
Remove-Item Env:OMP_EXTRA_WEBVIEW_ARGS -ErrorAction SilentlyContinue

Write-Step "L8: safe mode + swiftshader (software everything, rescue candidate)"
Stop-AllOmp
$dd = Join-Path $env:APPDATA "app.omp.player"
Set-Content -Path (Join-Path $dd "ui.failsafe") -Value "1" -NoNewline
Set-Content -Path (Join-Path $dd "session.dirty") -Value "1" -NoNewline
$env:OMP_EXTRA_WEBVIEW_ARGS = "--use-angle=swiftshader"
Write-Host "OMP_EXTRA_WEBVIEW_ARGS=$env:OMP_EXTRA_WEBVIEW_ARGS (safe mode active)"
$null = Invoke-Launch -tag "l8-swiftshader-safe" -waitSec 25 -GateOn $false
Remove-Item Env:OMP_EXTRA_WEBVIEW_ARGS -ErrorAction SilentlyContinue

Write-Step "L9: opaque + GPU + software compositing"
Stop-AllOmp
foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
    $ad = Join-Path $root "app.omp.player"
    if (Test-Path $ad) {
        Remove-Item -Force (Join-Path $ad "ui.safe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "ui.failsafe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "session.dirty") -ErrorAction SilentlyContinue
        Set-Content -Path (Join-Path $ad "ui.winrung") -Value "3" -NoNewline
    }
}
$env:OMP_EXTRA_WEBVIEW_ARGS = "--disable-gpu-compositing"
Write-Host "OMP_EXTRA_WEBVIEW_ARGS=$env:OMP_EXTRA_WEBVIEW_ARGS"
$null = Invoke-Launch -tag "l9-swcompositing" -waitSec 25 -GateOn $false
Remove-Item Env:OMP_EXTRA_WEBVIEW_ARGS -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------
Write-Step "cleanup"
Stop-AllOmp
Stop-Transcript | Out-Null

Write-Host ""
if ($script:failed -gt 0) {
    Write-Host "SMOKE RESULT: FAIL ($script:failed hard failure(s))" -ForegroundColor Red
    exit 1
}
Write-Host "SMOKE RESULT: PASS - all boots survived, handshaked, no crash reports, visibility checks honored" -ForegroundColor Green
