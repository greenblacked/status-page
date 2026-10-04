export const ANCHOR_STATUS: number;
export const ANCHOR_APPLE: number;
export const ANCHOR_WINDOWS: number;
export const ANCHOR_RELEASES: number;
export const ROUTES: Record<string, { file: string; anchor: number; utf16?: boolean }>;
export function shiftDates(text: string, from: number, to: number): string;
export function cannedPayload(url: URL, now: number): { body: string; type: string; utf16: boolean } | undefined;
