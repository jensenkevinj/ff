const POLL_MS = 30_000;

const container = document.getElementById("matchups");
const lastUpdated = document.getElementById("last-updated");

// Bench order; starters keep the lineup order the adapter sends. Unknown positions go last.
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "D/ST", "DEF"];
const STATUS_LABEL = { pre: "not started", live: "playing", done: "finished" };

// Cards whose player list is open. Every poll rebuilds the DOM, so this remembers what to re-open.
const openCards = new Set();

function fmt(n) {
  return typeof n === "number" ? n.toFixed(2) : "–";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function teamBlock(team, side) {
  const block = el("div", `team ${side}`);
  const name = el("div", "team-name", team.name);
  name.title = team.name; // full name on hover when it's truncated
  block.append(name);
  if (team.owner) block.append(el("div", "owner muted", team.owner));
  block.append(el("div", "points", fmt(team.points)));
  const meta = [];
  if (team.projected !== undefined) meta.push(`proj ${fmt(team.projected)}`);
  if (team.playersRemaining !== undefined) meta.push(`${team.playersRemaining} left`);
  if (meta.length) block.append(el("div", "meta muted", meta.join(" · ")));
  return block;
}

function positionRank(p) {
  const i = POSITION_ORDER.indexOf(p.position);
  return i === -1 ? POSITION_ORDER.length : i;
}

// "Harold Fannin Jr." → "H. Fannin Jr.", the usual fantasy-app style; the full name is in the tooltip.
// Team defenses ("Texans D/ST", "Buffalo Bills") and one-word names are left alone.
function shortName(p) {
  if (p.position === "D/ST" || p.position === "DEF") return p.name;
  const [first, ...rest] = p.name.split(" ");
  return rest.length ? `${first[0]}. ${rest.join(" ")}` : p.name;
}

function playerCell(p, side) {
  const cell = el("div", `player ${side}`);
  if (!p) return cell; // the other team has more players in this section
  cell.classList.add(p.status);
  cell.title = [p.name, p.statLine, STATUS_LABEL[p.status]].filter(Boolean).join(" · ");
  cell.append(el("span", "pos muted", p.position));
  const info = el("span", "player-info");
  info.append(el("span", "player-name", shortName(p)));
  if (p.statLine) info.append(el("span", "stat-line muted", p.statLine));
  cell.append(info);
  const pts = el("span", "pts");
  pts.append(el("span", "pts-actual", fmt(p.points)));
  if (p.projected !== undefined) pts.append(el("span", "pts-proj muted", fmt(p.projected)));
  cell.append(pts);
  return cell;
}

// My players on the left, the opponent's mirrored on the right, so points sit next to each other.
function playerRows(mine, theirs, className) {
  const rows = el("div", `player-rows ${className}`);
  for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
    rows.append(playerCell(mine[i], "me"), playerCell(theirs[i], "opp"));
  }
  return rows;
}

function playersSection(m) {
  const key = `${m.platform}:${m.leagueName}`;
  const details = el("details", "players");
  details.open = openCards.has(key);
  details.addEventListener("toggle", () => {
    if (details.open) openCards.add(key);
    else openCards.delete(key);
  });
  details.append(el("summary", "muted", "Players"));
  details.append(playerRows(m.me.starters ?? [], m.opponent.starters ?? [], "starters"));

  // toSorted returns a new array instead of sorting in place, leaving the API response untouched.
  const myBench = (m.me.bench ?? []).toSorted((a, b) => positionRank(a) - positionRank(b));
  const theirBench = (m.opponent.bench ?? []).toSorted((a, b) => positionRank(a) - positionRank(b));
  if (myBench.length || theirBench.length) {
    details.append(el("div", "section-label muted", "Bench"));
    details.append(playerRows(myBench, theirBench, "bench"));
  }
  return details;
}

function card(m) {
  const node = el("section", `card ${m.platform}`);

  const head = el("div", "card-head");
  head.append(el("span", "platform", m.platform.toUpperCase()));
  head.append(el("span", "league", m.leagueName));
  head.append(el("span", `status ${m.status}`, m.status === "live" ? "LIVE" : m.status.toUpperCase()));
  node.append(head);

  if (m.error) {
    node.append(el("div", "error", m.error));
    return node;
  }

  const diff = m.me.points - m.opponent.points;
  node.classList.add(diff > 0 ? "winning" : diff < 0 ? "losing" : "tied");

  const body = el("div", "card-body");
  body.append(teamBlock(m.me, "me"), el("div", "vs muted", "vs"), teamBlock(m.opponent, "opp"));
  node.append(body);

  if (m.me.starters?.length || m.opponent.starters?.length) node.append(playersSection(m));

  node.append(
    el("div", "card-foot muted", `Week ${m.week} · updated ${new Date(m.updatedAt).toLocaleTimeString()}`),
  );
  return node;
}

async function refresh() {
  try {
    const res = await fetch("/api/matchups");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const matchups = await res.json();
    container.replaceChildren(...matchups.map(card));
    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    lastUpdated.classList.remove("stale");
  } catch (err) {
    lastUpdated.textContent = `Update failed (${err.message}) — retrying`;
    lastUpdated.classList.add("stale");
  }
}

refresh();
setInterval(refresh, POLL_MS);
