// Test-only stand-in for fetch. `respond` gets each request's URL (and the call, for POSTs) and returns
// what to answer with: a body to send as JSON, a number to send as that HTTP status, or undefined for a 404.
// Every request is recorded in `calls` so tests can check what was sent.

export type FakeCall = { url: URL; method: string; headers: Headers; body?: string };

export function fakeFetch(
  respond: (url: URL, call: FakeCall) => unknown,
  calls: FakeCall[] = [],
): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const call: FakeCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
    };
    calls.push(call);
    const body = respond(url, call);
    if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (typeof body === "number") return Promise.resolve(new Response("error", { status: body }));
    return Promise.resolve(Response.json(body));
  };
}
