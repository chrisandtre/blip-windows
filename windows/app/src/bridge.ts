// The only way the UI reaches the core, the Mac bridge, or the OS. Every call
// the QML made with Process/execDetached has its equivalent here.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type Out = { code: number; stdout: string; stderr: string };

export interface Thread {
  chat: string;
  aliases?: string[];
  guid: string;
  name: string;
  handle: string;
  service: string;
  last_ts: string;
  last_text: string;
  last_from_me: boolean;
  count: number;
  unread: number;
  pinned: boolean;
  pin_order: number | null;
  pin_name?: string;
  participants?: { handle: string; name: string }[];
}

export interface Toast { chat: string; name: string; text: string; ts: string; key: string }
export interface SecurityCode { chat: string; name: string; code: string; domain: string; ts: string; key: string }

export interface CollectorOut {
  ok: boolean;
  online: boolean;
  error: string;
  ts: string;
  unread: number;
  threads: Thread[];
  toast: Toast[];
  failures: Toast[];
  links?: { chat: string; url: string; urls: string[]; ts: string; key: string }[];
  codes?: SecurityCode[];
  persisted: boolean;
  deep?: boolean;
  readPush?: string;
}

export interface Attachment { id: string; name: string; mime: string; bytes: number | null }

export interface Bubble {
  ts: string;
  from_me: boolean;
  name: string;
  text: string;
  day: string;
  groupStart: boolean;
  groupEnd: boolean;
  time: string;
  receipt: string;
  tapbacks: { emoji: string; from_me: boolean; by: string }[];
  attachments: Attachment[];
  replyText: string;
  replyMine: boolean;
  edited: boolean;
  link: { url: string; title: string; summary: string; image_id: string } | null;
  retracted: boolean;
  effect: string;
  failed?: boolean;
  failureReason?: string;
  pending?: boolean;
  scheduled?: boolean;
  scheduledFor?: string;
  localId?: number;
  /** The Mac's guid for the message: what a reaction is aimed at. */
  guid?: string;
}

export interface PendingSend { chat: string; text: string; ts: string; localId: number; failed?: boolean; failureReason?: string }

export function core(script: string, args: string[] = [], stdin?: string, timeoutMs?: number): Promise<Out> {
  return invoke<Out>("core", { script, args, stdin: stdin ?? null, timeoutMs: timeoutMs ?? null });
}

export function shim(tool: string, args: string[] = [], stdin?: string, timeoutMs?: number): Promise<Out> {
  return invoke<Out>("shim", { tool, args, stdin: stdin ?? null, timeoutMs: timeoutMs ?? null });
}

/** Parse a script's single JSON line; null when it printed something else. */
export function json<T>(o: Out): T | null {
  try {
    return JSON.parse(o.stdout.trim().split("\n").pop() || "") as T;
  } catch {
    return null;
  }
}

/** A file:///C:/... URL from the core, as a URL the webview may load
 *  (asset protocol, scoped to Blip's cache in tauri.conf.json). */
export function fileSrc(url: string): string {
  if (!url) return "";
  if (!url.startsWith("file://")) return "";
  return convertFileSrc(filePath(url));
}

export function filePath(url: string): string {
  return decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
}

/** Save pasted image bytes as a draft file; returns its path. */
export function writeDraft(name: string, bytes: Uint8Array): Promise<string> {
  return invoke<string>("write_draft", bytes, { headers: { "x-blip-name": name } });
}
