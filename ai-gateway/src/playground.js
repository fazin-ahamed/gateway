import { UAE_TIME_CLIENT_SOURCE } from "./uae-time.js";
var PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wind Control</title>
<script>try{var __t=localStorage.getItem("gw-theme");if(!__t)__t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=__t;}catch(e){}<\/script>
<style>
  @font-face{font-family:"Inter";font-weight:100 900;font-style:normal;font-display:swap;src:url(/console/fonts/inter.woff2) format("woff2")}
  @font-face{font-family:"IBM Plex Mono";font-weight:100 700;font-style:normal;font-display:swap;src:url(/console/fonts/plex-mono.woff2) format("woff2")}
  /* Wind: HeroUI v3 ocean anatomy ported to plain CSS. Borderless fields,
     pill controls, surface cards, sky accent; nothing glows. */
  :root{
    color-scheme:dark;
    --white:oklch(100% 0 0); --snow:oklch(0.9911 0 0); --eclipse:oklch(0.2103 0.0059 285.89);
    --bg:oklch(0.14 0.022 236); --surface:oklch(0.215 0.014 236); --surface-hi:oklch(0.262 0.012 240); --surface-deep:oklch(0.28 0.012 238);
    --line:oklch(0.30 0.012 238); --line-hi:oklch(0.4 0.02 240);
    --text:var(--snow); --muted:oklch(0.72 0.02 236); --muted-dim:color-mix(in oklab,var(--muted) 70%,transparent);
    --accent:oklch(0.66 0.17 236); --accent-dim:color-mix(in oklab,var(--accent) 90%,var(--snow) 10%); --accent-fg:oklch(0.98 0.01 240);
    --accent-soft:color-mix(in oklab,var(--accent) 18%,transparent); --accent-soft-fg:color-mix(in oklab,var(--accent) 70%,var(--snow) 30%);
    --ink:var(--snow);
    --cool:var(--accent); --cool-soft:var(--accent-soft);
    --good:oklch(0.7329 0.1935 150.81); --good-soft:color-mix(in oklab,var(--good) 18%,transparent);
    --warn:oklch(0.8203 0.1388 76.34); --warn-soft:color-mix(in oklab,var(--warn) 18%,transparent);
    --bad:oklch(0.594 0.1967 24.63); --bad-soft:color-mix(in oklab,var(--bad) 18%,transparent); --bad-soft-fg:color-mix(in oklab,var(--bad) 70%,var(--snow) 40%);
    --violet:var(--accent); --violet-soft:var(--accent-soft);
    --default:oklch(0.28 0.012 238); --default-hover:color-mix(in oklab,var(--default) 96%,var(--snow) 4%);
    --r-lg:24px; --radius:12px; --radius-sm:8px; --r-pill:999px; --radius-field:18px;
    --w-med:500; --w-bold:600;
    --mono:"IBM Plex Mono",ui-monospace,"SF Mono",Consolas,monospace;
    --sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --display:var(--sans);
    --ease:cubic-bezier(.32,.72,0,1);
    --ease-out:cubic-bezier(.23,1,.32,1);
    --dur:150ms; --dur-slow:250ms;
    --track:var(--default); --hatch:color-mix(in oklch,var(--snow) 7%,transparent);
    --solid:oklch(0.225 0.014 236);
    --overlay:oklch(0.225 0.014 236);
    --backdrop:rgba(3,6,14,.6);
    --shadow:0 0 0 0 transparent inset;
    --shadow-lift:0 0 1px 0 rgba(255,255,255,.3) inset,0 14px 28px 0 rgba(0,0,0,.5);
    --inset:none;
    --surface-shadow:0 0 0 0 transparent inset;
    --overlay-shadow:0 0 1px 0 rgba(255,255,255,.3) inset;
  }
  :root[data-theme="light"]{
    color-scheme:light;
    --bg:oklch(0.975 0.018 232); --surface:var(--white); --surface-hi:oklch(0.957 0.008 236); --surface-deep:oklch(0.94 0.01 236);
    --line:oklch(0.9 0.012 236); --line-hi:oklch(0.8 0.02 238);
    --text:var(--eclipse); --muted:oklch(0.52 0.03 240); --muted-dim:color-mix(in oklab,var(--muted) 70%,transparent);
    --accent:oklch(0.62 0.17 242); --accent-dim:color-mix(in oklab,var(--accent) 90%,var(--snow) 10%); --accent-fg:oklch(0.98 0.01 240);
    --accent-soft:color-mix(in oklab,var(--accent) 12%,transparent); --accent-soft-fg:color-mix(in oklab,var(--accent) 80%,var(--eclipse) 20%);
    --ink:var(--eclipse);
    --default:oklch(0.94 0.01 236); --default-hover:color-mix(in oklab,var(--default) 96%,var(--eclipse) 4%);
    --bad:oklch(0.6532 0.2328 25.74); --bad-soft:color-mix(in oklab,var(--bad) 12%,transparent); --bad-soft-fg:color-mix(in oklab,var(--bad) 80%,var(--eclipse) 20%);
    --good-soft:color-mix(in oklab,var(--good) 14%,transparent); --warn-soft:color-mix(in oklab,var(--warn) 16%,transparent);
    --track:var(--default); --hatch:color-mix(in oklch,var(--eclipse) 8%,transparent);
    --solid:var(--white); --overlay:var(--white);
    --backdrop:rgba(24,24,40,.5);
    --surface-shadow:0 2px 4px 0 rgba(0,0,0,.04),0 1px 2px 0 rgba(0,0,0,.06),0 0 1px 0 rgba(0,0,0,.06);
    --overlay-shadow:0 2px 8px 0 rgba(0,0,0,.06),0 -6px 12px 0 rgba(0,0,0,.03),0 14px 28px 0 rgba(0,0,0,.08);
    --shadow-lift:var(--overlay-shadow);
  }

  /* --- decision mode ------------------------------------------------- */
  /* A display rule beats the hidden attribute; restore it explicitly so
     mode switches actually hide their controls. */
  [hidden]{display:none !important;}

  .pg-modes{display:flex; gap:4px; padding:4px; margin-bottom:14px;
    background:var(--surface-deep); border:1px solid var(--line); border-radius:var(--r-pill);
    box-shadow:var(--inset);}
  .pg-modes .pg-mode{flex:1; padding:8px 14px; border:0; border-radius:var(--r-pill);
    background:transparent; color:var(--muted); font:600 12px/1 var(--sans); letter-spacing:.01em;
    cursor:pointer; transition:color var(--dur) var(--ease), background var(--dur) var(--ease), transform var(--dur) var(--ease);}
  .pg-modes .pg-mode:hover{color:var(--text);}
  .pg-modes .pg-mode.is-on{color:var(--ink); background:var(--accent);
    box-shadow:0 2px 10px -4px color-mix(in oklch,var(--accent) 40%,transparent);}
  .pg-modes .pg-mode:active{transform:scale(.985);}
  .pg-modes .pg-mode:focus-visible{outline:2px solid var(--accent); outline-offset:2px;}

  .pg-decision-results{display:grid; gap:10px; margin-top:14px;}
  .pg-dec-card{padding:14px 16px; border-radius:var(--r-lg);
    background:linear-gradient(180deg,var(--surface-hi),var(--surface));
    border:1px solid var(--line); box-shadow:var(--shadow),var(--inset);
    animation:pgDecIn var(--dur-slow) var(--ease-out) both;}
  .pg-dec-card .k{font:600 11px/1 var(--sans); letter-spacing:0; 
    color:var(--muted); display:flex; align-items:center; gap:8px; margin-bottom:8px;}
  .pg-dec-choice{font:600 16px/1.3 var(--sans); color:var(--text); margin-bottom:10px;}
  .pg-dec-bar{display:grid; grid-template-columns:minmax(72px,110px) 1fr auto; align-items:center;
    gap:12px; margin:7px 0; font:500 11px/1 var(--mono); color:var(--muted);}
  .pg-dec-bar .lbl{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
  .pg-dec-bar .trk{height:6px; border-radius:var(--r-pill); background:var(--surface-deep); overflow:hidden;}
  .pg-dec-bar .trk i{display:block; height:100%; border-radius:var(--r-pill);
    background:linear-gradient(90deg,var(--accent-dim),var(--accent));}
  .pg-dec-bar b{color:var(--text); font-weight:600; font-variant-numeric:tabular-nums; text-align:right; min-width:34px;}
  .pg-dec-track{height:6px; border-radius:var(--r-pill); background:var(--surface-deep); overflow:hidden; margin:2px 0 8px;}
  .pg-dec-track i{display:block; height:100%; background:linear-gradient(90deg,var(--accent-dim),var(--accent));}
  @keyframes pgDecIn{from{opacity:0; transform:translateY(8px) scale(.985);} to{opacity:1; transform:none;}}

  @media (prefers-reduced-motion:reduce){
    .pg-dec-card{animation:none;}
    *{transition-duration:1ms !important;}
  }
  *{box-sizing:border-box} html,body{margin:0;min-height:100%}
  body{font:14px/1.45 var(--sans);background:var(--bg);color:var(--text);letter-spacing:.005em;text-rendering:optimizeLegibility;font-feature-settings:"cv01","cv08","cv10","tnum"}
  a{color:var(--accent)} button,input,select,textarea{font:inherit} button{white-space:nowrap}
  header{height:52px;display:flex;align-items:center;gap:20px;padding:0 24px;border-bottom:1px solid var(--line);background:var(--bg);position:sticky;top:0;z-index:30}
  header .brand{display:flex;align-items:center;gap:9px;font-family:var(--display);font-weight:500;font-size:18px;letter-spacing:-.02em}
  header .brand .dot{width:24px;height:24px;display:grid;place-items:center;border-radius:50%;background:var(--accent);color:var(--ink);font:600 12px/1 var(--display)}
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
  label{display:block;font-size:10px;line-height:1.2;color:var(--muted);margin:0 0 5px;font-weight:var(--w-med);letter-spacing:0;}
  input,select,textarea{width:100%;background:var(--surface-deep);border:1px solid var(--line);color:var(--text);border-radius:var(--radius-sm);padding:8px 10px;font-size:12px;transition:border-color var(--dur) var(--ease)}
  input:hover,select:hover,textarea:hover{border-color:var(--line-hi)} input:focus,select:focus,textarea:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
  input::placeholder,textarea::placeholder{color:var(--muted)} textarea{min-height:100px;resize:vertical;font:11px/1.5 var(--mono)}
  .row{display:flex;gap:14px;flex-wrap:wrap}.row>*{flex:1;min-width:160px}.row>.spacer{flex:0;min-width:0}
  button.act,button.ghost,button.danger{border-radius:var(--radius-sm);cursor:pointer;font-size:11px;font-weight:var(--w-med);letter-spacing:.01em;transition:transform var(--dur) var(--ease),background var(--dur) var(--ease),border-color var(--dur) var(--ease)}
  button.act{background:var(--accent);color:var(--ink);border:1px solid var(--accent);padding:7px 12px}button.act:hover{background:var(--accent-dim);border-color:var(--accent-dim)}button.act:active,button.ghost:active,button.danger:active{transform:scale(.97)}button.act:disabled{opacity:.4;cursor:not-allowed}
  button.ghost{background:transparent;border:1px solid var(--line-hi);color:var(--muted);padding:7px 11px}button.ghost:hover{border-color:var(--accent);color:var(--accent)}
  button.danger{background:transparent;border:1px solid transparent;color:var(--bad);padding:6px 10px}button.danger:hover{background:color-mix(in oklch,var(--bad) 12%,transparent);border-color:color-mix(in oklch,var(--bad) 18%,transparent)}
  table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}#t-list{overflow-x:auto;border-radius:var(--radius-sm)}#t-list table{min-width:880px}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:middle}th{background:var(--surface-deep);color:var(--muted);font:9px/1.3 var(--mono);letter-spacing:0;text-transform:none}tbody tr:hover{background:var(--surface-deep)}tbody tr:last-child td{border-bottom:0}
  #pr-list{overflow-x:auto}#pr-list tbody tr:hover{background:var(--surface-deep)}
  .price-editor h3.sec{margin:18px 0 8px;font-size:11px;padding-bottom:6px;border-bottom:1px solid var(--line)}.price-editor h3.sec:first-child{margin-top:0}
  .price-editor .form-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pe-ov{border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px;margin-bottom:10px;background:var(--surface-deep)}
  .pe-ov-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .pe-add{display:flex;gap:8px;align-items:flex-end;margin-top:8px}.pe-add>div{flex:1}
  .mono{font-family:var(--mono);font-size:11px;word-break:break-all}.pill{padding:2px 7px;border:1px solid transparent;border-radius:var(--r-pill);font:9px/1.2 var(--mono);letter-spacing:0;display:inline-block}.pill.ok{background:color-mix(in oklch,var(--good) 14%,transparent);border-color:color-mix(in oklch,var(--good) 30%,transparent);color:var(--good)}.pill.bad{background:color-mix(in oklch,var(--bad) 18%,transparent);border-color:color-mix(in oklch,var(--bad) 30%,transparent);color:var(--bad)}.pill.warn{background:color-mix(in oklch,var(--warn) 14%,transparent);border-color:color-mix(in oklch,var(--warn) 30%,transparent);color:var(--warn)}.pill.mut{background:color-mix(in oklch,var(--muted) 12%,transparent);border-color:color-mix(in oklch,var(--muted) 24%,transparent);color:var(--muted)}.pill.acc{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
  .stat{position:relative;min-height:88px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px}.stat:before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--accent)}.stat .k{color:var(--muted);font-size:10px;font-weight:500;letter-spacing:0;text-transform:none}.stat .v{font:600 22px/1.1 var(--mono);margin-top:10px;font-variant-numeric:tabular-nums;letter-spacing:-.02em;overflow-wrap:anywhere}.stat .v.acc{color:var(--accent)}.stat .v.ok{color:var(--good)}.stat .v.bad{color:var(--bad)}
  .grid{display:grid;gap:12px}.grid.s4{grid-template-columns:repeat(4,minmax(0,1fr))}.grid.s3{grid-template-columns:repeat(3,minmax(0,1fr))}.grid.s2{grid-template-columns:repeat(2,minmax(0,1fr))}
  button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .toast{position:fixed;right:20px;bottom:20px;background:var(--surface-hi);border:1px solid var(--line-hi);padding:10px 14px;border-radius:6px;opacity:0;transform:translateY(6px);transition:opacity var(--dur) var(--ease),transform var(--dur) var(--ease);pointer-events:none;max-width:340px;z-index:80;font-size:12px}.toast.show{opacity:1;transform:translateY(0)}.toast.err{border-color:var(--bad);color:var(--bad)}.toast.ok{border-color:var(--good)}
  .hint,.small{color:var(--muted);font-size:11px}.hint{margin:10px 0 0;line-height:1.45;max-width:62ch}.small{font-size:10px}
  .skeleton{background:var(--surface-deep);border-radius:4px;animation:pulse 1.4s ease-in-out infinite;opacity:.5}@keyframes pulse{0%,100%{opacity:.3}50%{opacity:.7}}
  .empty{padding:24px 20px;text-align:center;color:var(--muted);font-size:11px;border:1px dashed var(--line-hi);border-radius:var(--radius-sm)}
  .overlay{position:fixed;inset:0;background:var(--overlay);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:70;padding:20px}.overlay.show{display:flex}.modal{background:var(--surface);border:1px solid var(--line-hi);border-radius:var(--r-lg);padding:20px;width:440px;max-width:100%;max-height:88vh;overflow:auto}.modal.wide{width:min(960px,100%)}.modal h3{margin:0 0 16px;font-size:16px;letter-spacing:-.02em;font-weight:var(--w-bold)}.modal pre{max-height:400px}.msg{display:flex;gap:10px;margin:8px 0}.msg .who{font-weight:var(--w-med);min-width:56px;font-size:11px}.msg.user .who{color:var(--accent)}.msg.assistant .who{color:var(--good)}
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
  .pg-msg.user{align-self:flex-end;background:var(--accent-soft);border:1px solid var(--line-hi);border-bottom-right-radius:4px}
  .pg-msg.assistant{align-self:flex-start;background:var(--surface-hi);border:1px solid var(--line);border-bottom-left-radius:4px}
  .pg-msg.streaming{border-style:dashed}
  .pg-msg .who{font:10px/1 var(--mono);letter-spacing:0;color:var(--muted);margin-bottom:6px}
  .pg-msg.user .who{color:var(--accent)}
  .pg-msg.assistant .who{color:var(--good)}
  .pg-body{white-space:pre-wrap;word-break:break-word}
  .pg-meta{margin-top:8px;font:10px/1.4 var(--mono);color:var(--muted)}
  .pg-composer{display:flex;gap:10px;align-items:flex-end;padding:14px 18px;border-top:1px solid var(--line);background:var(--surface)}
  .pg-composer textarea{flex:1;min-height:52px;max-height:160px;resize:vertical}
  .pg-composer button{flex:0 0 auto;margin-top:0}
  .pg-trace{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:12px 18px;border-top:1px solid var(--line);background:var(--surface)}
  .pg-trace .k{font:9px/1 var(--mono);letter-spacing:0;color:var(--muted)}
  .pg-trace .v{font:12px/1.3 var(--mono);margin-top:4px;word-break:break-all}
  .pg-probe{margin:0;padding:0;overflow:hidden}
  .pg-probe-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}
  .pg-probe-body{padding:12px 16px 16px;max-height:280px;overflow:auto}
  .pg-signals{display:flex;flex-direction:column;gap:6px}
  @media (max-width:980px){.pg-shell{grid-template-columns:1fr;min-height:0}.pg-messages{min-height:240px}.pg-msg{max-width:100%}.pg-trace{grid-template-columns:repeat(2,minmax(0,1fr))}}
  .pagehead{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0 0 14px}
  .pagehead h2.sec{font-family:var(--display);font-weight:500;font-size:24px;letter-spacing:-.02em;margin:0}
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
  /* Model-routes cards: one per public slug. The chain reads as a vertical
     list inside the card, so a slug never repeats as a table column. */
  .routegroup{padding:10px 14px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:10px;background:var(--surface-deep)}
  .routegroup>.kvrow{border-bottom:1px solid var(--line-hi)}
  .muted2{color:var(--muted-dim)}
  .strong{font-weight:600;color:var(--text)}
  .empty{padding:24px 20px;text-align:center;color:var(--muted);font-size:11px;border:1px dashed var(--line-hi);border-radius:var(--radius-sm)}
  /* Credit meter: same track+fill language as the decision bars, so the
     Credits tab needs no external stylesheet (the admin CSP allows inline
     styles only - no third-party code). */
  .usagebar{display:inline-block;width:96px;height:6px;border-radius:var(--r-pill);background:var(--surface-deep);border:1px solid var(--line);overflow:hidden;vertical-align:middle}
  .usagebar i{display:block;height:100%;background:linear-gradient(90deg,var(--accent-dim),var(--accent));}
  .form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .form-grid .full{grid-column:1/-1}
  .modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
  .modal-head h3{margin:0}
  .modal-x{background:transparent;border:1px solid var(--line);color:var(--muted);border-radius:var(--radius-sm);width:26px;height:26px;cursor:pointer;font-size:12px;line-height:1;display:grid;place-items:center;padding:0}
  .modal-x:hover{color:var(--text);border-color:var(--line-hi)}
  .modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
  .form-actions{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
  #modal-body label{margin-top:2px}
  .field{margin:0 0 12px}
  .field .small{margin:6px 0 0}
  .filter-grid{display:grid;grid-template-columns:1.2fr 1.4fr 1.2fr 1.2fr .8fr auto;gap:12px;align-items:end}
  .tj-chart{display:flex;flex-direction:column;gap:8px}
  .tj-bar{display:grid;grid-template-columns:160px 1fr 80px;gap:10px;align-items:center}
  .tj-bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--muted)}
  .tj-bar-track{height:6px;background:var(--surface-deep);border-radius:3px;overflow:hidden}
  .tj-bar-fill{height:100%;background:var(--accent);border-radius:3px;}
  .tj-bar-val{text-align:right;font-size:10px;color:var(--muted)}
  .tj-pager{display:flex;align-items:center;justify-content:center;gap:14px;padding:14px 0 4px;color:var(--muted)}
  .tj-pager button:disabled{background:var(--surface-hi);color:var(--muted-dim);cursor:not-allowed}
  .tj-steps{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0}
  .tj-step{padding:8px 12px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-deep)}
  .tj-step.ok{border-color:color-mix(in oklch,var(--good) 30%,transparent)}
  .tj-step.bad{border-color:color-mix(in oklch,var(--bad) 18%,transparent)}
  .tj-step.mut{border-color:var(--line)}
  .tj-step .k{font-size:11px;font-weight:600}
  .tj-step .v{font-size:9px;color:var(--muted);margin-top:2px}
  .tj-arrow{color:var(--faint,var(--muted-dim));font-size:12px}
  @media (max-width:620px){.tj-bar{grid-template-columns:1fr;gap:4px}.tj-bar-val{text-align:left}}
  .lg-pre{max-height:60vh;font:11px/1.6 var(--mono);background:var(--surface-deep)}
  .lg-ts{color:var(--muted);margin-right:8px;font-size:10px}
  @media (max-width:1100px){.hero-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.cols2{grid-template-columns:1fr}.filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width:620px){.hero-stats{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.filter-grid{grid-template-columns:1fr}.pagehead{flex-direction:column;align-items:flex-start}}

  /* ===== Wind layer =====
     HeroUI anatomy: pill controls and chips, borderless rounded fields,
     24px surface cards, sm-scale type at 500 weight, status colours as soft
     fills. Presses answer with scale(.97); hover only on devices that hover. */
  html{background:var(--bg);overflow-x:clip}
  body{background:var(--bg);font:14px/1.5 var(--sans);letter-spacing:0;overflow-x:clip;font-feature-settings:"tnum";scrollbar-width:thin;scrollbar-color:color-mix(in oklch,var(--text) 15%,transparent) transparent}
  body:before,body:after{content:none}
  header{position:sticky;top:0;z-index:30;height:56px;padding:0 24px;gap:16px;background:color-mix(in oklab,var(--bg) 82%,transparent);border-bottom:0;backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%)}
  header .brand{font-family:var(--sans);font-weight:600;font-size:17px;letter-spacing:-.02em}
  header .brand .dot{width:28px;height:28px;border-radius:8px;background:var(--accent);color:var(--ink);font:600 14px/1 var(--sans);box-shadow:none}
  header .base{padding:6px 12px;border-radius:var(--r-pill);background:var(--default);font:12px/1 var(--mono);color:var(--muted)}
  header .clock{border-left:0;padding-left:0;color:var(--muted);font:12px/1 var(--mono)}
  .themebtn{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:var(--r-pill);background:transparent;color:var(--muted);cursor:pointer;transition:color var(--dur) var(--ease-out),background-color var(--dur) var(--ease-out)}
  .themebtn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  nav{position:fixed;z-index:20;top:56px;bottom:0;left:0;width:224px;padding:12px 10px;display:flex;flex-direction:column;gap:2px;overflow-y:auto;background:transparent;border:0;border-radius:0;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}
  nav .navgrp{padding:16px 12px 6px;font:600 11px/1 var(--sans);color:var(--muted-dim);letter-spacing:.02em}
  nav .navgrp:first-child{padding-top:6px}
  nav button{position:relative;display:block;width:100%;height:36px;line-height:36px;padding:0 14px;text-align:left;border:0;border-radius:var(--r-pill);background:transparent;color:var(--muted);font-size:14px;font-weight:500;cursor:pointer;transition:color var(--dur) var(--ease-out),background-color var(--dur) var(--ease-out),transform 250ms var(--ease-out)}
  nav button:active{transform:scale(.98)}
  nav button.active{background:var(--default);color:var(--text);box-shadow:none}
  nav button.active:before{content:none}
  main{margin-left:224px;max-width:1280px;padding:28px 36px 72px}
  .tab.active{animation:gwtab 200ms var(--ease-out) both}
  @keyframes gwtab{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  .pagehead h2.sec{font-family:var(--sans);font-weight:600;font-size:26px;letter-spacing:-.02em}
  .pagehead .sub{font-size:14px;color:var(--muted)}
  h2.sec{font-size:14px;font-weight:500;letter-spacing:0}
  .panel,.card,.stat,.routegroup{background:var(--surface);border:0;border-radius:var(--r-lg);box-shadow:var(--surface-shadow);backdrop-filter:none;-webkit-backdrop-filter:none}
  .routegroup{background:var(--surface-deep)}
  .panel-h{padding:14px 20px;border-bottom:0}
  .panel-h h2.sec{font-size:14px}
  .panel-b{padding:20px}
  .stat:before{display:none}
  .stat{min-height:0}
  .hero-stats{gap:10px}
  .hero-stats .stat{background:var(--surface);border:0;border-radius:var(--r-lg);min-height:0;padding:14px 18px}
  .hero-stats .stat+.stat{border-left:0}
  .hero-stats .stat .k{font:500 14px/1.3 var(--sans);letter-spacing:0;text-transform:none;color:var(--muted)}
  .hero-stats .stat .v{margin-top:2px;font:600 26px/1.2 var(--mono);letter-spacing:-.01em}
  label{font-size:13px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--text)}
  input,select,textarea{background:var(--default);border:0;border-radius:var(--radius-field);padding:9px 12px;font-size:14px;transition:background-color var(--dur) var(--ease-out),box-shadow var(--dur) var(--ease-out)}
  textarea{font:12px/1.5 var(--mono)}
  select option{background:var(--solid);color:var(--text)}
  @media (hover:hover) and (pointer:fine){input:hover,select:hover,textarea:hover{background:var(--default-hover)}}
  input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:2px;border-color:transparent;box-shadow:none}
  button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  button.act,button.ghost,button.danger{font-size:14px;font-weight:500;border-radius:var(--r-pill);transition:transform 250ms var(--ease-out),background-color var(--dur) var(--ease-out),border-color var(--dur) var(--ease-out),color var(--dur) var(--ease-out)}
  button.act{padding:9px 16px;background:var(--accent);border:0;color:var(--accent-fg);box-shadow:none}
  button.ghost{padding:9px 16px;background:var(--default);border:0;color:var(--text);box-shadow:none}
  button.danger{padding:9px 14px;background:var(--bad-soft);color:var(--bad-soft-fg)}
  button.act:active,button.ghost:active,button.danger:active,.seg button:active{transform:scale(.97)}
  button:disabled{background:var(--default);color:var(--muted-dim);cursor:not-allowed;box-shadow:none}
  @media (hover:hover) and (pointer:fine){
    nav button:hover{color:var(--text);background:var(--default-hover)}
    button.act:hover{background:var(--accent-dim)}
    button.ghost:hover{background:var(--default-hover)}
    button.danger:hover{background:color-mix(in oklab,var(--bad) 24%,transparent)}
    .themebtn:hover{color:var(--text);background:var(--default)}
    table tbody tr:hover{background:var(--default)}
  }
  th{font:500 12px/1.3 var(--sans);letter-spacing:0;text-transform:none;color:var(--muted);background:var(--surface-hi);padding:10px 16px}
  td{padding:12px 16px;border-bottom:1px solid var(--line)}
  .mono,td.mono,.kvrow .grow.mono{font-family:var(--mono)}
  .pill{font:500 12px/1.2 var(--mono);letter-spacing:0;text-transform:none;padding:3px 8px;border-radius:var(--r-pill);border:0;background:var(--default);color:var(--muted)}
  .pill.ok{background:var(--good-soft);color:var(--good)}
  .pill.warn{background:var(--warn-soft);color:var(--warn)}
  .pill.bad{background:var(--bad-soft);color:var(--bad-soft-fg)}
  .seg{padding:3px;gap:2px;border:0;border-radius:var(--r-pill);background:var(--default)}
  .seg button{border-radius:var(--r-pill);padding:6px 14px;font-size:14px;font-weight:500;color:var(--muted)}
  .seg button.on{background:var(--solid);color:var(--text);box-shadow:var(--surface-shadow)}
  .skeleton{position:relative;overflow:hidden;animation:none;opacity:1;background:var(--surface-deep)}
  .skeleton:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--surface-hi),transparent);transform:translateX(-100%);animation:gwsheen 1.8s cubic-bezier(.77,0,.175,1) infinite}
  @keyframes gwsheen{to{transform:translateX(100%)}}
  .toast{background:var(--solid);border:0;border-radius:var(--radius);color:var(--text);box-shadow:var(--shadow-lift);transition:opacity 150ms var(--ease-out),transform 150ms var(--ease-out)}
  .overlay{background:var(--backdrop);backdrop-filter:none;-webkit-backdrop-filter:none}
  .modal{background:var(--solid);border:0;border-radius:var(--r-lg);box-shadow:var(--shadow-lift);animation:gwpop 180ms var(--ease-out) both}
  @keyframes gwpop{from{opacity:0;transform:scale(.97) translateY(4px)}to{opacity:1;transform:none}}
  .empty{border:0;border-radius:var(--radius);background:var(--surface-deep)}

  /* Budget meter */
  .rb{min-width:0}
  .rb-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:13px;color:var(--muted)}
  .rb-top b{font:600 22px/1.2 var(--mono);color:var(--text);letter-spacing:-.01em}
  .rb-top b.out{color:var(--bad-soft-fg)}
  .rb-track{position:relative;height:24px;margin:10px 0 8px;border:0;border-radius:var(--radius-sm);overflow:hidden;background:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 7px),var(--track)}
  .rb-track.off{opacity:.55}
  .rb-track i{position:absolute;inset:0 auto 0 0;min-width:6px;border-radius:var(--radius-sm);background:var(--accent);transform-origin:left center;animation:gwgrow 260ms var(--ease-out) both}
  .rb-track i.full{background:var(--bad)}
  .rb-track u{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--text);text-decoration:none}
  @keyframes gwgrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .rb-sub{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
  .bd-acct{padding:18px 20px;border-bottom:1px solid var(--line)}
  .bd-acct:last-child{border-bottom:0}
  .bd-head{display:flex;align-items:center;gap:10px;margin-bottom:16px}
  .bd-head strong{font-size:15px;font-weight:600;letter-spacing:-.01em}
  .bd-meters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 40px}
  .bd-edit{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;gap:10px;align-items:end;margin-top:16px}
  .bd-credit{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px;font-size:14px;color:var(--muted)}
  .bd-credit b{font:600 18px/1 var(--mono);color:var(--accent)}
  .bd-credit button{padding:6px 12px}
  .switch{position:relative;display:inline-block;width:44px;height:24px;flex:0 0 auto}
  .switch input{position:absolute;inset:0;opacity:0;margin:0;width:100%;height:100%;cursor:pointer;z-index:1}
  .switch span{position:absolute;inset:0;border-radius:var(--r-pill);background:var(--default);border:0;transition:background-color 200ms var(--ease-out)}
  .switch span:after{content:"";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;background:var(--accent-fg);transition:transform 200ms var(--ease-out),background-color 200ms var(--ease-out)}
  .switch input:checked+span{background:var(--accent)}
  .switch input:checked+span:after{transform:translateX(20px)}
  .switch input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
  .rl-head{display:flex;align-items:center;gap:12px}
  .rl-head .grow{flex:1;min-width:0}
  .rl-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .rl-stats div{padding:12px 16px;border:0;border-radius:var(--radius);background:var(--surface-deep)}
  .rl-stats div+div{border-left:0}
  .rl-stats b{display:block;font:600 22px/1.2 var(--mono);letter-spacing:-.01em}
  .rl-stats span{font-size:13px;color:var(--muted)}
  .rl-bars{display:grid;gap:8px;margin-top:16px}
  .rl-bar{display:grid;grid-template-columns:150px 1fr 48px;gap:10px;align-items:center;font-size:13px;color:var(--muted)}
  .rl-bar i{display:block;height:8px;border-radius:var(--radius-sm);background:var(--accent);min-width:2px}
  .rl-bar em{font:12px var(--mono);font-style:normal;text-align:right;color:var(--text)}
  .rl-help{font-size:14px;color:var(--muted);margin:0;max-width:70ch;line-height:1.55}
  .rl-list{display:grid;gap:0;margin-top:12px;font-size:13px}
  .rl-list div{display:flex;gap:12px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line);color:var(--muted)}
  .rl-list div:last-child{border-bottom:0}
  .usagebar i,.pg-dec-bar .trk i,.pg-dec-track i,.tj-bar-fill{background:var(--accent)}
  .pg-modes .pg-mode.is-on{background:var(--solid);color:var(--text);box-shadow:var(--surface-shadow)}
  .pg-dec-card{background:var(--surface);box-shadow:var(--surface-shadow);border:0}
  .pg-dec-card .k{letter-spacing:0;text-transform:none}
  .pg-trace .k{letter-spacing:0;text-transform:none}
  .pg-msg.user{background:var(--accent-soft);border:0}
  .pg-messages{background:var(--surface-deep)}
  .tj-step{background:var(--surface-deep);border:0}
  @media (max-width:980px){
    header{padding:0 16px}
    nav{position:sticky;top:56px;bottom:auto;left:auto;width:100%;flex-direction:row;gap:2px;padding:8px 12px;overflow-x:auto;background:color-mix(in oklab,var(--bg) 92%,transparent);backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%);border-bottom:0}
    nav .navgrp{display:none}
    nav button{width:auto;flex:0 0 auto;padding:0 14px}
    main{margin-left:0;padding:20px 16px 56px}
    .hero-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
    .bd-meters{grid-template-columns:1fr}
    .bd-edit{grid-template-columns:repeat(2,minmax(0,1fr))}
    .rl-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
    .pagehead h2.sec{font-size:22px}
  }
  @media (prefers-reduced-transparency:reduce){
    header,nav{background:var(--bg);backdrop-filter:none;-webkit-backdrop-filter:none}
  }
  @media (prefers-reduced-motion:reduce){
    .tab.active,.modal{animation:none}
    .rb-track i{animation:none}
    .skeleton:after{animation:none}
    button:active{transform:none!important}
  }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot">W</span><span>Wind Control</span></div>
  <span class="base" id="base">\u2026</span>
  <span class="clock" id="clock"></span>
  <button type="button" class="themebtn" id="theme-toggle" aria-label="Switch theme" title="Switch theme"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg></button>
</header>
<nav aria-label="Gateway sections">
  <button type="button" data-tab="overview" class="active" aria-current="page">Overview</button>
  <div class="navgrp">Traffic</div>
  <button type="button" data-tab="providers">Providers</button>
  <button type="button" data-tab="routes">Model routes</button>
  <button type="button" data-tab="tiers">Model tiers</button>
  <button type="button" data-tab="auto">Auto</button>
  <button type="button" data-tab="proxies">Proxies</button>
  <button type="button" data-tab="limits">Limits</button>
  <div class="navgrp">Customers</div>
  <button type="button" data-tab="keys">API keys</button>
  <button type="button" data-tab="accounts">Accounts</button>
  <button type="button" data-tab="budgets">Budgets</button>
  <button type="button" data-tab="credits">Credits</button>
  <button type="button" data-tab="prices">Prices</button>
  <button type="button" data-tab="tokens">Device tokens</button>
  <div class="navgrp">Quality</div>
  <button type="button" data-tab="reliability">Reliability</button>
  <button type="button" data-tab="detection">Detection</button>
  <button type="button" data-tab="cache">Cache</button>
  <button type="button" data-tab="trajectories">Trajectories</button>
  <button type="button" data-tab="chat">Playground</button>
  <div class="navgrp">System</div>
  <button type="button" data-tab="storage">Storage</button>
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

  <section class="tab" id="tab-accounts">
    <div class="pagehead"><div><h2 class="sec">Accounts</h2><p class="sub">Create a customer, set their spend cap and model tiers, and hand over one link. They set up credentials and mint their own keys.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Create account</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Spend cap mode</label><select id="acct-new-mode"><option value="usd">USD ($)</option><option value="tokens">Tokens</option></select></div>
        <div><label>Spend cap (blank = no cap)</label><input id="acct-new-limit" type="number" step="any" placeholder="10.00"></div>
        <div><label>Model tiers</label><select id="acct-new-tiers" multiple size="3"></select><small>The account's keys inherit these tiers.</small></div>
        <div class="full"><button class="act" id="acct-new-create">Create account link</button></div>
        <div class="full hint" id="acct-new-out"></div>
      </div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="accounts-list"></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Key invite (legacy)</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Key</label><select id="acct-legacy-key"></select><small>Attach an existing key to a new account. It stays in the API keys tab and keeps its limits.</small></div>
        <div class="full"><button class="act" id="acct-invite">Create key invite link</button></div>
        <div class="full hint" id="acct-invite-out"></div>
      </div>
    </div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Existing account links</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Account</label><select id="acct-key"></select><small>Pick an account to reset its password.</small></div>
        <div class="full"><button class="act" id="acct-reset">Create password reset link</button></div>
        <div class="full hint" id="acct-out"></div>
      </div>
    </div></div>
    <div class="panel"><div class="panel-b flush" id="acct-tokens-list"></div></div>
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
        <div class="pg-modes" id="c-modes" role="tablist" aria-label="Model class">
          <button class="pg-mode is-on" id="c-mode-chat" role="tab" aria-selected="true">Chat</button>
          <button class="pg-mode" id="c-mode-decision" role="tab" aria-selected="false">Decision</button>
        </div>
        <div class="card">
          <h2 class="sec" style="margin-top:0">Run</h2>
          <label for="c-model" id="c-model-label">Model slug</label>
          <select id="c-model"><option value="">Loading enabled models...</option></select>
          <div class="pg-decision-only" id="c-decision-config" hidden>
            <p class="hint">A decision model does not chat. You describe a <b>state</b>, then ask typed <b>questions</b> about it: a yes/no probability (noul), a pick from options you list (choice), or a rating on a scale (score). Load an example, then run:</p>
            <div class="form-actions">
              <button class="ghost" type="button" data-dec-ex="yesno">Yes / no example</button>
              <button class="ghost" type="button" data-dec-ex="choice">Choice example</button>
              <button class="ghost" type="button" data-dec-ex="score">Score example</button>
            </div>
            <label for="c-dec-state">State (JSON): what you are deciding about</label>
            <textarea id="c-dec-state" spellcheck="false">{
  "task": "fix the session writer race"
}</textarea>
            <label for="c-dec-questions">Questions (JSON): what to ask about the state</label>
            <textarea id="c-dec-questions" spellcheck="false">{
  "verify": {
    "type": "noul",
    "instructions": "Does this change require objective verification?"
  }
}</textarea>
            <p class="hint">noul needs instructions; choice needs a criteria object (option: why); score needs a criteria array of labels, lowest to highest.</p>
          </div>
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
            <div><div class="k">Request</div><div class="v" id="c-trace-id">-</div></div>
            <div><div class="k">Route</div><div class="v" id="c-trace-route">-</div></div>
            <div><div class="k">Attempts</div><div class="v" id="c-trace-attempts">-</div></div>
            <div><div class="k">Usage</div><div class="v" id="c-trace-usage">-</div></div>
          </div>
          <div class="pg-composer">
            <textarea id="c-prompt" placeholder="Send a prompt through the gateway…"></textarea>
            <button class="ghost" id="c-redo" title="Regenerate the last response">Regenerate</button>
            <button class="act" id="c-send">Send</button>
          </div>
          <div class="pg-decision-results" id="c-dec-answers" hidden></div>
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
    <div class="pagehead"><div><h2 class="sec">Response cache</h2><p class="sub">On by default for deterministic requests; each key can turn its own cache off in the client console. Send <span class="mono">x-gateway-cache: off</span> to bypass a single request, or <span class="mono">x-gateway-cache: refresh</span> to force a new fetch. Entries are scoped to each API key.</p></div><div class="actions"><button class="ghost" id="cache-refresh">Refresh</button><button class="danger" id="cache-purge">Purge all</button></div></div>
    <div class="panel"><div class="panel-b flush" id="cache-stats"></div></div>
    <div class="panel"><div class="panel-b"><pre id="cache-policy" style="margin:0"></pre></div></div>
  </section>

  <section class="tab" id="tab-prices">
    <div class="pagehead"><div><h2 class="sec">Model prices</h2><p class="sub">Add a model's <b>default</b> pricing here (applies to every provider). Use <b>Edit</b> on a row to set per-provider actual rates. <b>Equivalent</b> is the public list price (per 1M tokens); <b>actual</b> is what you pay and can be per 1M tokens or a flat per-request fee. Blank actual token rates reuse the equivalent.</p></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Add / update default price</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Slug</label><input id="pr-slug" placeholder="z-ai/glm-5.3"></div>
        <div><label>Actual pricing basis</label><select id="pr-actual-mode"><option value="per_1m">Per 1M tokens</option><option value="per_request">Flat per request</option></select></div>
        <div><label>Equivalent prompt $/1M</label><input id="pr-prompt" type="number" step="0.0001" placeholder="0"></div>
        <div><label>Equivalent completion $/1M</label><input id="pr-completion" type="number" step="0.0001" placeholder="0"></div>
        <div><label>Actual prompt $/1M (optional)</label><input id="pr-actual-prompt" type="number" step="0.0001" placeholder="same as equivalent"></div>
        <div><label>Actual completion $/1M (optional)</label><input id="pr-actual-completion" type="number" step="0.0001" placeholder="same as equivalent"></div>
        <div><label>Cache read $/1M (optional)</label><input id="pr-cache-read" type="number" step="0.0001" placeholder="same as prompt"></div>
        <div><label>Cache write $/1M (optional)</label><input id="pr-cache-write" type="number" step="0.0001" placeholder="0"></div>
        <div><label>Actual $/request (flat basis)</label><input id="pr-actual-request" type="number" step="0.0001" placeholder="0"></div>
      </div>
      <div class="form-actions"><button class="act" id="pr-save">Save default</button><button class="ghost" id="pr-sync">Sync equivalent from models.dev</button></div>
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
    <div class="pagehead"><div><h2 class="sec">Trajectories</h2><p class="sub">Every request with its full multi-turn conversation, tool calls, and route chain. Exports are industry-standard training formats with tool traffic preserved. Vey is the native routing/world-model format: candidate sets, every failed and successful attempt, operational outcomes separate from answer-quality evidence.</p></div><div class="actions"><button class="ghost" id="tj-export-openai" title="OpenAI fine-tuning messages format">OpenAI</button><button class="ghost" id="tj-export-sharegpt" title="ShareGPT conversations format">ShareGPT</button><button class="ghost" id="tj-export-trl" title="HuggingFace TRL conversational format">TRL</button><button class="ghost" id="tj-export-rl" title="RL episode: prompt, completion, reward slot">RL</button><button class="ghost" id="tj-export-vey" title="Vey World — native routing/world-model episodes with candidate sets, attempts, operational outcomes and semantic evidence">Vey</button><button class="ghost" id="tj-refresh">Refresh</button><button class="danger" id="tj-purge">Purge</button></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Settings</h2></div><div class="panel-b">
      <label class="pg-check" style="margin:0"><input type="checkbox" id="tj-capture"> Capture trajectories</label>
      <p class="hint">Bodies are capped at 128KB per side and secrets are stripped. Turn off to record nothing.</p>
    </div></div>
    <div class="hero-stats" id="tj-stats"></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Filter</h2></div><div class="panel-b">
      <div class="form-grid">
        <div><label>Account</label><select id="tj-f-account"><option value="">All accounts</option></select></div>
        <div><label>Key</label><select id="tj-f-key"><option value="">All keys</option></select></div>
        <div><label>Model</label><select id="tj-f-model"><option value="">All models</option></select></div>
        <div><label>Status</label><select id="tj-f-status"><option value="">Any</option><option value="ok">Succeeded</option><option value="fail">Failed</option></select></div>
        <div class="full"><button class="ghost" id="tj-f-clear">Clear filters</button></div>
      </div>
      <p class="hint">Totals and the latency chart follow the filter. Picking an account narrows to the keys it owns. Exports above follow the account, key, and model you pick; the status filter does not apply to them, because a training export needs a completed run.</p>
    </div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Latency by model</h2></div><div class="panel-b" id="tj-chart"></div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Recent requests</h2></div><div class="panel-b flush" id="tj-list"></div></div>
  </section>
  <section class="tab" id="tab-proxies">
    <div class="pagehead"><div><h2 class="sec">Proxies</h2><p class="sub">Egress inventory for the Z.AI uTLS helper. Credentials are sealed in SQLite and never leave the server. Testing verifies a real HTTPS tunnel against a neutral destination \u2014 it never touches Z.AI.</p></div><div class="actions"><label class="pg-check" style="margin:0" title="Auto: gateway picks the best healthy proxy and keeps it sticky. Manual: uses ZAI_EGRESS_PROXY."><input type="checkbox" id="px-auto"> Auto-select</label><button class="ghost" id="px-test-all">Test all</button><button class="ghost" id="px-test-failed">Retest failed</button><button class="danger" id="px-remove-dead">Remove dead</button></div></div>
    <div id="px-active" class="hint" style="margin:0 0 10px"></div>
    <div id="px-helper" class="hint" style="margin:0 0 10px"></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Import</h2></div><div class="panel-b">
      <textarea id="px-import" rows="4" placeholder="host:port&#10;http://user:pass@host:port&#10;socks5h://host:1080&#10;host:port:user:pass" style="width:100%;font-family:monospace;font-size:12px"></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">
        <label class="hint" style="margin:0">Default type for bare host:port
          <select id="px-default-scheme"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option><option value="socks5h">SOCKS5H</option></select>
        </label>
        <button class="act" id="px-import-btn">Import</button>
        <label class="hint" style="margin:0">Concurrency <input id="px-conc" type="number" value="20" min="1" max="50" style="width:60px"></label>
        <label class="hint" style="margin:0">Timeout ms <input id="px-timeout" type="number" value="10000" min="1000" max="20000" step="1000" style="width:80px"></label>
      </div>
    </div></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Egress reachability test</h2></div><div class="panel-b">
      <p class="hint" style="margin-top:0">Can this box reach a URL \u2014 directly, or through a proxy \u2014 before you trust it? Metadata only (status + stage timings), never the body.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="px-reach-url" type="text" value="https://chat.z.ai/" placeholder="https://chat.z.ai/" style="flex:1;min-width:260px;font-family:monospace;font-size:12px">
        <input id="px-reach-proxy" type="text" placeholder="optional proxy: socks5h://host:1080" style="flex:1;min-width:220px;font-family:monospace;font-size:12px">
        <button class="act" id="px-reach-btn">Test URL</button>
      </div>
      <div id="px-reach-out" class="hint" style="margin-top:8px"></div>
    </div></div>
    <div class="hero-stats" id="px-stats"></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Pool</h2></div><div class="panel-b flush" id="px-list"></div></div>
  </section>
  <section class="tab" id="tab-tokens">
    <div class="pagehead"><div><h2 class="sec">Z.AI device tokens</h2><p class="sub">Single-use Aliyun device tokens consumed as CAPTCHA proofs are minted. The SQLite FIFO is the live queue; the legacy .txt file is fallback only. Token values are never displayed.</p></div></div>
    <div class="hero-stats" id="zt-stats"></div>
    <div class="panel"><div class="panel-h"><h2 class="sec">Refill</h2></div><div class="panel-b">
      <textarea id="zt-import" rows="4" placeholder="one device token per line" style="width:100%;font-family:monospace;font-size:12px"></textarea>
      <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">
        <button class="act" id="zt-import-btn">Add tokens</button>
        <label class="ghost" style="margin:0;cursor:pointer">Load .txt<input type="file" id="zt-file" accept=".txt,text/plain" style="display:none"></label>
        <span id="zt-msg" class="hint" style="margin:0"></span>
      </div>
    </div></div>
  </section>

  <section class="tab" id="tab-credits">
    <div class="pagehead"><div><h2 class="sec">Credits</h2><p class="sub">Remaining allocation across every account and key this gateway enforces. Totals add the remainders of capped rows; uncapped rows contribute usage only, because an infinite cap has no remainder.</p></div></div>
    <div id="credits-root">
      <div class="hero-stats" id="credits-total" style="margin-bottom:12px"></div>
      <div class="panel" style="background:transparent;border:0;box-shadow:none;padding:0">
        <div class="panel-b flush" id="credits-list"></div>
      </div>
    </div>
  </section>


  <section class="tab" id="tab-logs">
    <div class="pagehead"><div><h2 class="sec">Logs</h2><p class="sub">Live request and provider events from this process. In memory only; the ring holds the last 500 lines and resets on restart.</p></div><div class="actions"><label class="pg-check" style="margin:0"><input type="checkbox" id="lg-auto"> Auto</label><button class="ghost" id="lg-refresh">Refresh</button><button class="ghost" id="lg-copy">Copy</button></div></div>
    <div class="panel"><div class="panel-b"><pre id="lg-out" class="lg-pre" style="margin:0"></pre></div></div>
  </section>

  <section class="tab" id="tab-budgets">
    <div class="pagehead"><div><h2 class="sec">Budgets</h2><p class="sub">Rolling 24 hour and 30 day caps per account, plus prepaid credits that cover a spent window. Windows roll continuously; there is no midnight reset.</p></div></div>
    <div class="panel">
      <div class="panel-h"><h2 class="sec">Fallback price</h2><span class="small">Per 1M tokens, for models with no price set</span></div>
      <div class="panel-b"><div class="bd-edit" style="margin-top:0;grid-template-columns:repeat(2,minmax(0,1fr)) auto">
        <div><label for="bf-prompt">Input</label><input id="bf-prompt" type="number" min="0" step="0.01"></div>
        <div><label for="bf-completion">Output</label><input id="bf-completion" type="number" min="0" step="0.01"></div>
        <button class="act" id="bf-save" type="button">Save price</button>
      </div></div>
    </div>
    <div class="panel"><div class="panel-b flush" id="bd-list"><div class="empty">Loading\u2026</div></div></div>
  </section>

  <section class="tab" id="tab-reliability">
    <div class="pagehead"><div><h2 class="sec">Reliability</h2><p class="sub">Built-in tool-call repair and the optional taste layer. Both act on model output after the model has answered.</p></div></div>
    <div class="panel">
      <div class="panel-h"><h2 class="sec">Tool-call repair</h2><button class="ghost" id="rl-reset" type="button">Reset counters</button></div>
      <div class="panel-b">
        <div class="rl-head"><label class="switch" aria-label="Tool-call repair"><input type="checkbox" id="rl-tr"><span></span></label><div class="grow"><strong id="rl-tr-state">On</strong><div class="small">Fixes malformed JSON, types and names in tool calls for every provider, streaming or not. A call cut off by the length limit is dropped, never completed.</div></div></div>
        <div class="rl-stats" id="rl-stats" style="margin-top:16px"></div>
        <div class="rl-bars" id="rl-fixes"></div>
        <div class="rl-list" id="rl-recent"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2 class="sec">Taste layer</h2><div style="display:flex;gap:12px;align-items:center"><label class="switch" aria-label="Neural judge" title="Score relevance, instruction-following and tone with a decision model"><input type="checkbox" id="rl-judge"><span></span></label><div class="seg" id="rl-mode" role="group" aria-label="Taste layer mode"><button type="button" data-mode="off">Off</button><button type="button" data-mode="annotate">Annotate</button><button type="button" data-mode="enforce">Enforce</button></div></div></div>
      <div class="panel-b">
        <p class="rl-help" id="rl-mode-help"></p>
        <div id="rl-taste" style="margin-top:16px"></div>
        <h3 class="sec" style="margin:20px 0 6px">Style rules</h3>
        <p class="small">One per line: a regular expression, or a label and a regular expression separated by a vertical bar. A match lowers the score; it never fails a response.</p>
        <textarea id="rl-style" rows="4" spellcheck="false" placeholder="em dash | \u2014"></textarea>
        <div class="form-actions"><button class="act" id="rl-style-save" type="button">Save rules</button></div>
        <div class="rl-list" id="rl-verdicts"></div>
      </div>
    </div>
  </section>

  <section class="tab" id="tab-detection">
    <div class="pagehead"><div><h2 class="sec">Detection</h2><p class="sub">Usage patterns that look like model distillation or limit bypass. Passive only: it records and surfaces, it never blocks a request. Evidence is counts and rates, never prompt or response text.</p></div></div>
    <div class="hero-stats" id="dt-stats"></div>
    <div class="panel">
      <div class="panel-h"><h2 class="sec">Active signals</h2><div class="seg" id="dt-filter" role="group" aria-label="Filter by kind"><button type="button" data-kind="" class="on">All</button><button type="button" data-kind="distillation">Distillation</button><button type="button" data-kind="bypass">Bypass</button></div></div>
      <div class="panel-b flush" id="dt-list"><div class="empty">Loading…</div></div>
    </div>
  </section>

  <section class="tab" id="tab-storage">
    <div class="pagehead"><div><h2 class="sec">Storage</h2><p class="sub">Optional backup of the database and taste data to an S3-compatible bucket (Backblaze B2). A backup path, not the live store: the gateway always reads and writes SQLite locally.</p></div></div>
    <div class="panel">
      <div class="panel-h"><h2 class="sec">S3 bucket</h2><button class="ghost" id="st-test" type="button">Test connection</button></div>
      <div class="panel-b">
        <div id="st-status" style="margin-bottom:14px"></div>
        <p class="small">Configure with environment variables, never here, so the keys cannot be read back out of the admin API:</p>
        <pre class="lg-pre" style="margin-top:10px">S3_ENDPOINT=https://s3.&lt;region&gt;.backblazeb2.com
S3_REGION=&lt;region&gt;
S3_BUCKET=&lt;bucket&gt;
S3_ACCESS_KEY_ID=&lt;key id&gt;
S3_SECRET_ACCESS_KEY=&lt;application key&gt;</pre>
        <div class="form-actions" style="margin-top:16px">
          <button class="act" id="st-enable" type="button">Enable backups</button>
          <button class="ghost" id="st-archive" type="button">Back up now</button>
        </div>
        <div id="st-out" style="margin-top:14px"></div>
      </div>
    </div>
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

// ---------- theme ----------
(function(){
  var btn=document.getElementById('theme-toggle');
  if(!btn) return;
  btn.addEventListener('click',function(){
    var next=document.documentElement.dataset.theme==='light'?'dark':'light';
    document.documentElement.dataset.theme=next;
    try{ localStorage.setItem('gw-theme',next); }catch(e){}
  });
})();

// ---------- budgets ----------
function usd(n){ return '$'+(Number(n)||0).toFixed(2); }
function cdown(s){ s=Math.max(0,Math.round(Number(s)||0)); var d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60); if(d>0) return d+'d '+h+'h'; if(h>0) return h+'h '+m+'m'; return m>0?m+'m':'<1m'; }
function rbMeter(w){
  var capped=w.limit_usd!=null;
  var out=capped&&(w.remaining_usd||0)<=0;
  var fill=capped&&w.spent_usd>0?Math.min(100,Math.max(2.2,w.spent_usd/w.limit_usd*100)):0;
  var tick=capped&&w.resets_in_s!=null?Math.min(99,Math.max(1,w.resets_in_s/(w.hours*3600)*100)):null;
  return '<div class="rb"><div class="rb-top"><span>'+esc(w.label)+'</span><b class="'+(out?'out':'')+'">'+(capped?usd(w.remaining_usd)+' left':'No cap')+'</b></div>'
    +'<div class="rb-track'+(capped?'':' off')+'">'+(fill?'<i class="'+(out?'full':'')+'" style="width:'+fill+'%"></i>':'')+(tick!=null?'<u style="left:'+tick+'%"></u>':'')+'</div>'
    +'<div class="rb-sub"><span>'+usd(w.spent_usd)+' spent'+(capped?' of '+usd(w.limit_usd):'')+'</span>'+(w.resets_in_s!=null?'<span>frees in '+cdown(w.resets_in_s)+'</span>':'<span></span>')+'</div></div>';
}
function bdBinding(a){
  if(a.binding==='credits') return '<span class="pill warn">credits covering</span>';
  if(a.binding==='exhausted') return '<span class="pill bad">blocked</span>';
  if(a.binding==='window') return '<span class="pill ok">within budget</span>';
  return '<span class="pill">no cap</span>';
}
function bdAccountHtml(a){
  var id=esc(a.key_id);
  return '<div class="bd-acct" data-account="'+id+'"><div class="bd-head"><strong>'+esc(a.username)+'</strong>'+bdBinding(a)+'<span class="mono muted2">'+id+'</span></div>'
    +'<div class="bd-meters">'+(a.windows||[]).map(rbMeter).join('')+'</div>'
    +'<div class="bd-edit"><div><label>24 hour cap (USD)</label><input type="number" min="0" step="0.01" data-f="daily" value="'+(a.budget_daily_usd==null?'':a.budget_daily_usd)+'" placeholder="no cap"></div>'
    +'<div><label>30 day cap (USD)</label><input type="number" min="0" step="0.01" data-f="monthly" value="'+(a.budget_monthly_usd==null?'':a.budget_monthly_usd)+'" placeholder="no cap"></div>'
    +'<div><label>Set credits (USD)</label><input type="number" min="0" step="0.01" data-f="credits" value="'+Number(a.credits_usd||0).toFixed(2)+'"></div>'
    +'<button class="act" type="button" data-bd="save">Save</button></div>'
    +'<div class="bd-credit"><span>Credits</span><b>'+usd(a.credits_usd)+'</b><button class="ghost" type="button" data-bd="add" data-amount="10">+10</button><button class="ghost" type="button" data-bd="add" data-amount="50">+50</button><button class="ghost" type="button" data-bd="add" data-amount="100">+100</button><button class="ghost" type="button" data-bd="clear">Clear caps</button></div></div>';
}
async function loadBudgets(){
  var el=document.getElementById('bd-list');
  var r=await api('/admin/rolling-budgets');
  if(r.status===404||!r.data){ el.innerHTML='<div class="empty">Rolling budgets are not available on this build.</div>'; return; }
  document.getElementById('bf-prompt').value=r.data.fallback_price.prompt_per_1m;
  document.getElementById('bf-completion').value=r.data.fallback_price.completion_per_1m;
  var list=r.data.accounts||[];
  el.innerHTML=list.length?list.map(bdAccountHtml).join(''):'<div class="empty">No console accounts yet. Accounts appear once a customer signs in to the console.</div>';
}
async function bdPatch(id, body, okMsg){
  var r=await api('/admin/rolling-budgets/'+encodeURIComponent(id),{method:'POST',body:JSON.stringify(body)});
  if(r.status!==200){ toast((r.data&&r.data.error&&r.data.error.message)||'Could not save','err'); return false; }
  toast(okMsg||'Saved','ok');
  await loadBudgets();
  return true;
}
document.getElementById('bd-list').addEventListener('click',function(e){
  var b=e.target.closest('button[data-bd]'); if(!b) return;
  var box=b.closest('.bd-acct'); var id=box.dataset.account;
  var kind=b.dataset.bd;
  function val(f){ return box.querySelector('input[data-f="'+f+'"]').value; }
  if(kind==='save'){
    var cap=function(v){ return v===''?null:Number(v); };
    bdPatch(id,{budget_daily_usd:cap(val('daily')),budget_monthly_usd:cap(val('monthly')),credits_usd:Number(val('credits')||0)},'Budget saved');
  } else if(kind==='add'){
    bdPatch(id,{credits_add_usd:Number(b.dataset.amount)},'Added $'+b.dataset.amount+' credits');
  } else if(kind==='clear'){
    bdPatch(id,{budget_daily_usd:null,budget_monthly_usd:null},'Caps cleared');
  }
});
document.getElementById('bf-save').addEventListener('click',async function(){
  var r=await api('/admin/rolling-budgets-fallback',{method:'POST',body:JSON.stringify({prompt_per_1m:Number(document.getElementById('bf-prompt').value),completion_per_1m:Number(document.getElementById('bf-completion').value)})});
  if(r.status===200) toast('Fallback price saved','ok'); else toast((r.data&&r.data.error&&r.data.error.message)||'Could not save','err');
});

// ---------- reliability ----------
var TASTE_HELP={
  off:'Nothing is checked. Responses pass through exactly as the model returned them.',
  annotate:'Every response is checked and learned from. Headers report the score; the answer is never changed. Streams are checked after they finish.',
  enforce:'As annotate, plus one retry when a hard rule fails (invalid JSON, a tool call that breaks its schema, an empty or cut-off answer). The better of the two answers is returned. Non-stream requests only.'
};
var FIX_LABELS={json_syntax:'JSON syntax',truncated_closed:'Closed truncation',type_coercion:'Type coercion',enum_snap:'Enum spelling',name_alias:'Tool name',unknown_prop_dropped:'Unknown property',required_default:'Required default'};
function rlSetMode(mode){
  document.querySelectorAll('#rl-mode button').forEach(function(b){ b.classList.toggle('on',b.dataset.mode===mode); b.setAttribute('aria-pressed',String(b.dataset.mode===mode)); });
  document.getElementById('rl-mode-help').textContent=TASTE_HELP[mode]||'';
}
function rlStyleToText(rules){ return (rules||[]).map(function(r){ return (r.label&&r.label!==r.pattern?r.label+' | ':'')+r.pattern; }).join(NL); }
function rlTextToStyle(text){
  return text.split(NL).map(function(l){ return l.trim(); }).filter(Boolean).map(function(l,i){
    var k=l.indexOf(' | ');
    var label=k>0?l.slice(0,k).trim():'';
    var pattern=k>0?l.slice(k+3).trim():l;
    return {id:(label||'rule-'+(i+1)).slice(0,48),label:label||undefined,pattern:pattern};
  });
}
async function loadReliability(){
  var tr=await api('/admin/tool-repair');
  var statsEl=document.getElementById('rl-stats');
  if(tr.status===404||!tr.data){ statsEl.innerHTML='<div class="empty" style="grid-column:1/-1">Tool-call repair is not available on this build.</div>'; }
  else {
    var d=tr.data;
    document.getElementById('rl-tr').checked=!!d.enabled;
    document.getElementById('rl-tr-state').textContent=d.enabled?'On':'Off';
    var t=d.totals||{};
    statsEl.innerHTML=[['Calls seen',t.calls],['Repaired',t.repaired],['Dropped (cut off)',t.dropped_truncated],['Unrepairable',t.unrepairable]].map(function(x){ return '<div><b>'+fmt(x[1])+'</b><span>'+x[0]+'</span></div>'; }).join('');
    var by=d.by_fix||{}; var max=Math.max.apply(null,Object.keys(by).map(function(k){return by[k];}).concat([1]));
    document.getElementById('rl-fixes').innerHTML=Object.keys(FIX_LABELS).map(function(k){ var n=by[k]||0; return '<div class="rl-bar"><span>'+FIX_LABELS[k]+'</span><div><i style="width:'+(n/max*100)+'%"></i></div><em>'+fmt(n)+'</em></div>'; }).join('');
    var rec=d.recent||[];
    document.getElementById('rl-recent').innerHTML=rec.length?rec.slice(0,12).map(function(x){ return '<div><span class="mono">'+esc((x.at||'').slice(11,19))+'</span><strong>'+esc(x.tool||'tool')+'</strong><span>'+esc(x.status==='dropped_truncated'?'dropped (cut off)':(x.fixes||[]).join(', ')||x.status)+'</span></div>'; }).join(''):'<div><span>No repairs recorded since the last restart.</span></div>';
  }
  var ta=await api('/admin/taste');
  var tEl=document.getElementById('rl-taste');
  if(ta.status===404||!ta.data){ tEl.innerHTML='<div class="empty">The taste layer is not available on this build.</div>'; return; }
  rlSetMode(ta.data.mode||'off');
  document.getElementById('rl-judge').checked=ta.data.judge!==false;
  document.getElementById('rl-style').value=rlStyleToText(ta.data.style_rules);
  var models=ta.data.models||[];
  tEl.innerHTML=models.length?'<div style="overflow-x:auto"><table><thead><tr><th>Model</th><th>Taste</th><th>Samples</th><th>Rule means</th></tr></thead><tbody>'+models.map(function(m){
    var routeRows=Object.keys(m.routes||{}).length?'<div class="small" style="margin-top:6px;color:var(--muted)">'+Object.keys(m.routes).map(function(rk){ var rm=m.routes[rk]; return '<div><span class="mono">'+esc(rk)+'</span> '+Object.keys(rm.rules).map(function(k){ return esc(k)+' '+Math.round(rm.rules[k].mean*100)+'%'; }).join(', ')+' (n='+rm.samples+')</div>'; }).join('')+'</div>':'';
    return '<tr><td class="mono">'+esc(m.slug)+routeRows+'</td><td><b>'+(m.taste==null?'-':Math.round(m.taste*100)+'%')+'</b></td><td>'+fmt(m.samples)+'</td><td class="small">'+Object.keys(m.rules).map(function(k){ return esc(k)+' '+Math.round(m.rules[k].mean*100)+'% (n='+m.rules[k].n+')'; }).join(', ')+'</td></tr>';
  }).join('')+'</tbody></table></div>':'<div class="empty">No responses checked yet. Switch the layer to annotate to start measuring.</div>';
  var v=ta.data.recent||[];
  document.getElementById('rl-verdicts').innerHTML=v.length?v.slice(0,10).map(function(x){ return '<div><span class="mono">'+esc((x.at||'').slice(11,19))+'</span><strong>'+esc(x.slug)+'</strong><span>score '+Number(x.score).toFixed(2)+(x.violations.length?' - '+esc(x.violations.join(', ')):'')+'</span></div>'; }).join(''):'';
}
document.getElementById('rl-tr').addEventListener('change',async function(e){
  var want=e.target.checked;
  var r=await api('/admin/tool-repair',{method:'POST',body:JSON.stringify({enabled:want})});
  if(r.status!==200){ e.target.checked=!want; toast('Could not change tool-call repair','err'); return; }
  document.getElementById('rl-tr-state').textContent=want?'On':'Off';
  toast('Tool-call repair '+(want?'on':'off'),'ok');
});
document.getElementById('rl-reset').addEventListener('click',async function(){ await api('/admin/tool-repair',{method:'POST',body:JSON.stringify({reset:true})}); loadReliability(); });
document.getElementById('rl-judge').addEventListener('change',async function(e){
  var want=e.target.checked;
  var r=await api('/admin/taste/judge',{method:'POST',body:JSON.stringify({enabled:want})});
  if(r.status!==200){ e.target.checked=!want; toast('Could not change the neural judge','err'); return; }
  toast('Neural judge '+(want?'on':'off'),'ok');
});
document.getElementById('rl-mode').addEventListener('click',async function(e){
  var b=e.target.closest('button[data-mode]'); if(!b) return;
  var prev=document.querySelector('#rl-mode button.on');
  rlSetMode(b.dataset.mode);
  var r=await api('/admin/taste',{method:'POST',body:JSON.stringify({mode:b.dataset.mode})});
  if(r.status!==200){ if(prev) rlSetMode(prev.dataset.mode); toast('Could not change the taste layer','err'); return; }
  toast('Taste layer: '+b.dataset.mode,'ok');
});
document.getElementById('rl-style-save').addEventListener('click',async function(){
  var r=await api('/admin/taste',{method:'POST',body:JSON.stringify({style_rules:rlTextToStyle(document.getElementById('rl-style').value)})});
  if(r.status===200) toast('Style rules saved','ok'); else toast((r.data&&r.data.error&&r.data.error.message)||'Could not save rules','err');
});

// ---------- Detection (passive) ----------
var dtKind='';
function sevChip(sev){ var cls=sev==='high'?'bad':sev==='medium'?'warn':'mut'; return '<span class="pill '+cls+'">'+sev+'</span>'; }
async function loadDetection(){
  var r=await api('/admin/detection'+(dtKind?('?kind='+dtKind):''));
  var d=r.data||{feed:[],summary:[]};
  var stats=document.getElementById('dt-stats');
  var sum=d.summary||[];
  var dist=sum.filter(function(s){return s.kind==='distillation';}).length;
  var byp=sum.filter(function(s){return s.kind==='bypass';}).length;
  var high=sum.filter(function(s){return s.severity==='high';}).length;
  stats.innerHTML=[
    ['Accounts with signals',sum.length],
    ['Distillation',dist],
    ['Bypass',byp],
    ['High severity',high]
  ].map(function(x){ return '<div class="stat"><div class="k">'+x[0]+'</div><div class="v'+(x[3]&&x[0]==='High severity'?' bad':'')+'">'+fmt(x[1])+'</div></div>'; }).join('');
  var feed=d.feed||[];
  var list=document.getElementById('dt-list');
  if(!feed.length){ list.innerHTML='<div class="empty">No detection events yet. Ordinary usage produces none.</div>'; return; }
  list.innerHTML='<table><thead><tr><th>Time</th><th>Account</th><th>Kind</th><th>Severity</th><th>Score</th><th>Evidence</th></tr></thead><tbody>'+feed.map(function(ev){
    var facts=Object.keys(ev.facts||{}).map(function(k){ return esc(k.replace(/_/g,' '))+' '+esc(String(ev.facts[k])); }).join(', ')||'-';
    return '<tr><td class="mono">'+esc((ev.at||'').slice(5,19).replace('T',' '))+'</td><td class="mono">'+esc(ev.account_id||'-')+'</td><td>'+esc(ev.kind)+'</td><td>'+sevChip(ev.severity)+'</td><td class="mono">'+Number(ev.score).toFixed(2)+'</td><td class="small">'+facts+'</td></tr>';
  }).join('')+'</tbody></table>';
}
document.getElementById('dt-filter').addEventListener('click',function(e){
  var b=e.target.closest('button[data-kind]'); if(!b) return;
  document.querySelectorAll('#dt-filter button').forEach(function(x){ x.classList.toggle('on',x===b); });
  dtKind=b.dataset.kind; loadDetection();
});

// ---------- Storage (optional S3 backup) ----------
async function loadStorage(){
  var r=await api('/admin/storage');
  var d=r.data||{};
  var el=document.getElementById('st-status');
  var en=document.getElementById('st-enable');
  if(!d.configured){
    el.innerHTML='<div class="empty">Not configured. Set the environment variables below and restart, then enable backups.</div>';
    en.disabled=true;
  } else {
    el.innerHTML='<div class="bd-edit" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-top:0">'
      +'<div><label>Bucket</label><div class="mono">'+esc(d.bucket||'-')+'</div></div>'
      +'<div><label>Region</label><div class="mono">'+esc(d.region||'-')+'</div></div>'
      +'<div><label>Endpoint</label><div class="mono">'+esc(d.endpoint||'-')+'</div></div>'
      +'<div><label>Prefix</label><div class="mono">'+esc(d.prefix||'-')+'</div></div></div>';
    en.disabled=false;
    en.textContent=d.enabled?'Disable backups':'Enable backups';
    en.classList.toggle('act',!d.enabled);
    en.classList.toggle('danger',!!d.enabled);
  }
}
document.getElementById('st-enable').addEventListener('click',async function(){
  var cur=(await api('/admin/storage')).data||{};
  var want=!cur.enabled;
  var r=await api('/admin/storage',{method:'POST',body:JSON.stringify({enabled:want})});
  if(r.status===200){ toast('Backups '+(want?'on':'off'),'ok'); loadStorage(); }
  else toast((r.data&&r.data.error&&r.data.error.message)||'Could not change storage','err');
});
document.getElementById('st-test').addEventListener('click',async function(){
  var out=document.getElementById('st-out'); out.innerHTML='<div class="empty">Testing…</div>';
  var r=await api('/admin/storage',{method:'POST',body:JSON.stringify({test:true})});
  var p=r.data&&r.data.probe;
  out.innerHTML=p?('<div class="'+(p.ok?'ok':'bad')+'">'+(p.ok?'Bucket reachable':'Could not reach the bucket')+': '+esc(p.detail||'')+'</div>'):'<div class="bad">'+esc((r.data&&r.data.error&&r.data.error.message)||'Storage is not configured')+'</div>';
});
document.getElementById('st-archive').addEventListener('click',async function(){
  var out=document.getElementById('st-out'); out.innerHTML='<div class="empty">Backing up…</div>';
  var r=await api('/admin/storage/archive',{method:'POST'});
  var d=r.data||{};
  if(d.ok){ out.innerHTML='<div class="ok">Backed up '+d.archived.length+' objects:<br><span class="mono small">'+d.archived.map(esc).join('<br>')+'</span></div>'; toast('Backup complete','ok'); }
  else out.innerHTML='<div class="bad">Backup failed: '+esc(d.error||'unknown')+'</div>';
});

// Arrow keys move between sections when the nav has focus.
document.querySelector('nav').addEventListener('keydown',function(e){
  if(e.key!=='ArrowDown'&&e.key!=='ArrowUp'&&e.key!=='ArrowRight'&&e.key!=='ArrowLeft') return;
  var i=navButtons.indexOf(document.activeElement); if(i<0) return;
  e.preventDefault();
  var n=(e.key==='ArrowDown'||e.key==='ArrowRight')?Math.min(navButtons.length-1,i+1):Math.max(0,i-1);
  navButtons[n].focus();
});

async function selectTab(t){
  if(!document.getElementById('tab-'+t)) return;
  setActiveTab(t);
  try{
    if(t==='overview') await loadOverview();
    if(t==='providers') await loadProviders();
    if(t==='routes') await loadRoutes();
    if(t==='tiers') await loadTiers();
    if(t==='keys') await loadKeys();
    if(t==='accounts') await loadAccounts();
    if(t==='chat'){ await refreshPlaygroundModels(); await refreshPlaygroundIntegrity(); }
    if(t==='cache') await loadCache();
    if(t==='prices') await loadPrices();
    if(t==='limits') await loadLimits();
    if(t==='auto') await loadAutoSettings();
    if(t==='trajectories') await loadTrajectories();
    if(t==='proxies') await loadProxies();
    if(t==='tokens') await loadZaiTokens();
    if(t==='credits') await loadCredits();
    if(t==='logs') await loadLogs();
    if(t==='budgets') await loadBudgets();
    if(t==='reliability') await loadReliability();
    if(t==='detection') await loadDetection();
    if(t==='storage') await loadStorage();
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
    const wrap=document.createElement('div'); wrap.className='field'; wrap.dataset.field=f.key;
    const lab=document.createElement('label'); lab.textContent=f.label; wrap.appendChild(lab);
    let inp;
    if(f.type==='select'||f.type==='multiselect'){ inp=document.createElement('select'); if(f.type==='multiselect') inp.multiple=true; (f.options||[]).forEach(function(o){ const op=document.createElement('option'); op.value=o.value; op.textContent=o.label; if(f.type==='multiselect'&&Array.isArray(f.value)&&f.value.map(String).includes(String(o.value))) op.selected=true; inp.appendChild(op); }); }
    else if(f.type==='textarea'){ inp=document.createElement('textarea'); inp.rows=f.rows||4; }
    else { inp=document.createElement('input'); inp.type=f.type||'text'; }
    inp.dataset.key=f.key;
    if(f.value!=null&&f.type!=='multiselect') inp.value=f.value;
    if(f.placeholder) inp.placeholder=f.placeholder;
    wrap.appendChild(inp);
    if(f.hint){ const h=document.createElement('div'); h.className='small'; h.textContent=f.hint; wrap.appendChild(h); }
    body.appendChild(wrap); vals[f.key]=inp;
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
var PROVIDER_FMT_OPTIONS=[{value:'openai',label:'OpenAI compatible'},{value:'anthropic',label:'Anthropic'},{value:'zaiminted',label:'Z.ai web chat (recommended pure HTTP)'},{value:'zaiwebbrowser',label:'Z.ai web chat (browser fallback)'},{value:'zaiweb',label:'Z.ai web chat (manual caller proof)'}];
// Applies a provider preset to the open provider form: fills the copy the
// preset owns and reveals the route fields, so a known upstream is two clicks
// in the console instead of a hand-typed base_url + fmt + slugs.
var PRESET_FIELD_KEYS=['name','base_url','fmt','transport','api_key','proxy_url','header_preset','extra_headers','seed_routes','preset_slug','preset_upstream','preset_slug2','preset_upstream2'];
function presetRow(vals,key){
  const el=vals[key];
  return el?(el.closest('.field')||el.parentNode):null;
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
    {key:'name',label:'Name',placeholder:'OpenRouter'},
    {key:'base_url',label:'Base URL',placeholder:'https://api.example.com/v1'},
    {key:'api_key',label:'Credential',type:'password',placeholder:'sk-... (stored in DB)'},
    {key:'fmt',label:'Format',type:'select',value:'openai',options:PROVIDER_FMT_OPTIONS},
    {key:'priority',label:'Priority (lower = first)',type:'number',value:'0'},
    {key:'proxy_url',label:'OCI proxy URL (rollback only)',placeholder:'http://user:pass@host:8080'},
    {key:'transport',label:'Transport',type:'select',value:'auto',options:[{value:'auto',label:'Auto (direct unless relay needed)'},{value:'direct',label:'Direct from gateway'},{value:'koyeb',label:'Koyeb relay'},{value:'oci',label:'OCI relay (rollback)'}]},
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
    if(!v.preset || v.preset==='custom') delete v.preset;
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
    applyProviderPreset(vals,{id:'custom'});
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
    {key:'transport',label:'Transport',type:'select',value:p.transport||'auto',options:[{value:'auto',label:'Auto (direct unless relay needed)'},{value:'direct',label:'Direct from gateway'},{value:'koyeb',label:'Koyeb relay'},{value:'oci',label:'OCI relay (rollback)'}]},
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
    // Live upstream balance pill (Charm Hyper shards). Empty until fetched:
    // the figure is a live upstream read, not a stored field.
    return '<tr><td><b>'+esc(p.name)+'</b><div class="small mono">'+esc(p.base_url||'')+'</div></td><td>'+esc(p.fmt||'')+'</td><td>'+esc(p.transport||'auto')+'</td><td>'+keys+'</td><td>'+esc(p.key_strategy||'round_robin')+'</td><td><span class="pill mut" data-credits-for="'+p.id+'">—</span></td><td><span class="pill '+cls+'">'+state+'</span></td>'+
      '<td class="rowact"><button class="ghost" data-act="pkeys" data-id="'+p.id+'">keys</button> <button class="ghost" data-act="pedit" data-id="'+p.id+'">edit</button> <button class="ghost" data-act="pverify" data-id="'+p.id+'" title="Probe what this provider really serves: tokenizer fingerprint, relay routing, identity, limits">verify</button> <button class="ghost" data-act="pcredits" data-id="'+p.id+'" title="Fetch the live balance this provider reports upstream, e.g. remaining Charm Hyper shards">credits</button> '+healthBtn+' '+switchBtn+' <button class="danger" data-act="pdel" data-id="'+p.id+'">delete</button></td></tr>';
  }).join('')||'<tr><td colspan="8"><div class="empty">No providers yet.</div></td></tr>';
  el.innerHTML='<table><tr><th>Provider</th><th>Format</th><th>Transport</th><th>Keys</th><th>Strategy</th><th>Balance</th><th>State</th><th></th></tr>'+rows+'</table>';
}
// Live upstream balance: reads what the provider itself reports (Charm Hyper
// answers GET <base>/credits with the team's remaining Hypercredits). The unit
// is the upstream's own; no figure is invented and no reset date is fabricated
// because the API returns none. The row pill mirrors the modal so the table
// carries the number without opening anything.
async function showProviderCredits(id){
  const pill=document.querySelector('[data-credits-for="'+id+'"]');
  if(pill){ pill.textContent='…'; pill.className='pill mut'; }
  let data; try{ const res=await api('/admin/providers/'+id+'/credits'); data=res.data; }catch(e){ if(pill){ pill.textContent='err'; pill.className='pill bad'; } toast('credits failed: '+e.message,'err'); return; }
  const body=document.getElementById('modal-body');
  document.querySelector('.modal').classList.remove('wide');
  document.getElementById('modal-title').textContent='Balance: '+((data&&data.provider&&data.provider.name)||id);
  document.getElementById('modal-title').style.color='';
  const save=document.getElementById('modal-save'); save.style.display='none';
  document.getElementById('overlay').classList.add('show');
  if(!data||!data.ok){ body.innerHTML='<div class="empty">Upstream did not report a balance'+(data&&data.status?' (HTTP '+data.status+')':'')+'. '+(data&&data.error?esc(data.error):'The provider may not expose a credits endpoint.')+'</div>'; save.style.display=''; if(pill){ pill.textContent='—'; pill.className='pill mut'; } return; }
  let html='';
  if(data.balance!=null){
    if(pill){ pill.textContent=fmt(data.balance)+' shards'; pill.className='pill acc'; }
    html+='<div class="kvrow"><span class="pill acc">'+fmt(data.balance)+'</span><span class="grow small">shards (Hypercredits) remaining</span></div>';
  } else if(data.balance_usd!=null){
    if(pill){ pill.textContent=money(data.balance_usd); pill.className='pill acc'; }
    html+='<div class="kvrow"><span class="pill acc">'+money(data.balance_usd)+'</span><span class="grow small">remaining (this account reports dollars, not shards)</span></div>';
  } else {
    if(pill){ pill.textContent='—'; pill.className='pill mut'; }
    html+='<div class="empty">The upstream reported no balance field.</div>';
  }
  if(data.keys&&data.keys.length>1){
    html+='<h3 class="sec" style="margin:14px 0 8px;font-size:12px">Per key</h3>';
    html+=data.keys.map(function(k){
      const own=k.balance!=null?(fmt(k.balance)+' shards'):(k.balance_usd!=null?money(k.balance_usd):(k.ok?'no figure':'failed'));
      const pill=k.ok?(k.balance!=null||k.balance_usd!=null?'ok':'warn'):'bad';
      return '<div class="kvrow"><span class="pill '+pill+'">'+esc(k.key_label)+'</span><span class="grow small">'+(k.error?('HTTP '+k.status+' · '+esc(String(k.error).slice(0,80))):esc(own))+'</span><span class="right mono small">'+(k.status?('HTTP '+k.status):'')+'</span></div>';
    }).join('');
  }
  html+='<div class="small mono" style="margin:10px 0">GET '+esc(data.base_url||'')+'/credits · '+esc(data.key_label||'')+(data.fetched_at?' · read '+esc(String(data.fetched_at).replace('T',' ').slice(0,19)):'')+'</div>';
  html+='<p class="hint" style="margin:0">The balance resets on the upstream account schedule, not on this gateway. The total sums every key that reported a figure; a key that failed contributes nothing, so the total is a floor, never an inflated guess.</p>';
  body.innerHTML=html;
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
  const routes=data.routes||[];
  const modes=data.selection_modes||{};
  // Group by slug so each public model is ONE card: the slug, its selection
  // mode, and the ordered candidate chain read top to bottom. No repeated
  // slug column, no repeated add-fallback button per row.
  const groups=new Map();
  for(const r of routes){
    if(!groups.has(r.slug)) groups.set(r.slug, []);
    groups.get(r.slug).push(r);
  }
  if(!groups.size){ el.innerHTML='<div class="empty">No model routes yet. Add one.</div>'; return; }
  el.innerHTML=[...groups.entries()].map(function(entry){
    const slug=entry[0], rs=entry[1];
    const mode=modes[slug]||'rank';
    const modePill=mode==='fastest'?'<span class="pill acc" title="Serving tries the lowest-latency candidate first, from measured route latency">fastest</span>':'<span class="pill mut" title="Serving tries candidates in rank order">in order</span>';
    const toggle='<button class="ghost" data-act="rmode" data-slug="'+esc(slug)+'" data-mode="'+esc(mode)+'">'+(mode==='fastest'?'use rank order':'use fastest')+'</button>';
    const chat=rs.filter(function(r){return String(r.model_kind||'chat')!=='decision';});
    const kindNote=chat.length&&chat.length<rs.length?' <span class="pill warn">decision route inside</span>':'';
    const rows=rs.map(function(r,ix){
      const providerOff=r.provider_enabled===undefined?false:!r.provider_enabled;
      const cls=(r.enabled&&r.provider_healthy&&!providerOff)?'ok':'bad';
      const label=r.enabled?(providerOff?'provider disabled':(r.provider_healthy?'on':'provider down')):'off';
      const ema=r.latency_ema!=null?('~'+Math.round(Number(r.latency_ema))+'ms'):'no data';
      const emaCls=r.latency_ema!=null?'pill acc':'pill mut';
      const verdict=r.probe_verdict?('<span class="pill '+verdictClass(r.probe_verdict)+'" title="'+esc(r.probe_measured_family||'')+'">'+esc(r.probe_verdict)+'</span>'):'';
      const kindPill=String(r.model_kind||'chat')==='decision'?'<span class="pill warn">decision</span>':'';
      return '<div class="kvrow"><span class="pill mut">'+(ix+1)+'</span>'
        +'<span class="grow"><span class="mono">'+esc(r.provider_name||'')+'</span> <span class="mono small muted2">'+esc(r.upstream_model)+'</span></span>'
        +'<span class="'+emaCls+'" title="Rolling latency EMA from real serving attempts">'+esc(ema)+'</span>'
        +'<span class="pill '+cls+'">'+esc(label)+'</span>'+verdict+kindPill
        +'<span class="right"><button class="ghost" data-act="rverify" data-id="'+esc(String(r.provider_id))+'" data-slug="'+esc(slug)+'" title="Probe this route: tokenizer fingerprint, relay routing, identity">verify</button> '
        +'<button class="ghost" data-act="redit" data-id="'+r.id+'">edit</button> '
        +'<button class="ghost" data-act="rtoggle" data-id="'+r.id+'" data-e="'+r.enabled+'">'+(r.enabled?'disable':'enable')+'</button> '
        +'<button class="danger" data-act="rdel" data-id="'+r.id+'">del</button></span></div>';
    }).join('');
    return '<div class="routegroup"><div class="kvrow"><span class="mono strong">'+esc(slug)+'</span>'
      +'<span class="grow"></span>'+modePill+kindNote
      +'<span class="right">'+toggle+' <button class="ghost" data-act="raddfb" data-slug="'+esc(slug)+'" data-kind="chat" data-wire="">add route</button></span></div>'
      +rows+'</div>';
  }).join('');
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
    {key:'model_kind',label:'Model type',type:'select',value:'chat',options:[{value:'chat',label:'Chat'},{value:'decision',label:'Decision / System-One'}]},
    {key:'wire_format',label:'Wire format (blank = inherit provider)',type:'select',value:'',options:[{value:'',label:'Inherit provider'},{value:'openai',label:'OpenAI'},{value:'anthropic',label:'Anthropic'},{value:'systemone',label:'SystemOne'}]},
    {key:'endpoint_path',label:'Endpoint path (blank = default)',placeholder:'/v1/systemone'},
    {key:'enabled',label:'State',type:'select',value:'1',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.provider_id=Number(v.provider_id); v.rank=Number(v.rank); v.enabled=v.enabled==='1';
    v.wire_format=v.wire_format||null; v.endpoint_path=v.endpoint_path||null;
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
    {key:'model_kind',label:'Model type',type:'select',value:String(r.model_kind||'chat'),options:[{value:'chat',label:'Chat'},{value:'decision',label:'Decision / System-One'}]},
    {key:'wire_format',label:'Wire format (blank = inherit provider)',type:'select',value:String(r.wire_format||''),options:[{value:'',label:'Inherit provider'},{value:'openai',label:'OpenAI'},{value:'anthropic',label:'Anthropic'},{value:'systemone',label:'SystemOne'}]},
    {key:'endpoint_path',label:'Endpoint path (blank = default)',value:r.endpoint_path||''},
    {key:'enabled',label:'State',type:'select',value:r.enabled?'1':'0',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.provider_id=Number(v.provider_id); v.rank=Number(v.rank); v.enabled=v.enabled==='1';
    v.wire_format=v.wire_format||null; v.endpoint_path=v.endpoint_path||null;
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
  openModal('Add route for '+slug,[
    {key:'provider_id',label:'Provider',type:'select',options:opts},
    {key:'upstream_model',label:'Upstream model id',placeholder:'model-id'},
    {key:'model_kind',label:'Model type',type:'select',value:'chat',options:[{value:'chat',label:'Chat'},{value:'decision',label:'Decision / System-One'}]},
    {key:'enabled',label:'State',type:'select',value:'1',options:[{value:'1',label:'enabled'},{value:'0',label:'disabled'}]}
  ], async function(v){
    v.provider_id=Number(v.provider_id); v.enabled=v.enabled==='1';
    // Rank lands at the END of the chain automatically; the card shows the
    // order, so the operator never types a rank number by hand.
    const {data:rd}=await api('/admin/routes');
    const siblings=(rd.routes||[]).filter(function(r){return r.slug===slug;});
    const nextRank=siblings.length?Math.max.apply(null,siblings.map(function(r){return Number(r.rank)||0;}))+1:0;
    const {status,data}=await api('/admin/routes',{method:'POST',body:JSON.stringify({slug:slug,provider_id:v.provider_id,upstream_model:v.upstream_model,rank:nextRank,model_kind:v.model_kind,enabled:v.enabled})});
    if(status===201){ toast('route added at rank '+nextRank,'ok'); closeModal(); loadRoutes(); }
    else toast('add failed: '+(data&&data.error&&data.error.message||status),'err');
  });
}
async function setSlugMode(slug, mode){
  const {status,data}=await api('/admin/routes/selection-mode/'+encodeURIComponent(slug),{method:'PUT',body:JSON.stringify({mode})});
  if(status===200){ toast(slug+' now serves '+(mode==='fastest'?'the fastest route first':'routes in order'),'ok'); loadRoutes(); }
  else toast('mode change failed: '+(data&&data.error&&data.error.message||status),'err');
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
  else if(act==='pcredits') showProviderCredits(id);
  else if(act==='pdel') delProvider(id);
  else if(act==='redit') editRoute(id);
  else if(act==='rverify') verifyProvider(id, btn.getAttribute('data-slug'));
  else if(act==='raddfb') addFallbackRoute(btn);
  else if(act==='rmode') setSlugMode(btn.getAttribute('data-slug'), btn.getAttribute('data-mode')==='fastest'?'rank':'fastest');
  else if(act==='rtoggle') toggleRoute(id, btn.getAttribute('data-e')==='1'?0:1);
  else if(act==='rdel') delRoute(id);
  else if(act==='tieredit') editTier(id);
  else if(act==='tierdel') delTier(id);
  else if(act==='copy') copyKey(id);
  else if(act==='kedit') editKey(id);
  else if(act==='ktoggle') toggleKey(id, btn.getAttribute('data-active')==='1'?0:1);
  else if(act==='kdel') delKey(id);
  else if(act==='kpool') setPool(id);
  else if(act==='acctreset') createResetLink(id);
  else if(act==='acctedit') editAccountLimits(id);
  else if(act==='tokdel') revokeToken(id);
  else if(act==='copylink') copyLink(btn.getAttribute('data-link'));
  else if(act==='tjprev'){ tjOffset=Math.max(0,tjOffset-tjLimit); loadTrajectories(); }
  else if(act==='tjnext'){ tjOffset+=tjLimit; loadTrajectories(); }
});

async function publicModelOptions(kind){ const {data}=await api('/admin/routes'); const seen=[]; const out=[]; for(const r of (data&&data.routes||[])){ if(!r.enabled) continue; const rk=String(r.model_kind||'chat'); if(kind&&kind!=='all'&&rk!==kind) continue; if(seen.indexOf(r.slug)>=0) continue; seen.push(r.slug); out.push({value:r.slug,label:kind==='all'&&rk==='decision'?r.slug+' \u00b7 decision':r.slug}); } return out.sort(function(a,b){return a.value.localeCompare(b.value);}); }
async function refreshTierSlugSelect(){ const select=document.getElementById('tier-slugs'); if(!select)return; const opts=await publicModelOptions('all'); select.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>';}).join('')||'<option disabled>No enabled public models</option>'; }
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
  const opts=await publicModelOptions('all');
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
  let poolId=''; try{ const pr=await api('/admin/shared-pool'); poolId=(pr.data&&pr.data.key_id)||''; }catch(e){}
  const rows=(data&&data.keys||[]).map(function(k){
    const used=k.budget_mode==='usd'?money(k.used_usd):fmt(k.used_tokens);
    const lim=k.budget_mode==='usd'?money(k.budget_limit):fmt(k.budget_limit);
    const am=k.allowed_models?esc(k.allowed_models):'<span class="pill mut">no extras</span>';
    const tiers=k.tier_names?esc(k.tier_names):'<span class="pill mut">none</span>';
    const excludes=k.excluded_models?esc(k.excluded_models):'<span class="pill mut">none</span>';
    const rpm=k.request_limit_per_minute?fmt(k.request_limit_per_minute)+'/min':'<span class="pill mut">unlimited</span>';
    const expiry=expiryLabel(k.expires_at);
    const isPool=poolId&&k.key_id===poolId;
    const active=(!k.active?'<span class="pill bad">off</span>':(k.expires_at&&new Date(k.expires_at).getTime()<=Date.now()?'<span class="pill bad">expired</span>':'<span class="pill ok">active</span>'));
    const poolPill=isPool?' <span class="pill ok">shared pool</span>':'';
    const poolBtn=isPool?'<button class="ghost" data-act="kpoolclear">unset pool</button>':'<button class="ghost" data-act="kpool" data-id="'+esc(k.key_id)+'">set pool</button>';
    return '<tr><td><b>'+esc(k.name)+'</b>'+poolPill+'<div class="mono small">'+esc(k.key_id)+'</div></td><td>'+used+' / '+lim+'</td><td>'+rpm+'</td><td>'+fmt(k.request_count)+'</td><td>'+tiers+'</td><td>'+am+'</td><td>'+excludes+'</td><td>'+expiry+'</td><td>'+active+'</td>'+
      '<td><button class="ghost" data-act="copy" data-id="'+esc(k.key_id)+'">copy</button> '+poolBtn+' <button class="ghost" data-act="kedit" data-id="'+esc(k.key_id)+'">edit</button> <button class="ghost" data-act="ktoggle" data-id="'+esc(k.key_id)+'" data-active="'+(k.active?1:0)+'">'+(k.active?'deact':'act')+'</button> <button class="danger" data-act="kdel" data-id="'+esc(k.key_id)+'">del</button></td></tr>';
  }).join('') || '<tr><td colspan="10"><div class="empty">No keys yet.</div></td></tr>';
  el.innerHTML='<table><tr><th>Key</th><th>Budget</th><th>Rate</th><th>Reqs</th><th>Tiers</th><th>Extra allow</th><th>Excludes</th><th>Expiry</th><th>State</th><th></th></tr>'+rows+'</table>';
}
async function setPool(id){ const {status,data}=await api('/admin/shared-pool',{method:'PUT',body:JSON.stringify({key_id:id})}); if(status===200){ toast('shared pool set','ok'); loadKeys(); } else toast('could not set pool: '+(data&&data.error&&data.error.message||status),'err'); }
async function clearPool(){ const {status,data}=await api('/admin/shared-pool',{method:'PUT',body:JSON.stringify({key_id:null})}); if(status===200){ toast('shared pool cleared','ok'); loadKeys(); } else toast('could not clear pool: '+(data&&data.error&&data.error.message||status),'err'); }
async function toggleKey(id, active){ await api('/admin/keys/'+id+'/'+(active?'activate':'deactivate'),{method:'POST'}); loadKeys(); }
function copyKey(id){ try{ navigator.clipboard.writeText(id).then(function(){ toast('key copied','ok'); }); }catch(e){ toast('copy failed','err'); } }
function delKey(id){ confirmAction('Delete key','Delete this key? Its budget, console account, sessions, and cached responses are removed. This cannot be undone.','Delete',async function(){ const {status,data}=await api('/admin/keys/'+id,{method:'DELETE'}); if(status===200){ toast('key deleted','ok'); loadKeys(); } else toast('delete failed: '+(data&&data.error&&data.error.message||status),'err'); }); }
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

// ---------- ACCOUNTS ----------
function accountKeyLabel(k){
  const used=k.budget_mode==='usd'?money(k.used_usd):fmt(k.used_tokens);
  const lim=k.budget_limit==null?'no cap':(k.budget_mode==='usd'?money(k.budget_limit):fmt(k.budget_limit));
  return esc(k.name)+' — '+used+' / '+lim+' '+(k.budget_mode==='usd'?'USD':'tokens');
}
async function refreshAccountTierSelect(){
  const sel=document.getElementById('acct-new-tiers');
  if(!sel) return;
  let tiers=[];
  try{ const tr=await api('/admin/model-tiers'); tiers=(tr.data&&tr.data.tiers)||[]; }catch(e){ return; }
  sel.innerHTML=tiers.map(function(t){return '<option value="'+esc(String(t.id))+'">'+esc(t.name)+'</option>';}).join('')||'<option value="">(no tiers defined)</option>';
}
async function loadAccounts(){
  const el=document.getElementById('accounts-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/accounts'); data=res.data; }catch(e){ paintLoadError(el,'Could not load accounts: '+e.message,loadAccounts); return; }
  const accounts=(data&&data.accounts)||[];
  const tokens=(data&&data.tokens)||[];
  const rows=accounts.map(function(a){
    const used=a.budget_mode==='usd'?money(a.used_usd):fmt(a.used_tokens);
    const lim=a.budget_limit==null?'<span class="pill mut">no cap</span>':(a.budget_mode==='usd'?money(a.budget_limit):fmt(a.budget_limit));
    const tiers=a.tier_names?esc(a.tier_names):'<span class="pill mut">none</span>';
    return '<tr><td><b>'+esc(a.username)+'</b><br><span class="mono small">'+esc(a.key_id)+'</span></td><td>'+used+' / '+lim+' '+(a.budget_mode==='usd'?'USD':'tok')+'</td><td>'+fmt(a.key_count)+' keys</td><td>'+tiers+'</td><td><button class="ghost" data-act="acctreset" data-id="'+esc(a.key_id)+'">reset link</button> <button class="ghost" data-act="acctedit" data-id="'+esc(a.key_id)+'">cap + tiers</button></td></tr>';
  }).join('')||'<tr><td colspan="5"><div class="empty">No accounts yet. Create one above.</div></td></tr>';
  el.innerHTML='<table><tr><th>Account</th><th>Spend</th><th>Keys</th><th>Tiers</th><th></th></tr>'+rows+'</table>';
  await refreshAccountTierSelect();
  const acctSel=document.getElementById('acct-key');
  if(acctSel)
    acctSel.innerHTML=accounts.map(function(a){return '<option value="'+esc(a.key_id)+'">'+esc(a.username)+' ('+esc(a.key_id)+')</option>';}).join('');
  // Legacy key invite: keys with no account yet, straight from the keys tab.
  const legacySel=document.getElementById('acct-legacy-key');
  if(legacySel){
    let keys=[]; try{ const kr=await api('/admin/keys'); keys=(kr.data&&kr.data.keys)||[]; }catch(e){ keys=[]; }
    const claimed=new Set(accounts.map(function(a){return a.key_id;}));
    const free=keys.filter(function(k){ return !claimed.has(k.key_id); });
    legacySel.innerHTML=free.map(function(k){return '<option value="'+esc(k.key_id)+'">'+esc(k.name)+' — '+esc(k.key_id)+'</option>';}).join('')||'<option value="">(no free keys)</option>';
  }
  const tl=document.getElementById('acct-tokens-list');
  if(tl){
    const now=Date.now();
    const trows=tokens.map(function(t){
      const expired=new Date(t.expires_at).getTime()<now;
      let badge;
      if(t.used_at) badge='<span class="pill mut">used</span>';
      else if(expired) badge='<span class="pill warn">expired</span>';
      else badge='<span class="pill ok">pending</span>';
      return '<tr><td class="mono small">'+esc(t.purpose)+'</td><td class="mono small">'+esc(t.key_id)+'</td><td>'+badge+'</td><td class="small">'+esc(t.expires_at)+'</td><td>'+(t.used_at||expired?'':'<button class="danger" data-act="tokdel" data-id="'+esc(t.token_hash)+'">revoke</button>')+'</td></tr>';
    }).join('')||'<tr><td colspan="5"><div class="empty">No links issued yet.</div></td></tr>';
    tl.innerHTML='<table><tr><th>Purpose</th><th>Account</th><th>State</th><th>Expires</th><th></th></tr>'+trows+'</table>';
  }
}
function paintAcctLink(kind,out){
  return function(status,r){
    if(status===201&&r&&r.url){
      out.innerHTML='<b>'+(kind==='reset'?'Reset link':'Account creation link')+':</b> <span class="mono small selectable">'+esc(r.url)+'</span> <button class="ghost" data-act="copylink" data-link="'+esc(r.url)+'">copy</button>';
      toast((kind==='reset'?'reset':'account')+' link created, expires in 24h','ok');
      loadAccounts();
    } else {
      toast('could not create link: '+(r&&r.error&&r.error.message||status),'err');
    }
  };
}
document.getElementById('acct-new-create').onclick=async function(){
  const tier_ids=Array.from(document.getElementById('acct-new-tiers').selectedOptions).map(function(o){return Number(o.value);}).filter(function(n){return Number.isFinite(n);});
  const rawLimit=document.getElementById('acct-new-limit').value;
  const body={budget_mode:document.getElementById('acct-new-mode').value, budget_limit:rawLimit===''?null:Number(rawLimit), tier_ids};
  const {status,data}=await api('/admin/accounts',{method:'POST',body:JSON.stringify(body)});
  paintAcctLink('invite',document.getElementById('acct-new-out'))(status,data);
};
document.getElementById('acct-invite').onclick=async function(){
  const id=document.getElementById('acct-legacy-key').value;
  if(!id||!id.startsWith('sk-')){ toast('no free key selected','err'); return; }
  const {status,data}=await api('/admin/accounts/'+id+'/invite-link',{method:'POST'});
  paintAcctLink('invite',document.getElementById('acct-invite-out'))(status,data);
};
document.getElementById('acct-reset').onclick=async function(){
  const id=document.getElementById('acct-key').value;
  if(!id){ toast('no account selected','err'); return; }
  const {status,data}=await api('/admin/accounts/'+id+'/reset-link',{method:'POST'});
  paintAcctLink('reset',document.getElementById('acct-out'))(status,data);
};
async function createResetLink(id){
  const {status,data}=await api('/admin/accounts/'+id+'/reset-link',{method:'POST'});
  paintAcctLink('reset',document.getElementById('acct-out'))(status,data);
}
async function editAccountLimits(id){
  const {data}=await api('/admin/accounts'); const a=((data&&data.accounts)||[]).find(function(x){return x.key_id===id;});
  if(!a){ toast('account not found','err'); return; }
  let opts=[];
  try{ const tr=await api('/admin/model-tiers'); opts=((tr.data&&tr.data.tiers)||[]).map(function(t){return {value:String(t.id),label:t.name};}); }catch(e){}
  openModal('Account: '+(a.username||a.key_id),[
    {key:'budget_mode',label:'Spend cap mode',type:'select',value:a.budget_mode,options:[{value:'usd',label:'USD ($)'},{value:'tokens',label:'Tokens'}]},
    {key:'budget_limit',label:'Spend cap (blank = no cap)',type:'text',value:a.budget_limit==null?'':String(a.budget_limit)},
    {key:'tier_ids',label:'Model tiers (keys inherit these)',type:'multiselect',value:(a.tier_names||'').split(' \u00B7 ').filter(Boolean).map(function(n){return String((opts.find(function(o){return o.label===n;})||{}).value||'');}),options:opts}
  ],async function(v){
    const body={budget_mode:v.budget_mode, budget_limit:v.budget_limit===''?null:Number(v.budget_limit), tier_ids:v.tier_ids.map(Number)};
    const {status,data:r}=await api('/admin/accounts/'+id,{method:'PATCH',body:JSON.stringify(body)});
    if(status===200){ toast('account updated','ok'); closeModal(); loadAccounts(); }
    else toast('update failed: '+(r&&r.error&&r.error.message||status),'err');
  });
}
async function createResetLink(id){
  const {status,data}=await api('/admin/accounts/'+id+'/reset-link',{method:'POST'});
  paintAcctLink('reset',document.getElementById('acct-out'))(status,data);
}
async function revokeToken(hash){
  confirmAction('Revoke link','Revoke this account link? It will stop working immediately.','Revoke',async function(){
    const {status,data}=await api('/admin/account-tokens/'+hash,{method:'DELETE'});
    if(status===200){ toast('link revoked','ok'); loadAccounts(); }
    else toast('revoke failed: '+(data&&data.error&&data.error.message||status),'err');
  });
}
function copyLink(link){
  try{ navigator.clipboard.writeText(link).then(function(){ toast('link copied','ok'); }); }catch(e){ toast('copy failed','err'); }
}


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
  var select=document.getElementById('c-model'); if(!select)return;
  var selected=select.value; var opts=await publicModelOptions(playgroundMode==='decision'?'decision':'chat');
  var empty=playgroundMode==='decision'?'No decision models configured':'No enabled public models';
  select.innerHTML=opts.map(function(o){return '<option value="'+esc(o.value)+'"'+(o.value===selected?' selected':'')+'>'+esc(o.label)+'</option>';}).join('') || '<option value="">'+esc(empty)+'</option>';
  if(!select.value&&select.options.length&&select.options[0].value) select.value=select.options[0].value;
}
function setPlaygroundMode(mode){
  playgroundMode = mode==='decision' ? 'decision' : 'chat';
  var dec=document.getElementById('c-decision-config');
  var ans=document.getElementById('c-dec-answers');
  var label=document.getElementById('c-model-label');
  var streamBox=document.getElementById('c-stream');
  var chat=document.getElementById('c-mode-chat');
  var decBtn=document.getElementById('c-mode-decision');
  if(dec) dec.hidden=playgroundMode!=='decision';
  if(ans) ans.hidden=playgroundMode!=='decision';
  if(label) label.textContent=playgroundMode==='decision'?'Decision model slug':'Model slug';
  if(streamBox) streamBox.closest('label').hidden=playgroundMode==='decision';
  if(chat){ chat.classList.toggle('is-on',playgroundMode==='chat'); chat.setAttribute('aria-selected',playgroundMode==='chat'?'true':'false'); }
  if(decBtn){ decBtn.classList.toggle('is-on',playgroundMode==='decision'); decBtn.setAttribute('aria-selected',playgroundMode==='decision'?'true':'false'); }
  var send=document.getElementById('c-send');
  if(send) send.textContent=playgroundMode==='decision'?'Ask':'Send';
  refreshPlaygroundModels();
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
document.getElementById('c-send').onclick=async function(){ if(playgroundMode==='decision'){ await sendPlaygroundDecision(); return; } await sendPlaygroundMessage(); };
document.getElementById('c-prompt').addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){ e.preventDefault(); if(playgroundMode==='decision') sendPlaygroundDecision(); else sendPlaygroundMessage(); } });
document.getElementById('c-clear').onclick=function(){
  pgMessages=[];
  document.getElementById('c-messages').value=JSON.stringify(playgroundDefaultMessages(),null,2);
  document.getElementById('c-prompt').value='';
  renderPlaygroundMessages([]); setPlaygroundStatus('Ready when you are.'); setPlaygroundTrace(null);
};
document.getElementById('c-verify').onclick=function(){ verifyPlaygroundSlug(); };
document.getElementById('c-model').addEventListener('change',function(){ refreshPlaygroundIntegrity(); });
document.getElementById('c-mode-chat').addEventListener('click',function(){ setPlaygroundMode('chat'); });
document.getElementById('c-mode-decision').addEventListener('click',function(){ setPlaygroundMode('decision'); });
var DEC_EXAMPLES={
  yesno:{state:{task:"fix the session writer race"},questions:{verify:{type:"noul",instructions:"Does this change require objective verification before merge?"}}},
  choice:{state:{task:"route this request",prompt:"summarize a 2-line diff"},questions:{tier:{type:"choice",instructions:"Which model tier fits this task?",criteria:{"fast-small":"cheap, quick, simple asks","balanced":"general work","flagship":"hard reasoning"}}}},
  score:{state:{answer:"The capital of France is Paris."},questions:{quality:{type:"score",instructions:"Rate the answer's quality.",criteria:["poor","fair","good","excellent"]}}}
};
document.addEventListener('click',function(e){
  var b=e.target.closest&&e.target.closest('[data-dec-ex]'); if(!b) return;
  var ex=DEC_EXAMPLES[b.getAttribute('data-dec-ex')]; if(!ex) return;
  document.getElementById('c-dec-state').value=JSON.stringify(ex.state,null,2);
  document.getElementById('c-dec-questions').value=JSON.stringify(ex.questions,null,2);
  toast('example loaded','ok');
});
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
var playgroundMode='chat';
function renderDecisionAnswers(answers,meta){
  var box=document.getElementById('c-dec-answers'); if(!box) return;
  if(!answers){ box.innerHTML='<div class="empty">No decision answers yet.</div>'; return; }
  var html='';
  for(const name of Object.keys(answers)){
    var a=answers[name]||{};
    var head='<div class="pg-dec-card"><div class="k">'+esc(name)+' <span class="pill mut">'+esc(a.type)+'</span></div>';
    if(a.type==='choice'){
      head+='<div class="pg-dec-choice">'+esc(a.choice==null?'n/a':a.choice)+'</div>';
      var probs=a.probabilities||{}; var keys=Object.keys(probs);
      for(const k of keys){
        var pct=Math.round((Number(probs[k])||0)*100);
        head+='<div class="pg-dec-bar"><span class="lbl">'+esc(k)+'</span><span class="trk"><i style="width:'+pct+'%"></i></span><b>'+pct+'%</b></div>';
      }
    } else if(a.type==='score'){
      head+='<div class="pg-dec-choice">'+esc(a.label==null?String(a.score):a.label)+'</div>';
    } else {
      var p=Math.round((Number(a.probability)||0)*100);
      head+='<div class="pg-dec-choice">'+p+'%</div><div class="pg-dec-track" role="meter" aria-valuenow="'+p+'"><i style="width:'+p+'%"></i></div>';
    }
    head+='<div class="small">confidence '+(a.confidence==null?'n/a':Math.round(a.confidence*100)+'%')+'</div></div>';
    html+=head;
  }
  if(meta) html+='<div class="small" style="margin-top:8px">'+esc(meta)+'</div>';
  box.innerHTML=html;
}
async function sendPlaygroundDecision(){
  var modelEl=document.getElementById('c-model'); var model=modelEl?modelEl.value.trim():'';
  if(!model){ toast('choose a decision model','err'); return; }
  var state,questions;
  try{ state=JSON.parse(document.getElementById('c-dec-state').value); }
  catch(e){ toast('State must be valid JSON','err'); return; }
  try{ questions=JSON.parse(document.getElementById('c-dec-questions').value); }
  catch(e){ toast('Questions must be valid JSON','err'); return; }
  if(pgBusy) return;
  pgBusy=true;
  var btn=document.getElementById('c-send'); if(btn) btn.disabled=true;
  setPlaygroundStatus('Asking '+model+'…');
  var startedAt=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
  try{
    var r=await fetch(API+'/admin/playground/systemone',{method:'POST',headers:{'Content-Type':'application/json','x-request-id':Math.random().toString(36).slice(2)},credentials:'same-origin',body:JSON.stringify({model:model,state:state,questions:questions})});
    var data=null; try{ data=await r.json(); }catch(e){}
    var elapsed=(((typeof performance!=='undefined'&&performance.now)?performance.now():Date.now())-startedAt)/1000;
    if(!r.ok){
      var msg=(data&&data.error&&data.error.message)||('HTTP '+r.status);
      setPlaygroundStatus('Decision failed: '+msg);
      renderDecisionAnswers(null,msg);
      return;
    }
    renderDecisionAnswers(data.answers, (data.upstream_model||'')+' · '+(data.source||'remote')+' · '+elapsed.toFixed(2)+'s');
    setPlaygroundStatus('Answered in '+elapsed.toFixed(2)+'s');
  }catch(e){
    setPlaygroundStatus('Decision failed: '+e.message);
    renderDecisionAnswers(null,e.message);
  }finally{
    pgBusy=false; if(btn) btn.disabled=false;
  }
}

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

document.getElementById('pr-save').onclick=async function(){
  const slug=document.getElementById('pr-slug').value.trim();
  if(!slug){ toast('slug required','err'); return; }
  await savePriceRow({
    slug,
    provider_id: 0,
    prompt_per_1m: document.getElementById('pr-prompt').value,
    completion_per_1m: document.getElementById('pr-completion').value,
    actual_prompt_per_1m: document.getElementById('pr-actual-prompt').value,
    actual_completion_per_1m: document.getElementById('pr-actual-completion').value,
    cache_read_per_1m: document.getElementById('pr-cache-read').value,
    cache_write_per_1m: document.getElementById('pr-cache-write').value,
    actual_mode: document.getElementById('pr-actual-mode').value,
    actual_per_request: document.getElementById('pr-actual-request').value
  });
};
document.getElementById('pr-sync').onclick=async function(){
  const btn=document.getElementById('pr-sync');
  btn.disabled=true;
  try{
    const {status,data}=await api('/admin/prices/sync-models-dev',{method:'POST'});
    if(status===200){ toast('synced '+(data.matched||0)+' equivalent prices'+(data.unmatched?' · '+data.unmatched+' unmatched':''),'ok'); loadPrices(); }
    else toast('sync failed: '+(data&&data.error&&data.error.message||status),'err');
  }catch(e){ toast('sync failed: '+e.message,'err'); }
  finally{ btn.disabled=false; }
};
function optRate(v){ const s=String(v==null?'':v).trim(); return s===''?null:s; }
function dashRate(v){ return v==null||v===''?'<span class="small">—</span>':money(Number(v))+'/1M'; }
let priceCache=[];
async function postPrice(p){
  const body=JSON.stringify({
    slug: p.slug,
    provider_id: Number(p.provider_id)||0,
    prompt_per_1m: p.prompt_per_1m||0,
    completion_per_1m: p.completion_per_1m||0,
    actual_prompt_per_1m: optRate(p.actual_prompt_per_1m),
    actual_completion_per_1m: optRate(p.actual_completion_per_1m),
    cache_read_per_1m: optRate(p.cache_read_per_1m),
    cache_write_per_1m: optRate(p.cache_write_per_1m),
    actual_mode: p.actual_mode==='per_request'?'per_request':'per_1m',
    actual_per_request: optRate(p.actual_per_request)
  });
  return api('/admin/prices',{method:'POST',body});
}
async function savePriceRow(p){
  if(!p.slug){ toast('slug required','err'); return false; }
  const {status,data}=await postPrice(p);
  if(status===200){ toast('price saved','ok'); loadPrices(); return true; }
  toast('save failed: '+(data&&data.error&&data.error.message||status),'err');
  return false;
}
// ----- consolidated per-slug editor (default + provider overrides) -----
function peActualBlock(prefix, d){
  d=d||{};
  const v=function(x){ return x==null||x===''?'':String(x); };
  const mode=d.actual_mode==='per_request'?'per_request':'per_1m';
  return '<div class="form-grid">'
    +'<div><label>Actual basis</label><select id="'+prefix+'-mode"><option value="per_1m"'+(mode==='per_1m'?' selected':'')+'>Per 1M tokens</option><option value="per_request"'+(mode==='per_request'?' selected':'')+'>Flat per request</option></select></div>'
    +'<div><label>Actual $/request</label><input id="'+prefix+'-req" type="number" step="0.0001" value="'+v(d.actual_per_request)+'" placeholder="0"></div>'
    +'<div><label>Actual prompt $/1M</label><input id="'+prefix+'-ap" type="number" step="0.0001" value="'+v(d.actual_prompt_per_1m)+'" placeholder="= equivalent"></div>'
    +'<div><label>Actual completion $/1M</label><input id="'+prefix+'-ac" type="number" step="0.0001" value="'+v(d.actual_completion_per_1m)+'" placeholder="= equivalent"></div>'
    +'<div><label>Cache read $/1M</label><input id="'+prefix+'-cr" type="number" step="0.0001" value="'+v(d.cache_read_per_1m)+'" placeholder="= prompt"></div>'
    +'<div><label>Cache write $/1M</label><input id="'+prefix+'-cw" type="number" step="0.0001" value="'+v(d.cache_write_per_1m)+'" placeholder="0"></div>'
    +'</div>';
}
function peReadActual(prefix){
  const g=function(s){ const el=document.getElementById(prefix+s); return el?el.value:''; };
  return { actual_mode:g('-mode'), actual_per_request:g('-req'), actual_prompt_per_1m:g('-ap'), actual_completion_per_1m:g('-ac'), cache_read_per_1m:g('-cr'), cache_write_per_1m:g('-cw') };
}
function peOverrideBlock(pid, name, d){
  return '<div class="pe-ov" data-pid="'+pid+'"><div class="pe-ov-head"><b>'+esc(name||('provider #'+pid))+'</b>'
    +'<button class="danger" type="button" data-act="pe-rm">remove</button></div>'+peActualBlock('pe-ov-'+pid, d)+'</div>';
}
async function editPrice(slug){
  const rows=priceCache.filter(function(x){ return x.slug===slug; });
  const def=rows.find(function(x){ return (Number(x.provider_id)||0)===0; })||{ slug, provider_id: 0 };
  const overrides=rows.filter(function(x){ return (Number(x.provider_id)||0)!==0; });
  let provOpts=[]; try{ provOpts=await providerOptions(); }catch(e){}
  const nameOf=function(pid){ const o=provOpts.find(function(x){ return String(x.value)===String(pid); }); return o?o.label:('provider #'+pid); };
  const v=function(x){ return x==null||x===''?'':String(x); };
  const originalPids=overrides.map(function(o){ return Number(o.provider_id)||0; });
  document.querySelector('.modal').classList.add('wide');
  document.getElementById('modal-title').textContent='Pricing · '+slug;
  document.getElementById('modal-title').style.color='';
  const body=document.getElementById('modal-body');
  body.innerHTML='<div class="price-editor">'
    +'<h3 class="sec">Equivalent · list price (per 1M tokens)</h3>'
    +'<div class="form-grid"><div><label>Prompt $/1M</label><input id="pe-eq-prompt" type="number" step="0.0001" value="'+v(def.prompt_per_1m)+'" placeholder="0"></div>'
    +'<div><label>Completion $/1M</label><input id="pe-eq-completion" type="number" step="0.0001" value="'+v(def.completion_per_1m)+'" placeholder="0"></div></div>'
    +'<h3 class="sec">Default actual pricing · applies to every provider</h3>'
    +peActualBlock('pe-def', def)
    +'<h3 class="sec">Per-provider actual overrides</h3>'
    +'<p class="small" style="margin:0 0 8px">Overrides replace the default when that provider serves the request. Blank token rates fall back to the equivalent list price.</p>'
    +'<div id="pe-overrides">'+overrides.map(function(o){ return peOverrideBlock(Number(o.provider_id)||0, nameOf(o.provider_id), o); }).join('')+'</div>'
    +'<div class="pe-add"><div><label>Add provider override</label><select id="pe-add-provider"></select></div><button class="ghost" type="button" id="pe-add-btn">Add</button></div>'
    +'</div>';
  function renderAddSelect(){
    const used=new Set(Array.from(body.querySelectorAll('.pe-ov')).map(function(el){ return el.getAttribute('data-pid'); }));
    const opts=provOpts.filter(function(o){ return !used.has(String(o.value)); });
    const sel=document.getElementById('pe-add-provider');
    sel.innerHTML=opts.length?opts.map(function(o){ return '<option value="'+esc(o.value)+'">'+o.label+'</option>'; }).join(''):'<option value="">every provider has an override</option>';
    document.getElementById('pe-add-btn').disabled=!opts.length;
  }
  renderAddSelect();
  document.getElementById('pe-add-btn').onclick=function(){
    const sel=document.getElementById('pe-add-provider'); const pid=sel.value; if(!pid) return;
    document.getElementById('pe-overrides').insertAdjacentHTML('beforeend', peOverrideBlock(Number(pid), nameOf(pid), {}));
    renderAddSelect();
  };
  body.onclick=function(e){
    const rm=e.target.closest('[data-act="pe-rm"]'); if(!rm) return;
    const blk=rm.closest('.pe-ov'); if(blk){ blk.remove(); renderAddSelect(); }
  };
  const save=document.getElementById('modal-save');
  save.textContent='Save all'; save.style.display=''; save.classList.remove('danger'); save.classList.add('act');
  modalSubmit=async function(){
    const eqP=document.getElementById('pe-eq-prompt').value||0;
    const eqC=document.getElementById('pe-eq-completion').value||0;
    const jobs=[];
    jobs.push(postPrice(Object.assign({ slug, provider_id:0, prompt_per_1m:eqP, completion_per_1m:eqC }, peReadActual('pe-def'))));
    const domPids=[];
    Array.from(body.querySelectorAll('.pe-ov')).forEach(function(el){
      const pid=Number(el.getAttribute('data-pid'))||0; if(!pid) return; domPids.push(pid);
      jobs.push(postPrice(Object.assign({ slug, provider_id:pid, prompt_per_1m:eqP, completion_per_1m:eqC }, peReadActual('pe-ov-'+pid))));
    });
    originalPids.filter(function(pid){ return domPids.indexOf(pid)<0; }).forEach(function(pid){
      jobs.push(api('/admin/prices/'+encodeURIComponent(slug)+'?provider_id='+pid,{method:'DELETE'}));
    });
    try{
      const results=await Promise.all(jobs);
      const bad=results.find(function(r){ return r&&r.status&&r.status!==200; });
      if(bad){ toast('save failed: '+((bad.data&&bad.data.error&&bad.data.error.message)||bad.status),'err'); return; }
      toast('pricing saved','ok'); closeModal(); loadPrices();
    }catch(e){ toast('save failed: '+e.message,'err'); }
  };
  document.getElementById('overlay').classList.add('show');
}
async function loadPrices(){
  const el=document.getElementById('pr-list');
  paintSkeleton(el);
  let data; try{ const res=await api('/admin/prices'); data=res.data; }catch(e){ paintLoadError(el,'Could not load prices: '+e.message,loadPrices); return; }
  priceCache=(data&&data.prices)||[];
  const bySlug=new Map();
  priceCache.forEach(function(p){ if(!bySlug.has(p.slug)) bySlug.set(p.slug,[]); bySlug.get(p.slug).push(p); });
  const slugs=Array.from(bySlug.keys()).sort();
  const rows=slugs.map(function(s){
    const list=bySlug.get(s);
    const def=list.find(function(x){ return (Number(x.provider_id)||0)===0; })||list[0]||{};
    const ov=list.filter(function(x){ return (Number(x.provider_id)||0)!==0; }).length;
    const ovPill=ov?' <span class="pill mut" title="per-provider overrides">'+ov+' override'+(ov>1?'s':'')+'</span>':'';
    const actual=def.actual_mode==='per_request'
      ? '<span class="pill acc">'+money(Number(def.actual_per_request||0))+'/req</span>'
      : ((def.actual_prompt_per_1m!=null||def.actual_completion_per_1m!=null)
          ? '<span class="mono small">'+dashRate(def.actual_prompt_per_1m)+' · '+dashRate(def.actual_completion_per_1m)+'</span>'
          : '<span class="small">= equivalent</span>');
    return '<tr data-slug="'+esc(s)+'">'
      +'<td class="mono">'+esc(s)+ovPill+'</td>'
      +'<td class="mono">'+money(Number(def.prompt_per_1m||0))+'/1M</td>'
      +'<td class="mono">'+money(Number(def.completion_per_1m||0))+'/1M</td>'
      +'<td>'+actual+'</td>'
      +'<td>'+(def.currency||'USD')+'</td>'
      +'<td class="rowact"><button class="ghost" data-act="predit" data-slug="'+esc(s)+'">edit</button> <button class="danger" data-act="prdel" data-slug="'+esc(s)+'">delete</button></td></tr>';
  }).join('') || '<tr><td colspan="6"><div class="empty">No prices set. Add a default above, or sync equivalent rates from models.dev.</div></td></tr>';
  el.innerHTML='<table><tr><th>Model</th><th>Eq prompt</th><th>Eq completion</th><th>Actual (default)</th><th>Cur</th><th></th></tr>'+rows+'</table>';
}
document.getElementById('pr-list').addEventListener('click',function(e){
  const b=e.target.closest('[data-act]'); if(!b) return;
  const act=b.getAttribute('data-act');
  if(act==='predit'){ editPrice(b.dataset.slug); return; }
  if(act==='prdel'){
    const list=priceCache.filter(function(x){ return x.slug===b.dataset.slug; });
    const pids=list.map(function(x){ return Number(x.provider_id)||0; });
    const ov=pids.filter(function(p){ return p!==0; }).length;
    confirmAction('Delete pricing','Remove all pricing for '+b.dataset.slug+(ov?' (default + '+ov+' provider override'+(ov>1?'s':'')+')':'')+'?','Delete',async function(){
      try{
        await Promise.all((pids.length?pids:[0]).map(function(pid){ return api('/admin/prices/'+encodeURIComponent(b.dataset.slug)+'?provider_id='+pid,{method:'DELETE'}); }));
        toast('pricing deleted','ok'); loadPrices();
      }catch(err){ toast('delete failed: '+err.message,'err'); }
    });
  }
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


// ---------- PROXIES ----------
function proxyStatusPill(s){
  const map={healthy:'ok',flaky:'warn',dead:'bad',disabled:'',untested:''};
  return '<span class="pill '+(map[s]||'')+'">'+esc(s)+'</span>';
}
async function loadProxies(){
  const statsEl=document.getElementById('px-stats'); const listEl=document.getElementById('px-list');
  paintSkeleton(statsEl,'stats');
  let data; try{ data=(await api('/admin/proxies')).data; }catch(e){ paintLoadError(listEl,'Could not load proxies: '+e.message,loadProxies); return; }
  const counts=data.counts||{};
  const stats=[
    {k:'Total',v:fmt(data.total||0),s:'in pool'},
    {k:'Healthy',v:fmt(counts.healthy||0),c:'ok',s:'usable'},
    {k:'Flaky/Dead',v:fmt((counts.flaky||0)+(counts.dead||0)),c:'warn',s:'failing'},
    {k:'Untested',v:fmt((counts.untested||0)+(counts.disabled||0)),s:'no result yet'}
  ];
  statsEl.innerHTML=stats.map(function(s){return '<div class="stat"><div class="k">'+esc(s.k)+'</div><div class="v '+(s.c||'')+'">'+esc(s.v)+'</div><div class="sub2">'+esc(s.s||'')+'</div></div>';}).join('');
  const autoEl=document.getElementById('px-auto'); if(autoEl) autoEl.checked=(data.mode==='auto');
  const activeEl=document.getElementById('px-active');
  if(activeEl){
    if(data.mode==='auto') activeEl.innerHTML=data.active?('Active egress: <span class="mono">'+esc(data.active)+'</span> (sticky until it fails)'):'Auto-select on \u2014 no healthy proxy yet; test the pool.';
    else activeEl.textContent='Manual: using ZAI_EGRESS_PROXY from the environment.';
  }
  const helperEl=document.getElementById('px-helper');
  if(helperEl){
    const h=data.helper||{};
    helperEl.innerHTML=h.online?('uTLS helper <span class="pill ok">online</span> <span class="mono">'+esc(h.base||'')+'</span>'):'uTLS helper <span class="pill bad">offline</span> \u2014 batch testing unavailable';
  }
  const rows=(data.proxies||[]);
  if(!rows.length){ listEl.innerHTML='<div class="empty" style="margin:20px">No proxies. Paste some above and Import.</div>'; return; }
  listEl.innerHTML='<div style="padding:8px 12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap"><button class="danger sm" id="px-del-selected" disabled>Delete selected</button> <span class="hint" id="px-sel-count"></span>'+
    '<span id="px-progress" class="hint" style="display:none;flex:1;min-width:160px"><span id="px-progress-label"></span><span class="px-bar" style="display:block;height:4px;border-radius:3px;background:var(--line,var(--line-hi));margin-top:4px;overflow:hidden"><span id="px-progress-fill" style="display:block;height:100%;width:0;background:var(--accent,var(--cool));transition:width .2s"></span></span></span></div>'+
    '<table class="tbl"><thead><tr><th style="width:28px"><input type="checkbox" id="px-select-all" title="Select all"></th><th>Type</th><th>Endpoint</th><th>Status</th><th>Latency</th><th>Fails</th><th>Last test</th><th></th></tr></thead><tbody>'+
    rows.map(function(p){
      const lat=p.last_latency_ms!=null?fmt(p.last_latency_ms)+'ms':'\u2014';
      const fails=p.consecutive_failures?(p.consecutive_failures+' streak'):(p.failure_count||0);
      const last=p.last_checked_at?esc(p.last_checked_at.replace('T',' ').slice(0,19)):'\u2014';
      const fc=p.last_failure_class?' <span class="hint">('+esc(p.last_failure_class)+')</span>':'';
      return '<tr data-px-row="'+p.id+'"><td><input type="checkbox" class="px-row-sel" data-px-id="'+p.id+'"></td><td class="mono">'+esc(p.scheme)+'</td><td class="mono">'+esc(p.endpoint)+'</td><td class="px-c-status">'+proxyStatusPill(p.status)+'</td><td class="px-c-lat">'+lat+'</td><td class="px-c-fails">'+fails+fc+'</td><td class="mono px-c-last">'+last+'</td>'+
        '<td style="text-align:right;white-space:nowrap"><button class="ghost sm" data-px-reach="'+p.id+'">Reach test</button> <button class="ghost sm" data-px-test="'+p.id+'">Test</button> <button class="ghost sm" data-px-toggle="'+p.id+'">'+(p.enabled?'Disable':'Enable')+'</button> <button class="danger sm" data-px-del="'+p.id+'">Del</button></td></tr>';
    }).join('')+'</tbody></table>';
  pxWireSelection();
}
function pxSelectedIds(){
  return Array.from(document.querySelectorAll('.px-row-sel:checked')).map(function(el){return Number(el.dataset.pxId);});
}
function pxWireSelection(){
  const all=document.getElementById('px-select-all');
  const delBtn=document.getElementById('px-del-selected');
  const count=document.getElementById('px-sel-count');
  const refresh=function(){
    const n=pxSelectedIds().length;
    if(delBtn) delBtn.disabled=n===0;
    if(count) count.textContent=n?(n+' selected'):'';
  };
  if(all) all.onchange=function(){ document.querySelectorAll('.px-row-sel').forEach(function(el){el.checked=all.checked;}); refresh(); };
  document.querySelectorAll('.px-row-sel').forEach(function(el){ el.onchange=refresh; });
  if(delBtn) delBtn.onclick=function(){
    const ids=pxSelectedIds();
    if(!ids.length) return;
    confirmAction('Delete selected proxies','Delete '+ids.length+' selected prox'+(ids.length===1?'y':'ies')+'? This cannot be undone.','Delete',async function(){
      const {data}=await api('/admin/proxies/delete',{method:'POST',body:JSON.stringify({ids})});
      toast('Deleted '+((data&&data.deleted)||0),'ok'); loadProxies();
    });
  };
  refresh();
}
function pxTestOpts(extra){
  const conc=Math.min(50,Math.max(1,Number(document.getElementById('px-conc').value)||20));
  const timeout=Math.min(20000,Math.max(1000,Number(document.getElementById('px-timeout').value)||10000));
  return Object.assign({concurrency:conc,timeout_ms:timeout},extra||{});
}
function pxPatchRow(ev){
  const tr=document.querySelector('tr[data-px-row="'+ev.id+'"]');
  if(!tr) return;
  if(ev.error){
    const st=tr.querySelector('.px-c-status'); if(st) st.innerHTML='<span class="pill bad">'+esc(ev.error)+'</span>';
    tr.style.background=''; return;
  }
  const st=tr.querySelector('.px-c-status'); if(st) st.innerHTML=proxyStatusPill(ev.status);
  const lat=tr.querySelector('.px-c-lat'); if(lat) lat.textContent=ev.last_latency_ms!=null?fmt(ev.last_latency_ms)+'ms':'\u2014';
  const fails=tr.querySelector('.px-c-fails');
  if(fails){ const fc=ev.last_failure_class?' <span class="hint">('+esc(ev.last_failure_class)+')</span>':''; fails.innerHTML=(ev.consecutive_failures?(ev.consecutive_failures+' streak'):'0')+fc; }
  const last=tr.querySelector('.px-c-last'); if(last&&ev.last_checked_at) last.textContent=ev.last_checked_at.replace('T',' ').slice(0,19);
  // brief flash so the eye catches which row just updated
  tr.style.transition='background .15s'; tr.style.background=ev.success?'rgba(78,161,255,.12)':'rgba(255,90,90,.10)';
  setTimeout(function(){ tr.style.background=''; },600);
}
function pxProgress(done,total,healthy,dead){
  const box=document.getElementById('px-progress');
  const fill=document.getElementById('px-progress-fill');
  const label=document.getElementById('px-progress-label');
  if(!box) return;
  box.style.display=done<total?'':'none';
  if(fill) fill.style.width=total?Math.round(done/total*100)+'%':'0';
  if(label) label.textContent='Testing '+done+'/'+total+' \u2014 '+healthy+' healthy, '+dead+' dead';
}
async function pxTest(body,label){
  // Live path: stream one event per proxy and repaint that row as it lands, no
  // reload. Falls back to a single toast if the stream can't be read.
  toast('Testing '+label+'\u2026');
  let r;
  try{
    r=await fetch(API+'/admin/proxies/test',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(pxTestOpts(Object.assign({stream:true},body)))});
  }catch(e){ toast('test failed: '+e.message,'err'); return; }
  if(r.status===401){ setTimeout(function(){location.href=API+'/_gw';},400); return; }
  if(!r.ok||!r.body){ let d=null; try{d=await r.json();}catch(e){} toast('test failed: '+((d&&d.error&&d.error.message)||r.status),'err'); return; }
  const reader=r.body.getReader(); const dec=new TextDecoder(); let buf=''; let total=0; let last={tested:0,healthy:0,dead:0};
  const sel=pxSelectedIds();
  try{
    for(;;){
      const {value,done}=await reader.read(); if(done) break;
      buf+=dec.decode(value,{stream:true});
      let nl; while((nl=buf.indexOf(NL+NL))>=0){
        const frame=buf.slice(0,nl); buf=buf.slice(nl+2);
        const line=frame.split(NL).find(function(l){return l.indexOf('data:')===0;}); if(!line) continue;
        let ev; try{ ev=JSON.parse(line.slice(5).trim()); }catch(e){ continue; }
        if(ev.type==='start'){ total=ev.total; pxProgress(0,total,0,0); }
        else if(ev.type==='result'){ pxPatchRow(ev); last={tested:ev.tested,healthy:ev.healthy,dead:ev.dead}; pxProgress(ev.tested,total,ev.healthy||0,ev.dead||0); }
        else if(ev.type==='done'){ last={tested:ev.tested,healthy:ev.healthy,dead:ev.dead}; if(ev.error) toast('stream error: '+ev.error,'err'); }
      }
    }
  }catch(e){ toast('stream interrupted: '+e.message,'err'); }
  pxProgress(last.tested,last.tested,last.healthy,last.dead);
  // restore the caller's selection (rows weren't rebuilt, but be safe) and
  // refresh the pool's active-egress/counts banner without nuking the table
  document.querySelectorAll('.px-row-sel').forEach(function(el){ el.checked=sel.indexOf(Number(el.dataset.pxId))>=0; });
  const delBtn=document.getElementById('px-del-selected'); const cnt=document.getElementById('px-sel-count'); const n=pxSelectedIds().length;
  if(delBtn) delBtn.disabled=n===0; if(cnt) cnt.textContent=n?(n+' selected'):'';
  toast('Tested '+last.tested+' \u2014 '+last.healthy+' healthy, '+last.dead+' dead','ok');
}
document.getElementById('px-import-btn').onclick=async function(){
  const text=document.getElementById('px-import').value;
  if(!text.trim()){ toast('Paste proxies first','err'); return; }
  const scheme=document.getElementById('px-default-scheme').value;
  const {status,data}=await api('/admin/proxies/import',{method:'POST',body:JSON.stringify({text,default_scheme:scheme})});
  if(status!==200){ toast('import failed: '+(data&&data.error&&data.error.message||status),'err'); return; }
  toast('Imported '+data.imported+' \u2014 '+data.duplicates+' dup, '+data.invalid+' invalid','ok');
  document.getElementById('px-import').value='';
  loadProxies();
};
document.getElementById('px-auto').onchange=async function(e){
  const mode=e.target.checked?'auto':'manual';
  const {status,data}=await api('/admin/proxies/mode',{method:'POST',body:JSON.stringify({mode})});
  if(status!==200){ toast('mode change failed','err'); e.target.checked=!e.target.checked; return; }
  toast(mode==='auto'?'Auto-select on \u2014 gateway picks the best healthy proxy':'Manual egress','ok');
  loadProxies();
};
async function pxReachTest(body, label){
  const url=(body && body.url) || document.getElementById('px-reach-url').value.trim();
  if(url.slice(0,8).toLowerCase()!=='https://'){ toast('Enter an https:// URL','err'); return; }
  const out=document.getElementById('px-reach-out');
  if(out) out.textContent='Testing '+(label||url)+'\u2026';
  toast('Testing '+(label||'URL')+'\u2026');
  const payload=Object.assign({ url }, body||{});
  try{
    const {status,data}=await api('/admin/egress/test',{method:'POST',body:JSON.stringify(payload)});
    if(status!==200){ const m=(data&&data.error&&data.error.message)||status; if(out) out.innerHTML='<span class="pill bad">error</span> '+esc(String(m)); toast('test failed: '+m,'err'); return; }
    const r=data.result||{};
    const okPill=r.success?'<span class="pill ok">reachable</span>':'<span class="pill bad">'+esc(r.failure_class||'failed')+'</span>';
    const timings='connect '+fmt(r.connect_ms||0)+'ms · tunnel '+fmt(r.tunnel_ms||0)+'ms · tls '+fmt(r.tls_ms||0)+'ms · total '+fmt(r.total_ms||0)+'ms';
    const httpline=r.http_status?(' · HTTP '+r.http_status):'';
    if(out) out.innerHTML=okPill+' via '+esc(data.via||'direct')+httpline+' <span class="hint">('+timings+')</span>';
    toast(r.success?'reachable':'unreachable: '+(r.failure_class||'failed'),r.success?'ok':'err');
  }catch(e){ if(out) out.textContent='test failed: '+e.message; toast('test failed: '+e.message,'err'); }
}
document.getElementById('px-reach-btn').onclick=function(){
  const proxy=document.getElementById('px-reach-proxy').value.trim();
  pxReachTest(proxy?{ proxy }:{}, null);
};
document.getElementById('px-test-all').onclick=function(){ pxTest({},'all'); };
document.getElementById('px-test-failed').onclick=function(){ pxTest({failed_only:true},'failed'); };
document.getElementById('px-remove-dead').onclick=function(){
  confirmAction('Remove dead proxies','Delete every proxy classified dead (3+ consecutive failures)? This cannot be undone.','Remove',async function(){
    const {data}=await api('/admin/proxies/delete',{method:'POST',body:JSON.stringify({dead:true})});
    toast('Removed '+((data&&data.deleted)||0)+' dead','ok'); loadProxies();
  });
};
document.getElementById('px-list').addEventListener('click',function(e){
  const rt=e.target.closest('button[data-px-reach]'); if(rt){ pxReachTest({ proxy_id: Number(rt.dataset.pxReach) }, 'proxy #'+rt.dataset.pxReach); return; }
  const t=e.target.closest('button[data-px-test]'); if(t){ pxTest({ids:[Number(t.dataset.pxTest)]},'proxy'); return; }
  const g=e.target.closest('button[data-px-toggle]'); if(g){ api('/admin/proxies/'+Number(g.dataset.pxToggle)+'/toggle',{method:'POST'}).then(loadProxies); return; }
  const d=e.target.closest('button[data-px-del]'); if(d){ confirmAction('Delete proxy','Remove this proxy from the pool?','Delete',async function(){ await api('/admin/proxies/delete',{method:'POST',body:JSON.stringify({ids:[Number(d.dataset.pxDel)]})}); loadProxies(); }); return; }
});

// ---------- Z.AI DEVICE TOKENS ----------
async function loadZaiTokens(){
  const statsEl=document.getElementById('zt-stats'); if(!statsEl) return;
  paintSkeleton(statsEl,'stats');
  let data; try{ data=(await api('/admin/zai/device-tokens/status')).data; }catch(e){ statsEl.innerHTML='<div class="empty">Could not load token status: '+esc(e.message)+'</div>'; return; }
  const available=Number(data&&data.available||0);
  const band=available===0?{t:'Empty',c:'warn'}:(data&&data.low?{t:'Low',c:'warn'}:{t:'Healthy',c:'ok'});
  const stats=[
    {k:'Available',v:fmt(available),c:band.c,s:'in FIFO'},
    {k:'CAPTCHA proofs',v:fmt(Number(data&&data.captcha_ready||0)),s:'cached'},
    {k:'Status',v:band.t,c:band.c,s:data&&data.low?'refill soon':'ok'}
  ];
  statsEl.innerHTML=stats.map(function(s){return '<div class="stat"><div class="k">'+esc(s.k)+'</div><div class="v '+(s.c||'')+'">'+esc(s.v)+'</div><div class="sub2">'+esc(s.s||'')+'</div></div>';}).join('');
}
async function submitZaiTokens(text){
  const msg=document.getElementById('zt-msg');
  const body=String(text||'').trim();
  if(!body){ if(msg) msg.textContent='Paste or load some tokens first.'; return; }
  if(msg) msg.textContent='Importing...';
  try{
    const res=await api('/admin/zai/device-tokens/import',{method:'POST',body:JSON.stringify({tokens:body})});
    const d=res.data||{};
    if(msg) msg.textContent='Accepted '+fmt(d.accepted||0)+', '+fmt(d.duplicates||0)+' duplicate, '+fmt(d.invalid||0)+' invalid \u2014 '+fmt(d.available||0)+' available.';
    const ta=document.getElementById('zt-import'); if(ta) ta.value='';
    await loadZaiTokens();
  }catch(e){ if(msg) msg.textContent='Import failed: '+e.message; }
}
document.addEventListener('click',function(e){
  if(e.target&&e.target.id==='zt-import-btn'){ const ta=document.getElementById('zt-import'); submitZaiTokens(ta?ta.value:''); }
});
document.addEventListener('change',function(e){
  if(e.target&&e.target.id==='zt-file'){
    const f=e.target.files&&e.target.files[0]; if(!f) return;
    const reader=new FileReader();
    reader.onload=function(){ const ta=document.getElementById('zt-import'); if(ta) ta.value=String(reader.result||''); };
    reader.readAsText(f);
    e.target.value='';
  }
});

// ---------- TRAJECTORIES ----------
let tjOffset=0; const tjLimit=25;
let tjFilters={account_id:'',key_id:'',slug:'',status:''};
let tjFilterOptionsLoaded=false;
function tjQuery(){
  const p=['limit='+tjLimit,'offset='+tjOffset];
  if(tjFilters.account_id) p.push('account_id='+encodeURIComponent(tjFilters.account_id));
  if(tjFilters.key_id) p.push('key_id='+encodeURIComponent(tjFilters.key_id));
  if(tjFilters.slug) p.push('slug='+encodeURIComponent(tjFilters.slug));
  if(tjFilters.status) p.push('status='+encodeURIComponent(tjFilters.status));
  return p.join('&');
}
async function loadTjFilterOptions(){
  try{
    const acc=(await api('/admin/accounts')).data||{};
    const keys=(await api('/admin/keys')).data||{};
    // Which keys belong to which account (new style), plus the legacy 1:1
    // shape where the account's own id is the key id. A key with no account
    // stays listed under "all keys" only.
    const ownerOf={}; ((keys.keys)||[]).forEach(function(k){ if(k.account_id) ownerOf[k.key_id]=k.account_id; });
    const acctSel=document.getElementById('tj-f-account');
    if(acctSel){
      const cur=acctSel.value;
      acctSel.innerHTML='<option value="">All accounts</option>'+((acc.accounts)||[]).map(function(a){
        return '<option value="'+esc(a.key_id)+'">'+esc(a.username)+' ('+esc(a.key_id)+')</option>';
      }).join('');
      acctSel.value=cur||'';
    }
    const keySel=document.getElementById('tj-f-key');
    if(keySel){
      const cur=keySel.value;
      const list=(keys.keys)||[];
      keySel.innerHTML='<option value="">All keys</option>'+list.map(function(k){
        const own=ownerOf[k.key_id]?' · '+esc(ownerOf[k.key_id]):' · no account';
        return '<option value="'+esc(k.key_id)+'">'+esc(k.name)+' — '+esc(k.key_id.slice(0,12))+'…'+own+'</option>';
      }).join('');
      keySel.value=cur||'';
    }
    const modelSel=document.getElementById('tj-f-model');
    if(modelSel){
      const cur=modelSel.value;
      let opts=[]; try{ opts=await publicModelOptions('all'); }catch(e){ opts=[]; }
      modelSel.innerHTML='<option value="">All models</option>'+opts.map(function(o){
        return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>';
      }).join('');
      modelSel.value=cur||'';
    }
    tjFilterOptionsLoaded=true;
  }catch(e){ /* the filters stay empty rather than blocking the list */ }
}
async function loadTrajectories(){
  const statsEl=document.getElementById('tj-stats'); const listEl=document.getElementById('tj-list'); const chartEl=document.getElementById('tj-chart');
  paintSkeleton(statsEl);
  if(!tjFilterOptionsLoaded) await loadTjFilterOptions();
  let settings=null; try{ settings=(await api('/admin/trajectory-settings')).data; }catch(e){}
  const capBox=document.getElementById('tj-capture'); if(capBox) capBox.checked=!settings||settings.capture!=='off';
  let data; try{ data=(await api('/admin/trajectories?'+tjQuery())).data; }catch(e){ listEl.innerHTML='<div class="empty">Could not load trajectories: '+esc(e.message)+'</div>'; return; }
  const list=(data&&data.trajectories)||[]; const s=(data&&data.stats)||{}; const pg=(data&&data.page)||{limit:tjLimit,offset:tjOffset,matched:list.length,hasMore:false};
  const okRate=s.total?Math.round(100*(s.ok_count||0)/s.total)+'%':'-';
  statsEl.innerHTML=[
    {k:'Requests',v:fmt(s.total||0),c:''},
    {k:'Success',v:okRate,c:'ok'},
    {k:'Tokens',v:fmt(s.tokens||0),c:'acc'},
    {k:'Cost',v:money(s.cost||0),c:''}
  ].map(function(x){return '<div class="stat"><div class="k">'+x.k+'</div><div class="v '+x.c+'">'+esc(x.v)+'</div></div>';}).join('');
  const lat=(data&&data.latency)||[];
  if(!lat.length){ chartEl.innerHTML='<div class="empty">No recorded requests yet.</div>'; }
  else{
    const max=Math.max.apply(null,lat.map(function(x){return x.avg_ms;}));
    chartEl.innerHTML='<div class="tj-chart">'+lat.map(function(x){
      const pct=max>0?Math.max(6,Math.round(100*x.avg_ms/max)):6;
      return '<div class="tj-bar"><div class="tj-bar-label mono">'+esc(x.slug)+'</div><div class="tj-bar-track"><div class="tj-bar-fill" style="width:'+pct+'%"></div></div><div class="tj-bar-val mono">'+x.avg_ms+'ms <span class="small">· '+fmt(x.n)+'</span></div></div>';
    }).join('')+'</div>';
  }
  const rows=list.map(function(t){
    const pill=t.status==='ok'?'<span class="pill ok">ok</span>':'<span class="pill bad">fail</span>';
    const cache=t.cache_state?'<span class="pill mut">'+esc(t.cache_state)+'</span>':'';
    return '<tr><td class="mono small">'+esc((t.created_at||'').slice(5,19).replace('T',' '))+'</td><td>'+esc(t.slug)+'</td><td class="small">'+esc(t.key_name||'-')+'<br><span class="mono small" title="'+esc(t.key_id||'')+'">'+esc(String(t.key_id||'').slice(0,10))+(t.key_id?'…':'')+'</span></td><td>'+esc(t.provider||'-')+'</td><td>'+pill+' '+cache+'</td><td class="mono" title="input tokens">'+fmt(t.prompt_tokens||0)+'&nbsp;in</td><td class="mono" title="output tokens">'+fmt(t.completion_tokens||0)+'&nbsp;out</td><td class="mono" title="latency">'+fmt(t.latency_ms||0)+'ms</td><td class="mono" title="cost">'+money(t.cost_usd||0)+'</td><td><button class="ghost" data-act="tjview" data-id="'+esc(t.id)+'">view</button></td></tr>';
  }).join('') || '<tr><td colspan="10"><div class="empty">No trajectories captured yet.</div></td></tr>';
  const from=pg.matched?pg.offset+1:0; const to=pg.offset+list.length;
  const pager='<div class="tj-pager">'+
    '<button class="ghost" data-act="tjprev" '+(pg.offset<=0?'disabled':'')+'>&larr; Newer</button>'+
    '<span class="small">Showing '+fmt(from)+'–'+fmt(to)+' of '+fmt(pg.matched)+'</span>'+
    '<button class="ghost" data-act="tjnext" '+(pg.hasMore?'':'disabled')+'>Older &rarr;</button>'+
  '</div>';
  listEl.innerHTML='<table><tr><th>Time</th><th>Model</th><th>Key</th><th>Provider</th><th>Status</th><th>In tok</th><th>Out tok</th><th>Latency</th><th>Cost</th><th></th></tr>'+rows+'</table>'+pager;
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
  function statusPill(c){
    if(c.eligible){
      const band=c.relBand||'unproven';
      const cls=band==='healthy'?'ok':(band==='degraded'?'bad':'warn');
      return '<span class="pill '+cls+'">'+esc(band)+'</span>';
    }
    return '<span class="pill bad">'+esc(c.reason||'below floor')+'</span>';
  }
  const rows=(d.candidates||[]).map(function(c){
    const picked=c.slug===d.picked?' <span class="pill acc">PICKED</span>':'';
    const lcbTxt=Number.isFinite(c.lcb)?' · lcb '+c.lcb.toFixed(2):'';
    const h=c.samples>0?' · '+Math.round(c.okRate*100)+'% ok ('+c.samples+')'+lcbTxt:' · no data';
    return '<tr><td class="mono">'+esc(c.slug)+picked+'</td><td>'+statusPill(c)+'</td><td class="mono">'+c.quality.toFixed(2)+'</td><td class="mono">'+money(c.cost)+'/1M</td><td class="mono small">'+esc(String(Math.round(c.avgMs))+'ms'+h)+'</td></tr>';
  }).join('');
  const v2=d.v2&&d.v2.explain?d.v2.explain:null;
  const ir=(d.v2&&d.v2.taskIR)||null;
  const secs=function(ms){ return ms==null?'—':(ms>=1000?(ms/1000).toFixed(1)+'s':Math.round(ms)+'ms'); };
  const v2Html=v2?('<div class="kvrow" style="margin-top:10px"><span class="pill '+(d.v2.mode==='live'?'acc':'mut')+'">V2 '+esc(d.v2.mode||'shadow')+'</span>'+
      '<span class="grow small">'+(ir?('task <b>'+esc(String(ir.task))+'</b> · classifier margin '+(ir.confidence||0).toFixed(2)+' · '):'')+
      'policy <b>'+esc(String(v2.mode))+'</b> → <b>'+esc(String(v2.primary||'—'))+'</b>'+
      (v2.challenger?(' vs '+esc(String(v2.challenger))):'')+
      ' · operational reliability '+Math.round((v2.expectedSuccess||0)*100)+'%'+
      ' · '+secs(v2.expectedLatencyMs)+(v2.latencyKnown===false?' <span class="hint">(default)</span>':'')+
      ' · '+money(v2.expectedCost||0)+'/req'+(v2.costKnown===false?' <span class="hint">(default)</span>':'')+
      (v2.quality&&v2.quality.stats&&v2.quality.stats.sufficient
        ?' · predicted quality '+Math.round(v2.quality.stats.mean*100)+'% <span class="hint">('+Number(v2.quality.stats.evidence).toFixed(1)+' weighted evidence)</span>'
        :' · quality <span class="hint">insufficient evidence (prior only)</span>')+'</span></div>'):
    '<div class="small" style="margin-top:10px">V2 shadow: no policy (router off or no eligible routes)</div>';
  const sh=d.v2&&d.v2.shadow?d.v2.shadow:null;
  const shHtml=sh?('<div class="kvrow" style="margin-top:6px"><span class="pill '+(sh.changed?'warn':'mut')+'">constraint-first '+(sh.changed?'DIFFERS':'agrees')+'</span>'+
    '<span class="grow small">quality-constrained pick <b>'+esc(String((sh.quality_aware_pick&&sh.quality_aware_pick.slug)||'— nothing cleared the floors'))+'</b>'+
    ' vs operational <b>'+esc(String((sh.operational_only_pick&&sh.operational_only_pick.slug)||'—'))+'</b>'+
    (sh.floors?' · floors rel '+Number(sh.floors.reliability).toFixed(2)+' / quality '+Number(sh.floors.quality).toFixed(2):'')+
    ' · considered '+fmt(sh.considered||0)+' → eligible '+fmt(sh.eligible||0)+
    ((sh.rejected_by_constraint&&sh.rejected_by_constraint.length)?' · below floor: '+sh.rejected_by_constraint.map(function(r){return esc(String(r.slug))+' ('+esc(String(r.reason||'floor'))+')';}).join(', '):'')+
    (sh.changed?' <span class="hint">shadow only — serving unchanged</span>':'')+
    '</span></div>'):'';
  out.innerHTML='<div class="kvrow"><span class="pill '+(d.fallback?'warn':'acc')+'">'+(d.fallback?'fallback (nothing eligible)':'V1 picked')+'</span><span class="grow"><b>'+esc(d.picked)+'</b> · complexity '+esc(String(d.complexity))+' → quality floor '+d.need.toFixed(2)+' · preference '+d.preference+'</span></div>'+
    v2Html+shHtml+
    '<table style="margin-top:10px"><tr><th>Model</th><th>Status</th><th>Quality</th><th>Cost</th><th>Health</th></tr>'+rows+'</table>';
};
document.getElementById('tj-refresh').onclick=function(){ loadTrajectories(); };
// Any filter change restarts from the first page: page 3 of the old filter is
// meaningless under a new one.
function applyTjFilter(patch){
  tjFilters=Object.assign({},tjFilters,patch);
  tjOffset=0;
  loadTrajectories();
}
['account','key','model','status'].forEach(function(name){
  const el=document.getElementById('tj-f-'+name);
  if(!el) return;
  el.addEventListener('change',function(){
    const value=el.value;
    if(name==='account') applyTjFilter({account_id:value});
    else if(name==='key') applyTjFilter({key_id:value});
    else if(name==='model') applyTjFilter({slug:value});
    else applyTjFilter({status:value});
  });
});
const tjClear=document.getElementById('tj-f-clear');
if(tjClear) tjClear.onclick=function(){
  ['account','key','model','status'].forEach(function(name){ const el=document.getElementById('tj-f-'+name); if(el) el.value=''; });
  applyTjFilter({account_id:'',key_id:'',slug:'',status:''});
};
document.getElementById('tj-purge').onclick=function(){ confirmAction('Purge trajectories','Delete every captured trajectory? This cannot be undone.','Purge',async function(){ await api('/admin/trajectories/purge',{method:'POST'}); loadTrajectories(); }); };
document.getElementById('tj-capture').addEventListener('change',async function(e){
  await api('/admin/trajectory-settings',{method:'POST',body:JSON.stringify({capture:e.target.checked?'on':'off'})});
  toast(e.target.checked?'capture on':'capture off','ok');
});
// Exports honour the active filter, so the file matches the table. Status is
// left out on purpose: an export needs a complete request/response pair, which
// only a successful run has.
function tjExportQuery(){
  const p=['format='];
  if(tjFilters.account_id) p.push('account_id='+encodeURIComponent(tjFilters.account_id));
  if(tjFilters.key_id) p.push('key_id='+encodeURIComponent(tjFilters.key_id));
  if(tjFilters.slug) p.push('slug='+encodeURIComponent(tjFilters.slug));
  return p;
}
function tjScopeLabel(){
  const bits=[];
  if(tjFilters.account_id) bits.push('account '+tjFilters.account_id);
  if(tjFilters.key_id) bits.push('key '+tjFilters.key_id.slice(0,12)+'…');
  if(tjFilters.slug) bits.push('model '+tjFilters.slug);
  return bits.length?bits.join(', '):'all trajectories';
}
function downloadTraj(fmt){
  const parts=tjExportQuery();
  parts[0]='format='+encodeURIComponent(fmt);
  const a=document.createElement('a');
  a.href=API+'/admin/trajectories-export?'+parts.join('&');
  a.download='trajectories-'+fmt+'.jsonl';
  document.body.appendChild(a); a.click(); a.remove();
  toast('exporting '+tjScopeLabel(),'ok');
}
document.getElementById('tj-export-openai').onclick=function(){ downloadTraj('openai'); };
document.getElementById('tj-export-sharegpt').onclick=function(){ downloadTraj('sharegpt'); };
document.getElementById('tj-export-trl').onclick=function(){ downloadTraj('trl'); };
document.getElementById('tj-export-rl').onclick=function(){ downloadTraj('rl'); };
document.getElementById('tj-export-vey').onclick=function(){ downloadTraj('vey'); };

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

// ---------- CREDITS ----------
// Admin-only credit book (/admin/credits): grand totals plus one row per
// account and key. USD and tokens are separate buckets; each bucket's
// "remaining" adds only capped rows, while usage counts everything.
function creditQuotaLabel(q){
  if(q.kind==='tokens'){
    const total=q.total==null?'uncapped':fmt(q.total);
    const left=q.available==null?fmt(q.used)+' used':fmt(q.available)+' left of '+total;
    return left;
  }
  const total=q.total==null?'uncapped':money(q.total);
  return q.available==null?money(q.used)+' used':money(q.available)+' left of '+total;
}
async function loadCredits(){
  const totalEl=document.getElementById('credits-total');
  const listEl=document.getElementById('credits-list');
  paintSkeleton(totalEl,'stats');
  paintSkeleton(listEl);
  let data; try{ const res=await api('/admin/credits'); data=res.data; }catch(e){ paintLoadError(totalEl,'Could not load credits: '+e.message,loadCredits); paintLoadError(listEl,'Could not load credits: '+e.message,loadCredits); return; }
  const usd=data&&data.total&&data.total.usd||{used:0,available:0};
  const tok=data&&data.total&&data.total.tokens||{used:0,available:0};
  totalEl.innerHTML=
    '<div class="stat"><div class="k">USD remaining (grand total)</div><div class="v acc">'+(usd.capped_rows?money(usd.available):'No cap')+'</div><div class="sub2">'+money(usd.used)+' spent across all rows'+(usd.capped_rows?'':', none has a USD cap')+'</div></div>'
    +'<div class="stat"><div class="k">Tokens remaining (grand total)</div><div class="v acc">'+(tok.capped_rows?fmt(tok.available):'No cap')+'</div><div class="sub2">'+fmt(tok.used)+' spent across all rows'+(tok.capped_rows?'':', none has a token cap')+'</div></div>'
    +'<div class="stat"><div class="k">Accounts</div><div class="v">'+((data&&data.rows||[]).filter(function(r){return r.kind==='account';}).length)+'</div><div class="sub2">customer accounts</div></div>'
    +'<div class="stat"><div class="k">Keys</div><div class="v">'+((data&&data.rows||[]).filter(function(r){return r.kind==='key';}).length)+'</div><div class="sub2">including shared-pool and operator keys</div></div>';
  const rows=(data&&data.rows||[]).map(function(r){
    const who=r.kind==='account'?'account':'key';
    const pill=r.kind==='account'?'<span class="pill acc">account</span>':'<span class="pill mut">key</span>';
    const owner=r.kind==='key'&&r.owned_by_account?'<span class="pill mut">'+esc(r.owned_by_account)+'</span>':'';
    const active=r.kind==='key'?(r.active?'<span class="pill ok">active</span>':'<span class="pill bad">off</span>'):'';
    const pct=r.quota&&r.quota.total&&r.quota.total>0?Math.max(0,Math.min(100,Math.round(r.quota.available/r.quota.total*100))):null;
    const meter=pct==null?'':'<span class="usagebar" title="'+pct+'% remaining"><i style="width:'+pct+'%"></i></span>';
    return '<tr><td>'+pill+'</td><td class="mono">'+esc(r.id)+'</td><td>'+esc(r.name||'')+'</td><td><div style="display:flex;gap:6px;flex-wrap:wrap">'+owner+active+'</div></td><td class="mono">'+esc(creditQuotaLabel(r.quota))+'</td><td>'+meter+'</td></tr>';
  }).join('') || '<tr><td colspan="6"><div class="empty">No accounts or keys yet. Create one in Accounts or API keys.</div></td></tr>';
  listEl.innerHTML='<table><tr><th>Kind</th><th>Id</th><th>Name</th><th>Scope</th><th>Remaining</th><th>Left</th></tr>'+rows+'</table>';
}

// init
loadOverview();
<\/script>
</body>
</html>`;
export { PLAYGROUND_HTML };
