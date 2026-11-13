// Puerta de codificación: todo archivo de texto del repositorio es UTF-8 válido, con finales LF y sin caracteres invisibles.
// La llama `npm run check`. Revisa lo que Git sigue y lo nuevo que no está ignorado, así no toca `.env`, `data/` ni `node_modules/`.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|woff2|sqlite)$/i;
const CODE = /(\.(mjs|js|css|html|json|yml|sql|webmanifest)|(^|\/)Dockerfile)$/i;
const BOM_ALLOWED = /^docs\/ejemplos\/[^/]+\.csv$/;
const chr = code => String.fromCharCode(code);
const FFFD = chr(0xfffd);
const FEFF = chr(0xfeff);
const INVISIBLE = new RegExp('[' + chr(0xa0) + chr(0x200b) + '-' + chr(0x200f) + chr(0x2028) + chr(0x2029) + ']');

// Devuelve la lista de problemas de un archivo de texto; vacía si está bien.
export function problems(path, bytes) {
  const found = [];
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return ['no es UTF-8 válido'];
  }
  if (!text.length) return found;
  for (const byte of bytes) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      found.push('contiene un byte de control (0x' + byte.toString(16).padStart(2, '0') + ')');
      break;
    }
  }
  if (text.includes('\r')) found.push('tiene finales de línea CRLF o un retorno de carro suelto');
  if (text.includes(FFFD)) found.push('contiene U+FFFD (texto dañado por una conversión)');
  const body = BOM_ALLOWED.test(path) && text.startsWith(FEFF) ? text.slice(1) : text;
  if (body.includes(FEFF)) found.push('contiene U+FEFF literal (escríbelo como \\uFEFF)');
  if (CODE.test(path) && INVISIBLE.test(text))
    found.push('contiene un espacio o separador invisible (U+00A0, U+200B a U+200F, U+2028 o U+2029)');
  if (!text.endsWith('\n')) found.push('no termina en salto de línea');
  return found;
}

export function listFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter(path => !BINARY.test(path))
    .sort();
}

export function run(root) {
  const failures = [];
  const files = listFiles(root);
  for (const path of files) {
    let bytes;
    try {
      bytes = readFileSync(join(root, path));
    } catch {
      continue; // borrado en la copia de trabajo y aún en el índice
    }
    for (const problem of problems(path, bytes)) failures.push(path + ': ' + problem);
  }
  return { files: files.length, failures };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { files, failures } = run(root);
  if (failures.length) {
    console.error(
      'Codificación: ' +
        failures.length +
        ' problema(s) en ' +
        files +
        ' archivos de texto:\n  ' +
        failures.join('\n  '),
    );
    process.exit(1);
  }
  console.log('Codificación: ' + files + ' archivos de texto en UTF-8 y LF.');
}
