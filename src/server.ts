import "dotenv/config"; // loads .env into process.env; must run before config is parsed
import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { createSources } from "./sources.js";

const config = parseConfig(process.env);
const sources = createSources(config);
const app = await buildApp({ logger: { level: config.LOG_LEVEL }, sources });

app.log.info({ platforms: sources.map((s) => s.platform) }, "active leagues (espn and yahoo are mock data)");
if (!sources.some((s) => s.platform === "sleeper")) {
  app.log.info("Sleeper not configured (set SLEEPER_LEAGUE_ID and SLEEPER_USERNAME); skipping it");
}

// Graceful shutdown: stop accepting connections and let in-flight requests finish before exiting.
// SIGINT is Ctrl+C; SIGTERM is what process managers and hosts (Docker, Fly.io, Render) send.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error(err, "error during shutdown");
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ port: config.PORT, host: "127.0.0.1" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
