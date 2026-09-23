// The repo's QML helper modules, shared with the web UI.
declare module "*/SendState.mjs" {
  export function markSendFailed<T extends { localId?: number }>(items: T[], id: number, reason: string, fallback?: T): T[];
}
declare module "*/MessageActions.mjs" {
  export function quoteText(message: unknown): string;
  export function quotedDraft(message: unknown, draft: string): string;
}
