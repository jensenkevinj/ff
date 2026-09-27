// One-time Yahoo sign-in: `npm run yahoo:auth`. Prints a Yahoo URL; after you approve access, paste back the
// code Yahoo shows you (or the whole URL your browser ended up on). Tokens are saved to .tokens/yahoo.json.
// The code can also be passed as an argument: `npm run yahoo:auth -- <code>`.
import "dotenv/config";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createYahooAuth, extractCode } from "./adapters/yahoo-auth.js";
import { parseConfig } from "./config.js";
import { yahooTokenFile } from "./sources.js";

const config = parseConfig(process.env);
const {
  YAHOO_CLIENT_ID: clientId,
  YAHOO_CLIENT_SECRET: clientSecret,
  YAHOO_REDIRECT_URI: redirectUri,
} = config;
if (!clientId || !clientSecret || !redirectUri) {
  // A CLI talks to a person at a terminal, so plain stderr output is right here (the server uses its logger).
  console.error("Set YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET and YAHOO_REDIRECT_URI first (see .env.example).");
  process.exit(1);
}

const auth = createYahooAuth({ clientId, clientSecret, redirectUri, tokenFile: yahooTokenFile });

let input = process.argv[2];
if (!input) {
  console.log(`1. Open this URL and approve access:\n\n   ${auth.authorizeUrl()}\n`);
  console.log("2. Paste the code Yahoo shows you (or the full URL you were redirected to).\n");
  const rl = createInterface({ input: stdin, output: stdout });
  input = await rl.question("Code: ");
  rl.close();
}

try {
  await auth.exchangeCode(extractCode(input));
  console.log(`Signed in. Tokens saved to ${yahooTokenFile}; they refresh automatically.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
