// Cloudflare Worker: serves public/ as static assets and runs the market-data
// proxy on /api/*. Config lives in wrangler.jsonc.
import { createMarket } from '../lib/market.mjs';

// Cloudflare's per-datacenter cache, shared by every Worker instance there.
// Many visitors watching one symbol cost one Yahoo request every few seconds.
// (The Cache API is a no-op on *.workers.dev; it works on the custom domain.)
const CACHE_ORIGIN = 'https://market-cache.internal/';
const edgeCache = {
  async get(key) {
    const res = await caches.default.match(CACHE_ORIGIN + encodeURIComponent(key));
    return res ? res.json() : null;
  },
  async put(key, data, ttlSec) {
    const res = new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSec}` },
    });
    await caches.default.put(CACHE_ORIGIN + encodeURIComponent(key), res);
  },
};

const market = createMarket({ shared: edgeCache });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const { status, body } = await market.handleApi(url);
      return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  },
};
