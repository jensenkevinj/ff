// Types for score-changes.js, so the tests (TypeScript) can import it. The browser never loads this file.
import type { Matchup } from "../src/types.js";

export type Direction = "up" | "down";

export function teamKey(platform: string, side: "me" | "opp"): string;
export function playerKey(platform: string, side: "me" | "opp", name: string): string;
export function scoreChanges(prev: Matchup[], next: Matchup[]): Map<string, Direction>;
