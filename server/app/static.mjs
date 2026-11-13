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
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

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

// `generated`: contenido que no es un archivo y se sirve con las mismas reglas de caché, por ruta exacta
// ({ '/screens/index.json': { bytes, type } }).
export function createStatic({ root, fail, generated = {} }) {
  const publicDir = resolve(root, 'public');
  const cache = new Map();
  const virtual = new Map(
    Object.entries(generated).map(([path, { bytes, type }]) => [path, { bytes, type, etag: etagOf(bytes) }]),
  );
  let publicReal = null;

  // Contenido y etiqueta de un archivo, releídos sólo si cambió en disco (también sirve mientras se desarrolla).
  async function load(file, variant = '') {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const key = file + '|' + variant;
    const known = cache.get(key);
    if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return known;
    let bytes = await readFile(file);
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
    const made = virtual.get(path);
    const found = made ?? (await locate(path));
    const entry = made ?? (found ? await load(found.file, found.variant).catch(() => null) : null);
    if (!entry) throw fail(404, 'No encontrado.');
    if (NO_STORE.has(path)) res.setHeader('Cache-Control', 'no-store');
    else {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('ETag', entry.etag);
      if (matches(req.headers['if-none-match'], entry.etag)) {
        res.writeHead(304);
        res.end();
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': found.type, 'Content-Length': entry.bytes.length });
    res.end(req.method === 'HEAD' ? undefined : entry.bytes);
  }

  return { serve };
}
