// Pure image maths — no DOM. Used by app.js, testable in Node.
// Points are always ordered [topLeft, topRight, bottomRight, bottomLeft].
(function (root) {
  'use strict';

  // Solve 8x8 system for homography mapping `from` quad -> `to` quad.
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = from[i], X = to[i].x, Y = to[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      if (Math.abs(A[c][c]) < 1e-12) throw new Error('Degenerate quad');
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    return b.map((v, i) => v / A[i][i]);
  }

  function applyH(H, x, y) {
    const d = H[6] * x + H[7] * y + 1;
    return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
  }

  // Output size for a flattened document, capped at maxSide.
  function outputSize(p, maxSide) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let w = Math.max(d(p[0], p[1]), d(p[3], p[2]));
    let h = Math.max(d(p[0], p[3]), d(p[1], p[2]));
    const s = Math.min(1, maxSide / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  // Perspective-warp RGBA `src` (Uint8ClampedArray, sw x sh) into a new w x h buffer.
  function warp(src, sw, sh, pts, w, h) {
    const H = homography(
      [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], pts);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = applyH(H, x + 0.5, y + 0.5);
        let sx = s.x - 0.5, sy = s.y - 0.5;
        if (sx < 0) sx = 0; if (sy < 0) sy = 0;
        if (sx > sw - 1) sx = sw - 1; if (sy > sh - 1) sy = sh - 1;
        const x0 = sx | 0, y0 = sy | 0;
        const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
        const fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4,
              i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const top = src[i00 + c] * (1 - fx) + src[i10 + c] * fx;
          const bot = src[i01 + c] * (1 - fx) + src[i11 + c] * fx;
          out[o + c] = top * (1 - fy) + bot * fy;
        }
        out[o + 3] = 255;
      }
    }
    return out;
  }

  function otsu(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = i; }
    }
    return t;
  }

  // Find the paper: largest bright blob, then its 4 extreme corners.
  // Returns null if nothing sensible (caller falls back to manual corners).
  function detectDocument(rgba, w, h) {
    const n = w * h, gray = new Uint8Array(n);
    for (let i = 0; i < n; i++)
      gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
    const t = otsu(gray);
    const label = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    let bestId = -1, bestArea = 0, id = 0;
    for (let s = 0; s < n; s++) {
      if (gray[s] <= t || label[s] !== -1) continue;
      let sp = 0, area = 0; stack[sp++] = s; label[s] = id;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && gray[p - 1] > t && label[p - 1] === -1) { label[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && gray[p + 1] > t && label[p + 1] === -1) { label[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && gray[p - w] > t && label[p - w] === -1) { label[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && gray[p + w] > t && label[p + w] === -1) { label[p + w] = id; stack[sp++] = p + w; }
      }
      if (area > bestArea) { bestArea = area; bestId = id; }
      id++;
    }
    if (bestId < 0 || bestArea < 0.12 * n || bestArea > 0.97 * n) return null;
    let tl = null, tr = null, br = null, bl = null;
    let mnS = Infinity, mxS = -Infinity, mxD = -Infinity, mnD = Infinity;
    for (let p = 0; p < n; p++) {
      if (label[p] !== bestId) continue;
      const x = p % w, y = (p / w) | 0, s = x + y, d = x - y;
      if (s < mnS) { mnS = s; tl = { x, y }; }
      if (s > mxS) { mxS = s; br = { x, y }; }
      if (d > mxD) { mxD = d; tr = { x, y }; }
      if (d < mnD) { mnD = d; bl = { x, y }; }
    }
    return [tl, tr, br, bl];
  }

  // Greyscale + stretch 2%–98% for a crisp "scanned" look.
  function enhance(rgba) {
    const n = rgba.length / 4, g = new Uint8Array(n), hist = new Array(256).fill(0);
    for (let i = 0; i < n; i++) {
      g[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
      hist[g[i]]++;
    }
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.02) { hi = i; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, Math.min(255, ((g[i] - lo) * 255) / span));
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    }
    return rgba;
  }

  const api = { homography, applyH, outputSize, warp, otsu, detectDocument, enhance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof self !== 'undefined' ? self : this);
