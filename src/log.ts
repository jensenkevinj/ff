import type { FastifyBaseLogger } from "fastify";

// Only the methods adapters call, so tests can pass a stub instead of a full Fastify logger.
export type Log = Pick<FastifyBaseLogger, "info" | "warn">;
