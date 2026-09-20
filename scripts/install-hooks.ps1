# Activates the hooks in .githooks/ for this clone (Windows / PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-hooks.ps1
#
# core.hooksPath is local configuration and is not carried by a clone, so
# this has to be run once per checkout.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

git config core.hooksPath .githooks

# This repository has core.filemode=false, so the executable bit is not
# tracked by default. Set it explicitly or the hooks land non-executable on
# Linux and macOS.
Get-ChildItem -Path .githooks -File | ForEach-Object {
  git update-index --chmod=+x (".githooks/" + $_.Name) 2>$null
}

Write-Output 'hooks installed: core.hooksPath -> .githooks'
Write-Output 'checks: credential files, credential shapes, local .env values,'
Write-Output '        .env.example values, >1MB blobs, typecheck + offline tests'
