/**
 * keycode.js — one normalised key identity for every listener in the sim.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `KeyboardEvent.code` is the right thing to bind flight controls to. It names
 * the PHYSICAL key, so W/A/S/D stays the same shape of hand under the fingers
 * on QWERTY, AZERTY and Dvorak alike — which is what every game does and what
 * players expect. `KeyboardEvent.key` would move the controls around the
 * keyboard with the layout.
 *
 * But `code` is not always populated. It is the empty string whenever the
 * keystroke did not come from a physical key with a known scancode:
 *
 *   - on-screen / virtual keyboards,
 *   - some IME and accessibility paths,
 *   - remote-desktop and screen-sharing clients,
 *   - synthetic events, including every browser-automation harness that
 *     dispatches through CDP without a scancode.
 *
 * On all of those, a `code`-only binding means the aircraft simply does not
 * respond and there is no error to find — the events arrive, they just match
 * nothing. That is a silent, total loss of control.
 *
 * So: prefer `code`, fall back to a code SYNTHESISED from `key`. The fallback
 * gives up the layout-independence (it cannot know which physical key produced
 * an 'a'), which is the correct trade — layout-independence is a nicety, being
 * able to fly at all is not.
 *
 * `toUpperCase()` on letters matters more than it looks: `key` is case-shifted
 * by modifiers, so holding W and then pressing Shift for throttle delivers
 * keydown 'w' and keyup 'W'. Folding case is what stops that leaving the
 * elevator jammed at full deflection.
 */

/** Named keys that already share their name with their code. */
const IDENTITY = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Escape',
  'Enter',
  'Tab',
  'Backspace',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Delete',
  'Insert',
]);

/** `key` values that map to a side-specific code. We assume the left one. */
const SIDED = {
  Shift: 'ShiftLeft',
  Control: 'ControlLeft',
  Alt: 'AltLeft',
  Meta: 'MetaLeft',
};

/**
 * The physical-key identity of a keyboard event, with a fallback.
 *
 * @param {KeyboardEvent} e
 * @returns {string} a `KeyboardEvent.code` value, or '' if nothing can be made
 *          of the event at all. Never null or undefined, so callers can hand
 *          the result straight to a Set or a switch.
 */
export function eventCode(e) {
  if (!e) return '';
  // The common path: a real key on a real keyboard. Costs one truthiness test.
  if (e.code) return e.code;

  const k = e.key;
  if (typeof k !== 'string' || k === '') return '';

  if (k === ' ' || k === 'Spacebar') return 'Space';
  if (IDENTITY.has(k)) return k;
  if (SIDED[k]) return SIDED[k];

  if (k.length === 1) {
    const c = k.toUpperCase();
    if (c >= 'A' && c <= 'Z') return `Key${c}`;
    if (c >= '0' && c <= '9') return `Digit${c}`;
  }

  // Anything else (F-keys, punctuation, dead keys) is not bound by this sim;
  // return the raw name so a caller that does care can still match on it.
  return k;
}
