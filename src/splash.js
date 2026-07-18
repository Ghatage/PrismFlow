// Splash screen: the brand prism scaled up with a bloom glow, "Prism" beneath.
// Idempotent — re-renders while the splash is showing leave the DOM untouched
// so the prism animation and fade timing are never restarted.

export const renderSplash = (app) => {
  if (app.querySelector('.splash')) return;
  app.innerHTML = `
    <div class="splash">
      <div class="splash-stage">
        <div class="splash-glow" aria-hidden="true"></div>
        <div class="splash-prism">
          <div class="brand-mark"><span></span><span></span><span></span></div>
        </div>
      </div>
      <h1 class="splash-title">Prism</h1>
      <p class="splash-sub">refracting stories into light</p>
    </div>
  `;
};

export const dismissSplash = (app, onDone) => {
  const splash = app.querySelector('.splash');
  if (!splash) { onDone(); return; }
  let done = false;
  const finish = () => { if (done) return; done = true; onDone(); };
  splash.addEventListener('transitionend', finish, {once: true});
  setTimeout(finish, 700);
  splash.classList.add('is-leaving');
};
