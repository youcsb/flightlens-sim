/**
 * png.mjs — a minimal PNG decoder/encoder for the bake scripts.
 *
 * Node has no image library here and we are not adding a dependency, so this
 * file does the two jobs the land-cover baker needs and nothing else:
 *
 *   decodePng(buffer)        -> { width, height, rgba: Uint8Array }
 *   encodePngRGB(w, h, rgb)  -> Buffer   (8-bit colour type 2, no interlace)
 *
 * SCOPE, stated so nobody mistakes this for a general codec:
 *   - decode handles 8-bit colour types 0 (grey), 2 (RGB), 3 (palette),
 *     4 (grey+alpha) and 6 (RGBA), non-interlaced, which is everything the
 *     MRLC WMS and the TIGER services return.
 *   - 16-bit and Adam7 interlace THROW rather than silently returning garbage.
 *     A wrong land-cover raster is worse than a missing one.
 *
 * The encoder writes colour type 2 on purpose: it is exactly what the Terrarium
 * DEM tiles use, so the runtime decode path (Image -> canvas -> getImageData)
 * is already proven in this project to round-trip 8-bit channel values
 * unmodified. Greyscale and palette PNGs are more compact but invite colour
 * management on the browser side, and these bytes are DATA, not a picture.
 */

import { inflateSync, deflateSync } from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, table built once. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Decode a PNG to straight RGBA8.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{width:number, height:number, rgba:Uint8Array}}
 */
export function decodePng(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  /** @type {Buffer|null} */ let palette = null;
  /** @type {Buffer|null} */ let trns = null;
  const idat = [];

  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
  }

  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
  if (interlace !== 0) throw new Error('interlaced PNG not supported');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('truncated PNG data');

  // Un-filter in place into a contiguous buffer with no per-row filter byte.
  const out = Buffer.alloc(stride * height);
  const bpp = channels;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[up + x] : 0;
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0;
      const v = raw[src + x];
      let r;
      switch (filter) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      out[dst + x] = r & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = out[s + 1];
    } else if (colorType === 2) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2];
      rgba[d + 3] = 255;
    } else if (colorType === 6) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1];
      rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3];
    } else {
      const idx = out[s];
      if (!palette) throw new Error('palette PNG with no PLTE');
      rgba[d] = palette[idx * 3];
      rgba[d + 1] = palette[idx * 3 + 1];
      rgba[d + 2] = palette[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }

  return { width, height, rgba };
}

/**
 * Encode 8-bit RGB (3 bytes per pixel, row-major, top-left origin).
 *
 * Filter choice: the land-cover raster is large flat regions of one value, so
 * filter 0 (None) leaves long runs of identical bytes that deflate collapses
 * to almost nothing. Sub/Paeth would break those runs up. Measured on the
 * region raster: None is ~4x smaller than Paeth here.
 *
 * @param {number} width @param {number} height
 * @param {Uint8Array} rgb
 * @returns {Buffer}
 */
export function encodePngRGB(width, height, rgb) {
  const stride = width * 3;
  if (rgb.length !== stride * height) throw new Error('rgb length mismatch');

  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
