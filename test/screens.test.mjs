import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadScreens, validateScreen, LEGACY_VIEWS } from '../server/app/screens.mjs';

async function project(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'crm-screens-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
const screen = (id, extra = {}) => ({
  id,
  title: 'Pantalla ' + id,
  nav: { group: 'Gestión', icon: 'megaphone', order: 40 },
  roles: ['agent', 'admin'],
  entry: 'index.js',
  ...extra,
});

test('registro de pantallas: lee cada carpeta, normaliza, ordena por el menú y sólo publica las que tocan', async t => {
  const root = await project(t, {
    'public/screens/difusiones/screen.json': screen('difusiones', { visibility: 'live', styles: ['screen.css'] }),
    'public/screens/difusiones/index.js': '',
    'public/screens/difusiones/screen.css': '',
    'public/screens/plantillas/screen.json': screen('plantillas', {
      nav: { group: 'Gestión', icon: 'file-text', label: 'Plantillas WA', order: 10 },
    }),
    'public/screens/plantillas/index.js': '',
    'public/screens/detalle/screen.json': screen('detalle', { nav: undefined, visibility: 'live', roles: ['admin'] }),
    'public/screens/detalle/index.js': '',
    // una carpeta sin screen.json todavía no es una pantalla (por ejemplo, piezas que otra pantalla usará)
    'public/screens/automatizacion/lienzo/canvas.js': '',
  });
  const production = loadScreens({ root });
  assert.deepEqual(
    production.all.map(s => s.id),
    ['detalle', 'difusiones', 'plantillas'],
  );
  assert.deepEqual(
    production.visible.map(s => s.id),
    ['difusiones', 'detalle'],
    'sin vista previa sólo salen las publicadas; las que no van en el menú, al final',
  );
  assert.deepEqual(production.errors, []);
  assert.deepEqual(JSON.parse(production.bytes.toString('utf8')), { screens: production.visible });
  assert.deepEqual(production.visible[0], {
    id: 'difusiones',
    title: 'Pantalla difusiones',
    visibility: 'live',
    nav: { group: 'Gestión', icon: 'megaphone', label: 'Pantalla difusiones', order: 40 },
    roles: ['admin', 'agent'],
    permission: null,
    entry: 'index.js',
    styles: ['screen.css'],
  });
  assert.equal(production.visible[1].nav, null);
  const preview = loadScreens({ root, preview: true });
  assert.deepEqual(
    preview.visible.map(s => s.id),
    ['plantillas', 'difusiones', 'detalle'],
  );
  assert.equal(preview.visible[0].visibility, 'preview', 'sin indicarlo, una pantalla nace en vista previa');
  assert.equal(preview.visible[0].nav.label, 'Plantillas WA');
  // sin carpeta de pantallas no pasa nada
  const empty = loadScreens({ root: await project(t, { 'public/app.js': '' }) });
  assert.deepEqual([empty.all, empty.errors, empty.bytes.toString()], [[], [], '{"screens":[]}']);
});

test('una pantalla mal declarada dice qué está mal; el servidor la omite y las pruebas la rechazan', async t => {
  const dir = await project(t, { 'index.js': '', 'screen.css': '' });
  const check = (raw, pattern, folder = 'nueva') => assert.throws(() => validateScreen(raw, folder, dir), pattern);
  check(null, /debe ser un objeto/);
  check(screen('otra'), /igual al nombre de la carpeta/);
  check(screen('ab'), /de 3 a 31 caracteres/, 'ab');
  check(screen('Nueva'), /de 3 a 31 caracteres/, 'Nueva');
  for (const view of LEGACY_VIEWS) check(screen(view), /ya es una vista de la interfaz actual/, view);
  check(screen('nueva', { title: '' }), /«title» es obligatorio/);
  check(screen('nueva', { visibility: 'publica' }), /«visibility»/);
  check(screen('nueva', { roles: [] }), /«roles»/);
  check(screen('nueva', { roles: ['customer'] }), /«roles»/);
  check(screen('nueva', { permission: 'Ver Todo' }), /«permission»/);
  check(screen('nueva', { entry: '../app.js' }), /«entry»/);
  check(screen('nueva', { entry: 'falta.js' }), /no existe el archivo falta\.js/);
  check(screen('nueva', { styles: ['../styles.css'] }), /«styles»/);
  check(screen('nueva', { styles: ['falta.css'] }), /no existe el archivo falta\.css/);
  check(screen('nueva', { nav: { icon: 'x', order: 1 } }), /«nav\.group»/);
  check(screen('nueva', { nav: { group: 'Gestión', icon: '<svg>', order: 1 } }), /«nav\.icon»/);
  check(screen('nueva', { nav: { group: 'Gestión', icon: 'x', order: 'primero' } }), /«nav\.order»/);
  const valid = validateScreen(
    screen('nueva', { styles: ['screen.css'], permission: 'broadcasts.view' }),
    'nueva',
    dir,
  );
  assert.deepEqual([valid.id, valid.permission], ['nueva', 'broadcasts.view']);

  const root = await project(t, {
    'public/screens/buena/screen.json': screen('buena', { visibility: 'live' }),
    'public/screens/buena/index.js': '',
    'public/screens/rota/screen.json': '{ esto no es JSON',
    'public/screens/sin-entrada/screen.json': screen('sin-entrada'),
  });
  const lenient = loadScreens({ root, preview: true });
  assert.deepEqual(
    lenient.visible.map(s => s.id),
    ['buena'],
  );
  assert.equal(lenient.errors.length, 2);
  assert.match(lenient.errors.join('\n'), /rota\/screen\.json: no es JSON válido/);
  assert.match(lenient.errors.join('\n'), /sin-entrada\/screen\.json: no existe el archivo index\.js/);
  assert.throws(() => loadScreens({ root, preview: true, strict: true }), /screen\.json/);
});

test('las pantallas del repositorio están bien declaradas', () => {
  const real = loadScreens({ root: '.', preview: true, strict: true });
  assert.deepEqual(real.errors, []);
  assert.equal(new Set(real.all.map(s => s.id)).size, real.all.length);
});
