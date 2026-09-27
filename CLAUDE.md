# CLAUDE.md

Unified fantasy football live dashboard (ESPN, Yahoo, Sleeper). A Node 24 + TypeScript + Fastify backend normalizes
each platform into one `Matchup` shape; a static page in `public/` polls `/api/matchups`.

- **Plan and status:** [PLAN.md](PLAN.md). Update its status table and checkboxes as work lands.
- **Current handoff:** [docs/step-2-kickoff.md](docs/step-2-kickoff.md). Read it before starting Step 2.

## Working with Kevin

- Kevin is using this project to **learn Node.js in depth**. Explain Node/TypeScript choices briefly as they come up
  (why this pattern, what the alternative is), tied to the code being written. Keep explanations short.
- Follow industry best practices; if you take a shortcut on purpose, say so.
- One commit per plan step, message `Step N: <summary>` with a bullet list body. Run `npm run check` before committing.
  Don't push unless asked.

## Commands

```sh
npm ci                 # install exactly what package-lock.json pins
npm run dev            # http://localhost:3000, tsx watch + pino-pretty
npm run check          # lint + format check + typecheck + tests (same as CI)
npm test               # node:test via tsx, files matching src/**/*.test.ts
npm run format         # Prettier --write
npm run build && npm start
```

## Conventions that aren't obvious from one file

- **ES modules + `module: NodeNext`.** Relative imports use the **`.js` extension** even though the source is `.ts`
  (`import { parseConfig } from "./config.js"`). The compiler does not rewrite import paths.
- **TypeScript is pinned to `~6.0` on purpose.** TS 7 (native compiler) isn't supported by typescript-eslint yet.
  Don't upgrade until it is.
- **`app.ts` vs `server.ts`.** `buildApp()` in `app.ts` builds the Fastify app without listening; tests call it
  and use `app.inject()`. `server.ts` is the entry point only: loads `.env`, parses config, listens, handles
  SIGINT/SIGTERM.
- **Config.** Every env var is declared in the zod schema in `src/config.ts` **and** listed in `.env.example`.
  `parseConfig(env)` takes env as a parameter so tests can pass their own. Blank values count as unset.
- **Logging.** Use Fastify's logger (`app.log`, `request.log`), never `console.log`. `/api/matchups` is polled every
  30s, so it's registered with `logLevel: "warn"`.
- **Lint.** Type-aware typescript-eslint. `no-floating-promises` and `require-await` are on: await or handle every
  promise; don't mark functions `async` without awaiting.
- **Tests** live next to the code as `*.test.ts`, use `node:test` + `node:assert/strict`, and never hit real
  networks.
- **Gitignored local state:** `.env`, `.cache/` (Sleeper players file), `.tokens/` (Yahoo OAuth).
- npm prints `install-scripts` warnings for `esbuild` and `fsevents`. They're harmless; tsx works without them.
