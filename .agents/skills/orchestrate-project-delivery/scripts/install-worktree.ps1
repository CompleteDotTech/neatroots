param([string]$Worktree = (Get-Location).Path)
$ErrorActionPreference = 'Stop'

# This installer stays local to this repository. Never copy into another repo.
$sourceSkill = Split-Path $PSScriptRoot -Parent
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $sourceSkill '../../..'))
$targetRoot = & git -C $Worktree rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw 'Target is not a Git worktree' }
$sourceCommon = & git -C $sourceRoot rev-parse --path-format=absolute --git-common-dir
if ($LASTEXITCODE -ne 0) { throw 'Source Git directory is unavailable' }
$targetCommon = & git -C $targetRoot rev-parse --path-format=absolute --git-common-dir
if ($LASTEXITCODE -ne 0 -or $sourceCommon -ne $targetCommon) {
    throw 'Target does not belong to the configured repository'
}

$pairs = @()
$localOverride = Join-Path $sourceRoot 'AGENTS.override.md'
if (Test-Path -LiteralPath $localOverride) {
    $pairs += @{Source=$localOverride; Target=(Join-Path $targetRoot 'AGENTS.override.md')}
}
foreach ($file in Get-ChildItem -LiteralPath $sourceSkill -Recurse -File) {
    $relative = [IO.Path]::GetRelativePath($sourceSkill, $file.FullName)
    $pairs += @{Source=$file.FullName; Target=(Join-Path $targetRoot ".agents/skills/orchestrate-project-delivery/$relative")}
}

# Preflight every destination before any copying. Preserve local customizations.
foreach ($pair in $pairs) {
    if (Test-Path -LiteralPath $pair.Target) {
        if ((Get-FileHash -LiteralPath $pair.Source).Hash -ne (Get-FileHash -LiteralPath $pair.Target).Hash) {
            throw "Existing local guidance differs; reconcile manually: $($pair.Target)"
        }
    }
    $relativeTarget = [IO.Path]::GetRelativePath($targetRoot, $pair.Target).Replace('\', '/')
    & git -C $targetRoot ls-files --error-unmatch -- $relativeTarget 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & git -C $targetRoot check-ignore --quiet -- $relativeTarget
        if ($LASTEXITCODE -ne 0) { throw "Local workflow path is neither tracked nor Git-excluded: $($pair.Target)" }
    }
}
foreach ($pair in $pairs) {
    if (!(Test-Path -LiteralPath $pair.Target)) {
        New-Item -ItemType Directory -Path (Split-Path $pair.Target) -Force | Out-Null
        Copy-Item -LiteralPath $pair.Source -Destination $pair.Target
    }
}
Write-Output "Local workflow ready: $targetRoot"
