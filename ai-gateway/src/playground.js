import { UAE_TIME_CLIENT_SOURCE } from "./uae-time.js";
var PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gateway Control</title>
<style>
  :root{
    color-scheme:dark;
    --bg:#08090c; --surface:#0f1218; --surface-hi:#151b25; --surface-deep:#0a0d12;
    --line:#1c222d; --line-hi:#2d3a4e; --text:#e4eaf2; --muted:#5f6d82;
    --accent:#2fd4b5; --accent-dim:#26aa90; --accent-soft:rgba(47,212,181,.08); --ink:#06211b;
    --good:#3ec98c; --warn:#dcae4f; --bad:#e45b5b;
    --r-lg:8px; --radius:8px; --radius-sm:4px; --r-pill:999px;
    --w-med:500; --w-bold:600;
    --mono:ui-monospace,"SF Mono",Consolas,monospace;
    --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --ease:cubic-bezier(.2,0,.13,1);
    --dur:120ms;
  }
  *{box-sizing:border-box} html,body{margin:0;min-height:100%}
  body{font:14px/1.45 var(--sans);background:var(--bg);color:var(--text);letter-spacing:.005em;text-rendering:optimizeLegibility;font-feature-settings:"cv01","cv08","cv10","tnum"}
  a{color:var(--accent)} button,input,select,textarea{font:inherit} button{white-space:nowrap}
  header{height:52px;display:flex;align-items:center;gap:20px;padding:0 24px;border-bottom:1px solid var(--line);background:var(--bg);position:sticky;top:0;z-index:30}
  header .brand{display:flex;align-items:center;gap:8px;font-weight:var(--w-bold);font-size:13px;letter-spacing:-.01em}
  header .brand .dot{width:22px;height:22px;display:grid;place-items:center;border-radius:4px;background:var(--accent);color:var(--ink);font:600 11px/1 var(--mono)}
  header .base{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font:10px/1 var(--mono);letter-spacing:.02em}
  header .clock{padding-left:12px;border-left:1px solid var(--line);color:var(--muted);font:10px/1 var(--mono);font-variant-numeric:tabular-nums}
  nav{position:fixed;z-index:20;top:52px;bottom:0;left:0;width:196px;display:flex;flex-direction:column;align-items:stretch;gap:0;padding:12px 12px 12px 0;background:var(--bg);border-right:1px solid var(--line)}
  nav button{position:relative;text-align:left;background:transparent;border:0;color:var(--muted);padding:8px 12px 8px 16px;border-radius:0 var(--radius-sm) var(--radius-sm) 0;border-left:2px solid transparent;cursor:pointer;font-size:12px;font-weight:var(--w-med);letter-spacing:.01em;transition:background var(--dur) var(--ease),color var(--dur) var(--ease),border-color var(--dur) var(--ease)}
  nav button:hover{color:var(--text)} nav button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  nav button.active{background:var(--accent-soft);color:var(--accent);border-left-color:var(--accent)}
  main{position:relative;z-index:1;max-width:1400px;margin:0 auto 0 196px;padding:24px 32px 64px;min-height:calc(100dvh - 52px)}
  .tab{display:none}.tab.active{display:block}
  h2.sec{font-size:13px;line-height:1.3;letter-spacing:-.01em;color:var(--text);margin:0 0 10px;font-weight:var(--w-bold)}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:16px;margin-bottom:12px}
  label{display:block;font-size:10px;line-height:1.2;color:var(--muted);margin:0 0 5px;font-weight:var(--w-med);letter-spacing:.06em}
  input,select,textarea{width:100%;background:var(--surface-deep);border:1px solid var(--line);color:var(--text);border-radius:var(--radius-sm);padding:8px 10px;font-size:12px;transition:border-color var(--dur) var(--ease)}
  input:hover,select:hover,textarea:hover{border-color:var(--line-hi)} input:focus,select:focus,textarea:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
  input::placeholder,textarea::placeholder{color:var(--muted)} textarea{min-height:100px;resize:vertical;font:11px/1.5 var(--mono)}
  .row{display:flex;gap:14px;flex-wrap:wrap}.row>*{flex:1;min-width:160px}.row>.spacer{flex:0;min-width:0}
  button.act,button.ghost,button.danger{border-radius:var(--radius-sm);cursor:pointer;font-size:11px;font-weight:var(--w-med);letter-spacing:.01em;transition:transform var(--dur) var(--ease),background var(--dur) var(--ease),border-color var(--dur) var(--ease)}
  button.act{background:var(--accent);color:var(--ink);border:1px solid var(--accent);padding:7px 12px}button.act:hover{background:var(--accent-dim);border-color:var(--accent-dim)}button.act:active,button.ghost:active,button.danger:active{transform:scale(.97)}button.act:disabled{opacity:.4;cursor:not-allowed}
  button.ghost{background:transparent;border:1px solid var(--line-hi);color:var(--muted);padding:7px 11px}button.ghost:hover{border-color:var(--accent);color:var(--accent)}
  button.danger{background:transparent;border:1px solid transparent;color:var(--bad);padding:6px 10px}button.danger:hover{background:rgba(228,91,91,.1);border-color:rgba(228,91,91,.4)}
  table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}#t-list{overflow-x:auto;border-radius:var(--radius-sm)}#t-list table{min-width:880px}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:middle}th{position:sticky;top:0;background:var(--surface-deep);color:var(--muted);font:9px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase}tbody tr:hover{background:var(--surface-deep)}tbody tr:last-child td{border-bottom:0}
  .mono{font-family:var(--mono);font-size:11px;word-break:break-all}.pill{padding:2px 7px;border:1px solid transparent;border-radius:var(--r-pill);font:9px/1.2 var(--mono);letter-spacing:.04em;text-transform:uppercase;display:inline-block}.pill.ok{background:rgba(62,201,140,.12);border-color:rgba(62,201,140,.24);color:var(--good)}.pill.bad{background:rgba(228,91,91,.12);border-color:rgba(228,91,91,.24);color:var(--bad)}.pill.warn{background:rgba(220,174,79,.12);border-color:rgba(220,174,79,.24);color:var(--warn)}.pill.mut{background:rgba(95,109,130,.1);border-color:rgba(95,109,130,.2);color:var(--muted)}.pill.acc{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
  .stat{position:relative;min-height:88px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px}.stat:before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--accent)}.stat .k{color:var(--muted);font-size:10px;font-weight:500;letter-spacing:.05em;text-transform:uppercase}.stat .v{font:600 22px/1.1 var(--mono);margin-top:10px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}.stat .v.acc{color:var(--accent)}.stat .v.ok{color:var(--good)}.stat .v.bad{color:var(--bad)}
  .grid{display:grid;gap:12px}.grid.s4{grid-template-columns:repeat(4,minmax(0,1fr))}.grid.s3{grid-template-columns:repeat(3,minmax(0,1fr))}.grid.s2{grid-template-columns:repeat(2,minmax(0,1fr))}
  button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .toast{position:fixed;right:20px;bottom:20px;background:var(--surface-hi);border:1px solid var(--line-hi);padding:10px 14px;border-radius:6px;opacity:0;transform:translateY(6px);transition:opacity var(--dur) var(--ease),transform var(--dur) var(--ease);pointer-events:none;max-width:340px;z-index:80;font-size:12px}.toast.show{opacity:1;transform:translateY(0)}.toast.err{border-color:var(--bad);color:var(--bad)}.toast.ok{border-color:var(--good)}
  .hint,.small{color:var(--muted);font-size:11px}.hint{margin:10px 0 0;line-height:1.45;max-width:62ch}.small{font-size:10px}
  .skeleton{background:var(--surface-deep);border-radius:4px;animation:pulse 1.4s ease-in-out infinite;opacity:.5}@keyframes pulse{0%,100%{opacity:.3}50%{opacity:.7}}
  .empty{padding:24px 20px;text-align:center;color:var(--muted);font-size:11px;border:1px dashed var(--line-hi);border-radius:var(--radius-sm)}
  .overlay{position:fixed;inset:0;background:rgba(5,6,9,.82);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:70;padding:20px}.overlay.show{display:flex}.modal{background:var(--surface);border:1px solid var(--line-hi);border-radius:var(--r-lg);padding:20px;width:440px;max-width:100%;max-height:88vh;overflow:auto}.modal.wide{width:min(960px,100%)}.modal h3{margin:0 0 16px;font-size:16px;letter-spacing:-.02em;font-weight:var(--w-bold)}.modal pre{max-height:400px}.msg{display:flex;gap:10px;margin:8px 0}.msg .who{font-weight:var(--w-med);min-width:56px;font-size:11px}.msg.user .who{color:var(--accent)}.msg.assistant .who{color:var(--good)}
  pre{background:var(--surface-deep);border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;overflow:auto;max-height:320px;font:10.5px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word}.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px}.toolbar .spacer{margin-left:auto}
  .seg{display:inline-flex;border:1px solid var(--line-hi);border-radius:var(--radius-sm);overflow:hidden}.seg button{background:transparent;border:0;color:var(--muted);padding:5px 10px;cursor:pointer;font-size:10px}.seg button.on{background:var(--accent);color:var(--ink)}
  @media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
  @media (max-width:980px){nav{position:sticky;top:56px;bottom:auto;width:100%;height:auto;flex-direction:row;overflow:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px 14px}nav:before{display:none}nav button{flex:0 0 auto}nav button.active:before{left:10px;right:10px;top:auto;bottom:-8px;width:auto;height:2px}main{margin-left:0;padding:24px}.grid.s4{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:620px){header{padding:0 14px}.base{display:none}header .clock{margin-left:auto}.grid.s4,.grid.s3,.grid.s2{grid-template-columns:1fr}.row>*{min-width:100%}main{padding:18px 14px}.card{padding:16px}.toolbar{align-items:flex-start;flex-wrap:wrap}.toolbar .spacer{display:none}.modal{padding:16px}.toast{right:14px;left:14px;bottom:14px;max-width:none}}
  .pg-shell{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px;align-items:start}
  .pg-config{position:sticky;top:80px}
  .pg-check{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:12px;color:var(--text)}
  .pg-check input{width:auto;accent-color:var(--accent)}
  .pg-advanced{margin-top:16px;border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;background:var(--surface-deep)}
  .pg-advanced summary{cursor:pointer;font-size:12px;color:var(--muted);font-weight:var(--w-med)}
  .pg-advanced textarea{margin-top:10px;min-height:140px}
  .pg-main{display:grid;gap:16px;min-width:0}
  .pg-chat{display:flex;flex-direction:column;min-height:560px;overflow:hidden;padding:0}
  .pg-chat-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line)}
  .pg-messages{flex:1;min-height:360px;max-height:520px;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px;background:var(--surface-deep)}
  .pg-msg{max-width:78%;padding:12px 14px;border-radius:10px;line-height:1.55}
  .pg-msg.user{align-self:flex-end;background:rgba(61,214,198,.12);border:1px solid rgba(61,214,198,.28);border-bottom-right-radius:4px}
  .pg-msg.assistant{align-self:flex-start;background:var(--surface-hi);border:1px solid var(--line);border-bottom-left-radius:4px}
  .pg-msg.streaming{border-style:dashed}
  .pg-msg .who{font:10px/1 var(--mono);letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
  .pg-msg.user .who{color:var(--accent)}
  .pg-msg.assistant .who{color:var(--good)}
  .pg-body{white-space:pre-wrap;word-break:break-word}
  .pg-meta{margin-top:8px;font:10px/1.4 var(--mono);color:var(--muted)}
  .pg-composer{display:flex;gap:10px;align-items:flex-end;padding:14px 18px;border-top:1px solid var(--line);background:var(--surface)}
  .pg-composer textarea{flex:1;min-height:44px;max-height:160px;resize:vertical}
  .pg-composer button{flex:0 0 auto;margin-top:0}
  .pg-detail{overflow:hidden}
  .pg-detail-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line)}
  .pg-detail-tabs{display:flex;gap:6px;padding:12px 18px 0;flex-wrap:wrap}
  .pg-detail-body{padding:16px 18px 20px}
  .pg-detail-body pre{max-height:320px}
  .pg-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .pg-summary .stat{min-height:78px;padding:12px 14px}
  .pg-summary .stat .v{font-size:17px;margin-top:7px}
  .pg-kv{display:grid;grid-template-columns:110px 1fr;gap:8px 14px;font-size:11px;margin:12px 0 0}
  .pg-kv dt{color:var(--muted)}
  .pg-kv dd{margin:0;word-break:break-word}
  @media (max-width:980px){.pg-shell{grid-template-columns:1fr}.pg-config{position:static}.pg-messages{max-height:400px}.pg-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.pg-msg{max-width:100%}}
  .pagehead{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 14px}
  .pagehead h2.sec{font-size:20px;letter-spacing:-.025em;margin:0}
  .pagehead .sub{color:var(--muted);font-size:12px;margin:6px 0 0;max-width:60ch;line-height:1.45}
  .pagehead .actions{display:flex;gap:8px;flex:0 0 auto}
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);margin-bottom:12px;overflow:hidden}
  .panel-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line)}
  .panel-h h2.sec{margin:0;font-size:12px}
  .panel-b{padding:16px}
  .panel-b.flush{padding:0}
  .hero-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
  .hero-stats .stat{min-height:96px;padding:14px 16px}
  .hero-stats .stat .v{font-size:24px;margin-top:10px}
  .hero-stats .stat .sub2{color:var(--muted);font-size:10px;margin-top:5px}
  .cols2{display:grid;grid-template-columns:1.4fr 1fr;gap:12px;align-items:start}
  table tr th:first-child,table tr td:first-child{padding-left:16px}
  table tr th:last-child,table tr td:last-child{padding-right:16px}
  td.rowact{white-space:nowrap;text-align:right}
  .kvrow{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)}
  .kvrow:last-child{border-bottom:0}
  .kvrow .grow{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px}
  .kvrow .right{margin-left:auto;flex:0 0 auto}
  .empty{padding:24px 20px;text-align:center;color:var(--muted);font-size:11px;border:1px dashed var(--line-hi);border-radius:var(--radius-sm)}
  .form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .form-grid .full{grid-column:1/-1}
  .modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
  .modal-head h3{margin:0}
  .modal-x{background:transparent;border:1px solid var(--line);color:var(--muted);border-radius:var(--radius-sm);width:26px;height:26px;cursor:pointer;font-size:12px;line-height:1;display:grid;place-items:center;padding:0}
  .modal-x:hover{color:var(--text);border-color:var(--line-hi)}
  .modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
  .form-actions{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
  #modal-body label{margin-top:2px}
  .filter-grid{display:grid;grid-template-columns:1.2fr 1.4fr 1.2fr 1.2fr .8fr auto;gap:12px;align-items:end}
  .lg-pre{max-height:60vh;font:11px/1.6 var(--mono);background:var(--surface-deep)}
  .lg-ts{color:var(--muted);margin-right:8px;font-size:10px}
  @media (max-width:1100px){.hero-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.cols2{grid-template-columns:1fr}.filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:620px){.hero-stats{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.filter-grid{grid-template-columns:1fr}.pagehead{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot">G</span><span>Gateway Control</span></div>
  <span class="base" id="base">\u2026</span>
  <span class="clock" id="clock"></span>
</header>
<nav aria-label="Gateway sections">
  <button type="button" data-tab="overview" class="active" aria-current="page">Overview</button>
  <button type="button" data-tab="providers">Providers</button>
  <button type="button" data-tab="routes">Model routes</button>
  <button type="button" data-tab="tiers">Model tiers</button>
  <button type="button" data-tab="keys">API keys</button>
  <button type="button" data-tab="chat">Playground</button>
  <button type="button" data-tab="cache">Cache</button>
  <button type="button" data-tab="prices">Prices</button>
  <button type="button" data-tab="logs">Logs</button>
</nav>
<main>
  <section class="tab active" id="tab-overview">
    <div class="pagehead"><div><h2 class="sec">Overview</h2><p class="sub">Totals, recent runs, and upstream health for this gateway.</p></div></div>
    <div class="hero-stats" id="stats"></div>
    <div class="cols2">
      <div class="panel"><div class="panel-h"><h2 class="sec">Recent activity</h2></div><div class="panel-b flush" id="recent"></div></div>
      <div class="panel"><div class="panel-h"><h2 class="sec">Provider health</h2></div><div class="panel-b" id="ov-providers"></div></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2 class="sec">Egress health</h2><button class="ghost" id="ph-refresh">Refresh</button></div>
      <div class="panel-b" id="proxy-health"><span class="small">Loading egress status…</span></div>
    </div>
  </section>

  <section class="tab" id="tab-providers">
    <div class="pagehead"><div><h2 class="sec">Providers</h2><p class="sub">Upstream backends. Keys stay sealed in SQLite. <span class="mono">auto</span> uses direct egress; <span class="mono">proxy_url</span> is the OCI rollback path.</p></div><div class="actions"><button class="act" id="p-add">Add provider</button></div></div>
    <div class="panel"><div class="panel-b flush" id="providers-list"></div></div>
  </section>

  <section class="tab" id="tab-routes">
    <div class="pagehead"><div><h2 class="sec">Model routes</h2><p class="sub">Each public slug has a rank-0 primary plus fallbacks tried in order. Clients only see the slug.</p></div><div class="actions"><button class="act" id="r-add">Add route</button></div></div>
    <div class="panel"><div class="panel-b flush" id="routes-list"></div></div>
  </section>

  <section class="tab" id="tab-tiers">
    <div class="pagehead"><div><h2 class="sec">Model tiers</h2><p class="sub">A tier is a reusable bundle of public model slugs. Assign one or more tiers to a key; per-key exclusions always win.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Create tier</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Tier name</label><input id="tier-name" placeholder="Builder"></div>
        <div><label>Public model slugs</label><select id="tier-slugs" multiple size="5"></select><small>Choose one or more currently enabled public models.</small></div>
        <div class="full"><button class="act" id="tier-create">Create tier</button></div>
      </div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="tiers-list"></div></div>
  </section>

  <section class="tab" id="tab-keys">
    <div class="pagehead"><div><h2 class="sec">API keys</h2><p class="sub">Client credentials with budgets, rate limits, tier access, and model overrides.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Create key</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Name</label><input id="k-name" placeholder="my-app"></div>
        <div><label>Budget mode</label><select id="k-mode"><option value="usd">USD ($)</option><option value="tokens">Tokens</option></select></div>
        <div><label>Budget limit</label><input id="k-limit" type="number" step="any" placeholder="5.00"></div>
        <div><label>Request limit / minute</label><input id="k-rpm" type="number" min="1" step="1" placeholder="Unlimited"></div>
        <div><label>Expires at (UAE / GST)</label><input id="k-expiry" type="datetime-local"><small>UAE time (UTC+4). Blank means the key never expires.</small></div>
        <div><label>Model tiers</label><select id="k-tiers" multiple size="3"></select><small>Optional; choose one or more.</small></div>
        <div><label>Extra allowed models (comma list)</label><input id="k-models" placeholder="z-ai/glm-5.2"></div>
        <div><label>Excluded models (always override tiers and extra allows)</label><input id="k-excludes" placeholder="minimax/minimax-m3"></div>
      </div>
      <button class="act" id="k-create">Create key</button>
      <div class="hint" id="k-out"></div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="keys-list"></div></div>
  </section>

  <section class="tab" id="tab-chat">
    <div class="pg-shell">
      <aside class="pg-config card">
        <h2 class="sec" style="margin-top:0">Playground</h2>
        <p class="hint">Run a model through the gateway with your admin session.</p>
        <label for="c-model">Model slug</label>
        <select id="c-model"><option value="">Loading enabled models...</option></select>
        <label class="pg-check" for="c-stream"><input type="checkbox" id="c-stream"> Stream responses</label>
        <div class="form-actions"><button class="act" id="c-clear">Clear chat</button></div>
        <div class="form-actions"><button class="act" id="c-batch">Batch test all models</button></div>
        <button class="ghost" id="c-batch-cancel" style="margin-top:8px;display:none">Cancel batch</button>
        <p class="hint">Sends the current prompt once to every enabled model, non-streaming. Usage is recorded.</p>
        <details class="pg-advanced">
          <summary>Request JSON</summary>
          <textarea id="c-messages">[]</textarea>
        </details>
      </aside>
      <div class="pg-main">
        <section class="pg-chat card">
          <header class="pg-chat-head">
            <div>
              <h2 class="sec" style="margin:0">Conversation</h2>
              <div class="small" id="c-status">Ready when you are.</div>
            </div>
          </header>
          <div class="pg-messages" id="c-chat">
            <div class="empty">Send a message to start a run.</div>
          </div>
          <div class="pg-composer">
            <textarea id="c-prompt" placeholder="Send a prompt through the gateway…"></textarea>
            <button class="ghost" id="c-redo" title="Regenerate the last response">Regenerate</button>
            <button class="act" id="c-send">Send</button>
          </div>
        </section>
      <section class="card" id="c-batch-panel" hidden>
        <header class="pg-detail-head">
          <div>
            <h2 class="sec" style="margin:0">Batch results</h2>
            <div class="small" id="c-batch-meta">No batch run yet.</div>
          </div>
          <button class="ghost" id="c-batch-close">Close</button>
        </header>
        <div class="pg-detail-body" id="c-batch-results"></div>
      </section>
  </section>

  <section class="tab" id="tab-cache">
    <div class="pagehead"><div><h2 class="sec">Response cache</h2><p class="sub">Cache is always on for deterministic requests. Send <span class="mono">x-gateway-cache: off</span> to bypass, or <span class="mono">x-gateway-cache: refresh</span> to force a new fetch. Entries are scoped to each API key.</p></div><div class="actions"><button class="ghost" id="cache-refresh">Refresh</button><button class="danger" id="cache-purge">Purge all</button></div></div>
    <div class="panel"><div class="panel-b flush" id="cache-stats"></div></div>
    <div class="panel"><div class="panel-b"><pre id="cache-policy" style="margin:0"></pre></div></div>
  </section>

  <section class="tab" id="tab-prices">
    <div class="pagehead"><div><h2 class="sec">Model prices (USD / 1M tokens)</h2><p class="sub">Used to compute cost_usd when the upstream doesn't return a cost. Sync pulls <span class="mono">models.dev</span> rates for every routed slug. Manual rows override the catalog.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Save price</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Slug</label><input id="pr-slug" placeholder="z-ai/glm-5.3"></div>
        <div><label>Prompt $/1M</label><input id="pr-prompt" type="number" step="0.0001" placeholder="0"></div>
        <div><label>Completion $/1M</label><input id="pr-completion" type="number" step="0.0001" placeholder="0"></div>
      </div>
      <div class="form-actions"><button class="act" id="pr-save">Save price</button><button class="ghost" id="pr-sync">Sync from models.dev</button></div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="pr-list"></div></div>
  </section>

  <section class="tab" id="tab-logs">
    <div class="pagehead"><div><h2 class="sec">Logs</h2><p class="sub">Live request and provider events from this process. In memory only; the ring holds the last 500 lines and resets on restart.</p></div><div class="actions"><label class="pg-check" style="margin:0"><input type="checkbox" id="lg-auto"> Auto</label><button class="ghost" id="lg-refresh">Refresh</button><button class="ghost" id="lg-copy">Copy</button></div></div>
    <div class="panel"><div class="panel-b"><pre id="lg-out" class="lg-pre" style="margin:0"></pre></div></div>
  </section>
</main>

<div class="overlay" id="overlay">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-head"><h3 id="modal-title">Modal</h3><button class="modal-x" id="modal-x" aria-label="Close">×</button></div>
    <div id="modal-body"></div>
    <div class="modal-foot">
      <button class="ghost" id="modal-cancel">Cancel</button>
      <button class="act" id="modal-save">Save</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
${UAE_TIME_CLIENT_SOURCE}
const API = location.origin;
const NL = String.fromCharCode(10);
const toastEl = document.getElementById('toast');
function toast(msg, kind){ toastEl.textContent=msg; toastEl.className='toast show '+(kind||''); clearTimeout(toast._t); toast._t=setTimeout(function(){toastEl.className='toast';},2600); }
async function api(path, opts){ opts=opts||{}; const r=await fetch(API+path,{headers:{'Content-Type':'application/json'},credentials:'same-origin',...opts}); if(r.status===401){ setTimeout(()=>{location.href=API+'/_gw';},400); throw new Error('session expired'); } let d=null; try{d=await r.json();}catch(e){} return {status:r.status,data:d}; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function fmt(n){ n=Number(n)||0; return n.toLocaleString(undefined,{maximumFractionDigits:4}); }
function money(n){ return '$'+(Number(n)||0).toFixed(4); }
function statusPill(s){ s=Number(s)||0; if(s>=200&&s<400) return '<span class="pill ok">'+s+'</span>'; if(s===0) return '<span class="pill warn">err</span>'; return '<span class="pill bad">'+s+'</span>'; }

document.getElementById('base').textContent = API;
function tick(){ const el=document.getElementById('clock'); el.textContent=new Intl.DateTimeFormat('en-GB',{timeZone:UAE_TIME_ZONE,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date())+' GST'; }
tick(); setInterval(tick,1000);

// tabs
const navButtons=Array.from(document.querySelectorAll('nav button[data-tab]'));
function setActiveTab(t){
  navButtons.forEach(function(x){
    const active=x.dataset.tab===t;
    x.classList.toggle('active',active);
    if(active) x.setAttribute('aria-current','page'); else x.removeAttribute('aria-current');
  });
  document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x.id==='tab-'+t);});
}
async function selectTab(t){
  if(!document.getElementById('tab-'+t)) return;
  setActiveTab(t);
  try{
    if(t==='overview') await loadOverview();
    if(t==='providers') await loadProviders();
    if(t==='routes') await loadRoutes();
    if(t==='tiers') await loadTiers();
    if(t==='keys') await loadKeys();
    if(t==='chat') await refreshPlaygroundModels();
    if(t==='cache') await loadCache();
    if(t==='prices') await loadPrices();
    if(t==='logs') await loadLogs();
  }catch(e){ toast('Could not load '+t+': '+e.message,'err'); }
}
document.querySelector('nav').addEventListener('click',function(e){
  const b=e.target.closest('button[data-tab]'); if(!b) return;
  selectTab(b.dataset.tab);
});

// ---------- modal helper ----------
let modalSubmit=null;
function openModal(title, fields, onSubmit, saveLabel){
  document.querySelector('.modal').classList.remove('wide');
  document.getElementById('modal-title').textContent=title;
  const body=document.getElementById('modal-body'); body.innerHTML='';
  const vals={};
  fields.forEach(function(f){
    const lab=document.createElement('label'); lab.textContent=f.label; body.appendChild(lab);
    let inp;
    if(f.type==='select'||f.type==='multiselect'){ inp=document.createElement('select'); if(f.type==='multiselect') inp.multiple=true; (f.options||[]).forEach(function(o){ const op=document.createElement('option'); op.value=o.value; op.textContent=o.label; if(f.type==='multiselect'&&Array.isArray(f.value)&&f.value.map(String).includes(String(o.value))) op.selected=true; inp.appendChild(op); }); }
    else if(f.type==='textarea'){ inp=document.createElement('textarea'); inp.rows=f.rows||4; }
    else { inp=document.createElement('input'); inp.type=f.type||'text'; }
    if(f.value!=null&&f.type!=='multiselect') inp.value=f.value;
    if(f.placeholder) inp.placeholder=f.placeholder;
    if(f.hint){ const h=document.createElement('div'); h.className='small'; h.style.margin='-6px 0 12px'; h.textContent=f.hint; body.appendChild(inp); body.appendChild(h); vals[f.key]=inp; return; }
    inp.dataset.key=f.key; body.appendChild(inp); vals[f.key]=inp;
  });
  modalSubmit=function(){ const out={}; fields.forEach(function(f){ out[f.key]=f.type==='multiselect'?Array.from(vals[f.key].selectedOptions).map(function(o){return o.value;}):vals[f.key].value; }); onSubmit(out); };
  const saveBtn=document.getElementById('modal-save');
  saveBtn.textContent=saveLabel||'Save';
  document.getElementById('modal-title').style.color='';
  saveBtn.style.display='';
  saveBtn.classList.remove('danger'); saveBtn.classList.add('act');
  document.getElementById('overlay').classList.add('show');
  const first=body.querySelector('input,select,textarea'); if(first) setTimeout(function(){ try{first.focus();}catch(e){} },30);
}
function paintSkeleton(el,kind){
  if(!el) return;
  if(kind==='stats'){ el.innerHTML='<div class="hero-stats">'+('<div class="stat"><div class="k">&nbsp;</div><div class="v skeleton">----</div></div>').repeat(4)+'</div>'; return; }
  el.innerHTML='<div class="skeleton" style="height:14px;margin:8px 0">&nbsp;</div>'.repeat(4);
}
function paintLoadError(el,message,retry){
  if(!el) return;
  el.innerHTML='';
  const d=document.createElement('div'); d.className='empty';
  d.appendChild(document.createTextNode(message+' '));
  const b=document.createElement('button'); b.className='ghost'; b.textContent='Retry'; b.onclick=retry;
  d.appendChild(b); el.appendChild(d);
}
function confirmAction(title,summary,confirmLabel,action){
  const body=document.getElementById('modal-body'); const save=document.getElementById('modal-save');
  document.querySelector('.modal').classList.remove('wide');
  document.getElementById('modal-title').textContent=title;
  document.getElementById('modal-title').style.color='var(--bad)';
  body.innerHTML='';
  const p=document.createElement('p'); p.className='hint'; p.style.margin='0'; p.textContent=summary; body.appendChild(p);
  modalSubmit=async function(){ closeModal(); await action(); };
  save.textContent=confirmLabel||'Confirm';
  save.style.display='';
  save.classList.remove('act'); save.classList.add('danger');
  document.getElementById('overlay').classList.add('show');
}
function closeModal(){ document.getElementById('overlay').classList.remove('show'); modalSubmit=null; }
document.getElementById('modal-cancel').onclick=closeModal;
document.getElementById('modal-x').onclick=closeModal;
document.getElementById('modal-save').onclick=function(){ if(modalSubmit) modalSubmit(); };
document.getElementById('overlay').addEventListener('click',function(e){ if(e.target.id==='overlay') closeModal(); });
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&document.getElementById('overlay').classList.contains('show')) closeModal();
  if(e.key==='Enter'&&document.getElementById('overlay').classList.contains('show')&&modalSubmit&&/^(INPUT|SELECT)$/.test((document.activeElement||{}).tagName||'')){ e.preventDefault(); modalSubmit(); }
});
async function loadOverview(){
  const statsEl=document.getElementById('stats');
  statsEl.innerHTML='<div class="stat"><div class="k">loading</div><div class="v skeleton">----</div></div>';
  let data; try{ const res=await api('/admin/overview'); data=res.data; }catch(e){ statsEl.innerHTML='<div class="empty">Could not load overview: '+esc(e.message)+'</div>'; return; }
  if(!data) return;
  const tot=data.totals||{};
  const stats=[
    {k:'Total requests', v:fmt(tot.requests), c:'acc', s:'all time'},
    {k:'Tokens used', v:fmt(tot.used_tokens), c:'', s:'all time'},
    {k:'Spend (USD)', v:money(tot.used_usd), c:'ok', s:'all time'},
    {k:'API keys', v:fmt((data.keys||[]).length), c:'', s:'configured'},
    {k:'Providers', v:fmt((data.providers||[]).length), c:'', s:'configured'},
    {k:'Model routes', v:fmt((data.routes||[]).length), c:'', s:'enabled paths'}
  ];
  statsEl.innerHTML=stats.map(function(s){return '<div class="stat"><div class="k">'+esc(s.k)+'</div><div class="v '+(s.c||'')+'">'+esc(s.v)+'</div><div class="sub2">'+esc(s.s||'')+'</div></div>';}).join('');
  document.getElementById('recent').innerHTML='<div class="empty" style="margin:20px">Usage totals update after each request. Provider health is live.</div>';
  const ps=(data.providers||[]);
  document.getElementById('ov-providers').innerHTML = ps.length ? ps.map(function(p){
    const ok=(p.healthy&&p.last_status&&p.last_status>=200&&p.last_status<400); const cls=ok?'ok':(p.healthy?'warn':'bad');
    const label=ok?'healthy':(!p.healthy?'disabled':('HTTP '+(p.last_status||'-')));
    return '<div class="kvrow"><span class="pill '+cls+'">'+label+'</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">'+esc(p.route_count||0)+' routes</span></div>';
  }).join('') : '<div class="empty">No providers.</div>';
  loadProxyHealth();
}
async function loadProxyHealth(){
  const el=document.getElementById('proxy-health'); el.innerHTML='<span class="small">Checking…</span>';
  let data; try{ const res=await api('/admin/proxy-health'); data=res.data; }catch(e){ el.innerHTML='<span class="small">Egress check failed: '+esc(e.message)+'</span>'; return; }
  if(!data){ el.innerHTML='<span class="small">Failed to load.</span>'; return; }
  const h=data.health||[];
  el.innerHTML = h.length ? h.map(function(p){
    if(p.transport==='koyeb'){ const ok=p.relay_reachable; return '<div class="kvrow"><span class="pill '+(ok?'ok':'bad')+'">'+(ok?'koyeb ok':'koyeb down')+'</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">'+esc(p.relay_status||p.reason||'')+'</span></div>'; }
    if(!p.proxy) return '<div class="kvrow"><span class="pill mut">direct</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">'+esc(p.reason||'')+'</span></div>';
    const ok=p.upstream_status && p.upstream_status>=200 && p.upstream_status<500;
    return '<div class="kvrow"><span class="pill '+(ok?'ok':'warn')+'">'+(ok?'proxy ok':'proxy reachable')+'</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">upstream '+p.upstream_status+'</span></div>';
  }).join('') : '<div class="empty">No providers configured.</div>';
}
var HEADER_PRESETS={
  none:'',
  openrouter:'HTTP-Referer: https://example.com\\nX-Title: AI Gateway',
  claudecode:'anthropic-beta: claude-code-20250219',
  anthropicbeta:'anthropic-beta: prompt-caching-2024-07-31',
  harness:'anthropic-beta: claude-code-20250219\\nanthropic-dangerous-direct-browser-access: true\\nx-app: cli\\nUser-Agent: claude-cli/2.1.220 (external, claude-desktop)'
};
function headersToLines(json){
  try{ const o=typeof json==='string'?JSON.parse(json||'{}'):json||{}; return Object.keys(o).map(function(k){return k+': '+o[k];}).join('\\n'); }catch(e){ return ''; }
}
function applyHeaderPreset(v){
  if(v.header_preset&&v.header_preset!=='custom'&&!(v.extra_headers||'').trim()) v.extra_headers=HEADER_PRESETS[v.header_preset]||'';
  delete v.header_preset; return v;
}
var HEADER_PRESET_OPTIONS=[{value:'none',label:'No preset'},{value:'openrouter',label:'OpenRouter app headers'},{value:'claudecode',label:'Claude Code beta'},{value:'anthropicbeta',label:'Anthropic prompt-caching beta'},{value:'harness',label:'Harness fingerprint (omp / Claude Code)'},{value:'custom',label:'Custom only'}];
async function addProvider(){
  openModal('Add provider',[
    {key:'name',label:'Name',placeholder:'OpenRouter'},
    {key:'base_url',label:'Base URL',placeholder:'https://api.example.com/v1'},
    {key:'api_key',label:'API Key',type:'password',placeholder:'sk-... (stored in DB)'},
    {key:'fmt',label:'Format',type:'select',options:[{value:'openai',label:'OpenAI compatible'},{value:'anthropic',label:'Anthropic'}]},
    {key:'priority',label:'Priority (lower = first)',type:'number',value:'0'},
    {key:'proxy_url',label:'OCI proxy URL (rollback only)',placeholder:'http://user:pass@host:8080'},
    {key:'transport',label:'Transport',type:'select',value:'auto',options:[{value:'auto',label:'Auto (direct unless relay needed)'},{value:'direct',label:'Direct from Worker'},{value:'koyeb',label:'Koyeb relay'},{value:'oci',label:'OCI relay (rollback)'}]},
    {key:'header_preset',label:'Header preset',type:'select',value:'none',options:HEADER_PRESET_OPTIONS},
    {key:'extra_headers',label:'Extra upstream headers',type:'textarea',placeholder:'HTTP-Referer: https://example.com\\nX-Title: My app',hint:'One Name: value per line. Sent to this provider on every request. Auth and content headers are managed automatically.'},
  ], async function(v){
    applyHeaderPreset(v);
    const {status,data}=await api('/admin/providers',{method:'POST',body:JSON.stringify(v)});
    if(status===201){ toast('provider created (id '+data.id+')','ok'); closeModal(); loadProviders(); }
    else toast('create failed: '+(data&&data.error&&data.error.message||status),'err');
  });
};
async function editProvider(id){
  const {data}=await api('/admin/providers'); const p=(data.providers||[]).find(function(x){return x.id==id;}); if(!p) return;
  openModal('Edit provider',[
    {key:'name',label:'Name',value:p.name},
    {key:'base_url',label:'Base URL',value:p.base_url},
    {key:'api_key',label:'API Key',type:'password',placeholder: p.api_key_set ? '(saved; leave blank to keep)' : 'sk-... (stored in DB)'},
    {key:'fmt',label:'Format',type:'select',value:p.fmt,options:[{value:'openai',label:'OpenAI compatible'},{value:'anthropic',label:'Anthropic'}]},
    {key:'priority',label:'Priority',type:'number',value:p.priority},
    {key:'proxy_url',label:'OCI proxy URL (rollback only)',value:p.proxy_url||''},
    {key:'transport',label:'Transport',type:'select',value:p.transport||'auto',options:[{value:'auto',label:'Auto (direct unless relay needed)'},{value:'direct',label:'Direct from Worker'},{value:'koyeb',label:'Koyeb relay'},{value:'oci',label:'OCI relay (rollback)'}]},
    {key:'header_preset',label:'Header preset',type:'select',value:'none',options:HEADER_PRESET_OPTIONS},
    {key:'extra_headers',label:'Extra upstream headers',type:'textarea',value:headersToLines(p.extra_headers),placeholder:'HTTP-Referer: https://example.com\\nX-Title: My app',hint:'One Name: value per line. Sent to this provider on every request. Auth and content headers are managed automatically.'},
    {key:'notes',label:'Notes',value:p.notes||''},
    {key:'healthy',label:'State',type:'select',value:p.healthy?'1':'0',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.healthy = v.healthy==='1'; applyHeaderPreset(v);
    const {status,data:r}=await api('/admin/providers/'+id,{method:'PATCH',body:JSON.stringify(v)});
    if(status===200){ toast('provider updated','ok'); closeModal(); loadProviders(); }
    else toast('update failed: '+(r&&r.error&&r.error.message||status),'err');
  });
}
async function toggleProvider(id, healthy){
  await api('/admin/providers/'+id+'/toggle',{method:'POST'}); loadProviders();
}
async function delProvider(id){
  confirmAction('Delete provider','Delete provider '+id+' and all of its routes? This cannot be undone.','Delete',async function(){ const {status}=await api('/admin/providers/'+id,{method:'DELETE'}); if(status===200){ toast('provider deleted','ok'); loadProviders(); } else toast('delete failed','err'); }); return;
}
async function loadProviders(){
  const el=document.getElementById('providers-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/providers'); data=res.data; }catch(e){ paintLoadError(el,'Could not load providers: '+e.message,loadProviders); return; }
  const rows=((data&&data.providers)||[]).map(function(p){
    const ok=p.healthy&&p.last_status&&p.last_status>=200&&p.last_status<400;
    const cls=ok?'ok':(p.healthy?'warn':'bad');
    const state=!p.healthy?'disabled':(p.last_status?('HTTP '+p.last_status):'unprobed');
    return '<tr><td><b>'+esc(p.name)+'</b><div class="small mono">'+esc(p.base_url||'')+'</div></td><td>'+esc(p.fmt||'')+'</td><td>'+esc(p.transport||'auto')+'</td><td><span class="pill '+cls+'">'+state+'</span></td>'+
      '<td class="rowact"><button class="ghost" data-act="pedit" data-id="'+p.id+'">edit</button> <button class="ghost" data-act="ptoggle" data-id="'+p.id+'" data-h="'+(p.healthy?'1':'0')+'">'+(p.healthy?'disable':'enable')+'</button> <button class="danger" data-act="pdel" data-id="'+p.id+'">delete</button></td></tr>';
  }).join('')||'<tr><td colspan="5"><div class="empty">No providers yet.</div></td></tr>';
  el.innerHTML='<table><tr><th>Provider</th><th>Format</th><th>Transport</th><th>State</th><th></th></tr>'+rows+'</table>';
}
document.getElementById('p-add').onclick=function(){ addProvider(); };

// ---------- ROUTES ----------
async function loadRoutes(){
  const el=document.getElementById('routes-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/routes'); data=res.data; }catch(e){ paintLoadError(el,'Could not load routes: '+e.message,loadRoutes); return; }
  const rows=(data.routes||[]).map(function(r){
    const cls=(r.enabled&&r.provider_healthy)?'ok':'bad';
    const role=r.rank===0?'<span class="pill acc">primary</span>':'<span class="pill mut">fallback '+esc(String(r.rank))+'</span>';
    return '<tr><td class="mono">'+esc(r.slug)+'</td><td>'+role+' <span class="mono small">rank '+esc(String(r.rank))+'</span></td><td>'+esc(r.provider_name||'')+'</td><td class="mono small">'+esc(r.upstream_model)+'</td><td><span class="pill '+cls+'">'+(r.enabled?'on':'off')+'</span></td>'+
      '<td class="rowact"><button class="ghost" data-act="raddfb" data-slug="'+esc(r.slug)+'" data-provider="'+esc(String(r.provider_id))+'" data-model="'+esc(r.upstream_model)+'" data-rank="'+esc(String(r.rank))+'">add fallback</button> <button class="ghost" data-act="redit" data-id="'+r.id+'">edit</button> <button class="ghost" data-act="rtoggle" data-id="'+r.id+'" data-e="'+r.enabled+'">'+(r.enabled?'disable':'enable')+'</button> <button class="danger" data-act="rdel" data-id="'+r.id+'">delete</button></td></tr>';
  }).join('') || '<tr><td colspan="6"><div class="empty">No model routes yet.</div></td></tr>';
  el.innerHTML='<table><tr><th>Slug</th><th>Role</th><th>Provider</th><th>Upstream model</th><th>Route</th><th></th></tr>'+rows+'</table>';
}
async function providerOptions(){
  const {data}=await api('/admin/providers'); return (data.providers||[]).map(function(p){return {value:String(p.id),label:esc(p.name)};});
}
document.getElementById('r-add').onclick=async function(){
  const opts=await providerOptions();
  if(!opts.length){ toast('create a provider first','err'); return; }
  openModal('Add model route',[
    {key:'slug',label:'Public slug (clients see this)',placeholder:'openai/gpt-4o-mini'},
    {key:'provider_id',label:'Provider',type:'select',options:opts},
    {key:'upstream_model',label:'Upstream model id',placeholder:'gpt-4o-mini'},
    {key:'rank',label:'Rank (0 = primary)',type:'number',value:'0'},
    {key:'enabled',label:'State',type:'select',value:'1',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.provider_id=Number(v.provider_id); v.rank=Number(v.rank); v.enabled=v.enabled==='1';
    const {status,data}=await api('/admin/routes',{method:'POST',body:JSON.stringify(v)});
    if(status===201){ toast('route added','ok'); closeModal(); loadRoutes(); }
    else toast('add failed: '+(data&&data.error&&data.error.message||status),'err');
  });
};
async function editRoute(id){
  const {data}=await api('/admin/routes/'+id); const r=data.route; if(!r) return;
  const opts=await providerOptions();
  openModal('Edit model route',[
    {key:'slug',label:'Public slug',value:r.slug},
    {key:'provider_id',label:'Provider',type:'select',value:String(r.provider_id),options:opts},
    {key:'upstream_model',label:'Upstream model id',value:r.upstream_model},
    {key:'rank',label:'Rank',type:'number',value:r.rank},
    {key:'enabled',label:'State',type:'select',value:r.enabled?'1':'0',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.provider_id=Number(v.provider_id); v.rank=Number(v.rank); v.enabled=v.enabled==='1';
    const {status,data:rr}=await api('/admin/routes/'+id,{method:'PATCH',body:JSON.stringify(v)});
    if(status===200){ toast('route updated','ok'); closeModal(); loadRoutes(); }
    else toast('update failed: '+(rr&&rr.error&&rr.error.message||status),'err');
  });
}
async function toggleRoute(id, enabled){
  await api('/admin/routes/'+id+'/toggle',{method:'POST'}); loadRoutes();
}
async function delRoute(id){
  confirmAction('Delete route','Delete route '+id+'? Fallback ranks on this slug are unchanged.','Delete',async function(){ const {status}=await api('/admin/routes/'+id,{method:'DELETE'}); if(status===200){ toast('route deleted','ok'); loadRoutes(); } else toast('delete failed','err'); }); return;
}
async function addFallbackRoute(btn){
  const slug=btn.getAttribute('data-slug')||'';
  if(!slug){ toast('route slug missing','err'); return; }
  const opts=await providerOptions();
  if(!opts.length){ toast('create a provider first','err'); return; }
  const nextRank=Number(btn.getAttribute('data-rank')||'0')+1;
  openModal('Add fallback for '+slug,[
    {key:'provider_id',label:'Fallback provider',type:'select',value:btn.getAttribute('data-provider')||'',options:opts},
    {key:'upstream_model',label:'Fallback upstream model id',value:btn.getAttribute('data-model')||''},
    {key:'rank',label:'Rank (higher than '+esc(String(nextRank-1))+')',type:'number',value:String(nextRank)},
    {key:'enabled',label:'State',type:'select',value:'1',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.provider_id=Number(v.provider_id); v.rank=Number(v.rank)||nextRank; v.enabled=v.enabled==='1';
    const {status,data}=await api('/admin/routes',{method:'POST',body:JSON.stringify({slug:slug,provider_id:v.provider_id,upstream_model:v.upstream_model,rank:v.rank,enabled:v.enabled})});
    if(status===201){ toast('fallback added at rank '+v.rank,'ok'); closeModal(); loadRoutes(); }
    else toast('add failed: '+(data&&data.error&&data.error.message||status),'err');
  });
}

// delegated clicks
document.addEventListener('click', function(e){
  const btn=e.target.closest('button[data-act]'); if(!btn) return;
  const id=btn.getAttribute('data-id'); const act=btn.getAttribute('data-act');
  if(act==='pedit') editProvider(id);
  else if(act==='ptoggle') toggleProvider(id, btn.getAttribute('data-h')==='1'?0:1);
  else if(act==='pdel') delProvider(id);
  else if(act==='redit') editRoute(id);
  else if(act==='raddfb') addFallbackRoute(btn);
  else if(act==='rtoggle') toggleRoute(id, btn.getAttribute('data-e')==='1'?0:1);
  else if(act==='tieredit') editTier(id);
  else if(act==='tierdel') delTier(id);
  else if(act==='copy') copyKey(id);
  else if(act==='kedit') editKey(id);
  else if(act==='ktoggle') toggleKey(id, btn.getAttribute('data-active')==='1'?0:1);
  else if(act==='kdel') delKey(id);
});

async function publicModelOptions(){ const {data}=await api('/admin/routes'); return [...new Set((data&&data.routes||[]).filter(function(r){return r.enabled;}).map(function(r){return r.slug;}))].sort().map(function(slug){return {value:slug,label:slug};}); }
async function refreshTierSlugSelect(){ const select=document.getElementById('tier-slugs'); if(!select)return; const opts=await publicModelOptions(); select.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>';}).join('')||'<option disabled>No enabled public models</option>'; }
async function tierOptions(){ const {data}=await api('/admin/model-tiers'); return (data&&data.tiers||[]).map(function(t){return {value:String(t.id),label:t.name+' - '+t.models};}); }
async function refreshKeyTierSelect(){
  const select=document.getElementById('k-tiers'); if(!select) return;
  const opts=await tierOptions(); const selected=new Set(Array.from(select.selectedOptions).map(function(o){return o.value;}));
  select.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'"'+(selected.has(o.value)?' selected':'')+'>'+esc(o.label)+'</option>';}).join('') || '<option disabled>No tiers created yet</option>';
}
async function loadTiers(){
  const el=document.getElementById('tiers-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/model-tiers'); data=res.data; }catch(e){ paintLoadError(el,'Could not load tiers: '+e.message,loadTiers); return; }
  const tiers=(data&&data.tiers)||[];
  const rows=tiers.map(function(t){return '<tr><td><b>'+esc(t.name)+'</b></td><td class="mono">'+esc(t.models)+'</td><td>'+fmt(t.key_count)+' keys</td><td><button class="ghost" data-act="tieredit" data-id="'+t.id+'">edit</button> <button class="danger" data-act="tierdel" data-id="'+t.id+'">delete</button></td></tr>';}).join('')||'<tr><td colspan="4"><div class="empty">No tiers yet.</div></td></tr>';
  el.innerHTML='<table><tr><th>Tier</th><th>Public models</th><th>Assigned</th><th></th></tr>'+rows+'</table>';
  try{ await Promise.all([refreshKeyTierSelect(),refreshTierSlugSelect()]); }catch(e){ toast('Could not refresh tier selects: '+e.message,'err'); }
}
async function editTier(id){
  const {data}=await api('/admin/model-tiers'); const t=(data&&data.tiers||[]).find(function(x){return Number(x.id)===Number(id);}); if(!t)return toast('tier not found','err');
  const opts=await publicModelOptions();
  openModal('Edit model tier',[{key:'name',label:'Tier name',value:t.name},{key:'models',type:'multiselect',label:'Public model slugs',value:t.models.split(',').map(function(s){return s.trim();}),options:opts}],async function(v){const {status,data:r}=await api('/admin/model-tiers/'+id,{method:'PATCH',body:JSON.stringify(v)});if(status===200){toast('tier updated','ok');closeModal();loadTiers();}else toast('update failed: '+(r&&r.error&&r.error.message||status),'err');});
}
async function delTier(id){confirmAction('Delete tier','Delete this tier? It will be removed from assigned keys.','Delete',async function(){const {status}=await api('/admin/model-tiers/'+id,{method:'DELETE'});if(status===200){toast('tier deleted','ok');loadTiers();}else toast('delete failed','err');});return;}
document.getElementById('tier-create').onclick=async function(){const body={name:document.getElementById('tier-name').value,models:Array.from(document.getElementById('tier-slugs').selectedOptions).map(function(o){return o.value;})};const {status,data}=await api('/admin/model-tiers',{method:'POST',body:JSON.stringify(body)});if(status===201){document.getElementById('tier-name').value='';Array.from(document.getElementById('tier-slugs').options).forEach(function(o){o.selected=false;});toast('tier created','ok');loadTiers();}else toast('create failed: '+(data&&data.error&&data.error.message||status),'err');};

// ---------- KEYS ----------
function localExpiryValue(iso){
  try { return isoToUaeLocalInput(iso); } catch(e) { return ''; }
}
function expiryLabel(iso){
  if(!iso) return '<span class="pill mut">never</span>';
  let label=''; let ms=NaN;
  try { label=esc(formatUaeTime(iso)); ms=new Date(iso).getTime(); } catch(e) { return '<span class="pill bad">invalid</span>'; }
  return ms<=Date.now()?'<span class="pill bad">expired</span><div class="small">'+label+'</div>':'<span class="pill warn">expires</span><div class="small">'+label+'</div>';
}
async function loadKeys(){
  const el=document.getElementById('keys-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/keys'); data=res.data; }catch(e){ paintLoadError(el,'Could not load keys: '+e.message,loadKeys); return; }
  try{ await refreshKeyTierSelect(); }catch(e){ toast('Could not refresh tier selects: '+e.message,'err'); }
  const rows=(data&&data.keys||[]).map(function(k){
    const used=k.budget_mode==='usd'?money(k.used_usd):fmt(k.used_tokens);
    const lim=k.budget_mode==='usd'?money(k.budget_limit):fmt(k.budget_limit);
    const am=k.allowed_models?esc(k.allowed_models):'<span class="pill mut">no extras</span>';
    const tiers=k.tier_names?esc(k.tier_names):'<span class="pill mut">none</span>';
    const excludes=k.excluded_models?esc(k.excluded_models):'<span class="pill mut">none</span>';
    const rpm=k.request_limit_per_minute?fmt(k.request_limit_per_minute)+'/min':'<span class="pill mut">unlimited</span>';
    const expiry=expiryLabel(k.expires_at);
    const active=(!k.active?'<span class="pill bad">off</span>':(k.expires_at&&new Date(k.expires_at).getTime()<=Date.now()?'<span class="pill bad">expired</span>':'<span class="pill ok">active</span>'));
    return '<tr><td><b>'+esc(k.name)+'</b><div class="mono small">'+esc(k.key_id)+'</div></td><td>'+used+' / '+lim+'</td><td>'+rpm+'</td><td>'+fmt(k.request_count)+'</td><td>'+tiers+'</td><td>'+am+'</td><td>'+excludes+'</td><td>'+expiry+'</td><td>'+active+'</td>'+
      '<td><button class="ghost" data-act="copy" data-id="'+esc(k.key_id)+'">copy</button> <button class="ghost" data-act="kedit" data-id="'+esc(k.key_id)+'">edit</button> <button class="ghost" data-act="ktoggle" data-id="'+esc(k.key_id)+'" data-active="'+(k.active?1:0)+'">'+(k.active?'deact':'act')+'</button> <button class="danger" data-act="kdel" data-id="'+esc(k.key_id)+'">del</button></td></tr>';
  }).join('') || '<tr><td colspan="10"><div class="empty">No keys yet.</div></td></tr>';
  el.innerHTML='<table><tr><th>Key</th><th>Budget</th><th>Rate</th><th>Reqs</th><th>Tiers</th><th>Extra allow</th><th>Excludes</th><th>Expiry</th><th>State</th><th></th></tr>'+rows+'</table>';
}
async function toggleKey(id, active){ await api('/admin/keys/'+id+'/'+(active?'activate':'deactivate'),{method:'POST'}); loadKeys(); }
async function delKey(id){ confirmAction('Delete API key','Delete '+id+'? Clients using it stop working immediately.','Delete',async function(){ await api('/admin/keys/'+id,{method:'DELETE'}); loadKeys(); }); return; }
document.getElementById('k-create').onclick=async function(){
  const rpm=document.getElementById('k-rpm').value;
  const rawExpiry=document.getElementById('k-expiry').value;
  let expires_at=null;
  if(rawExpiry){ try { expires_at=uaeLocalInputToIso(rawExpiry); } catch(e) { return toast('invalid UAE expiry','err'); } }
  const tier_ids=Array.from(document.getElementById('k-tiers').selectedOptions).map(function(o){return Number(o.value);});
  const body={name:document.getElementById('k-name').value, budget_mode:document.getElementById('k-mode').value, budget_limit:Number(document.getElementById('k-limit').value), request_limit_per_minute:rpm===''?0:Number(rpm), expires_at, tier_ids, allowed_models:document.getElementById('k-models').value, excluded_models:document.getElementById('k-excludes').value};
  if(!body.name||!body.budget_limit){ toast('name + limit required','err'); return; }
  const {status,data}=await api('/admin/keys',{method:'POST',body:JSON.stringify(body)});
  if(status===201){ document.getElementById('k-out').innerHTML='<b>Key:</b> <span class="mono">'+esc(data.key)+'</span>'; toast('key created','ok'); loadKeys(); }
  else toast('create failed: '+(data&&data.error&&data.error.message||status),'err');
};

// ---------- CHAT ----------
let pgMessages=[];
function playgroundDefaultMessages(){ return []; }
function setPlaygroundStatus(text){ const el=document.getElementById('c-status'); if(el) el.textContent=text; }
function renderPlaygroundMessages(messages){
  const el=document.getElementById('c-chat'); if(!el) return; el.innerHTML='';
  if(!messages.length){ el.innerHTML='<div class="empty">Send a message to start a run.</div>'; return; }
  messages.forEach(function(m){ appendPlaygroundMessage(m.role, m.content, m.meta); });
}
function appendPlaygroundMessage(role, text, meta){
  const el=document.getElementById('c-chat'); if(!el) return;
  const empty=el.querySelector('.empty'); if(empty) empty.remove();
  const d=document.createElement('div'); d.className='pg-msg '+(role==='user'?'user':'assistant');
  const who=document.createElement('div'); who.className='who'; who.textContent=role==='user'?'You':'Assistant';
  const body=document.createElement('div'); body.className='pg-body'; body.textContent=text||'(no content)';
  d.appendChild(who); d.appendChild(body);
  if(meta){ const me=document.createElement('div'); me.className='pg-meta'; me.textContent=meta; d.appendChild(me); }
  el.appendChild(d); el.scrollTop=el.scrollHeight;
  return d;
}
function appendStreamingMessage(){
  const d=appendPlaygroundMessage('assistant','',null); d.classList.add('streaming');
  const body=d.querySelector('.pg-body'); body.textContent='…';
  return { el:d, append:function(chunk){ if(body.textContent==='…') body.textContent=''; body.textContent+=chunk; const box=document.getElementById('c-chat'); box.scrollTop=box.scrollHeight; }, done:function(){ d.classList.remove('streaming'); } };
}
async function refreshPlaygroundModels(){
  const select=document.getElementById('c-model'); if(!select)return;
  const selected=select.value; const opts=await publicModelOptions();
  select.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'"'+(o.value===selected?' selected':'')+'>'+esc(o.label)+'</option>';}).join('') || '<option value="">No enabled public models</option>';
  if(!select.value&&select.options.length&&select.options[0].value) select.value=select.options[0].value;
}
document.getElementById('c-send').onclick=async function(){ await sendPlaygroundMessage(); };
document.getElementById('c-prompt').addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); sendPlaygroundMessage(); } });
document.getElementById('c-clear').onclick=function(){
  pgMessages=[];
  document.getElementById('c-messages').value=JSON.stringify(playgroundDefaultMessages(),null,2);
  document.getElementById('c-prompt').value='';
  renderPlaygroundMessages([]); setPlaygroundStatus('Ready when you are.');
};
let pgLastRun=null;
let pgBusy=false;
function pgRateMeta(elapsedMs, totalTokens){
  const s=elapsedMs/1000; const tps=s>0&&totalTokens?Math.round(totalTokens/s):null;
  return s.toFixed(1)+'s'+(tps!=null?' · '+tps+' tok/s':'');
}
document.getElementById('c-redo').onclick=async function(){
  if(!pgLastRun){ toast('nothing to redo yet','err'); return; }
  await sendPlaygroundMessage(pgLastRun.prompt, pgLastRun.history);
};
async function sendPlaygroundMessage(promptOverride, historyOverride){
  const modelEl=document.getElementById('c-model'); const model=modelEl?modelEl.value.trim():'';
  const streamBox=document.getElementById('c-stream'); const stream=streamBox?streamBox.checked:false;
  const promptEl=document.getElementById('c-prompt'); const prompt=String(promptOverride!=null?promptOverride:(promptEl?promptEl.value:'')).trim();
  if(!model){ toast('choose a model','err'); return; }
  if(!prompt){ toast('write a prompt first','err'); return; }
  if(pgBusy){ toast('a run is already in flight','err'); return; }
  pgBusy=true;
  const sendBtn=document.getElementById('c-send'); if(sendBtn) sendBtn.disabled=true;
  let history;
  if(historyOverride) history=historyOverride;
  else { try{ history=JSON.parse(document.getElementById('c-messages').value); if(!Array.isArray(history)) throw new Error('array'); }
  catch(e){ toast('Request JSON must be a messages array','err'); return; } }
  const messages=history.concat([{role:'user',content:prompt}]);
  document.getElementById('c-messages').value=JSON.stringify(messages,null,2);
  if(promptEl) promptEl.value='';
  pgMessages=messages; renderPlaygroundMessages(messages);
  pgLastRun={prompt:prompt,history:history.slice(),model:model,stream:stream};
  const requestId=Math.random().toString(36).slice(2);
  setPlaygroundStatus('Running '+model+(stream?' (streaming)':'')+'…');
  const startedAt=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
  const elapsed=function(){ return (((typeof performance!=='undefined'&&performance.now)?performance.now():Date.now())-startedAt)/1000; };
  try{
    const r=await fetch(API+'/admin/playground/completions',{method:'POST',headers:{'Content-Type':'application/json','x-request-id':requestId},credentials:'same-origin',body:JSON.stringify({model:model,messages:messages,stream:stream})});
    const usage=r.headers.get('x-gateway-used-usd')?('used '+r.headers.get('x-gateway-used-tokens')+' tokens / '+r.headers.get('x-gateway-used-usd')+' USD'):null;
    if(!r.ok){ const t=await r.text(); appendPlaygroundMessage('assistant','Request failed (HTTP '+r.status+'): '+t.slice(0,1200),'request '+requestId+' · '+elapsed().toFixed(1)+'s'); setPlaygroundStatus('Failed: HTTP '+r.status); return; }
    if(stream){
      const handle=appendStreamingMessage();
      const reader=r.body.getReader(); const dec=new TextDecoder(); let buf='', out='', su=null;
      while(true){ const res=await reader.read(); if(res.done)break; buf+=dec.decode(res.value,{stream:true});
        let i; while((i=buf.indexOf(NL))>=0){ const line=buf.slice(0,i).trim(); buf=buf.slice(i+1);
          if(line.indexOf('data:')===0){ const d=line.slice(5).trim(); if(d==='[DONE]')continue; try{ const o=JSON.parse(d); out+=(o.choices&&o.choices[0]&&o.choices[0].delta&&o.choices[0].delta.content||''); handle.append(o.choices&&o.choices[0]&&o.choices[0].delta&&o.choices[0].delta.content||''); if(o.usage) su=o.usage; }catch(e){} } } }
      handle.done();
      const toks=su?(su.total_tokens||((su.prompt_tokens||0)+(su.completion_tokens||0)))||null:null;
      const meta=pgRateMeta(elapsed()*1000,toks)+(usage?' · '+usage:'');
      pgMessages=messages.concat([{role:'assistant',content:out||'(no content)',meta:meta}]);
      appendPlaygroundMessage('assistant',out||'(no content)',meta);
      document.getElementById('c-messages').value=JSON.stringify(pgMessages,null,2);
    } else {

      const j=await r.json(); const content=(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'(no content)';
      const ju=j.usage||{}; const jt=(ju.total_tokens||((ju.prompt_tokens||0)+(ju.completion_tokens||0)))||null;
      const meta=pgRateMeta(elapsed()*1000,jt)+(usage?' · '+usage:'');
      pgMessages=messages.concat([{role:'assistant',content:content,meta:meta}]);
      appendPlaygroundMessage('assistant',content,meta);
      document.getElementById('c-messages').value=JSON.stringify(pgMessages,null,2);
    }
    setPlaygroundStatus('Complete.');
  }catch(e){ toast('error: '+e.message,'err'); setPlaygroundStatus('Error: '+e.message); }finally{ pgBusy=false; const sb=document.getElementById('c-send'); if(sb) sb.disabled=false; }
};
function pgNow(){ return (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now(); }

// ---------- BATCH TEST ----------
let pgBatchCancel=false;
function renderBatchResults(rows){
  const panel=document.getElementById('c-batch-panel'); const body=document.getElementById('c-batch-results'); const meta=document.getElementById('c-batch-meta');
  if(!panel||!body||!meta) return;
  panel.hidden=false;
  const done=rows.filter(function(r){return r.status!=='running'&&r.status!=='queued';}).length;
  meta.textContent=done+' of '+rows.length+' finished';
  body.innerHTML='<table><tr><th>Model</th><th>Result</th><th>Reply</th><th>Route</th><th>Time</th></tr>'+rows.map(function(r){
    const pill=r.status==='ok'?'<span class="pill ok">ok</span>':r.status==='fail'?'<span class="pill bad">fail</span>':r.status==='running'?'<span class="pill acc">running</span>':'<span class="pill mut">queued</span>';
    return '<tr><td class="mono">'+esc(r.model)+'</td><td>'+pill+(r.http?' <span class="mono small">'+esc(String(r.http))+'</span>':'')+'</td><td>'+esc(r.reply||(r.status==='running'?'…':''))+'</td><td class="mono small">'+esc(r.route||'')+'</td><td class="mono small">'+esc(r.elapsed||'')+'</td></tr>';
  }).join('')+'</table>';
}
document.getElementById('c-batch-close').onclick=function(){ document.getElementById('c-batch-panel').hidden=true; };
document.getElementById('c-batch-cancel').onclick=function(){ pgBatchCancel=true; };
document.getElementById('c-batch').onclick=async function(){
  const models=await publicModelOptions();
  if(!models.length){ toast('no enabled models','err'); return; }
  const promptEl=document.getElementById('c-prompt'); const prompt=String(promptEl?promptEl.value:'').trim();
  if(!prompt){ toast('write the batch prompt first','err'); return; }
  if(pgBusy){ toast('a run is already in flight','err'); return; }
  pgBusy=true; pgBatchCancel=false;
  const batchBtn=document.getElementById('c-batch'); const cancelBtn=document.getElementById('c-batch-cancel');
  if(batchBtn) batchBtn.disabled=true; if(cancelBtn) cancelBtn.style.display='';
  const rows=models.map(function(m){return {model:m.value,status:'queued',reply:'',http:'',route:'',elapsed:''};});
  renderBatchResults(rows);
  setPlaygroundStatus('Batch testing '+rows.length+' models…');
  try{
    for(const row of rows){
      if(pgBatchCancel) break;
      row.status='running'; renderBatchResults(rows);
      const started=pgNow();
      try{
        const requestId=Math.random().toString(36).slice(2);
        const r=await fetch(API+'/admin/playground/completions',{method:'POST',headers:{'Content-Type':'application/json','x-request-id':requestId},credentials:'same-origin',body:JSON.stringify({model:row.model,messages:[{role:'user',content:prompt}],stream:false})});
        row.elapsed=((pgNow()-started)/1000).toFixed(1)+'s'; row.http=r.status;
        const routeRank=r.headers.get('x-gateway-route'); row.route=routeRank==null||routeRank===''?'':'rank '+routeRank;
        if(!r.ok){ const t=await r.text(); row.status='fail'; row.reply='HTTP '+r.status+': '+t.slice(0,160); }
        else{
          const j=await r.json();
          const content=j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content;
          if(content){ row.status='ok'; row.reply=String(content).slice(0,160); }
          else{ row.status='fail'; row.reply='(no content)'; }
        }
      }catch(e){ row.status='fail'; row.reply='error: '+e.message; }
      renderBatchResults(rows);
    }
    const ok=rows.filter(function(r){return r.status==='ok';}).length;
    setPlaygroundStatus(pgBatchCancel?'Batch cancelled: '+ok+' of '+rows.length+' passed.':'Batch complete: '+ok+' of '+rows.length+' passed.');
  }finally{ pgBusy=false; if(batchBtn) batchBtn.disabled=false; if(cancelBtn) cancelBtn.style.display='none'; }
};
function addMsg(who,text){ appendPlaygroundMessage(who==='user'?'user':'assistant',text,null); }

// ---------- CACHE ----------
async function loadCache(){
  const statsEl=document.getElementById('cache-stats'); const polEl=document.getElementById('cache-policy');
  paintSkeleton(statsEl);
  let data; try{ const res=await api('/admin/cache'); data=res.data; }catch(e){ paintLoadError(statsEl,'Could not load cache: '+e.message,loadCache); return; }
  if(!data) return;
  const c=data.cache||{}; const stats=[{k:'Entries',v:fmt(c.entries)},{k:'Hits',v:fmt(c.hits),c:'acc'},{k:'Saved tokens',v:fmt(c.saved_tokens),c:'ok'},{k:'Saved USD',v:money(c.saved_usd),c:'ok'}];
  statsEl.innerHTML=stats.map(function(s){return '<div class="stat"><div class="k">'+s.k+'</div><div class="v '+(s.c||'')+'">'+s.v+'</div></div>';}).join('');
  if(polEl) polEl.textContent=JSON.stringify(data.policy||{},null,2);
}
document.getElementById('cache-refresh').onclick=loadCache;
document.getElementById('cache-purge').onclick=function(){ confirmAction('Purge cache','Purge every protected response cache entry? This cannot be undone.','Purge all',async function(){ const {status,data}=await api('/admin/cache/purge',{method:'POST',body:JSON.stringify({confirm:'PURGE_ALL_CACHE'})}); if(status===200){toast('purged '+data.purged+' entries','ok');loadCache();}else toast('purge failed','err'); }); };

// ---------- prices ----------
document.getElementById('pr-save').onclick=async function(){
  const slug=document.getElementById('pr-slug').value.trim();
  if(!slug){ toast('slug required','err'); return; }
  const body=JSON.stringify({ slug, prompt_per_1m: document.getElementById('pr-prompt').value||0, completion_per_1m: document.getElementById('pr-completion').value||0 });
  const {status,data}=await api('/admin/prices',{method:'POST',body});
  if(status===200){ toast('price saved','ok'); loadPrices(); }
  else toast('save failed: '+(data&&data.error&&data.error.message||status),'err');
};
document.getElementById('pr-sync').onclick=async function(){
  const btn=document.getElementById('pr-sync');
  btn.disabled=true;
  try{
    const {status,data}=await api('/admin/prices/sync-models-dev',{method:'POST'});
    if(status===200){ toast('synced '+(data.matched||0)+' prices'+(data.unmatched?' · '+data.unmatched+' unmatched':''),'ok'); loadPrices(); }
    else toast('sync failed: '+(data&&data.error&&data.error.message||status),'err');
  }catch(e){ toast('sync failed: '+e.message,'err'); }
  finally{ btn.disabled=false; }
};
async function loadPrices(){
  const el=document.getElementById('pr-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/prices'); data=res.data; }catch(e){ paintLoadError(el,'Could not load prices: '+e.message,loadPrices); return; }
  const rows=(data&&data.prices||[]).map(function(p){
    return '<tr><td class="mono">'+esc(p.slug)+'</td><td>'+Number(p.prompt_per_1m||0)+'</td><td>'+Number(p.completion_per_1m||0)+'</td><td>'+(p.currency||'USD')+'</td><td><button class="ghost" data-act="prdel" data-slug="'+esc(p.slug)+'">delete</button></td></tr>';
  }).join('') || '<tr><td colspan="5"><div class="empty">No prices set. Costs will be 0 unless the upstream returns them.</div></td></tr>';
  el.innerHTML='<table><tr><th>Slug</th><th>Prompt $/1M</th><th>Completion $/1M</th><th>Cur</th><th></th></tr>'+rows+'</table>';
}
document.getElementById('pr-list').addEventListener('click',function(e){
  const b=e.target.closest('[data-act="prdel"]'); if(!b) return;
  api('/admin/prices/'+encodeURIComponent(b.dataset.slug),{method:'DELETE'}).then(function(){ loadPrices(); });
});

// ---------- LOGS ----------
let logsAutoTimer=null;
function escLogLine(line,t){ return '<span class="lg-ts">'+esc(t)+'</span> '+esc(line); }
async function loadLogs(){
  const out=document.getElementById('lg-out'); if(!out) return;
  let data; try{ const res=await api('/admin/logs'); data=res.data; }catch(e){ out.textContent='Could not load logs: '+e.message; return; }
  const lines=(data&&data.logs||[]).map(function(l){ return escLogLine(l.m,l.t); });
  out.innerHTML=lines.length?lines.join('\n'):'<span class="small">No log entries yet.</span>';
  out.scrollTop=out.scrollHeight;
}
document.getElementById('lg-refresh').onclick=function(){ loadLogs(); };
document.getElementById('lg-copy').onclick=function(){
  const out=document.getElementById('lg-out'); if(!out) return;
  navigator.clipboard.writeText(out.innerText).then(function(){ toast('copied','ok'); }).catch(function(){ toast('copy failed','err'); });
};
document.getElementById('lg-auto').addEventListener('change',function(e){
  clearInterval(logsAutoTimer); logsAutoTimer=null;
  if(e.target.checked){ logsAutoTimer=setInterval(loadLogs,3000); loadLogs(); }
});

// init
loadOverview();
<\/script>
</body>
</html>`;
export { PLAYGROUND_HTML };
