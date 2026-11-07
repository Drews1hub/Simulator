# NYSE Day Trader Simulator

A paper-trading simulator that runs on **live NYSE market data**. It starts you with virtual cash and lets you day trade real NYSE-listed stocks at real prices, without risking money.

![features](https://img.shields.io/badge/deps-zero-brightgreen)

## Running it

### Locally

Requires Node.js 18+ (uses built-in `fetch`). No `npm install` needed.

```bash
npm start
# open http://localhost:3000
```

Set `PORT=8080 npm start` to change the port. Run the engine tests with `npm test`. To run the production Cloudflare Worker locally instead, use `npm run dev:cf` (http://localhost:8787).

### Production: Cloudflare Workers (trader.beneby.cc)

`worker/index.mjs` serves `public/` as static assets and runs the same market-data proxy as `server.js` (both use `lib/market.mjs`) on `/api/*`. Config is in `wrangler.jsonc`.

Deploys come straight from GitHub through Cloudflare Workers Builds. A push to `main` deploys production, and every other branch gets its own preview URL. One-time setup in the Cloudflare dashboard:

1. **Workers & Pages → Create → Import a repository**, then pick `BenEby15/trader`. The defaults work as-is, with deploy command `npx wrangler deploy`.
2. In the new Worker, open **Settings → Domains & Routes → Add → Custom domain** and enter `trader.beneby.cc`.
3. In Supabase **Authentication → URL Configuration**, set the Site URL to `https://trader.beneby.cc` and keep `http://localhost:3000` under Redirect URLs.

To deploy by hand instead, run `npm run deploy`, which needs `wrangler login` first.

On the custom domain the Worker caches each symbol in Cloudflare's edge cache for 4 s. Every visitor watching the same symbol shares one upstream request, which keeps traffic to Yahoo low as usage grows.

### Static-only hosting (Finnhub fallback)

If `public/` is served without the proxy, the app streams real-time NYSE trades straight from the browser using [Finnhub](https://finnhub.io/register). It asks for a free API key on first visit. The key is stored only in that browser and sent only to finnhub.io.

Finnhub mode differences:
- Charts build from live trades from the moment you open the page. The free tier has no historical candles, so only the 1-day views are enabled.
- Quote snapshots are rate-limited to about 55 requests a minute, so a full watchlist takes around 30 s to populate. Live trade prices arrive over the WebSocket in between.

## Features

- **Live quotes**: the watchlist and open positions refresh every 5 s. Price changes flash green or red.
- **NYSE only**: symbols you add are checked against their listing exchange. For example, Nasdaq names like AAPL are rejected.
- **Candlestick chart**: 1D/1m, 1D/5m, 5D/15m and 1M/1h views. Includes volume, the previous-close line, your average price and open-order levels. Hover a candle to see its OHLCV.
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

## How it works

```
browser (public/)  ──►  server.js (local) or worker/index.mjs (Cloudflare)  ──►  Yahoo Finance chart API
   app.js   UI, polling, chart                └── both use lib/market.mjs
   engine.js  pure order/fill/P&L engine (also unit-tested in Node)
```

On startup the browser checks for the proxy (`api/health`). If it isn't there, as on static-only hosting, it switches to Finnhub mode (`public/data.js`).

The proxy is small and has no dependencies. Browsers can't call the quote API directly because of CORS, so the server fetches it, normalizes the response, and caches each symbol for 4 s to stay polite to the upstream. If Yahoo rate-limits it (HTTP 429), it backs off and keeps serving the last good quotes, and the UI shows them as *Delayed*.

## Caveats

- Quotes come from Yahoo Finance's public endpoint. They are real-time or near-real-time for NYSE in most cases, but they are not an exchange-direct feed and are unofficial. The endpoint can change or rate-limit without notice.
- There's no order book. Market orders fill at last price ± slippage, and limit and stop orders trigger on the last trade price.
- This is for education and practice only, not investment advice.

## Accounts & cloud sync (optional, Supabase)

Enabled for trader.beneby.cc via `public/config.js`. Visitors who don't sign in keep using the app as guests. To set up a new Supabase project:

1. Create a project at [supabase.com](https://supabase.com) and run `supabase/schema.sql` in the SQL Editor.
2. In Authentication → URL Configuration, set the Site URL to your hosted URL (and add `http://localhost:3000` for local testing).
3. Put the project URL and **anon** key in `public/config.js` and set `AUTH_ENABLED: true`. Never use the `service_role` key there.

Signed-in users get their account and watchlist synced to the `portfolios` table (row-level security restricts each row to its owner). The Finnhub key is never uploaded. `profiles.plan` is reserved for subscriptions and is writable only by a server-side Stripe webhook.
