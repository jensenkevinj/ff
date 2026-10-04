import { playerKey, scoreChanges, teamKey } from "./score-changes.js";
import { addPoints } from "./win-history.js";

// Poll fast while a game is being played, slowly otherwise, and not at all while the tab is hidden.
const LIVE_POLL_MS = 30_000;
const IDLE_POLL_MS = 5 * 60_000;
const RETRY_MS = 30_000;

const tabBar = document.getElementById("tabs");
const container = document.getElementById("matchups");
const lastUpdated = document.getElementById("last-updated");
const refreshButton = document.getElementById("refresh");
const sheet = document.getElementById("player-sheet");
const sheetContent = document.getElementById("sheet-content");

// Bench order; starters keep the lineup order the adapter sends. Unknown positions go last.
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "D/ST", "DEF"];
const STATUS_LABEL = { pre: "not started", live: "playing", done: "finished" };
const INJURY_LABEL = {
  Q: "questionable",
  D: "doubtful",
  DTD: "day-to-day",
  O: "out",
  IR: "injured reserve",
  PUP: "PUP list",
  SUS: "suspended",
};

// The latest API response, kept so switching tabs re-renders instantly instead of waiting for the next poll.
let matchups = [];
// Scores that moved in the latest poll (key → "up" | "down"), flashed once by render(). refresh() empties it
// afterwards, so switching tabs doesn't replay old flashes.
let flashes = new Map();

// Win probability through the day, per league (see win-history.js). localStorage rather than sessionStorage, so
// closing the tab mid-game doesn't lose it; the week change resets it, which keeps it small. Storage can be
// unavailable (private mode, blocked site data) or hold something unexpected, so every access is guarded and
// the trend just starts over.
const HISTORY_KEY = "ff.winHistory";
let winHistory = loadHistory();

function loadHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(winHistory));
  } catch {
    // Full or blocked: the trend lasts until the page is reloaded.
  }
}

// Team totals keep two decimals (close games are decided on them); player points use one, which is easier to scan.
function fmt(n, digits = 2) {
  return typeof n === "number" ? n.toFixed(digits) : "–";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function recordText({ wins, losses, ties, rank }) {
  const record = ties ? `${wins}–${losses}–${ties}` : `${wins}–${losses}`;
  return rank ? `${record} · ${ordinal(rank)}` : record;
}

// 1 → "1st", 2 → "2nd", 11 → "11th", 22 → "22nd". Intl.PluralRules knows English's ordinal rules.
const ordinalRules = new Intl.PluralRules("en-US", { type: "ordinal" });
const SUFFIX = { one: "st", two: "nd", few: "rd", other: "th" };
function ordinal(n) {
  return `${n}${SUFFIX[ordinalRules.select(n)]}`;
}

function teamBlock(team, side) {
  const block = el("div", `team ${side}`);
  const name = el("div", "team-name", team.name);
  name.title = team.name; // full name on hover when it's truncated
  block.append(name);
  // "Kevin Jensen · 0–4 · 11th". Sleeper's owner is often the same as the team name, so skip repeats.
  // The owner's name truncates if space runs out; the record never breaks.
  const showOwner = team.owner && team.owner.toLowerCase() !== team.name.toLowerCase();
  if (showOwner || team.record) {
    const sub = el("div", "owner muted");
    if (showOwner) sub.append(el("span", "owner-name", team.owner));
    if (team.record) sub.append(el("span", "record", `${showOwner ? " · " : ""}${recordText(team.record)}`));
    block.append(sub);
  }
  block.append(el("div", "points", fmt(team.points)));
  const meta = [];
  if (team.projected !== undefined) meta.push(`proj ${fmt(team.projected)}`);
  if (team.playersRemaining !== undefined) meta.push(`${team.playersRemaining} left`);
  if (meta.length) block.append(el("div", "meta muted", meta.join(" · ")));
  return block;
}

// 0.994 → "99%", but never "100%" or "0%" while the game is still going: ESPN, for one, caps at 99/1.
function percent(p) {
  if (p > 0.99 && p < 1) return ">99%";
  if (p < 0.01 && p > 0) return "<1%";
  return `${Math.round(p * 100)}%`;
}

// A bar split between the two teams, like the fantasy apps' "win probability" line.
function winBar(m) {
  const p = m.me.winProbability;
  const bar = el("div", "win-bar");
  bar.title = "Win probability";
  bar.append(el("span", "win-pct me", percent(p)));
  const track = el("div", "win-track");
  const fill = el("div", `win-fill ${p >= 0.5 ? "favored" : "underdog"}`);
  fill.style.width = `${p * 100}%`;
  track.append(fill);
  bar.append(track, el("span", "win-pct opp", percent(1 - p)));
  return bar;
}

// The day's win probability as a line: above the dashed midline (green) I'm favored, below it (red) I'm not.
// Inline SVG, so it scales with the card and takes its colors from the CSS variables like everything else.
const SVG_NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs) {
  // SVG elements need createElementNS: createElement("polyline") would make an unknown *HTML* element.
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function winTrend(m) {
  const saved = winHistory[m.platform];
  const points = saved?.week === m.week ? saved.points : [];
  if (points.length < 2) return undefined;
  // x is time from the first point to the latest, y is 0–100% (top = 100%). preserveAspectRatio="none" stretches
  // this 100×28 box to the card's size; vector-effect keeps the line's width from stretching with it.
  const W = 100;
  const H = 28;
  const t0 = points[0].t;
  const span = points.at(-1).t - t0 || 1;
  const coords = points.map(
    ({ t, p }) => `${(((t - t0) / span) * W).toFixed(2)},${((1 - p) * H).toFixed(2)}`,
  );

  const chart = svg("svg", {
    class: "win-trend",
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `Win probability this week: ${percent(points[0].p)} at first, ${percent(points.at(-1).p)} now`,
  });
  // The same line twice, each clipped to one half, so the color switches exactly where it crosses 50%.
  const id = `trend-${m.platform}`;
  const defs = svg("defs", {});
  for (const [half, y] of [
    ["above", 0],
    ["below", H / 2],
  ]) {
    const clip = svg("clipPath", { id: `${id}-${half}` });
    clip.append(svg("rect", { x: 0, y, width: W, height: H / 2 }));
    defs.append(clip);
  }
  chart.append(defs, svg("line", { class: "win-trend-mid", x1: 0, y1: H / 2, x2: W, y2: H / 2 }));
  for (const [half, className] of [
    ["above", "favored"],
    ["below", "underdog"],
  ]) {
    chart.append(
      svg("polyline", {
        class: className,
        points: coords.join(" "),
        "clip-path": `url(#${id}-${half})`,
        "vector-effect": "non-scaling-stroke",
      }),
    );
  }
  return chart;
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
  cell.dataset.player = p.name; // flashScores() and the details sheet find the player by this
  // Focusable and announced as a button, so the details sheet opens from the keyboard too.
  cell.tabIndex = 0;
  cell.setAttribute("role", "button");
  cell.setAttribute("aria-haspopup", "dialog");
  const game = gameLines(p);
  cell.title = [
    p.name,
    p.injury && INJURY_LABEL[p.injury],
    ...game.map((g) => g.text),
    p.statLine,
    STATUS_LABEL[p.status],
  ]
    .filter(Boolean)
    .join(" · ");
  if (p.status === "live") {
    cell.classList.add("active");
    if (p.game?.hasBall) cell.classList.add("offense");
    if (p.game?.redZone) cell.classList.add("red-zone");
  }
  cell.append(el("span", "pos muted", p.position));
  const name = el("span", "player-name");
  name.append(el("span", "name-text", shortName(p)));
  // Q and day-to-day are a heads-up; the rest mean they probably won't play.
  if (p.injury)
    name.append(el("span", `injury ${["Q", "DTD"].includes(p.injury) ? "maybe" : "out"}`, p.injury));
  cell.append(name);
  const pts = el("span", "pts");
  pts.append(el("span", "pts-actual", fmt(p.points, 1)));
  if (p.projected !== undefined) pts.append(el("span", "pts-proj muted", fmt(p.projected, 1)));
  cell.append(pts);
  // Game lines first, then the box score. The server joins passing/rushing/receiving with " · "; one
  // line each, so a narrow screen breaks between them rather than in the middle of "312 YD".
  const lines = [
    ...game.map((g) => el("span", `stat-group ${g.className}`, g.text)),
    ...(p.statLine?.split(" · ") ?? []).map((group) => el("span", "stat-group", group)),
  ];
  if (lines.length) {
    const stats = el("span", "stat-line muted");
    stats.append(...lines);
    cell.append(stats);
  }
  return cell;
}

const kickoffFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

// Before kickoff: "Mon 8:15 PM · ESPN" (in the viewer's time zone). During the game: "BUF 20–13 LAC · 4:12 3rd",
// plus the down and distance when the player's team has the ball. Nothing once it's over; the points say it all.
function gameLines(p) {
  const g = p.game;
  if (!g) return [];
  if (p.status === "pre" && g.kickoff) {
    const when = kickoffFormat.format(new Date(g.kickoff));
    return [{ text: [when, g.broadcast].filter(Boolean).join(" · "), className: "game-line" }];
  }
  if (p.status !== "live" || !g.score) return [];
  const lines = [{ text: [g.score, g.clock].filter(Boolean).join(" · "), className: "game-line" }];
  if (g.hasBall && g.situation) {
    lines.push({
      text: g.redZone ? `Red zone · ${g.situation}` : `Ball · ${g.situation}`,
      className: g.redZone ? "game-line red-zone-line" : "game-line offense-line",
    });
  }
  return lines;
}

// My players on the left, the opponent's mirrored on the right, so points sit next to each other.
function playerRows(mine, theirs, className) {
  const rows = el("div", `player-rows ${className}`);
  for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
    rows.append(playerCell(mine[i], "me"), playerCell(theirs[i], "opp"));
  }
  return rows;
}

// "Set your lineup" warnings for my team: an empty slot, a starter on a bye or ruled out.
function alertsBox(alerts) {
  const box = el("div", "alerts");
  box.setAttribute("role", "status");
  box.append(el("div", "alerts-title", "⚠ Lineup"));
  const list = el("ul");
  list.append(...alerts.map((a) => el("li", undefined, a)));
  box.append(list);
  return box;
}

function playersSection(m) {
  const section = el("div", "players");
  // Which column is whose: the rosters mirror each other, so this isn't obvious at a glance.
  const head = el("div", "roster-head section-label muted");
  head.append(el("span", "me", "Your starters"), el("span", "opp", m.opponent.name));
  head.lastChild.title = m.opponent.name;
  section.append(head);
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
  node.dataset.platform = m.platform; // which league a tapped player belongs to, when all cards are showing

  const head = el("div", "card-head");
  head.append(el("span", "platform", m.platform.toUpperCase()));
  head.append(el("span", "league", m.leagueName));
  head.append(el("span", `status ${m.status}`, m.status === "live" ? "LIVE" : m.status.toUpperCase()));
  node.append(head);

  if (m.error) {
    node.append(errorBox(m));
    return node;
  }

  node.classList.add(outcome(m));

  const body = el("div", "card-body");
  const vs = el("div", "vs muted", "vs");
  const arrow = trend(m);
  if (arrow) vs.prepend(arrow);
  body.append(teamBlock(m.me, "me"), vs, teamBlock(m.opponent, "opp"));
  node.append(body);

  if (m.me.winProbability !== undefined && m.status !== "final") {
    // One group, so the trend line sits tight under the bar while the card spaces the sections apart.
    const win = el("div", "win");
    win.append(winBar(m));
    const trend = winTrend(m);
    if (trend) win.append(trend);
    node.append(win);
  }

  if (hasAlerts(m)) node.append(alertsBox(m.me.alerts));
  if (m.me.starters?.length || m.opponent.starters?.length) node.append(playersSection(m));

  // The header says when the data was fetched, so the card only needs the week.
  node.append(el("div", "card-foot muted", `Week ${m.week}`));
  return node;
}

// The server's messages already say how to fix the problem ("run `npm run yahoo:auth`"); show `backticked`
// parts as code, and offer a retry for the transient failures.
function errorBox(m) {
  const box = el("div", "error");
  box.append(el("div", "error-title", `Couldn't load ${m.leagueName}`));
  const message = el("div", "error-message");
  // split() with a capture group keeps the separators' contents: odd indexes are the backticked parts.
  m.error.split(/`([^`]+)`/).forEach((part, i) => message.append(i % 2 ? el("code", undefined, part) : part));
  box.append(message);
  const retry = el("button", "retry", "Retry");
  retry.type = "button";
  retry.addEventListener("click", () => refresh());
  box.append(retry);
  return box;
}

function hasAlerts(m) {
  return !m.error && m.status !== "final" && m.me.alerts?.length > 0;
}

function outcome(m) {
  const diff = m.me.points - m.opponent.points;
  return diff > 0 ? "winning" : diff < 0 ? "losing" : "tied";
}

// ▲ or ▼, so winning and losing don't rest on red vs green alone (hard to tell apart for about 1 in 12 men).
// The arrow itself is aria-hidden; screen readers get the word instead. Nothing when tied.
function trend(m) {
  const state = outcome(m);
  if (state === "tied") return undefined;
  const wrap = el("span", `trend ${state}`);
  const arrow = el("span", undefined, state === "winning" ? "▲" : "▼");
  arrow.setAttribute("aria-hidden", "true");
  wrap.append(arrow, el("span", "sr-only", state));
  return wrap;
}

// One league per platform (the server caches by platform too), so the platform name is the tab's ID.
// It lives in the URL hash, so a refresh or a bookmark like /#espn opens the same tab.
function selectedPlatform() {
  const wanted = location.hash.slice(1);
  return matchups.some((m) => m.platform === wanted) ? wanted : matchups[0]?.platform;
}

// `slide` is "left" or "right": which way the new card slides in after a swipe.
function selectTab(platform, { focus = false, slide } = {}) {
  // replaceState changes the hash without adding a history entry for every tab click, and without
  // firing "hashchange", so render() is called directly below.
  history.replaceState(null, "", `#${platform}`);
  render();
  if (focus) document.getElementById(`tab-${platform}`)?.focus();
  if (slide) container.firstElementChild?.classList.add(`slide-${slide}`);
}

// The tab `step` places away from the selected one (+1 = next), or undefined past either end.
function neighbour(step, { wrap }) {
  const i = matchups.findIndex((m) => m.platform === selectedPlatform());
  const j = wrap ? (i + step + matchups.length) % matchups.length : i + step;
  return matchups[j];
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
  if (m.status === "live") {
    const dot = el("span", "tab-live", "●");
    dot.setAttribute("aria-hidden", "true");
    button.append(dot, el("span", "sr-only", "live"));
  }
  if (hasAlerts(m)) button.append(el("span", "tab-alert", "⚠"));
  const score = el("span", "tab-score", m.error ? "error" : `${fmt(m.me.points)}–${fmt(m.opponent.points)}`);
  const arrow = !m.error && trend(m);
  if (arrow) score.prepend(arrow, " ");
  // The tab shows both scores; flash in the direction of mine if it moved, else the opponent's.
  const moved = flashes.get(teamKey(m.platform, "me")) ?? flashes.get(teamKey(m.platform, "opp"));
  if (moved) score.classList.add(`flash-${moved}`);
  button.append(score);
  button.title = m.leagueName;
  return button;
}

// Wide enough for every league's card side by side (about 450px each); below this, tabs show one at a time.
// matchMedia is the JS side of a CSS media query, so the breakpoint lives in one place (styles.css has the
// same number for the layout).
const sideBySide = window.matchMedia("(min-width: 1280px)");

function render() {
  const all = sideBySide.matches;
  const current = selectedPlatform();
  tabBar.replaceChildren(...matchups.map((m) => tab(m, m.platform === current)));
  tabBar.hidden = all || matchups.length < 2; // nothing to switch between, or everything is already visible
  // Tabs and a tabpanel only make sense together; side by side, <main> is a plain container.
  if (all) {
    container.removeAttribute("role");
    container.removeAttribute("aria-labelledby");
  } else {
    container.setAttribute("role", "tabpanel");
    container.setAttribute("aria-labelledby", `tab-${current}`);
  }
  container.classList.toggle("side-by-side", all);
  const shown = all ? matchups : matchups.filter((m) => m.platform === current);
  const cards = shown.map((m) => card(m));
  container.replaceChildren(...cards);
  shown.forEach((m, i) => flashScores(cards[i], m.platform));
  // An open sheet follows the new data: points and game state update while you're looking at it.
  if (sheet.open) renderSheet();
}

// Briefly colors each score on the card that changed since the last poll: green up, red down.
function flashScores(cardNode, platform) {
  const flash = (node, direction) => direction && node?.classList.add(`flash-${direction}`);
  for (const side of ["me", "opp"]) {
    flash(cardNode.querySelector(`.team.${side} .points`), flashes.get(teamKey(platform, side)));
  }
  for (const cell of cardNode.querySelectorAll("[data-player]")) {
    const side = cell.classList.contains("me") ? "me" : "opp";
    flash(cell.querySelector(".pts-actual"), flashes.get(playerKey(platform, side, cell.dataset.player)));
  }
}

// --- Player details sheet ---------------------------------------------------------------------------------

// Which player the sheet shows. Kept as a lookup rather than the player object, so each poll's new data is
// found again by renderSheet().
let sheetPlayer;

function findPlayer({ platform, side, name }) {
  const m = matchups.find((x) => x.platform === platform && !x.error);
  const team = m && (side === "me" ? m.me : m.opponent);
  if (!team) return undefined;
  const starter = team.starters?.find((p) => p.name === name);
  const benched = starter ? undefined : team.bench?.find((p) => p.name === name);
  const p = starter ?? benched;
  return p && { p, team, bench: Boolean(benched) };
}

function renderSheet() {
  const found = sheetPlayer && findPlayer(sheetPlayer);
  if (!found) {
    sheet.close(); // dropped from the roster, or the league errored since it was opened
    return;
  }
  const { p, team, bench } = found;
  const nodes = [el("h2", "sheet-title", p.name)];
  nodes[0].id = "sheet-title";
  nodes.push(
    el("div", "sheet-sub muted", [p.position, team.name, bench && "bench"].filter(Boolean).join(" · ")),
  );

  const points = el("div", "sheet-points");
  points.append(el("span", "sheet-pts", fmt(p.points)), el("span", "muted", " pts"));
  if (p.projected !== undefined) points.append(el("span", "muted", ` · proj ${fmt(p.projected)}`));
  points.append(el("span", `sheet-status ${p.status}`, STATUS_LABEL[p.status]));
  nodes.push(points);

  if (p.injury) {
    const severity = ["Q", "DTD"].includes(p.injury) ? "maybe" : "out";
    nodes.push(el("div", `sheet-injury injury ${severity}`, `${p.injury} · ${INJURY_LABEL[p.injury]}`));
  }
  const lines = [
    ...gameLines(p),
    ...(p.statLine?.split(" · ") ?? []).map((text) => ({ text, className: "" })),
  ];
  if (lines.length) {
    const list = el("ul", "sheet-lines");
    list.append(...lines.map((line) => el("li", line.className, line.text)));
    nodes.push(list);
  }
  sheetContent.replaceChildren(...nodes);
}

function openSheet(cell) {
  sheetPlayer = {
    platform: cell.closest(".card").dataset.platform,
    side: cell.classList.contains("me") ? "me" : "opp",
    name: cell.dataset.player,
  };
  renderSheet();
  // showModal() (not show()) makes the rest of the page inert, traps focus inside, closes on Esc, and adds the
  // ::backdrop. That's all the work a hand-made overlay would have to redo.
  if (!sheet.open) sheet.showModal();
}

// One listener on the container instead of one per player: render() rebuilds every cell on each poll, and
// clicks "bubble" up from the cell to here, where closest() finds which player was tapped. This is called
// event delegation.
container.addEventListener("click", (event) => {
  const cell = event.target.closest(".player[data-player]");
  if (cell) openSheet(cell);
});
container.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  // Only when the cell itself has focus, not a control inside the card such as the Retry button.
  if (!event.target.matches(".player[data-player]")) return;
  event.preventDefault(); // otherwise Space also scrolls the page
  openSheet(event.target);
});
// A click on the backdrop lands on the <dialog> element itself (its content is inside a padded child).
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) sheet.close();
});

// Resizing the window across the breakpoint switches between the two layouts.
sideBySide.addEventListener("change", render);

// Typing a new #hash, or Back/Forward, changes the tab without reloading the page.
window.addEventListener("hashchange", render);

tabBar.addEventListener("keydown", (event) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  const next = step && neighbour(step, { wrap: true });
  if (next) selectTab(next.platform, { focus: true });
});

// Swipe left for the next league, right for the previous one. Touch events rather than pointer
// events: with a mouse, a click-and-drag to select text shouldn't switch tabs.
const SWIPE_MIN_PX = 60;
let touchStart;
container.addEventListener(
  "touchstart",
  (event) => {
    // One finger only, so pinch-zooming doesn't count as a swipe.
    const t = event.touches.length === 1 ? event.touches[0] : undefined;
    touchStart = t && { x: t.clientX, y: t.clientY };
  },
  { passive: true }, // we never call preventDefault(), so the browser can start scrolling right away
);
container.addEventListener(
  "touchend",
  (event) => {
    if (!touchStart || sideBySide.matches) return; // nothing to swipe between when all cards are showing
    const t = event.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    touchStart = undefined;
    // Mostly sideways, so scrolling down the roster never flips the tab.
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return;
    const next = neighbour(dx < 0 ? 1 : -1, { wrap: false });
    if (next) selectTab(next.platform, { slide: dx < 0 ? "left" : "right" });
  },
  { passive: true },
);

let timer;
let lastFetch = 0;
let lastFailed = false;
let lastError = "";
let lastSuccess; // Date.now() of the last good response; undefined until the first one
let inFlight = false;

async function refresh() {
  // The refresh and Retry buttons can be pressed while a poll is running; one request at a time.
  if (inFlight) return;
  inFlight = true;
  refreshButton.classList.add("busy");
  clearTimeout(timer);
  lastFetch = Date.now();
  try {
    const res = await fetch("/api/matchups");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    flashes = scoreChanges(matchups, next);
    matchups = next;
    winHistory = addPoints(winHistory, next, Date.now());
    saveHistory();
    render();
    flashes = new Map();
    lastFailed = false;
    lastSuccess = Date.now();
    container.removeAttribute("aria-busy");
  } catch (err) {
    lastFailed = true;
    lastError = err.message;
  } finally {
    // finally runs on both paths, so the button can't get stuck spinning.
    inFlight = false;
    refreshButton.classList.remove("busy");
  }
  // Keep showing the last good data after a failure, dimmed, rather than blanking the page.
  container.classList.toggle("stale", lastFailed && lastSuccess !== undefined);
  showFreshness();
  schedule();
}

refreshButton.addEventListener("click", () => refresh());

// "12s ago", "3 min ago"; past an hour, the clock time reads better.
function ago(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `at ${new Date(Date.now() - ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function showFreshness() {
  const since = lastSuccess === undefined ? undefined : ago(Date.now() - lastSuccess);
  if (!lastFailed) lastUpdated.textContent = since ? `Updated ${since}` : "Loading…";
  else if (since) lastUpdated.textContent = `Retrying · data from ${since}`;
  else lastUpdated.textContent = "Can't reach the server · retrying";
  lastUpdated.classList.toggle("stale", lastFailed);
  // The technical detail is still there for whoever wants it.
  lastUpdated.title = lastFailed ? `Couldn't update: ${lastError}` : "";
}

// Ticks the "12s ago" text once a second. It only rewrites one text node, not the cards, so it's cheap.
// Stopped while the tab is hidden (see "visibilitychange"), like the polling.
let ticker;
function startTicker() {
  clearInterval(ticker);
  ticker = setInterval(showFreshness, 1000);
}

// How long until the next refresh: 30s if any player's game is under way, otherwise until the next
// kickoff (at most 5 minutes, at least 30s). The game data drives it, so there's no calendar of game
// windows to keep up to date: a Saturday game in December just works.
function nextDelay() {
  if (lastFailed) return RETRY_MS;
  const players = matchups.flatMap((m) =>
    m.error ? [] : [m.me, m.opponent].flatMap((t) => [...(t.starters ?? []), ...(t.bench ?? [])]),
  );
  if (players.some((p) => p.status === "live")) return LIVE_POLL_MS;
  const kickoffs = players
    .filter((p) => p.status === "pre" && p.game?.kickoff)
    .map((p) => new Date(p.game.kickoff).getTime() - Date.now());
  // Past kickoff but not shown as started yet (a delay, or the feed catching up): check often.
  if (kickoffs.some((ms) => ms <= 0)) return LIVE_POLL_MS;
  const untilKickoff = Math.min(...kickoffs, IDLE_POLL_MS);
  return Math.max(untilKickoff, LIVE_POLL_MS);
}

function schedule() {
  clearTimeout(timer);
  // A hidden tab (another tab in front, phone locked) doesn't poll; "visibilitychange" picks it back up.
  if (!document.hidden) timer = setTimeout(refresh, nextDelay());
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(timer);
    clearInterval(ticker);
    return;
  }
  showFreshness();
  startTicker();
  // Back in view: refresh now if the data has gone stale, otherwise just resume the schedule.
  if (Date.now() - lastFetch >= nextDelay()) refresh();
  else schedule();
});

startTicker();
refresh();
