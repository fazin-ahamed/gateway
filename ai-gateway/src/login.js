var LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Wind</title>
<style>
  @font-face{font-family:"Inter";font-weight:100 900;font-display:swap;src:url(/console/fonts/inter.woff2) format("woff2")}
  :root{color-scheme:dark;
    --bg:oklch(0.14 0.022 236);--panel:oklch(0.215 0.014 236);--field:oklch(0.28 0.012 238);--field-hover:color-mix(in oklab,var(--field) 96%,var(--snow) 4%);
    --snow:oklch(0.9911 0 0);--eclipse:oklch(0.2103 0.0059 285.89);
    --text:var(--snow);--muted:oklch(0.72 0.02 236);--faint:color-mix(in oklab,var(--muted) 70%,transparent);
    --accent:oklch(0.66 0.17 236);--accent-dim:color-mix(in oklab,var(--accent) 90%,var(--snow) 10%);
    --bad:oklch(0.594 0.1967 24.63);
    --sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --ease:cubic-bezier(.23,1,.32,1)}
  :root[data-theme="light"]{color-scheme:light;--bg:oklch(0.975 0.018 232);--panel:oklch(100% 0 0);--field:oklch(0.94 0.01 236);--field-hover:color-mix(in oklab,var(--field) 96%,var(--eclipse) 4%);--text:var(--eclipse);--muted:oklch(0.52 0.03 240);--accent:oklch(0.62 0.17 242);--bad:oklch(0.6532 0.2328 25.74)}
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%;overflow-x:clip}
  body{min-height:100dvh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans)}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:24px}
  .brand .dot{width:32px;height:32px;display:grid;place-items:center;border-radius:9px;background:var(--accent);color:var(--snow);font:600 15px/1 var(--sans)}
  .brand-name{font-size:20px;font-weight:600;letter-spacing:-.02em}
  .login-card{width:min(400px,100%);padding:36px;border-radius:24px;background:var(--panel)}
  .login-head{margin-bottom:20px}
  .login-head h2{margin:0;font-size:18px;line-height:1.2;letter-spacing:-.02em;font-weight:600}
  .login-head .sub{margin:6px 0 0;color:var(--muted);font-size:14px;line-height:1.45}
  .field{display:block;margin:0 0 14px}
  .field>span{display:block;margin:0 0 6px;color:var(--text);font-size:13px;font-weight:500}
  input{width:100%;min-height:44px;border:0;border-radius:18px;background:var(--field);color:var(--text);padding:10px 14px;font:14px/1.2 var(--sans);transition:background-color 150ms var(--ease)}
  @media (hover:hover) and (pointer:fine){input:hover{background:var(--field-hover)}}
  input:focus{outline:2px solid var(--accent);outline-offset:2px}
  input::placeholder{color:var(--faint)}
  button{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;border:0;border-radius:999px;background:var(--accent);color:var(--snow);padding:10px 14px;font:500 14px/1 var(--sans);cursor:pointer;transition:background-color 150ms var(--ease),transform 250ms var(--ease)}
  button:active{transform:scale(.97)}
  @media (hover:hover) and (pointer:fine){button:hover{background:var(--accent-dim)}}
  button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  button:disabled{opacity:.5;cursor:not-allowed}
  .err{min-height:1.2em;margin:10px 0 0;color:var(--bad);font-size:14px}
  .help{margin:16px 0 0;color:var(--faint);font-size:12px;line-height:1.4}
  @media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}button:active{transform:none}}
</style>
</head>
<body>
<main>
  <div class="brand"><span class="dot">A</span><span class="brand-name">Astrosphere</span></div>
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
