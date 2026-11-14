// Subida única de archivos (conciliación técnica, filas 44 y 45): recepción, comprobación, almacenamiento y entrega
// de un archivo que sube el equipo. La usan las plantillas de WhatsApp (muestra del encabezado) y la ampliarán la
// biblioteca y el adjunto del chat.
//
//   const file = receive(input.file, { allow: ['image', 'document'], purpose: 'templateHeader' });
//   const name = await store(dataDir, { area: 'library', brandId }, file);   // → 'globalvet/<uuid>.png'
//   await serve(res, { path: storedPath(dataDir, 'library', name), mime, filename });   // el permiso lo decide quien llama
//
// Reglas:
//   - Tipo REAL por la firma del archivo (server/lib/media-sniff.mjs). Si el tipo declarado o la extensión del nombre
//     no coinciden con el contenido, se rechaza: un «.png» que por dentro es un PDF no pasa.
//   - Tamaño por clase y por uso (server/lib/media-limits.mjs).
//   - Nombre seguro: sin carpetas ni caracteres de control, recortado y con la extensión del tipo real. En el disco el
//     archivo lleva un nombre al azar dentro de la carpeta de su marca.
//   - Sin base de datos ni red: quien llama registra el archivo en su tabla.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fail } from '../app/http.mjs';
import { extensionOf, sniff } from './media-sniff.mjs';
import { limitFor, sizeLabel } from './media-limits.mjs';

const BRAND = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AREA = /^[a-z][a-z0-9-]{1,30}$/;
const KIND_LABEL = { image: 'imagen', document: 'documento PDF', video: 'video', audio: 'audio' };
// Tipos que un navegador puede declarar como sinónimo del real.
const ALIASES = { 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'application/x-pdf': 'application/pdf' };

// Nombre de archivo para mostrar y para la descarga: sin carpetas ni caracteres de control, con la extensión real.
export function safeName(name, ext) {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const stem =
    base
      .replace(/\.[A-Za-z0-9]{1,8}$/, '')
      .slice(0, 100)
      .trim() || 'archivo';
  return `${stem}.${ext}`;
}

// Recibe `{name, type, base64}` (lo que manda la interfaz) y devuelve el archivo comprobado:
// `{buffer, mime, ext, kind, filename, size}`. `allow` lista las clases admitidas; `mimes`, si se da, acota los tipos.
export function receive(input, { allow = ['image', 'document'], mimes = null, purpose, channel } = {}) {
  if (!input || typeof input !== 'object' || typeof input.base64 !== 'string' || !input.base64)
    throw fail(400, 'Elige un archivo.', { code: 'upload_missing' });
  const largest = Math.max(...allow.map(kind => limitFor(kind, { purpose, channel })));
  // base64 ocupa 4/3 del archivo: se rechaza antes de decodificar lo que de seguro excede el límite
  if (input.base64.length > Math.ceil((largest * 4) / 3) + 8)
    throw fail(413, `El archivo es demasiado grande: máximo ${sizeLabel(largest)}.`, {
      code: 'upload_too_large',
      details: { limit: largest },
    });
  const buffer = Buffer.from(input.base64, 'base64');
  if (!buffer.length) throw fail(400, 'El archivo está vacío.', { code: 'upload_empty' });
  const real = sniff(buffer);
  if (!real || !allow.includes(real.kind) || (mimes && !mimes.includes(real.mime)))
    throw fail(
      400,
      `Ese archivo no es de un formato admitido: sube ${allow.map(kind => KIND_LABEL[kind] ?? kind).join(' o ')}` +
        (mimes ? ` (${mimes.map(extensionOf).join(', ')}).` : '.'),
      { code: 'upload_type_not_allowed' },
    );
  const declared = String(input.type ?? '')
    .toLowerCase()
    .trim();
  const nameExt = /\.([A-Za-z0-9]{1,8})$/.exec(String(input.name ?? ''))?.[1]?.toLowerCase();
  const extOk = !nameExt || nameExt === real.ext || (real.ext === 'jpg' && nameExt === 'jpeg');
  if ((declared && (ALIASES[declared] ?? declared) !== real.mime) || !extOk)
    throw fail(
      400,
      'El contenido del archivo no coincide con su formato: revisa que no le hayan cambiado la extensión.',
      { code: 'upload_type_mismatch' },
    );
  const limit = limitFor(real.kind, { purpose, channel });
  if (buffer.length > limit)
    throw fail(413, `El archivo es demasiado grande: máximo ${sizeLabel(limit)} para un ${KIND_LABEL[real.kind]}.`, {
      code: 'upload_too_large',
      details: { limit },
    });
  return {
    buffer,
    mime: real.mime,
    ext: real.ext,
    kind: real.kind,
    filename: safeName(input.name, real.ext),
    size: buffer.length,
  };
}

// Ruta absoluta de un archivo guardado, comprobando que no salga de la carpeta del área.
export function storedPath(dataDir, area, storageName) {
  if (!AREA.test(area)) throw new TypeError('Área de archivos no válida.');
  const root = resolve(dataDir, area);
  const path = resolve(root, String(storageName ?? ''));
  if (!path.startsWith(root + sep)) throw fail(404, 'Archivo no disponible.', { code: 'not_found' });
  return path;
}

// Guarda el archivo en DATA_DIR/<área>/<marca>/<uuid>.<ext> sin pisar nada y sólo legible por su dueño. Devuelve el
// nombre relativo al área: es lo que se anota en la tabla de quien llama.
export async function store(dataDir, { area, brandId }, file) {
  if (!BRAND.test(String(brandId ?? ''))) throw fail(400, 'Marca no válida.', { code: 'invalid_brand' });
  const storageName = `${brandId}/${randomUUID()}.${file.ext}`;
  const path = storedPath(dataDir, area, storageName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, file.buffer, { flag: 'wx', mode: 0o600 });
  return storageName;
}

// Quita un archivo guardado (por ejemplo, si falló su registro en la base). No falla si ya no existe.
export const discard = (dataDir, area, storageName) => unlink(storedPath(dataDir, area, storageName)).catch(() => {});

// Lee un archivo guardado (para enviarlo a un proveedor).
export const load = (dataDir, area, storageName) => readFile(storedPath(dataDir, area, storageName));

// Entrega un archivo a quien ya tiene permiso (lo comprueba quien llama). Una imagen se muestra; un documento se
// descarga. El navegador no adivina el tipo y el archivo no puede ejecutar nada en el origen del CRM.
export async function serve(res, { path, mime, filename }) {
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) throw fail(404, 'Archivo no disponible.', { code: 'not_found' });
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': bytes.length,
    'Content-Disposition': `${mime.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  });
  res.end(bytes);
}
