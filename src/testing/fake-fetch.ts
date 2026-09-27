// Test-only stand-in for fetch. `respond` gets each request's URL and returns what to answer with:
// a body to send as JSON, a number to send as that HTTP status, or undefined for a 404.
// Every request is recorded in `calls` so tests can check what was sent.

export type FakeCall = { url: URL; headers: Headers };

export function fakeFetch(respond: (url: URL) => unknown, calls: FakeCall[] = []): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const body = respond(url);
    if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (typeof body === "number") return Promise.resolve(new Response("error", { status: body }));
    return Promise.resolve(Response.json(body));
  };
}
