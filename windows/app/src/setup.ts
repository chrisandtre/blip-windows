// First run: no bridge.conf yet means no Mac to talk to.
//
// The usual way is pairing: the Mac runs `blip setup` (Homebrew), shows six
// digits, and advertises itself; this screen finds it and takes the code
// (pair.rs does the rest). The older way is still here behind a link:
// blip-setup.ps1 in a console window, with the Mac's password.
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface SetupState { configured: boolean; host: string; shims: boolean; tapbacks: boolean }
interface FoundMac { name: string; addrs: string[]; port: number; user: string }
interface Paired { host: string; computer: string; bridge: string }

const BREW = "brew install chrisandtre/blip/blip && blip setup";

export function setupState(): Promise<SetupState> {
  return invoke<SetupState>("setup_state");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function setupScreen(): Promise<void> {
  return new Promise((done) => {
    const box = document.createElement("div");
    box.className = "setup";
    document.body.append(box);
    pairView(box, done);
  });
}

function pairView(box: HTMLElement, done: () => void) {
  box.innerHTML = `
    <div class="setup-card">
      <h1>Set up Blip</h1>
      <p>Blip reads and sends iMessage through a Mac you own. Start on the Mac, then finish here.</p>

      <div class="setup-step">
        <div class="setup-num">1</div>
        <div>
          <b>On your Mac</b>, open Terminal and run:
          <div class="setup-cmd"><code>${esc(BREW)}</code><button class="setup-copy" type="button">Copy</button></div>
          <p class="setup-hint">It walks you through the Mac's settings, then shows a six-digit code.
          No Homebrew yet? <a href="#" data-url="https://brew.sh">brew.sh</a> has the one-line install.</p>
        </div>
      </div>

      <div class="setup-step">
        <div class="setup-num">2</div>
        <div class="setup-grow">
          <b>Pick your Mac</b>
          <div class="setup-macs" role="radiogroup" aria-label="Macs on this network"></div>
          <details class="setup-manual">
            <summary>Don't see it?</summary>
            <p class="setup-hint">Make sure the Mac shows a code and is on the same network or Tailscale. Or type its name or address:</p>
            <input id="setup-addr" placeholder="chriss-imac or 192.168.1.20" spellcheck="false" autocomplete="off">
          </details>
        </div>
      </div>

      <div class="setup-step">
        <div class="setup-num">3</div>
        <div class="setup-grow">
          <b>Enter the code</b>
          <input id="setup-code" class="setup-code" inputmode="numeric" maxlength="7" placeholder="000 000" autocomplete="off" aria-label="Six-digit code from the Mac">
          <button id="setup-go" type="button" disabled>Pair</button>
          <p id="setup-msg" class="setup-msg" role="status"></p>
        </div>
      </div>

      <p class="setup-alt"><a href="#" id="setup-password">Set up with the Mac's password instead</a></p>
    </div>`;

  const macsEl = box.querySelector<HTMLDivElement>(".setup-macs")!;
  const addrEl = box.querySelector<HTMLInputElement>("#setup-addr")!;
  const codeEl = box.querySelector<HTMLInputElement>("#setup-code")!;
  const go = box.querySelector<HTMLButtonElement>("#setup-go")!;
  const msg = box.querySelector<HTMLParagraphElement>("#setup-msg")!;
  const copy = box.querySelector<HTMLButtonElement>(".setup-copy")!;
  let macs: FoundMac[] = [];
  let chosen = "";
  let busy = false;
  let alive = true;

  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(BREW);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    } catch { /* the text is selectable */ }
  };
  box.querySelectorAll<HTMLAnchorElement>("a[data-url]").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); void openUrl(a.dataset.url!); };
  });
  box.querySelector<HTMLAnchorElement>("#setup-password")!.onclick = (e) => {
    e.preventDefault();
    alive = false;
    passwordView(box, done, () => { alive = true; pairView(box, done); });
  };

  const digits = () => codeEl.value.replace(/\D/g, "");
  const target = (): FoundMac | null => {
    const typed = addrEl.value.trim();
    if (typed) return { name: typed, addrs: [typed], port: 7447, user: "" };
    return macs.find((m) => m.name === chosen) ?? null;
  };
  const refreshButton = () => { go.disabled = busy || digits().length !== 6 || !target(); };

  const renderMacs = () => {
    if (!macs.length) {
      macsEl.innerHTML = `<div class="setup-searching"><span class="setup-spin" aria-hidden="true"></span>Looking for a Mac showing a code…</div>`;
      return;
    }
    if (!macs.some((m) => m.name === chosen)) chosen = macs[0].name;
    macsEl.innerHTML = macs
      .map((m) => `<label class="setup-mac${m.name === chosen ? " on" : ""}"><input type="radio" name="mac" value="${esc(m.name)}"${m.name === chosen ? " checked" : ""}>
        <span class="setup-mac-name">${esc(m.name)}</span><span class="setup-hint">${esc(m.addrs[0] ?? "")}</span></label>`)
      .join("");
    macsEl.querySelectorAll<HTMLInputElement>("input").forEach((r) => {
      r.onchange = () => { chosen = r.value; renderMacs(); refreshButton(); };
    });
  };

  const scan = async () => {
    while (alive && document.body.contains(box)) {
      try {
        const found = await invoke<FoundMac[]>("discover_macs");
        if (!alive) return;
        const key = (l: FoundMac[]) => l.map((m) => m.name + m.addrs.join()).join("|");
        if (key(found) !== key(macs)) { macs = found; renderMacs(); refreshButton(); }
      } catch { /* keep looking */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
  };

  codeEl.oninput = () => {
    const d = digits().slice(0, 6);
    codeEl.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
    msg.textContent = "";
    msg.classList.remove("bad");
    refreshButton();
  };
  addrEl.oninput = refreshButton;

  const run = async () => {
    const mac = target();
    if (!mac || digits().length !== 6 || busy) return;
    busy = true;
    refreshButton();
    msg.classList.remove("bad");
    let lastErr = "";
    for (const addr of mac.addrs) {
      msg.textContent = `Pairing with ${mac.name}…`;
      try {
        const p = await invoke<Paired>("pair_mac", { addr, port: mac.port, code: digits() });
        alive = false;
        msg.textContent = `Paired with ${p.computer}. Connecting…`;
        setTimeout(() => { box.remove(); done(); }, 900);
        return;
      } catch (e) {
        lastErr = String(e);
        // A wrong code is the same answer at every address; do not retry it.
        if (!lastErr.startsWith("Couldn't reach")) break;
      }
    }
    msg.textContent = lastErr;
    msg.classList.add("bad");
    busy = false;
    refreshButton();
    if (lastErr.includes("didn't match")) { codeEl.select(); codeEl.focus(); }
  };
  go.onclick = run;
  codeEl.onkeydown = (e) => { if (e.key === "Enter") void run(); };

  renderMacs();
  codeEl.focus();
  void scan();
}

function passwordView(box: HTMLElement, done: () => void, back: () => void) {
  box.innerHTML = `
    <div class="setup-card">
      <h1>Set up with a password</h1>
      <p>The Mac must be signed into your Apple ID, stay awake, and have <b>Remote Login</b> on (System Settings &rarr; General &rarr; Sharing).</p>
      <label>Mac address <input id="setup-host" placeholder="you@your-mac" spellcheck="false"></label>
      <p class="setup-hint">Your Mac login name and its name on the network, or its Tailscale name.
      A console window opens next. Before typing <b>yes</b> to the Mac's fingerprint, compare it with
      <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> run on the Mac. Then type the
      Mac's password once, and be at the Mac to click <b>Allow</b> when it asks.</p>
      <button id="setup-go">Set up</button>
      <p id="setup-msg" class="setup-msg"></p>
      <p class="setup-alt"><a href="#" id="setup-back">Pair with a code instead</a></p>
    </div>`;
  const input = box.querySelector<HTMLInputElement>("#setup-host")!;
  const go = box.querySelector<HTMLButtonElement>("#setup-go")!;
  const msg = box.querySelector<HTMLParagraphElement>("#setup-msg")!;
  box.querySelector<HTMLAnchorElement>("#setup-back")!.onclick = (e) => { e.preventDefault(); back(); };
  input.focus();
  const run = async () => {
    const host = input.value.trim();
    if (!host) return input.focus();
    go.disabled = true;
    msg.textContent = "Setup is running in the console window…";
    try {
      const code = await invoke<number>("run_setup", { host });
      const s = await setupState();
      if (code === 0 && s.configured) {
        box.remove();
        done();
        return;
      }
      msg.textContent = `Setup did not finish (exit ${code}). Read the console output, fix what it says, and try again.`;
    } catch (e) {
      msg.textContent = String(e);
    }
    go.disabled = false;
  };
  go.onclick = run;
  input.onkeydown = (e) => { if (e.key === "Enter") void run(); };
}
