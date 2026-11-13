// Generador de códigos QR (modo bytes, versiones 1–10, niveles L/M/Q/H) sin dependencias, para el QR de verificación de
// los certificados. Sigue la norma ISO/IEC 18004: codificación, Reed–Solomon sobre GF(256), intercalado por bloques,
// colocación en zigzag, elección de máscara por penalización, bits de formato y de versión. Devuelve la matriz de módulos
// y un camino SVG. Cubre hasta 213 bytes (v10-M), de sobra para una URL de verificación.
const EC_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const rawModules = v => {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) {
    const n = Math.floor(v / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (v >= 7) r -= 36;
  }
  return r;
};
const totalCodewords = v => Math.floor(rawModules(v) / 8);
const dataCodewords = (v, ecl) => totalCodewords(v) - EC_PER_BLOCK[ecl][v - 1] * BLOCKS[ecl][v - 1];
// GF(256) con polinomio 0x11D
const gfMul = (a, b) => {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
};
function rsGenerator(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, gen) {
  const r = new Array(gen.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < gen.length; i++) r[i] ^= gfMul(gen[i], f);
  }
  return r;
}
function alignmentPositions(v) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2,
    size = v * 4 + 17,
    step = Math.floor((v * 4 + n * 2 + 1) / (n * 2 - 2)) * 2,
    out = [6];
  for (let i = n - 1, pos = size - 7; i >= 1; i--, pos -= step) out.splice(1, 0, pos);
  return out;
}

export function encodeQR(text, ecl = 'M') {
  if (!EC_PER_BLOCK[ecl]) throw new Error('Nivel de corrección no válido.');
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const bits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCodewords(v, ecl) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('Texto demasiado largo para un QR de hasta versión 10.');
  // --- bits de datos
  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(4, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version, ecl) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  // --- Reed–Solomon e intercalado
  const numBlocks = BLOCKS[ecl][version - 1],
    ecLen = EC_PER_BLOCK[ecl][version - 1],
    total = totalCodewords(version),
    numShort = numBlocks - (total % numBlocks),
    shortLen = Math.floor(total / numBlocks) - ecLen,
    gen = rsGenerator(ecLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen + (i < numShort ? 0 : 1),
      d = data.slice(k, k + len);
    k += len;
    const ec = rsRemainder(d, gen);
    if (i < numShort) d.push(null);
    blocks.push([...d, ...ec]);
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++)
    for (let j = 0; j < blocks.length; j++) {
      if (i === shortLen && j < numShort) continue;
      all.push(blocks[j][i]);
    }
  // --- matriz y patrones de función
  const size = version * 4 + 17,
    m = Array.from({ length: size }, () => new Array(size).fill(false)),
    fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    m[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (x, y) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(xx, yy, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const ap = alignmentPositions(version);
  for (let i = 0; i < ap.length; i++)
    for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) set(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const drawFormat = mask => {
    const d = (ECL_BITS[ecl] << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412,
      bit = i => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = ((vb >>> i) & 1) === 1,
        a = size - 11 + (i % 3),
        c = Math.floor(i / 3);
      set(a, c, b);
      set(c, a, b);
    }
  }
  // --- colocación de datos en zigzag
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j,
          upward = ((right + 1) & 2) === 0,
          y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < all.length * 8) {
          m[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
  }
  // --- máscara con menor penalización
  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const apply = mask => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[mask](x, y)) m[y][x] = !m[y][x];
  };
  let best = -1,
    bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask);
    drawFormat(mask);
    const s = penalty(m, size);
    if (s < bestScore) {
      bestScore = s;
      best = mask;
    }
    apply(mask);
  }
  apply(best);
  drawFormat(best);
  return { version, ecl, mask: best, size, modules: m };
}
function penalty(m, size) {
  let score = 0;
  const runs = line => {
    let s = 0;
    for (let i = 0; i < size;) {
      let j = i;
      while (j < size && line[j] === line[i]) j++;
      const run = j - i;
      if (run >= 5) s += 3 + run - 5;
      i = j;
    }
    return s;
  };
  const finderLike = line => {
    let s = 0;
    const pat = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= size; i++) {
      let ok = true;
      for (let k = 0; k < 7; k++)
        if (line[i + k] !== pat[k]) {
          ok = false;
          break;
        }
      if (!ok) continue;
      const before = i >= 4 && !line[i - 1] && !line[i - 2] && !line[i - 3] && !line[i - 4],
        after = i + 11 <= size && !line[i + 7] && !line[i + 8] && !line[i + 9] && !line[i + 10];
      if (before || after) s += 40;
    }
    return s;
  };
  for (let y = 0; y < size; y++) {
    score += runs(m[y]) + finderLike(m[y]);
    const col = m.map(r => r[y]);
    score += runs(col) + finderLike(col);
  }
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size,
    k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += k * 10;
  return score;
}
// Camino SVG (un rectángulo por módulo, con margen silencioso de 4 módulos).
export function qrSvgPath(qr, scale = 4, quiet = 4) {
  const parts = [];
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.modules[y][x]) parts.push(`M${(x + quiet) * scale} ${(y + quiet) * scale}h${scale}v${scale}h-${scale}z`);
  return { path: parts.join(''), side: (qr.size + quiet * 2) * scale };
}
export function qrSvg(text, { scale = 4, ecl = 'M' } = {}) {
  const qr = encodeQR(text, ecl),
    { path, side } = qrSvgPath(qr, scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
