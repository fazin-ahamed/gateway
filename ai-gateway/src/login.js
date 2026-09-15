var LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Gateway Control - Sign in</title>
<style>
  :root{color-scheme:dark;
    --bg:#0a0c10;--panel:#12161d;--line:#232a34;--line-hi:#3a4454;
    --text:#eef2f7;--muted:#8b96a6;--faint:#6a7686;--accent:#3dd6c6;--accent-deep:#2fc4b4;
    --ink:#071311;--good:#62d3a5;--bad:#f07d7d;--radius:10px;
    --w-med:600;--w-bold:650;
    --sans:ui-sans-serif,system-ui,"Segoe UI",sans-serif;--mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%}
  body{min-height:100dvh;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(360px,.95fr);background:var(--bg);color:var(--text);font:15px/1.5 var(--sans);text-rendering:optimizeLegibility;font-feature-settings:"kern" 1,"liga" 1;-webkit-font-smoothing:antialiased}
  body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 420px at 12% -8%,rgba(61,214,198,.1),transparent 58%)}
  .login-brand{position:relative;display:flex;flex-direction:column;justify-content:space-between;min-height:100dvh;padding:clamp(28px,5vw,72px);border-right:1px solid var(--line)}
  .brand-top,.brand-content,.brand-footer{position:relative;z-index:1}
  .brand-top{display:flex;align-items:center;gap:12px}
  .brand-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:7px;background:var(--accent);color:var(--ink);font:650 13px/1 var(--mono)}
  .brand-name{font-size:14px;letter-spacing:-.02em;color:var(--muted)}.brand-name strong{font-weight:var(--w-bold);color:var(--text)}
  .brand-content{max-width:560px;margin:auto 0;padding:64px 0}
  h1{max-width:11ch;margin:0;font-size:clamp(40px,5vw,68px);line-height:1.05;letter-spacing:-.05em;font-weight:var(--w-bold)}
  .lede{max-width:46ch;margin:20px 0 0;color:var(--muted);font-size:16px;line-height:1.55}
  .brand-footer{color:var(--faint);font:12px/1.4 var(--mono)}
  .login-form-wrap{display:grid;place-items:center;padding:clamp(24px,5vw,64px);background:#0c1016}
  .login-card{width:min(400px,100%);padding:32px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}
  .login-head{margin-bottom:26px}
  .login-head h2{margin:0;font-size:26px;line-height:1.15;letter-spacing:-.035em}
  .login-head .sub{margin:8px 0 0;color:var(--muted);font-size:13px;max-width:36ch}
  .field{display:block;margin:0 0 16px}
  .field>span{display:block;margin:0 0 8px;color:var(--muted);font-size:12px;font-weight:var(--w-med);letter-spacing:.04em}
  input{width:100%;min-height:48px;border:1px solid var(--line);border-radius:7px;background:#0b1016;color:var(--text);padding:12px 13px;font:15px/1.2 var(--sans)}
  input:hover{border-color:var(--line-hi)}
  input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(61,214,198,.16)}
  input::placeholder{color:var(--faint)}
  button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:48px;border:1px solid var(--accent-deep);border-radius:7px;background:var(--accent-deep);color:var(--ink);padding:11px 14px;font:600 14px/1 var(--sans);cursor:pointer}
  button:hover{background:var(--accent);border-color:var(--accent)}
  button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  button:disabled{opacity:.58;cursor:wait}
  .err{min-height:1.2em;margin:12px 0 0;color:var(--bad);font-size:13px}
  .help{margin:18px 0 0;color:var(--faint);font-size:12px;line-height:1.5}
  @media (max-width:820px){body{grid-template-columns:1fr}.login-brand{min-height:auto;border-right:0;border-bottom:1px solid var(--line);padding:28px 24px}.brand-content{margin:0;padding:40px 0 28px}.brand-footer{display:none}.login-form-wrap{min-height:auto;padding:32px 20px 48px}}
  @media (prefers-reduced-motion:reduce){*,*:before,*:after{transition-duration:.01ms!important}}
</style>
</head>
<body>
<section class="login-brand" aria-label="Gateway Control introduction">
  <div>
    <div class="brand-top"><span class="brand-mark">G</span><span class="brand-name">Gateway <strong>Control</strong></span></div>
    <div class="brand-content">
      <h1>Route every model from one console.</h1>
      <p class="lede">Providers, keys, fallbacks, and live egress. Private edge, SQLite state, encrypted sessions.</p>
    </div>
  </div>
  <div class="brand-footer">n1.eclipsesystems.org</div>
</section>
<main class="login-form-wrap">
  <form class="login-card" id="f">
    <div class="login-head">
      <h2>Sign in</h2>
      <p class="sub">Administrator password for this gateway.</p>
    </div>
    <label class="field" for="p"><span>Password</span><input id="p" type="password" autofocus autocomplete="current-password" placeholder="Administrator password" required/></label>
    <button type="submit" id="submit"><span>Unlock console</span></button>
    <div class="err" id="e" role="alert" aria-live="polite"></div>
    <p class="help">Sessions last 12 hours.</p>
  </form>
</main>
<script>
const f=document.getElementById('f'),p=document.getElementById('p'),e=document.getElementById('e'),submit=document.getElementById('submit');
const defaultLabel=submit.querySelector('span').textContent;
f.addEventListener('submit',async function(ev){
  ev.preventDefault();e.textContent='';submit.disabled=true;submit.querySelector('span').textContent='Checking\u2026';
  try{
    const r=await fetch('/_gw/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})});
    if(r.ok){location.href='/_gw';return;}
    const j=await r.json().catch(function(){return {};});e.textContent=j.error||'Invalid password';
  }catch(err){e.textContent='Network error. Try again.';}
  submit.disabled=false;submit.querySelector('span').textContent=defaultLabel;
});
p.addEventListener('input',function(){e.textContent='';});
<\/script>
</body>
</html>`;
export { LOGIN_HTML };
