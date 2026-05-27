# Native Bridge Installer for Windows
# Registers the native messaging host so the Chrome extension can read
# Claude Code CLI credentials from ~/.claude/.credentials.json
#
# Run from the native-host directory:
#   powershell -ExecutionPolicy Bypass -File install.ps1

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  Hanzi Browse - Native Bridge Installer (Windows)  " -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# --- Locate files ------------------------------------------------------------

$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeScript = Join-Path $ScriptDir "native-bridge.cjs"

if (-not (Test-Path $BridgeScript)) {
    Write-Host "ERROR: native-bridge.cjs not found at: $BridgeScript" -ForegroundColor Red
    exit 1
}
Write-Host "OK  native-bridge.cjs: $BridgeScript" -ForegroundColor Green

# --- Find Node.js ------------------------------------------------------------

$NodePath = $null
try {
    $NodePath    = (Get-Command node -ErrorAction Stop).Source
    $NodeVersion = node --version
    Write-Host "OK  Node.js: $NodePath  ($NodeVersion)" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

# --- Create wrapper .cmd file ------------------------------------------------
# Chrome native messaging on Windows requires a .cmd/.bat/.exe as the host path.

$WrapperPath    = Join-Path $ScriptDir "native-bridge-win.cmd"
$WrapperContent = "@echo off`r`n`"$NodePath`" `"$BridgeScript`" %*`r`n"
[System.IO.File]::WriteAllText($WrapperPath, $WrapperContent, [System.Text.Encoding]::ASCII)
Write-Host "OK  Wrapper: $WrapperPath" -ForegroundColor Green

# --- Extension IDs -----------------------------------------------------------

$ChromeStoreId = "iklpkemlmbhemkiojndpbhoakgikpmcd"
$DevId         = "dnajlkacmnpfmilkeialficajdgkkkfo"

Write-Host ""
Write-Host "Enter your DEV extension ID (from chrome://extensions Developer mode)."
Write-Host "Press Enter to use the default: $DevId"
$InputId = Read-Host "  Extension ID"
if ($InputId.Trim() -ne "") {
    $DevId = $InputId.Trim()
}
Write-Host "OK  Extension IDs: $ChromeStoreId  +  $DevId" -ForegroundColor Green

# --- Write manifest JSON -----------------------------------------------------

$ManifestPath = Join-Path $ScriptDir "com.hanzi_browse.oauth_host.win.json"

# Build JSON manually (no here-string) to avoid encoding issues
$EscapedWrapper = $WrapperPath -replace '\\', '\\'
$ManifestJson  = "{`r`n"
$ManifestJson += "  `"name`": `"com.hanzi_browse.oauth_host`",`r`n"
$ManifestJson += "  `"description`": `"Native bridge for Hanzi Browse (Claude CLI credentials)`",`r`n"
$ManifestJson += "  `"path`": `"$EscapedWrapper`",`r`n"
$ManifestJson += "  `"type`": `"stdio`",`r`n"
$ManifestJson += "  `"allowed_origins`": [`r`n"
$ManifestJson += "    `"chrome-extension://$ChromeStoreId/`",`r`n"
$ManifestJson += "    `"chrome-extension://$DevId/`"`r`n"
$ManifestJson += "  ]`r`n"
$ManifestJson += "}`r`n"

[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson, [System.Text.Encoding]::UTF8)
Write-Host "OK  Manifest: $ManifestPath" -ForegroundColor Green

# --- Register in HKCU registry -----------------------------------------------
# Chrome reads native messaging hosts from:
#   HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>  (default = path to manifest JSON)

$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.hanzi_browse.oauth_host"
try {
    if (-not (Test-Path $RegPath)) {
        New-Item -Path $RegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $RegPath -Name "(default)" -Value $ManifestPath
    Write-Host "OK  Registry: $RegPath" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Could not write registry key: $_" -ForegroundColor Red
    exit 1
}

# Also register for Chrome Beta / Dev if installed
foreach ($Variant in @("Chrome Beta", "Chrome Dev")) {
    $AltPath = "HKCU:\Software\Google\$Variant\NativeMessagingHosts\com.hanzi_browse.oauth_host"
    try {
        if (Test-Path "HKCU:\Software\Google\$Variant") {
            if (-not (Test-Path $AltPath)) { New-Item -Path $AltPath -Force | Out-Null }
            Set-ItemProperty -Path $AltPath -Name "(default)" -Value $ManifestPath
            Write-Host "OK  Also registered for $Variant" -ForegroundColor Green
        }
    } catch {}
}

# --- Done --------------------------------------------------------------------

Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "  Installation complete!                            " -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Open chrome://extensions"
Write-Host "  2. Click the reload button on Hanzi Browse / job-auto-apply"
Write-Host "  3. Open the extension Settings and click Connect"
Write-Host ""
Write-Host "If you see 'Native host not found' after reloading, your extension"
Write-Host "ID may differ. Re-run this script and paste the correct ID."
Write-Host ""
