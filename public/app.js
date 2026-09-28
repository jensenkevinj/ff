const POLL_MS = 30_000;

const tabBar = document.getElementById("tabs");
const container = document.getElementById("matchups");
const lastUpdated = document.getElementById("last-updated");

// Bench order; starters keep the lineup order the adapter sends. Unknown positions go last.
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "D/ST", "DEF"];
const STATUS_LABEL = { pre: "not started", live: "playing", done: "finished" };

// The latest API response, kept so switching tabs re-renders instantly instead of waiting for the next poll.
let matchups = [];

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
  const section = el("div", "players");
  section.append(el("div", "section-label muted", "Starters"));
  section.append(playerRows(m.me.starters ?? [], m.opponent.starters ?? [], "starters"));

  // toSorted returns a new array instead of sorting in place, leaving the API response untouched.
  const myBench = (m.me.bench ?? []).toSorted((a, b) => positionRank(a) - positionRank(b));
  const theirBench = (m.opponent.bench ?? []).toSorted((a, b) => positionRank(a) - positionRank(b));
  if (myBench.length || theirBench.length) {
    section.append(el("div", "section-label muted", "Bench"));
    section.append(playerRows(myBench, theirBench, "bench"));
  }
  return section;
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

  node.classList.add(outcome(m));

  const body = el("div", "card-body");
  body.append(teamBlock(m.me, "me"), el("div", "vs muted", "vs"), teamBlock(m.opponent, "opp"));
  node.append(body);

  if (m.me.starters?.length || m.opponent.starters?.length) node.append(playersSection(m));

  node.append(
    el("div", "card-foot muted", `Week ${m.week} · updated ${new Date(m.updatedAt).toLocaleTimeString()}`),
  );
  return node;
}

function outcome(m) {
  const diff = m.me.points - m.opponent.points;
  return diff > 0 ? "winning" : diff < 0 ? "losing" : "tied";
}

// One league per platform (the server caches by platform too), so the platform name is the tab's ID.
// It lives in the URL hash, so a refresh or a bookmark like /#espn opens the same tab.
function selectedPlatform() {
  const wanted = location.hash.slice(1);
  return matchups.some((m) => m.platform === wanted) ? wanted : matchups[0]?.platform;
}

function selectTab(platform, focus = false) {
  // replaceState changes the hash without adding a history entry for every tab click, and without
  // firing "hashchange", so render() is called directly below.
  history.replaceState(null, "", `#${platform}`);
  render();
  if (focus) document.getElementById(`tab-${platform}`)?.focus();
}

function tab(m, selected) {
  const button = el("button", `tab ${m.error ? "has-error" : outcome(m)}`);
  button.id = `tab-${m.platform}`;
  button.type = "button";
  button.setAttribute("role", "tab");
  button.setAttribute("aria-selected", String(selected));
  button.setAttribute("aria-controls", "matchups");
  // Roving tabindex: only the selected tab is in the Tab-key order; arrow keys move between tabs.
  button.tabIndex = selected ? 0 : -1;
  button.addEventListener("click", () => selectTab(m.platform));

  button.append(el("span", "tab-platform", m.platform.toUpperCase()));
  if (m.status === "live") button.append(el("span", "tab-live", "●"));
  button.append(el("span", "tab-score", m.error ? "error" : `${fmt(m.me.points)}–${fmt(m.opponent.points)}`));
  button.title = m.leagueName;
  return button;
}

function render() {
  const current = selectedPlatform();
  tabBar.replaceChildren(...matchups.map((m) => tab(m, m.platform === current)));
  tabBar.hidden = matchups.length < 2; // nothing to switch between
  const m = matchups.find((x) => x.platform === current);
  container.setAttribute("aria-labelledby", `tab-${current}`);
  container.replaceChildren(...(m ? [card(m)] : []));
}

// Typing a new #hash, or Back/Forward, changes the tab without reloading the page.
window.addEventListener("hashchange", render);

tabBar.addEventListener("keydown", (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step || matchups.length === 0) return;
  const i = matchups.findIndex((m) => m.platform === selectedPlatform());
  const next = matchups[(i + step + matchups.length) % matchups.length];
  selectTab(next.platform, true);
});

async function refresh() {
  try {
    const res = await fetch("/api/matchups");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    matchups = await res.json();
    render();
    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    lastUpdated.classList.remove("stale");
  } catch (err) {
    lastUpdated.textContent = `Update failed (${err.message}) — retrying`;
    lastUpdated.classList.add("stale");
  }
}

refresh();
setInterval(refresh, POLL_MS);
