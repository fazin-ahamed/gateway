var LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Gateway Control</title>
<style>
  :root{color-scheme:dark;
    --bg:#08090c;--panel:#0f1218;--line:#1c222d;--line-hi:#2d3a4e;
    --text:#e4eaf2;--muted:#5f6d82;--faint:#4d596a;--accent:#2fd4b5;--accent-dim:#26aa90;
    --ink:#06211b;--bad:#e45b5b;--radius:10px;
    --w-med:500;--w-bold:600;
    --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --mono:ui-monospace,"SF Mono",Consolas,monospace;
    --ease:cubic-bezier(.2,0,.13,1);
  }
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%}
  body{min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);text-rendering:optimizeLegibility;font-feature-settings:"cv01","cv08","cv10","tnum"}
  body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(600px 400px at 20% -5%,rgba(47,212,181,.06),transparent 60%)}
  .login-card{width:min(380px,100%);padding:28px;border:1px solid var(--line);border-radius:10px;background:var(--panel);position:relative}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:28px}
  .brand .dot{width:26px;height:26px;display:grid;place-items:center;border-radius:4px;background:var(--accent);color:var(--ink);font:600 12px/1 var(--mono)}
  .brand-name{font-size:13px;font-weight:var(--w-bold);letter-spacing:-.01em}
  .login-head{margin-bottom:22px}
  .login-head h2{margin:0;font-size:18px;line-height:1.2;letter-spacing:-.02em;font-weight:var(--w-bold)}
  .login-head .sub{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.45}
  .field{display:block;margin:0 0 14px}
  .field>span{display:block;margin:0 0 6px;color:var(--muted);font-size:10px;font-weight:var(--w-med);letter-spacing:.06em;text-transform:uppercase}
  input{width:100%;min-height:42px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--text);padding:10px 12px;font:13px/1.2 var(--sans);transition:border-color 120ms var(--ease),box-shadow 120ms var(--ease)}
  input:hover{border-color:var(--line-hi)}
  input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 2px rgba(47,212,181,.12)}
  input::placeholder{color:var(--faint)}
  button{display:flex;align-items:center;justify-content:center;width:100%;min-height:40px;border:1px solid var(--accent);border-radius:4px;background:var(--accent);color:var(--ink);padding:10px 14px;font:600 13px/1 var(--sans);cursor:pointer;transition:background 120ms var(--ease),border-color 120ms var(--ease)}
  button:hover{background:var(--accent-dim);border-color:var(--accent-dim)}
  button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  button:disabled{opacity:.4;cursor:wait}
  .err{min-height:1.2em;margin:10px 0 0;color:var(--bad);font-size:12px}
  .help{margin:16px 0 0;color:var(--faint);font-size:10px;line-height:1.4}
  @media (prefers-reduced-motion:reduce){*,*:before,*:after{transition-duration:.01ms!important}}
</style>
</head>
<body>
<main>
  <div class="brand"><span class="dot">G</span><span class="brand-name">Gateway Control</span></div>
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
