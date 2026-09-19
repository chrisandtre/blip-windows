#!/usr/bin/env bun
/** Prepare a restored window and keep it on its last home across remaps. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Lua quoted strings use decimal escapes, unlike JSON's Unicode escapes.
export function luaString(value: string): string {
  return '"' + Array.from(Buffer.from(value), b => `\\${String(b).padStart(3, "0")}`).join("") + '"';
}

export function workspaceSelector(value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (/^[1-9][0-9]*$/.test(value) || value === "special" || value.startsWith("special:")) return value;
  return "name:" + value;
}

export function isLiveBlipTitle(title: unknown): boolean {
  return typeof title === "string" && /^Blip( \([0-9]+\))?$/.test(title);
}

export function windowAddress(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? value : null;
}

export type WorkspaceReason = "move" | "map" | "report" | "monitor";

/** User moves become the new home. A remap or monitor churn is a stray. */
export function workspaceDecision(saved: unknown, incoming: unknown, reason: WorkspaceReason): "save" | "return" | "ignore" {
  const next = typeof incoming === "string" ? incoming : "";
  const home = typeof saved === "string" ? saved : "";
  if (!next || /[\x00-\x1f\x7f]/.test(next)) return "ignore";
  // An empty home is claimed by a DELIBERATE move only. Claiming it on a map
  // made wherever the window happened to land its home for good, which with a
  // stale compositor rule (they outlive the plugin, only a reload clears them)
  // meant Super+M opened the app on a workspace the reader was not on, every
  // time (2026-09-19).
  if (!home) return reason === "move" ? "save" : "ignore";
  if (next === home) return "ignore";
  if (reason === "move") return "save";
  if (reason === "map" || reason === "monitor") return "return";
  return "ignore";
}

export function restoreRule(workspace: unknown, title: string): string {
  if (!/^Blip-restore-[a-f0-9-]+$/.test(title)) throw new Error("Invalid restore title");
  const target = workspaceSelector(workspace);
  return `hl.window_rule({ name = "blip-session-restore", match = { class = "^org\\\\.quickshell$", title = "^${title}$" }, no_initial_focus = true${target ? `, workspace = ${luaString(target + " silent")}` : ""} })`;
}

export function homeRule(workspace: unknown): string {
  const target = workspaceSelector(workspace);
  return `hl.window_rule({ name = "blip-session-home", match = { class = ${luaString("^org\\.quickshell$")}, title = ${luaString("^Blip( \\([0-9]+\\))?$")} }, no_initial_focus = true${target ? `, workspace = ${luaString(target + " silent")}` : ""} })`;
}

export function silentMove(workspace: unknown, address: unknown): string | null {
  const target = workspaceSelector(workspace);
  const addr = windowAddress(address);
  if (!target || !addr) return null;
  return `hl.dsp.window.move({ workspace = ${luaString(target)}, follow = false, window = ${luaString("address:" + addr)} })`;
}

/**
 * Does that workspace still exist? A home saved by name or id can outlive the
 * workspace itself: an empty workspace disappears, and a compactor like plonk
 * renumbers the ones that remain. Restoring onto a dead id does not find the
 * old place, it CREATES a workspace and drags the reader to it, which on
 * 2026-09-19 looked like the window opening, flying off, resizing and vanishing
 * (it then got renumbered under the window). Unknown or unreadable: treat as
 * alive, so a hyprctl hiccup cannot silently drop a real home.
 */
export function workspaceLives(workspace: unknown, live: unknown): boolean {
  const target = typeof workspace === "string" ? workspace : "";
  if (!target) return false;
  if (!Array.isArray(live)) return true;
  return live.some((w: any) => String(w?.name ?? "") === target || String(w?.id ?? "") === target);
}

function liveWorkspaces(): unknown {
  const result = spawnSync("hyprctl", ["workspaces", "-j"], { encoding: "utf8", timeout: 3000 });
  if (result.status !== 0) return null;
  try { return JSON.parse(String(result.stdout)); } catch { return null; }
}

function hyprEval(lua: string): boolean {
  const result = spawnSync("hyprctl", ["eval", lua], { encoding: "utf8", timeout: 3000 });
  return result.status === 0 && /^ok\s*$/.test(result.stdout);
}

function hyprDispatch(lua: string): boolean {
  const result = spawnSync("hyprctl", ["dispatch", lua], { encoding: "utf8", timeout: 3000 });
  return result.status === 0;
}

if (import.meta.main) {
  const action = process.argv[2] || "prepare";
  if (action === "home") {
    if (!hyprEval(homeRule(process.argv[3]))) {
      console.error("Blip could not keep the window on its workspace");
      process.exit(1);
    }
    process.exit(0);
  }
  if (action === "return") {
    const lua = silentMove(process.argv[3], process.argv[4]);
    if (!lua || !hyprDispatch(lua)) {
      console.error("Blip could not return the window to its workspace");
      process.exit(1);
    }
    process.exit(0);
  }

  const asked = action === "prepare" ? process.argv[3] : action;
  // A home that no longer exists is not a home. Opening here beats creating it.
  const workspace = workspaceSelector(asked) && !workspaceLives(asked, liveWorkspaces()) ? "" : asked;
  const title = `Blip-restore-${randomUUID()}`;
  if (!hyprEval(restoreRule(workspace, title))) {
    console.error("Blip could not prepare quiet window restoration");
    process.exit(1);
  }
  if (workspaceSelector(workspace) && !hyprEval(homeRule(workspace))) {
    console.error("Blip could not keep the window on its workspace");
    process.exit(1);
  }
  console.log(JSON.stringify({ title }));
}
