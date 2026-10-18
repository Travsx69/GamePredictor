// Replays completed games through predict() and reports the track record.
// Run: node backtest.js [league ...] [--tune] [--refresh]   (default: all leagues in SEASONS)
// Writes backtest-results.js (scorecard loaded by index.html). Fetched games are cached in the OS temp dir.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LEAGUES, WEIGHTS, toGame, trend, predict, impliedProb, betCheck } = require('./model.js');

const API = 'https://site.api.espn.com/apis/site/v2/sports/';
const CORE = 'https://sports.core.api.espn.com/v2/sports/';
// Last completed regular season per league (inclusive date range, label shown on the page).
const SEASONS = {
  nfl: ['2025-09-04', '2026-01-04', '2025 season'],
  nba: ['2025-10-21', '2026-04-12', '2025-26 season'],
  mlb: ['2026-03-25', '2026-09-27', '2026 season'],
  epl: ['2025-08-15', '2026-05-24', '2025-26 season'],
  laliga: ['2025-08-15', '2026-05-24', '2025-26 season'],
  mls: ['2026-02-21', '2026-10-18', '2026 season to date'],
  ucl: ['2025-09-16', '2026-01-28', '2025-26 league phase'],
};

const args = process.argv.slice(2);
const refresh = args.includes('--refresh'), tune = args.includes('--tune');
const keys = args.filter((a) => !a.startsWith('--'));
const leagues = keys.length ? keys : Object.keys(SEASONS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) throw Object.assign(new Error(r.status + ' ' + url), { fatal: true });
    } catch (e) { if (e.fatal || i >= 5) throw e; }
    await sleep(1000 * i);
  }
}
async function pool(items, n, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
  return out;
}
function days(from, to) {
  const out = [];
  for (const d = new Date(from); d <= new Date(to); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
  return out;
}

// Completed games as toGame() objects (post-game records, as ESPN serves them), with closing odds from the summary pickcenter.
async function fetchGames(key) {
  const file = path.join(os.tmpdir(), `gp-backtest-${key}.json`);
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const [from, to] = SEASONS[key], lp = LEAGUES[key].path;
  const boards = await pool(days(from, to), 8, (d) => getJSON(`${API}${lp}/scoreboard?dates=${d}`).then((b) => b.events || []));
  const seen = new Set();
  const events = boards.flat().filter((e) => e.competitions[0].status.type.completed && !/preseason|pre-season|post-season|postseason|playoff/i.test(e.season?.slug || '')
    && !seen.has(e.id) && seen.add(e.id));
  let done = 0;
  const games = await pool(events, 12, async (e) => {
    // Scoreboards drop odds after the game; the core API keeps them (summary pickcenter is empty for older games).
    const [sport, lg] = lp.split('/');
    const core = await getJSON(`${CORE}${sport}/leagues/${lg}/events/${e.id}/competitions/${e.id}/odds`).catch(() => ({}));
    const hasML = (o) => o?.homeTeamOdds?.moneyLine && o?.awayTeamOdds?.moneyLine;
    let odds = (core.items || []).find(hasML);
    if (!odds) odds = (await getJSON(`${API}${lp}/summary?event=${e.id}`).catch(() => ({}))).pickcenter?.find(hasML);
    if (odds) e.competitions[0].odds = [odds];
    if (++done % 200 === 0) console.error(`  ${key}: ${done}/${events.length} games`);
    const g = toGame(e, {}, false);
    for (const t of [g.home, g.away]) { delete t.leaders; delete t.pitcher; }
    return { id: e.id, date: e.date, g };
  });
  games.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(file, JSON.stringify(games));
  return games;
}

const resultOf = (t, o) => (t.winner ? 'W' : o.winner ? 'L' : 'D');

// What the page would have seen before kickoff. ESPN's historical records are post-game, and some dates carry
// end-of-season (NBA) or stale (MLS) records, so subtracting the game's own result isn't enough: rebuild
// total/home/road records and results history (margin, last-5 form, rest) from the season's results so far (fetch starts on opening day).
// ESPN's post-game record minus this result must equal ours; mismatches are counted as the leak check.
function pregame(games, league) {
  const seen = {}, check = { same: 0, diff: 0 };
  const fmt = ([w, d, l]) => (league.soccer ? `${w}-${d}-${l}` : d ? `${w}-${l}-${d}` : `${w}-${l}`);
  const cases = [];
  for (const { g, date } of games) {
    for (const [t, o, split] of [[g.home, g.away, 'home'], [g.away, g.home, 'road']]) {
      const s = (seen[t.id] ||= { total: [0, 0, 0], home: [0, 0, 0], road: [0, 0, 0], results: [] });
      const res = resultOf(t, o), k = 'WDL'.indexOf(res);
      const post = s.total.slice();
      post[k]++;
      check[t.record === fmt(post) ? 'same' : 'diff']++;
      const tr = trend(s.results, date);
      Object.assign(t, { record: fmt(s.total), homeRecord: fmt(s.home), roadRecord: fmt(s.road), trend: tr, form: tr?.form });
      s.total[k]++; s[split][k]++;
      s.results.push({ date, pf: Number(t.score), pa: Number(o.score), res });
    }
    cases.push({ g, homeWon: g.home.winner === true, draw: !g.home.winner && !g.away.winner });
  }
  return { cases, check };
}

function evaluate(cases, league) {
  const r = { games: cases.length, correct: 0, decisive: 0, decCorrect: 0, brier: 0, logloss: 0, odds: 0, oddsModel: 0, oddsBook: 0, bins: {} };
  // Flat 1-unit bets on the pick at the closing moneyline, by rule (expected value from our probability)
  const RULES = { 'every pick': () => true, 'EV > 0': (ev) => ev > 0, 'EV > 3%': (ev) => ev > 0.03 };
  r.bets = Object.fromEntries([...Object.keys(RULES), 'model-only EV > 3%'].map((k) => [k, { n: 0, won: 0, profit: 0 }]));
  const settle = (b, won, payout) => { b.n++; b.won += won; b.profit += won ? payout : -1; };
  for (const c of cases) {
    const g = { ...c.g, injuriesKnown: false };
    const { pHome: p, drawP } = predict(g, league);
    const pickHome = p >= 0.5;
    const ml = pickHome ? g.home.ml : g.away.ml;
    const bc = betCheck((pickHome ? p : 1 - p) * (1 - (drawP || 0)), ml);
    if (bc) {
      const won = !c.draw && pickHome === c.homeWon, payout = 1 / bc.breakEven - 1;
      for (const [k, rule] of Object.entries(RULES)) if (rule(bc.ev)) settle(r.bets[k], won, payout);
      // What a bettor following the model's own opinion would do: back whichever side it rates above the price
      const solo = predict(noOdds(c).g, league).pHome;
      for (const [home, pSide] of [[true, solo], [false, 1 - solo]]) {
        const b2 = betCheck(pSide * (1 - (drawP || 0)), home ? g.home.ml : g.away.ml);
        if (b2 && b2.ev > 0.03) settle(r.bets['model-only EV > 3%'], !c.draw && home === c.homeWon, 1 / b2.breakEven - 1);
      }
    }
    if (!c.draw && pickHome === c.homeWon) r.correct++;
    const mH = impliedProb(g.home.ml), mA = impliedProb(g.away.ml);
    if (mH && mA) {
      r.odds++;
      if (!c.draw && pickHome === c.homeWon) r.oddsModel++;
      if (!c.draw && (mH >= mA) === c.homeWon) r.oddsBook++;
    }
    if (c.draw) continue; // Brier/calibration on decisive games: P(home wins | not a draw)
    const y = c.homeWon ? 1 : 0;
    r.decisive++;
    if (pickHome === c.homeWon) r.decCorrect++;
    r.brier += (p - y) ** 2;
    r.logloss -= Math.log(Math.max(1e-9, y ? p : 1 - p));
    const e = Math.max(p, 1 - p), b = e < 0.55 ? '50-55' : e < 0.6 ? '55-60' : e < 0.7 ? '60-70' : e < 0.8 ? '70-80' : '80+';
    const bin = (r.bins[b] ||= { n: 0, pred: 0, won: 0 });
    bin.n++; bin.pred += e; bin.won += pickHome === c.homeWon;
  }
  r.brier /= r.decisive || 1;
  r.logloss /= r.decisive || 1;
  return r;
}

const pctS = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a');
function report(key, r, check, solo) {
  const l = LEAGUES[key];
  console.log(`\n== ${l.name} ${SEASONS[key][2]}: ${r.games} games (record leak check: ${check.same} consistent, ${check.diff} not)`);
  console.log(`  pick accuracy ${pctS(r.correct, r.games)}` + (l.soccer ? ` (draws count as misses; ${pctS(r.decCorrect, r.decisive)} of ${r.decisive} decisive games)` : ''));
  console.log(`  with odds: ${r.odds} games, model ${pctS(r.oddsModel, r.odds)} vs bookmaker favourite ${pctS(r.oddsBook, r.odds)}`);
  console.log(`  Brier ${r.brier.toFixed(4)} (coin flip 0.2500), log loss ${r.logloss.toFixed(4)}`);
  console.log(`  model alone (odds hidden): pick accuracy ${pctS(solo.correct, solo.games)}, Brier ${solo.brier.toFixed(4)}`);
  for (const [k, b] of Object.entries(r.bets)) {
    console.log(`  bet ${k.padEnd(10)} ${String(b.n).padStart(5)} bets, won ${pctS(b.won, b.n)}, ROI ${b.n ? ((100 * b.profit) / b.n).toFixed(1) + '%' : 'n/a'}`);
  }
  console.log('  confidence  games  predicted  actual');
  for (const b of ['50-55', '55-60', '60-70', '70-80', '80+']) {
    const x = r.bins[b];
    if (x) console.log(`  ${b.padEnd(10)}  ${String(x.n).padStart(5)}  ${pctS(x.pred, x.n).padStart(9)}  ${pctS(x.won, x.n).padStart(6)}`);
  }
}

const noOdds = (c) => ({ ...c, g: { ...c.g, home: { ...c.g.home, ml: null }, away: { ...c.g.away, ml: null } } });

// Grid search on log loss. Model weights are fit with odds stripped (they decide no-odds games and which argument
// leads), then the market blend weight on full games. Fit on even games, checked on odd (held-out) games.
function gridSearch(data) {
  const all = Object.keys(data);
  const loss = (keys, part, strip) => {
    let s = 0, n = 0;
    for (const k of keys) {
      const c = data[k].cases.filter((_, i) => i % 2 === part); // alternate games: both halves span the season
      const r = evaluate(strip ? c.map(noOdds) : c, LEAGUES[k]);
      s += r.logloss * r.decisive; n += r.decisive;
    }
    return s / n;
  };
  const fit = (label, keys, strip, grid, apply, current) => {
    const before = loss(keys, 1, strip);
    let best = current, bestL = loss(keys, 0, strip);
    for (const v of grid) { apply(v); const l = loss(keys, 0, strip); if (l < bestL - 1e-6) { bestL = l; best = v; } }
    apply(best);
    const after = loss(keys, 1, strip), keep = after < before; // only accept what the held-out half confirms
    if (!keep) apply(current);
    console.log(`  ${label}: ${JSON.stringify(best)}  held-out log loss ${before.toFixed(4)} -> ${after.toFixed(4)}`
      + (keep ? '' : `  (rejected, keeping ${JSON.stringify(current)})`));
  };
  console.log('\nTuning (fit on even games, held-out = odd games):');
  const pick = (...k) => Object.fromEntries(k.map((x) => [x, WEIGHTS[x]]));
  const set = (v) => Object.assign(WEIGHTS, v);
  // record and margin overlap (both measure team strength), so they're searched jointly
  const rm = [];
  for (const record of [0, 1, 2, 3, 4, 6]) for (const prior of [15, 30, 45, 60])
    for (const margin of [0, 0.1, 0.2, 0.25, 0.3, 0.5, 0.75]) for (const marginPrior of [5, 10, 20]) rm.push({ record, prior, margin, marginPrior });
  for (const pass of [1, 2]) { // two passes: each step is fit with the others already tuned
    fit('record x prior x margin x marginPrior, model only, pass ' + pass, all, true, rm, set, pick('record', 'prior', 'margin', 'marginPrior'));
    fit('form, model only, pass ' + pass, all, true, [0, 0.25, 0.5, 1, 1.5, 2].map((form) => ({ form })), set, pick('form'));
    fit('rest, model only, pass ' + pass, all, true, [0, 0.05, 0.1, 0.15, 0.2, 0.3].map((rest) => ({ rest })), set, pick('rest'));
  }
  for (const k of all) fit(`${k} homeEdge, model only`, [k], true, [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6], (h) => { LEAGUES[k].homeEdge = h; }, LEAGUES[k].homeEdge);
  fit('market blend', all, false, [0, 0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 1], (m) => { WEIGHTS.market = m; }, WEIGHTS.market);
  console.log('Copy into model.js:', JSON.stringify(WEIGHTS), all.map((k) => `${k} ${LEAGUES[k].homeEdge}`).join(', '));
}

module.exports = { fetchGames, pregame, evaluate, noOdds };
if (require.main === module) (async () => {
  const data = {};
  for (const k of leagues) {
    console.error(`Fetching ${k} ${SEASONS[k][0]}..${SEASONS[k][1]}`);
    data[k] = pregame(await fetchGames(k), LEAGUES[k]);
  }
  if (tune) gridSearch(data);
  const card = {};
  for (const k of leagues) {
    const r = evaluate(data[k].cases, LEAGUES[k]);
    report(k, r, data[k].check, evaluate(data[k].cases.map(noOdds), LEAGUES[k]));
    card[k] = { season: SEASONS[k][2], games: r.games, acc: +(r.correct / r.games).toFixed(3), oddsGames: r.odds,
      bookAcc: r.odds ? +(r.oddsBook / r.odds).toFixed(3) : null, brier: +r.brier.toFixed(4),
      // the page only suggests a bet if this rule made money here
      valueBets: r.bets['EV > 0'].n, valueRoi: r.bets['EV > 0'].n ? +(r.bets['EV > 0'].profit / r.bets['EV > 0'].n).toFixed(3) : null,
      allRoi: r.bets['every pick'].n ? +(r.bets['every pick'].profit / r.bets['every pick'].n).toFixed(3) : null };
  }
  const file = path.join(__dirname, 'backtest-results.js');
  const old = fs.existsSync(file) ? require(file) : {};
  const out = { ...old, ...card };
  fs.writeFileSync(file, `// Written by backtest.js on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.\n`
    + `const BACKTEST = ${JSON.stringify(out, null, 1)};\nif (typeof module !== 'undefined') module.exports = BACKTEST;\n`);
  console.log(`\nWrote ${path.basename(file)}`);
})();
