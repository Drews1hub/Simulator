# Handoff: NYSE Day Trader Simulator (2026-11-06)

## Goal
Paper-trading day-trader simulator on live NYSE data, hosted publicly on GitHub Pages
for non-technical users. Repo: Drews1hub/Simulator (public).

## Done (all pushed to `claude/gifted-carson-xltk5t`, latest commit 64cc209)
- App: `public/` (index.html, app.js UI, engine.js pure trading engine, data.js data sources, style.css); `server.js` zero-dep Node proxy (Yahoo) for local use.
- Features: live watchlist, candlestick chart (VWAP/EMA 9/21), market/limit/stop orders, long+short, bracket (SL/TP, OCO) orders, leverage/fees/slippage, stats + equity curve, CSV export, auto-flatten 15:55 ET, hotkeys B/S/X/F, company-name search with suggestions + "Add anyway" for non-NYSE, ticker hover tooltip (company name), Total on the Buy button, favicon.
- Website mode: no server on Pages, so it asks for a free Finnhub API key (stored only in browser) and streams trades via WebSocket; chart builds from polled prices and is cached in localStorage (free Finnhub has no history; 5D/1M greyed out).
- User guide: `public/guide.html` + `guide.css` + 21 annotated real screenshots in `public/guide/`, plain language, website-only (no local-run instructions, per user). Help button in top bar + one-time first-visit notice. README links to it.
- 12 engine tests (`npm test`) pass; CI in `.github/workflows/test.yml`.

## Decisions (don't reopen)
- Tone for guide: plain language, little jargon, NOT childish; real screenshots, not drawings.
- Watchlist is a left column ending level with the chart (above the Positions panel).
- Non-NYSE stocks allowed via "Add anyway". Only US stocks supported (Finnhub free).
- Extended-hours trading ON by default. Other-country exchanges: user had "no preference", nothing built.

## Where things live
- Live site: https://drews1hub.github.io/Simulator/  (guide: .../guide.html)
- Branches: `claude/gifted-carson-xltk5t` (repo DEFAULT branch, all work) and `main` (stale copy at commit 12fcb99, created for Pages; not updated since).
- Deploy: Pages enabled (Source = GitHub Actions). Workflow `pages.yml` only auto-runs on pushes to main/master, so after pushing to the claude branch trigger it manually: workflow_dispatch of `pages.yml` with ref `claude/gifted-carson-xltk5t`. Takes ~25s.
- Screenshots were made with a throwaway Playwright script in the session scratchpad (not in repo). Guide images are static, so re-shoot if the UI changes.

## Open / next
- Optional: make `main` the default branch (repo Settings -> Default branch) and fast-forward it so pushes auto-deploy. Not done.
- Optional: clearer extended-hours (4am-8pm ET) messaging, or non-US exchanges (needs a new data source). User declined to choose.
- Not verified: real Finnhub key behaviour on the live site (tested only with mocked Finnhub responses, plus the user's own screenshots showing real prices). Finnhub `/search` (company-name search on the website) is untested against the real API. Verify prices tick during market hours (9:30-16:00 ET Mon-Fri).
- Last user question answered in chat: how to add a GitHub collaborator (Settings -> Collaborators -> Add people). No repo change.
- The other repo in scope, `audio-book-reader`, was not touched.
