export function rng(seed: number): () => number;
export function pen(pts: number[][], base: number, taper?: number, min?: number, swell?: number): string;
export function loop(cx: number, cy: number, r: number, seed: number, turns?: number, steps?: number): number[][];
export function underline(x0: number, x1: number, y: number, seed: number, steps?: number): number[][];
export const UNDERLINE_BOX: { width: number; height: number };
export const LOOP_BOX: { min: number; size: number; glyph: number };
export const LOOP_SEEDS: number[];
export function marks(): { underline: string; loops: string[] };
export function render(): string;
