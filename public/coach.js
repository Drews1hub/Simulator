/* global store, quotes, chartData, chartRange, src, prices, Engine, DataSources, session, futuresOpen,
          ema, vwap, fmtPx, fmtPct, fmt$, esc, $, side, save */
// AI trading coach: sends an LLM a snapshot of what's on screen plus the
// user's question, and streams the reply into a panel beside the chart.
//  - Local server: POST api/coach, the server adds the key (COACH_API_KEY or ANTHROPIC_API_KEY).
//  - Website: the browser calls the provider directly with the user's own key.
// Works with Anthropic, plus anything that speaks the OpenAI chat API
// (OpenAI, Google Gemini, OpenRouter, Groq, Ollama, LM Studio, ...).
'use strict';

// format 'anthropic' = Messages API; 'openai' = /chat/completions (the de-facto standard).
const COACH_PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', format: 'anthropic', base: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', keyUrl: 'https://console.anthropic.com/settings/keys', hint: 'sk-ant-…' },
  openai: { label: 'OpenAI', format: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-4o', keyUrl: 'https://platform.openai.com/api-keys', hint: 'sk-…' },
  gemini: { label: 'Google Gemini', format: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey', hint: 'AIza…' },
  openrouter: { label: 'OpenRouter (any model)', format: 'openai', base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o', keyUrl: 'https://openrouter.ai/keys', hint: 'sk-or-…' },
  custom: { label: 'Other (OpenAI-compatible URL)', format: 'openai', base: '', model: '', keyUrl: '', hint: 'API key (leave blank for local models)' },
};
// $ per token, only known for the default Anthropic model; others show tokens only.
const COACH_PRICES = { 'claude-opus-5-5': { in: 4 / 1e6, out: 20 / 1e6 } };

// The active provider settings: the server's (if it holds a key) or the user's own.
function coachConfig(route) {
  if (route === 'server' && serverCoach && typeof serverCoach === 'object') return serverCoach;
  const id = COACH_PROVIDERS[store.coachProvider] ? store.coachProvider : 'anthropic', p = COACH_PROVIDERS[id];
  return {
    provider: id, format: p.format, key: store.coachKey || '',
    base: (id === 'custom' ? (store.coachBase || '') : p.base).replace(/\/+$/, ''),
    model: (store.coachModel || '').trim() || p.model,
  };
}

const COACH_SYSTEM = `You are a trading coach built into a paper-trading simulator. The person is practicing day trading with pretend money, mostly US stocks and sometimes oil futures. Each question comes with a snapshot of their screen: the selected instrument, recent price bars, their positions, account, open orders, the order they are drafting, and their recent fills.

Help them think, not just act. Nobody can reliably predict prices, so never present a direction as certain. If they ask "will it go up", say plainly that you can't know, then give what is useful: the trend, nearby levels, what would confirm or invalidate the idea, and how much they stand to lose if wrong.

Ground everything in the snapshot's numbers. Work out dollar risk to a stop, risk as a percent of equity, reward-to-risk, and position size relative to the account. For futures, use the contract multiplier (a $1 move is worth multiplier dollars per contract). When you suggest a stop-loss or take-profit, tie it to a level visible in the bars and give the price. When reviewing trades, name what they did well, then the habits that cost them money, such as holding losers, sizing too big, trading without stops, or overtrading.

Write for a beginner: plain language, explain any jargon in a few words, short bullet points, usually under 200 words. Finish with one line starting "Takeaway:". Mention that prices may be delayed only if it matters to the answer.`;

const COACH_PRESETS = {
  order: 'Check the order I am drafting in the order ticket. Is the size and risk sensible for my account? Where would you put a stop-loss and a take-profit, and why?',
  chart: 'What is this chart doing right now? Point out the trend, key price levels, and anything notable such as volume spikes or a move away from VWAP.',
  position: 'Look at my open position in this symbol (or all my positions if I have none here). How is it going, and what should I be thinking about: stop, profit target, size?',
  review: 'Review my recent trades. What am I doing well, and which habits should I work on?',
};

// ---------- screen snapshot ----------
function etTime(t, withDate) {
  return new Date(t).toLocaleString('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    ...(withDate ? { month: '2-digit', day: '2-digit' } : {}),
  });
}

function coachSnapshot() {
  const sym = store.selected, q = quotes[sym] || {}, a = store.acct, px = prices();
  const f = Engine.futuresSpec(sym), L = [];
  L.push(`Now: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET. Stock market: ${session().label}.` +
    (f ? ` Futures market: ${futuresOpen() ? 'open' : 'closed'}.` : ''));
  L.push(`Data: ${src ? src.label : 'unknown'}.${f ? ' Futures prices are delayed about 10 minutes.' : ''}`);

  L.push(`\n## Selected instrument: ${sym}${q.name && q.name !== sym ? ` (${q.name})` : ''}`);
  if (f) L.push(`Futures contract: ${f.multiplier} ${f.unit} per contract, so a $1 move = $${f.multiplier} per contract. Margin $${f.margin} per contract, commission $${f.feePerContract} per contract per side.`);
  L.push(`Last ${fmtPx(q.price)} | change today ${q.changePct != null ? fmtPct(q.changePct) : 'n/a'} | previous close ${fmtPx(q.prevClose)} | day high ${fmtPx(q.dayHigh)} | day low ${fmtPx(q.dayLow)} | volume ${q.volume != null ? q.volume.toLocaleString() : 'n/a'}`);

  const c = (chartData && chartData.candles) || [];
  if (c.length) {
    const closes = c.map((x) => x.c), e9 = ema(closes, 9), e21 = ema(closes, 21), vw = vwap(c);
    const n = Math.min(90, c.length), multiDay = chartRange.r !== '1d';
    L.push(`\n## Price bars (${chartRange.r} chart, ${chartRange.i} bars; last ${n} of ${c.length})`);
    L.push(`Latest EMA9 ${fmtPx(e9[e9.length - 1])}, EMA21 ${fmtPx(e21[e21.length - 1])}, VWAP ${fmtPx(vw[vw.length - 1])}`);
    L.push('time_ET,open,high,low,close,volume');
    for (const b of c.slice(-n)) L.push(`${etTime(b.t, multiDay)},${b.o.toFixed(2)},${b.h.toFixed(2)},${b.l.toFixed(2)},${b.c.toFixed(2)},${b.v}`);
  } else L.push('\n(No price bars loaded yet.)');

  const eq = Engine.equity(a, px);
  L.push('\n## Account');
  L.push(`Equity ${fmt$(eq)} | cash ${fmt$(a.cash)} | buying power ${fmt$(Engine.buyingPower(a, px))} | day P&L ${fmt$(store.dayStart ? eq - store.dayStart.equity : 0)} | realized after fees ${fmt$(a.realized - a.commissions)} | starting cash ${fmt$(a.settings.startingCash)} | leverage ${a.settings.leverage}x | futures margin in use ${fmt$(Engine.futuresMargin(a))}`);

  const pos = Object.entries(a.positions);
  L.push('\n## Open positions');
  if (!pos.length) L.push('None.');
  for (const [s, p] of pos) {
    const m = Engine.multiplier(s), last = px[s] ?? p.avgPrice, u = (last - p.avgPrice) * p.qty * m;
    L.push(`${s}: ${p.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.qty)} ${m > 1 ? 'contracts' : 'shares'} @ avg ${fmtPx(p.avgPrice)}, last ${fmtPx(last)}, open P&L ${fmt$(u)}`);
  }

  const open = a.orders.filter((o) => o.status === 'open');
  L.push('\n## Working orders');
  if (!open.length) L.push('None.');
  for (const o of open) L.push(`${o.side.toUpperCase()} ${o.qty} ${o.symbol} ${o.type.toUpperCase()}${o.limitPrice ? ' limit ' + o.limitPrice : ''}${o.stopPrice ? ' stop ' + o.stopPrice : ''}${o.tag ? ' (' + o.tag + ')' : ''}`);

  const t = $('oType').value, bracket = $('oBracket').checked;
  L.push('\n## Order being drafted (not placed yet)');
  L.push(`${side.toUpperCase()} ${$('oQty').value || '?'} ${$('oSymbol').value.toUpperCase() || '?'} ${t.toUpperCase()}${t !== 'market' ? ' at ' + ($('oPrice').value || '?') : ''}` +
    (bracket ? ` with stop-loss ${$('oSL').value || 'none'} and take-profit ${$('oTP').value || 'none'}` : ' with no stop-loss or take-profit attached'));

  const fills = a.fills.slice(-20);
  L.push(`\n## Recent fills (last ${fills.length} of ${a.fills.length}, oldest first)`);
  if (!fills.length) L.push('No trades yet.');
  for (const x of fills) L.push(`${etTime(x.time, true)} ${x.side.toUpperCase()} ${x.qty} ${x.symbol} @ ${fmtPx(x.price)}, fee ${fmt$(x.fee)}${x.realized ? ', realized ' + fmt$(x.realized) : ''}`);
  return L.join('\n');
}

// ---------- talking to Claude ----------
let serverCoach = null; // null = unknown, false = none, or {provider, format, model} when the local server holds a key
async function coachRoute() {
  if (src instanceof DataSources.ServerSource) {
    if (serverCoach === null) {
      try { serverCoach = (await (await fetch('api/health', { cache: 'no-store' })).json()).coach || false; } catch (_) { serverCoach = false; }
    }
    if (serverCoach) return 'server';
  }
  const c = coachConfig('browser');
  const needsKey = c.provider !== 'custom' || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(c.base);
  return c.base && c.model && (c.key || !needsKey) ? 'browser' : null;
}

async function coachRequest(question, route, signal) {
  const c = coachConfig(route), user = `<screen>\n${coachSnapshot()}\n</screen>\n\n${question}`;
  let body, url, headers = { 'content-type': 'application/json' };
  if (c.format === 'anthropic') {
    body = {
      model: c.model, max_tokens: 16000, stream: true,
      output_config: { effort: 'medium' },
      fallbacks: 'default', // if a request is declined, Anthropic retries it on its recommended substitute model
      system: COACH_SYSTEM, messages: [{ role: 'user', content: user }],
    };
    url = (c.base || COACH_PROVIDERS.anthropic.base) + '/messages';
    Object.assign(headers, {
      'x-api-key': c.key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true', // the key is the user's own and stays in their browser
    });
  } else {
    body = {
      model: c.model, max_tokens: 4000, stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'system', content: COACH_SYSTEM }, { role: 'user', content: user }],
    };
    url = c.base + '/chat/completions';
    if (c.key) headers.authorization = 'Bearer ' + c.key;
  }
  if (route === 'server') return fetch('api/coach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  return fetch(url, { method: 'POST', signal, headers, body: JSON.stringify(body) });
}

// Read the server-sent event stream; call onText for each piece of the answer.
async function readCoachStream(res, onText) {
  const info = { stop: null, inTok: 0, outTok: 0, fallback: false, error: null };
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      if (data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch (_) { continue; }
      if (ev.choices || (ev.error && !ev.type)) { // OpenAI-style chunk
        if (ev.error) { info.error = ev.error.message || String(ev.error); continue; }
        const ch = ev.choices[0];
        if (ch && ch.delta && ch.delta.content) onText(ch.delta.content);
        if (ch && ch.finish_reason) info.stop = ch.finish_reason === 'length' ? 'max_tokens' : ch.finish_reason === 'content_filter' ? 'refusal' : ch.finish_reason;
        if (ev.usage) { info.inTok = ev.usage.prompt_tokens || 0; info.outTok = ev.usage.completion_tokens || 0; }
        continue;
      }
      if (ev.type === 'message_start' && ev.message && ev.message.usage) info.inTok = ev.message.usage.input_tokens || 0;
      else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'fallback') info.fallback = true;
      else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') onText(ev.delta.text);
      else if (ev.type === 'message_delta') {
        if (ev.delta && ev.delta.stop_reason) info.stop = ev.delta.stop_reason;
        if (ev.usage && ev.usage.output_tokens != null) info.outTok = ev.usage.output_tokens;
      } else if (ev.type === 'error') info.error = (ev.error && ev.error.message) || 'The coach service had an error.';
    }
  }
  return info;
}

async function errorText(res) {
  let msg = '';
  try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || ''; } catch (_) { /* not JSON */ }
  if (res.status === 401 || res.status === 403) return 'The AI provider rejected the API key. Check it in Settings (⚙).' + (msg ? ' (' + msg + ')' : '');
  if (res.status === 404) return 'The provider could not find that model or URL. Check the model name in Settings (⚙).' + (msg ? ' (' + msg + ')' : '');
  if (res.status === 429) return 'Too many requests right now (rate limit). Wait a minute and try again.';
  if (res.status === 529 || res.status === 503) return msg || 'The AI service is busy. Try again shortly.';
  return `The coach couldn't answer (HTTP ${res.status})${msg ? ': ' + msg : ''}`;
}

// ---------- panel ----------
// Tiny, safe Markdown: escape everything, then add bold, code, headings and lists.
function coachMd(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = []; let list = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd(), li = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/), h = line.match(/^#{1,4}\s+(.*)$/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

let coachBusy = null; // AbortController of the request in flight

function openCoach() {
  $('coachPanel').classList.remove('hidden');
  if (typeof drawChart === 'function') drawChart();
  renderCoachSetup();
  $('coachInput').focus();
}
function closeCoach() {
  $('coachPanel').classList.add('hidden');
  if (coachBusy) coachBusy.abort();
  if (typeof drawChart === 'function') drawChart();
}

function coachFieldsHtml() {
  const c = coachConfig('browser');
  return `<div class="field"><label>Provider</label><select class="cProv">${Object.entries(COACH_PROVIDERS).map(([k, p]) => `<option value="${k}"${k === c.provider ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
    <div class="field cBaseRow"><label>API base URL (OpenAI-compatible, e.g. https://api.groq.com/openai/v1 or http://localhost:11434/v1)</label><input class="cBase" value="${esc(store.coachBase || '')}" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label>Model <span class="muted">(blank = default)</span></label><input class="cModel" value="${esc(store.coachModel || '')}" placeholder="${esc(COACH_PROVIDERS[c.provider].model || 'model name')}" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label>API key <span class="cKeyLink"></span></label><input class="cKey" type="password" value="${esc(store.coachKey || '')}" autocomplete="off" spellcheck="false"></div>`;
}
function coachFieldsWire(root) {
  const sel = root.querySelector('.cProv');
  const sync = () => {
    const p = COACH_PROVIDERS[sel.value];
    root.querySelector('.cBaseRow').classList.toggle('hidden', sel.value !== 'custom');
    root.querySelector('.cModel').placeholder = p.model || 'model name';
    root.querySelector('.cKey').placeholder = p.hint;
    root.querySelector('.cKeyLink').innerHTML = p.keyUrl ? `(<a href="${p.keyUrl}" target="_blank" rel="noopener">get one</a>)` : '';
  };
  sel.onchange = sync; sync();
}
function coachFieldsSave(root) {
  store.coachProvider = root.querySelector('.cProv').value;
  store.coachBase = root.querySelector('.cBase').value.trim();
  store.coachModel = root.querySelector('.cModel').value.trim();
  store.coachKey = root.querySelector('.cKey').value.trim();
}

async function renderCoachSetup() {
  const route = await coachRoute(), box = $('coachSetup');
  box.classList.toggle('hidden', !!route);
  if (route) return;
  const local = src instanceof DataSources.ServerSource;
  box.innerHTML = `<p><b>Connect the coach.</b> Use your own API key from any AI provider (Claude, ChatGPT, Gemini, OpenRouter, or a local model). Providers charge per question, usually a few cents. The key is stored only in this browser and sent only to the provider.</p>
    ${coachFieldsHtml()}
    <div class="coach-key"><button class="btn" id="coachKeySave">Save</button></div>
    ${local ? '<p class="muted">Running the local server? You can instead start it with COACH_API_KEY set (see the README), so the key stays out of the browser.</p>' : ''}`;
  coachFieldsWire(box);
  $('coachKeySave').onclick = () => { coachFieldsSave(box); save(); renderCoachSetup(); };
}

async function askCoach(question) {
  question = (question || '').trim();
  if (!question || coachBusy) return;
  const route = await coachRoute();
  if (!route) { renderCoachSetup(); return; }

  const log = $('coachLog');
  const item = document.createElement('div');
  item.className = 'coach-item';
  item.innerHTML = `<div class="coach-q">${esc(question)}</div><div class="coach-a"><span class="muted">Thinking…</span></div><div class="coach-meta muted"></div>`;
  log.appendChild(item);
  item.scrollIntoView({ block: 'end' });
  const ans = item.querySelector('.coach-a'), meta = item.querySelector('.coach-meta');
  $('coachInput').value = '';
  setCoachBusy(true);

  let text = '';
  coachBusy = new AbortController();
  try {
    const res = await coachRequest(question, route, coachBusy.signal);
    if (!res.ok) throw new Error(await errorText(res));
    const info = await readCoachStream(res, (t) => { text += t; ans.innerHTML = coachMd(text); log.scrollTop = log.scrollHeight; });
    if (info.error) throw new Error(info.error);
    if (info.stop === 'refusal') ans.innerHTML = '<p class="muted">The coach couldn\'t answer this one. Try asking it a different way.</p>';
    else if (!text) ans.innerHTML = '<p class="muted">No answer came back. Try again.</p>';
    else if (info.stop === 'max_tokens') ans.insertAdjacentHTML('beforeend', '<p class="muted">(Answer was cut off.)</p>');
    const cfg = coachConfig(route), pr = COACH_PRICES[cfg.model];
    meta.textContent = `${cfg.model} · ${pr ? `≈ $${(info.inTok * pr.in + info.outTok * pr.out).toFixed(3)} · ` : ''}${info.inTok + info.outTok} tokens${info.fallback ? ' · answered by a backup model' : ''}`;
  } catch (e) {
    if (e.name === 'AbortError') ans.innerHTML = '<p class="muted">Stopped.</p>';
    else ans.innerHTML = `<p class="down">${esc(e.message || String(e))}</p>`;
  } finally {
    coachBusy = null;
    setCoachBusy(false);
  }
}
function setCoachBusy(b) {
  $('coachAsk').disabled = b;
  document.querySelectorAll('#coachPresets button').forEach((x) => { x.disabled = b; });
}

$('btnCoach').addEventListener('click', openCoach);
$('coachClose').addEventListener('click', closeCoach);
$('coachClear').addEventListener('click', () => { $('coachLog').innerHTML = ''; });
$('coachPresets').addEventListener('click', (e) => { const k = e.target.dataset.preset; if (k) askCoach(COACH_PRESETS[k]); });
$('coachForm').addEventListener('submit', (e) => { e.preventDefault(); askCoach($('coachInput').value); });
