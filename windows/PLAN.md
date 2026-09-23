# Blip for Windows — plan

A Windows client for Blip. Same Mac gateway, same `bridge/mac/`, same TypeScript
core. Only the transport and the UI are new. Omarchy does not need to be running;
Windows talks to the Mac directly, with its own key.

## Decisions

| Question | Choice | Why |
|---|---|---|
| Repo | Fork of nixfred/blip (`chrisandtre/blip-windows`), Windows code under `windows/` | Upstream fixes keep flowing; a PR back to Fred stays possible |
| UI | Tauri 2 (Rust shell + web UI) | Reuses the ~6k lines of TS core; tray, toasts. Installer is 31.7 MB, mostly the Bun runtime inside blip-core.exe |
| Core runtime | Bun, compiled to one `blip-core.exe` (`windows/core`) | Core uses only 4 Bun APIs; users don't install Bun |
| Transport | blip-mux: one russh connection behind a named pipe; blip-shim forwards to it | Windows OpenSSH has no ControlMaster; a fresh ssh per call is slow |
| Mac side | Unchanged. New key goes through `blip-dispatch` like the Linux one | No second setup on the Mac |
| Audience | Public | Installer, docs, and a setup wizard from the start |

## Status (2026-09-23)

Working, verified against the real gateway Mac, installed from the built setup.exe:

- Setup from scratch (`blip-setup.ps1`, or the app's first-run screen): one password prompt.
- `blip-mux` + `blip-shim`: ping 95 ms, `imsg recent` 230 ms warm (Mac-side
  Python startup dominates, same as Linux), cold start 0.54 s, offline fails
  fast with exit 69.
- Core: `bun test` 609 pass / 15 skip (Linux-only) / 0 fail on Windows; CI
  runs it on ubuntu-latest too, and Linux passes.
- App: conversation list, pinned tiles, contact photos, threads with every
  bubble field, inline images, link cards, search, new chat, read marks, text
  and file sends (a real send confirmed by Chris; failure and give-up paths
  verified in mock mode), Add to Contacts, tray popout + full window, tray
  unread/offline icons, notifications (allowlist-gated) that open their
  conversation, security codes (5 min, memory only), keyboard navigation,
  remembered window size, optional start at login.
- Security: independent review, fixes applied (opener scope, fail-closed
  paths, Mark of the Web on attachments, narrower page surface, CSP).
- Installer: per-user NSIS; CI builds it; a `win-v*` tag drafts a release.

Needs a person to confirm on the installed build: the tray popout's
placement, opening a link and an attachment, a group send.

Not done (and why):
- Code signing: needs a certificate or Azure Trusted Signing account in the
  publisher's name. Until then SmartScreen warns on download.
- Contact review (duplicate scan, card details, vCard export) and the share
  sheet: the QML has them; the web UI has Add to Contacts and link
  open/copy. Candidates for a later release.
- A long-running core process instead of one `blip-core.exe` per call:
  lower per-poll cost, smaller bundle. An optimisation, not a gap.
- Upstream: `.gitattributes` and `platform.ts` + `bin-dir.ts` (identical on
  Linux, enable Windows) are ready to offer Fred. linkpreview.ts has a DNS
  rebinding gap (checks the IP, then fetch() resolves again) that affects
  Linux too; to report upstream rather than fork.

## Where Windows plugs in

The core never calls ssh directly. It calls shims (`bridge/linux/blip-shim` →
`~/bin/imsg`, `imsg-send`, …) resolved through `shimPath()` / `bridgeFor()` in
`source-id.ts`. On Windows:

- The core is unchanged: it spawns `~/bin/imsg` etc. With `HOME=%LOCALAPPDATA%\Blip`
  that is `blip-shim.exe` installed under each tool name, which hands argv +
  stdin to `blip-mux` over a named pipe. The mux keeps one SSH connection and
  runs each call as an exec channel through the forced command. Exit 69 still
  means "Mac offline".
- Linux-only helpers get Windows equivalents:

| Linux | Windows |
|---|---|
| `notify-send` | Tauri notification plugin (Windows toasts) |
| `wl-copy` / `wl-paste` | Tauri clipboard plugin |
| `xdg-open` | Tauri opener plugin |
| `~/.config/blip`, `~/.cache/blip`, `~/bin` | the same paths under `%LOCALAPPDATA%\Blip` (the core runs with HOME set there) |
| `$XDG_RUNTIME_DIR/blip` | `%LOCALAPPDATA%\Blip\run` |
| hunspell | WebView2 built-in spellcheck |
| Omarchy bar widget | System tray icon with unread badge |
| Hyprland keybind | Global shortcut `Ctrl+Alt+M` (Win+ combinations are reserved by the shell) |

Every change to shared files stays small and behind a platform check, so
upstream merges stay clean.

## Phases

1. **Baseline.** Install Bun, Rust, VS C++ Build Tools. Run the existing test
   suite on Windows and list what fails and why (paths, spawn, Linux tools).
2. **Transport.** `blip-mux` (russh) + `blip-shim` (done).
   Proof: `imsg chats` and one read of a thread from Windows.
3. **Setup wizard.** Generate `%USERPROFILE%\.ssh\blip_win_ed25519`, print or
   push the `authorized_keys` line with the `blip-dispatch` forced command,
   test the connection, write `bridge.conf`.
4. **Tray + panel.** Unread badge, conversation list, open thread, send text.
5. **App window.** Sidebar, threads, inline photos, file send (drag-drop,
   Ctrl+V), search, j/k keyboard nav.
6. **Notifications + polish.** Toasts with the allowlist, mute list, spellcheck,
   remembered window size, offline state in the tray icon.
7. **Release.** Signed installer (MSI/NSIS via Tauri), GitHub Releases, README
   section, then ask Fred whether he wants the Windows client upstream.

## Setup (phase 3, pulled forward)

`windows\scripts\blip-setup.cmd [user@]mac-host` wraps `blip-setup.ps1`
(PowerShell 5.1-compatible, ASCII only). Unlike the Linux wizard it does not
assume key auth already works: it packs `bridge/mac`, `mac-enroll.sh`, the new
public key and this PC's Tailscale IPs into one tar and sends it over ONE ssh
session, so a password-only Mac asks once. After that everything (confinement
check, `blip-check`, smoke test) goes through the confined key. Config lands in
`%LOCALAPPDATA%\Blip\.config\blip\bridge.conf`; the key is `%USERPROFILE%\.ssh\blip_win_ed25519`.
The GUI wizard in the app will drive the same steps.

## Phase 1 baseline (2026-09-22)

Bun 1.4.2, Rust 1.98.1 (MSVC), VS Build Tools 2022. Upstream at 48ba7b4.

`bun test` on Windows: 592 pass, 1 skip, 30 fail of 623. The first run was 588;
4 failures were CRLF from `core.autocrlf=true`, fixed by `.gitattributes`
(`* text=auto eol=lf`), which is worth sending upstream on its own.

The 30 remaining, by cause:

| Bucket | Count | Tests | Plan |
|---|---|---|---|
| Linux-only by design | 11 | window-launch (8, Hyprland focus script via `sh`), blip-setup `from=` pin (3, bash) | Skip on win32; Windows gets its own launcher and wizard |
| Paths | 9 | `shimPath`/`bridgeFor`, contact-save spawn, state round-trip, clipboard file paste (3, `file:///C:/…` URIs) | Tests hard-code `/`; core needs `path.join` and URI→path handling |
| POSIX filesystem | 10 | contact-review cache (4, `process.getuid`), contact-vcard (5, `/proc/self/fd`, `$XDG_RUNTIME_DIR`), panel-size-store (1, symlink/mode checks) | Small `platform.ts`: uid→SID or skip, runtime dir, open-then-verify without `/proc` |

## Open questions

- Code signing: unsigned installers trigger SmartScreen. Options are an OV/EV
  cert or Azure Trusted Signing (cheapest for a public project).
- OTP autofill: the Linux version uses accessibility APIs; Windows would need
  UI Automation. Probably out of scope for 1.0.
- Tailscale key pinning (`from=` on the key) works the same; wizard should offer it.
