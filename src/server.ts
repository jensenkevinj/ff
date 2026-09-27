import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "./config.js";
import { mockMatchups } from "./mock.js";
import type { Matchup } from "./types.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const app = Fastify({ logger: true });

await app.register(fastifyStatic, { root: publicDir });

app.get("/api/matchups", async (): Promise<Matchup[]> => mockMatchups());

try {
  await app.listen({ port: config.PORT, host: "127.0.0.1" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
