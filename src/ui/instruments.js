/**
 * instruments.js — the cockpit HUD / instrument panel.
 *
 * STUB IMPLEMENTATION. A plain DOM readout in the corner. Replace the internals
 * (canvas gauges, SVG dials, whatever) but do not change the exported signature.
 *
 * Contract: see MODULES.md § instruments
 *
 *   createInstruments(container) -> { update(state) }
 *
 * `state` is the flight model's state object, READ-ONLY here. This module is
 * THE DISPLAY BOUNDARY, and the only place in the codebase allowed to speak
 * imperial. It consumes the precomputed fields (airspeedKts, altitudeFt,
 * verticalSpeedFpm, headingDeg) and must never do physics, convert units
 * itself, or write back to state.
 *
 * ALT is MSL and AGL is above the terrain directly below. Both matter here:
 * the whole point of real elevation data is that the ground moves, so an
 * altimeter alone tells you nothing about whether you are about to hit
 * Mount Rainier.
 */

const FIELDS = [
  { key: 'airspeedKts', label: 'IAS', unit: 'kt', digits: 0 },
  { key: 'altitudeFt', label: 'ALT', unit: 'ft', digits: 0 },
  { key: 'altitudeAglFt', label: 'AGL', unit: 'ft', digits: 0 },
  { key: 'verticalSpeedFpm', label: 'V/S', unit: 'fpm', digits: 0 },
  { key: 'headingDeg', label: 'HDG', unit: '°', digits: 0 },
  { key: 'pitchDeg', label: 'PITCH', unit: '°', digits: 1 },
  { key: 'rollDeg', label: 'BANK', unit: '°', digits: 1 },
  { key: 'rpm', label: 'RPM', unit: '', digits: 0 },
];

/**
 * @param {HTMLElement} container Element to mount into. Instruments own their
 *                                own child nodes and must not clear siblings.
 * @returns {{ update: (state: Object) => void }}
 */
export function createInstruments(container) {
  const root = document.createElement('div');
  root.className = 'instruments';
  root.style.cssText = [
    'position:absolute',
    'left:16px',
    'bottom:16px',
    'padding:12px 16px',
    'background:rgba(8,12,18,0.68)',
    'border:1px solid rgba(150,180,220,0.25)',
    'border-radius:8px',
    'color:#cfe6ff',
    'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'letter-spacing:0.04em',
    'min-width:190px',
    'pointer-events:none',
    'user-select:none',
  ].join(';');

  const rows = new Map();

  for (const f of FIELDS) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;gap:14px';

    const label = document.createElement('span');
    label.textContent = f.label;
    label.style.color = 'rgba(160,190,225,0.65)';

    const value = document.createElement('span');
    value.textContent = '--';
    value.style.cssText = 'font-variant-numeric:tabular-nums;color:#e8f3ff';

    row.append(label, value);
    root.appendChild(row);
    rows.set(f.key, value);
  }

  const warn = document.createElement('div');
  warn.textContent = 'STALL';
  warn.style.cssText = [
    'margin-top:8px',
    'text-align:center',
    'font-weight:700',
    'letter-spacing:0.18em',
    'color:#ff6b6b',
    'visibility:hidden',
  ].join(';');
  root.appendChild(warn);

  const ground = document.createElement('div');
  ground.textContent = 'ON GROUND';
  ground.style.cssText = [
    'margin-top:4px',
    'text-align:center',
    'letter-spacing:0.14em',
    'color:#8fe38f',
    'visibility:hidden',
  ].join(';');
  root.appendChild(ground);

  // Geodetic readout. This is the honesty check for the whole project: fly to
  // 47.6204 / -122.3491 and the Space Needle should be underneath you.
  const position = document.createElement('div');
  position.style.cssText = [
    'margin-top:8px',
    'padding-top:6px',
    'border-top:1px solid rgba(150,180,220,0.18)',
    'text-align:center',
    'color:rgba(160,190,225,0.75)',
    'font-variant-numeric:tabular-nums',
  ].join(';');
  position.textContent = '--';
  root.appendChild(position);

  (container || document.body).appendChild(root);

  /**
   * Refresh the panel. Called once per rendered frame; keep it allocation-light
   * and avoid layout thrash.
   *
   * @param {Object} state Flight model state (see MODULES.md § flight model).
   */
  function update(state) {
    if (!state) return;
    for (const f of FIELDS) {
      const el = rows.get(f.key);
      const raw = state[f.key];
      if (!el) continue;
      el.textContent = Number.isFinite(raw)
        ? `${raw.toFixed(f.digits)}${f.unit}`
        : '--';
    }
    warn.style.visibility = state.stalled ? 'visible' : 'hidden';
    ground.style.visibility = state.onGround ? 'visible' : 'hidden';

    position.textContent =
      Number.isFinite(state.lat) && Number.isFinite(state.lon)
        ? `${state.lat.toFixed(4)}  ${state.lon.toFixed(4)}`
        : '--';
  }

  return { update };
}
