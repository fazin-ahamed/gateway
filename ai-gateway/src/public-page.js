export const PUBLIC_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Astrosphere's public AI gateway overview: recorded token usage, recent activity, and available models.">
<title>Astrosphere · Gateway overview</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500&family=Source+Sans+3:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark;--canvas:#070912;--surface:#0e1122;--surface-subtle:#161b31;--text:#eef1fb;--text-muted:#9aa4c6;--border:#232a46;--border-strong:#6574aa;--accent:#74a4ff;--accent-hover:#93bbff;--accent-soft:#172247;--accent-text:#05070f;--danger:#ff7a90;--font-display:"Fraunces","Iowan Old Style",Palatino,serif;--font-sans:"Source Sans 3","Segoe UI",system-ui,sans-serif;--font-mono:"IBM Plex Mono",ui-monospace,Consolas,monospace}
:root[data-theme="light"]{color-scheme:light;--canvas:#eef1f9;--surface:#fff;--surface-subtle:#e6ebf6;--text:#101426;--text-muted:#56608a;--border:#d6dcef;--border-strong:#6b769c;--accent:#2f5fd0;--accent-hover:#2450c4;--accent-soft:#e3eafc;--accent-text:#fff;--danger:#c0324a}
*{box-sizing:border-box}html{scrollbar-color:var(--border-strong) var(--canvas);scroll-padding-top:20px}body{margin:0;background:var(--canvas);color:var(--text);font-family:var(--font-sans);font-size:16px;line-height:1.45;font-kerning:normal;text-rendering:optimizeLegibility}::selection{background:var(--accent);color:var(--accent-text)}a{color:inherit;text-underline-offset:4px}button,input,select{font:inherit}button,a,input,select,summary{-webkit-tap-highlight-color:transparent}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:4px}button{cursor:pointer}button:disabled{cursor:wait;opacity:.65}[hidden]{display:none!important}h1,h2,h3,p{margin:0}h1,h2,h3{text-wrap:balance}h1{font:500 clamp(1.9rem,3.4vw,2.8rem)/1.15 var(--font-display);letter-spacing:-.025em}h2{font-size:1.15rem;font-weight:600}p{max-width:70ch}.muted{color:var(--text-muted)}.mono{font-family:var(--font-mono);font-variant-numeric:tabular-nums}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.skip{position:absolute;left:20px;top:-80px;padding:12px;background:var(--accent);color:var(--accent-text);z-index:2}.skip:focus{top:12px}.wrap{max-width:1200px;margin:auto;padding-inline:clamp(20px,4vw,48px)}.top{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:100px;border-bottom:1px solid var(--border)}.brand{display:flex;align-items:center;gap:12px;font:500 26px/1.2 var(--font-display);text-decoration:none}.brand svg{width:30px;height:30px;flex-shrink:0;color:var(--accent)}.actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:9px 16px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text);font-weight:500;text-decoration:none;transition:background 130ms ease-out}.button:hover{background:var(--surface-subtle)}.button:active{background:var(--accent-soft)}.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}.primary:hover{background:var(--accent-hover)}.quiet{background:transparent}.intro{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:24px;padding-block:44px 30px}.intro p{margin-top:12px;color:var(--text-muted)}.freshness{text-align:right;font-size:14px;max-width:300px}.freshness span{display:block;margin-bottom:8px}.error{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;background:var(--surface-subtle);padding:20px;border-radius:10px;margin-bottom:24px}.error p{color:var(--danger)}.usage{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:40px;padding-block:28px 34px;border-block:1px solid var(--border)}.token-total{font:500 clamp(2rem,5.8vw,4.1rem)/1.15 var(--font-mono);letter-spacing:-.025em;overflow-wrap:anywhere;margin-top:18px;font-variant-numeric:tabular-nums}.coverage{margin-top:16px;color:var(--text-muted);font-size:14px}.breakdown{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 32px;align-content:center;margin:0}.breakdown div{min-width:0}.breakdown dt{color:var(--text-muted);font-size:14px;margin-bottom:6px}.breakdown dd{margin:0;font:500 clamp(1rem,2vw,1.3rem)/1.35 var(--font-mono);overflow-wrap:anywhere}.section{padding-top:36px}.section-head{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:12px;margin-bottom:22px}.section-head p{font-size:14px;color:var(--text-muted)}.chart{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:clamp(8px,2vw,26px);padding:22px 0 12px}.day{min-width:0}.plot{height:124px;display:flex;align-items:flex-end;border-bottom:1px solid var(--border-strong)}.bar{width:100%;background:var(--accent);border-radius:3px 3px 0 0;min-height:0}.day-label{display:block;margin-top:10px;font-size:13px;color:var(--text-muted);text-align:center}.chart-empty{padding:28px;background:var(--surface);border-radius:10px;color:var(--text-muted)}details{margin-top:14px}summary{min-height:44px;display:flex;align-items:center;width:fit-content;cursor:pointer;color:var(--text-muted);text-decoration:underline;text-underline-offset:4px}details[open] summary{margin-bottom:12px}.daily{width:100%;border-collapse:collapse;font-size:14px}.daily th,.daily td{text-align:left;padding:10px 12px}.daily th{border-bottom:1px solid var(--border);font-weight:500;color:var(--text-muted)}.daily th:not(:first-child),.daily td:not(:first-child){text-align:right}.directory{margin-top:30px;border-top:1px solid var(--border);padding-top:36px}.directory-heading{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px}.directory-heading h2{font:500 28px/1.2 var(--font-display);letter-spacing:-.02em}.filters{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,.38fr) minmax(150px,.4fr);gap:16px;margin-bottom:20px}.field{display:flex;flex-direction:column;gap:8px;min-width:0}.field label{font-size:14px;color:var(--text-muted)}input,select{min-height:46px;padding:10px 12px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text);min-width:0;width:100%;caret-color:var(--accent)}input::placeholder{color:var(--text-muted)}.model-head,.model{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(100px,.55fr);gap:24px}.model-head{padding:14px 20px;color:var(--text-muted);font-size:13px;border-bottom:1px solid var(--border)}.model-list{padding:0;margin:0;list-style:none}.model{padding:22px 20px;border-bottom:1px solid var(--border);align-items:start}.model:hover{background:var(--surface)}.model h3{font:500 15px/1.4 var(--font-mono);overflow-wrap:anywhere}.model-kind{display:block;color:var(--text-muted);font-size:13px;margin-top:6px}.endpoint{display:block;font-size:12px;margin-top:8px;overflow-wrap:anywhere;color:var(--text-muted)}.capabilities{display:flex;flex-wrap:wrap;gap:8px;font-size:13px}.cap{background:var(--surface-subtle);padding:4px 8px;border-radius:4px;color:var(--text-muted)}.limits{font-size:13px}.limit-value{font-family:var(--font-mono);font-variant-numeric:tabular-nums}.limit-label{color:var(--text-muted)}.limits p+p{margin-top:8px}.empty{padding:30px 20px;background:var(--surface);border-radius:10px;color:var(--text-muted)}.connection{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;margin-block:44px 30px;padding-top:30px;border-top:1px solid var(--border)}.connection h2{margin-bottom:12px}.address{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:16px}.address code{font-family:var(--font-mono);font-size:14px;overflow-wrap:anywhere;flex:1;min-width:0}.copy-note{min-height:22px;font-size:14px;color:var(--text-muted);margin-top:10px}.privacy p{color:var(--text-muted);font-size:14px}.footer{padding-block:20px 30px;border-top:1px solid var(--border);display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;color:var(--text-muted);font-size:13px}.footer a{min-height:44px;display:inline-flex;align-items:center}.footer p{display:flex;align-items:center}.load-note{padding:20px 0;color:var(--text-muted)}
@media(max-width:850px){.usage{gap:28px;grid-template-columns:1fr 1fr}.filters{grid-template-columns:1fr 1fr}.filters .field:first-child{grid-column:1/-1}.model-head,.model{grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) minmax(90px,.5fr);gap:16px}.connection{gap:28px}.intro{padding-top:32px}.freshness{text-align:left}}
@media(max-width:560px){.top{flex-direction:column;align-items:stretch;gap:18px;padding-block:22px}.brand{font-size:24px}.actions{justify-content:space-between}.actions .button{flex:1}.intro{padding-block:30px 24px;gap:20px}.freshness{max-width:none;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}.freshness span{margin:0;max-width:210px}.usage{grid-template-columns:1fr;gap:24px;padding-block:24px}.breakdown{gap:18px}.token-total{font-size:clamp(2rem,9vw,3rem)}.section{padding-top:28px}.section-head{gap:8px;margin-bottom:10px}.plot{height:100px}.day-label{font-size:11px}.directory{padding-top:28px;margin-top:24px}.filters{gap:12px}.model-head{display:none}.model{grid-template-columns:1fr;gap:14px;padding:20px 0}.capabilities{gap:6px}.limits{display:flex;flex-wrap:wrap;gap:16px}.limits p+p{margin:0}.connection{grid-template-columns:1fr;gap:26px;margin-top:32px}.daily th,.daily td{padding:10px 4px;font-size:12px}.chart-empty{padding:20px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
</style>
<script>
try { document.documentElement.dataset.theme = localStorage.getItem('console-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
catch { document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
</script>
</head>
<body>
<a class="skip" href="#overview">Skip to overview</a>
<div class="wrap">
<header class="top">
<a class="brand" href="/" aria-label="Astrosphere home"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/><ellipse cx="12" cy="12" rx="10" ry="4.2" fill="none" stroke="currentColor" stroke-width="1.3" transform="rotate(60 12 12)"/></svg>Astrosphere</a>
<nav class="actions" aria-label="Gateway"><button id="theme" class="button quiet" type="button">Change theme</button><a class="button primary" href="/console/signin">Open console</a></nav>
</header>
<main id="overview" tabindex="-1">
<div class="intro"><div><h1>Gateway overview</h1><p>AI usage and available models, without signing in.</p></div><div class="freshness"><span id="freshness" class="muted">Loading the public snapshot…</span><button id="refresh" class="button" type="button">Refresh</button></div></div>
<div id="error" class="error" role="alert" hidden><p id="error-message"></p><button id="retry" class="button" type="button">Retry snapshot</button></div>
<p id="loading" class="load-note" role="status">Reading recorded usage and the model catalogue…</p>
<section class="usage" aria-labelledby="usage-heading" aria-busy="true" id="usage">
<div><h2 id="usage-heading">Recorded token usage</h2><div id="total" class="token-total">Not loaded</div><p id="coverage" class="coverage">Input and output tokens across recorded requests.</p></div>
<dl class="breakdown"><div><dt>Input tokens</dt><dd id="input">Not loaded</dd></div><div><dt>Output tokens</dt><dd id="output">Not loaded</dd></div><div><dt>Recorded requests</dt><dd id="requests">Not loaded</dd></div><div><dt>Available models</dt><dd id="available">Not loaded</dd></div></dl>
</section>
<section class="section" aria-labelledby="activity-heading"><div class="section-head"><h2 id="activity-heading">Token activity</h2><p>Seven calendar days · UTC</p></div><div id="activity-empty" class="chart-empty" hidden>No token usage has been recorded in these seven days.</div><div id="chart" class="chart" aria-hidden="true"></div><details id="daily-details" hidden><summary>View daily totals</summary><table class="daily"><caption class="sr-only">Daily recorded token usage and request counts in UTC</caption><thead><tr><th scope="col">Date</th><th scope="col">Tokens</th><th scope="col">Requests</th></tr></thead><tbody id="daily"></tbody></table></details></section>
<section class="directory" aria-labelledby="models-heading"><div class="directory-heading"><h2 id="models-heading">Model directory</h2><p id="model-count" class="muted" role="status">Reading available models…</p></div><div class="filters"><div class="field"><label for="search">Find a model</label><input id="search" type="search" placeholder="Search by model name" autocomplete="off"></div><div class="field"><label for="kind">Model type</label><select id="kind"><option value="all">All types</option><option value="chat">Chat</option><option value="decision">Decision</option></select></div><div class="field"><label for="capability">Capability</label><select id="capability"><option value="all">All capabilities</option><option value="tools">Tools</option><option value="vision">Vision</option><option value="reasoning">Reasoning</option><option value="streaming">Streaming</option><option value="choice">Choice</option><option value="score">Score</option><option value="noul">NOUL</option></select></div></div><div class="model-head" aria-hidden="true"><span>Model and endpoint</span><span>Capabilities</span><span>Token limits</span></div><ul id="models" class="model-list"></ul><p id="model-empty" class="empty" hidden></p></section>
<section class="connection" aria-labelledby="connection-heading"><div><h2 id="connection-heading">Connect to the gateway</h2><p class="muted">OpenAI-compatible chat API. Requests require an API key.</p><div class="address"><code id="api-base"></code><button id="copy" class="button" type="button">Copy API URL</button></div><p id="copy-note" class="copy-note" role="status"></p></div><div class="privacy"><h2>Public by design</h2><p>Only aggregate recorded usage and model metadata are shown here. Accounts, API keys, request contents, provider details and spending stay private.</p><p style="margin-top:12px">Models reflect the latest configured, healthy routes. Availability can change. Totals cover retained ledger history rather than an unverifiable lifetime count.</p></div></section>
</main>
<footer class="footer"><p>Astrosphere · Public gateway overview</p><a href="/health">Gateway liveness endpoint</a></footer>
</div>
<noscript><p class="wrap">JavaScript is required to load the public overview. The aggregate JSON is available at <a href="/public/overview">/public/overview</a>.</p></noscript>
<script>
(function () {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const integer = new Intl.NumberFormat('en-US');
  const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const labels = { streaming: 'Streaming', tools: 'Tools', vision: 'Vision', reasoning: 'Reasoning', choice: 'Choice', score: 'Score', noul: 'NOUL' };
  let snapshot = null;
  let busy = false;
  const apiBase = location.origin + '/v1';
  byId('api-base').textContent = apiBase;
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function themeLabel() {
    const dark = document.documentElement.dataset.theme === 'dark';
    byId('theme').textContent = dark ? 'Light theme' : 'Dark theme';
    byId('theme').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  themeLabel();
  byId('theme').addEventListener('click', function () {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('console-theme', next); } catch {}
    themeLabel();
  });
  byId('copy').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(apiBase);
      byId('copy-note').textContent = 'API base URL copied.';
    } catch {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(byId('api-base'));
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      byId('copy-note').textContent = 'Clipboard access is unavailable. The URL is selected so you can copy it manually.';
    }
  });
  function renderModels() {
    if (!snapshot) return;
    const query = byId('search').value.trim().toLowerCase();
    const kind = byId('kind').value;
    const capability = byId('capability').value;
    const models = snapshot.models.filter(function (model) {
      return model.id.toLowerCase().includes(query) && (kind === 'all' || model.model_kind === kind) && (capability === 'all' || model.capabilities[capability]);
    });
    const fragment = document.createDocumentFragment();
    models.forEach(function (model) {
      const item = node('li', undefined, 'model');
      const identity = node('div');
      identity.append(node('h3', model.id), node('span', model.model_kind === 'decision' ? 'Decision model' : 'Chat model', 'model-kind'), node('code', model.endpoint, 'endpoint mono'));
      const caps = node('div', undefined, 'capabilities');
      Object.keys(labels).forEach(function (key) { if (model.capabilities[key]) caps.append(node('span', labels[key], 'cap')); });
      if (!caps.childNodes.length) caps.append(node('span', 'No extra capabilities advertised', 'muted'));
      const limits = node('div', undefined, 'limits');
      if (model.model_kind === 'decision') limits.append(node('p', 'Typed decisions', 'muted'));
      else [['context_window', 'context'], ['max_output_tokens', 'output']].forEach(function (field) {
        const p = node('p');
        p.append(node('span', model[field[0]] == null ? 'Unknown' : integer.format(model[field[0]]), 'limit-value'), node('span', ' ' + field[1], 'limit-label'));
        limits.append(p);
      });
      item.append(identity, caps, limits);
      fragment.append(item);
    });
    byId('models').replaceChildren(fragment);
    byId('model-count').textContent = models.length === snapshot.models.length ? integer.format(models.length) + ' available' : integer.format(models.length) + ' of ' + integer.format(snapshot.models.length) + ' models';
    byId('model-empty').hidden = models.length > 0;
    byId('model-empty').textContent = snapshot.models.length ? 'No models match these filters. Try another name, type or capability.' : 'No models are currently available. Refresh later to check configured, healthy routes.';
  }
  ['search', 'kind', 'capability'].forEach(function (id) { byId(id).addEventListener(id === 'search' ? 'input' : 'change', renderModels); });
  function renderActivity(points) {
    const maximum = Math.max.apply(null, points.map(function (p) { return p.total_tokens; }));
    const bars = document.createDocumentFragment();
    const rows = document.createDocumentFragment();
    points.forEach(function (point) {
      const date = new Date(point.date + 'T00:00:00Z');
      const day = node('div', undefined, 'day');
      const plot = node('div', undefined, 'plot');
      const bar = node('div', undefined, 'bar');
      bar.style.height = maximum ? (point.total_tokens / maximum * 100) + '%' : '0%';
      plot.append(bar);
      day.append(plot, node('span', dayFormat.format(date), 'day-label'));
      day.title = point.date + ': ' + integer.format(point.total_tokens) + ' tokens';
      bars.append(day);
      const row = node('tr');
      const dateCell = node('th', dateFormat.format(date));
      dateCell.scope = 'row';
      row.append(dateCell, node('td', integer.format(point.total_tokens), 'mono'), node('td', integer.format(point.requests), 'mono'));
      rows.append(row);
    });
    byId('chart').replaceChildren(bars);
    byId('chart').hidden = maximum === 0;
    byId('activity-empty').hidden = maximum !== 0;
    byId('daily').replaceChildren(rows);
    byId('daily-details').hidden = false;
  }
  function render(data) {
    byId('total').textContent = integer.format(data.usage.total_tokens);
    byId('input').textContent = integer.format(data.usage.input_tokens);
    byId('output').textContent = integer.format(data.usage.output_tokens);
    byId('requests').textContent = integer.format(data.usage.requests);
    byId('available').textContent = integer.format(data.models.length);
    byId('coverage').textContent = data.usage.first_recorded_at ? 'Recorded since ' + dateFormat.format(new Date(data.usage.first_recorded_at)) + ' · Across retained request history' : 'No requests have been recorded yet.';
    const updated = new Date(data.generated_at);
    byId('freshness').textContent = 'Snapshot ' + updated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }) + ' UTC · Cached for up to 30 seconds';
    renderActivity(data.activity.points);
    renderModels();
  }
  async function load() {
    if (busy) return;
    busy = true;
    byId('refresh').disabled = true;
    byId('retry').disabled = true;
    byId('usage').setAttribute('aria-busy', 'true');
    byId('loading').hidden = false;
    byId('loading').textContent = snapshot ? 'Updating the public snapshot…' : 'Reading recorded usage and the model catalogue…';
    byId('error').hidden = true;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      const response = await fetch('/public/overview', { credentials: 'omit', signal: controller.signal, cache: 'no-cache' });
      if (!response.ok) throw new Error('snapshot unavailable');
      const data = await response.json();
      snapshot = data;
      render(data);
    } catch {
      byId('error').hidden = false;
      byId('error-message').textContent = snapshot ? 'The latest snapshot could not load. Previously recorded values remain below; retry to update.' : 'Usage and models could not load. Retry the public snapshot.';
      if (!snapshot) { byId('freshness').textContent = 'Snapshot unavailable'; byId('model-count').textContent = 'Catalogue unavailable'; }
    } finally {
      clearTimeout(timer);
      busy = false;
      byId('refresh').disabled = false;
      byId('retry').disabled = false;
      byId('usage').setAttribute('aria-busy', 'false');
      byId('loading').hidden = true;
    }
  }
  byId('refresh').addEventListener('click', load);
  byId('retry').addEventListener('click', load);
  load();
}());
</script>
</body>
</html>`;
