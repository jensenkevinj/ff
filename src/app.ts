import Fastify, { type FastifyServerOptions } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TtlCache } from "./cache.js";
import type { Log } from "./adapters/sleeper.js";
import type { MatchupSource } from "./sources.js";
import type { Matchup, Platform } from "./types.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const CACHE_TTL_MS = 20_000;
const PLATFORM_NAMES: Record<Platform, string> = { espn: "ESPN", yahoo: "Yahoo", sleeper: "Sleeper" };

export type AppOptions = FastifyServerOptions & { sources?: MatchupSource[] };

// Builds the app without starting it, so tests can call routes with app.inject() instead of a real port.
// Sources are passed in (server.ts builds them from config), so tests can supply fakes.
export async function buildApp({ sources = [], ...fastifyOpts }: AppOptions = {}) {
  const app = Fastify(fastifyOpts);
  const cache = new TtlCache<Matchup>(CACHE_TTL_MS);

  await app.register(fastifyStatic, { root: publicDir });

  // Polled every 30s by each open tab, so only log problems here, not every request.
  app.get("/api/matchups", { logLevel: "warn" }, async (request): Promise<Matchup[]> => {
    // allSettled (unlike Promise.all) waits for every league and never rejects, so one failing
    // league becomes an error card instead of blanking the whole page.
    const results = await Promise.allSettled(
      sources.map((s) => cache.getOrLoad(s.platform, () => s.load(request.log))),
    );
    return results.map((r, i) =>
      r.status === "fulfilled" ? r.value : errorMatchup(sources[i].platform, r.reason, request.log),
    );
  });

  return app;
}

function errorMatchup(platform: Platform, err: unknown, log: Log): Matchup {
  log.warn({ err, platform }, "failed to load league");
  return {
    platform,
    leagueName: PLATFORM_NAMES[platform],
    week: 0,
    status: "pre",
    updatedAt: new Date().toISOString(),
    me: { name: "", points: 0 },
    opponent: { name: "", points: 0 },
    error: err instanceof Error ? err.message : String(err),
  };
}
