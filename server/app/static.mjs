// Archivos estáticos. Se sirve cualquier archivo de public/ (también en subcarpetas, como public/kit/ y
// public/screens/) que cumpla TODAS estas condiciones; lo demás responde 404:
//   - ruta en minúsculas, sin «..», sin «%» y sin barras dobles;
//   - primer segmento fuera de la lista de exclusión (los flyers se sirven con sesión por la API);
//   - extensión de la lista de tipos;
//   - el archivo real sigue dentro de public/ (un enlace simbólico no puede sacar de la carpeta).
// Una ruta sin punto es la portada (la aplicación resuelve la pantalla en el navegador).
//
// Caché: `no-cache` + ETag. El navegador pregunta siempre antes de usar su copia y recibe 304 si no cambió, así
// que tras un despliegue la primera carga ya trae el código nuevo. El service worker se queda en `no-store`.
//
// Paquete (docs/PLAN_ATENDER_COMO_WHATSAPP.md, «Velocidad»): la portada cargaba 42 archivos de JavaScript y 13 hojas de
// estilo, cada uno con su ida y vuelta al servidor. Ahora se arman UNA hoja de CSS y el JavaScript en tramos (uno por
// cada seguidilla de scripts clásicos; un módulo ES los parte y se queda en su sitio) a partir de las etiquetas de index.html (que sigue siendo la lista de verdad y funciona igual sin paquete), con el hash de su contenido
// en el nombre (/paquete/app.<hash>.js, /paquete/estilos.<hash>.css), caché larga e inmutable y gzip ya calculado: tras
// un despliegue cambia el nombre, nunca el contenido de un nombre. Los módulos ES (kit/boot.js) y lo que cargan las
// pantallas nuevas siguen aparte. En desarrollo se rearma solo cuando cambia algún archivo.
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};
const SHAPE = /^\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const EXCLUDED = new Set(['flyers', 'index.html']);
const NO_STORE = new Set(['/sw.js']);
// Únicas rutas con nombre propio: lo que se sirve desde fuera de public/.
const VENDOR = { '/vendor/lucide.js': 'node_modules/lucide/dist/umd/lucide.min.js' };

// Fuera de /crm la portada es la experiencia del cliente: al instalarla, la app abre el chat de prueba y no el CRM del equipo.
const customerHome = html =>
  html
    .replace('href="/manifest.webmanifest"', 'href="/manifest-cliente.webmanifest"')
    .replace(
      'name="apple-mobile-web-app-title" content="TEC Capital"',
      'name="apple-mobile-web-app-title" content="Chat de prueba"',
    );

const etagOf = bytes => '"' + createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '"';

// If-None-Match puede traer varias etiquetas, con o sin el prefijo de validador débil.
function matches(header, etag) {
  if (!header) return false;
  return header
    .split(',')
    .map(value => value.trim().replace(/^W\//, ''))
    .some(value => value === etag || value === '*');
}

const STYLE_TAG = /^[ \t]*<link rel="stylesheet" href="\/([a-z0-9._/-]+\.css)">[ \t]*\r?\n/gm;
// Los clásicos (`defer`) se empaquetan; un módulo (`type="module"`, también diferido) parte el paquete en tramos para que
// todo corra en el mismo orden que en la portada: public/app.js va después de kit/boot.js y lo necesita así.
const SCRIPT_TAG = /^[ \t]*<script (defer|type="module") src="\/([a-z0-9._/-]+\.js)"><\/script>[ \t]*\r?\n/gm;
const IMPORT_RULE = /^[ \t]*@import\b.*;[ \t]*$\r?\n?/gm; // la línea entera: la URL de una fuente lleva «;» dentro
const IMMUTABLE = 'public, max-age=31536000, immutable';

// `generated`: contenido que no es un archivo y se sirve con las mismas reglas de caché, por ruta exacta
// ({ '/screens/index.json': { bytes, type } }). `bundle`: armar el paquete de la portada (encendido por omisión).
export function createStatic({ root, fail, generated = {}, bundle = true }) {
  const publicDir = resolve(root, 'public');
  const cache = new Map();
  const virtual = new Map(
    Object.entries(generated).map(([path, { bytes, type }]) => [path, { bytes, type, etag: etagOf(bytes) }]),
  );
  // Paquetes servidos, por ruta con hash; se conservan los últimos (una pestaña abierta con la portada anterior sigue
  // encontrando el suyo hasta recargar).
  const packs = new Map();
  let pack = null; // { signature, css: path, js: [path por tramo de scripts clásicos] }
  let publicReal = null;

  const partPath = name => (VENDOR['/' + name] ? resolve(root, VENDOR['/' + name]) : resolve(publicDir, name));
  // Arma (o reutiliza) el paquete para esta portada y devuelve la portada reescrita. Si algo falla, la portada sale como está.
  async function packaged(html) {
    const styles = [...html.matchAll(STYLE_TAG)].map(m => m[1]);
    // tramos: scripts clásicos seguidos; un módulo cierra el tramo y queda donde estaba
    const runs = [];
    for (const m of html.matchAll(SCRIPT_TAG)) {
      if (m[1] !== 'defer') runs.push(null);
      else if (runs.at(-1)) runs.at(-1).push(m[2]);
      else runs.push([m[2]]);
    }
    const groups = runs.filter(Boolean),
      scripts = groups.flat();
    if (!styles.length && !scripts.length) return html;
    const parts = [...styles, ...scripts].map(partPath);
    const infos = await Promise.all(parts.map(file => stat(file)));
    const signature = infos.map(i => i.mtimeMs + ':' + i.size).join('|');
    if (pack?.signature !== signature) {
      const read = async names =>
        (await Promise.all(names.map(n => readFile(partPath(n), 'utf8')))).map(t => t.trimEnd());
      const cssParts = await read(styles),
        jsParts = await read(scripts);
      // `@import` sólo vale al principio de una hoja: los de cada parte van primero, en su orden.
      const imports = [];
      const css = cssParts
        .map(
          (t, i) =>
            '/* ---- ' + styles[i] + ' ---- */\n' + t.replace(IMPORT_RULE, rule => (imports.push(rule.trim()), '')),
        )
        .join('\n\n');
      const text = new Map(scripts.map((n, i) => [n, jsParts[i]]));
      const make = (content, type) => {
        const bytes = Buffer.from(content, 'utf8');
        return { bytes, gzip: gzipSync(bytes, { level: 9 }), type, etag: etagOf(bytes), immutable: true };
      };
      const cssEntry = styles.length ? make([...imports, ''].join('\n') + css + '\n', TYPES['.css']) : null;
      const jsEntries = groups.map(names =>
        make(names.map(n => '// ---- ' + n + ' ----\n' + text.get(n)).join('\n;\n') + '\n', TYPES['.js']),
      );
      const next = {
        signature,
        css: cssEntry ? '/paquete/estilos.' + cssEntry.etag.slice(1, 17) + '.css' : null,
        js: jsEntries.map(e => '/paquete/app.' + e.etag.slice(1, 17) + '.js'),
      };
      if (cssEntry) packs.set(next.css, cssEntry);
      next.js.forEach((path, i) => packs.set(path, jsEntries[i]));
      for (const key of [...packs.keys()].slice(0, -12)) packs.delete(key); // los últimos tres o cuatro juegos
      pack = next;
    }
    let first = true;
    let out = html.replace(STYLE_TAG, m => {
      if (!first || !pack.css) return '';
      first = false;
      return m.replace(/href="[^"]+"/, 'href="' + pack.css + '"');
    });
    // cada tramo de clásicos se vuelve una etiqueta (la primera del tramo); los módulos se quedan como están
    let group = -1,
      inRun = false;
    out = out.replace(SCRIPT_TAG, m => {
      if (!m.startsWith('<script defer') && !/^[ \t]*<script defer/.test(m)) {
        inRun = false;
        return m;
      }
      if (inRun) return '';
      inRun = true;
      group++;
      return m.replace(/src="[^"]+"/, 'src="' + pack.js[group] + '"');
    });
    return out;
  }

  // Contenido y etiqueta de un archivo, releídos sólo si cambió en disco (también sirve mientras se desarrolla).
  async function load(file, variant = '') {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const home = variant !== null;
    let text = null,
      packKey = '';
    if (home && bundle) {
      // la portada depende también de sus partes: se vuelve a armar si cambió cualquiera
      text = await packaged((await readFile(file)).toString('utf8')).catch(() => null);
      packKey = pack?.signature || '';
    }
    const key = file + '|' + variant + '|' + packKey;
    const known = cache.get(key);
    if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return known;
    let bytes = text === null ? await readFile(file) : Buffer.from(text, 'utf8');
    if (variant === 'customer') bytes = Buffer.from(customerHome(bytes.toString('utf8')), 'utf8');
    const entry = { mtimeMs: info.mtimeMs, size: info.size, bytes, etag: etagOf(bytes) };
    cache.set(key, entry);
    return entry;
  }

  async function locate(path) {
    if (VENDOR[path]) return { file: resolve(root, VENDOR[path]), type: TYPES['.js'] };
    if (!path.includes('.'))
      return {
        file: resolve(publicDir, 'index.html'),
        type: 'text/html; charset=utf-8',
        variant: path.startsWith('/crm') ? '' : 'customer',
      };
    if (path.startsWith('/paquete/')) return null; // sólo los paquetes armados aquí, nunca un archivo de esa carpeta
    const type = TYPES[extname(path)];
    if (!type || !SHAPE.test(path) || EXCLUDED.has(path.split('/')[1])) return null;
    const file = resolve(publicDir, '.' + path);
    try {
      publicReal ??= await realpath(publicDir);
      const real = await realpath(file);
      if (!real.startsWith(publicReal + sep)) return null;
    } catch {
      return null;
    }
    return { file, type };
  }

  // Atiende GET y HEAD (el método ya viene comprobado). Lanza 404 si la ruta no corresponde a nada que se pueda servir.
  async function serve(req, res, path) {
    const made = virtual.get(path) ?? packs.get(path);
    const found = made ?? (await locate(path));
    const entry = made ?? (found ? await load(found.file, found.variant ?? null).catch(() => null) : null);
    if (!entry) throw fail(404, 'No encontrado.');
    if (NO_STORE.has(path)) res.setHeader('Cache-Control', 'no-store');
    else {
      res.setHeader('Cache-Control', entry.immutable ? IMMUTABLE : 'no-cache');
      res.setHeader('ETag', entry.etag);
      if (matches(req.headers['if-none-match'], entry.etag)) {
        res.writeHead(304);
        res.end();
        return;
      }
    }
    const gzip = entry.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const bytes = gzip ? entry.gzip : entry.bytes;
    res.writeHead(200, {
      'Content-Type': found.type,
      'Content-Length': bytes.length,
      ...(entry.gzip ? { Vary: 'Accept-Encoding' } : {}),
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  return { serve, pack: () => pack };
}
