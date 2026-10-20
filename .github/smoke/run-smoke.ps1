# =====================================================================
# OMP SMOKE TEST v2 - real launches on a real Windows runner.
#
# Runs the actual OMP.exe three times on the runner's desktop:
#   L1  fresh boot          = the safe-mode probe every first launch does
#                             (v0.15.8: safe mode = OPAQUE window rungs)
#   L2  planted rescue      = ui.failsafe + session.dirty set (the exact
#                             path a broken machine takes after a bad boot)
#   L3  after clean exit    = normal GPU path (ui.safe/ui.winrung cleared)
#
# HARD pass criteria per launch:
#   - process stays alive for the full wait
#   - no NEW crash report (the planted-rescue "did not close cleanly"
#     info report is EXPECTED and does not fail the run)
#   - "ui_ready" handshake lands in boot.log
#   - for opaque (safe-mode) launches: the window must actually SHOW
#     content - PrintWindow capture + pixel variance gate catches the
#     "alive but flat gray/black surface" disease that rAF cannot see
# Evidence saved either way: full-screen shots, window-only PrintWindow
# captures, boot logs, any reports, full transcript.
# =====================================================================
param([string]$StageDir = "smoke-stage")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not ("WU32" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct WRECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class WU32 {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out WRECT rect);
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
    # PrintWindow with PW_RENDERFULLCONTENT: asks the WINDOW to render
    # itself into our bitmap - the ground truth of what this window paints,
    # independent of what DWM composites onto the monitor.
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

# ---------------------------------------------------------------------
Write-Step "stage the build"
$exe = Get-ChildItem -Path $StageDir -Recurse -Filter "OMP.exe" |
    Where-Object { $_.FullName -notmatch '\\bundle\\' } | Select-Object -First 1
if (-not $exe) { throw "OMP.exe not found in $StageDir" }
$appDir = $exe.Directory.FullName
Write-Host "exe: $($exe.FullName) ($([math]::Round($exe.Length/1MB,1)) MB)"
if (Test-Path (Join-Path $appDir "resources")) {
    Write-Host "resources dir present next to the exe (portable layout)"
} else {
    Write-Host "WARNING: no resources dir next to the exe - mpv will not init (video not needed for the boot smoke)"
}

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
Write-Step "clean slate (fresh-install state)"
Stop-AllOmp
Remove-Item -Recurse -Force "$env:APPDATA\app.omp.player" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\app.omp.player" -ErrorAction SilentlyContinue
Wipe-Reports
Write-Host "app data + old reports wiped"

# ---------------------------------------------------------------------
function Invoke-Launch([string]$tag, [int]$waitSec, [bool]$RequireVisible) {
    Write-Step "launch $tag (visible-window gate: $RequireVisible)"
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
    $paintSus = $log -match "SUSPECT"
    $opaqueRung = $log -match "restricted to the opaque rungs"
    $safeLine = ($log -split "`n" | Where-Object { $_ -match "safe_mode=" } | Select-Object -Last 1)
    Write-Host "handshake(ui_ready): $hs   paint-ok: $paintOk   paint-suspect: $paintSus   opaque-safe-rule: $opaqueRung"
    if ($safeLine) { Write-Host "boot states: $safeLine" }
    $tail = ($log -split "`n" | Select-Object -Last 10) -join "`n"
    Write-Host "---- boot.log tail ----`n$tail`n-----------------------"

    # ---- report classification ---------------------------------------
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

    # ---- visible-window gate (the black-surface net) -------------------
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $wcap = Save-WindowCapture $proc.MainWindowHandle $tag
        if ($wcap) {
            $st = Get-BitmapStats $wcap
            Write-Host ("window pixels: mean={0} std={1} distinct-colors={2}" -f $st.mean, $st.std, $st.colors)
            $flat = ($st.std -ge 0) -and ($st.std -lt 3.0)
            if ($flat) {
                if ($RequireVisible) {
                    $script:failed++
                    Write-Host "FAIL [$tag]: FLAT WINDOW - the surface paints no content (std $($st.std) < 3.0). This is the black-window disease." -ForegroundColor Red
                } else {
                    Write-Host "WARN [$tag]: window surface is flat (std $($st.std)) - acceptable for this launch (glass on a VM), informational only" -ForegroundColor Yellow
                }
            } else {
                Write-Host "window shows REAL content - visible-window gate PASSED" -ForegroundColor Green
            }
            $wcap.Dispose()
        } else {
            if ($RequireVisible) {
                $script:failed++
                Write-Host "FAIL [$tag]: window capture impossible (empty rect or PrintWindow failure) with the visible-window gate on" -ForegroundColor Red
            }
        }
    } else {
        if ($RequireVisible) {
            $script:failed++
            Write-Host "FAIL [$tag]: no MainWindowHandle - the window never became visible" -ForegroundColor Red
        }
    }

    Save-Screen $tag
    return $log
}

# ---------- L1: fresh boot = safe-mode probe (opaque rungs) ----------
Write-Step "L1: fresh boot (safe-mode probe - opaque window per the v0.15.8 rule)"
$null = Invoke-Launch -tag "l1-fresh" -waitSec 40 -RequireVisible $true

# ---------- L2: planted rescue = the broken-machine path -------------
Write-Step "L2: force-kill L1, plant ui.failsafe + session.dirty (rescue state)"
Stop-AllOmp
$dd = Join-Path $env:APPDATA "app.omp.player"
New-Item -ItemType Directory -Force -Path $dd | Out-Null
Set-Content -Path (Join-Path $dd "ui.failsafe") -Value "1" -NoNewline
Set-Content -Path (Join-Path $dd "session.dirty") -Value "1" -NoNewline
Write-Host "rescue markers planted"

Write-Step "L2: rescue boot (safe graphics - the exact path a broken machine takes)"
$null = Invoke-Launch -tag "l2-rescue" -waitSec 40 -RequireVisible $true

# ---------- L3: after a graceful exit = normal GPU path --------------
Write-Step "L3: close L2 gracefully (clean exit clears session.dirty)"
$procL2 = Get-Process OMP -ErrorAction SilentlyContinue | Select-Object -First 1
if ($procL2) {
    $null = $procL2.CloseMainWindow()
    Wait-OmpExit $procL2 12
    Write-Host "L2 closed"
} else {
    Write-Host "no OMP process found for the graceful close"
}

# clear the sticky safe markers so L3 really exercises the NORMAL path
# (glass rung 1). On a VM the glass backdrop may still capture flat -
# that is why the visible-window gate is OFF for this launch.
foreach ($root in @($env:APPDATA, $env:LOCALAPPDATA)) {
    $ad = Join-Path $root "app.omp.player"
    if (Test-Path $ad) {
        Remove-Item -Force (Join-Path $ad "ui.safe") -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ad "ui.winrung") -ErrorAction SilentlyContinue
    }
}
Write-Step "L3: normal boot after clean exit (sticky safe markers cleared)"
$null = Invoke-Launch -tag "l3-normal" -waitSec 30 -RequireVisible $false

# ---------------------------------------------------------------------
Write-Step "cleanup"
Stop-AllOmp
Stop-Transcript | Out-Null

Write-Host ""
if ($script:failed -gt 0) {
    Write-Host "SMOKE RESULT: FAIL ($script:failed hard failure(s))" -ForegroundColor Red
    exit 1
}
Write-Host "SMOKE RESULT: PASS - all boots survived, handshaked, no crash reports, opaque windows showed real content" -ForegroundColor Green
