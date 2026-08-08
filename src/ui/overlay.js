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
 *
 *    One documented exception: the `viewport` meta tag. `env(safe-area-inset-*)`
 *    is a hard zero on iOS unless the viewport carries `viewport-fit=cover`, so
 *    without it every safe-area offset in this file and in instruments.js is a
 *    no-op and the place picker sits under the notch. It is set here, idempotently,
 *    because this module owns the page chrome and because doing it in JS cannot
 *    collide with an edit to `index.html` (see ensureViewportFit).
 *
 * ---------------------------------------------------------------------------
 * THE PHONE STORY
 * ---------------------------------------------------------------------------
 * Below the COMPACT_QUERY breakpoint (the same one instruments.js switches its
 * layout on — imported, not copied, so the two cannot disagree) the chrome
 * collapses to three always-visible things and a sheet:
 *
 *   MENU button   top left     opens the sheet
 *   A/P chip      top right    the autopilot annunciator, which must never be
 *                              behind a tap — it is how the player knows the
 *                              autopilot is flying
 *   toast         top centre   unchanged, moved clear of the heading strip
 *
 * Everything else — the place picker, the status rows, the key legend — is
 * REPARENTED into the sheet rather than duplicated, so `setActive`, `setCamera`
 * and friends keep writing to the same nodes in both layouts.
 *
 * The key legend is a desktop artefact: a phone has no keyboard, and listing
 * "W / S nose down / up" to someone who cannot press W is worse than showing
 * nothing. On a coarse pointer the sheet shows TAPPABLE actions instead, which
 * synthesise the keystroke their desktop equivalent would send (or call
 * `o.onAction(code, repeat)` if the integrator supplies one) — `repeat` is
 * true for every tick of a press-and-hold after the first, exactly as a
 * keyboard's auto-repeat reports it.
 *
 * THE TWO BOTTOM CORNERS BELONG TO THE TOUCH CONTROLS. Nothing in this file is
 * positioned into TOUCH_RESERVE; the sheet is centred and the chips are along
 * the top.
 */

import { COMPACT_QUERY, TOUCH_RESERVE, pickLayout } from './instruments.js';

/** Safe-area shorthands. A device without a notch answers 0px, which is right. */
const SL = 'env(safe-area-inset-left, 0px)';
const SR = 'env(safe-area-inset-right, 0px)';
const ST = 'env(safe-area-inset-top, 0px)';
const SB = 'env(safe-area-inset-bottom, 0px)';

const CSS = `
.ovl, .ovl * { box-sizing: border-box; }
.ovl {
  position: absolute; inset: 0; pointer-events: none;
  font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #cfd8e3; -webkit-font-smoothing: antialiased;
  /* ABOVE the instrument panel, which sits at z-index 20. Without this the
     compact menu sheet — and the boot screen — render UNDER the tapes, which
     is invisible on a desktop (the panel is bottom-centre, the chrome is at
     the edges) and glaring the moment the HUD moves to the screen edges. */
  z-index: 30;
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
.ovl-places { top: calc(${ST} + 12px); left: calc(${SL} + 12px); width: 216px; }
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
  top: calc(${ST} + 12px); right: calc(${SR} + 12px); min-width: 176px; text-align: right;
  pointer-events: none; padding: 8px 10px;
}
.ovl-status div { white-space: nowrap; }
.ovl-status .v { color: #ffffff; }
.ovl-status .warn { color: #ffcf6b; }

/* The instrument panel owns the bottom ~210 px of the window and runs the full
   width, so the key legend sits ABOVE it rather than beside it. */
.ovl-keys {
  bottom: calc(${SB} + 226px); left: calc(${SL} + 12px); width: 248px;
  max-height: calc(100vh - 420px); overflow: hidden;
}
.ovl-keys table { border-collapse: collapse; width: 100%; }
.ovl-keys td { padding: 1.5px 0; vertical-align: top; white-space: nowrap; }
.ovl-keys td.k { color: #8fb4de; width: 84px; padding-right: 8px; }
.ovl-hint {
  position: absolute; bottom: calc(${SB} + 226px); left: calc(${SL} + 12px);
  pointer-events: auto;
  cursor: pointer; color: #7f93ad; background: rgba(10,14,20,0.6);
  border: 1px solid rgba(150,175,205,0.18); border-radius: 7px; padding: 4px 8px;
}
.ovl-toast {
  position: absolute; left: 50%; top: calc(${ST} + 74px); transform: translateX(-50%);
  pointer-events: none; padding: 6px 14px; border-radius: 20px;
  background: rgba(10,14,20,0.8); border: 1px solid rgba(150,175,205,0.28);
  color: #ffffff; opacity: 0; transition: opacity 220ms ease;
  white-space: nowrap;
}
.ovl-toast.show { opacity: 1; }
/* A band, not a curtain. The chase camera frames the aeroplane dead centre, so
   anything drawn there hides the one thing the user is looking at. */
.ovl-paused {
  position: absolute; left: 0; right: 0; top: ${ST}; display: none;
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
  position: absolute; left: 50%; top: calc(${ST} + 108px); transform: translateX(-50%);
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
/* Too little room to show the legend without covering the windscreen.
   The CHILD combinator matters: once compact mode reparents the legend into
   the sheet it is no longer a child of .ovl, this rule stops applying, and a
   narrow desktop window — which still has a keyboard — gets its legend back
   inside the menu. Only the coarse-pointer rule below takes it away for good. */
@media (max-width: 900px), (max-height: 700px) {
  .ovl > .ovl-keys, .ovl > .ovl-hint { display: none !important; }
}

/* =========================================================================
   COMPACT — everything below here is inert until JS adds .ovl-c to the root.
   A class, not a media query, so this file and instruments.js switch on the
   SAME decision (including the ?hud= override) and can never disagree about
   which layout is on screen.
   ========================================================================= */

/* The three always-visible chips. */
.ovl-menu, .ovl-ap {
  position: absolute; display: none; pointer-events: auto;
  background: rgba(10,14,20,0.72);
  border: 1px solid rgba(150,175,205,0.22); border-radius: 8px;
  backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
  color: #cfd8e3; font: inherit; cursor: pointer;
  min-height: 34px; padding: 0 12px; line-height: 32px; white-space: nowrap;
}
.ovl-c .ovl-menu, .ovl-c .ovl-ap { display: block; }
.ovl-menu { top: calc(${ST} + 6px); left: calc(${SL} + 8px); letter-spacing: 0.12em; }
.ovl-ap {
  top: calc(${ST} + 6px); right: calc(${SR} + 8px);
  pointer-events: none; color: #7f93ad; letter-spacing: 0.06em;
}
.ovl-ap.on {
  color: #0b0d10; background: #3fb96b; border-color: #7fe0a4; font-weight: 700;
}

/* On a phone the panels move INSIDE the sheet, so their absolute positions,
   fixed widths and backdrop go away and the sheet lays them out in flow. */
.ovl-c .ovl-places, .ovl-c .ovl-status, .ovl-c .ovl-keys, .ovl-c .ovl-hint {
  display: none;
}
.ovl-sheet-body .ovl-panel {
  position: static; width: auto; min-width: 0; text-align: left;
  background: none; border: none; box-shadow: none; backdrop-filter: none;
  -webkit-backdrop-filter: none; padding: 0; margin-bottom: 14px;
  display: block !important; max-height: none; overflow: visible;
}
.ovl-sheet-body .ovl-status div { display: flex; justify-content: space-between; }

/* The sheet itself. Centred, never in a bottom corner — those are thumbs. */
.ovl-sheet {
  position: absolute; inset: 0; display: none; pointer-events: auto;
  background: rgba(4,6,9,0.62);
  align-items: center; justify-content: center;
  padding: calc(${ST} + 8px) calc(${SR} + 8px) calc(${SB} + 8px) calc(${SL} + 8px);
}
.ovl-sheet.show { display: flex; }
.ovl-sheet-card {
  width: min(420px, 100%); max-height: 100%; overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  background: rgba(10,14,20,0.94);
  border: 1px solid rgba(150,175,205,0.28); border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.6); padding: 12px 12px 14px;
}
.ovl-sheet-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px;
}
.ovl-sheet-head b { font-size: 12px; letter-spacing: 0.2em; font-weight: 600; }
.ovl-x {
  pointer-events: auto; cursor: pointer; background: rgba(255,255,255,0.06);
  border: 1px solid rgba(150,175,205,0.22); border-radius: 8px; color: #d7e2ee;
  font: inherit; width: 38px; height: 38px; line-height: 1;
}
/* Actions: what the keyboard shortcuts are, for a device with no keyboard. */
.ovl-acts-wrap { margin-bottom: 2px; }
.ovl-acts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
.ovl-acts button {
  pointer-events: auto; cursor: pointer; min-height: 44px;
  background: rgba(255,255,255,0.045);
  border: 1px solid rgba(150,175,205,0.16); border-radius: 8px;
  color: #d7e2ee; font: inherit; padding: 4px 2px;
}
.ovl-acts button:active { background: rgba(120,180,255,0.22); }

/* Bigger targets wherever a finger is the pointer, sheet or not. */
@media (pointer: coarse) {
  .ovl-btn { min-height: 44px; padding: 7px 10px; }
  .ovl-menu, .ovl-ap { min-height: 38px; line-height: 36px; }
}
/* No keyboard, no key legend — see the header note. */
@media (pointer: coarse) and (any-pointer: coarse) and (hover: none) {
  .ovl-sheet-body .ovl-keys { display: none !important; }
}

/* Landscape is the primary orientation; portrait gets a chip that says so and
   then gets out of the way. It sits mid-screen, clear of both thumb corners. */
.ovl-rotate {
  position: absolute; left: 50%; transform: translateX(-50%);
  bottom: calc(${SB} + ${TOUCH_RESERVE.portrait.h}px + 150px);
  display: none; pointer-events: auto; cursor: pointer;
  padding: 7px 14px; border-radius: 20px;
  background: rgba(10,14,20,0.82); border: 1px solid rgba(150,175,205,0.3);
  color: #cfd8e3; opacity: 1; transition: opacity 500ms ease;
}
@media (orientation: portrait) {
  .ovl-c .ovl-rotate { display: block; }
}
.ovl-rotate.gone { opacity: 0; pointer-events: none; }

/* Compact toast: clear of the heading strip instruments.js puts at the top. */
.ovl-c .ovl-toast { top: calc(${ST} + 108px); max-width: 74vw; white-space: normal;
                    text-align: center; }
@media (orientation: portrait) { .ovl-c .ovl-toast { top: calc(${ST} + 152px); } }
.ovl-c .ovl-crash { top: calc(${ST} + 150px); padding: 9px 14px; }
.ovl-c .ovl-crash .h { font-size: 13px; }
.ovl-c .ovl-crash .d { font-size: 11px; }
.ovl-c .ovl-paused { padding: 6px 0 18px; }
.ovl-c .ovl-paused span { font-size: 12px; }
.ovl-load { padding: ${ST} ${SR} ${SB} ${SL}; }
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

  ensureViewportFit();

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
      closeSheet(); // no-op on desktop, where the picker is not in a sheet
      if (typeof o.onGoto === 'function') o.onGoto(i);
    });
    places.appendChild(b);
    return b;
  });
  root.appendChild(places);

  // --- status -------------------------------------------------------------
  const status = document.createElement('div');
  status.className = 'ovl-panel ovl-status';
  const stType = row(status, 'AIRCRAFT');
  const stCam = row(status, 'VIEW');
  const stTime = row(status, 'TIME');
  const stAudio = row(status, 'SOUND');
  const stAp = row(status, 'A/P');
  /* The two readouts the compact HUD crops off the windscreen. On a desktop
     they sit here in the status panel; on a phone this whole panel reparents
     into the menu sheet, so they are one tap away rather than in the view. */
  const stNear = row(status, 'FIELD');
  const stRpm = row(status, 'RPM');
  /* Trim has no needle of its own — the six-pack has no trim gauge, and a real
     one is a wheel with a paint mark. A signed readout says the same thing and
     costs no windscreen. */
  const stTrim = row(status, 'TRIM');
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

  // --- compact chrome -----------------------------------------------------
  // Three chips and a sheet. Built unconditionally and left `display: none` by
  // the stylesheet until `.ovl-c` is on the root: building them lazily would
  // mean the first frame after a rotation has no autopilot annunciator.
  const menuBtn = document.createElement('button');
  menuBtn.className = 'ovl-menu';
  menuBtn.type = 'button';
  menuBtn.textContent = '☰ MENU';
  root.appendChild(menuBtn);

  // The autopilot annunciator's compact home. It is `pointer-events: none` and
  // it is never inside the sheet, because "is the autopilot flying?" has to be
  // answerable without opening anything.
  const apChip = document.createElement('div');
  apChip.className = 'ovl-ap';
  apChip.textContent = 'A/P OFF';
  root.appendChild(apChip);

  const rotateEl = document.createElement('div');
  rotateEl.className = 'ovl-rotate';
  rotateEl.textContent = '⟳  turn sideways to fly';
  root.appendChild(rotateEl);

  const sheet = document.createElement('div');
  sheet.className = 'ovl-sheet';
  sheet.innerHTML =
    '<div class="ovl-sheet-card">' +
    '<div class="ovl-sheet-head"><b>MENU</b>' +
    '<button class="ovl-x" type="button" aria-label="close">✕</button></div>' +
    '<div class="ovl-sheet-body"></div></div>';
  const sheetBody = sheet.querySelector('.ovl-sheet-body');
  root.appendChild(sheet);

  // The actions block. On a phone these ARE the keyboard: each button sends
  // the keystroke its desktop equivalent would send, so main.js needs no new
  // callback and cannot drift out of sync with the legend.
  const acts = document.createElement('div');
  acts.className = 'ovl-acts-wrap';
  acts.innerHTML =
    '<div class="ovl-h">Controls</div><div class="ovl-acts">' +
    ACTIONS.map(
      (a) => `<button type="button" data-code="${a[0]}"${a[2] ? ' data-hold="1"' : ''}>${esc(a[1])}</button>`,
    ).join('') +
    '</div>';

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
    '<div class="t">EVERETT&rsquo;S FLIGHT SIM</div>' +
    '<div class="bar"><i></i></div>' +
    '<div class="s">loading terrain…</div>';
  const loadSub = loadEl.querySelector('.s');
  root.appendChild(loadEl);

  host.appendChild(root);

  let toastTimer = 0;
  let keysShown = true;
  let crashShown = false;
  let crashText = '';
  let rotateTimer = 0;

  // -------------------------------------------------------------------------
  // Compact mode: reparent, do not duplicate.
  // -------------------------------------------------------------------------
  /** null until applyMode() runs, so the first call always does the work. */
  let compact = null;

  function applyMode(next) {
    if (next === compact) return;
    compact = next;
    root.classList.toggle('ovl-c', next);
    if (next) {
      // Same nodes, new parent — every setter in the returned handle keeps
      // working, and `setActive` still lights the button the user tapped.
      sheetBody.appendChild(places);
      sheetBody.appendChild(status);
      sheetBody.appendChild(acts);
      sheetBody.appendChild(keys);
      keys.style.display = ''; // the sheet decides, not the H key
    } else {
      // insertBefore, not appendChild: appending would move these three PAST
      // the loading screen in document order, and they would paint on top of
      // it for the whole of the boot.
      root.insertBefore(places, menuBtn);
      root.insertBefore(status, menuBtn);
      root.insertBefore(keys, menuBtn);
      if (acts.parentNode) acts.parentNode.removeChild(acts);
      keys.style.display = keysShown ? '' : 'none';
      closeSheet();
    }
  }

  function openSheet() {
    sheet.classList.add('show');
  }
  function closeSheet() {
    sheet.classList.remove('show');
  }

  menuBtn.addEventListener('click', () => {
    menuBtn.blur();
    if (sheet.classList.contains('show')) closeSheet();
    else openSheet();
  });
  sheet.querySelector('.ovl-x').addEventListener('click', (e) => {
    e.target.blur();
    closeSheet();
  });
  // A tap on the scrim, not on the card, dismisses.
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) closeSheet();
  });

  // Rotate hint: say it once, then get out of the way. It is a chip, not a
  // curtain — portrait is a WORSE layout here, not a broken one, and locking
  // the player out of their own aeroplane over an orientation is not graceful.
  let rotateDismissed = false;
  rotateEl.addEventListener('click', () => {
    rotateDismissed = true;
    clearTimeout(rotateTimer);
    rotateEl.classList.add('gone');
  });
  function armRotateHint() {
    if (rotateDismissed || typeof setTimeout !== 'function') return;
    clearTimeout(rotateTimer);
    rotateEl.classList.remove('gone');
    rotateTimer = setTimeout(() => rotateEl.classList.add('gone'), 7000);
  }
  armRotateHint();
  // Re-arm on every ENTRY into portrait. Without this the hint is spent seven
  // seconds after boot, so the player who boots in landscape and then turns the
  // phone upright — the only person it is for — never sees it.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const pmq = window.matchMedia('(orientation: portrait)');
    const onP = (e) => {
      if (e.matches) armRotateHint();
    };
    if (typeof pmq.addEventListener === 'function') pmq.addEventListener('change', onP);
    else if (typeof pmq.addListener === 'function') pmq.addListener(onP);
  }

  // --- action buttons ------------------------------------------------------
  wireActions(acts, (code, repeat) => {
    if (typeof o.onAction === 'function') o.onAction(code, repeat);
    else fireKey(code, repeat);
    if (code === 'KeyR' || code === 'KeyP') closeSheet();
  });

  // --- which mode? ---------------------------------------------------------
  let mq = null;
  const onMq = () => applyMode(wantCompact());
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mq = window.matchMedia(COMPACT_QUERY);
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMq);
    else if (typeof mq.addListener === 'function') mq.addListener(onMq);
  }
  applyMode(wantCompact());

  function row(parent, label) {
    const d = document.createElement('div');
    d.innerHTML = `${label} <span class="v">—</span>`;
    parent.appendChild(d);
    return d.querySelector('.v');
  }

  function toggleKeys() {
    // On a phone the legend lives in the sheet, so H — which a phone does not
    // have anyway, but a Bluetooth keyboard does — toggles the sheet instead.
    if (compact) {
      if (sheet.classList.contains('show')) closeSheet();
      else openSheet();
      return;
    }
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
    /** Which aeroplane is being flown. Named, not abbreviated: the whole point
     *  of having two is knowing which one you are in. */
    setAircraft(name) {
      stType.textContent = name;
    },
    setTime(label) {
      stTime.textContent = label;
    },
    setAudio(label, warn) {
      stAudio.textContent = label;
      stAudio.classList.toggle('warn', !!warn);
    },
    /**
     * Autopilot annunciator. Called every frame, so it writes the DOM only
     * when the text actually changes — `textContent` assignment on an unchanged
     * string still dirties layout in some engines.
     *
     * Engaged reads "HDG 040  ALT 3500" so the bugs are visible without opening
     * anything; disengaged it shows the armed bugs in grey, because the numbers
     * you are about to fly to matter before you press the button.
     */
    /**
     * Readouts displaced from the compact cluster. Called every frame, so it
     * writes only on change — assigning an unchanged string still dirties
     * layout in some engines.
     * @param {{rpm:number, nearest:string, nearestSub:string}} info
     */
    setFlightInfo(info) {
      if (!info) return;
      if (Number.isFinite(info.trim)) {
        const t = info.trim;
        // Neutral is the common case and deserves a word, not "0.00".
        const txt =
          Math.abs(t) < 0.02
            ? 'neutral'
            : `${t > 0 ? 'UP' : 'DN'} ${Math.round(Math.abs(t) * 100)}%`;
        if (stTrim.textContent !== txt) stTrim.textContent = txt;
        stTrim.classList.toggle('warn', Math.abs(t) > 0.75);
      }
      const near = info.nearestSub ? `${info.nearest} ${info.nearestSub}` : info.nearest;
      if (stNear.textContent !== near) stNear.textContent = near;
      // The label follows the aeroplane: a piston reads RPM, a turbofan reads
      // N1 as a percentage. A row headed RPM showing a fan speed is worse than
      // no row, because it looks like a number someone checked.
      // row() builds `LABEL <span class="v">`, so the label is the text node
      // before the value span, and it carries the separating space.
      const lbl = `${info.engineLabel || 'RPM'} `;
      const labelNode = stRpm.previousSibling;
      if (labelNode && labelNode.textContent !== lbl) labelNode.textContent = lbl;
      const rpm = `${info.rpm ?? 0}${info.engineUnit || ''}`;
      if (stRpm.textContent !== rpm) stRpm.textContent = rpm;
    },
    setAutopilot(ap) {
      const txt = ap.engaged
        ? `HDG ${String(Math.round(ap.headingBug)).padStart(3, '0')} · ALT ${Math.round(ap.altitudeBug)}`
        : 'off';
      if (stAp.textContent !== txt) stAp.textContent = txt;
      stAp.classList.toggle('v', true);
      stAp.classList.toggle('warn', !!ap.engaged);

      // The compact chip carries its own label, because on a phone the row
      // heading ("A/P") that makes the status panel readable is gone.
      const chip = ap.engaged ? `A/P  ${txt}` : 'A/P OFF';
      if (apChip.textContent !== chip) apChip.textContent = chip;
      apChip.classList.toggle('on', !!ap.engaged);
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
    /** True when the phone chrome is on screen. For the acceptance check. */
    isCompact: () => !!compact,
    dispose() {
      clearTimeout(toastTimer);
      clearTimeout(rotateTimer);
      if (mq) {
        if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onMq);
        else if (typeof mq.removeListener === 'function') mq.removeListener(onMq);
        mq = null;
      }
      root.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Compact-mode helpers. Module scope, so they are testable and so nothing here
// touches the DOM until a factory runs (MODULES.md §2.18 makes the same
// argument for device.js, and for the same reason: it has to run in Node).
// ---------------------------------------------------------------------------

/**
 * `[code, label, hold?]`. These are exactly the app-level keys `main.js`
 * handles — the flight controls (W/A/S/D, throttle, flaps, brakes) are NOT
 * here, because they belong to `controls/input.js` and its touch layer.
 *
 * `hold` marks the four that repeat — both bug pairs. The heading bug steps one
 * degree and the altitude bug 100 feet per press, and setting either by tapping
 * is not a control: 054 to 234 is 180 taps, 1,000 ft to 8,000 ft is 70. Held,
 * both accelerate (main.js ramps the step on the repeat count) and land in
 * about a second and a half.
 */
const ACTIONS = [
  ['KeyC', 'VIEW'],
  ['KeyV', 'PANEL'],
  ['KeyT', 'TIME'],
  ['KeyN', 'SOUND'],
  ['KeyP', 'PAUSE'],
  ['KeyR', 'RESET'],
  ['KeyL', 'A/P'],
  ['KeyY', 'BUG=HDG'],
  ['KeyU', 'ALT +100', true],
  ['KeyJ', 'ALT −100', true],
  ['BracketLeft', 'HDG −', true],
  ['BracketRight', 'HDG +', true],
  // Trim is what lets a phone hold altitude without a thumb parked on the
  // stick, so it belongs here rather than being desktop-only. Held, like the
  // bugs, because settling on a trim is a nudge-until-it-looks-right gesture.
  ['Comma', 'TRIM ▼', true],
  ['Period', 'TRIM ▲', true],
  ['KeyK', 'TRIM 0'],
];

/** `e.code` is preferred by core/keycode.js, but send `key` too — §2.0. */
const KEY_CHAR = {
  KeyC: 'c', KeyV: 'v', KeyT: 't', KeyN: 'n', KeyP: 'p', KeyR: 'r',
  KeyL: 'l', KeyY: 'y', KeyU: 'u', KeyJ: 'j', KeyK: 'k',
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.',
};

/**
 * Send the keystroke a desktop player would send. This is deliberately NOT a
 * new callback into `main.js`: the switch in `main.js#onKeyDown` is already the
 * single definition of what each action does, and a parallel path would be a
 * second one to keep in step.
 *
 * `controls/input.js` uses the same trick for its own touch buttons
 * (`TOUCH_KEY`), so the pattern is the house pattern, not an invention here.
 */
function fireKey(code, repeat = false) {
  if (typeof window === 'undefined' || typeof KeyboardEvent !== 'function') return;
  const init = {
    code, key: KEY_CHAR[code] || '', bubbles: true, cancelable: true,
    // A held thumb IS an auto-repeat, and saying so is what earns the phone
    // main.js's acceleration ramp instead of 180 identical one-degree nudges.
    // The `keyup` deliberately never carries it: a repeat is a press that has
    // not ended, and input.js's key set would keep a released key "held".
    repeat,
  };
  window.dispatchEvent(new KeyboardEvent('keydown', init));
  window.dispatchEvent(new KeyboardEvent('keyup', { ...init, repeat: false }));
}

/**
 * Wire the action grid. Tap fires once; press-and-hold on a `data-hold`
 * button repeats and accelerates, which is how either bug is usable at all
 * with a thumb.
 *
 * `run(code, repeat)` — every tick after the first says it is a repeat, so the
 * phone gets the same accelerating step a desktop keyboard's auto-repeat gets.
 * That flag used to be pointless because `main.js#onKeyDown` dropped every
 * repeat at the door; it now passes the four bug keys through, which is also
 * what made the DESKTOP ramp work for the first time.
 */
function wireActions(host, run) {
  const buttons = host.querySelectorAll ? host.querySelectorAll('button[data-code]') : [];
  for (const b of buttons) {
    const code = b.getAttribute('data-code');
    if (!b.getAttribute('data-hold')) {
      b.addEventListener('click', () => {
        b.blur();
        run(code, false);
      });
      continue;
    }
    let timer = 0;
    let n = 0;
    const stop = () => {
      clearTimeout(timer);
      timer = 0;
      n = 0;
    };
    const step = () => {
      run(code, n > 0);
      n += 1;
      timer = setTimeout(step, n < 4 ? 190 : n < 14 ? 90 : 55);
    };
    b.addEventListener('pointerdown', (e) => {
      if (e.preventDefault) e.preventDefault();
      b.blur();
      stop();
      step();
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
      b.addEventListener(ev, stop);
    }
  }
}

/**
 * Add `viewport-fit=cover` to the page's viewport meta if it is missing.
 *
 * WITHOUT THIS EVERY `env(safe-area-inset-*)` IN THIS PROJECT IS ZERO. iOS only
 * reports the insets when the page has opted into drawing under the notch and
 * the home indicator; a page at the default `contain` fit gets a letterboxed
 * viewport and four zeroes, so a "safe area aware" layout that has never been
 * tested with the flag looks identical to one with no safe-area handling at
 * all — which is exactly how this goes unnoticed.
 *
 * Done in JS rather than in `index.html` so it is idempotent and cannot
 * conflict with another edit to the same tag.
 */
function ensureViewportFit() {
  if (typeof document === 'undefined' || !document.querySelector) return;
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    if (!document.head || !document.createElement) return;
    meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    meta.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
    document.head.appendChild(meta);
    return;
  }
  const content = meta.getAttribute('content') || '';
  if (/viewport-fit\s*=/.test(content)) return;
  meta.setAttribute('content', `${content.replace(/,\s*$/, '')}, viewport-fit=cover`);
}

/**
 * The chrome and the instruments must agree about which layout is on screen —
 * a MENU button over a seven-dial panel, or a place-picker panel over a tape
 * HUD, are both worse than either layout alone. So this asks instruments.js
 * rather than re-deriving it, which also picks up the `?hud=` override for
 * free (COMPACT_QUERY is imported only so the media listener watches the same
 * query the answer is derived from).
 */
function wantCompact() {
  return pickLayout('auto') === 'compact';
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
  ['I', 'change aircraft'],
  ['R · P', 'reset · pause'],
  ['T · N', 'time of day · mute'],
  ['M', 'mouse yoke'],
  [', · .', 'trim nose down / up'],
  ['K', 'trim to neutral'],
  ['L', 'autopilot on / off'],
  ['[ · ]', 'heading bug −/+ (hold)'],
  ['Y', 'bug to present heading'],
  ['U · J', 'altitude bug +/− 100'],
];

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
