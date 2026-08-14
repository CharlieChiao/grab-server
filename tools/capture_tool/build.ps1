$ErrorActionPreference = "Stop"
$toolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $toolRoot "../..")
$requirements = Join-Path $toolRoot "requirements.txt"
$entry = Join-Path $toolRoot "main.py"
$venue = Join-Path $root "src/venues/picklepop/venue.yml"
$config = Join-Path $toolRoot "capture_tool_config.py"
@"
SERVER_URL = "https://api.cn.orangechai.fun/grab"
UPDATE_TOKEN = ""
"@ | Set-Content $config -Encoding utf8
python -m pip install -r $requirements
python -m PyInstaller --noconfirm --clean --onefile --windowed --name CourtCredentialCapture --add-data "$venue;src/venues/picklepop" $entry
Write-Host "EXE 已生成到 dist/CourtCredentialCapture.exe" -ForegroundColor Green
