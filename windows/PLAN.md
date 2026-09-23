# Blip for Windows — plan

A Windows client for Blip. Same Mac gateway, same `bridge/mac/`, same TypeScript
core. Only the transport and the UI are new. Omarchy does not need to be running;
Windows talks to the Mac directly, with its own key.

## Decisions

| Question | Choice | Why |
|---|---|---|
| Repo | Fork of nixfred/blip (`chrisandtre/blip-windows`), Windows code under `windows/` | Upstream fixes keep flowing; a PR back to Fred stays possible |
| UI | Tauri 2 (Rust shell + web UI) | Reuses the ~6k lines of TS core; tray, toasts. Installer is 31.7 MB, mostly the Bun runtime inside blip-core.exe |
| Core runtime | Bun, compiled to one `.exe` sidecar (`bun build --compile`) | Core uses only 4 Bun APIs; users don't install Bun |
| Transport | blip-mux: one russh connection behind a named pipe; blip-shim forwards to it | Windows OpenSSH has no ControlMaster; a fresh ssh per call is slow |
| Mac side | Unchanged. New key goes through `blip-dispatch` like the Linux one | No second setup on the Mac |
| Audience | Public | Installer, docs, and a setup wizard from the start |

## Status (2026-09-22)

Working, verified against the real gateway Mac, installed from the built setup.exe:

- Setup from scratch (`blip-setup.ps1`, or the app's first-run screen): one password prompt.
- `blip-mux` + `blip-shim`: ping 95 ms, `imsg recent` 230 ms warm (Mac-side
  Python startup dominates, same as Linux), cold start 0.54 s, offline fails
  fast with exit 69.
- Core on Windows: `bun test` 609 pass / 15 skip (Linux-only) / 0 fail.
- App: conversation list, pinned tiles, contact photos, threads with every
  bubble field, inline images, link cards, search, new chat, read marks,
  tray with unread/offline icons, notifications (allowlist-gated by the
  collector), security codes (5 min, memory only), keyboard navigation.
- Installer: per-user NSIS; bundles blip-core/mux/shim and the Mac bridge.

Not yet verified, because it sends real messages and needs a person at the
keyboard: text send, file send, pasted screenshot, group send, failed send.

Next:
1. Verify sends. Push `windows-client` so CI runs `bun test` on Linux too.
2. Tray popout (the Omarchy panel equivalent). Today the tray toggles the window.
3. Notification click opens the conversation; start at login; remember window size.
4. Contact review / save and the share sheet (in the QML, not yet in the web UI).
5. Code signing (Azure Trusted Signing) so SmartScreen does not warn.
6. A long-running core process instead of one `blip-core.exe` per call:
   lower per-poll cost, and a chance to shrink the bundle.
7. Upstream PRs to nixfred/blip: `.gitattributes`; `platform.ts` + `bin-dir.ts`
   (identical on Linux, enable Windows).

## Where Windows plugs in

The core never calls ssh directly. It calls shims (`bridge/linux/blip-shim` →
`~/bin/imsg`, `imsg-send`, …) resolved through `shimPath()` / `bridgeFor()` in
`source-id.ts`. On Windows:

- `bridgeFor()` returns a Windows transport instead of a bash shim path.
- The transport keeps one SSH session open and runs each tool as a channel
  on it (exec `imsg …` through the forced command), streaming stdin/stdout
  the same way the shim does. Exit 69 still means "Mac offline".
- Linux-only helpers get Windows equivalents:

| Linux | Windows |
|---|---|
| `notify-send` | Tauri notification plugin (Windows toasts) |
| `wl-copy` / `wl-paste` | Tauri clipboard plugin |
| `xdg-open` | Tauri opener plugin |
| `~/.config/blip`, `~/.cache/blip` | `%APPDATA%\Blip`, `%LOCALAPPDATA%\Blip\cache` |
| `$XDG_RUNTIME_DIR/blip` | `%TEMP%\Blip` |
| hunspell | WebView2 built-in spellcheck |
| Omarchy bar widget | System tray icon with unread badge |
| Hyprland keybind | Global shortcut (default `Win+Ctrl+M`, configurable) |

Every change to shared files stays small and behind a platform check, so
upstream merges stay clean.

## Phases

1. **Baseline.** Install Bun, Rust, VS C++ Build Tools. Run the existing test
   suite on Windows and list what fails and why (paths, spawn, Linux tools).
2. **Transport.** Windows `bridgeFor()` path + persistent `ssh2` session.
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
`%APPDATA%\Blip\bridge.conf`; the key is `%USERPROFILE%\.ssh\blip_win_ed25519`.
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
