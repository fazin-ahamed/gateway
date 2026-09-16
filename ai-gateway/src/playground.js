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
  .pg-shell{display:grid;grid-template-columns:280px minmax(0,1fr);gap:16px;align-items:stretch;min-height:calc(100dvh - 120px)}
  .pg-config{display:flex;flex-direction:column;gap:12px}
  .pg-config .card{margin:0}
  .pg-check{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--text)}
  .pg-check input{width:auto;accent-color:var(--accent)}
  .pg-advanced{margin-top:12px;border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 12px;background:var(--surface-deep)}
  .pg-advanced summary{cursor:pointer;font-size:12px;color:var(--muted);font-weight:var(--w-med)}
  .pg-advanced textarea{margin-top:10px;min-height:120px}
  .pg-main{display:grid;grid-template-rows:minmax(0,1fr) auto;gap:12px;min-width:0}
  .pg-chat{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:0;margin:0}
  .pg-chat-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)}
  .pg-messages{flex:1;min-height:280px;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px;background:var(--surface-deep)}
  .pg-msg{max-width:78%;padding:12px 14px;border-radius:10px;line-height:1.55}
  .pg-msg.user{align-self:flex-end;background:rgba(47,212,181,.12);border:1px solid rgba(47,212,181,.28);border-bottom-right-radius:4px}
  .pg-msg.assistant{align-self:flex-start;background:var(--surface-hi);border:1px solid var(--line);border-bottom-left-radius:4px}
  .pg-msg.streaming{border-style:dashed}
  .pg-msg .who{font:10px/1 var(--mono);letter-spacing:.08em;color:var(--muted);margin-bottom:6px}
  .pg-msg.user .who{color:var(--accent)}
  .pg-msg.assistant .who{color:var(--good)}
  .pg-body{white-space:pre-wrap;word-break:break-word}
  .pg-meta{margin-top:8px;font:10px/1.4 var(--mono);color:var(--muted)}
  .pg-composer{display:flex;gap:10px;align-items:flex-end;padding:14px 18px;border-top:1px solid var(--line);background:var(--surface)}
  .pg-composer textarea{flex:1;min-height:52px;max-height:160px;resize:vertical}
  .pg-composer button{flex:0 0 auto;margin-top:0}
  .pg-trace{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:12px 18px;border-top:1px solid var(--line);background:var(--surface)}
  .pg-trace .k{font:9px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  .pg-trace .v{font:12px/1.3 var(--mono);margin-top:4px;word-break:break-all}
  .pg-probe{margin:0;padding:0;overflow:hidden}
  .pg-probe-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
  .pg-probe-body{padding:12px 16px 16px;max-height:280px;overflow:auto}
  .pg-signals{display:flex;flex-direction:column;gap:6px}
  @media (max-width:980px){.pg-shell{grid-template-columns:1fr;min-height:0}.pg-messages{min-height:240px}.pg-msg{max-width:100%}.pg-trace{grid-template-columns:repeat(2,minmax(0,1fr))}}
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
  .tj-chart{display:flex;flex-direction:column;gap:8px}
  .tj-bar{display:grid;grid-template-columns:160px 1fr 80px;gap:10px;align-items:center}
  .tj-bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--muted)}
  .tj-bar-track{height:6px;background:var(--surface-deep);border-radius:3px;overflow:hidden}
  .tj-bar-fill{height:100%;background:var(--accent);border-radius:3px;transition:width var(--dur) var(--ease)}
  .tj-bar-val{text-align:right;font-size:10px;color:var(--muted)}
  .tj-steps{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0}
  .tj-step{padding:8px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-deep)}
  .tj-step.ok{border-color:rgba(62,201,140,.3)}
  .tj-step.bad{border-color:rgba(228,91,91,.3)}
  .tj-step.mut{border-color:var(--line)}
  .tj-step .k{font-size:11px;font-weight:600}
  .tj-step .v{font-size:9px;color:var(--muted);margin-top:2px}
  .tj-arrow{color:var(--faint,#4d596a);font-size:12px}
  @media (max-width:620px){.tj-bar{grid-template-columns:1fr;gap:4px}.tj-bar-val{text-align:left}}
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
  <button type="button" data-tab="limits">Limits</button>
  <button type="button" data-tab="trajectories">Trajectories</button>
  <button type="button" data-tab="auto">Auto</button>
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
      <div class="panel-h"><h2 class="sec">Active model limits</h2><button class="ghost" onclick="selectTab('limits')">Edit</button></div>
      <div class="panel-b" id="ov-limits"><span class="small">Loading…</span></div>
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
    <div class="pagehead">
      <div>
        <h2 class="sec">Playground</h2>
        <p class="sub">Chat through the gateway, then verify the slug that actually answered. Probe hits that route only.</p>
      </div>
    </div>
    <div class="pg-shell">
      <aside class="pg-config">
        <div class="card">
          <h2 class="sec" style="margin-top:0">Run</h2>
          <label for="c-model">Model slug</label>
          <select id="c-model"><option value="">Loading enabled models...</option></select>
          <div class="small" id="c-route-hint" style="margin-top:6px">Pick a slug to see its last integrity verdict.</div>
          <label class="pg-check" for="c-stream"><input type="checkbox" id="c-stream"> Stream responses</label>
          <div class="form-actions">
            <button class="act" id="c-verify">Verify this slug</button>
            <button class="ghost" id="c-clear">Clear chat</button>
          </div>
          <div class="form-actions">
            <button class="ghost" id="c-batch">Batch test all models</button>
            <button class="ghost" id="c-batch-cancel" style="display:none">Cancel batch</button>
          </div>
          <p class="hint">Batch sends the current prompt once to every enabled model, non-streaming. Usage is recorded.</p>
          <details class="pg-advanced">
            <summary>Request JSON</summary>
            <textarea id="c-messages">[]</textarea>
          </details>
        </div>
      </aside>
      <div class="pg-main">
        <section class="pg-chat card">
          <header class="pg-chat-head">
            <div>
              <h2 class="sec" style="margin:0">Conversation</h2>
              <div class="small" id="c-status">Ready when you are.</div>
            </div>
            <span class="pill mut" id="c-verdict-pill">unverified</span>
          </header>
          <div class="pg-messages" id="c-chat">
            <div class="empty">Send a message, or verify the slug first.</div>
          </div>
          <div class="pg-trace" id="c-trace">
            <div><div class="k">Request</div><div class="v" id="c-trace-id">—</div></div>
            <div><div class="k">Route</div><div class="v" id="c-trace-route">—</div></div>
            <div><div class="k">Attempts</div><div class="v" id="c-trace-attempts">—</div></div>
            <div><div class="k">Usage</div><div class="v" id="c-trace-usage">—</div></div>
          </div>
          <div class="pg-composer">
            <textarea id="c-prompt" placeholder="Send a prompt through the gateway…"></textarea>
            <button class="ghost" id="c-redo" title="Regenerate the last response">Regenerate</button>
            <button class="act" id="c-send">Send</button>
          </div>
        </section>
        <section class="card pg-probe" id="c-probe-panel">
          <header class="pg-probe-head">
            <div>
              <h2 class="sec" style="margin:0">Integrity</h2>
              <div class="small" id="c-probe-meta">No probe yet for this slug.</div>
            </div>
          </header>
          <div class="pg-probe-body" id="c-probe-body">
            <div class="empty">Verify this slug to fingerprint tokenizer, routing, stack leaks, output ceiling, and knowledge horizon.</div>
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
      </div>
    </div>
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

  <section class="tab" id="tab-limits">
    <div class="pagehead"><div><h2 class="sec">Model limits</h2><p class="sub">Per-model caps by kind (requests, tokens, USD) and period (minute, day, week, month). Combine freely; each combo enforces independently and 0 removes the cap.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Set limit</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Model slug</label><select id="lm-slug"></select></div>
        <div><label>Kind</label><select id="lm-kind"><option value="requests">Requests</option><option value="tokens">Tokens</option><option value="usd">USD spend</option></select></div>
        <div><label>Period</label><select id="lm-period"><option value="minute">Per minute</option><option value="day" selected>Per day</option><option value="week">Per week</option><option value="month">Per month</option></select></div>
        <div><label>Limit value</label><input id="lm-value" type="number" step="any" min="0" placeholder="0 removes"></div>
        <div class="full"><button class="act" id="lm-save">Save limit</button></div>
      </div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="lm-list"></div></div>
  </section>

  <section class="tab" id="tab-auto">
    <div class="pagehead"><div><h2 class="sec">Auto router</h2><p class="sub">The virtual <span class="mono">auto</span> model picks per request: prompt complexity sets a quality floor, then your preference blends cheapest vs best among models that clear it. Health comes from live success rates.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Settings</h2></div><div class="panel-b">
      <label class="pg-check" style="margin:0 0 14px"><input type="checkbox" id="ar-enabled"> Enable auto routing</label>
      <label>Preference: <span id="ar-pref-val" class="mono">70</span> (0 = best quality, 100 = cheapest)</label>
      <input type="range" id="ar-pref" min="0" max="100" step="5" value="70" style="margin-bottom:14px">
      <div class="form-grid">
        <div><label>Excluded models</label><select id="ar-excluded" multiple size="6"></select><small>Hold Ctrl/Cmd to pick several. Selected models never receive auto traffic.</small></div>
        <div><label>Quality override</label>
          <div class="form-grid" style="grid-template-columns:1fr 100px;gap:8px">
            <select id="ar-ov-slug"></select>
            <input id="ar-ov-mult" type="number" step="0.1" min="0.1" placeholder="1.5">
          </div>
          <small>Multiplier for the picked model (1 = catalog score). Applied instantly on save.</small>
          <div class="form-actions"><button class="ghost" id="ar-ov-add">Add / update override</button></div>
          <div id="ar-ov-list" style="margin-top:10px"></div>
        </div>
      </div>
      <div class="form-actions"><button class="act" id="ar-save">Save settings</button></div>
    </div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Preview</h2></div><div class="panel-b">
      <label>Test prompt</label>
      <textarea id="ar-test" placeholder="Paste a prompt to see which model auto would pick and why"></textarea>
      <div class="form-actions"><button class="act" id="ar-run">Run preview</button></div>
      <div id="ar-result" style="margin-top:14px"></div>
    </div></div>
  </section>

  <section class="tab" id="tab-trajectories">
    <div class="pagehead"><div><h2 class="sec">Trajectories</h2><p class="sub">Every request with its full multi-turn conversation, tool calls, and route chain. Exports are industry-standard training formats with tool traffic preserved.</p></div><div class="actions"><button class="ghost" id="tj-export-openai" title="OpenAI fine-tuning messages format">OpenAI</button><button class="ghost" id="tj-export-sharegpt" title="ShareGPT conversations format">ShareGPT</button><button class="ghost" id="tj-export-trl" title="HuggingFace TRL conversational format">TRL</button><button class="ghost" id="tj-export-rl" title="RL episode: prompt, completion, reward slot">RL</button><button class="ghost" id="tj-refresh">Refresh</button><button class="danger" id="tj-purge">Purge</button></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Settings</h2></div><div class="panel-b">
      <label class="pg-check" style="margin:0"><input type="checkbox" id="tj-capture"> Capture trajectories</label>
      <p class="hint">Bodies are capped at 128KB per side and secrets are stripped. Turn off to record nothing.</p>
    </div></div>
    <div class="hero-stats" id="tj-stats"></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Latency by model</h2></div><div class="panel-b" id="tj-chart"></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Recent requests</h2></div><div class="panel-b flush" id="tj-list"></div></div>
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
    if(t==='chat'){ await refreshPlaygroundModels(); await refreshPlaygroundIntegrity(); }
    if(t==='cache') await loadCache();
    if(t==='prices') await loadPrices();
    if(t==='limits') await loadLimits();
    if(t==='auto') await loadAutoSettings();
    if(t==='trajectories') await loadTrajectories();
    if(t==='logs') await loadLogs();
  }catch(e){ toast('Could not load '+t+': '+e.message,'err'); }
}
document.querySelector('nav').addEventListener('click',function(e){
  const b=e.target.closest('button[data-tab]'); if(!b) return;
  selectTab(b.dataset.tab);
});

// ---------- modal helper ----------
let modalSubmit=null;
function openModal(title, fields, onSubmit, saveLabel, onReady){
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
    inp.dataset.key=f.key;
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
  if(onReady) onReady(vals, body);
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
    {k:'Cache hits', v:fmt((data.cache||{}).hits||0), c:'', s:fmt((data.cache||{}).entries||0)+' entries · '+money((data.cache||{}).saved_usd||0)+' saved'},
    {k:'API keys', v:fmt((data.keys||[]).length), c:'', s:'configured'},
    {k:'Providers', v:fmt((data.providers||[]).length), c:'', s:'configured'}
  ];
  statsEl.innerHTML=stats.map(function(s){return '<div class="stat"><div class="k">'+esc(s.k)+'</div><div class="v '+(s.c||'')+'">'+esc(s.v)+'</div><div class="sub2">'+esc(s.s||'')+'</div></div>';}).join('');
  document.getElementById('recent').innerHTML='<div class="empty" style="margin:20px">Usage totals update after each request. Provider health is live.</div>';
  const ps=(data.providers||[]);
  document.getElementById('ov-providers').innerHTML = ps.length ? ps.map(function(p){
    const ok=(p.healthy&&p.last_status&&p.last_status>=200&&p.last_status<400); const cls=ok?'ok':(p.healthy?'warn':'bad');
    const label=ok?'healthy':(!p.healthy?'disabled':('HTTP '+(p.last_status||'-')));
    return '<div class="kvrow"><span class="pill '+cls+'">'+label+'</span><span class="grow">'+esc(p.name)+'</span><span class="mono small right">'+esc(p.route_count||0)+' routes</span></div>';
  }).join('') : '<div class="empty">No providers.</div>';
  const limEl=document.getElementById('ov-limits');
  const lims=(data.limits||[]); const usageList=data.limit_usage||[];
  limEl.innerHTML = lims.length ? lims.map(function(l){
    const used=(usageList.find(function(u){return u.slug===l.slug&&u.kind===l.kind&&u.period===l.period;})||{}).used||0;
    const pct=l.limit_value>0?Math.min(100,Math.round(100*used/l.limit_value)):0;
    const near=pct>=80;
    const val=l.kind==='usd'?money(l.limit_value):fmt(l.limit_value);
    const usedStr=l.kind==='usd'?money(used):fmt(used);
    const period=l.period==='minute'?'min':l.period;
    return '<div class="kvrow"><span class="pill '+(near?'warn':'acc')+'">'+esc(l.slug)+'</span><span class="grow small">'+esc(l.kind)+' / '+esc(period)+' · cap '+esc(val)+'</span><span class="mono small right">'+esc(usedStr)+(l.limit_value>0?' ('+pct+'%)':'')+'</span></div>';
  }).join('') : '<div class="empty">No model limits configured. Set them in Limits.</div>';
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
var PROVIDER_FMT_OPTIONS=[{value:'openai',label:'OpenAI compatible'},{value:'anthropic',label:'Anthropic'},{value:'zaiminted',label:'Z.ai web chat (minted, no browser)'},{value:'zaiwebbrowser',label:'Z.ai web chat (browser)'},{value:'zaiweb',label:'Z.ai web chat (HTTP + captcha proof)'}];
// Applies a provider preset to the open provider form: fills the copy the
// preset owns and reveals the route fields, so a known upstream is two clicks
// in the console instead of a hand-typed base_url + fmt + slugs.
var PRESET_FIELD_KEYS=['name','base_url','fmt','transport','api_key','header_preset','extra_headers','seed_routes','preset_slug','preset_upstream','preset_slug2','preset_upstream2'];
function presetRow(vals,key){
  const el=vals[key]; return el?(el.closest('div')||el.parentNode):null;
}
function applyProviderPreset(vals,preset){
  const custom=!preset||preset.id==='custom';
  const set=function(key,value){ if(vals[key]) vals[key].value=value; };
  if(custom){
    set('name',''); set('base_url',''); set('fmt','openai'); set('transport','auto');
    set('preset_slug',''); set('preset_upstream',''); set('preset_slug2',''); set('preset_upstream2','');
    if(vals.api_key){ vals.api_key.value=''; vals.api_key.placeholder='sk-... (stored in DB)'; }
    if(vals.extra_headers) vals.extra_headers.value='';
  } else {
    if(preset.name) set('name',preset.name);
    if(preset.base_url) set('base_url',preset.base_url);
    if(preset.fmt) set('fmt',preset.fmt);
    if(preset.transport) set('transport',preset.transport);
    if(preset.extra_headers) set('extra_headers',preset.extra_headers);
    if(vals.api_key){ vals.api_key.value=''; if(preset.credential_hint) vals.api_key.placeholder=preset.credential_hint; }
    const routes=preset.routes||[];
    const r0=routes[0]||{};
    const r1=routes[1]||{};
    set('preset_slug',r0.slug||'');
    set('preset_upstream',r0.upstream_model||'');
    set('preset_slug2',r1.slug||'');
    set('preset_upstream2',r1.upstream_model||'');
  }
  set('seed_routes','1');
  PRESET_FIELD_KEYS.forEach(function(key){
    const row=presetRow(vals,key);
    if(!row) return;
    const optional=row.getAttribute('data-preset-optional')==='1';
    if(optional) row.style.display=custom?'none':'';
  });
  if(vals.preset) vals.preset.value=preset&&preset.id?preset.id:'custom';
}
function bindPresetPicker(vals,presets){
  if(!vals.preset) return;
  vals.preset.addEventListener('change',function(){
    const preset=presets.find(function(p){ return p.id===vals.preset.value; })||{id:'custom'};
    applyProviderPreset(vals,preset);
  });
}
async function addProvider(){
  let presets=[];
  try{ presets=((await api('/admin/provider-presets')).data.presets)||[]; }catch(e){}
  const options=[{value:'custom',label:'Custom / other provider'}].concat(presets.map(function(p){ return {value:p.id,label:p.label}; }));
  const first=presets[0];
  openModal('Add provider',[
    {key:'preset',label:'Preset',type:'select',value:'custom',options:options,hint:first?('Presets fill this form and seed routes for the usual model ids. '+first.label+': '+first.summary):'Pick a preset or fill the fields yourself.'},
    {key:'name',label:'Name',value:first?first.name:'',placeholder:'OpenRouter'},
    {key:'base_url',label:'Base URL',value:first?first.base_url:'',placeholder:'https://api.example.com/v1'},
    {key:'api_key',label:'Credential',type:'password',placeholder:(first&&first.credential_hint)||'sk-... (stored in DB)'},
    {key:'fmt',label:'Format',type:'select',value:first?first.fmt:'openai',options:PROVIDER_FMT_OPTIONS},
    {key:'priority',label:'Priority (lower = first)',type:'number',value:'0'},
    {key:'proxy_url',label:'OCI proxy URL (rollback only)',placeholder:'http://user:pass@host:8080'},
    {key:'transport',label:'Transport',type:'select',value:(first&&first.transport)||'auto',options:[{value:'auto',label:'Auto (direct unless relay needed)'},{value:'direct',label:'Direct from Worker'},{value:'koyeb',label:'Koyeb relay'},{value:'oci',label:'OCI relay (rollback)'}]},
    {key:'header_preset',label:'Header preset',type:'select',value:'none',options:HEADER_PRESET_OPTIONS},
    {key:'extra_headers',label:'Extra upstream headers',type:'textarea',placeholder:'HTTP-Referer: https://example.com\\nX-Title: My app',hint:'One Name: value per line. Sent to this provider on every request. Auth and content headers are managed automatically.'},
    {key:'seed_routes',label:'Seed preset routes',type:'select',value:'1',options:[{value:'1',label:'Yes — add the preset model routes'},{value:'0',label:'No — provider only'}],hint:'Routes are only added for slugs that do not already have an enabled route.'},
    {key:'preset_slug',label:'Primary route slug',placeholder:'z-ai/glm-5.3'},
    {key:'preset_upstream',label:'Primary upstream model',placeholder:'glm-5.3'},
    {key:'preset_slug2',label:'Fallback route slug (optional)',placeholder:'z-ai/glm-5.3-flash'},
    {key:'preset_upstream2',label:'Fallback upstream model (optional)',placeholder:'glm-5.3-flash'}
  ], async function(v){
    applyHeaderPreset(v);
    if(v.seed_routes==='1'){
      v.routes=[];
      if((v.preset_slug||'').trim() && (v.preset_upstream||'').trim()) v.routes.push({slug:v.preset_slug.trim(),upstream_model:v.preset_upstream.trim()});
      if((v.preset_slug2||'').trim() && (v.preset_upstream2||'').trim()) v.routes.push({slug:v.preset_slug2.trim(),upstream_model:v.preset_upstream2.trim()});
    }
    delete v.seed_routes; delete v.preset_slug; delete v.preset_upstream; delete v.preset_slug2; delete v.preset_upstream2;
    const {status,data}=await api('/admin/providers',{method:'POST',body:JSON.stringify(v)});
    if(status===201){
      const added=(data.routes||[]);
      const skipped=(data.routes_skipped||[]);
      let msg='provider created (id '+data.id+')';
      if(added.length) msg+=' — routes: '+added.join(', ');
      if(skipped.length) msg+=' — kept existing: '+skipped.join(', ');
      toast(msg,'ok'); closeModal(); loadProviders();
    }
    else toast('create failed: '+(data&&data.error&&data.error.message||status),'err');
  }, undefined, function(vals,body){
    ['proxy_url','header_preset','extra_headers','seed_routes','preset_slug','preset_upstream','preset_slug2','preset_upstream2'].forEach(function(key){
      const row=presetRow(vals,key); if(row) row.setAttribute('data-preset-optional','1');
    });
    applyProviderPreset(vals,first||{id:'custom'});
    PRESET_FIELD_KEYS.concat(['preset']).forEach(function(key){
      const row=presetRow(vals,key);
      if(row) row.setAttribute('data-preset-field',key);
    });
    bindPresetPicker(vals,presets);
  });
};
async function editProvider(id){
  const {data}=await api('/admin/providers'); const p=(data.providers||[]).find(function(x){return x.id==id;}); if(!p) return;
  openModal('Edit provider',[
    {key:'name',label:'Name',value:p.name},
    {key:'base_url',label:'Base URL',value:p.base_url},
    {key:'api_key',label:'API Key',type:'password',placeholder: p.api_key_set ? '(saved; leave blank to keep)' : 'sk-... (stored in DB)'},
    {key:'fmt',label:'Format',type:'select',value:p.fmt,options:PROVIDER_FMT_OPTIONS},
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
// Operator off-switch: takes the provider fully out of rotation (distinct from
// marking it down). Reports which slugs just went dark.
async function switchProvider(id, enabled){
  try{
    const {status,data}=await api('/admin/providers/'+id+(enabled?'/enable':'/disable'),{method:'POST'});
    if(status!==200){ toast((data&&data.error&&data.error.message)||'switch failed','err'); return; }
    const slugs=(data&&data.slugs)||[];
    toast((enabled?'provider enabled':'provider disabled')+(slugs.length?' — affects '+slugs.join(', '):''),'ok');
    loadProviders();
  }catch(e){ toast('switch failed: '+e.message,'err'); }
}
// Model-integrity probe: show what the provider really serves. The verdict and
// per-probe signals come straight from /admin/providers/:id/integrity.
var PROBE_LEVEL_CLASS={alert:'bad',warn:'warn',ok:'ok',inconclusive:'mut',info:'mut'};
function verdictClass(verdict){
  if(verdict==='MULTI-MODEL RELAY'||verdict==='TOKENIZER MISMATCH'||verdict==='STACK LEAK') return 'bad';
  if(verdict==='CONSISTENT WITH CLAIM') return 'ok';
  if(verdict==='INCONCLUSIVE') return 'warn';
  return 'mut';
}
async function verifyProvider(id, slug){
  const body=document.getElementById('modal-body');
  document.querySelector('.modal').classList.remove('wide');
  document.getElementById('modal-title').textContent=slug?'Verifying '+slug:'Verifying provider '+id;
  document.getElementById('modal-title').style.color='';
  body.innerHTML='<p class="hint" style="margin:0">Probing '+(slug?esc(slug)+' only':'the first enabled route')+': tokenizer fingerprint, relay routing, identity, declared limits, determinism. This sends a handful of small requests.</p>';
  const save=document.getElementById('modal-save'); save.style.display='none';
  document.getElementById('overlay').classList.add('show');
  let data;
  try{ const res=await api('/admin/providers/'+id+'/integrity',{method:'POST',body:JSON.stringify(slug?{slug:slug}:{limit:1})}); data=res.data; }
  catch(e){ body.innerHTML='<p class="hint" style="margin:0">Probe failed: '+esc(e.message)+'</p>'; save.style.display=''; return; }
  if(data&&data.error){ body.innerHTML='<p class="hint" style="margin:0">'+esc(data.error.message)+'</p>'; save.style.display=''; return; }
  const run=(data.runs||[])[0];
  if(!run){ body.innerHTML='<p class="hint" style="margin:0">No probe result returned.</p>'; save.style.display=''; return; }
  document.getElementById('modal-title').textContent='Integrity: '+run.slug;
  let html='<div class="kvrow"><span class="pill '+verdictClass(run.verdict)+'">'+esc(run.verdict)+'</span>'
    +'<span class="right mono small">'+esc(String(run.elapsed_ms||0))+'ms · '+esc(run.model||'')+'</span></div>';
  if(run.measured_family||run.expected){
    html+='<div class="small mono" style="margin:8px 0">measured '+(esc(run.measured_family||'—'))+' · claimed '+(esc((run.expected&&run.expected.family)||'—'))+(run.tokenize&&run.tokenize.exactMatches&&run.tokenize.exactMatches.length?' · exact token-ID match':'')+'</div>';
  }
  html+='<h3 class="sec" style="margin:14px 0 8px;font-size:12px">Signals</h3>';
  html+=(run.signals||[]).map(function(s){
    return '<div class="kvrow"><span class="pill '+(PROBE_LEVEL_CLASS[s.level]||'mut')+'">'+esc(s.kind)+'</span><span class="grow small">'+esc(s.text)+'</span></div>';
  }).join('')||'<div class="empty">No signals.</div>';
  if(run.slope&&run.slope.rows&&run.slope.rows.length){
    html+='<h3 class="sec" style="margin:14px 0 8px;font-size:12px">Tokenizer families (ratio ~1.0 = match)</h3>';
    html+='<table><tr><th>Reference</th><th>ratio</th><th></th></tr>'+run.slope.rows.slice(0,6).map(function(r){
      return '<tr><td class="small">'+esc(r.label)+'</td><td class="mono small">'+esc(String(r.ratio))+'</td><td>'+(run.measured_family===r.key?'<span class="pill acc">measured</span>':'')+'</td></tr>';
    }).join('')+'</table>';
  }
  if(run.routing&&run.routing.distinct_models_served&&run.routing.distinct_models_served.length){
    html+='<h3 class="sec" style="margin:14px 0 8px;font-size:12px">Also answered as</h3><div class="small mono">'+run.routing.distinct_models_served.map(esc).join(', ')+'</div>';
  }
  body.innerHTML=html;
  save.style.display='';
  if(slug) loadRoutes();
}

async function delProvider(id){
  confirmAction('Delete provider','Delete provider '+id+' and all of its routes? This cannot be undone.','Delete',async function(){ const {status}=await api('/admin/providers/'+id,{method:'DELETE'}); if(status===200){ toast('provider deleted','ok'); loadProviders(); } else toast('delete failed','err'); });
}
async function loadProviders(){
  const el=document.getElementById('providers-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/providers'); data=res.data; }catch(e){ paintLoadError(el,'Could not load providers: '+e.message,loadProviders); return; }
  const rows=((data&&data.providers)||[]).map(function(p){
    const on=p.enabled===undefined?true:!!p.enabled;
    const ok=p.healthy&&p.last_status&&p.last_status>=200&&p.last_status<400;
    const cls=!on?'bad':(ok?'ok':(p.healthy?'warn':'bad'));
    const state=!on?'DISABLED':(!p.healthy?'down':(p.last_status?('HTTP '+p.last_status):'unprobed'));
    const keys=p.key_count>0?'<span class="pill acc">'+p.key_count+' key'+(p.key_count>1?'s':'')+'</span>':'<span class="pill bad">no key</span>';
    // Two distinct controls: "mark down" flips runtime health (the provider
    // stays listed and probed), "disable" takes it out of rotation entirely.
    const healthBtn=on?('<button class="ghost" data-act="ptoggle" data-id="'+p.id+'" data-h="'+(p.healthy?'1':'0')+'">'+(p.healthy?'mark down':'mark up')+'</button>'):'';
    const switchBtn=on?('<button class="danger" data-act="pdisable" data-id="'+p.id+'" title="Take this provider out of rotation: its slugs stop being advertised and routed">disable</button>'):('<button class="ghost" data-act="penable" data-id="'+p.id+'" title="Put this provider back into rotation">enable</button>');
    return '<tr><td><b>'+esc(p.name)+'</b><div class="small mono">'+esc(p.base_url||'')+'</div></td><td>'+esc(p.fmt||'')+'</td><td>'+esc(p.transport||'auto')+'</td><td>'+keys+'</td><td>'+esc(p.key_strategy||'round_robin')+'</td><td><span class="pill '+cls+'">'+state+'</span></td>'+
      '<td class="rowact"><button class="ghost" data-act="pkeys" data-id="'+p.id+'">keys</button> <button class="ghost" data-act="pedit" data-id="'+p.id+'">edit</button> <button class="ghost" data-act="pverify" data-id="'+p.id+'" title="Probe what this provider really serves: tokenizer fingerprint, relay routing, identity, limits">verify</button> '+healthBtn+' '+switchBtn+' <button class="danger" data-act="pdel" data-id="'+p.id+'">delete</button></td></tr>';
  }).join('')||'<tr><td colspan="7"><div class="empty">No providers yet.</div></td></tr>';
  el.innerHTML='<table><tr><th>Provider</th><th>Format</th><th>Transport</th><th>Keys</th><th>Strategy</th><th>State</th><th></th></tr>'+rows+'</table>';
}
async function manageProviderKeys(id){
  const provs=(await api('/admin/providers')).data.providers||[];
  const prov=provs.find(function(p){return String(p.id)===String(id);});
  if(!prov){ toast('provider not found','err'); return; }
  let keys=[]; try{ keys=(await api('/admin/providers/'+id+'/keys')).data.keys||[]; }catch(e){}
  document.querySelector('.modal').classList.add('wide');
  document.getElementById('modal-title').textContent='Keys: '+prov.name;
  document.getElementById('modal-title').style.color='';
  const body=document.getElementById('modal-body');
  const keyRows=keys.length?keys.map(function(k){
    return '<div class="kvrow"><span class="pill '+(k.enabled?'ok':'mut')+'">'+(k.label||('key '+k.id))+'</span><span class="grow small mono">id '+k.id+' · added '+(k.created_at||'').slice(0,10)+'</span><span class="right"><button class="danger" data-act="pkdel" data-id="'+id+'" data-key="'+k.id+'">remove</button></span></div>';
  }).join(''):'<div class="empty">No keys. Add one below.</div>';
  body.innerHTML=
    '<label>Rotation strategy</label><select id="pk-strategy">'+
      '<option value="round_robin"'+(prov.key_strategy==='round_robin'?' selected':'')+'>Round robin</option>'+
      '<option value="failover"'+(prov.key_strategy==='failover'?' selected':'')+'>Failover (first key, then next on auth error)</option>'+
      '<option value="random"'+(prov.key_strategy==='random'?' selected':'')+'>Random</option>'+
    '</select>'+
    '<h3 class="sec" style="margin:16px 0 8px;font-size:12px">Keys</h3>'+keyRows+
    '<h3 class="sec" style="margin:16px 0 8px;font-size:12px">Add key</h3>'+
    '<div class="form-grid"><div><label>API key</label><input id="pk-new-key" type="password" placeholder="sk-..."></div><div><label>Label</label><input id="pk-new-label" placeholder="backup"></div></div>';
  const save=document.getElementById('modal-save');
  save.textContent='Save key';
  save.style.display='';
  save.classList.remove('danger'); save.classList.add('act');
  modalSubmit=async function(){
    const newKey=document.getElementById('pk-new-key').value.trim();
    const newLabel=document.getElementById('pk-new-label').value.trim();
    const strategy=document.getElementById('pk-strategy').value;
    if(!newKey){ toast('enter a key','err'); return; }
    const {status,data}=await api('/admin/providers/'+id+'/keys',{method:'POST',body:JSON.stringify({api_key:newKey,label:newLabel||null})});
    if(status!==201){ toast('add failed: '+(data&&data.error&&data.error.message||status),'err'); return; }
    await api('/admin/providers/'+id,{method:'PATCH',body:JSON.stringify({key_strategy:strategy})});
    toast('key added, strategy '+strategy,'ok');
    closeModal(); loadProviders();
  };
  document.getElementById('overlay').classList.add('show');
}
document.addEventListener('click',function(e){
  const b=e.target.closest('button[data-act]'); if(!b) return;
  const act=b.getAttribute('data-act');
  if(act==='pkeys'){ manageProviderKeys(b.getAttribute('data-id')); return; }
  if(act==='pkdel'){
    const pid=b.getAttribute('data-id'), kid=b.getAttribute('data-key');
    confirmAction('Remove key','Remove this key from the pool? The provider keeps its other keys.','Remove',async function(){
      const {status,data}=await api('/admin/providers/'+pid+'/keys/'+kid,{method:'DELETE'});
      if(status===200){ toast('key removed','ok'); closeModal(); manageProviderKeys(pid); }
      else toast('remove failed: '+(data&&data.error&&data.error.message||status),'err');
    });
  }
});
document.getElementById('p-add').onclick=function(){ addProvider(); };

// ---------- ROUTES ----------
async function loadRoutes(){
  const el=document.getElementById('routes-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/routes'); data=res.data; }catch(e){ paintLoadError(el,'Could not load routes: '+e.message,loadRoutes); return; }
  const rows=(data.routes||[]).map(function(r){
    // A route can be on while its provider is off: say so, otherwise a slug
    // going dark looks like a routing bug.
    const providerOff=r.provider_enabled===undefined?false:!r.provider_enabled;
    const cls=(r.enabled&&r.provider_healthy&&!providerOff)?'ok':'bad';
    const label=r.enabled?(providerOff?'<span class="pill bad">provider disabled</span>':(r.provider_healthy?'on':'<span class="pill bad">provider down</span>')):'off';
    const role=r.rank===0?'<span class="pill acc">primary</span>':'<span class="pill mut">fallback '+esc(String(r.rank))+'</span>';
    const verdict=r.probe_verdict
      ? '<span class="pill '+verdictClass(r.probe_verdict)+'" title="'+(r.probe_measured_family?('measured '+r.probe_measured_family):'')+'">'+esc(r.probe_verdict)+'</span>'
      : '<span class="pill mut">unverified</span>';
    return '<tr><td class="mono">'+esc(r.slug)+'</td><td>'+role+' <span class="mono small">rank '+esc(String(r.rank))+'</span></td><td>'+esc(r.provider_name||'')+'</td><td class="mono small">'+esc(r.upstream_model)+'</td><td><span class="pill '+cls+'">'+label+'</span></td><td>'+verdict+'</td>'+
      '<td class="rowact"><button class="ghost" data-act="rverify" data-id="'+esc(String(r.provider_id))+'" data-slug="'+esc(r.slug)+'" title="Probe this slug only: tokenizer fingerprint, relay routing, identity, limits">verify</button> <button class="ghost" data-act="raddfb" data-slug="'+esc(r.slug)+'" data-provider="'+esc(String(r.provider_id))+'" data-model="'+esc(r.upstream_model)+'" data-rank="'+esc(String(r.rank))+'">add fallback</button> <button class="ghost" data-act="redit" data-id="'+r.id+'">edit</button> <button class="ghost" data-act="rtoggle" data-id="'+r.id+'" data-e="'+r.enabled+'">'+(r.enabled?'disable':'enable')+'</button> <button class="danger" data-act="rdel" data-id="'+r.id+'">delete</button></td></tr>';
  }).join('') || '<tr><td colspan="7"><div class="empty">No model routes yet.</div></td></tr>';
  el.innerHTML='<table><tr><th>Slug</th><th>Role</th><th>Provider</th><th>Upstream model</th><th>Route</th><th>Integrity</th><th></th></tr>'+rows+'</table>';
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
  else if(act==='pdisable') switchProvider(id, false);
  else if(act==='penable') switchProvider(id, true);
  else if(act==='pverify') verifyProvider(id);
  else if(act==='pdel') delProvider(id);
  else if(act==='redit') editRoute(id);
  else if(act==='rverify') verifyProvider(id, btn.getAttribute('data-slug'));
  else if(act==='raddfb') addFallbackRoute(btn);
  else if(act==='rtoggle') toggleRoute(id, btn.getAttribute('data-e')==='1'?0:1);
  else if(act==='rdel') delRoute(id);
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
function copyKey(id){ try{ navigator.clipboard.writeText(id).then(function(){ toast('key copied','ok'); }); }catch(e){ toast('copy failed','err'); } }
async function editKey(id){
  const {data}=await api('/admin/keys/'+id); const k=data&&data.key; if(!k){ toast('key not found','err'); return; }
  const tierIds=((data&&data.tiers)||[]).map(function(t){return String(t.id);});
  const opts=await tierOptions();
  openModal('Edit key '+k.name,[
    {key:'name',label:'Name',value:k.name},
    {key:'budget_mode',label:'Budget mode',type:'select',value:k.budget_mode,options:[{value:'usd',label:'USD ($)'},{value:'tokens',label:'Tokens'}]},
    {key:'budget_limit',label:'Budget limit',type:'number',value:k.budget_limit},
    {key:'request_limit_per_minute',label:'Request limit / minute (0 = unlimited)',type:'number',value:k.request_limit_per_minute||0},
    {key:'expires_at',label:'Expires at (UAE / GST, blank = never)',value:localExpiryValue(k.expires_at),hint:'UAE time (UTC+4). Clear to make the key never expire.'},
    {key:'tier_ids',label:'Model tiers',type:'multiselect',value:tierIds,options:opts},
    {key:'allowed_models',label:'Extra allowed models (comma list)',value:k.allowed_models||''},
    {key:'excluded_models',label:'Excluded models',value:k.excluded_models||''},
    {key:'active',label:'State',type:'select',value:k.active?'1':'0',options:[{value:'1',label:'active'},{value:'0',label:'deactivated'}]}
  ], async function(v){
    let expires_at=null;
    if(v.expires_at){ try { expires_at=uaeLocalInputToIso(v.expires_at); } catch(e) { return toast('invalid UAE expiry','err'); } }
    const body={name:v.name,budget_mode:v.budget_mode,budget_limit:Number(v.budget_limit),request_limit_per_minute:Number(v.request_limit_per_minute)||0,expires_at,tier_ids:v.tier_ids.map(Number),allowed_models:v.allowed_models,excluded_models:v.excluded_models,active:v.active==='1'};
    const {status,data:r}=await api('/admin/keys/'+id,{method:'PATCH',body:JSON.stringify(body)});
    if(status===200){ toast('key updated','ok'); closeModal(); loadKeys(); }
    else toast('update failed: '+(r&&r.error&&r.error.message||status),'err');
  });
}
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
function setPlaygroundTrace(info){
  const id=document.getElementById('c-trace-id');
  const route=document.getElementById('c-trace-route');
  const attempts=document.getElementById('c-trace-attempts');
  const usage=document.getElementById('c-trace-usage');
  if(id) id.textContent=(info&&info.id)||'—';
  if(route) route.textContent=(info&&info.route)||'—';
  if(attempts) attempts.textContent=(info&&info.attempts)||'—';
  if(usage) usage.textContent=(info&&info.usage)||'—';
}
function setPlaygroundVerdictPill(verdict){
  const pill=document.getElementById('c-verdict-pill'); if(!pill) return;
  const v=verdict||'unverified';
  pill.className='pill '+verdictClass(v==='unverified'?'':v);
  pill.textContent=v;
}
function paintPlaygroundProbe(run, meta){
  const body=document.getElementById('c-probe-body');
  const metaEl=document.getElementById('c-probe-meta');
  if(!body) return;
  if(!run){
    if(metaEl) metaEl.textContent=meta||'No probe yet for this slug.';
    body.innerHTML='<div class="empty">Verify this slug to fingerprint tokenizer, routing, stack leaks, output ceiling, and knowledge horizon.</div>';
    setPlaygroundVerdictPill('unverified');
    return;
  }
  setPlaygroundVerdictPill(run.verdict);
  if(metaEl) metaEl.textContent=(run.slug||'')+' · '+(run.elapsed_ms||0)+'ms'+(run.measured_family?' · measured '+run.measured_family:'');
  let html='<div class="kvrow"><span class="pill '+verdictClass(run.verdict)+'">'+esc(run.verdict)+'</span><span class="right mono small">'+esc(run.model||'')+'</span></div>';
  html+='<div class="pg-signals" style="margin-top:10px">';
  html+=(run.signals||[]).map(function(s){
    return '<div class="kvrow"><span class="pill '+(PROBE_LEVEL_CLASS[s.level]||'mut')+'">'+esc(s.kind)+'</span><span class="grow small">'+esc(s.text)+'</span></div>';
  }).join('')||'<div class="empty">No signals.</div>';
  html+='</div>';
  if(run.leak&&run.leak.leaked) html+='<p class="hint">Stack leak: response.model was '+esc(run.leak.leaked)+'.</p>';
  if(run.ceiling&&run.ceiling.ceiling) html+='<p class="hint">Enforced output cap '+esc(String(run.ceiling.ceiling))+'.</p>';
  body.innerHTML=html;
}
async function refreshPlaygroundIntegrity(){
  const select=document.getElementById('c-model');
  const slug=select?select.value.trim():'';
  const hint=document.getElementById('c-route-hint');
  if(!slug){ if(hint) hint.textContent='Pick a slug to see its last integrity verdict.'; paintPlaygroundProbe(null); return; }
  let data; try{ const res=await api('/admin/routes'); data=res.data; }catch(e){ if(hint) hint.textContent='Could not load routes.'; return; }
  const routes=((data&&data.routes)||[]).filter(function(r){return r.slug===slug;});
  const primary=routes[0];
  if(hint){
    if(!primary) hint.textContent=slug+' has no route.';
    else hint.textContent=(primary.provider_name||'provider')+' · rank '+String(primary.rank)+(routes.length>1?' · '+routes.length+' routes':'');
  }
  if(primary&&primary.probe_verdict){
    paintPlaygroundProbe({ slug:slug, verdict:primary.probe_verdict, measured_family:primary.probe_measured_family, model:primary.upstream_model, signals:[], elapsed_ms:0 });
    const metaEl=document.getElementById('c-probe-meta');
    if(metaEl) metaEl.textContent='Last stored verdict'+(primary.probe_at?' · '+String(primary.probe_at).slice(0,19).replace('T',' '):'')+'. Click Verify to re-probe.';
  } else {
    paintPlaygroundProbe(null, slug+' has not been probed yet.');
  }
}
async function verifyPlaygroundSlug(){
  const select=document.getElementById('c-model');
  const slug=select?select.value.trim():'';
  if(!slug){ toast('choose a model','err'); return; }
  let routesData; try{ routesData=(await api('/admin/routes')).data; }catch(e){ toast('could not load routes','err'); return; }
  const route=((routesData&&routesData.routes)||[]).find(function(r){return r.slug===slug;});
  if(!route){ toast('no route for '+slug,'err'); return; }
  const body=document.getElementById('c-probe-body');
  const metaEl=document.getElementById('c-probe-meta');
  if(metaEl) metaEl.textContent='Probing '+slug+'…';
  if(body) body.innerHTML='<div class="empty">Running tokenizer, routing, stack-leak, ceiling, and cutoff probes.</div>';
  setPlaygroundStatus('Verifying '+slug+'…');
  try{
    const {status,data}=await api('/admin/providers/'+route.provider_id+'/integrity',{method:'POST',body:JSON.stringify({slug:slug})});
    if(status!==200){ toast((data&&data.error&&data.error.message)||('verify failed '+status),'err'); paintPlaygroundProbe(null,'Verify failed.'); return; }
    const run=(data.runs||[])[0];
    paintPlaygroundProbe(run);
    setPlaygroundStatus(run&&run.verdict?run.verdict:'Verify complete.');
    toast(run&&run.verdict?run.verdict:'probed','ok');
  }catch(e){ toast('verify failed: '+e.message,'err'); setPlaygroundStatus('Verify failed.'); }
}
document.getElementById('c-send').onclick=async function(){ await sendPlaygroundMessage(); };
document.getElementById('c-prompt').addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); sendPlaygroundMessage(); } });
document.getElementById('c-clear').onclick=function(){
  pgMessages=[];
  document.getElementById('c-messages').value=JSON.stringify(playgroundDefaultMessages(),null,2);
  document.getElementById('c-prompt').value='';
  renderPlaygroundMessages([]); setPlaygroundStatus('Ready when you are.'); setPlaygroundTrace(null);
};
document.getElementById('c-verify').onclick=function(){ verifyPlaygroundSlug(); };
document.getElementById('c-model').addEventListener('change',function(){ refreshPlaygroundIntegrity(); });
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
  catch(e){ toast('Request JSON must be a messages array','err'); pgBusy=false; if(sendBtn) sendBtn.disabled=false; return; } }
  const messages=history.concat([{role:'user',content:prompt}]);
  document.getElementById('c-messages').value=JSON.stringify(messages,null,2);
  if(promptEl) promptEl.value='';
  pgMessages=messages; renderPlaygroundMessages(messages);
  pgLastRun={prompt:prompt,history:history.slice(),model:model,stream:stream};
  const requestId=Math.random().toString(36).slice(2);
  setPlaygroundStatus('Running '+model+(stream?' (streaming)':'')+'…');
  setPlaygroundTrace({id:requestId,route:'…',attempts:'…',usage:'…'});
  const startedAt=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
  const elapsed=function(){ return (((typeof performance!=='undefined'&&performance.now)?performance.now():Date.now())-startedAt)/1000; };
  try{
    const r=await fetch(API+'/admin/playground/completions',{method:'POST',headers:{'Content-Type':'application/json','x-request-id':requestId},credentials:'same-origin',body:JSON.stringify({model:model,messages:messages,stream:stream})});
    const usedUsd=r.headers.get('x-gateway-used-usd');
    const usedTok=r.headers.get('x-gateway-used-tokens');
    const usage=usedUsd?('used '+usedTok+' tokens / '+usedUsd+' USD'):null;
    const routeRank=r.headers.get('x-gateway-route');
    const attempts=r.headers.get('x-gateway-attempts');
    setPlaygroundTrace({id:requestId,route:routeRank==null||routeRank===''?'—':'rank '+routeRank,attempts:attempts||'—',usage:usage||'—'});
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
  out.innerHTML=lines.length?lines.join('\\n'):'<span class="small">No log entries yet.</span>';
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

// ---------- TRAJECTORIES ----------
async function loadTrajectories(){
  const statsEl=document.getElementById('tj-stats'); const listEl=document.getElementById('tj-list'); const chartEl=document.getElementById('tj-chart');
  paintSkeleton(statsEl);
  let settings=null; try{ settings=(await api('/admin/trajectory-settings')).data; }catch(e){}
  const capBox=document.getElementById('tj-capture'); if(capBox) capBox.checked=!settings||settings.capture!=='off';
  let data; try{ data=(await api('/admin/trajectories?limit=300')).data; }catch(e){ listEl.innerHTML='<div class="empty">Could not load trajectories: '+esc(e.message)+'</div>'; return; }
  const list=(data&&data.trajectories)||[]; const s=(data&&data.stats)||{};
  const okRate=s.total?Math.round(100*(s.ok_count||0)/s.total)+'%':'-';
  statsEl.innerHTML=[
    {k:'Requests',v:fmt(s.total||0),c:''},
    {k:'Success',v:okRate,c:'ok'},
    {k:'Tokens',v:fmt(s.tokens||0),c:'acc'},
    {k:'Cost',v:money(s.cost||0),c:''}
  ].map(function(x){return '<div class="stat"><div class="k">'+x.k+'</div><div class="v '+x.c+'">'+esc(x.v)+'</div></div>';}).join('');
  const byModel={};
  list.forEach(function(t){ if(t.status!=='ok') return; const k=t.slug; (byModel[k]=byModel[k]||[]).push(t.latency_ms||0); });
  const models=Object.keys(byModel).sort();
  if(!models.length){ chartEl.innerHTML='<div class="empty">No recorded requests yet.</div>'; }
  else{
    chartEl.innerHTML='<div class="tj-chart">'+models.map(function(m){
      const lat=byModel[m]; const avg=lat.reduce(function(a,b){return a+b;},0)/lat.length;
      const max=Math.max.apply(null,models.map(function(x){const l=byModel[x];return l.reduce(function(a,b){return a+b;},0)/l.length;}));
      const pct=max>0?Math.max(6,Math.round(100*avg/max)):6;
      return '<div class="tj-bar"><div class="tj-bar-label mono">'+esc(m)+'</div><div class="tj-bar-track"><div class="tj-bar-fill" style="width:'+pct+'%"></div></div><div class="tj-bar-val mono">'+Math.round(avg)+'ms</div></div>';
    }).join('')+'</div>';
  }
  const rows=list.map(function(t){
    const pill=t.status==='ok'?'<span class="pill ok">ok</span>':'<span class="pill bad">fail</span>';
    const cache=t.cache_state?'<span class="pill mut">'+esc(t.cache_state)+'</span>':'';
    return '<tr><td class="mono small">'+esc((t.created_at||'').slice(5,19).replace('T',' '))+'</td><td>'+esc(t.slug)+'</td><td>'+esc(t.provider||'-')+'</td><td>'+pill+' '+cache+'</td><td class="mono" title="input tokens">'+fmt(t.prompt_tokens||0)+'&nbsp;in</td><td class="mono" title="output tokens">'+fmt(t.completion_tokens||0)+'&nbsp;out</td><td class="mono" title="latency">'+fmt(t.latency_ms||0)+'ms</td><td class="mono" title="cost">'+money(t.cost_usd||0)+'</td><td><button class="ghost" data-act="tjview" data-id="'+esc(t.id)+'">view</button></td></tr>';
  }).join('') || '<tr><td colspan="9"><div class="empty">No trajectories captured yet.</div></td></tr>';
  listEl.innerHTML='<table><tr><th>Time</th><th>Model</th><th>Provider</th><th>Status</th><th>In tok</th><th>Out tok</th><th>Latency</th><th>Cost</th><th></th></tr>'+rows+'</table>';
}
async function viewTrajectory(id){
  const {data}=await api('/admin/trajectories/'+id); const t=data&&data.trajectory; if(!t){ toast('not found','err'); return; }
  const steps=(function(){ try{ return JSON.parse(t.steps_json||'[]'); }catch(e){ return []; } })();
  const reqs=(function(){ try{ return JSON.parse(t.request_json||'null'); }catch(e){ return null; } })();
  const resps=(function(){ try{ return JSON.parse(t.response_json||'null'); }catch(e){ return null; } })();
  const stepsHtml=steps.length?'<div class="tj-steps">'+steps.map(function(s,i){
    const cls=s.ok?'ok':(s.error?'bad':'mut');
    const label=s.ok?(s.http||'ok'):(s.error||s.http||'fail');
    return (i>0?'<span class="tj-arrow">-&gt;</span>':'')+'<div class="tj-step '+cls+'"><div class="k mono">'+esc(s.provider)+' r'+s.rank+'</div><div class="v">'+esc(label)+' '+(s.ms?' '+s.ms+'ms':'')+'</div></div>';
  }).join('')+'</div>':'<div class="empty">No step chain.</div>';
  const reqText=reqs?JSON.stringify(reqs.messages||reqs,null,2):'';
  const reqHtml=reqText?'<div class="rowact" style="margin-bottom:6px"><button class="ghost" data-act="tjcopy" data-copy="req">Copy full request</button><span class="small">'+reqText.length+' chars</span></div><pre>'+esc(reqText)+'</pre>':'<div class="empty">No request body.</div>';
  const content=resps&&resps.choices&&resps.choices[0]&&resps.choices[0].message?resps.choices[0].message.content:null;
  const respHtml=content!=null?'<div class="rowact" style="margin-bottom:6px"><button class="ghost" data-act="tjcopy" data-copy="resp">Copy full response</button><span class="small">'+String(content).length+' chars</span></div><pre>'+esc(String(content))+'</pre>':'<div class="empty">No response content.</div>';
  document.querySelector('.modal').classList.add('wide');
  document.getElementById('modal-title').textContent='Trajectory '+t.slug;
  document.getElementById('modal-title').style.color='';
  const body=document.getElementById('modal-body');
  body.innerHTML='<div class="kvrow"><span class="small">'+esc(t.created_at||'')+'</span><span class="right mono small">'+esc(t.status)+' '+fmt(t.latency_ms||0)+'ms '+fmt(t.total_tokens||0)+' tok</span></div>'
    +'<h3 class="sec" style="margin:14px 0 8px;font-size:12px">Route chain</h3>'+stepsHtml
    +'<h3 class="sec" style="margin:14px 0 8px;font-size:12px">Request</h3>'+reqHtml
    +'<h3 class="sec" style="margin:14px 0 8px;font-size:12px">Response</h3>'+respHtml
    +(t.error?'<h3 class="sec" style="margin:14px 0 8px;font-size:12px">Error</h3><pre>'+esc(t.error)+'</pre>':'');
  document.getElementById('modal-save').style.display='none';
  document.getElementById('overlay').classList.add('show');
}
document.addEventListener('click',function(e){
  const b=e.target.closest('[data-act="tjcopy"]'); if(!b) return;
  const which=b.getAttribute('data-copy');
  const pre=document.querySelector('#modal-body pre');
  if(!pre){ toast('nothing to copy','err'); return; }
  navigator.clipboard.writeText(pre.textContent).then(function(){ toast(which==='req'?'request copied':'response copied','ok'); },function(){ toast('copy failed','err'); });
});
document.addEventListener('click',function(e){
  const b=e.target.closest('[data-act="tjview"]'); if(!b) return;
  viewTrajectory(b.getAttribute('data-id'));
});

// ---------- AUTO ROUTER ----------
var arOverrides={};
async function refreshAutoSlugSelects(){
  const opts=await publicModelOptions();
  const ex=document.getElementById('ar-excluded');
  const ov=document.getElementById('ar-ov-slug');
  if(ex) ex.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>';}).join('')||'<option disabled>No enabled public models</option>';
  if(ov) ov.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>';}).join('')||'<option disabled>No enabled public models</option>';
}
function renderOverrideList(){
  const el=document.getElementById('ar-ov-list'); if(!el) return;
  const keys=Object.keys(arOverrides);
  el.innerHTML=keys.length?keys.map(function(k){
    return '<div class="kvrow"><span class="grow mono">'+esc(k)+'</span><span class="mono small right">x'+arOverrides[k]+'</span><span class="right"><button class="danger" data-act="arovdel" data-slug="'+esc(k)+'">remove</button></span></div>';
  }).join(''):'<div class="small">No overrides set.</div>';
}
async function loadAutoSettings(){
  await refreshAutoSlugSelects();
  let s; try{ s=(await api('/admin/auto-settings')).data; }catch(e){ toast('Could not load auto settings: '+e.message,'err'); return; }
  if(!s) return;
  document.getElementById('ar-enabled').checked=!!s.enabled;
  document.getElementById('ar-pref').value=s.preference;
  document.getElementById('ar-pref-val').textContent=s.preference;
  arOverrides=s.overrides||{};
  renderOverrideList();
  const ex=document.getElementById('ar-excluded');
  const excluded=s.excluded||[];
  Array.from(ex.options).forEach(function(o){ o.selected=excluded.includes(o.value); });
}
document.getElementById('ar-pref').addEventListener('input',function(e){
  document.getElementById('ar-pref-val').textContent=e.target.value;
});
document.getElementById('ar-ov-add').onclick=function(){
  const slug=document.getElementById('ar-ov-slug').value;
  const mult=Number(document.getElementById('ar-ov-mult').value);
  if(!slug){ toast('pick a model','err'); return; }
  if(!Number.isFinite(mult)||mult<=0){ toast('multiplier must be positive','err'); return; }
  arOverrides[slug]=mult;
  document.getElementById('ar-ov-mult').value='';
  renderOverrideList();
  toast('override staged: '+slug+' x'+mult+' (save to apply)','ok');
};
document.addEventListener('click',function(e){
  const b=e.target.closest('button[data-act="arovdel"]'); if(!b) return;
  delete arOverrides[b.getAttribute('data-slug')];
  renderOverrideList();
});
document.getElementById('ar-save').onclick=async function(){
  const body={
    enabled: document.getElementById('ar-enabled').checked,
    preference: Number(document.getElementById('ar-pref').value),
    excluded: Array.from(document.getElementById('ar-excluded').selectedOptions).map(function(o){return o.value;}),
    overrides: arOverrides
  };
  const {status,data}=await api('/admin/auto-settings',{method:'POST',body:JSON.stringify(body)});
  if(status===200) toast('auto settings saved','ok');
  else toast('save failed: '+(data&&data.error&&data.error.message||status),'err');
};
document.getElementById('ar-run').onclick=async function(){
  const out=document.getElementById('ar-result');
  const prompt=document.getElementById('ar-test').value.trim();
  if(!prompt){ out.innerHTML='<div class="empty">Write a prompt first.</div>'; return; }
  out.innerHTML='<span class="small">Running preview…</span>';
  let d; try{ d=(await api('/admin/auto-preview',{method:'POST',body:JSON.stringify({prompt})})).data; }catch(e){ out.innerHTML='<div class="empty">Preview failed: '+esc(e.message)+'</div>'; return; }
  if(!d||!d.picked){ out.innerHTML='<div class="empty">'+esc((d&&d.error&&d.error.message)||'unavailable')+'</div>'; return; }
  const rows=(d.candidates||[]).map(function(c){
    const pill=c.eligible?'<span class="pill ok">eligible</span>':'<span class="pill mut">below floor</span>';
    const picked=c.slug===d.picked?' <span class="pill acc">PICKED</span>':'';
    const h=c.samples>0?' · '+Math.round(c.okRate*100)+'% ok ('+c.samples+')':' · no data';
    return '<tr><td class="mono">'+esc(c.slug)+picked+'</td><td>'+pill+'</td><td class="mono">'+c.quality.toFixed(2)+'</td><td class="mono">'+money(c.cost)+'/1M</td><td class="mono small">'+esc(String(Math.round(c.avgMs))+'ms'+h)+'</td></tr>';
  }).join('');
  out.innerHTML='<div class="kvrow"><span class="pill '+(d.fallback?'warn':'acc')+'">'+(d.fallback?'fallback (nothing eligible)':'picked')+'</span><span class="grow"><b>'+esc(d.picked)+'</b> · complexity '+esc(String(d.complexity))+' → quality floor '+d.need.toFixed(2)+' · preference '+d.preference+'</span></div>'+
    '<table style="margin-top:10px"><tr><th>Model</th><th>Status</th><th>Quality</th><th>Cost</th><th>Health</th></tr>'+rows+'</table>';
};
document.getElementById('tj-refresh').onclick=function(){ loadTrajectories(); };
document.getElementById('tj-purge').onclick=function(){ confirmAction('Purge trajectories','Delete every captured trajectory? This cannot be undone.','Purge',async function(){ await api('/admin/trajectories/purge',{method:'POST'}); loadTrajectories(); }); };
document.getElementById('tj-capture').addEventListener('change',async function(e){
  await api('/admin/trajectory-settings',{method:'POST',body:JSON.stringify({capture:e.target.checked?'on':'off'})});
  toast(e.target.checked?'capture on':'capture off','ok');
});
function downloadTraj(fmt){ const a=document.createElement('a'); a.href=API+'/admin/trajectories-export?format='+fmt; a.download='trajectories-'+fmt+'.jsonl'; document.body.appendChild(a); a.click(); a.remove(); }
document.getElementById('tj-export-openai').onclick=function(){ downloadTraj('openai'); };
document.getElementById('tj-export-sharegpt').onclick=function(){ downloadTraj('sharegpt'); };
document.getElementById('tj-export-trl').onclick=function(){ downloadTraj('trl'); };
document.getElementById('tj-export-rl').onclick=function(){ downloadTraj('rl'); };

// ---------- LIMITS ----------
async function loadLimits(){
  const el=document.getElementById('lm-list');
  paintSkeleton(el);
  await refreshLimitSlugSelect();
  let data; try{ const res=await api('/admin/model-limits'); data=res.data; }catch(e){ paintLoadError(el,'Could not load limits: '+e.message,loadLimits); return; }
  const rows=(data&&data.limits||[]).map(function(l){
    const value=l.limit_value>0?(l.kind==='usd'?money(l.limit_value):fmt(l.limit_value)):'-';
    const label=l.kind==='usd'?('$'+value+' / '+l.period):(value+' / '+l.period);
    return '<tr><td class="mono">'+esc(l.slug)+'</td><td><span class="pill acc">'+esc(l.kind)+'</span></td><td class="mono">'+esc(label)+'</td><td><button class="danger" data-act="lmdel" data-slug="'+esc(l.slug)+'" data-kind="'+esc(l.kind)+'" data-period="'+esc(l.period)+'">remove</button></td></tr>';
  }).join('') || '<tr><td colspan="4"><div class="empty">No model limits set.</div></td></tr>';
  el.innerHTML='<table><tr><th>Slug</th><th>Kind</th><th>Cap</th><th></th></tr>'+rows+'</table>';
}
async function refreshLimitSlugSelect(){
  const sel=document.getElementById('lm-slug'); if(!sel) return;
  const opts=await publicModelOptions();
  sel.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>';}).join('') || '<option value="">No enabled public models</option>';
}
document.getElementById('lm-save').onclick=async function(){
  const slug=document.getElementById('lm-slug').value;
  if(!slug){ toast('pick a slug','err'); return; }
  const body={ slug, kind: document.getElementById('lm-kind').value, period: document.getElementById('lm-period').value, limit_value: document.getElementById('lm-value').value };
  const {status,data}=await api('/admin/model-limits',{method:'POST',body:JSON.stringify(body)});
  if(status===200){ toast('limit saved for '+slug,'ok'); document.getElementById('lm-value').value=''; loadLimits(); }
  else toast('save failed: '+(data&&data.error&&data.error.message||status),'err');
};
document.addEventListener('click',function(e){
  const b=e.target.closest('button[data-act="lmdel"]'); if(!b) return;
  confirmAction('Remove model limit','Remove the '+b.getAttribute('data-kind')+'/'+b.getAttribute('data-period')+' cap on '+b.getAttribute('data-slug')+'?','Remove',async function(){
    const slug=b.getAttribute('data-slug'), kind=b.getAttribute('data-kind'), period=b.getAttribute('data-period');
    const {status,data}=await api('/admin/model-limits/'+encodeURIComponent(slug)+'/'+kind+'/'+period,{method:'DELETE'});
    if(status===200){ toast('limit removed','ok'); }
    else toast('remove failed ('+status+'): '+(data&&data.error&&data.error.message||''),'err');
    loadLimits();
  });
});

// init
loadOverview();
<\/script>
</body>
</html>`;
export { PLAYGROUND_HTML };
