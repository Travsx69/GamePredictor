# Game Predictor

A single static web page that picks winners for NFL, NBA, MLB, soccer (Premier League, La Liga, MLS, Champions League) and esports (Counter-Strike 2, Dota 2). For every game it argues the case for **both** sides, then gives a verdict on why the underdog falls short.

No build step, no dependencies, no backend: plain HTML + JavaScript pulling free public data in the browser.

## Run it

```bash
python -m http.server 8765
```

Then open http://localhost:8765. (Opening `index.html` straight from disk won't load `model.js` in some browsers.)

## What goes into a pick

| Sport | Data | Factors |
|---|---|---|
| NFL, NBA, MLB, soccer | ESPN public API (scoreboards, team schedules, injuries, betting lines) | record, scoring margin, home/road split, last-5 form, rest days, home edge, injuries, closing odds (blended 90/10 with the model) |
| Counter-Strike 2 | Valve Regional Standings (GitHub) | Valve's own rating formula; arguments from form, head-to-head, LAN wins, quality of wins, prize money |
| Dota 2 | OpenDota | team Elo rating; arguments from form, head-to-head, kill margin |

Upcoming esports matches are listed if you paste a free [PandaScore](https://pandascore.co) key into the page (stored only in your browser). Without one, you can still pick any two teams.

## Track record (backtest)

`backtest.js` replays the last completed season of each league through the same model, rebuilding every team's pre-game record from results (ESPN's historical records are post-game, so using them directly would leak the answer).

| League | Games | Pick accuracy | Bookmaker favourite | Brier score |
|---|---|---|---|---|
| NFL 2025 | 272 | 64.7% | 64.0% | 0.213 |
| NBA 2025-26 | 1,235 | 69.7% | 69.5% | 0.194 |
| MLB 2026 | 2,430 | 57.0% | 57.2% | 0.243 |
| Premier League 2025-26 | 380 | 49.2% | 49.7% | 0.202 |
| La Liga 2025-26 | 380 | 54.7% | 53.9% | 0.190 |
| MLS 2026 (to Oct) | 450 | 50.2% | 50.0% | 0.212 |
| Champions League 2025-26 league phase | 144 | 61.1% | 60.4% | 0.182 |

Soccer accuracy counts draws as misses. Weights were tuned on half the games and only kept if they also improved the other half.

**Honest takeaway:** the picks are about as good as the bookmaker's favourite, not better. Backing every pick at closing odds lost money in 5 of 7 leagues, so each card's bet check says "pass" unless a value rule has a profitable track record. The esports predictions are not backtested (no free historical odds or ratings).

```bash
node model.test.js            # self-check
node backtest.js              # re-run the backtest, rewrites backtest-results.js
node backtest.js --tune       # grid-search the weights
```

## Files

- `index.html` – the page: league sidebar, cards, arguments, esports picker
- `model.js` – prediction logic (no DOM), shared by the page and the backtest
- `backtest.js` – season replays, tuning, betting simulation
- `backtest-results.js` – generated scorecard shown on the page
- `model.test.js` – assertion tests

For fun and analysis, not betting advice. Bookmakers' margins mean most bets lose money.
