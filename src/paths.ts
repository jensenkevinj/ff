import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo root, whether running from src/ (tsx) or dist/ (compiled): both are one level down.
export const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Local state, all gitignored.
export const sleeperPlayersFile = path.join(projectRoot, ".cache", "sleeper-players.json");
export const yahooTokensFile = path.join(projectRoot, ".tokens", "yahoo.json");
