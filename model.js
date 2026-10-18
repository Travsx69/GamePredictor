// Pure prediction logic: no DOM, no fetch. Loaded by index.html, tested by model.test.js.

const LEAGUES = {
  // unit/marginScale: what a scoring margin is counted in, and a typical team-average margin in those units.
  // MLB Infinity = margin factor off: run margin only added noise in the 2026 backtest.
  nfl: { name: 'NFL', path: 'football/nfl', unit: 'point', marginScale: 10, homeEdge: 0.1, pos: { QB: 6, K: 0.3, P: 0.3, LS: 0.2 } },
  nba: { name: 'NBA', path: 'basketball/nba', unit: 'point', marginScale: 10, homeEdge: 0.25, pos: {} },
  mlb: { name: 'MLB', path: 'baseball/mlb', unit: 'run', marginScale: Infinity, homeEdge: 0.08, pos: { SP: 2, RP: 0.5 } },
  epl: { name: 'Premier League', path: 'soccer/eng.1', unit: 'goal', marginScale: 1, homeEdge: 0.25, pos: {}, soccer: true },
  laliga: { name: 'La Liga', path: 'soccer/esp.1', unit: 'goal', marginScale: 1, homeEdge: 0.6, pos: {}, soccer: true },
  mls: { name: 'MLS', path: 'soccer/usa.1', unit: 'goal', marginScale: 1, homeEdge: 0.3, pos: {}, soccer: true },
  ucl: { name: 'Champions League', path: 'soccer/uefa.champions', unit: 'goal', marginScale: 1, homeEdge: 0.4, pos: {}, soccer: true },
  // Not ESPN (esport adapters in index.html): CS2 from Valve Regional Standings, Dota 2 from OpenDota; schedule via PandaScore
  cs2: { name: 'Counter-Strike 2', path: 'esports/cs2', esport: 'cs2', homeEdge: 0, pos: {} },
  dota2: { name: 'Dota 2', path: 'esports/dota2', esport: 'dota2', homeEdge: 0, pos: {} },
};

// Unknown statuses (e.g. NFL "Active") count 0. Season-long absences are low: the record already reflects them.
const STATUS_WEIGHT = {
  Out: 1, Doubtful: 0.75, Questionable: 0.4, 'Day-To-Day': 0.3, Suspension: 1, suspension: 1,
  '7-Day IL': 1, '10-Day-IL': 1, '15-Day-IL': 1, '60-Day-IL': 0.3, 'Injured Reserve': 0.3,
};
const injuryWeight = (i, league) => (STATUS_WEIGHT[i.status] || 0) * (league.pos[i.pos] ?? 1);
// Tunable weights (logit scale). backtest.js grid-searches them (see CLAUDE.md for the last results).
// prior / marginPrior: shrink small samples with this many phantom average games. ponytail: a real Elo rating would beat this
const WEIGHTS = { record: 4, split: 1, form: 0.25, prior: 45, margin: 0.2, marginPrior: 5, rest: 0.1, market: 0.9 };
const REST_CAP = 3; // days; beyond this extra rest is treated as equal (mainly catches NBA/MLB back-to-backs)

// "4-1" / "4-1-1" (W-L-T) or soccer "1-1-4" (W-D-L) -> strength 0..1, shrunk toward .5
function recordPct(summary, soccer) {
  const n = String(summary || '').split('-').map(Number);
  if (n.length < 2 || n.some(isNaN)) return 0.5;
  const [w, a, b = 0] = n;
  const games = w + a + b;
  const score = soccer ? w + a / 3 : w + b / 2; // soccer: points/3 per game; else ties count half
  return (score + WEIGHTS.prior / 2) / (games + WEIGHTS.prior);
}

// "WDLLW" -> points share of last games (soccer form string)
function formPct(form) {
  if (!form) return 0.5;
  const pts = [...form].reduce((s, c) => s + (c === 'W' ? 3 : c === 'D' ? 1 : 0), 0);
  return pts / (form.length * 3);
}

// Team results [{ date, pf, pa, res: 'W'|'D'|'L' }] -> form going into `date`, or null before a team's first game
function trend(results, date) {
  const past = results.filter((r) => r.date < date).sort((a, b) => a.date.localeCompare(b.date));
  if (!past.length) return null;
  return {
    games: past.length,
    margin: past.reduce((s, r) => s + r.pf - r.pa, 0) / past.length,
    form: past.slice(-5).map((r) => r.res).join(''),
    rest: Math.round((Date.parse(date) - Date.parse(past.at(-1).date)) / 864e5),
  };
}

// American odds -> implied probability
function impliedProb(ml) {
  const n = Number(String(ml).replace('+', ''));
  if (!n || isNaN(n)) return null;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

// Bet on a side with win probability pWin at American odds ml: break-even win rate and expected profit per 1 staked
function betCheck(pWin, ml) {
  const n = Number(String(ml).replace('+', ''));
  if (!n || isNaN(n)) return null;
  const payout = n > 0 ? n / 100 : 100 / -n; // profit on a winning 1-unit bet
  return { breakEven: 1 / (1 + payout), ev: pWin * payout - (1 - pWin) };
}

function injuryLoad(injuries, league) {
  return injuries.reduce((s, i) => s + injuryWeight(i, league), 0);
}

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// game: { home, away, odds } where team = { abbr, record, homeRecord, roadRecord, form, trend (from trend()), injuries:[{name,pos,status,type}], ml }
// Returns { pHome, drawP, factors:[{key, value (+ favors home), home, away}] }
function predict(game, league) {
  const { home: h, away: a } = game;
  const f = [];
  const add = (key, value, home, away) => f.push({ key, value, home, away });

  const rH = recordPct(h.record, league.soccer), rA = recordPct(a.record, league.soccer);
  add('record', (rH - rA) * WEIGHTS.record, h.record, a.record);

  if (h.homeRecord && a.roadRecord && !game.neutral) {
    const s = recordPct(h.homeRecord, league.soccer) - recordPct(a.roadRecord, league.soccer);
    add('split', s * WEIGHTS.split, h.homeRecord, a.roadRecord);
  }
  if (h.trend && a.trend) {
    const m = (t) => (t.margin * t.games) / (t.games + WEIGHTS.marginPrior) / league.marginScale;
    add('margin', (m(h.trend) - m(a.trend)) * WEIGHTS.margin, h.trend.margin, a.trend.margin);
    const r = (t) => Math.min(t.rest, REST_CAP);
    add('rest', (r(h.trend) - r(a.trend)) * WEIGHTS.rest, h.trend.rest, a.trend.rest);
  }
  if (h.form && a.form) add('form', (formPct(h.form) - formPct(a.form)) * WEIGHTS.form, h.form, a.form);

  if (!game.neutral) add('home', league.homeEdge, '', '');

  if (game.injuriesKnown) {
    const iH = injuryLoad(h.injuries, league), iA = injuryLoad(a.injuries, league);
    add('injuries', Math.max(-1, Math.min(1, (iA - iH) * 0.06)), iH, iA);
  }

  const modelLogit = f.reduce((s, x) => s + x.value, 0);
  let pHome = sigmoid(modelLogit);

  let drawP = null;
  const pmH = impliedProb(h.ml), pmA = impliedProb(a.ml);
  if (pmH && pmA) {
    const pmD = impliedProb(game.drawMl) || 0;
    const total = pmH + pmA + pmD; // strip the bookmaker's margin
    if (pmD) drawP = pmD / total;
    const market = logit(pmH / (pmH + pmA));
    add('market', market, h.ml, a.ml);
    pHome = sigmoid((1 - WEIGHTS.market) * modelLogit + WEIGHTS.market * market);
  }
  return { pHome, drawP, factors: f };
}

// --- Counter-Strike 2 (Valve Regional Standings, github.com/ValveSoftware/counter-strike_regional_standings) ---
// Win chance uses Valve's own formula: Glicko with fixed RD 75, i.e. Elo on VRS points.
// ponytail: Valve's readme says it's overconfident at the extremes; no CS2 odds/results history here to rescale it.
const VRS_G = 1 / Math.sqrt(1 + (3 * (Math.LN10 / 400) ** 2 * 75 ** 2) / Math.PI ** 2);
const vrsWinProb = (pointsA, pointsB) => sigmoid((Math.LN10 * VRS_G * (pointsA - pointsB)) / 400);

// Global standings markdown -> [{ rank, points, name, roster, details (path relative to the file) }]
function vrsParseStandings(md) {
  const row = /^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*\[details\]\(([^)]+)\)/;
  return md.split('\n').map((l) => l.match(row)).filter(Boolean)
    .map(([, rank, points, name, roster, details]) => ({ rank: +rank, points: +points, name, roster, details }));
}

// Team details markdown -> Valve's factor scores (0..1) and matches [{ date, opponent, res }], newest first
function vrsParseDetails(md) {
  const factor = (label) => Number(md.match(new RegExp(`^- ${label}: ([0-9.]+)`, 'm'))?.[1] ?? NaN);
  const row = /^\|\s*\d+\s*\|\s*\d+\s*\|\s*(\d{4}-\d\d-\d\d)\s*\|\s*([^|]+?)\s*\|\s*([WL])\s*\|/;
  const matches = md.split('\n').map((l) => l.match(row)).filter(Boolean).map(([, date, opponent, res]) => ({ date, opponent, res }));
  return { bounty: factor('Bounty Offered'), beaten: factor('Bounty Collected'), network: factor('Opponent Network'), lan: factor('LAN Wins'), matches };
}

// game.home/away carry { points, rank }. Same return shape as predict(); no draws, no home side.
function predictCs2(game) {
  const { home: h, away: a } = game;
  const pHome = vrsWinProb(h.points, a.points);
  return { pHome, drawP: null, factors: [{ key: 'vrs', value: logit(pHome), home: h.points, away: a.points }] };
}

// --- Dota 2 (OpenDota, api.opendota.com) ---
// OpenDota team ratings are Elo: standard 400-point formula. ponytail: not backtested; OpenDota only exposes current ratings
function predictElo(game) {
  const pHome = 1 / (1 + 10 ** ((game.away.rating - game.home.rating) / 400));
  return { pHome, drawP: null, factors: [{ key: 'elo', value: logit(pHome), home: game.home.rating, away: game.away.rating }] };
}

// OpenDota /teams/{id}/matches -> [{ date, opponentId, opponent, res, kills (own minus opponent's) }], newest first
function dotaResults(matches) {
  return matches.map((m) => {
    const own = m.radiant ? m.radiant_score : m.dire_score, opp = m.radiant ? m.dire_score : m.radiant_score;
    return { date: new Date(m.start_time * 1000).toISOString(), opponentId: m.opposing_team_id, opponent: m.opposing_team_name,
      res: m.radiant === m.radiant_win ? 'W' : 'L', kills: own - opp };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

// ESPN scoreboard event -> game object for predict(). Shared by index.html and backtest.js.
function toGame(e, injByTeam, injuriesKnown) {
  const c = e.competitions[0];
  const o = c.odds?.[0] || {};
  const team = (side) => {
    const t = c.competitors.find((x) => x.homeAway === side);
    const rec = (type) => t.records?.find((r) => r.type === type)?.summary;
    return {
      id: t.team.id, abbr: t.team.abbreviation, name: t.team.displayName, logo: t.team.logo, score: t.score, winner: t.winner,
      record: rec('total'), homeRecord: rec('home'), roadRecord: rec('road'), form: t.form,
      injuries: injByTeam[t.team.id] || [],
      ml: o.moneyline?.[side]?.close?.odds ?? o[side + 'TeamOdds']?.moneyLine,
      leaders: leadersOf(t),
      pitcher: pitcherOf(t),
      seriesWins: c.series?.competitors?.find((s) => s.id === t.team.id)?.wins,
    };
  };
  return {
    home: team('home'), away: team('away'), drawMl: o.drawOdds?.moneyLine, injuriesKnown, line: o.details,
    state: c.status.type, neutral: c.neutralSite, venue: c.venue?.fullName, note: c.notes?.[0]?.headline,
  };
}

const LEADER_LABEL = { passingLeader: 'passer', rushingLeader: 'rusher', receivingLeader: 'receiver', goals: 'scorer' };
function leadersOf(t) {
  return (t.leaders || []).filter((l) => LEADER_LABEL[l.name]).map((l) => ({
    label: LEADER_LABEL[l.name], name: l.leaders?.[0]?.athlete?.displayName, value: l.leaders?.[0]?.value,
    stat: l.name === 'goals' ? l.leaders?.[0]?.displayValue + ' goals' : l.leaders?.[0]?.displayValue,
  })).filter((l) => l.name);
}
function pitcherOf(t) {
  const p = t.probables?.[0];
  if (!p) return null;
  const s = (abbr) => p.statistics?.find((x) => x.abbreviation === abbr)?.displayValue;
  return { name: p.athlete?.displayName, era: s('ERA'), w: s('W'), l: s('L') };
}

if (typeof module !== 'undefined') module.exports = { LEAGUES, WEIGHTS, toGame, trend, betCheck, vrsWinProb, vrsParseStandings, vrsParseDetails, predictCs2, predictElo, dotaResults, recordPct, formPct, impliedProb, injuryLoad, injuryWeight, predict };
