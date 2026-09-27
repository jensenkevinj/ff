const POLL_MS = 30_000;

const container = document.getElementById("matchups");
const lastUpdated = document.getElementById("last-updated");

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
  block.append(el("div", "team-name", team.name));
  if (team.owner) block.append(el("div", "owner muted", team.owner));
  block.append(el("div", "points", fmt(team.points)));
  const meta = [];
  if (team.projected !== undefined) meta.push(`proj ${fmt(team.projected)}`);
  if (team.playersRemaining !== undefined) meta.push(`${team.playersRemaining} left`);
  if (meta.length) block.append(el("div", "meta muted", meta.join(" · ")));
  return block;
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
