import Fastify, { type FastifyServerOptions } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mockMatchups } from "./mock.js";
import type { Matchup } from "./types.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// Builds the app without starting it, so tests can call routes with app.inject() instead of a real port.
export async function buildApp(opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);

  await app.register(fastifyStatic, { root: publicDir });

  // Polled every 30s by each open tab, so only log problems here, not every request.
  app.get("/api/matchups", { logLevel: "warn" }, (): Matchup[] => mockMatchups());

  return app;
}
