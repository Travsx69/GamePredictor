// Run: node model.test.js
const assert = require('assert');
const { LEAGUES, recordPct, formPct, impliedProb, predict, trend, betCheck, vrsWinProb, vrsParseStandings, vrsParseDetails, predictCs2, predictElo, dotaResults } = require('./model.js');

assert.equal(recordPct('0-0'), 0.5);
assert.ok(recordPct('4-1') > recordPct('1-4'));
assert.ok(recordPct('3-0-3', true) > recordPct('0-3-3', true)); // soccer W-D-L
assert.equal(formPct('WWW'), 1);
assert.equal(impliedProb('+100'), 0.5);
assert.ok(Math.abs(impliedProb('-150') - 0.6) < 1e-9);

const team = (abbr, record, extra = {}) => ({ abbr, record, injuries: [], ...extra });
const qbOut = [{ name: 'QB1', pos: 'QB', status: 'Out' }];

// Equal teams: home team is the pick
let r = predict({ home: team('H', '3-3'), away: team('A', '3-3'), injuriesKnown: true }, LEAGUES.nfl);
assert.ok(r.pHome > 0.5);

// Neutral site (e.g. London games): no home edge
r = predict({ home: team('H', '3-3'), away: team('A', '3-3'), neutral: true }, LEAGUES.nfl);
assert.equal(r.pHome, 0.5);

// Starting QB out flips an even game
r = predict({ home: team('H', '3-3', { injuries: qbOut }), away: team('A', '3-3'), injuriesKnown: true }, LEAGUES.nfl);
assert.ok(r.pHome < 0.5);

// "Active" players are not injuries
r = predict({ home: team('H', '3-3', { injuries: [{ name: 'x', pos: 'WR', status: 'Active' }] }), away: team('A', '3-3'), injuriesKnown: true }, LEAGUES.nfl);
assert.equal(r.factors.find((f) => f.key === 'injuries').value, 0);

// Market and soccer draw odds are used
r = predict({ home: team('H', '1-1-1', { ml: '+300' }), away: team('A', '1-1-1', { ml: '-120' }), drawMl: '+250' }, LEAGUES.epl);
assert.ok(r.pHome < 0.5 && r.drawP > 0.2 && r.drawP < 0.35);

// trend(): only results before the game count; margin, last-5 form and rest days
const res = [
  { date: '2025-10-01T00:00Z', pf: 110, pa: 100, res: 'W' },
  { date: '2025-10-03T00:00Z', pf: 90, pa: 100, res: 'L' },
  { date: '2025-10-05T00:00Z', pf: 120, pa: 100, res: 'W' },
];
const tr = trend(res, '2025-10-05T00:00Z');
assert.deepEqual(tr, { games: 2, margin: 0, form: 'WL', rest: 2 });
assert.equal(trend(res, '2025-10-01T00:00Z'), null);

// Better scoring margin and more rest both favour that team
const withTrend = (abbr, margin, rest) => team(abbr, '3-3', { trend: { games: 6, margin, form: 'WLWLWL', rest } });
r = predict({ home: withTrend('H', 8, 2), away: withTrend('A', -8, 2), neutral: true }, LEAGUES.nba);
assert.ok(r.pHome > 0.5 && r.factors.find((f) => f.key === 'margin').value > 0);
r = predict({ home: withTrend('H', 0, 1), away: withTrend('A', 0, 3), neutral: true }, LEAGUES.nba);
assert.ok(r.pHome < 0.5 && r.factors.find((f) => f.key === 'rest').value < 0);

// betCheck: +100 breaks even at 50%; -200 needs 2/3; EV sign follows our probability vs that
assert.equal(betCheck(0.5, '+100').breakEven, 0.5);
assert.ok(Math.abs(betCheck(0.6, -200).breakEven - 2 / 3) < 1e-9 && betCheck(0.6, -200).ev < 0);
assert.ok(Math.abs(betCheck(0.55, '+100').ev - 0.1) < 1e-9);
assert.equal(betCheck(0.5, undefined), null);

// CS2: Valve's formula is symmetric, 50% for equal points; parsers read Valve's markdown rows
assert.equal(vrsWinProb(1500, 1500), 0.5);
assert.ok(Math.abs(vrsWinProb(2046, 1931) + vrsWinProb(1931, 2046) - 1) < 1e-12 && vrsWinProb(2046, 1931) > 0.6);
const st = vrsParseStandings('| 1        |   2046 | Spirit               | donk, magixx, sh1ro, tN1R, zont1x | [details](details/x/0001--spirit.md) |');
assert.deepEqual(st, [{ rank: 1, points: 2046, name: 'Spirit', roster: 'donk, magixx, sh1ro, tN1R, zont1x', details: 'details/x/0001--spirit.md' }]);
const det = vrsParseDetails('- LAN Wins: 0.932[<sup>2</sup>](#t)\n|           38 |     1319 | 2026-09-06 | MOUZ          | W   | 1.000 |');
assert.equal(det.lan, 0.932);
assert.deepEqual(det.matches, [{ date: '2026-09-06', opponent: 'MOUZ', res: 'W' }]);
r = predictCs2({ home: { points: 1500 }, away: { points: 1900 } });
assert.ok(r.pHome < 0.5 && r.drawP === null && r.factors[0].key === 'vrs');

// Dota 2: standard Elo (400 points = 10:1 odds); OpenDota rows -> W/L from our side, kill margin, newest first
assert.equal(predictElo({ home: { rating: 1500 }, away: { rating: 1500 } }).pHome, 0.5);
assert.ok(Math.abs(predictElo({ home: { rating: 1900 }, away: { rating: 1500 } }).pHome - 10 / 11) < 1e-12);
const dr = dotaResults([
  { start_time: 100, radiant: true, radiant_win: false, radiant_score: 20, dire_score: 30, opposing_team_id: 7, opposing_team_name: 'X' },
  { start_time: 200, radiant: false, radiant_win: false, radiant_score: 10, dire_score: 35, opposing_team_id: 8, opposing_team_name: 'Y' },
]);
assert.deepEqual(dr.map((m) => [m.opponentId, m.res, m.kills]), [[8, 'W', 25], [7, 'L', -10]]);

console.log('model ok');
