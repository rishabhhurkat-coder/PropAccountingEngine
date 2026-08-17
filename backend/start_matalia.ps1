$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$frontend = Join-Path $root 'frontend'
$runtime = Join-Path $root 'Other Logs\Runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$runId = "{0:yyyyMMdd-HHmmss}-{1}" -f (Get-Date), $PID

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Matalia SL'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object System.Drawing.Size(660, 310)
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(12, 19, 37)
$form.ShowInTaskbar = $true
$form.Icon = [System.Drawing.SystemIcons]::Application
$form.Add_Paint({
    param($sender, $event)
    $graphics = $event.Graphics
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Rectangle(0, 0, 660, 310)),
        [System.Drawing.Color]::FromArgb(12, 19, 37),
        [System.Drawing.Color]::FromArgb(25, 30, 68),
        20
    )
    $graphics.FillRectangle($background, 0, 0, 660, 310)
    $background.Dispose()

    # Soft ambient light behind the isometric mark.
    $glow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(30, 91, 104, 255))
    $graphics.FillEllipse($glow, 447, 42, 172, 172)
    $glow.Dispose()

    # Three layered faces create a compact 3D Matalia mark.
    $top = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(111, 106, 255))
    $left = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(64, 189, 255))
    $right = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(41, 67, 177))
    $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(54, 233, 197))
    $topFace = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(520, 57)), (New-Object System.Drawing.Point(594, 99)),
        (New-Object System.Drawing.Point(560, 119)), (New-Object System.Drawing.Point(486, 77))
    )
    $leftFace = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(486, 77)), (New-Object System.Drawing.Point(560, 119)),
        (New-Object System.Drawing.Point(560, 191)), (New-Object System.Drawing.Point(486, 149))
    )
    $rightFace = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(560, 119)), (New-Object System.Drawing.Point(594, 99)),
        (New-Object System.Drawing.Point(594, 171)), (New-Object System.Drawing.Point(560, 191))
    )
    $accentFace = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(520, 105)), (New-Object System.Drawing.Point(546, 120)),
        (New-Object System.Drawing.Point(546, 161)), (New-Object System.Drawing.Point(520, 146))
    )
    $accentTop = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point(520, 105)), (New-Object System.Drawing.Point(546, 120)),
        (New-Object System.Drawing.Point(576, 103)), (New-Object System.Drawing.Point(550, 88))
    )
    $graphics.FillPolygon($top, $topFace)
    $graphics.FillPolygon($left, $leftFace)
    $graphics.FillPolygon($right, $rightFace)
    $graphics.FillPolygon($accent, $accentFace)
    $graphics.FillPolygon($top, $accentTop)
    $top.Dispose(); $left.Dispose(); $right.Dispose(); $accent.Dispose()

    $pill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(34, 49, 84))
    $graphics.FillRectangle($pill, 30, 24, 116, 24)
    $pill.Dispose()
})

$title = New-Object System.Windows.Forms.Label
$title.Text = 'MATALIA  /  SL'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(150, 163, 255)
$title.AutoSize = $true
$title.BackColor = [System.Drawing.Color]::Transparent
$title.Location = New-Object System.Drawing.Point(43, 30)
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Preparing your workspace'
$status.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 21, [System.Drawing.FontStyle]::Bold)
$status.ForeColor = [System.Drawing.Color]::FromArgb(239, 243, 255)
$status.AutoSize = $true
$status.BackColor = [System.Drawing.Color]::Transparent
$status.Location = New-Object System.Drawing.Point(30, 86)
$form.Controls.Add($status)

$subtext = New-Object System.Windows.Forms.Label
$subtext.Text = 'Securely connecting your services and preparing the Matalia bridge.'
$subtext.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$subtext.ForeColor = [System.Drawing.Color]::FromArgb(151, 166, 197)
$subtext.AutoSize = $true
$subtext.BackColor = [System.Drawing.Color]::Transparent
$subtext.Location = New-Object System.Drawing.Point(32, 132)
$form.Controls.Add($subtext)

$progress = New-Object System.Windows.Forms.Panel
$progress.BackColor = [System.Drawing.Color]::FromArgb(35, 49, 82)
$progress.Size = New-Object System.Drawing.Size(410, 6)
$progress.Location = New-Object System.Drawing.Point(32, 207)
$form.Controls.Add($progress)

$progressGlow = New-Object System.Windows.Forms.Panel
$progressGlow.BackColor = [System.Drawing.Color]::FromArgb(100, 120, 255)
$progressGlow.Size = New-Object System.Drawing.Size(128, 6)
$progressGlow.Location = New-Object System.Drawing.Point(0, 0)
$progress.Controls.Add($progressGlow)

$motion = 0
$direction = 5
$progressTimer = New-Object System.Windows.Forms.Timer
$progressTimer.Interval = 25
$progressTimer.Add_Tick({
    $motion += $direction
    if ($motion -ge 282 -or $motion -le 0) { $direction = -$direction }
    $progressGlow.Left = $motion
})
$progressTimer.Start()

$detail = New-Object System.Windows.Forms.Label
$detail.Text = 'Please wait...'
$detail.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 8)
$detail.ForeColor = [System.Drawing.Color]::FromArgb(95, 223, 202)
$detail.AutoSize = $true
$detail.BackColor = [System.Drawing.Color]::Transparent
$detail.Location = New-Object System.Drawing.Point(32, 229)
$form.Controls.Add($detail)

$footer = New-Object System.Windows.Forms.Label
$footer.Text = 'MATALIA SYSTEMS  •  DATA OPERATIONS'
$footer.Font = New-Object System.Drawing.Font('Segoe UI', 7)
$footer.ForeColor = [System.Drawing.Color]::FromArgb(100, 117, 153)
$footer.AutoSize = $true
$footer.BackColor = [System.Drawing.Color]::Transparent
$footer.Location = New-Object System.Drawing.Point(32, 270)
$form.Controls.Add($footer)

$form.Show()
$form.Refresh()
[System.Windows.Forms.Application]::DoEvents()

function Set-Status([string] $message, [string] $small = '') {
    $status.Text = $message
    $detail.Text = $small
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

function Test-PortInUse([int] $port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(250)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch { return $false }
    finally { $client.Close() }
}

function Find-FreePort([int] $preferred) {
    for ($port = $preferred; $port -le ($preferred + 20); $port++) {
        if (-not (Test-PortInUse $port)) { return $port }
    }
    throw "No free backend port was found between $preferred and $($preferred + 20)."
}

function Wait-ForUrl([string] $url, [System.Diagnostics.Process] $process = $null, [int] $attempts = 8) {
    for ($i = 0; $i -lt $attempts; $i++) {
        if ($process -and $process.HasExited) {
            throw "The required service stopped before it was ready."
        }
        try {
            Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1 | Out-Null
            return
        } catch {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 250
        }
    }
    throw "Matalia did not become ready within 3 seconds: $url"
}

function Get-LastError([string] $path) {
    if (-not (Test-Path $path)) { return 'No startup log was created.' }
    $lines = Get-Content -LiteralPath $path -Tail 8
    if ($lines) { return ($lines -join [Environment]::NewLine) }
    return 'The service exited without writing an error.'
}

try {
    Set-Status 'Checking Matalia requirements' 'Verifying backend and frontend files...'
    if (-not (Test-Path (Join-Path $root 'backend\main.py'))) { throw 'Backend file is missing.' }
    if (-not (Test-Path (Join-Path $frontend 'package.json'))) { throw 'Frontend package.json is missing.' }
    if (-not (Test-Path (Join-Path $frontend 'node_modules'))) { throw 'Frontend dependencies are missing. Run npm install in frontend.' }

    $backendPort = Find-FreePort 8001
    $backendUrl = "http://127.0.0.1:$backendPort"
    $frontendPort = Find-FreePort 3489
    $frontendUrl = "http://127.0.0.1:$frontendPort"
    # Each launch has separate logs so a currently running service never locks
    # a shared log file and prevents Matalia from restarting.
    $backendOut = Join-Path $runtime "backend-$runId.log"
    $backendErr = Join-Path $runtime "backend-$runId-error.log"
    $frontendOut = Join-Path $runtime "frontend-$runId.log"
    $frontendErr = Join-Path $runtime "frontend-$runId-error.log"
    New-Item -ItemType File -Path $backendOut, $backendErr, $frontendOut, $frontendErr -Force | Out-Null

    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        $backendFile = $python.Source
        $backendArgs = "-u -m uvicorn backend.main:app --host 127.0.0.1 --port $backendPort"
    } else {
        $py = Get-Command py.exe -ErrorAction SilentlyContinue
        if (-not $py) { throw 'Python was not found on PATH.' }
        $backendFile = $py.Source
        $backendArgs = "-3 -u -m uvicorn backend.main:app --host 127.0.0.1 --port $backendPort"
    }

    $backendReady = $false
    for ($attempt = 1; $attempt -le 2 -and -not $backendReady; $attempt++) {
        $backendPort = Find-FreePort 8001
        $backendUrl = "http://127.0.0.1:$backendPort"
        $backendArgs = $backendArgs -replace '--port \d+', "--port $backendPort"
        $attemptText = if ($attempt -eq 1) { 'Starting backend API' } else { 'Retrying backend API' }
        Set-Status $attemptText "Attempt $attempt of 2 on port $backendPort..."
        $backendProcess = Start-Process -FilePath $backendFile -ArgumentList $backendArgs -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $backendOut -RedirectStandardError $backendErr -PassThru
        try {
            Wait-ForUrl "$backendUrl/api/rawtxtdata" $backendProcess
            $backendReady = $true
        } catch {
            if ($backendProcess -and -not $backendProcess.HasExited) { Stop-Process $backendProcess.Id -Force }
            if ($attempt -eq 2) {
                throw "Backend could not start after an automatic retry.`n$(Get-LastError $backendErr)"
            }
            Set-Status 'Backend restart required' 'The first attempt stopped. Retrying automatically...'
            Start-Sleep -Milliseconds 250
        }
    }
    Set-Status 'Backend API is ready' "$backendUrl"

    $frontendReady = $false
    for ($attempt = 1; $attempt -le 2 -and -not $frontendReady; $attempt++) {
        $frontendPort = Find-FreePort 3489
        $frontendUrl = "http://127.0.0.1:$frontendPort"
        $attemptText = if ($attempt -eq 1) { 'Starting Matalia interface' } else { 'Retrying Matalia interface' }
        Set-Status $attemptText "Attempt $attempt of 2 on port $frontendPort..."
        $frontendCommand = "set VITE_BACKEND_URL=$backendUrl&& npm run dev -- --host 127.0.0.1 --port $frontendPort --strictPort"
        $frontendProcess = Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /c $frontendCommand" -WorkingDirectory $frontend -WindowStyle Hidden -RedirectStandardOutput $frontendOut -RedirectStandardError $frontendErr -PassThru
        try {
            Wait-ForUrl "$frontendUrl/raw-trade-import" $frontendProcess
            $frontendReady = $true
        } catch {
            if ($frontendProcess -and -not $frontendProcess.HasExited) { Stop-Process $frontendProcess.Id -Force }
            if ($attempt -eq 2) {
                throw "Frontend could not start after an automatic retry.`n$(Get-LastError $frontendErr)"
            }
            Set-Status 'Interface restart required' 'The first attempt stopped. Retrying automatically...'
            Start-Sleep -Milliseconds 250
        }
    }
    Set-Status 'Matalia is ready' "$frontendUrl/raw-trade-import"
    Start-Process "$frontendUrl/raw-trade-import"
    Start-Sleep -Milliseconds 700
    $progressTimer.Stop()
    $progressTimer.Dispose()
    $form.Close()
    $form.Dispose()
    exit 0
} catch {
    $message = $_.Exception.Message
    Set-Status 'Matalia could not start' $message
    $progressTimer.Stop()
    $progressGlow.BackColor = [System.Drawing.Color]::FromArgb(242, 103, 123)
    $progressGlow.Width = $progress.Width
    [System.Windows.Forms.MessageBox]::Show($form, "$message`n`nSee Other Logs\Runtime logs for details.", 'Matalia Startup Error', 'OK', 'Error') | Out-Null
    if ($backendProcess -and -not $backendProcess.HasExited) { Stop-Process $backendProcess.Id -Force }
    if ($frontendProcess -and -not $frontendProcess.HasExited) { Stop-Process $frontendProcess.Id -Force }
    $form.Close()
    $form.Dispose()
    exit 1
}
