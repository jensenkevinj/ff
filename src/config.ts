import { z } from "zod";

// Blank counts as unset: `HOST=` in .env means "use the default", same as leaving the line out.
const blankAsUnset = (v: unknown) => (v === "" ? undefined : v);

// League settings stay optional until each adapter lands; adapters check what they need.
const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

// Optional whole number, e.g. a season or team ID.
const optionalInt = z.preprocess(blankAsUnset, z.coerce.number().int().positive().optional());

const schema = z.object({
  // Loopback by default: only this machine can connect. 0.0.0.0 listens on every network interface.
  HOST: z.preprocess(blankAsUnset, z.string().trim().min(1).default("127.0.0.1")),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  SLEEPER_LEAGUE_ID: optional,
  SLEEPER_USERNAME: optional,

  ESPN_LEAGUE_ID: optional,
  ESPN_SEASON: optionalInt,
  ESPN_S2: optional,
  ESPN_SWID: optional,
  ESPN_TEAM_ID: optionalInt,

  YAHOO_LEAGUE_ID: optional,
  YAHOO_CLIENT_ID: optional,
  YAHOO_CLIENT_SECRET: optional,
  YAHOO_REDIRECT_URI: optional,
});

export type Config = z.infer<typeof schema>;

// Takes env as a parameter (instead of reading process.env directly) so tests can pass their own.
export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration in .env:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// True for addresses only reachable from this machine. Used to warn when the server is exposed to the network.
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
