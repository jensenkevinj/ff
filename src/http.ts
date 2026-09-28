import { z } from "zod";

// Shared GET-and-validate helper for the adapters. Every failure becomes an Error whose message names
// the service and URL, because that message ends up on the dashboard card.

export type FetchJsonOptions = {
  /** Service name for error messages, e.g. "Sleeper". */
  service: string;
  fetch: typeof globalThis.fetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Defaults to GET. */
  method?: "GET" | "POST";
  /** For POST. URLSearchParams sends a form (`application/x-www-form-urlencoded`), as OAuth expects. */
  body?: URLSearchParams;
};

// A non-2xx response. Subclassing Error lets callers check `err instanceof HttpError` and read the
// status, e.g. to turn ESPN's 401 into advice about cookies.
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export async function fetchJson<S extends z.ZodType>(
  url: string,
  schema: S,
  { service, fetch, headers, timeoutMs = 10_000, method = "GET", body }: FetchJsonOptions,
): Promise<z.infer<S>> {
  let res: Response;
  try {
    // AbortSignal.timeout() cancels a request that hangs; fetch has no timeout by default.
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`${service} request failed: ${method} ${url}: ${errorMessage(err)}`, { cause: err });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(`${service} returned HTTP ${res.status} for ${method} ${url}`, res.status, text);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(`${service} sent a response that isn't JSON: ${method} ${url}`, { cause: err });
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Unexpected ${service} response from ${method} ${url}:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

// fetch's own errors are vague ("fetch failed"); the useful detail (DNS, refused, timeout) is in `cause`.
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}
