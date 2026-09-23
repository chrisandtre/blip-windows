<#
build-release.ps1 - build the Blip for Windows installer.

  windows\scripts\build-release.ps1

Needs Rust (MSVC), Bun, and the VS C++ build tools. Output:
  windows\target\release\bundle\nsis\Blip for Windows_<version>_x64-setup.exe
#>
$ErrorActionPreference = 'Stop'
# Mock mode (fake sends, a local HTTP bridge) is compiled in only when this is
# set; a release must never carry it.
if ($env:VITE_BLIP_MOCK) { throw 'VITE_BLIP_MOCK is set: refusing to build a release with mock mode' }
$win = Resolve-Path (Join-Path $PSScriptRoot '..')
$repo = Resolve-Path (Join-Path $win '..')

function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

Push-Location $win
try {
  Step 'blip-mux + blip-shim (release)'
  cargo build --release -p blip-mux -p blip-shim; Check 'cargo build'

  Step 'blip-core.exe (the TypeScript core, compiled with Bun)'
  Push-Location $repo
  bun windows/core/build.ts (Join-Path $win 'target\release\blip-core.exe'); Check 'blip-core build'
  Pop-Location

  Step 'Blip app + NSIS installer'
  Push-Location (Join-Path $win 'app')
  bun install --frozen-lockfile; Check 'bun install'
  bunx tauri build; Check 'tauri build'
  Pop-Location

  $setup = Get-ChildItem (Join-Path $win 'target\release\bundle\nsis\*.exe') | Sort-Object LastWriteTime | Select-Object -Last 1
  Write-Host "`nInstaller: $($setup.FullName)  ($([math]::Round($setup.Length / 1MB, 1)) MB)" -ForegroundColor Green
} finally {
  Pop-Location
}
