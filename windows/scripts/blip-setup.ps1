<#
blip-setup.ps1 - Windows-side first run for Blip. Idempotent; safe to re-run.

  blip-setup.cmd [user@]mac-host      # e.g. blip-setup.cmd you@your-mac, or a Tailscale name
  blip-setup.cmd -UpdateMac           # re-install the bridge tools on an already-enrolled Mac

Steps:
  0. prerequisites          Windows OpenSSH client and tar (both ship with Windows 10 1803+)
  1. %LOCALAPPDATA%\Blip\.config\blip\bridge.conf   host=, remote_bin=, python=, key=
                            (other keys survive a re-run)
  2. %USERPROFILE%\.ssh\blip_win_ed25519   this PC's own key; your everyday keys are untouched
  3. Mac install + enroll   ONE ssh session: copies bridge/mac to ~/.blip/src, runs install.sh,
                            adds the key confined to blip-dispatch (see mac-enroll.sh).
                            Skipped when the key already works, unless -UpdateMac.
  4. permission check       blip-check through the new key, after you are at the Mac's screen
  5. smoke test             imsg recent 1 through the new key (a count, never message text)

Written for Windows PowerShell 5.1, which every Windows install has; runs on 7.x too.
ASCII only on purpose: 5.1 reads a BOM-less script as the ANSI code page.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$MacHost,
  [switch]$UpdateMac
)

$ErrorActionPreference = 'Stop'
# 7.3+ passes native arguments differently from 5.1 (empty strings, embedded quotes).
# Legacy makes both behave the same; ssh-keygen's empty passphrase depends on it.
$PSNativeCommandArgumentPassing = 'Legacy'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Ok($m)   { Write-Host "[ok] $m" -ForegroundColor Green }
function Info($m) { Write-Host " -   $m" }
function Fail($m, [int]$code = 1) { Write-Host "[x]  $m" -ForegroundColor Red; exit $code }

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$macSrc = Join-Path $repo 'bridge\mac'
$enroll = Join-Path $PSScriptRoot 'mac-enroll.sh'

# ---------------------------------------------------------------- 0. prerequisites
$sshDir = Join-Path $env:SystemRoot 'System32\OpenSSH'
$ssh = Join-Path $sshDir 'ssh.exe'
$keygen = Join-Path $sshDir 'ssh-keygen.exe'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
# The System32 client, not whatever ssh is first on PATH (Git for Windows ships its own).
if (-not (Test-Path $ssh) -or -not (Test-Path $keygen)) {
  Fail ("The Windows OpenSSH client is missing. In an admin PowerShell run:`n" +
        "       Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`n     then re-run blip-setup.")
}
if (-not (Test-Path $tar)) { Fail 'tar.exe is missing from System32 (Windows 10 1803 or later is required).' }
if (-not (Test-Path (Join-Path $macSrc 'install.sh')) -or -not (Test-Path $enroll)) {
  Fail "Cannot find bridge\mac\install.sh and windows\scripts\mac-enroll.sh under $repo. Run this from a Blip checkout."
}
Ok 'Windows OpenSSH client and tar present'

# Native calls with stderr dropped. 5.1 turns redirected native stderr into a
# terminating error under 'Stop', so relax it for the call and report the exit code.
function Invoke-Quiet([string]$exe, [string[]]$argv) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & $exe @argv 2>$null; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $old }
  [pscustomobject]@{ Out = @($out); Code = $code }
}

# ---------------------------------------------------------------- 1. config
# bridge.conf is DATA: parsed as key=value lines, never executed. Keys this
# script does not own (country_code, automation, anything set by hand) survive.
# Blip's Windows home is %LOCALAPPDATA%\Blip; the app runs the core with HOME set there,
# so this is the core's own ~/.config/blip/bridge.conf.
$confDir = Join-Path $env:LOCALAPPDATA 'Blip\.config\blip'
$conf = Join-Path $confDir 'bridge.conf'
$lines = New-Object System.Collections.Generic.List[string]
if (Test-Path $conf) { foreach ($l in [IO.File]::ReadAllLines($conf)) { $lines.Add($l) } }
function Get-ConfValue([string]$k) {
  foreach ($l in $lines) { if ($l -match "^\s*$([regex]::Escape($k))=(.*)$") { return $Matches[1].Trim() } }
  return $null
}

if (-not $MacHost) { $MacHost = Get-ConfValue 'host' }
if (-not $MacHost) { $MacHost = Read-Host 'Mac ssh target ([user@]host, Tailscale name works best)' }
$MacHost = $MacHost.Trim()
# Neither part may start with "-" (it would reach ssh as an option), and no
# spaces or shell characters: the value is passed to ssh on a command line.
if ($MacHost -notmatch '^([A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9._][A-Za-z0-9._:-]*$') {
  Fail "'$MacHost' does not look like [user@]host."
}

$key = Join-Path $env:USERPROFILE '.ssh\blip_win_ed25519'
$managed = [ordered]@{ host = $MacHost; remote_bin = "'`$HOME/.blip/bin'"; python = 'python3'; key = $key }
$defaults = [ordered]@{ country_code = '1' }

if ($lines.Count -eq 0) {
  $lines.Add('# Blip bridge (Windows) - read as data, never executed, by the Blip client')
  $lines.Add("# remote_bin is single-quoted on purpose: expanded on the MAC, not here")
}
foreach ($k in $managed.Keys) {
  $i = -1
  for ($n = 0; $n -lt $lines.Count; $n++) { if ($lines[$n] -match "^\s*$k=") { $i = $n; break } }
  if ($i -ge 0) { $lines[$i] = "$k=$($managed[$k])" } else { $lines.Add("$k=$($managed[$k])") }
}
foreach ($k in $defaults.Keys) { if ($null -eq (Get-ConfValue $k)) { $lines.Add("$k=$($defaults[$k])") } }
New-Item -ItemType Directory -Force -Path $confDir | Out-Null
[IO.File]::WriteAllText($conf, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
Ok "config written: $conf (host=$MacHost)"

# ---------------------------------------------------------------- 2. key
if (-not (Test-Path $key)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $key) | Out-Null
  & $keygen -q -t ed25519 -N '""' -C "blip@$env:COMPUTERNAME" -f $key
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$key.pub")) { Fail "ssh-keygen could not create $key" }
  Ok "new key: $key"
} else {
  Ok "existing key: $key"
}

$keyArgs = @('-n', '-i', $key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', $MacHost)
function Test-Confined {
  $pong = Invoke-Quiet $ssh ($keyArgs + 'ping')
  if ($pong.Code -ne 0 -or ($pong.Out -join '') -ne 'pong') { return $false }
  # The key must NOT get a shell: blip-dispatch refuses anything but the Blip tools.
  $shell = Invoke-Quiet $ssh ($keyArgs + 'true')
  return ($shell.Code -ne 0)
}

# ---------------------------------------------------------------- 3. Mac install + enroll
$enrolled = Test-Confined
if ($enrolled -and -not $UpdateMac) {
  Ok "key already enrolled on $MacHost (use -UpdateMac to re-install the bridge tools)"
} else {
  # This PC's Tailscale addresses, so the Mac can pin the key to both families.
  $tsips = @()
  $ts = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($ts) {
    $r = Invoke-Quiet $ts.Source @('ip')
    if ($r.Code -eq 0) { $tsips = @($r.Out | Where-Object { $_ -match '^[0-9A-Fa-f.:]+$' }) }
  }

  $stage = Join-Path ([IO.Path]::GetTempPath()) ("blip-setup-" + [Guid]::NewGuid().ToString('N'))
  $payload = "$stage.tar"
  try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    # Regular files only (bridge/mac can hold a __pycache__ directory).
    Get-ChildItem -LiteralPath $macSrc -File | Copy-Item -Destination $stage
    Copy-Item -LiteralPath $enroll -Destination $stage
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $stage 'blip-win.pub'), ([IO.File]::ReadAllText("$key.pub").Trim() + "`n"), $utf8)
    [IO.File]::WriteAllText((Join-Path $stage 'blip-win.tsips'), (($tsips -join "`n") + "`n"), $utf8)
    & $tar -cf $payload -C $stage .
    if ($LASTEXITCODE -ne 0) { Fail 'tar could not build the Mac payload' }

    Write-Host ''
    Info "Connecting to $MacHost to install the bridge and enroll this PC's key."
    Info 'If this is the first connection, check the host fingerprint and type yes.'
    Info 'If the Mac asks for a password, it is your Mac login password (asked once).'
    Write-Host ''
    # Start-Process feeds the tar to ssh's stdin as raw bytes; a PowerShell
    # pipeline would re-encode it. Prompts still come from the console.
    $remote = 'mkdir -p ~/.blip/src && tar -xf - -C ~/.blip/src && bash ~/.blip/src/mac-enroll.sh'
    $p = Start-Process -FilePath $ssh -NoNewWindow -Wait -PassThru -RedirectStandardInput $payload `
           -ArgumentList "-o ConnectTimeout=10 -- $MacHost `"$remote`""
    if ($p.ExitCode -ne 0) {
      Fail ("Mac install/enroll failed (ssh exit $($p.ExitCode)). Common causes: Remote Login is off " +
            "(System Settings > General > Sharing), or python3 needs 'xcode-select --install' on the Mac.")
    }
  } finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $payload -Force -ErrorAction SilentlyContinue
  }

  if (-not (Test-Confined)) { Fail "the key did not confine as expected - check ~/.ssh/authorized_keys on $MacHost" }
  Ok "key works and can run only the Blip tools on $MacHost"
}

# ---------------------------------------------------------------- 4. permission check
# blip-check talks to Messages, which pops a one-time Allow prompt on the Mac's
# own screen when the Automation grant is missing. The prompt expires in about
# two minutes and an expired prompt is recorded as a denial, so warn first.
Write-Host ''
Info 'Next: the Mac may ask, ON ITS OWN SCREEN, whether sshd may control Messages.'
Info 'Be at the Mac (or in Screen Sharing) and click Allow within two minutes.'
Info 'An unanswered prompt is recorded as a denial.'
[void](Read-Host '     Press Enter to run the permission check')
$granted = $false
foreach ($attempt in 1..3) {
  Write-Host ''; Info "Checking Mac permissions (attempt $attempt)..."
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $ssh @($keyArgs + 'blip-check')
  $code = $LASTEXITCODE; $ErrorActionPreference = $old
  if ($code -eq 0) { $granted = $true; break }
  if ($attempt -lt 3) { [void](Read-Host '     Grant what is missing on the Mac, then press Enter to re-check (Ctrl+C to stop)') }
}
if (-not $granted) {
  Fail ('The Mac is still missing a permission after 3 checks. Blip can read but cannot send ' +
        'until it is granted. Fix it on the Mac, then re-run blip-setup.')
}

# ---------------------------------------------------------------- 5. smoke test
# Content-free on purpose: message text echoed into a terminal is an
# escape-sequence injection vector and a shoulder-surf.
Write-Host ''
$r = Invoke-Quiet $ssh ($keyArgs + @('imsg', '--json', 'recent', '1'))
if ($r.Code -ne 0) { Fail "the bridge did not answer (exit $($r.Code)). Usually a missing Full Disk Access grant on the Mac." 69 }
$n = '?'
# Assign first: 5.1's ConvertFrom-Json emits a JSON array as ONE object.
try { $j = ($r.Out -join "`n") | ConvertFrom-Json; $n = @($j).Count } catch { }
Ok "bridge is up - $n message(s) readable through the Blip key"
Write-Host ''
Info 'Setup done. The Windows app reads its settings from:'
Info "  $conf"
