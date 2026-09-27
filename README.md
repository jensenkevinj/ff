# ff

A single-page live dashboard for my fantasy football matchups across ESPN, Yahoo, and Sleeper.

See [PLAN.md](PLAN.md) for the implementation plan.

## Running

Requires Node 20+.

```sh
cp .env.example .env   # fill in league IDs as each adapter lands
npm install
npm run dev            # http://localhost:3000
```

`npm run build && npm start` runs the compiled version.
