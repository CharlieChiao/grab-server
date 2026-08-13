param(
  [string]$Server = "https://api.cn.orangechai.fun/grab",
  [string]$VenueId = "picklepop",
  [string]$Token = $env:CREDENTIAL_UPDATE_TOKEN,
  [string]$Value
)

$ErrorActionPreference = "Stop"

if (-not $Value) {
  $Value = Get-Clipboard -Raw
}
if (-not $Value) {
  throw "剪贴板为空，请先复制 PSPLVISITORID 或包含该请求头的抓包文本。"
}

$body = @{ text = $Value } | ConvertTo-Json
$headers = @{}
if ($Token) {
  $headers["x-credential-update-token"] = $Token
}

$url = "$Server/api/credentials/$VenueId/ingest"
try {
  $result = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -ContentType "application/json" -Body $body
  if (-not $result.ok) { throw ($result | ConvertTo-Json -Compress) }
  Write-Host "凭证已发送并保存。ready=$($result.ready)" -ForegroundColor Green
} catch {
  Write-Error "凭证更新失败：$($_.Exception.Message)"
  exit 1
}
