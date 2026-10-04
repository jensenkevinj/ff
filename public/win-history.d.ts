// Types for win-history.js, so the tests (TypeScript) can import it. The browser never loads this file.
import type { Matchup } from "../src/types.js";

export type WinPoint = { t: number; p: number };
export type WinHistory = Record<string, { week: number; points: WinPoint[] }>;

export const MAX_POINTS: number;
export function addPoints(history: WinHistory, matchups: Matchup[], now: number): WinHistory;
