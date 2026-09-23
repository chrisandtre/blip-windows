#!/usr/bin/env bash
# mac-enroll.sh — runs ON THE MAC, inside the one ssh session blip-setup.ps1 opens.
#
# blip-setup.ps1 sends a tar on stdin holding bridge/mac, this script, the
# Windows key's .pub (blip-win.pub) and that PC's Tailscale addresses
# (blip-win.tsips, may be empty), unpacked into ~/.blip/src. One session means
# a Mac that still wants a password asks for it once, not once per step.
#
#   1. install.sh --no-check    bridge tools into ~/.blip/bin (blip-setup.ps1
#                               runs blip-check later, once you are at the Mac)
#   2. authorized_keys          the Windows key, confined to blip-dispatch, and
#                               pinned with from= when it came in over Tailscale.
#                               A re-run REPLACES the key's line.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$src/install.sh" --no-check

pub="$(tr -d '\r\n' < "$src/blip-win.pub")"
re='^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]+)?$'
if ! [[ "$pub" =~ $re ]]; then
  echo "✗ blip-win.pub is not a plain ed25519 public key — refusing to enroll it" >&2
  exit 1
fi
body="${pub#ssh-ed25519 }"; body="${body%% *}"

# Same rule as blip_key_from in scripts/blip-setup: pin only a Tailscale
# address (a stable per-node identity), to both of the PC's addresses when it
# sent them. A LAN address stays unpinned — an unpinned key beats a stranded one.
seen="${SSH_CONNECTION%% *}"
from=""
case "$seen" in
  100.*) second="${seen#100.}"; second="${second%%.*}"
         [[ "$second" =~ ^[0-9]+$ ]] && (( second >= 64 && second <= 127 )) && from="$seen" ;;
  fd7a:115c:a1e0:*) from="$seen" ;;
esac
if [[ -n "$from" && -s "$src/blip-win.tsips" ]]; then
  ips="$(tr -d '\r' < "$src/blip-win.tsips" | paste -sd, -)"
  case ",$ips," in *",$seen,"*) from="$ips" ;; esac
fi
[[ -z "$from" || "$from" =~ ^[0-9A-Fa-f.:,]+$ ]] || from=""
opt=""
[[ -n "$from" ]] && opt="from=\"$from\","

umask 077
mkdir -p ~/.ssh
touch ~/.ssh/authorized_keys
grep -vF -- "$body" ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.blip.tmp || true
printf '%s\n' "${opt}restrict,command=\"\$HOME/.blip/bin/blip-dispatch\" $pub" >> ~/.ssh/authorized_keys.blip.tmp
mv ~/.ssh/authorized_keys.blip.tmp ~/.ssh/authorized_keys

if [[ -n "$from" ]]; then
  echo "✓ Windows key enrolled, confined to the Blip tools, pinned to $from"
else
  echo "✓ Windows key enrolled, confined to the Blip tools (not pinned: came in from $seen, not Tailscale)"
fi
