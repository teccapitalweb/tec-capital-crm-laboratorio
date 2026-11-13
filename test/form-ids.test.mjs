import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Los módulos reclaman los formularios por prefijo de id (operations.js y crm.js). Un formulario de app.js cuyo id empiece
// con uno de esos prefijos lo recibe el módulo equivocado y no hace nada (así se rompió «Cobrar»: pay-link-form empezaba con pay-).
test('ningún formulario de app.js usa un prefijo que un módulo reclama', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const claimed = new Set();
  for (const file of ['operations.js', 'crm.js', 'catalogue.js']) {
    const src = readFileSync(new URL('../public/' + file, import.meta.url), 'utf8');
    // Tolera espacios, saltos de línea, comillas dobles y «?.»: el formato automático no debe hacer que se pierdan prefijos en silencio.
    for (const m of src.matchAll(
      /(?:id\s*\??\.\s*startsWith|getAttribute\(\s*['"]id['"]\s*\)\s*\??\.\s*startsWith)\(\s*['"]([a-z]+-)['"]\s*\)/g,
    ))
      claimed.add(m[1]);
  }
  assert.ok(
    claimed.has('pay-') && claimed.has('co-') && claimed.has('ct-') && claimed.size >= 19,
    'no se pudieron leer los prefijos de los módulos: ' + [...claimed].join(' '),
  );
  const ids = [...app.matchAll(/<form id="([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(ids.includes('order-link-form'), 'el formulario de Cobrar debe existir');
  for (const id of ids)
    for (const prefix of claimed)
      assert.ok(!id.startsWith(prefix), `El formulario «${id}» empieza con «${prefix}», que reclama otro módulo`);
});
