param(
  [Parameter(Mandatory = $true)]
  [string]$Repo,
  [string]$EnvFile = ".env"
)

$ErrorActionPreference = 'Stop'

$Gh = 'C:\Program Files\GitHub CLI\gh.exe'
if (-not (Test-Path $Gh)) {
  throw "GitHub CLI not found: $Gh"
}
if (-not (Test-Path $EnvFile)) {
  throw "Env file not found: $EnvFile"
}

$Required = @(
  'PEXELS_API_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'IG_USER_ID',
  'META_ACCESS_TOKEN',
  'META_GRAPH_VERSION'
)

$Optional = @(
  'PIXABAY_API_KEY',
  'UNSPLASH_ACCESS_KEY',
  'CLOUDINARY_UPLOAD_PRESET',
  'REEL_SOURCE',
  'PUBLISH_FORMAT_GAP_MS',
  'FALLBACK_FORMAT_GAP_MS',
  'REEL_AUDIO_URL',
  'REEL_AUDIO_VOLUME',
  'REEL_AUDIO_TITLE',
  'REEL_AUDIO_CREATOR',
  'REEL_AUDIO_SOURCE_URL',
  'REEL_AUDIO_LICENSE',
  'REEL_AUDIO_CREDIT'
)

$EnvValues = @{}
foreach ($Line in [System.IO.File]::ReadAllLines((Resolve-Path $EnvFile))) {
  if ($Line -match '^([A-Z0-9_]+)=(.*)$') {
    $Key = $Matches[1]
    $Value = $Matches[2].Trim()
    $Value = $Value -replace '^[ ''"]|[ ''"]$', ''
    if ($Value) {
      $EnvValues[$Key] = $Value
    }
  }
}

$Missing = @()
foreach ($Key in $Required) {
  if (-not $EnvValues.ContainsKey($Key)) {
    $Missing += $Key
  }
}
if ($Missing.Count -gt 0) {
  throw "Missing required .env values: $($Missing -join ', ')"
}

foreach ($Key in ($Required + $Optional)) {
  if ($EnvValues.ContainsKey($Key)) {
    $EnvValues[$Key] | & $Gh secret set $Key --repo $Repo | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to set GitHub secret: $Key"
    }
    Write-Output "set secret $Key"
  }
}

Write-Output "GitHub secrets configured for $Repo"
