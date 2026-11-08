$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $root 'app\tools\launch.mjs') -PathType Leaf)) {
    throw 'Keep this launcher beside the complete BudgetMe app folder.'
}
$runtime = Join-Path $root '.runtime'
foreach ($part in @('temp', 'home', 'cache', 'appdata', 'localappdata')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $runtime $part) | Out-Null
}
$env:TEMP = Join-Path $runtime 'temp'
$env:TMP = $env:TEMP
$env:HOME = Join-Path $runtime 'home'
$env:USERPROFILE = $env:HOME
$env:APPDATA = Join-Path $runtime 'appdata'
$env:LOCALAPPDATA = Join-Path $runtime 'localappdata'
$env:XDG_CACHE_HOME = Join-Path $runtime 'cache'
$env:npm_config_cache = Join-Path $runtime 'cache\npm'
$env:npm_config_update_notifier = 'false'
Set-Location (Join-Path $root 'app')
& node tools\launch.mjs
if ($LASTEXITCODE -ne 0) { throw "BudgetMe exited with code $LASTEXITCODE." }
