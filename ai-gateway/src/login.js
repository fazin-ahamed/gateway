var LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Gateway Control \u2014 Sign in</title>
<style>
  :root{color-scheme:dark;
    --bg:#0b0d11;--panel:#11151c;--panel-hi:#161b24;--line:#252c37;--line-hi:#364152;
    --text:#edf1f7;--muted:#8d98a8;--faint:#8d98a8;--accent:#77a7ff;--accent-deep:#5f93f5;
    --good:#62d3a5;--bad:#f07d7d;--radius:14px;--r-lg:14px;--radius-sm:8px;--r-pill:999px;
    --w-med:600;--w-bold:700;
    --sans:"Segoe UI Variable","Segoe UI",ui-sans-serif,system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;
  }
  html,body{margin:0;min-height:100%}
  body{min-height:100vh;display:grid;grid-template-columns:minmax(0,1.08fr) minmax(360px,.92fr);background:var(--bg);color:var(--text);font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
  body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(119,167,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(119,167,255,.045) 1px,transparent 1px);background-size:56px 56px;mask-image:linear-gradient(to bottom,black,transparent 82%)}
  .login-brand{position:relative;display:flex;flex-direction:column;justify-content:space-between;min-height:100vh;padding:clamp(32px,6vw,84px);border-right:1px solid var(--line);overflow:hidden}
  .login-brand:after{content:"";position:absolute;right:-180px;bottom:-180px;width:420px;height:420px;border:1px solid rgba(119,167,255,.2);border-radius:50%;box-shadow:0 0 0 34px rgba(119,167,255,.035),0 0 0 86px rgba(119,167,255,.025)}
  .brand-top,.brand-content,.brand-footer{position:relative;z-index:1}
  .brand-top{display:flex;align-items:center;gap:12px}
  .brand-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--accent);color:#07101f;font:700 15px/1 var(--mono)}
  .brand-name{font-size:15px;letter-spacing:-.015em;color:#dce5ef}.brand-name strong{font-weight:var(--w-bold);color:var(--text)}
  .brand-content{max-width:620px;margin:auto 0;padding:72px 0}
  .eyebrow{margin:0 0 18px;color:var(--accent);font:600 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase}
  h1{max-width:9ch;margin:0;font-size:clamp(42px,5.1vw,76px);line-height:.98;letter-spacing:-.065em;font-weight:var(--w-bold)}
  .lede{max-width:46ch;margin:24px 0 0;color:var(--muted);font-size:16px;line-height:1.65}
  .brand-footer{display:flex;align-items:center;gap:10px;color:var(--faint);font:12px/1.4 var(--mono)}
  .status-dot{width:7px;height:7px;border-radius:50%;background:var(--good);box-shadow:0 0 0 4px rgba(98,211,165,.1)}
  .login-form-wrap{display:grid;place-items:center;padding:clamp(28px,6vw,72px);background:#0b0f16}
  .login-card{width:min(420px,100%);padding:34px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);box-shadow:0 24px 70px rgba(0,0,0,.3)}
  .login-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:30px}
  .login-head h2{margin:0;font-size:28px;line-height:1.1;letter-spacing:-.04em}
  .login-head .sub{margin:9px 0 0;color:var(--muted);font-size:13px}
  .shield{display:grid;place-items:center;flex:0 0 auto;width:42px;height:42px;border:1px solid var(--line-hi);border-radius:12px;color:var(--accent);font:700 11px/1 var(--mono);letter-spacing:.08em}
  .field{display:block;margin:0 0 16px}
  input{width:100%;min-height:48px;border:1px solid var(--line);border-radius:10px;background:#080d14;color:var(--text);padding:12px 13px;font:15px/1.2 var(--sans);transition:border-color 160ms ease,box-shadow 160ms ease,background 160ms ease}
  input:hover{border-color:var(--line-hi)}
  input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(119,167,255,.14);background:#0a111a}
  .field>span{display:block;margin:0 0 8px;color:var(--muted);font-size:12px;font-weight:var(--w-med);letter-spacing:.02em}
  input::placeholder{color:var(--faint)}
  input:-webkit-autofill,input:-webkit-autofill:hover,input:-webkit-autofill:focus{-webkit-text-fill-color:var(--text);caret-color:var(--text);-webkit-box-shadow:0 0 0 1000px #0a111a inset;box-shadow:0 0 0 1000px #0a111a inset;border-color:var(--accent)}
  input:autofill{color:var(--text);background:#0a111a;border-color:var(--accent)}
  button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:48px;border:1px solid var(--accent-deep);border-radius:10px;background:var(--accent-deep);color:#07101f;padding:11px 14px;font:600 14px/1 var(--sans);cursor:pointer;transition:transform 150ms ease,background 150ms ease,border-color 150ms ease,opacity 150ms ease}
  button:hover{background:var(--accent);border-color:var(--accent)}
  button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  button:disabled{opacity:.58;cursor:wait;transform:none}
  .arrow{font:600 18px/1 var(--sans)}
  .help{margin:22px 0 0;color:var(--faint);font-size:12px;line-height:1.5;text-align:center}
  @media (max-width:820px){body{grid-template-columns:1fr}.login-brand{min-height:330px;border-right:0;border-bottom:1px solid var(--line);padding:30px 28px}.brand-content{margin:0;padding:64px 0 52px}.brand-footer{display:none}.login-brand:after{right:-110px;bottom:-130px;width:280px;height:280px}.login-form-wrap{min-height:calc(100vh - 330px);padding:34px 22px 48px}.login-card{padding:28px}}
  @media (max-width:480px){.login-brand{min-height:290px;padding:24px 20px}.brand-content{padding:48px 0 40px}h1{font-size:43px}.lede{font-size:14px}.login-form-wrap{min-height:calc(100vh - 290px)}.login-card{padding:24px 20px}.login-head{margin-bottom:24px}.login-head h2{font-size:25px}}
  @media (prefers-reduced-motion:reduce){*,*:before,*:after{transition-duration:.01ms!important}}
</style>
</head>
<body>
<section class="login-brand" aria-label="Gateway Control introduction">
  <div>
    <div class="brand-top"><span class="brand-mark">G</span><span class="brand-name">Gateway <strong>Control</strong></span></div>
    <div class="brand-content">
      <p class="eyebrow">Operator console</p>
      <h1>One route.<br/>Every model.<br/><span>Controlled.</span></h1>
      <p class="lede">Secure access to providers, routes, keys, and live egress from a single control plane.</p>
    </div>
  </div>
  <div class="brand-footer"><span class="status-dot"></span><span>Cloudflare edge · D1 state · Encrypted session</span></div>
</section>
<main class="login-form-wrap">
  <form class="login-card" id="f">
    <div class="login-head">
      <div><p class="eyebrow">Restricted access</p><h2>Sign in</h2><p class="sub">Use the administrator password for this gateway.</p></div>
      <span class="shield" aria-hidden="true">GC</span>
    </div>
    <label class="field" for="p"><span>Password</span><input id="p" type="password" autofocus autocomplete="current-password" placeholder="Enter administrator password" required/></label>
    <button type="submit" id="submit"><span>Unlock console</span><span class="arrow" aria-hidden="true">&rarr;</span></button>
    <div class="err" id="e" role="alert" aria-live="polite"></div>
    <p class="help">Sessions last 12 hours. Keep this password private.</p>
  </form>
</main>
<script>
const f=document.getElementById('f'),p=document.getElementById('p'),e=document.getElementById('e'),submit=document.getElementById('submit');
const defaultLabel=submit.querySelector('span').textContent;
f.addEventListener('submit',async function(ev){
  ev.preventDefault();e.textContent='';submit.disabled=true;submit.querySelector('span').textContent='Checking…';
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
