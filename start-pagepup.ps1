$ErrorActionPreference = 'Stop'
$port = if ($env:PAGEPUP_WEBUI_PORT) { [int]$env:PAGEPUP_WEBUI_PORT } else { 6100 }
if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid PAGEPUP_WEBUI_PORT.' }
$url = "http://127.0.0.1:$port/"

function Test-PagePup {
    try {
        $status = Invoke-RestMethod -Uri ($url + 'status') -TimeoutSec 1
        return $status -and ($status.PSObject.Properties.Name -contains 'signedOut') -and
            ($status.PSObject.Properties.Name -contains 'forwarding')
    } catch {
        return $false
    }
}

if (Test-PagePup) {
    Start-Process $url
    exit 0
}

$harness = Join-Path $env:SystemDrive 'DeepSeek Harness\resources\runtime\primary-runtime\dependencies'
if (Test-Path -LiteralPath 'E:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe') {
    $harness = 'E:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies'
}
$node = Get-Command (Join-Path $harness 'node\bin\node.exe') -ErrorAction SilentlyContinue
if (-not $node) { $node = Get-Command node.exe -ErrorAction SilentlyContinue }
if (-not $node) {
    $node = Get-Command (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe') -ErrorAction SilentlyContinue
}
if (-not $node) { throw 'Node.js 24 is required. Install it from https://nodejs.org/en/download and try again.' }

$dependenciesReady = Join-Path $PSScriptRoot 'node_modules\qrcode\package.json'
if (-not (Test-Path -LiteralPath $dependenciesReady)) {
    $env:Path = (Split-Path -Parent $node.Source) + ';' + $env:Path
    $bundledPnpm = Join-Path $harness 'pnpm\bin\pnpm.cjs'
    Write-Host 'Installing PagePup dependencies. First launch needs internet access.'
    if (Test-Path -LiteralPath $bundledPnpm) {
        & $node.Source $bundledPnpm --dir $PSScriptRoot install --frozen-lockfile
    } else {
        $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
        if (-not $pnpm) { throw 'Install pnpm and try again.' }
        & $pnpm.Source --dir $PSScriptRoot install --frozen-lockfile
    }
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. See the error above.' }
}

$process = Start-Process -FilePath $node.Source -ArgumentList 'bili-dm-listener.mjs', '--webui' -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($process.HasExited) { throw 'PagePup stopped during startup. See the error above.' }
    if (Test-PagePup) {
        Start-Process $url
        Write-Host 'PagePup is running. Keep this window open.'
        $process.WaitForExit()
        exit $process.ExitCode
    }
    Start-Sleep -Milliseconds 250
}
Stop-Process -InputObject $process -ErrorAction SilentlyContinue
throw 'PagePup did not start in time.'
