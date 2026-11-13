// Live college-football data (ESPN public API) -> rival speed modifiers.
import { ROSTER, WISCONSIN_ID } from './teams.js';
import { shuffle } from './util.js';

const API = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';

export const emptySeason = () => ({ ok: false, poll: null, ranks: new Map(), beaten: new Set() });

/** Parse the /rankings payload into Map(teamId -> rank). Prefers the AP poll. */
export function parseRankings(json) {
  const polls = json?.rankings ?? [];
  const poll = polls.find((p) => /AP/i.test(p.name)) ?? polls[0];
  const ranks = new Map();
  for (const r of poll?.ranks ?? []) {
    if (r.current >= 1 && r.current <= 25) ranks.set(String(r.team.id), r.current);
  }
  return { poll: poll?.name ?? null, ranks };
}

/** Parse Wisconsin's schedule into the set of team ids Wisconsin has beaten. */
export function parseBeaten(json) {
  const beaten = new Set();
  for (const e of json?.events ?? []) {
    const c = e.competitions?.[0];
    if (!c?.status?.type?.completed) continue;
    const uw = c.competitors.find((k) => String(k.team.id) === WISCONSIN_ID);
    const opp = c.competitors.find((k) => String(k.team.id) !== WISCONSIN_ID);
    if (uw?.winner === true && opp) beaten.add(String(opp.team.id));
  }
  return beaten;
}

/** Fetch both feeds. Never throws: on failure returns an empty season (no modifiers). */
export async function fetchSeasonData(timeoutMs = 5000) {
  const get = async (path) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${API}/${path}`, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const [rk, sched] = await Promise.all([get('rankings'), get(`teams/${WISCONSIN_ID}/schedule`)]);
    return { ok: true, ...parseRankings(rk), beaten: parseBeaten(sched) };
  } catch (err) {
    console.warn('Live rankings unavailable, racing without modifiers:', err);
    return emptySeason();
  }
}

/**
 * Speed multiplier for a rival.
 *  - Top 25: +4.0% (#1) sliding to +1.6% (#25)
 *  - Lost to Wisconsin this season: -2.5%
 *  - A ranked team that lost to Wisconsin always keeps at least +0.5%
 *  - Hot streak (random pick each race): +2%
 */
export function computeMods(team, season, hot = false) {
  const badges = [];
  let mult = 1;
  const rank = season.ranks.get(team.id);
  if (rank) {
    const bonus = 0.016 + (0.024 * (25 - rank)) / 24;
    mult += bonus;
    badges.push({ kind: 'rank', text: `#${rank} · +${(bonus * 100).toFixed(1)}%` });
  }
  if (season.beaten.has(team.id)) {
    mult -= 0.025;
    if (rank) mult = Math.max(mult, 1.005);
    badges.push({ kind: 'beaten', text: 'Lost to UW · slower' });
  }
  if (hot) {
    mult += 0.02;
    badges.push({ kind: 'hot', text: '🔥 Hot streak · +2%' });
  }
  return { mult, badges, rank: rank ?? null };
}

/** Pick `n` rivals: a couple of ranked teams, one team UW beat, the rest random. */
export function pickField(n, season) {
  const pool = shuffle(ROSTER);
  const picked = [];
  const take = (pred, count) => {
    for (const t of pool) {
      if (count <= 0 || picked.length >= n) break;
      if (!picked.includes(t) && pred(t)) {
        picked.push(t);
        count--;
      }
    }
  };
  take((t) => season.ranks.has(t.id), 2);
  take((t) => season.beaten.has(t.id), 1);
  take(() => true, n);
  const hotCount = Math.max(1, Math.round(n / 3));
  const hot = new Set(shuffle(picked).slice(0, hotCount));
  return shuffle(picked).map((team) => ({ team, ...computeMods(team, season, hot.has(team)) }));
}
