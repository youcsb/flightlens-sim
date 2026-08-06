/**
 * overlay.js — the chrome around the flight: loading, places, keys, status.
 *
 * Everything here is DOM. It knows nothing about the world, the aeroplane or
 * the terrain; `main.js` hands it strings and callbacks. Keeping it out of
 * `instruments.js` matters because that file is the *display boundary* — the
 * one place allowed to speak imperial — and a place-picker is not an
 * instrument.
 *
 * TWO RULES THIS FILE EXISTS TO OBEY
 *
 * 1. **It must not steal the keyboard.** The HUD container is
 *    `pointer-events: none`; only the panels turn it back on. Every button
 *    calls `blur()` the instant it is clicked, because a focused <button>
 *    swallows Space and the arrow keys — which are the elevator.
 *
 * 2. **It owns its own subtree and touches nothing else.** `instruments.js`
 *    mounts into the same container and neither may clear the other.
 */

const CSS = `
.ovl, .ovl * { box-sizing: border-box; }
.ovl {
  position: absolute; inset: 0; pointer-events: none;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #cfd8e3; -webkit-font-smoothing: antialiased;
}
.ovl-panel {
  position: absolute; pointer-events: auto;
  background: rgba(10,14,20,0.72);
  border: 1px solid rgba(150,175,205,0.22);
  border-radius: 9px;
  backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
  box-shadow: 0 6px 22px rgba(0,0,0,0.45);
  padding: 9px 10px;
}
.ovl-places { top: 12px; left: 12px; width: 216px; }
.ovl-h {
  font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase;
  color: #7f93ad; margin-bottom: 7px;
}
.ovl-btn {
  display: block; width: 100%; text-align: left; cursor: pointer;
  background: rgba(255,255,255,0.045);
  border: 1px solid rgba(150,175,205,0.16);
  border-radius: 6px; color: #d7e2ee;
  font: inherit; padding: 5px 8px; margin-bottom: 5px;
  transition: background 120ms ease, border-color 120ms ease;
}
.ovl-btn:last-child { margin-bottom: 0; }
.ovl-btn:hover { background: rgba(120,180,255,0.16); border-color: rgba(140,190,255,0.5); }
.ovl-btn.on { background: rgba(90,170,255,0.22); border-color: rgba(130,195,255,0.75); color: #ffffff; }
.ovl-btn .k {
  display: inline-block; width: 15px; color: #7f93ad; font-size: 10.5px;
}
.ovl-btn.on .k { color: #bcd9ff; }
.ovl-btn .sub { display: block; margin-left: 15px; font-size: 10px; color: #8497ad; }
.ovl-btn.on .sub { color: #a9c8ea; }

.ovl-status {
  top: 12px; right: 12px; min-width: 176px; text-align: right;
  pointer-events: none; padding: 8px 10px;
}
.ovl-status div { white-space: nowrap; }
.ovl-status .v { color: #ffffff; }
.ovl-status .warn { color: #ffcf6b; }

/* The instrument panel owns the bottom ~210 px of the window and runs the full
   width, so the key legend sits ABOVE it rather than beside it. */
.ovl-keys {
  bottom: 226px; left: 12px; width: 248px;
  max-height: calc(100vh - 420px); overflow: hidden;
}
.ovl-keys table { border-collapse: collapse; width: 100%; }
.ovl-keys td { padding: 1.5px 0; vertical-align: top; white-space: nowrap; }
.ovl-keys td.k { color: #8fb4de; width: 84px; padding-right: 8px; }
.ovl-hint {
  position: absolute; bottom: 226px; left: 12px; pointer-events: auto;
  cursor: pointer; color: #7f93ad; background: rgba(10,14,20,0.6);
  border: 1px solid rgba(150,175,205,0.18); border-radius: 7px; padding: 4px 8px;
}
.ovl-toast {
  position: absolute; left: 50%; top: 74px; transform: translateX(-50%);
  pointer-events: none; padding: 6px 14px; border-radius: 20px;
  background: rgba(10,14,20,0.8); border: 1px solid rgba(150,175,205,0.28);
  color: #ffffff; opacity: 0; transition: opacity 220ms ease;
  white-space: nowrap;
}
.ovl-toast.show { opacity: 1; }
/* A band, not a curtain. The chase camera frames the aeroplane dead centre, so
   anything drawn there hides the one thing the user is looking at. */
.ovl-paused {
  position: absolute; left: 0; right: 0; top: 0; display: none;
  justify-content: center; pointer-events: none;
  background: linear-gradient(rgba(4,7,11,0.72), rgba(4,7,11,0));
  padding: 10px 0 26px;
}
.ovl-paused.show { display: flex; }
.ovl-paused span {
  font-size: 15px; letter-spacing: 0.34em; color: #ffffff;
  text-shadow: 0 2px 12px rgba(0,0,0,0.9); padding-left: 0.34em;
}
/* The crash card. A band like PAUSED, for the same reason — the chase camera
   frames the aeroplane dead centre and the wreck is the thing worth looking at.
   It sits below the toast so a "reset · KBFI" toast is still readable. */
.ovl-crash {
  position: absolute; left: 50%; top: 108px; transform: translateX(-50%);
  display: none; pointer-events: none; text-align: center;
  padding: 12px 22px; border-radius: 10px;
  background: rgba(38,8,10,0.86); border: 1px solid rgba(255,120,120,0.55);
  box-shadow: 0 8px 30px rgba(0,0,0,0.6);
  max-width: min(560px, 84vw);
}
.ovl-crash.show { display: block; }
.ovl-crash .h {
  font-size: 16px; letter-spacing: 0.3em; color: #ff8f8f; padding-left: 0.3em;
  font-weight: 700;
}
.ovl-crash .d { margin-top: 6px; font-size: 12px; color: #ffd9d9; }
.ovl-crash .n { margin-top: 8px; font-size: 11px; color: #ff9f9f; letter-spacing: 0.08em; }
.ovl-load {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px;
  background: #0b0d10; pointer-events: auto; transition: opacity 420ms ease;
}
.ovl-load.gone { opacity: 0; pointer-events: none; }
.ovl-load .t { font-size: 15px; letter-spacing: 0.2em; color: #e8eef6; }
.ovl-load .s { font-size: 11.5px; color: #7f93ad; }
.ovl-load .bar {
  width: 240px; height: 2px; background: rgba(150,175,205,0.18); overflow: hidden;
}
.ovl-load .bar i {
  display: block; height: 100%; width: 38%; background: #6fb0ff;
  animation: ovl-sweep 1.35s ease-in-out infinite;
}
@keyframes ovl-sweep {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(340%); }
}
/* Too little room to show the legend without covering the windscreen. */
@media (max-width: 900px), (max-height: 700px) {
  .ovl-keys, .ovl-hint { display: none !important; }
}
`;

/**
 * @param {HTMLElement} container the HUD element
 * @param {Object} o
 * @param {Array<{label:string, sub?:string}>} o.locations
 * @param {(i:number)=>void} o.onGoto
 * @returns {Object} handle
 */
export function createOverlay(container, o = {}) {
  const host = container || document.body;
  const locations = o.locations || [];

  const root = document.createElement('div');
  root.className = 'ovl';

  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  // --- places -------------------------------------------------------------
  const places = document.createElement('div');
  places.className = 'ovl-panel ovl-places';
  places.innerHTML = '<div class="ovl-h">Fly from</div>';
  const buttons = locations.map((loc, i) => {
    const b = document.createElement('button');
    b.className = 'ovl-btn';
    b.type = 'button';
    b.innerHTML =
      `<span class="k">${i + 1}</span>${esc(loc.label)}` +
      (loc.sub ? `<span class="sub">${esc(loc.sub)}</span>` : '');
    b.addEventListener('click', () => {
      // Blur FIRST. A focused button eats Space and the arrow keys, and the
      // arrow keys are the elevator.
      b.blur();
      if (typeof o.onGoto === 'function') o.onGoto(i);
    });
    places.appendChild(b);
    return b;
  });
  root.appendChild(places);

  // --- status -------------------------------------------------------------
  const status = document.createElement('div');
  status.className = 'ovl-panel ovl-status';
  const stCam = row(status, 'VIEW');
  const stTime = row(status, 'TIME');
  const stAudio = row(status, 'SOUND');
  root.appendChild(status);

  // --- key legend ---------------------------------------------------------
  const keys = document.createElement('div');
  keys.className = 'ovl-panel ovl-keys';
  keys.innerHTML =
    '<div class="ovl-h">Controls &nbsp;·&nbsp; H hides</div><table>' +
    KEYMAP.map((r) => `<tr><td class="k">${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('') +
    '</table>';
  root.appendChild(keys);

  const hint = document.createElement('div');
  hint.className = 'ovl-hint';
  hint.textContent = 'H — controls';
  hint.style.display = 'none';
  hint.addEventListener('click', () => {
    hint.blur();
    toggleKeys();
  });
  root.appendChild(hint);

  // --- toast / paused / loading ------------------------------------------
  const toastEl = document.createElement('div');
  toastEl.className = 'ovl-toast';
  root.appendChild(toastEl);

  const pausedEl = document.createElement('div');
  pausedEl.className = 'ovl-paused';
  pausedEl.innerHTML = '<span>PAUSED</span>';
  root.appendChild(pausedEl);

  const crashEl = document.createElement('div');
  crashEl.className = 'ovl-crash';
  crashEl.innerHTML =
    '<div class="h">CRASHED</div><div class="d"></div>' +
    '<div class="n">R — reset and try again</div>';
  const crashDetail = crashEl.querySelector('.d');
  root.appendChild(crashEl);

  const loadEl = document.createElement('div');
  loadEl.className = 'ovl-load';
  loadEl.innerHTML =
    '<div class="t">KEN FLIGHT SIM</div>' +
    '<div class="bar"><i></i></div>' +
    '<div class="s">loading terrain…</div>';
  const loadSub = loadEl.querySelector('.s');
  root.appendChild(loadEl);

  host.appendChild(root);

  let toastTimer = 0;
  let keysShown = true;
  let crashShown = false;
  let crashText = '';

  function row(parent, label) {
    const d = document.createElement('div');
    d.innerHTML = `${label} <span class="v">—</span>`;
    parent.appendChild(d);
    return d.querySelector('.v');
  }

  function toggleKeys() {
    keysShown = !keysShown;
    keys.style.display = keysShown ? '' : 'none';
    hint.style.display = keysShown ? 'none' : '';
  }

  return {
    /** Progress text on the boot screen. */
    setLoadingText(t) {
      if (loadSub) loadSub.textContent = t;
    },
    /** Fade the boot screen out and stop the sweep animation. */
    hideLoading() {
      loadEl.classList.add('gone');
      setTimeout(() => loadEl.remove(), 600);
    },
    /** Boot failed — say so on the screen the user is already looking at. */
    setLoadingError(msg) {
      loadEl.innerHTML =
        '<div class="t" style="color:#ff9a9a">COULD NOT START</div>' +
        `<div class="s" style="max-width:70ch;white-space:pre-wrap;text-align:center">${esc(msg)}</div>`;
    },
    setActive(i) {
      for (let k = 0; k < buttons.length; k += 1) buttons[k].classList.toggle('on', k === i);
    },
    setCamera(name) {
      stCam.textContent = name;
    },
    setTime(label) {
      stTime.textContent = label;
    },
    setAudio(label, warn) {
      stAudio.textContent = label;
      stAudio.classList.toggle('warn', !!warn);
    },
    setPaused(p) {
      pausedEl.classList.toggle('show', !!p);
    },
    /**
     * Show or hide the crash card. Called every frame with the model's latched
     * `crashed` flag, so it is idempotent and cheap: the DOM is only written
     * when the state actually changes.
     *
     * @param {boolean} on
     * @param {string} [detail] one line, e.g. "gear collapsed — 21 m/s into 22° terrain"
     */
    setCrashed(on, detail) {
      const want = !!on;
      if (want === crashShown && (!want || detail === crashText)) return;
      crashShown = want;
      crashText = detail || '';
      crashDetail.textContent = crashText;
      crashEl.classList.toggle('show', want);
    },
    toggleKeys,
    toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1500);
    },
    dispose() {
      clearTimeout(toastTimer);
      root.remove();
    },
  };
}

const KEYMAP = [
  ['W / S', 'nose down / up'],
  ['A / D', 'roll left / right'],
  ['Q / E', 'rudder'],
  ['Shift/Ctrl', 'throttle'],
  ['Z / X', 'full power / idle'],
  ['F · B', 'flaps · brakes'],
  ['C · V', 'view · panel view'],
  ['1 – 4', 'jump to a place'],
  ['R · P', 'reset · pause'],
  ['T · N', 'time of day · mute'],
  ['M', 'mouse yoke'],
];

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
