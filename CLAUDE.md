# Game Predictor

Static web page: per-game winner picks for NFL, NBA, MLB, soccer (EPL, La Liga, MLS, UCL) and esports (Counter-Strike 2, Dota 2). Each card argues "The case for" both teams side by side (pick badged), then a verdict naming why the loser falls short, plus an injury report.

## Repo
- Git repo (branch `main`) pushed to public https://github.com/Travsx69/GamePredictor (GitHub account Travsx69). The parent `C:\AI-Developer-Portfolio` is not a repo.
- `gh` CLI is installed at `C:\Program Files\GitHub CLI\gh.exe` (not on the sandboxed Bash PATH; its token is in Windows Credential Manager, so run `gh`/`git push` from PowerShell). `README.md` is the public-facing description; keep its backtest table in sync with this file.

## Stack / files
- No build, no deps. Plain HTML + JS, data fetched client-side from ESPN public API (`site.api.espn.com/apis/site/v2/sports/{path}/scoreboard|injuries`, CORS `*`, no key).
- `model.js` — pure logic (LEAGUES config, `WEIGHTS`, record/form/odds parsing, injury weights, `predict()`, `toGame()` ESPN event → game object). No DOM. Shared by the page and `backtest.js`.
- `index.html` — UI: sticky left sidebar of leagues grouped by sport (`SPORT` map from `path` prefix; becomes a horizontal pill row under 760px; ☰ `#navToggle` hides/shows it, remembered in localStorage `navOpen`), date picker (`?dates=YYYYMMDD`; shows today while on the current slate, which loads ESPN's default board, `slate` flag), status line counts upcoming/live/final games, backtest scorecard line, game cards. Argument text lives here: `point()` (one sentence per model factor), `buildCase()` (factor sentences incl. margin/rest + pre-game extras: season-leader head-to-heads for NFL/soccer, MLB probable-pitcher ERA, playoff series lead), `weakness()` (short phrases for the verdict).
- `model.test.js` — `node model.test.js` assert self-check. Run after any model change.
- `backtest.js` — replays past seasons through `predict()`; writes `backtest-results.js` (`BACKTEST` object, the page's scorecard). Don't hand-edit the results file.
- Run locally: `python -m http.server 8765 --directory GamePredictor` (launch config `game-predictor` in `../.claude/launch.json`). Opening via `file://` in the app preview does not load `model.js`.

## Esports (not ESPN): Counter-Strike 2, Dota 2
- `LEAGUES.cs2|dota2` have `esport` (path `esports/*` → sidebar "Esports"). `load()` hides the date bar and runs `loadEsport()`. Per-game adapters in `ESPORTS` (index.html): `load()` → ranked teams + scorecard text, `team(t)` → card team, `pick(list)` (same-name entries), `predict`, `points(x, y)` (extra arguments, text only). Shared: `esportGame()`, picker (`#teamA/#teamB`, repopulated per league), `pandaGames()`/`loadUpcoming()`.
- CS2 ratings: Valve Regional Standings, newest `live/<year>/standings_global_*.md` via GitHub contents API (60 req/h unauthenticated; cached per session), files from raw.githubusercontent (CORS *). Per-team `details/*.md`: LAN Wins, Bounty Collected/Offered, Opponent Network, ~6 months of matches (`vrsParseStandings`, `vrsParseDetails`). Win chance `predictCs2()` = Valve's formula (Glicko, fixed RD 75 → Elo on VRS points); Valve says it's overconfident at the extremes. Valve ranks rosters: ~31 names appear twice (e.g. ex-RUSTEC #92/#152); `pick` takes the roster with the latest match; details cache keyed by URL.
- Dota 2 ratings: OpenDota (`api.opendota.com/api/teams`, no key, CORS, ~60/min 3000/day). Teams active in the last 182 days, same-name entries deduped by latest match, sorted by `rating` (Elo). `predictElo()` = standard 400-point Elo. Arguments: form (last 5 games), head-to-head games (6 months), kill margin over last 10 games, from `/teams/{id}/matches` (`dotaResults()`, cached per team).
- Both: not backtested (no free results+odds history; OpenDota exposes only current ratings), scorecard says so. No bet line (no odds).
- Upcoming/live: PandaScore `/{csgo|dota2}/matches/running|upcoming`, Bearer key typed by the user, stored only in localStorage `pandascoreKey`. Matching via `norm()` (lowercase, drops team/esports/gaming/club words and punctuation; non-Latin names → '' and never match) on name, then acronym against names or unique tags. Unmatched matches skipped and counted.
- Verified 2026-10-18 with the user's key: CS2 14 shown / 15 skipped; Dota 6 shown / 19 skipped (mostly EPL Masters / streamer-league teams OpenDota doesn't list as active).
- No map (CS2) or hero/draft data: PandaScore free plan returns no map names; `/csgo/games/{id}` and `/teams/{id}/stats` are 403 (paid). Options noted to user: PandaScore Historical plan, GRID Open Access.

## Model (confirmed behavior)
- Neutral-site games (`competition.neutralSite`, e.g. NFL London) get no home or split factor.
- Leader/pitcher/series extras are argument text only; they do not change the probability.
- Logit sum of factors (weights in `WEIGHTS`): record (×4, shrunk to .500 with 45 phantom games), scoring margin (avg margin/game ÷ league `marginScale`, shrunk with 5 phantom games, ×0.2; MLB `marginScale: Infinity` = off), home/road split (×1), last-5 form (×0.25), rest days diff (capped at 3, ×0.1), league `homeEdge`, injury load diff (status weight × position weight, capped ±1).
- Margin/form/rest come from `trend(results, kickoff)`; the page builds `results` from each team's `/teams/{id}/schedule` (cached per session, only results before kickoff), the backtest from replayed games. No completed games yet (e.g. NBA opening week) → no margin/form/rest. Schedule feed is the current season (postseason when in playoffs).
- If moneylines exist: `sigmoid(0.1·model + 0.9·market)` (de-vigged); soccer draw prob from `drawOdds`.
- Record formats: soccer `W-D-L`, others `W-L[-T]`.
- Bet suggestion (`betAdvice()` in index.html, upcoming games only): `betCheck(pWin, ml)` gives break-even rate and expected value per unit. Says "Value bet" only if EV > 0 AND the backtest's EV>0 rule made money over ≥ `MIN_BETS` (100) bets in that league (`BACKTEST[k].valueBets/valueRoi`); otherwise "Pass" with the price math and the league's every-pick return. Currently every league fails the gate, so it always passes.
- Injury statuses: unknown statuses (NFL lists "Active" players) count 0; season-long (IR, 60-Day-IL) weighted 0.3.

## Backtest (run 2026-10-18, tuned weights, injuries off)
Re-run: `node backtest.js [league ...]` (all leagues by default); `--tune` grid-searches and prints values to copy into `model.js`; `--refresh` re-downloads (cache: `%TEMP%/gp-backtest-<league>.json`). Then `node model.test.js`.
- Data: daily scoreboards over `SEASONS` ranges (regular season only); odds from core API `sports.core.api.espn.com/.../competitions/{id}/odds` (scoreboards drop odds after the game; summary `pickcenter` is empty before ~Nov 2025), fallback pickcenter.
- Leakage (confirmed): historical scoreboard records are post-game; some NBA dates carry end-of-season records, MLS records were stale after the World Cup break; soccer `form` is always today's form. So `pregame()` rebuilds total/home/road records and last-5 form from the replayed results (fetch starts on opening day); ESPN post-game record minus the result is only a check (NFL 544/544, MLB 4858/4860, EPL/LaLiga/UCL all, NBA 2340/2470, MLS 888/900 consistent).
- Tuning: model weights fit with odds hidden on even games, kept only if odd (held-out) games improve; record+margin searched jointly (they overlap), two passes, then home edges, then blend. Results: record 4/prior 45, margin 0.2/prior 5, form 0.25, rest 0.1, La Liga homeEdge .6, UCL .4; model-only held-out log loss .6618 (record only) → .6591. MLB margin off (only added noise). Rejected: MLB/EPL/MLS home-edge changes. Market 0.9 vs 1.0 tied within 0.001 log loss; 0.9 kept so the model still moves the number.

| League | Games | Pick acc | Book fav | Brier (hand weights → now) | Model alone acc / Brier (record-only → +margin/form/rest) |
|---|---|---|---|---|---|
| NFL 2025 | 272 | 64.7% | 64.0% | .2154→.2129 | 62.9→65.8% / .2307→.2256 |
| NBA 2025-26 | 1235 | 69.7% | 69.5% | .1985→.1941 | 67.7→67.8% / .2110→.2092 |
| MLB 2026 | 2430 | 57.0% | 57.2% | .2459→.2432 | 54.7→54.1% / .2494→.2484 |
| EPL 2025-26 | 380 | 49.2% | 49.7% | .2045→.2020 | 47.6→48.4% / .2177→.2183 |
| La Liga 2025-26 | 380 | 54.7% | 53.9% | .1999→.1904 | 49.5→49.7% / .2115→.2095 |
| MLS 2026 to date | 450 | 50.2% | 50.0% | .2201→.2121 | 43.3→45.6% / .2310→.2298 |
| UCL 25-26 league phase | 144 | 61.1% | 60.4% | .1973→.1818 | 50.0→50.0% / .2297→.2279 |
Betting (flat 1 unit at closing moneyline, `bet ...` lines in the report): every pick NFL -7.8%, NBA -3.5%, MLB -3.3%, EPL -9.8%, La Liga +3.3%, MLS -6.6%, UCL +0.4% ROI. EV>0 (blended prob) fires only 18 times in 5,300 games (prob is 90% market). Betting where the model alone beats the price by 3%: -1.5% (NFL) to -15.2% (MLS), negative in every league, so the model has no betting edge.
Soccer accuracy counts draws as misses (decisive-only: 68–74%); Brier/calibration use P(home | not draw) on decisive games. Calibration buckets are within ~6 pts in the big samples (NBA, MLB). Takeaway: the page's probability is essentially the closing line; the model alone is worse than the bookmaker in every league. Margin/form/rest mainly add argument variety; their predictive gain is small (biggest in NFL).

## Style
- Small, flat functions; 2-space indent; single quotes; escape all API text via `esc()` before injecting HTML.
- Card layout (answer first): meta line → matchup header (`side()`: logo or initials, name, record, big win %) → prob bar → result → verdict → two cases (top `SHOWN`=3 reasons, rest in native `<details class="more">`) → bet → injuries.
- Phone rules live in the `@media (max-width: 760px)` block at the END of `<style>` so they override base rules; ☰ is hidden there and league pills always show.
- python http.server sends no cache headers: after edits, hard-reload or the preview shows stale files. `[hidden]` is forced `display:none` (`.bar` is flex). Cards: `card()` (ESPN event) → `render(g, league, injuriesKnown)` (any game object, `g.date`).

## Known limits / TODO
- ESPN soccer injury feed is empty → soccer has no injury factor (shown in status line).
- NBA position weights are flat (no star-player detection); MLB ignores probable starting pitchers.
- Injury weights untested: past-date injuries aren't available (injuries endpoint is current-only).
- Esports team names can differ between PandaScore and the rating source beyond the stripped words (no fuzzy matching). CS2 picker lists duplicate-name rosters separately (rank shown, roster not).
- `SEASONS` in `backtest.js` is hard-coded; extend ranges as seasons finish. Model never picks a draw.
- Weights are shared across leagues (except homeEdge/marginScale); per-league weights untested. Rest ignores travel/time zones.
