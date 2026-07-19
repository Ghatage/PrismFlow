// Splash screen: the brand prism scaled up with a bloom glow, "Prism" beneath.
// Lives in a body-level fixed overlay (#splashLayer) so the prism can glide up
// and dock over the projects hub rendered underneath. Idempotent — re-renders
// while the splash is showing leave the DOM untouched so the prism animation
// and dock timing are never restarted.

const splashLayer = () => document.querySelector('#splashLayer');

export const renderSplash = () => {
  if (splashLayer()) return;
  const layer = document.createElement('div');
  layer.id = 'splashLayer';
  layer.innerHTML = `
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
  document.body.append(layer);
};

// FLIP the splash stage onto the hub's prism anchor: measure both rects, then
// transition transform. The layer goes transparent and click-through at dock
// start so the hub beneath is usable while the prism is still travelling.
export const dockSplash = (anchorElement, onDocked = () => {}) => {
  const layer = splashLayer();
  const stage = layer?.querySelector('.splash-stage');
  if (!layer || !stage || !anchorElement) { onDocked(); return; }
  const from = stage.getBoundingClientRect();
  const to = anchorElement.getBoundingClientRect();
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const scale = to.height / from.height;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    layer.classList.add('is-docked');
    onDocked();
  };
  stage.addEventListener('transitionend', finish, {once: true});
  setTimeout(finish, 1000);
  layer.classList.add('is-docking');
  stage.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
};

export const removeSplashLayer = () => {
  splashLayer()?.remove();
};
