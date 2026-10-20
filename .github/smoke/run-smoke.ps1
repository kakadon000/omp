# =====================================================================
# OMP SMOKE TEST - real launches on a real Windows runner.
#
# Runs the actual OMP.exe three times on the runner's desktop:
#   L1  fresh boot          = the safe-mode probe every first launch does
#   L2  planted rescue      = ui.failsafe + session.dirty set (the exact
#                             path a broken machine takes after a bad boot)
#   L3  after graceful exit = the normal GPU path a healthy machine takes
#
# HARD pass criteria per launch: process stays alive for the full wait,
# no OMP-report.txt appears on the Desktop, "ui_ready" handshake lands
# in boot.log. Screenshots + boot logs are saved as evidence either way.
# =====================================================================
param([string]$StageDir = "smoke-stage")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$desktop = [Environment]::GetFolderPath("Desktop")
$ws = (Get-Location).Path
$out = Join-Path $ws "smoke-out"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Start-Transcript -Path (Join-Path $out "smoke-transcript.txt") | Out-Null

$script:failed = 0

function Write-Step($msg) { Write-Host "`n===== $msg =====" -ForegroundColor Cyan }

function Find-Report {
    # bootguard writes OMP-report.txt to Desktop / OneDrive Desktop /
    # USERPROFILE / TEMP - check every fallback it can pick
    $dirs = @(
        $desktop,
        (Join-Path $env:USERPROFILE "Desktop"),
        (Join-Path $env:USERPROFILE "OneDrive\Desktop"),
        (Join-Path $env:USERPROFILE "OneDrive"),
        $env:TEMP,
        $env:USERPROFILE
    )
    foreach ($d in $dirs) {
        if ($d -and (Test-Path (Join-Path $d "OMP-report.txt"))) {
            return (Join-Path $d "OMP-report.txt")
        }
    }
    return $null
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
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
        $bmp.Save((Join-Path $out "screen-$tag.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        Write-Host "screenshot saved: screen-$tag.png"
    } catch {
        Write-Host "screenshot failed: $($_.Exception.Message)"
    }
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
$reportDirs = @($desktop, (Join-Path $env:USERPROFILE "OneDrive\Desktop"), $env:TEMP, $env:USERPROFILE)
foreach ($d in $reportDirs) {
    if ($d) { Remove-Item -Force (Join-Path $d "OMP-report.txt") -ErrorAction SilentlyContinue }
}
Write-Host "app data + old reports wiped"

# ---------------------------------------------------------------------
function Invoke-Launch([string]$tag, [int]$waitSec) {
    Write-Step "launch $tag"
    $proc = Start-Process -FilePath $exe.FullName -WorkingDirectory $appDir -PassThru
    Start-Sleep -Seconds 4
    $aliveNow = -not $proc.HasExited
    Write-Host "alive after 4s: $aliveNow"

    $deadline = (Get-Date).AddSeconds($waitSec)
    $report = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if ($proc.HasExited) { break }
        $report = Find-Report
        if ($report) { break }
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
    $safeLine = ($log -split "`n" | Where-Object { $_ -match "safe_mode=" } | Select-Object -Last 1)
    Write-Host "handshake(ui_ready): $hs   paint-ok: $paintOk   paint-suspect: $paintSus"
    if ($safeLine) { Write-Host "boot states: $safeLine" }
    $tail = ($log -split "`n" | Select-Object -Last 12) -join "`n"
    Write-Host "---- boot.log tail ----`n$tail`n-----------------------"

    if ($report) {
        $script:failed++
        Write-Host "FAIL [$tag]: OMP-report.txt appeared: $report" -ForegroundColor Red
        Get-Content $report -TotalCount 30 | Out-String | Write-Host
    }
    if ($proc.HasExited) {
        $script:failed++
        Write-Host "FAIL [$tag]: process exited before the deadline" -ForegroundColor Red
    }
    if (-not $hs) {
        $script:failed++
        Write-Host "FAIL [$tag]: no ui_ready handshake in boot.log" -ForegroundColor Red
    }
    Save-Screen $tag
    return $log
}

# ---------- L1: fresh boot = safe-mode probe -------------------------
Write-Step "L1: fresh boot (safe-mode probe - every first launch does this)"
$null = Invoke-Launch -tag "l1-fresh" -waitSec 40

# ---------- L2: planted rescue = the broken-machine path -------------
Write-Step "L2: force-kill L1, plant ui.failsafe + session.dirty (rescue state)"
Stop-AllOmp
$dd = Join-Path $env:APPDATA "app.omp.player"
New-Item -ItemType Directory -Force -Path $dd | Out-Null
Set-Content -Path (Join-Path $dd "ui.failsafe") -Value "1" -NoNewline
Set-Content -Path (Join-Path $dd "session.dirty") -Value "1" -NoNewline
Write-Host "rescue markers planted"

Write-Step "L2: rescue boot (safe graphics - the exact path a broken machine takes)"
$null = Invoke-Launch -tag "l2-rescue" -waitSec 40

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

Write-Step "L3: normal boot after clean exit"
$null = Invoke-Launch -tag "l3-normal" -waitSec 30

# ---------------------------------------------------------------------
Write-Step "cleanup"
Stop-AllOmp
Stop-Transcript | Out-Null

Write-Host ""
if ($script:failed -gt 0) {
    Write-Host "SMOKE RESULT: FAIL ($script:failed hard failure(s))" -ForegroundColor Red
    exit 1
}
Write-Host "SMOKE RESULT: PASS - all three boots survived, handshaked, no crash reports" -ForegroundColor Green
