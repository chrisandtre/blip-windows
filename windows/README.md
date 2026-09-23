# Blip for Windows

iMessage on Windows, through a Mac you own. This is a Windows client for
[Blip](https://github.com/nixfred/blip): the same Mac bridge and the same
TypeScript core, with a Windows app on top. It does not reimplement iMessage.
Your Mac does the messaging; Windows talks to it over SSH.

## What you need

- **A Mac** (macOS 13+) signed into your Apple ID, awake, and reachable from
  the PC (same network, or Tailscale). The same Mac can serve Linux Blip and
  Windows Blip at once.
- **Remote Login** on the Mac: System Settings > General > Sharing.
- **Windows 10 (1803+) or 11.** The OpenSSH client and `tar` ship with it.

## Install

1. Download `Blip for Windows_<version>_x64-setup.exe` from the
   [releases](https://github.com/chrisandtre/blip-windows/releases) and run it.
   It installs for your user only and needs no admin rights. Windows may warn
   that the publisher is unknown until the installer is code-signed.
2. Open **Blip for Windows**. The first run asks for your Mac's address
   (`you@your-mac`, or its Tailscale name) and opens a console window that:
   - asks you to confirm the Mac's fingerprint and type its password **once**;
   - installs Blip's bridge tools on the Mac and gives this PC its own SSH key,
     locked to Blip's tools and nothing else (your other keys are untouched);
   - asks you to be at the Mac to click **Allow** when macOS asks whether sshd
     may control Messages.
3. Grant **Full Disk Access** to `/usr/libexec/sshd-keygen-wrapper` on the Mac
   if the setup says it is missing (press Cmd+Shift+G in the file picker).

If you already use Blip on Linux, the Mac is already set up; the Windows setup
only adds this PC's key.

## Using it

- **Tray icon**: click for the popout, double-click for the full window.
  Blue means unread; dimmed means the Mac is unreachable. Right-click for
  Mark all as read, Start Blip at login, and Quit.
- **Ctrl+Alt+M** brings the window up from anywhere.
- **Keys**: Up/Down move through conversations, Enter opens one, `/` searches,
  `n` starts a new message, Ctrl+1..9 opens a pinned conversation, Esc goes back.
- **Send**: Enter sends, Shift+Enter is a new line. Paste a screenshot, drag
  files in, or use the paperclip.
- **Notifications** only come from people on your allowlist, as in Linux Blip:
  `%LOCALAPPDATA%\Blip\.config\blip\allowlist.json` (a JSON list of handles).
  Copy yours over from `~/.config/blip/` on Linux. `mutelist.json` works too.
- Closing the window keeps Blip running in the tray.

## Where things live

| What | Where |
|---|---|
| App | `%LOCALAPPDATA%\Blip for Windows` |
| Settings (`bridge.conf`, allowlist, mute list) | `%LOCALAPPDATA%\Blip\.config\blip\` |
| Read marks and state (no message text) | `%LOCALAPPDATA%\Blip\.local\state\blip\` |
| Cached photos and attachments | `%LOCALAPPDATA%\Blip\.cache\blip\` |
| This PC's key | `%USERPROFILE%\.ssh\blip_win_ed25519` |

Uninstalling removes the app and leaves your settings, so a reinstall picks up
where you were. To remove everything, also delete `%LOCALAPPDATA%\Blip` and
the key, and remove the key's line from `~/.ssh/authorized_keys` on the Mac.

## Troubleshooting

- **"Mac unreachable"**: is the Mac awake and on the network? From PowerShell,
  `ssh -i $env:USERPROFILE\.ssh\blip_win_ed25519 you@your-mac ping` should print `pong`.
- **Messages read but will not send**: the Automation grant is missing. Re-run
  setup from the app, or run `windows\scripts\blip-setup.cmd` from a checkout.
- **Connection log**: `%LOCALAPPDATA%\Blip\mux.log` (connection events only,
  never message text).

## How it works

Windows OpenSSH has no connection sharing, so a fresh `ssh` per request cost
330-430 ms. `blip-mux` keeps one SSH connection to the Mac and serves a named
pipe only your account can open; `blip-shim`, installed under each tool name
(`imsg.exe`, `imsg-send.exe`, ...), forwards each request to it, exactly where
Linux Blip runs its shell shims. The TypeScript core runs unchanged, compiled
into `blip-core.exe`, with its home set to `%LOCALAPPDATA%\Blip`. Details and
the build are in [PLAN.md](PLAN.md).

## Building

Needs Rust (MSVC), Bun, and the Visual Studio C++ build tools.

```powershell
windows\scripts\build-release.ps1
```

`bun windows/app/dev/serve.ts` runs the UI in a browser against your real Mac
with sending faked, for UI work without sending anything.

## License

MIT, like Blip.
