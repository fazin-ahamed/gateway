<!--
  The identity motif: a faint, real starfield behind the whole console.
  Two parallax layers of tiled point-stars plus one distant nebula glow.
  Purpose, not decoration: it is what makes Astrosphere read as deep space
  rather than a generic dark theme. Kept low-contrast so data stays legible,
  and it holds still for anyone who asked the OS to reduce motion.
-->
<div class="sky" aria-hidden="true">
  <div class="nebula"></div>
  <div class="stars near"></div>
  <div class="stars far"></div>
</div>

<style>
  .sky {
    position: fixed;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    overflow: hidden;
    background: radial-gradient(140% 120% at 50% -20%, #0c1024 0%, var(--canvas) 60%);
  }

  .nebula {
    position: absolute;
    top: -30%;
    right: -20%;
    width: 70vw;
    height: 70vw;
    border-radius: 50%;
    background: radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent) 0%, transparent 62%);
    filter: blur(40px);
    opacity: 0.5;
  }

  .stars {
    position: absolute;
    inset: -200px;
    background-repeat: repeat;
  }

  .near {
    background-image:
      radial-gradient(1.4px 1.4px at 40px 60px, rgba(238, 241, 251, 0.9), transparent),
      radial-gradient(1.2px 1.2px at 170px 120px, rgba(200, 214, 255, 0.7), transparent),
      radial-gradient(1.6px 1.6px at 250px 40px, rgba(238, 241, 251, 0.8), transparent),
      radial-gradient(1.2px 1.2px at 90px 220px, rgba(180, 200, 255, 0.6), transparent);
    background-size: 300px 300px;
    animation: drift-a 220s linear infinite;
  }

  .far {
    background-image:
      radial-gradient(1px 1px at 60px 30px, rgba(238, 241, 251, 0.5), transparent),
      radial-gradient(1px 1px at 200px 160px, rgba(200, 214, 255, 0.4), transparent),
      radial-gradient(1px 1px at 320px 90px, rgba(238, 241, 251, 0.45), transparent);
    background-size: 400px 400px;
    opacity: 0.7;
    animation: drift-b 340s linear infinite;
  }

  @keyframes drift-a { to { transform: translate3d(-300px, -150px, 0); } }
  @keyframes drift-b { to { transform: translate3d(200px, -300px, 0); } }

  :root[data-theme="light"] .sky {
    background: radial-gradient(140% 120% at 50% -20%, #f4f7ff 0%, var(--canvas) 60%);
  }

  :root[data-theme="light"] .stars {
    display: none;
  }

  :root[data-theme="light"] .nebula {
    opacity: 0.25;
  }

  @media (prefers-reduced-motion: reduce) {
    .stars {
      animation: none;
    }
  }
</style>
