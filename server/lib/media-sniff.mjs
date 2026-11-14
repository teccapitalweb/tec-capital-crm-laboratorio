// Tipo real de un archivo por su firma (los primeros bytes), no por su nombre ni por lo que dice el navegador.
//
// Por qué existe: una sola tabla de huellas de formato para toda subida y descarga (conciliación técnica, fila 44):
// la subida única (server/lib/upload.mjs) y, después, el adjunto del chat y la descarga de entrantes. Un archivo cuya
// extensión o tipo declarado no coincide con su contenido se rechaza.
//
//   sniff(buffer) → { mime: 'image/png', ext: 'png', kind: 'image' } o null si no es un formato conocido.

const ascii = (buffer, start, text) =>
  buffer.length >= start + text.length && buffer.toString('latin1', start, start + text.length) === text;
const bytes = (buffer, list) => buffer.length >= list.length && list.every((value, i) => buffer[i] === value);

// De la firma más específica a la más general. Cada formato dice su tipo, su extensión y su clase de medio (la clase
// decide el límite de tamaño en server/lib/media-limits.mjs).
export const FORMATS = Object.freeze([
  {
    mime: 'image/png',
    ext: 'png',
    kind: 'image',
    test: b => bytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: 'image/jpeg', ext: 'jpg', kind: 'image', test: b => bytes(b, [0xff, 0xd8, 0xff]) },
  { mime: 'image/webp', ext: 'webp', kind: 'image', test: b => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP') },
  { mime: 'image/gif', ext: 'gif', kind: 'image', test: b => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a') },
  { mime: 'application/pdf', ext: 'pdf', kind: 'document', test: b => ascii(b, 0, '%PDF-') },
]);

export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  const found = FORMATS.find(format => format.test(buffer));
  return found ? { mime: found.mime, ext: found.ext, kind: found.kind } : null;
}

// Extensión que corresponde a un tipo conocido («image/jpeg» → «jpg»), o null.
export const extensionOf = mime => FORMATS.find(format => format.mime === mime)?.ext ?? null;
