// `npm run yahoo:auth`: the one-time Yahoo login. Prints the consent URL, reads back the code Yahoo shows
// (or the URL it redirected to), trades it for tokens and saves them to .tokens/yahoo.json. The server
// refreshes them from then on; run this again only if the card says to.
import "dotenv/config";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseConfig } from "../config.js";
import { errorMessage } from "../http.js";
import { yahooTokensFile } from "../paths.js";
import { consentUrl, createYahooTokenStore, parseAuthCode } from "../adapters/yahoo-oauth.js";

const config = parseConfig(process.env);
const {
  YAHOO_CLIENT_ID: clientId,
  YAHOO_CLIENT_SECRET: clientSecret,
  YAHOO_REDIRECT_URI: redirectUri,
} = config;
if (!clientId || !clientSecret || !redirectUri) {
  console.error("Set YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET and YAHOO_REDIRECT_URI in .env first.");
  process.exit(1);
}

// A CLI talks to a person, so plain console output is right here (the no-console.log rule is for the server).
console.log("1. Open this URL in a browser and approve access:\n");
console.log(`   ${consentUrl({ clientId, redirectUri })}\n`);
console.log("2. Yahoo then shows a code, or sends you to a page that fails to load. Either is fine:");
console.log("   paste the code, or the whole address from the browser's address bar.\n");

const rl = createInterface({ input: stdin, output: stdout });
try {
  const code = parseAuthCode(await rl.question("Code or URL: "));
  const store = createYahooTokenStore({ clientId, clientSecret, redirectUri, tokensFile: yahooTokensFile });
  const tokens = await store.exchangeCode(code);
  console.log(
    `\nSaved to ${yahooTokensFile}. Access token valid until ${new Date(tokens.expiresAt).toLocaleString()}.`,
  );
} catch (err) {
  console.error(`\nYahoo login failed: ${errorMessage(err)}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
