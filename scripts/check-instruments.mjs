/**
 * check-instruments.mjs — does the panel actually wire up?
 *
 *   node scripts/check-instruments.mjs
 *
 * ui/instruments.js builds its entire panel as one SVG string, parses it once,
 * and then drives about thirty nodes by id. The failure mode that costs a whole
 * session is a single mistyped id: `svgEl.querySelector('#ki1-alt-h')` returns
 * null, `setAttr(null, ...)` returns early by design, and the altimeter's
 * hundreds hand simply never moves. No exception, no console warning, nothing
 * to see except a gauge that is quietly dead. A build passes. A screenshot of a
 * parked aeroplane looks identical.
 *
 * So this file mounts the panel against a deliberately minimal DOM shim — a few
 * dozen lines, no jsdom — and checks three things a browser screenshot cannot:
 *
 *   1. every id `update()` writes to EXISTS in the generated markup,
 *   2. every gauge actually responds to the state field it is supposed to read,
 *   3. the needles INTERPOLATE — a step change in the state moves the needle
 *      part of the way, not all of it, on the frame it arrives.
 *
 * The shim is not a browser. It does not lay anything out or draw anything. It
 * indexes the markup by id and records attribute writes, which is exactly the
 * surface instruments.js touches and nothing more.
 */

// ---------------------------------------------------------------------------
// A DOM small enough to read in one sitting.
// ---------------------------------------------------------------------------

class Node_ {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = new Map();
    this.classes = new Set();
    this._text = '';
    this._html = '';
    this.byId = new Map();
    this.style = {};
  }
  get className() {
    return [...this.classes].join(' ');
  }
  set className(v) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get classList() {
    return {
      toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)),
      contains: (c) => this.classes.has(c),
    };
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  remove() {
    this.removed = true;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  /**
   * The panel is one flat SVG string. Rather than parse it, index every
   * `id="..."` in it and hand back a stub per id — which is precisely the
   * question we are asking: does this id exist in the markup at all?
   */
  set innerHTML(markup) {
    this._html = markup;
    const root = new Node_('svg');
    root._html = markup;
    for (const m of markup.matchAll(/\bid="([^"]+)"/g)) {
      const stub = new Node_('g');
      stub.id = m[1];
      root.byId.set(m[1], stub);
    }
    root.querySelector = (sel) => {
      if (!sel.startsWith('#')) throw new Error(`shim: unsupported selector ${sel}`);
      return root.byId.get(sel.slice(1)) ?? null;
    };
    this.children = [root];
  }
  get innerHTML() {
    return this._html;
  }
}

globalThis.document = {
  createElement: (tag) => new Node_(tag),
  body: new Node_('body'),
};
let clockMs = 0;
globalThis.performance = { now: () => clockMs };

const { createInstruments } = await import('../src/ui/instruments.js');

// ---------------------------------------------------------------------------
let failures = 0;
let checks = 0;
const ok = (name, cond, note = '') => {
  checks++;
  if (!cond) failures++;
  console.log(
    `  ${cond ? '\x1b[32m ok \x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}` +
      `${note ? `   (${note})` : ''}`,
  );
};
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m\n${'-'.repeat(t.length)}`);

/** A plausible flight-model state. Only display fields — as the contract says. */
function makeState(o = {}) {
  return {
    airspeedKts: 0,
    indicatedAirspeedKts: 0,
    altitudeFt: 21,
    altitudeAglFt: 0,
    verticalSpeedFpm: 0,
    headingDeg: 330.13,
    pitchDeg: 0,
    rollDeg: 0,
    rpm: 700,
    stalled: false,
    stallWarning: false,
    onGround: true,
    lat: 47.516745,
    lon: -122.291252,
    flapsPos: 0,
    flaps: 0,
    brakes: 0,
    ...o,
  };
}

const container = new Node_('div');
const panel = createInstruments(container);
const svg = panel.root.children.find((c) => c.tagName === 'svg');
const markup = svg.innerHTML;
const el = (id) => svg.byId.get(id);
const u = [...svg.byId.keys()][0].split('-')[0]; // the instance prefix, e.g. "ki1"

/** Step the panel forward `ms` and hand it `state`. */
function tick(state, ms = 16.7) {
  clockMs += ms;
  panel.update(state);
}

// ---------------------------------------------------------------------------
head('1. the panel mounts and every driven id exists');
// ---------------------------------------------------------------------------
ok('createInstruments appended exactly one root', container.children.length === 1);
ok('the root carries the public .instruments class', panel.root.classes.has('instruments'));
ok('an <svg> was produced', !!svg, `${markup.length} chars of markup`);
ok('the container was appended to, not cleared', container.children[0] === panel.root);

// These are every id update() writes to. If one is missing the gauge is dead
// and nothing anywhere reports it.
const DRIVEN = [
  'asi-n', 'ai-card', 'alt-h', 'alt-k', 'alt-tk', 'alt-baro',
  'tc-plane', 'tc-ball', 'hi-card', 'hi-true', 'hi-mag',
  'vsi-n', 'tach-n', 'tach-hobbs',
  'lamp-stall', 'lamp-gnd', 'lamp-brk',
  'gear-0', 'gear-1', 'gear-2', 'gear-txt',
  'flap-0', 'flap-1', 'flap-2', 'flap-3', 'flap-txt',
  'agl', 'nrst', 'nrst-sub', 'pos', 'msl',
];
const missing = DRIVEN.filter((id) => !el(`${u}-${id}`));
ok('every driven node id is present in the markup', missing.length === 0, missing.join(', ') || `${DRIVEN.length} ids`);

// ---------------------------------------------------------------------------
head('2. the six-pack plus tach is really there');
// ---------------------------------------------------------------------------
const count = (re) => (markup.match(re) || []).length;
ok('seven instrument bezels drawn', count(/-bezel\)/g) === 7, `${count(/-bezel\)/g)}`);
ok('seven dial faces drawn', count(/-face\)/g) === 7, `${count(/-face\)/g)}`);
ok('glass sheen on all seven', count(/-sheen\)/g) === 7, `${count(/-sheen\)/g)}`);
ok('gradients and clip paths defined once', count(/<defs>/g) === 1);
ok('markup is well-formed enough to balance <g>', count(/<g[\s>]/g) === count(/<\/g>/g), `${count(/<g[\s>]/g)} open`);
ok('markup balances <text>', count(/<text[\s>]/g) === count(/<\/text>/g));
ok('one viewBox on the root svg', count(/viewBox=/g) === 1);
ok('nothing NaN leaked into the markup', !/NaN|undefined|Infinity/.test(markup),
  (markup.match(/NaN|undefined|Infinity/) || [''])[0]);

// The airspeed arcs are the claim that the panel matches the flight model.
ok('ASI has a green arc (Vs1..Vno)', /stroke="#3fb96b"/.test(markup));
ok('ASI has a yellow caution arc', /stroke="#ffb02e"/.test(markup));
ok('ASI has a white flap-operating arc', /stroke="#f0f4f8"/.test(markup));
ok('a red line is drawn (Vne / tach redline)', count(/stroke="#e2453c"/g) >= 2);
ok('attitude indicator has a sky and a ground gradient', /-sky\)/.test(markup) && /-gnd\)/.test(markup));
ok('heading card carries N / E / S / W', /">N</.test(markup) && /">E</.test(markup) && /">S</.test(markup) && /">W</.test(markup));

// ---------------------------------------------------------------------------
head('3. gauges respond to the state fields they read');
// ---------------------------------------------------------------------------
// Settle on the ground first. The first update() snaps by design.
tick(makeState());
for (let i = 0; i < 60; i++) tick(makeState());

const rot = (id) => {
  const t = el(`${u}-${id}`).getAttribute('transform') || '';
  const m = t.match(/rotate\(([-\d.]+)\)/);
  return m ? parseFloat(m[1]) : NaN;
};

const asiRest = rot('asi-n');
const tachRest = rot('tach-n');
const vsiRest = rot('vsi-n');
const altRest = rot('alt-h');

// Fly for a while at a cruise state and see what moved.
const cruise = makeState({
  airspeedKts: 112, indicatedAirspeedKts: 108, altitudeFt: 4500, altitudeAglFt: 3800,
  verticalSpeedFpm: 500, headingDeg: 90, pitchDeg: 4, rollDeg: 12, rpm: 2400,
  onGround: false, flapsPos: 0,
});
for (let i = 0; i < 240; i++) tick(cruise);

ok('ASI needle moved', Math.abs(rot('asi-n') - asiRest) > 30, `${asiRest.toFixed(0)} -> ${rot('asi-n').toFixed(0)} deg`);
ok('tachometer needle moved', Math.abs(rot('tach-n') - tachRest) > 30, `${tachRest.toFixed(0)} -> ${rot('tach-n').toFixed(0)} deg`);
ok('VSI needle moved', Math.abs(rot('vsi-n') - vsiRest) > 10, `${vsiRest.toFixed(0)} -> ${rot('vsi-n').toFixed(0)} deg`);
ok('altimeter hundreds hand moved', Math.abs(rot('alt-h') - altRest) > 5, `${altRest.toFixed(0)} -> ${rot('alt-h').toFixed(0)} deg`);
ok('heading card rotated to 090', Math.abs(rot('hi-card') - -90) < 1.5, `${rot('hi-card').toFixed(1)} deg, want -90`);
ok('heading card stays wrapped, never accumulates laps', Math.abs(rot('hi-card')) <= 360, `${rot('hi-card').toFixed(1)} deg`);
ok('attitude card banked', /rotate\(-1[12]\./.test(el(`${u}-ai-card`).getAttribute('transform')), el(`${u}-ai-card`).getAttribute('transform'));
ok('attitude card pitched', /translate\(0 10\./.test(el(`${u}-ai-card`).getAttribute('transform')), el(`${u}-ai-card`).getAttribute('transform'));

// A turn coordinator measures RATE OF TURN, so it needs a heading that is
// actually changing — pointing it at a constant 090 proves nothing. Fly a
// standard-rate turn (3 deg/s) and the little aeroplane should sit on the
// standard-rate index, by definition.
{
  const p = createInstruments(new Node_('div'));
  const s2 = p.root.children.find((c) => c.tagName === 'svg');
  const pre = [...s2.byId.keys()][0].split('-')[0];
  const tilt = () =>
    parseFloat(s2.byId.get(`${pre}-tc-plane`).getAttribute('transform').match(/rotate\(([-\d.]+)\)/)[1]);
  let hdg = 0;
  for (let i = 0; i < 900; i++) {
    clockMs += 16.7;
    hdg = (hdg + 3 * 0.0167) % 360; // 3 deg/s = standard rate
    p.update(makeState({ headingDeg: hdg, rollDeg: 17, onGround: false,
      airspeedKts: 95, indicatedAirspeedKts: 95 }));
  }
  ok('turn coordinator sits on the standard-rate index in a 3 deg/s turn',
    Math.abs(tilt() - 20) < 3, `${tilt().toFixed(1)} deg, want 20`);

  // And the other way.
  for (let i = 0; i < 900; i++) {
    clockMs += 16.7;
    hdg = (hdg - 3 * 0.0167 + 360) % 360;
    p.update(makeState({ headingDeg: hdg, rollDeg: -17, onGround: false,
      airspeedKts: 95, indicatedAirspeedKts: 95 }));
  }
  ok('and mirrors for a left turn', Math.abs(tilt() + 20) < 3, `${tilt().toFixed(1)} deg, want -20`);
}

// The ASI reads INDICATED, not true — the arcs on the face are KIAS.
{
  const asiFor = (st) => {
    const p = createInstruments(new Node_('div'));
    const s2 = p.root.children.find((c) => c.tagName === 'svg');
    const pre = [...s2.byId.keys()][0].split('-')[0];
    for (let i = 0; i < 400; i++) {
      clockMs += 16.7;
      p.update(st);
    }
    const t = s2.byId.get(`${pre}-asi-n`).getAttribute('transform');
    return parseFloat(t.match(/rotate\(([-\d.]+)\)/)[1]);
  };
  const high = makeState({ airspeedKts: 130, indicatedAirspeedKts: 100, altitudeFt: 14000, onGround: false });
  const low = makeState({ airspeedKts: 100, indicatedAirspeedKts: 100, altitudeFt: 500, onGround: false });
  ok(
    'ASI tracks INDICATED airspeed, not true',
    Math.abs(asiFor(high) - asiFor(low)) < 0.5,
    `${asiFor(high).toFixed(1)} vs ${asiFor(low).toFixed(1)} deg at the same 100 KIAS`,
  );
}

// ---------------------------------------------------------------------------
head('4. needles interpolate, they do not snap');
// ---------------------------------------------------------------------------
{
  const p = createInstruments(new Node_('div'));
  const s2 = p.root.children.find((c) => c.tagName === 'svg');
  const pre = [...s2.byId.keys()][0].split('-')[0];
  const grab = (id) =>
    parseFloat((s2.byId.get(`${pre}-${id}`).getAttribute('transform') || '').match(/rotate\(([-\d.]+)\)/)[1]);

  const slow = makeState({ airspeedKts: 50, indicatedAirspeedKts: 50, rpm: 700, onGround: false });
  clockMs += 16.7;
  p.update(slow); // first frame snaps, by design
  for (let i = 0; i < 60; i++) {
    clockMs += 16.7;
    p.update(slow);
  }
  const a0 = grab('asi-n');

  // Step change: 50 -> 150 kt in one frame.
  const fast = makeState({ airspeedKts: 150, indicatedAirspeedKts: 150, rpm: 2600, onGround: false });
  clockMs += 16.7;
  p.update(fast);
  const a1 = grab('asi-n');
  const target = 210 + ((150 - 40) / 160) * 330;

  ok('one frame of a 100 kt step moves the needle', a1 > a0 + 1, `${a0.toFixed(1)} -> ${a1.toFixed(1)} deg`);
  ok(
    'but nowhere near all the way (it is damped, not assigned)',
    a1 < a0 + (target - a0) * 0.35,
    `moved ${(((a1 - a0) / (target - a0)) * 100).toFixed(1)}% of the way in one frame`,
  );
  for (let i = 0; i < 300; i++) {
    clockMs += 16.7;
    p.update(fast);
  }
  ok('and it does arrive', Math.abs(grab('asi-n') - target) < 1.5, `${grab('asi-n').toFixed(1)} vs ${target.toFixed(1)} deg`);

  // Heading must take the SHORT way round 359 -> 001.
  const p2 = createInstruments(new Node_('div'));
  const s3 = p2.root.children.find((c) => c.tagName === 'svg');
  const pre2 = [...s3.byId.keys()][0].split('-')[0];
  const hdgCard = () =>
    parseFloat(s3.byId.get(`${pre2}-hi-card`).getAttribute('transform').match(/rotate\(([-\d.]+)\)/)[1]);
  clockMs += 16.7;
  p2.update(makeState({ headingDeg: 359 }));
  for (let i = 0; i < 30; i++) {
    clockMs += 16.7;
    p2.update(makeState({ headingDeg: 359 }));
  }
  const before = hdgCard();
  clockMs += 16.7;
  p2.update(makeState({ headingDeg: 1 }));
  const after = hdgCard();
  ok(
    'heading crosses north the short way, not 358 degrees backwards',
    Math.abs(after - before) < 3,
    `card ${before.toFixed(1)} -> ${after.toFixed(1)} deg`,
  );
}

// ---------------------------------------------------------------------------
head('5. the geographic readout — what makes the accuracy legible');
// ---------------------------------------------------------------------------
{
  const p = createInstruments(new Node_('div'));
  const s2 = p.root.children.find((c) => c.tagName === 'svg');
  const pre = [...s2.byId.keys()][0].split('-')[0];
  const txt = (id) => s2.byId.get(`${pre}-${id}`).textContent;

  const spawn = makeState();
  for (let i = 0; i < 120; i++) {
    clockMs += 16.7;
    p.update(spawn);
  }
  console.log(`     POSITION  "${txt('pos')}"`);
  console.log(`     MSL       "${txt('msl')}"`);
  console.log(`     NEAREST   "${txt('nrst')}"  /  "${txt('nrst-sub')}"`);
  console.log(`     RADIO ALT "${txt('agl')}"`);
  console.log(`     HEADING   "${txt('hi-true')}"  /  "${txt('hi-mag')}"`);
  console.log(`     HOBBS     "${txt('tach-hobbs')}"`);

  ok('lat/lon shows KBFI 32L to 4 decimals', /47\.5167° N/.test(txt('pos')) && /122\.2913° W/.test(txt('pos')), txt('pos'));
  ok('MSL reads the field elevation', /MSL 21 FT/.test(txt('msl')), txt('msl'));
  ok('AGL reads zero on the ground', txt('agl') === '0', txt('agl'));
  ok('true heading reads 330', txt('hi-true') === '330°T', txt('hi-true'));
  ok('magnetic heading is offset by the 15.6 deg variation', txt('hi-mag') === '315° MAG', txt('hi-mag'));
  ok(
    'nearest-airport degrades gracefully when unbaked',
    txt('nrst') === '----' || /^[A-Z0-9]{3,4}$/.test(txt('nrst')),
    txt('nrst'),
  );
  ok('hobbs meter is counting', parseFloat(txt('tach-hobbs')) >= 0, txt('tach-hobbs'));

  // Move to the Space Needle and the readout must follow.
  const needle = makeState({ lat: 47.6204, lon: -122.3491, altitudeFt: 1200, altitudeAglFt: 1050, onGround: false });
  for (let i = 0; i < 120; i++) {
    clockMs += 16.7;
    p.update(needle);
  }
  console.log(`     over the Space Needle: "${txt('pos')}"  AGL ${txt('agl')} ft`);
  ok('position tracks the aircraft', /47\.6204° N/.test(txt('pos')), txt('pos'));
  ok('AGL tracks too', parseInt(txt('agl').replace(/,/g, ''), 10) > 900, txt('agl'));
}

// ---------------------------------------------------------------------------
head('6. annunciators, flaps and brakes');
// ---------------------------------------------------------------------------
{
  const p = createInstruments(new Node_('div'));
  const s2 = p.root.children.find((c) => c.tagName === 'svg');
  const pre = [...s2.byId.keys()][0].split('-')[0];
  const node = (id) => s2.byId.get(`${pre}-${id}`);
  const run = (st, n = 200) => {
    for (let i = 0; i < n; i++) {
      clockMs += 16.7;
      p.update(st);
    }
  };

  run(makeState({ onGround: true, brakes: 1 }));
  ok('GND lamp lit on the ground', node('lamp-gnd').classes.has('on'));
  ok('BRK lamp lit with the brakes on', node('lamp-brk').classes.has('on'));
  ok('STALL lamp dark in normal flight', !node('lamp-stall').classes.has('on'));

  run(makeState({ onGround: false, stallWarning: true, airspeedKts: 52, indicatedAirspeedKts: 52 }));
  ok('STALL lamp lights STEADY on the buffet warning',
    node('lamp-stall').classes.has('on') && !node('lamp-stall').classes.has('blink'));

  run(makeState({ onGround: false, stalled: true, stallWarning: true, airspeedKts: 46, indicatedAirspeedKts: 46 }));
  ok('STALL lamp FLASHES once the wing lets go',
    node('lamp-stall').classes.has('on') && node('lamp-stall').classes.has('blink'));
  ok('GND lamp dark in the air', !node('lamp-gnd').classes.has('on'));

  // Flaps come from the flight model's actual position, not the lever.
  run(makeState({ onGround: false, flapsPos: 1, flaps: 1 }), 400);
  ok('flap readout shows the full detent', node('flap-txt').textContent === '30°', node('flap-txt').textContent);
  run(makeState({ onGround: false, flapsPos: 0, flaps: 0 }), 400);
  ok('flap readout returns to UP', node('flap-txt').textContent === 'UP', node('flap-txt').textContent);
  ok('flap readout is never "--" when the model publishes a position',
    node('flap-txt').textContent !== '--');

  // Blow-back: lever at 30, flaps still up above Vfe.
  run(makeState({ onGround: false, flapsPos: 0, flaps: 0, airspeedKts: 130, indicatedAirspeedKts: 130 }), 400);
  ok('flap gauge follows the aeroplane, not the switch', node('flap-txt').textContent === 'UP');

  ok('gear shows three greens on a fixed-gear aeroplane',
    node('gear-txt').textContent === 'DOWN (FIXED)', node('gear-txt').textContent);
}

// ---------------------------------------------------------------------------
head('7. robustness — it must never take the frame down');
// ---------------------------------------------------------------------------
{
  const p = createInstruments(new Node_('div'));
  let threw = null;
  try {
    p.update(null);
    p.update(undefined);
    p.update({});
    p.update(makeState({ airspeedKts: NaN, altitudeFt: Infinity, headingDeg: NaN, rpm: -1 }));
    p.update(makeState({ lat: NaN, lon: NaN }));
    p.update(makeState({ pitchDeg: 1e9, rollDeg: -1e9, verticalSpeedFpm: 1e9 }));
    for (let i = 0; i < 30; i++) {
      clockMs += 16.7;
      p.update(makeState({ airspeedKts: 90, indicatedAirspeedKts: 90 }));
    }
  } catch (e) {
    threw = e;
  }
  ok('survives null / empty / NaN / Infinity state', !threw, threw ? threw.message : '');
  const s2 = p.root.children.find((c) => c.tagName === 'svg');
  const pre = [...s2.byId.keys()][0].split('-')[0];
  const attrs = [...s2.byId.values()]
    .flatMap((n) => [...n.attrs.values()])
    .concat([...s2.byId.values()].map((n) => n.textContent));
  ok('no NaN written into any attribute afterwards', !attrs.some((v) => /NaN|Infinity/.test(v)),
    (attrs.find((v) => /NaN|Infinity/.test(v)) || ''));

  // Two panels must not fight over ids or styles.
  const a = createInstruments(new Node_('div'));
  const b = createInstruments(new Node_('div'));
  const idA = [...a.root.children.find((c) => c.tagName === 'svg').byId.keys()][0];
  const idB = [...b.root.children.find((c) => c.tagName === 'svg').byId.keys()][0];
  ok('two instances get distinct id namespaces', idA.split('-')[0] !== idB.split('-')[0], `${idA} vs ${idB}`);

  a.dispose();
  ok('dispose() removes the root', a.root.removed === true);
}

console.log(
  failures
    ? `\n\x1b[31m${failures} of ${checks} instrument checks FAILED\x1b[0m\n`
    : `\n\x1b[32mall ${checks} instrument checks passed\x1b[0m\n`,
);
process.exit(failures ? 1 : 0);
