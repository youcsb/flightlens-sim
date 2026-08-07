/**
 * canvas-stub.mjs — the minimum `document.createElement('canvas')` that
 * `geo/airports.js` needs in order to run in Node.
 *
 * airports.js paints two textures with 2D canvas — the pavement grain and the
 * runway-number glyph atlas — and both are called unconditionally from
 * `buildRunwayMeshes`. Neither one moves a vertex: the grain is a UV-mapped
 * multiply and the atlas only supplies UVs (and its ink-box code already has a
 * documented fallback for "a canvas that reports nothing at all", which is
 * exactly what this is). So stubbing the 2D context lets the harness run the
 * SHIPPING builder — the thing that decides where the pavement is drawn —
 * rather than a re-implementation of it.
 *
 * It is deliberately dumb. If a future marking needs real text metrics to place
 * geometry, this stub will make the UVs degenerate, not the positions, and the
 * float assertions in check-airports.mjs stay meaningful.
 */

class StubContext {
  constructor(width, height) {
    this.canvas = { width, height };
    this.fillStyle = '#000';
    this.font = '';
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
  }
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  getImageData(x, y, w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData() {}
  clearRect() {}
  fillRect() {}
  fillText() {}
  createRadialGradient() {
    return { addColorStop() {} };
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
  /** Helvetica Bold digits run about 0.56 em wide; good enough for a UV. */
  measureText(text) {
    const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] || '16');
    return { width: String(text).length * px * 0.56 };
  }
  save() {}
  restore() {}
  translate() {}
  scale() {}
  rotate() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arc() {}
  fill() {}
  stroke() {}
  drawImage() {}
}

/** Install a `document` with just enough canvas to satisfy airports.js. */
export function installCanvasStub() {
  if (globalThis.document?.createElement) return globalThis.document;
  const doc = {
    createElement(tag) {
      if (String(tag).toLowerCase() !== 'canvas') return { tagName: tag };
      const canvas = {
        width: 300,
        height: 150,
        _ctx: null,
        getContext(kind) {
          if (kind !== '2d') return null;
          if (!canvas._ctx) canvas._ctx = new StubContext(canvas.width, canvas.height);
          canvas._ctx.canvas = canvas;
          return canvas._ctx;
        },
        toDataURL: () => 'data:,',
      };
      return canvas;
    },
  };
  globalThis.document = doc;
  return doc;
}
