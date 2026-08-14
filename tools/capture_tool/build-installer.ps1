$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "../..")
$appExe = Join-Path $root "dist/CourtCredentialCapture/CourtCredentialCapture.exe"
$compilerCandidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)
$compiler = $compilerCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not (Test-Path $appExe)) {
    & (Join-Path $PSScriptRoot "build.ps1")
}
if (-not $compiler) {
    throw "Inno Setup 6 not found. Install JRSoftware.InnoSetup first."
}

& $compiler (Join-Path $root "installer/CourtCredentialCapture.iss")
if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed with exit code $LASTEXITCODE." }
Write-Host "Setup generated at dist/setup/CourtCredentialCapture-Setup.exe" -ForegroundColor Green
