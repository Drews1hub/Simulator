# NYSE Day Trader Simulator

A paper-trading simulator that runs on **live NYSE market data**. It starts you with virtual cash and lets you day trade real NYSE-listed stocks at real prices, without risking money.

![features](https://img.shields.io/badge/deps-zero-brightgreen)

## Run it

Requires Node.js 18+ (uses built-in `fetch`). No `npm install` needed.

```bash
npm start
# open http://localhost:3000
```

Set `PORT=8080 npm start` to change the port. Run the engine tests with `npm test`.

## Features

- **Live quotes**: the watchlist and open positions refresh every 5 s. Price changes flash green or red.
- **NYSE only**: symbols you add are checked against their listing exchange. For example, Nasdaq names like AAPL are rejected.
- **Candlestick chart**: 1D/1m, 1D/5m, 5D/15m and 1M/1h views. Includes volume, the previous-close line, your average price and open-order levels. Hover a candle to see its OHLCV.
- **Orders**: market, limit and stop, in both directions. The engine works out buy, sell, sell short and buy to cover from your current position, and long/short flips are handled.
- **Realistic friction**: per-share commission with a minimum, slippage in basis points (1¢ minimum), and intraday leverage of 1×, 2× or 4×. Buying power is enforced, but closing trades are always allowed.
- **Account metrics**: equity, day P&L (from the ET session start), unrealized and realized P&L, buying power and cash.
- **Stats**: win rate, average win and loss, profit factor, commissions paid, plus a pattern-day-trader warning (4+ day trades with under $25k equity).
- **Hotkeys**: `B` buy at market, `S` sell at market, `X` close the selected position, `F` flatten everything.
- **Persistence**: your account, watchlist and settings are saved in browser `localStorage`. Reset them from ⚙ Settings.

## Market hours

The NYSE regular session runs 9:30–16:00 ET. The simulator reads the exchange's trading-period data, so the market-status pill reflects open, pre-market, after-hours and closed (including holidays). By default you can also trade outside regular hours: fills then use the latest extended-hours print or the last close. Untick this in Settings to trade only during the regular session.

## How it works

```
browser (public/)  ──►  server.js  ──►  Yahoo Finance chart API (live/delayed NYSE prices)
   app.js   UI, polling, chart
   engine.js  pure order/fill/P&L engine (also unit-tested in Node)
```

The Node server is a small, zero-dependency proxy. Browsers can't call the quote API directly because of CORS, so the server fetches it, normalizes the response, and caches each symbol for 4 s to stay polite to the upstream.

## Caveats

- Quotes come from Yahoo Finance's public endpoint. They are real-time or near-real-time for NYSE in most cases, but they are not an exchange-direct feed and are unofficial. The endpoint can change or rate-limit without notice.
- There's no order book. Market orders fill at last price ± slippage, and limit and stop orders trigger on the last trade price.
- This is for education and practice only, not investment advice.
