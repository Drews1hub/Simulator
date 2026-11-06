# NYSE Day Trader Simulator

A paper-trading simulator that runs on **live NYSE market data**. It starts you with virtual cash and lets you day trade real NYSE-listed stocks at real prices, without risking money.

![features](https://img.shields.io/badge/deps-zero-brightgreen)

**New to trading?** Read the plain-language [How to use guide](public/guide.html) (live at https://drews1hub.github.io/Simulator/guide.html). It also opens from the **? Help** button in the app.

## Two ways to run it

### 1. Locally with the data server (full chart history)

Requires Node.js 18+ (uses built-in `fetch`). No `npm install` needed.

```bash
npm start
# open http://localhost:3000
```

Set `PORT=8080 npm start` to change the port. Run the engine tests with `npm test`.

### 2. Hosted on GitHub Pages (no server)

`.github/workflows/pages.yml` publishes the `public/` folder to GitHub Pages on every push to `main`. One-time setup: in the repo's **Settings → Pages**, set **Source** to **GitHub Actions**.

GitHub Pages can't run the Node proxy, so the hosted copy streams real-time NYSE trades straight from the browser using [Finnhub](https://finnhub.io/register). It asks for a free API key on first visit. The key is stored only in that browser and sent only to finnhub.io.

Finnhub mode differences:
- Charts build from live trades from the moment you open the page. The free tier has no historical candles, so only the 1-day views are enabled.
- Quote snapshots are rate-limited to about 55 requests a minute, so a full watchlist takes around 30 s to populate. Live trade prices arrive over the WebSocket in between.

## Features

- **Live quotes**: the watchlist and open positions refresh every 5 s. Price changes flash green or red.
- **NYSE only**: symbols you add are checked against their listing exchange. For example, Nasdaq names like AAPL are rejected.
- **Candlestick chart**: 1D/1m, 1D/5m, 5D/15m and 1M/1h views. Includes volume, the previous-close line, your average price and open-order levels. Hover a candle to see its OHLCV. On the website (no server), 5D and 1M need an optional free [Twelve Data](https://twelvedata.com/register) key, added in Settings; live prices still come from Finnhub.
- **Orders**: market, limit and stop, in both directions. The engine works out buy, sell, sell short and buy to cover from your current position, and long/short flips are handled.
- **Realistic friction**: per-share commission with a minimum, slippage in basis points (1¢ minimum), and intraday leverage of 1×, 2× or 4×. Buying power is enforced, but closing trades are always allowed.
- **Account metrics**: equity, day P&L (from the ET session start), unrealized and realized P&L, buying power and cash.
- **Stats**: win rate, average win and loss, profit factor, commissions paid, plus a pattern-day-trader warning (4+ day trades with under $25k equity).
- **Bracket orders**: attach a stop-loss and take-profit to any entry. They become one-cancels-other exits once the entry fills, and are cancelled automatically if you close the position yourself. Prices pre-fill from a risk %, and the ticket shows dollar risk, reward and R:R.
- **Indicators**: VWAP (resets each session), EMA 9 and EMA 21 overlays.
- **Equity curve** in the Stats tab, plus **CSV export** of the trade log.
- **Auto-flatten at 15:55 ET** (optional) to enforce the day-trader rule of no overnight holds.
- **Sound on fills** (optional).
- **Hotkeys**: `B` buy at market, `S` sell at market, `X` close the selected position, `F` flatten everything.
- **Persistence**: your account, watchlist and settings are saved in browser `localStorage`. Reset them from ⚙ Settings.

## Market hours

The NYSE regular session runs 9:30–16:00 ET. The simulator reads the exchange's trading-period data, so the market-status pill reflects open, pre-market, after-hours and closed (including holidays). By default you can also trade outside regular hours: fills then use the latest extended-hours print or the last close. Untick this in Settings to trade only during the regular session.

## AI coach

**💬 Ask the coach** (under the order ticket) opens a panel beside the chart. It sends Claude (`claude-opus-5-5`) a text snapshot of the screen: selected symbol, the last 90 bars with EMA/VWAP, account, positions, working orders, the order being drafted, and the last 20 fills. Then it streams the answer. Presets: check my order, explain the chart, my position, review my trades.

- **Website:** paste an Anthropic API key in the coach panel or Settings. It stays in the browser and is sent only to `api.anthropic.com`.
- **Local server:** start it with the key in the environment so it never reaches the browser, e.g. `ANTHROPIC_API_KEY=sk-ant-... npm start` (PowerShell: `$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start`). The server forwards `/api/coach` only for requests from the same computer. Without the env var, the browser key is used instead.
- Cost is shown under each answer (estimated at $4 / $20 per million input / output tokens); a typical question is a few cents.

## Oil futures (local server only)

Add **MCL** (Micro WTI crude, 100 barrels) or **CL** (WTI crude, 1,000 barrels) to the watchlist, or search "oil". Prices are Yahoo's continuous front-month contract (`MCL=F` / `CL=F`), delayed about 10 minutes. The website version can't show futures because the free Finnhub data has none.

- Quantity is in **contracts**. A $1 move in oil = $100 per MCL contract, $1,000 per CL contract.
- You put up **margin** per contract (MCL $1,000, CL $10,000), not the full contract value. Only profit/loss and fees change your cash.
- Commission is per contract ($1 MCL, $2.50 CL). The PDT day-trade count ignores futures.
- Futures trade Sunday 6pm to Friday 5pm ET with a 5–6pm daily break, independently of stock hours.
- Margins and fees are rough, simulator-only figures; edit the `FUTURES` table in `public/engine.js` to change them or add contracts.
- Not simulated: contract expiry and roll. The continuous price can jump when Yahoo rolls to the next month.

## How it works

```
browser (public/)  ──►  server.js  ──►  Yahoo Finance chart API (live/delayed NYSE prices)
   app.js   UI, polling, chart
   engine.js  pure order/fill/P&L engine (also unit-tested in Node)
```

On startup the browser checks for the server (`api/health`). If it isn't there, as on GitHub Pages, it switches to Finnhub mode (`public/data.js`).

The Node server is a small, zero-dependency proxy. Browsers can't call the quote API directly because of CORS, so the server fetches it, normalizes the response, and caches each symbol for 4 s to stay polite to the upstream. If Yahoo rate-limits it (HTTP 429), it backs off and keeps serving the last good quotes, and the UI shows them as *Delayed*.

## Caveats

- Quotes come from Yahoo Finance's public endpoint. They are real-time or near-real-time for NYSE in most cases, but they are not an exchange-direct feed and are unofficial. The endpoint can change or rate-limit without notice.
- There's no order book. Market orders fill at last price ± slippage, and limit and stop orders trigger on the last trade price.
- This is for education and practice only, not investment advice.
