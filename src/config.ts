import "dotenv/config";
import { z } from "zod";

// League settings stay optional until each adapter lands; adapters check what they need.
const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  SLEEPER_LEAGUE_ID: optional,
  SLEEPER_USERNAME: optional,

  ESPN_LEAGUE_ID: optional,
  ESPN_SEASON: optional,
  ESPN_S2: optional,
  ESPN_SWID: optional,
  ESPN_TEAM_ID: optional,

  YAHOO_LEAGUE_ID: optional,
  YAHOO_CLIENT_ID: optional,
  YAHOO_CLIENT_SECRET: optional,
  YAHOO_REDIRECT_URI: optional,
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
