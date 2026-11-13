// Uso: node scripts/tools/ast-equal.mjs <ref de Git> "<glob>" [más globs]
// Compara el árbol sintáctico de cada archivo en <ref> con el de la copia de trabajo, ignorando posiciones,
// comentarios y la grafía de los literales. Sirve para demostrar que un cambio de formato o un traslado no altera el programa.
import { execFileSync } from 'node:child_process';
import { readFileSync, globSync } from 'node:fs';
import * as espree from 'espree';

const [ref, ...globs] = process.argv.slice(2);
if (!ref || !globs.length) {
  console.error('Uso: node scripts/tools/ast-equal.mjs <ref de Git> "<glob>" [más globs]');
  process.exit(2);
}

// Los guiones clásicos de public/ (sin import) se analizan como guion; lo demás, como módulo.
const clasico = file => /^public\/[^/]+\.js$/.test(file);
const parse = (code, file) =>
  espree.parse(code, { ecmaVersion: 'latest', sourceType: clasico(file) ? 'script' : 'module' });
const IGNORAR = new Set(['start', 'end', 'loc', 'range', 'raw']);
const limpiar = node =>
  Array.isArray(node)
    ? node.map(limpiar)
    : typeof node === 'bigint'
      ? node.toString() + 'n'
      : node instanceof RegExp
        ? null // el patrón y las banderas ya están en node.regex
        : node && typeof node === 'object'
          ? Object.fromEntries(
              Object.entries(node)
                .filter(([key]) => !IGNORAR.has(key))
                .map(([key, value]) => [key, limpiar(value)]),
            )
          : node;

let distintos = 0;
let total = 0;
const files = globs
  .flatMap(glob => globSync(glob))
  .map(file => file.replaceAll('\\', '/'))
  .sort();
for (const file of files) {
  total++;
  let antes;
  try {
    antes = execFileSync('git', ['show', `${ref}:${file}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    console.log('nuevo (sin comparar):', file);
    continue;
  }
  const a = JSON.stringify(limpiar(parse(new TextDecoder('utf-8').decode(antes), file)));
  const b = JSON.stringify(limpiar(parse(readFileSync(file, 'utf8'), file)));
  if (a !== b) {
    distintos++;
    console.error('DISTINTO:', file);
  }
}
console.log(`${total} archivos, ${distintos} con el árbol distinto`);
process.exit(distintos ? 1 : 0);
