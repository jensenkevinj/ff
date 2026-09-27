# ff

A single-page live dashboard for my fantasy football matchups across ESPN, Yahoo, and Sleeper.

See [PLAN.md](PLAN.md) for the implementation plan.

## Running

Requires Node 24 (pinned in `.nvmrc`). With [fnm](https://github.com/Schniz/fnm) set up, `cd`-ing into the repo switches to it automatically.

```sh
cp .env.example .env   # fill in league IDs as each adapter lands
npm install
npm run dev            # http://localhost:3000, restarts on file changes
```

| Script              | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Run from TypeScript source with auto-restart and pretty logs    |
| `npm test`          | Run tests (`src/**/*.test.ts`) with Node's built-in test runner |
| `npm run lint`      | ESLint, including type-aware TypeScript rules                   |
| `npm run format`    | Format everything with Prettier                                 |
| `npm run typecheck` | Type-check everything, including tests, without emitting        |
| `npm run check`     | Lint + format check + typecheck + tests (what CI runs)          |
| `npm run build`     | Compile to `dist/` (tests excluded)                             |
| `npm start`         | Run the compiled server                                         |
