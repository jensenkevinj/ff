// Yahoo's JSON is converted straight from XML, so it has two awkward shapes that `flatten` undoes:
//
//   lists:      { "0": {...}, "1": {...}, "count": 2 }        → [ {...}, {...} ]
//   properties: [ { team_key: "…" }, { name: "…" }, [] ]      → { team_key: "…", name: "…" }
//
// Yahoo pads property lists with empty arrays (`[]`), which are dropped. Everything else passes through
// unchanged, so zod schemas can then describe the data like ordinary JSON.

export function flatten(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(flatten);
    return isPropertyList(items) ? Object.assign({}, ...items.filter(isRecord)) : items;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((k) => k === "count" || /^\d+$/.test(k))) {
      // Numeric keys aren't guaranteed to be in order, so sort by index rather than trusting insertion order.
      return keys
        .filter((k) => k !== "count")
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => flatten(value[k]));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, flatten(v)]));
  }
  return value;
}

// A property list is an array of single-purpose objects whose keys don't repeat. If keys do repeat
// (`[{ stat: … }, { stat: … }]`), it's a real list of items and must stay an array. The catch: a real
// list with exactly one item looks like a property list, so schemas for lists that can be short use
// `listOf` below.
function isPropertyList(items: unknown[]): boolean {
  const isPadding = (i: unknown) => Array.isArray(i) && i.length === 0;
  const objects = items.filter(isRecord);
  if (objects.length === 0 || objects.length + items.filter(isPadding).length !== items.length) return false;
  const keys = objects.flatMap((o) => Object.keys(o));
  return new Set(keys).size === keys.length;
}

/** Accepts one item where a list was expected: see the note on `isPropertyList`. */
export function listOf(value: unknown): unknown {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
