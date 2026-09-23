// First run: no bridge.conf yet means no Mac to talk to. The setup itself
// runs in a console window (blip-setup.ps1), where ssh can ask for the Mac's
// password and fingerprint.
import { invoke } from "@tauri-apps/api/core";

export interface SetupState { configured: boolean; host: string; shims: boolean }

export function setupState(): Promise<SetupState> {
  return invoke<SetupState>("setup_state");
}

export function setupScreen(): Promise<void> {
  return new Promise((done) => {
    const box = document.createElement("div");
    box.className = "setup";
    box.innerHTML = `
      <div class="setup-card">
        <h1>Set up Blip</h1>
        <p>Blip reads and sends iMessage through a Mac you own. The Mac must be signed into your
        Apple ID, stay awake, and have <b>Remote Login</b> on (System Settings &rarr; General &rarr; Sharing).</p>
        <label>Mac address <input id="setup-host" placeholder="you@your-mac" spellcheck="false"></label>
        <p class="setup-hint">Your Mac login name and its name on the network, or its Tailscale name.
        A console window opens next. Before typing <b>yes</b> to the Mac's fingerprint, compare it with
        <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> run on the Mac. Then type the
        Mac's password once, and be at the Mac to click <b>Allow</b> when it asks.</p>
        <button id="setup-go">Set up</button>
        <p id="setup-msg" class="setup-msg"></p>
      </div>`;
    document.body.append(box);
    const input = box.querySelector<HTMLInputElement>("#setup-host")!;
    const go = box.querySelector<HTMLButtonElement>("#setup-go")!;
    const msg = box.querySelector<HTMLParagraphElement>("#setup-msg")!;
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
  });
}
