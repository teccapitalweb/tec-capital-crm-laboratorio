import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../public/kit/state.js';
import { ApiError, createApi, isAbort, isStale, mutation, newClientRef, withRevision } from '../public/kit/api.js';
import { formValues, listen } from '../public/kit/events.js';
import { ids, nextId } from '../public/kit/ids.js';
import { createScreens, validScreens } from '../public/kit/screens.js';
import { coerce, field, fieldError, validateFields } from '../public/kit/components/form.js';
import { nextSort, toggleColumn } from '../public/kit/components/table.js';
import { empty, failure, loading, toast } from '../public/kit/components/feedback.js';
import {
  LIMITS,
  conditionProblems,
  defaultRule,
  describeConditions,
  emptyConditions,
  normalizeConditions,
  operatorsOf,
  ruleProblem,
} from '../public/kit/components/conditions.js';
import { h } from './kit-dom.mjs';

// Lo que el kit decide sin pintar: estado, peticiones, reparto de eventos, registro de pantallas y las
// reglas de sus componentes. Lo que necesita un navegador de verdad (foco, <dialog>, estilos) se
// comprueba a mano y con las pruebas de humo de interfaz.

const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// ---------------------------------------------------------------------------------------------------
// state.js
// ---------------------------------------------------------------------------------------------------

test('el almacén avisa una vez por tanda de cambios y sólo si algo cambió', async () => {
  const store = createStore({ q: '', page: 1 });
  const seen = [];
  const off = store.subscribe((state, before) => seen.push([state.q, state.page, before.q, before.page]));

  store.set({ q: 'a' });
  store.set({ q: 'ab' });
  store.set(state => ({ page: state.page + 1 }));
  assert.deepEqual(store.get(), { q: 'ab', page: 2 }, 'el estado cambia en el acto');
  assert.deepEqual(seen, [], 'el aviso espera al final de la tarea');
  await tick();
  assert.deepEqual(seen, [['ab', 2, '', 1]], 'tres cambios, un solo aviso, con el estado anterior a la tanda');

  store.set({ q: 'ab' });
  store.set(() => null);
  store.set(undefined);
  await tick();
  assert.equal(seen.length, 1, 'sin cambio real no hay aviso');

  store.set({ q: 'x' });
  store.set({ q: 'ab' });
  await tick();
  assert.equal(seen.length, 2, 'se compara por referencia: ir y volver sí avisa, una vez');

  assert.throws(() => (store.get().q = 'mutado'), TypeError, 'el estado está congelado');
  off();
  store.set({ q: 'z' });
  store.flush();
  assert.equal(seen.length, 2, 'quien se desuscribe deja de recibir avisos');
});

test('el almacén pinta de inmediato con {now}, sobrevive a un suscriptor roto y se apaga con destroy', async t => {
  t.mock.method(console, 'error', () => {});
  const store = createStore({ n: 0 });
  const seen = [];
  store.subscribe(() => {
    throw new Error('suscriptor roto');
  });
  store.subscribe(state => seen.push(state.n), { now: true });
  assert.deepEqual(seen, [0]);
  store.set({ n: 1 });
  store.flush();
  assert.deepEqual(seen, [0, 1], 'flush() avisa sin esperar');
  assert.equal(console.error.mock.callCount(), 1);
  store.set({ n: 2 });
  store.destroy();
  await tick();
  store.set({ n: 3 });
  await tick();
  assert.deepEqual(seen, [0, 1], 'tras destroy() no hay más avisos ni cambios');
  assert.equal(store.get().n, 2);
});

// ---------------------------------------------------------------------------------------------------
// api.js
// ---------------------------------------------------------------------------------------------------

test('api envía JSON con la cookie del mismo origen y arma la consulta', async () => {
  const calls = [];
  const api = createApi({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return json(200, { ok: true });
    },
  });
  assert.deepEqual(
    await api.get('/api/contacts', {
      brand: 'b1',
      q: 'ana pérez',
      cursor: null,
      empty: '',
      none: undefined,
      columns: ['name', 'phone'],
      filter: { version: 1 },
      limit: 50,
    }),
    { ok: true },
  );
  assert.equal(
    calls[0].url,
    '/api/contacts?brand=b1&q=ana+p%C3%A9rez&columns=name%2Cphone&filter=%7B%22version%22%3A1%7D&limit=50',
  );
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.body, undefined);

  await api.post('/api/contacts?x=1', { name: 'Ana' }, { query: { y: 2 } });
  assert.equal(calls[1].url, '/api/contacts?x=1&y=2');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].init.body, '{"name":"Ana"}');

  await api.patch('/api/x', { a: 1 });
  await api.put('/api/x', { a: 1 });
  await api.delete('/api/x');
  assert.deepEqual(
    calls.slice(2).map(call => call.init.method),
    ['PATCH', 'PUT', 'DELETE'],
  );

  // Un cuerpo que no es un objeto (un CSV) viaja tal cual, sin cabecera de JSON.
  await api.post('/api/contacts/imports', 'Name,Phone\nAna,55', { headers: { 'Content-Type': 'text/csv' } });
  assert.equal(calls[5].init.body, 'Name,Phone\nAna,55');
  assert.equal(calls[5].init.headers['Content-Type'], 'text/csv');
});

test('api convierte {error, code} del servidor en un ApiError con estado y código', async () => {
  const answers = [
    json(409, {
      error: 'Otra persona cambió este registro. Recarga sus datos antes de guardar.',
      code: 'STALE_RECORD',
      contactId: 'c1',
    }),
    json(400, { error: 'Escribe el nombre.' }),
    new Response('<html>Bad gateway</html>', { status: 502 }),
    new Response(null, { status: 204 }),
    json(409, { error: 'Ya existe.', code: 'DUPLICATE' }),
  ];
  const api = createApi({ fetch: async () => answers.shift() });

  const stale = await api.patch('/api/contacts/c1', {}).catch(error => error);
  assert.ok(stale instanceof ApiError && stale instanceof Error);
  assert.deepEqual(
    [stale.name, stale.status, stale.code, stale.message],
    ['ApiError', 409, 'STALE_RECORD', 'Otra persona cambió este registro. Recarga sus datos antes de guardar.'],
  );
  assert.equal(stale.data.contactId, 'c1', 'el cuerpo completo queda a mano');
  assert.equal(isStale(stale), true);

  const invalid = await api.post('/api/contacts', {}).catch(error => error);
  assert.deepEqual(
    [invalid.status, invalid.code, invalid.message, isStale(invalid)],
    [400, '', 'Escribe el nombre.', false],
  );

  const proxy = await api.get('/api/x').catch(error => error);
  assert.deepEqual([proxy.status, proxy.message, proxy.data], [502, 'Ocurrió un error.', null]);

  assert.equal(await api.delete('/api/x'), null, 'un 204 no trae cuerpo');
  assert.equal(
    isStale(await api.post('/api/x', {}).catch(error => error)),
    false,
    'un 409 por duplicado no es un registro viejo',
  );
});

test('api distingue no hay red de petición cancelada', async () => {
  const offline = createApi({
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const failed = await offline.get('/api/x').catch(error => error);
  assert.ok(failed instanceof ApiError);
  assert.deepEqual([failed.status, failed.code, isAbort(failed)], [0, 'NETWORK', false]);
  assert.match(failed.message, /No hay conexión/);

  // Un fetch que respeta la señal, como el de verdad.
  let started = 0;
  const hanging = (_url, init) =>
    new Promise((_resolve, reject) => {
      started++;
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const api = createApi({ fetch: hanging });
  const flight = api.get('/api/lento').catch(error => error);
  await tick();
  api.abort();
  const aborted = await flight;
  assert.equal(isAbort(aborted), true, 'lo que estaba en vuelo se cancela al salir de la pantalla');
  assert.equal(api.signal.aborted, true);
  const later = await api.get('/api/otra').catch(error => error);
  assert.equal(isAbort(later), true);
  assert.equal(started, 1, 'tras abortar ya no se pide nada');

  // Una señal por petición cancela sólo esa.
  const other = createApi({ fetch: hanging });
  const controller = new AbortController();
  const one = other.get('/api/a', null, { signal: controller.signal }).catch(error => error);
  await tick();
  controller.abort();
  assert.equal(isAbort(await one), true);
  assert.equal(other.signal.aborted, false);
});

test('withRevision añade la revisión esperada y no deja editar sin ella', () => {
  assert.deepEqual(withRevision({ name: 'Ana' }, { id: 'c1', revision: 7 }), { name: 'Ana', expectedRevision: 7 });
  assert.deepEqual(withRevision({ name: 'Ana' }, 3), { name: 'Ana', expectedRevision: 3 });
  for (const sin of [undefined, null, {}, { revision: '7' }, NaN])
    assert.throws(() => withRevision({ name: 'Ana' }, sin), TypeError);
});

test('mutation reutiliza el clientRef al reintentar y lo cambia cuando la acción es otra', async () => {
  assert.match(newClientRef(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const sent = [];
  let fail = true;
  const save = mutation(async (clientRef, body) => {
    sent.push([clientRef, body.name]);
    if (fail) throw new ApiError('No hay conexión', { code: 'NETWORK' });
    return { saved: body.name };
  });

  await assert.rejects(save.run({ name: 'Ana' }));
  await assert.rejects(save.run({ name: 'Ana' }));
  assert.equal(sent[0][0], sent[1][0], 'mismo intento, misma referencia: el servidor no lo repite');
  assert.equal(save.clientRef, sent[0][0]);

  await assert.rejects(save.run({ name: 'Ana María' }));
  assert.notEqual(sent[2][0], sent[1][0], 'con otros datos es otra acción');

  fail = false;
  assert.deepEqual(await save.run({ name: 'Ana María' }), { saved: 'Ana María' });
  assert.equal(sent[3][0], sent[2][0]);
  assert.equal(save.clientRef, null, 'confirmada: la siguiente acción lleva otra referencia');
  await save.run({ name: 'Ana María' });
  assert.notEqual(sent[4][0], sent[3][0]);

  // Dos clics seguidos mientras el primero viaja: un solo envío.
  let release;
  let calls = 0;
  const slow = mutation(() => {
    calls++;
    return new Promise(resolve => (release = resolve));
  });
  const [first, second] = [slow.run(1), slow.run(1)];
  assert.equal(first, second);
  assert.equal(slow.pending, true);
  release('hecho');
  assert.equal(await second, 'hecho');
  assert.deepEqual([calls, slow.pending], [1, false]);
});

// ---------------------------------------------------------------------------------------------------
// events.js
// ---------------------------------------------------------------------------------------------------

test('listen reparte por data-do y decide el elemento más cercano al origen', () => {
  const icon = h('span', {});
  const button = h('button', { 'data-do': 'abrir', type: 'button', 'data-id': '7' }, icon);
  const box = h('input', { 'data-do': 'marcar', type: 'checkbox' });
  const row = h('tr', { 'data-do': 'fila' }, h('td', {}, box), h('td', {}, button));
  const plain = h('p', {}, 'sin acción');
  const root = h('section', {}, h('table', {}, row), plain);
  const page = h('body', {}, root);
  const calls = [];
  const outside = [];
  page.addEventListener('click', () => outside.push('click'));
  page.addEventListener('keydown', () => outside.push('keydown'));

  const off = listen(root, {
    click: {
      abrir: (event, element) => calls.push(['abrir', element.getAttribute('data-id'), event.type]),
      fila: () => calls.push(['fila']),
    },
    change: { marcar: () => calls.push(['marcar']) },
  });

  icon.dispatch('click');
  assert.deepEqual(calls, [['abrir', '7', 'click']], 'un clic en el icono de un botón es un clic en el botón');
  // La casilla tiene data-do pero no atiende clics: su fila NO se abre por marcarla.
  box.dispatch('click');
  box.dispatch('change');
  assert.deepEqual(calls.slice(1), [['marcar']]);
  h('td', {}).dispatch('click');
  row.childNodes[0].dispatch('click');
  assert.deepEqual(calls.slice(2), [['fila']], 'una celda sin acción propia pertenece a su fila');
  plain.dispatch('click');
  plain.dispatch('keydown', { key: 'a' });
  assert.equal(calls.length, 3);
  assert.deepEqual(outside, [], 'nada de la pantalla llega a los oyentes de fuera, se atienda o no');

  off();
  icon.dispatch('click');
  assert.equal(calls.length, 3, 'la función devuelta quita los oyentes');
  assert.deepEqual(outside, ['click'], 'y deja de contener');
});

test('listen con contain:false (componentes) no detiene nada', () => {
  const button = h('button', { 'data-do': 'k-mas', type: 'button' });
  const screenButton = h('button', { 'data-do': 'archivar', type: 'button' });
  const component = h('div', {}, button, screenButton);
  const root = h('section', {}, component);
  const calls = [];
  listen(component, { click: { 'k-mas': () => calls.push('componente') } }, { contain: false });
  listen(root, { click: { archivar: () => calls.push('pantalla') } });
  button.dispatch('click');
  screenButton.dispatch('click');
  assert.deepEqual(calls, ['componente', 'pantalla'], 'lo que el componente no atiende sube hasta la pantalla');
});

test('la raíz contiene un evento hasta el final aunque algo de dentro la desmonte a mitad', async () => {
  // El caso real: «Cancelar» de un formulario dentro de una ventana cierra la ventana (y quita su listen)
  // mientras el clic todavía está subiendo.
  const cancel = h('button', { 'data-do': 'k-form-cancel', type: 'button' });
  const form = h('div', {}, cancel);
  const dialog = h('dialog', {}, form);
  const page = h('body', {}, dialog);
  const outside = [];
  page.addEventListener('click', () => outside.push('click'));
  const offDialog = listen(dialog, { click: {} });
  listen(form, { click: { 'k-form-cancel': () => offDialog() } }, { contain: false });

  cancel.dispatch('click');
  assert.deepEqual(outside, [], 'el clic que cerró la ventana no llega a los oyentes de fuera');
  await new Promise(resolve => setTimeout(resolve, 5));
  cancel.dispatch('click');
  assert.deepEqual(outside, ['click'], 'al terminar el evento los oyentes sí se quitan');

  // Fuera de un evento, quitar es inmediato.
  const other = h('section', {}, h('button', { 'data-do': 'x', type: 'button' }));
  const frame = h('body', {}, other);
  frame.addEventListener('click', () => outside.push('otra'));
  listen(other, { click: {} })();
  other.childNodes[0].dispatch('click');
  assert.deepEqual(outside, ['click', 'otra']);
});

test('listen nunca deja que un formulario navegue ni que se envíe dos veces', async () => {
  const name = { name: 'name', type: 'text', value: ' Ana ', disabled: false };
  const cancel = h('button', { 'data-do': 'cancelar' });
  const send = h('button', { type: 'submit' });
  const form = h('form', { 'data-do': 'guardar' }, cancel, send);
  form.elements = [name, { name: '', type: 'submit', value: '' }];
  const loose = h('form', {});
  loose.elements = [];
  const root = h('section', {}, form, loose);
  const seen = [];
  let finish;
  listen(root, {
    submit: {
      guardar: (event, element, values) => {
        seen.push([element === form, values]);
        return new Promise(resolve => (finish = resolve));
      },
    },
    click: { cancelar: () => seen.push('cancelar') },
  });

  assert.equal(
    loose.dispatch('submit').defaultPrevented,
    true,
    'todo submit lleva preventDefault, tenga o no manejador',
  );
  const first = form.dispatch('submit');
  assert.equal(first.defaultPrevented, true);
  assert.deepEqual(seen, [[true, { name: ' Ana ' }]], 'el manejador recibe los valores del formulario');
  form.dispatch('submit');
  assert.equal(seen.length, 1, 'un segundo envío mientras el primero sigue en curso se ignora');
  finish();
  await tick();
  form.dispatch('submit');
  assert.equal(seen.length, 2, 'al terminar se puede volver a enviar');

  // Un botón con data-do dentro de un formulario no lo envía por accidente; el de enviar sí puede.
  assert.equal(cancel.dispatch('click').defaultPrevented, true);
  assert.equal(seen[2], 'cancelar');
  assert.equal(send.dispatch('click').defaultPrevented, false);
});

test('los errores de un manejador llegan a onError y las peticiones canceladas se ignoran', async () => {
  const errors = [];
  const make = verb => h('button', { 'data-do': verb, type: 'button' });
  const [sync, later, aborted] = [make('rompe'), make('rechaza'), make('aborta')];
  const root = h('section', {}, sync, later, aborted);
  listen(
    root,
    {
      click: {
        rompe: () => {
          throw new Error('ahora');
        },
        rechaza: async () => {
          throw new ApiError('No se pudo guardar.', { status: 500 });
        },
        aborta: async () => {
          throw new DOMException('Cancelada', 'AbortError');
        },
      },
    },
    { onError: error => errors.push(error.message) },
  );
  sync.dispatch('click');
  later.dispatch('click');
  aborted.dispatch('click');
  await tick();
  assert.deepEqual(errors, ['ahora', 'No se pudo guardar.']);
});

test('formValues devuelve formas previsibles', () => {
  const control = (name, type, extra) => ({ name, type, value: '', checked: false, disabled: false, ...extra });
  const form = {
    elements: [
      control('name', 'text', { value: 'Ana' }),
      control('quiet', 'checkbox', { checked: true, value: 'on' }),
      control('tags', 'checkbox', { checked: true, value: 'alumno' }),
      control('tags', 'checkbox', { value: 'beca' }),
      control('tags', 'checkbox', { checked: true, value: 'vip' }),
      control('consent', 'radio', { value: 'in' }),
      control('consent', 'radio', { value: 'out', checked: true }),
      control('channel', 'radio', { value: 'wa' }),
      control('brands', 'select-multiple', { selectedOptions: [{ value: 'b1' }, { value: 'b2' }] }),
      control('file', 'file', { files: [{ name: 'a.csv' }] }),
      control('line', 'text', { value: 'uno' }),
      control('line', 'text', { value: 'dos' }),
      control('skipped', 'text', { value: 'x', disabled: true }),
      control('', 'text', { value: 'sin nombre' }),
      control('go', 'submit', { value: 'Guardar' }),
      control('group', 'fieldset'),
    ],
  };
  assert.deepEqual(formValues(form), {
    name: 'Ana',
    quiet: true,
    tags: ['alumno', 'vip'],
    consent: 'out',
    channel: '',
    brands: ['b1', 'b2'],
    file: [{ name: 'a.csv' }],
    line: ['uno', 'dos'],
  });
});

// ---------------------------------------------------------------------------------------------------
// ids.js y feedback.js
// ---------------------------------------------------------------------------------------------------

test('los ids llevan el prefijo k- y la pantalla, y los estados dicen su papel', t => {
  assert.equal(ids('difusiones')('nombre'), 'k-difusiones-nombre');
  assert.equal(ids('Mi Pantalla')('Campo Raro #1'), 'k-mi-pantalla-campo-raro-1');
  assert.notEqual(nextId('ventana'), nextId('ventana'));
  assert.match(nextId('ventana'), /^k-ventana-\d+$/);

  assert.equal(String(loading()), '<div class="k-state k-state--loading" role="status"><p>Cargando…</p></div>');
  assert.match(
    String(empty({ title: 'Sin <contactos>', text: 'Importa una lista.' })),
    /<p class="k-state__title">Sin &lt;contactos&gt;<\/p>\s*<p>Importa una lista\.<\/p>/,
  );
  const server = String(
    failure({ error: new ApiError('No tienes acceso a esta marca.', { status: 403 }), retry: 'reintentar' }),
  );
  assert.match(server, /role="alert"/);
  assert.match(server, /No tienes acceso a esta marca\./);
  assert.match(server, /<button type="button" class="k-btn" data-do="reintentar">Volver a intentar<\/button>/);
  // De un error que no viene de la API no se enseña el texto técnico.
  const internal = String(failure({ error: new TypeError("Cannot read properties of undefined (reading 'x')") }));
  assert.ok(!internal.includes('Cannot read') && !internal.includes('<button'));

  // Dentro de la aplicación el aviso breve es el de siempre; sin ella (aquí, sin DOM) no falla.
  const said = [];
  t.after(() => delete globalThis.TC);
  toast('sin aplicación');
  globalThis.TC = { host: { toast: message => said.push(message) } };
  toast('Guardado');
  assert.deepEqual(said, ['Guardado']);
});

// ---------------------------------------------------------------------------------------------------
// screens.js
// ---------------------------------------------------------------------------------------------------

/** Raíz de mentira: lo que el registro y render() necesitan de #page. */
function fakeRoot() {
  return {
    innerHTML: '',
    firstChild: null,
    listeners: [],
    replaceChildren() {
      this.innerHTML = '';
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, handler) {
      this.listeners.push([type, handler]);
    },
    removeEventListener(type, handler) {
      this.listeners = this.listeners.filter(([t, fn]) => !(t === type && fn === handler));
    },
  };
}

const descriptor = (id, extra = {}) => ({
  id,
  title: `Pantalla ${id}`,
  visibility: 'live',
  nav: { group: 'Gestión', icon: 'megaphone', label: id, order: 10 },
  roles: ['admin', 'agent'],
  permission: null,
  entry: 'index.js',
  styles: ['screen.css'],
  ...extra,
});

test('validScreens sólo deja pasar descriptores que se pueden montar sin salir de su carpeta', t => {
  t.mock.method(console, 'warn', () => {});
  const list = [
    descriptor('difusiones'),
    descriptor('difusiones'),
    descriptor('Mal'),
    descriptor('ab'),
    descriptor('fuera', { entry: '../app.js' }),
    descriptor('carpeta', { entry: 'lib/index.js' }),
    descriptor('otra-ext', { entry: 'index.mjs' }),
    descriptor('estilos', { styles: ['../../styles.css'] }),
    descriptor('sin-titulo', { title: undefined }),
    descriptor('sin-menu', { nav: null, styles: undefined }),
    null,
    'texto',
  ];
  assert.deepEqual(
    validScreens({ screens: list }).map(screen => screen.id),
    ['difusiones', 'sin-menu'],
  );
  assert.deepEqual(
    validScreens(list).map(screen => screen.id),
    ['difusiones', 'sin-menu'],
    'también acepta la lista suelta',
  );
  assert.deepEqual(validScreens(undefined), []);
  assert.deepEqual(validScreens({ screens: 'no' }), []);
});

test('la lista de pantallas nunca rechaza: si no carga, la aplicación sigue como siempre', async t => {
  t.mock.method(console, 'warn', () => {});
  const broken = createScreens({
    loadIndex: async () => {
      throw new Error('500');
    },
    importScreen: async () => ({}),
  });
  assert.deepEqual(await broken.ready, []);
  assert.equal(broken.get('difusiones'), undefined);
  assert.equal(await broken.mount('difusiones', fakeRoot()), false);
  assert.equal(console.warn.mock.callCount(), 1);

  const screens = createScreens({
    loadIndex: async () => ({
      screens: [
        descriptor('bandeja'),
        descriptor('ajustes', { roles: ['admin'] }),
        descriptor('interna', { nav: null }),
      ],
    }),
    importScreen: async () => ({}),
  });
  assert.deepEqual(
    (await screens.ready).map(screen => screen.id),
    ['bandeja', 'ajustes', 'interna'],
    'en el orden del servidor',
  );
  assert.equal(screens.get('ajustes').title, 'Pantalla ajustes');
  assert.deepEqual(
    screens.list('agent').map(screen => screen.id),
    ['bandeja', 'interna'],
  );
  assert.deepEqual(
    screens.menu('agent').map(screen => screen.id),
    ['bandeja'],
    'sin nav no sale en el menú',
  );
  assert.deepEqual(
    screens.menu('admin').map(screen => screen.id),
    ['bandeja', 'ajustes'],
  );
});

test('una pantalla se monta con su contexto, se desmonta con todo deshecho y recuerda lo guardado', async t => {
  t.after(() => delete globalThis.TC);
  const log = [];
  const views = [];
  let imports = 0;
  let styles = 0;
  const module = {
    default: {
      mount(root, ctx) {
        log.push('mount');
        ctx.onUnmount(() => log.push('onUnmount'));
        ctx.keep.set('veces', (ctx.keep.get('veces') ?? 0) + 1);
        root.innerHTML = `montada ${ctx.keep.get('veces')}`;
        module.ctx = ctx;
        return () => log.push('salida');
      },
      onEvent(event, ctx) {
        log.push(`evento:${event.type}:${ctx === module.ctx}`);
      },
    },
  };
  const screens = createScreens({
    loadIndex: async () => [descriptor('difusiones'), descriptor('contactos')],
    importScreen: async screen => {
      imports++;
      assert.equal(screen.entry, 'index.js');
      return module;
    },
    addStyles: async () => styles++,
    host: () => ({ state: { user: { id: 'u1', role: 'admin' }, brand: 'marca-1' }, setView: view => views.push(view) }),
  });
  await screens.ready;
  assert.equal(screens.current(), null);
  screens.notify({ type: 'nadie' });

  const root = fakeRoot();
  assert.equal(await screens.mount('difusiones', root), true);
  assert.equal(screens.current(), 'difusiones');
  assert.equal(root.innerHTML, 'montada 1');
  const ctx = module.ctx;
  assert.deepEqual([ctx.user.id, ctx.brand, ctx.uid('nombre')], ['u1', 'marca-1', 'k-difusiones-nombre']);
  assert.equal(typeof ctx.api.get, 'function');
  assert.equal(typeof ctx.toast, 'function');
  ctx.go('inbox');
  assert.deepEqual(views, ['inbox']);
  screens.notify({ type: 'inbox.upsert' });

  screens.unmount();
  assert.deepEqual(
    log,
    ['mount', 'evento:inbox.upsert:true', 'salida', 'onUnmount'],
    'lo último registrado se deshace primero',
  );
  assert.equal(ctx.api.signal.aborted, true, 'lo que estuviera en vuelo se cancela al salir');
  assert.equal(screens.current(), null);
  screens.notify({ type: 'tarde' });
  screens.unmount();
  assert.equal(log.length, 4, 'desmontar dos veces no repite la limpieza');

  // Se vuelve a montar con una raíz nueva: lo guardado en ctx.keep sigue ahí; el de otra pantalla es otro.
  const again = fakeRoot();
  await screens.mount('difusiones', again);
  assert.equal(again.innerHTML, 'montada 2');
  assert.notEqual(module.ctx.api, ctx.api);
  const other = fakeRoot();
  await screens.mount('contactos', other);
  assert.equal(other.innerHTML, 'montada 1');
  assert.deepEqual(log.slice(4), ['mount', 'salida', 'onUnmount', 'mount'], 'montar otra desmonta la anterior');
  assert.equal(imports, 3);
  assert.equal(styles, 3);
});

test('si se cambia de vista mientras una pantalla carga, la que llega tarde no se monta', async () => {
  const pending = new Map();
  const mounted = [];
  const screens = createScreens({
    loadIndex: async () => [descriptor('lenta'), descriptor('rapida')],
    importScreen: screen =>
      new Promise(resolve =>
        pending.set(screen.id, () => resolve({ default: { mount: () => void mounted.push(screen.id) } })),
      ),
  });
  await screens.ready;
  const [slowRoot, fastRoot] = [fakeRoot(), fakeRoot()];
  const slow = screens.mount('lenta', slowRoot);
  assert.match(slowRoot.innerHTML, /role="status".*Abriendo Pantalla lenta…/s, 'mientras carga se dice');
  const fast = screens.mount('rapida', fastRoot);
  await tick();
  pending.get('rapida')();
  assert.equal(await fast, true);
  pending.get('lenta')();
  assert.equal(await slow, false);
  assert.deepEqual(mounted, ['rapida']);
  assert.equal(screens.current(), 'rapida');
});

test('una pantalla que no se puede abrir pinta el fallo con «Volver a intentar» y no lanza', async t => {
  t.mock.method(console, 'error', () => {});
  let attempts = 0;
  const undone = [];
  const screens = createScreens({
    loadIndex: async () => [descriptor('difusiones'), descriptor('vacia'), descriptor('rota')],
    importScreen: async screen => {
      if (screen.id === 'vacia') return { default: {} };
      if (screen.id === 'rota')
        return {
          default: {
            mount(_root, ctx) {
              ctx.onUnmount(() => undone.push('a medias'));
              throw new Error('falla al montar');
            },
          },
        };
      if (++attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
      return { default: { mount: root => void (root.innerHTML = 'montada') } };
    },
  });
  await screens.ready;
  const root = fakeRoot();
  assert.equal(await screens.mount('difusiones', root), false);
  assert.match(
    root.innerHTML,
    /<section class="k-page">.*role="alert".*No se pudo abrir «Pantalla difusiones».*data-do="k-reabrir"/s,
  );
  assert.ok(!root.innerHTML.includes('Failed to fetch'), 'el texto técnico no se enseña');
  assert.ok(
    root.listeners.some(([type]) => type === 'click'),
    'el botón de reintentar tiene quien lo atienda',
  );
  // El segundo intento sí carga.
  assert.equal(await screens.mount('difusiones', root), true);
  assert.equal(root.innerHTML, 'montada');

  for (const id of ['vacia', 'rota']) {
    const broken = fakeRoot();
    assert.equal(await screens.mount(id, broken), false);
    assert.match(broken.innerHTML, /No se pudo abrir/);
  }
  assert.deepEqual(undone, ['a medias'], 'lo que mount() alcanzó a registrar antes de fallar se deshace en el acto');
  assert.equal(await screens.mount('no-existe', fakeRoot()), false);

  // Un onEvent que falla (en el acto o más tarde) no tumba a quien avisa.
  const noisy = createScreens({
    loadIndex: async () => [descriptor('ruidosa'), descriptor('lenta')],
    importScreen: async screen => ({
      default: {
        mount() {},
        onEvent:
          screen.id === 'ruidosa'
            ? () => {
                throw new Error('onEvent roto');
              }
            : async () => {
                throw new Error('onEvent roto más tarde');
              },
      },
    }),
  });
  await noisy.ready;
  for (const id of ['ruidosa', 'lenta']) {
    await noisy.mount(id, fakeRoot());
    assert.doesNotThrow(() => noisy.notify({ type: 'x' }));
    await tick();
  }
  assert.ok(console.error.mock.calls.some(call => call.arguments[0]?.message === 'onEvent roto más tarde'));
});

// ---------------------------------------------------------------------------------------------------
// Componentes: lo que deciden sin DOM
// ---------------------------------------------------------------------------------------------------

test('la validación de campos dice qué hacer, en español', () => {
  const required = { name: 'name', label: 'Nombre', required: true, maxlength: 5, minlength: 2 };
  assert.equal(fieldError(required, ''), 'Este dato es obligatorio.');
  assert.equal(fieldError(required, 'A'), 'Escribe al menos 2 caracteres.');
  assert.equal(fieldError(required, 'Anabel'), 'Máximo 5 caracteres; llevas 6.');
  assert.equal(fieldError(required, ' Ana  '), '', 'los espacios de los extremos no cuentan');
  assert.equal(fieldError({ name: 'x', label: 'X' }, ''), '', 'un campo opcional vacío es válido');
  assert.equal(
    fieldError({ name: 'ok', label: 'Acepto', type: 'checkbox', required: true }, false),
    'Marca esta casilla para continuar.',
  );
  assert.match(fieldError({ name: 'e', label: 'Correo', type: 'email' }, 'ana@'), /correo válido/);
  assert.equal(fieldError({ name: 'e', label: 'Correo', type: 'email' }, 'ana@ejemplo.test'), '');
  assert.match(fieldError({ name: 't', label: 'Teléfono', type: 'tel' }, 'abc'), /teléfono válido/);
  assert.equal(fieldError({ name: 't', label: 'Teléfono', type: 'tel' }, '+52 55 1234 5678'), '');
  assert.match(fieldError({ name: 'u', label: 'Sitio', type: 'url' }, 'http://x.test'), /https:\/\//);
  const amount = { name: 'n', label: 'Cupo', type: 'number', min: 1, max: 10 };
  assert.deepEqual(
    [NaN, 0, 11, 5].map(value => fieldError(amount, value)),
    ['Escribe un número.', 'Debe ser 1 o más.', 'Debe ser 10 o menos.', ''],
  );
  const choice = { name: 'c', label: 'Consentimiento', type: 'select', options: [{ value: 'in', label: 'Acepta' }] };
  assert.deepEqual([fieldError(choice, 'in'), fieldError(choice, 'inventado')], ['', 'Elige una opción de la lista.']);
  assert.equal(
    fieldError({ name: 'x', label: 'X', validate: value => (value === 'no' ? 'Ese no.' : null) }, 'no'),
    'Ese no.',
  );

  assert.deepEqual(coerce({ type: 'number' }, ''), null);
  assert.deepEqual(
    [coerce({ type: 'number' }, '3,5'), coerce({ type: 'number' }, '12'), coerce({ type: 'number' }, 7)],
    [3.5, 12, 7],
  );
  assert.deepEqual(
    [coerce({ type: 'checkbox' }, true), coerce({ type: 'checkbox' }, 'on'), coerce({}, undefined), coerce({}, 5)],
    [true, false, '', '5'],
  );

  const errors = validateFields([required, amount], { name: '', n: 5, other: 'x' }, values => ({
    n: values.n === 5 ? 'El cinco no.' : '',
    name: 'no pisa el propio del campo',
  }));
  assert.deepEqual(errors, { name: 'Este dato es obligatorio.', n: 'El cinco no.' });
});

test('el marcado de un campo une etiqueta, ayuda y error con el control', () => {
  const text = String(
    field(
      { name: 'name', label: 'Nombre <b>', required: true, hint: 'Como aparece en su identificación.', maxlength: 80 },
      { id: 'k-x-name', value: 'Ana "la" <jefa>', error: 'Este dato es obligatorio.' },
    ),
  );
  assert.match(
    text,
    /<label class="k-label" for="k-x-name">Nombre &lt;b&gt; <span class="k-req" aria-hidden="true">\*<\/span><\/label>/,
  );
  assert.match(text, /<input class="k-input" type="text" value="Ana &quot;la&quot; &lt;jefa&gt;"/);
  assert.match(
    text,
    / id="k-x-name" name="name" required aria-invalid="true" aria-describedby="k-x-name-ayuda k-x-name-error" maxlength="80"/,
  );
  assert.match(text, /<p class="k-hint" id="k-x-name-ayuda">Como aparece en su identificación\.<\/p>/);
  assert.match(text, /<p class="k-error" id="k-x-name-error">Este dato es obligatorio\.<\/p>/);

  const clean = String(field({ name: 'email', label: 'Correo', type: 'email' }, { id: 'k-x-email', value: '' }));
  assert.ok(
    !clean.includes('aria-invalid') &&
      !clean.includes('aria-describedby') &&
      !clean.includes('k-error') &&
      !clean.includes('required'),
  );

  const select = String(
    field(
      {
        name: 'c',
        label: 'Consentimiento',
        type: 'select',
        options: [
          { value: 'in', label: 'Acepta' },
          { value: 'out', label: 'No desea' },
        ],
      },
      { id: 'k-x-c', value: 'out' },
    ),
  );
  assert.match(select, /<option value="">Elige una opción<\/option>/);
  assert.match(select, /<option value="in" >Acepta<\/option>\s*<option value="out" selected>No desea<\/option>/);

  const box = String(
    field({ name: 'quiet', label: 'No molestar', type: 'checkbox' }, { id: 'k-x-quiet', value: true }),
  );
  assert.match(
    box,
    /<label class="k-check">\s*<input type="checkbox" id="k-x-quiet" name="quiet" checked \/>\s*<span>No molestar<\/span>/,
  );

  const radio = String(
    field(
      {
        name: 'canal',
        label: 'Canal',
        type: 'radio',
        hint: 'Uno solo.',
        options: [
          { value: 'wa', label: 'WhatsApp' },
          { value: 'ig', label: 'Instagram' },
        ],
      },
      { id: 'k-x-canal', value: 'ig' },
    ),
  );
  assert.match(
    radio,
    /<fieldset class="k-fieldset" id="k-x-canal" aria-describedby="k-x-canal-ayuda">\s*<legend class="k-label">Canal<\/legend>/,
  );
  assert.match(radio, /<input type="radio" value="ig" id="k-x-canal-1" name="canal" checked \/>/);
  assert.ok(!/value="wa"[^>]*checked/.test(radio));

  const area = String(
    field({ name: 'n', label: 'Notas', type: 'textarea', rows: 4 }, { id: 'k-x-n', value: '</textarea><b>' }),
  );
  assert.match(area, /<textarea class="k-input" rows="4" id="k-x-n" name="n">&lt;\/textarea&gt;&lt;b&gt;<\/textarea>/);
});

test('la tabla alterna el orden y respeta columnas fijas y el máximo', () => {
  assert.deepEqual(nextSort(null, 'name'), { by: 'name', dir: 'asc' });
  assert.deepEqual(nextSort({ by: 'name', dir: 'asc' }, 'name'), { by: 'name', dir: 'desc' });
  assert.deepEqual(nextSort({ by: 'name', dir: 'desc' }, 'name'), { by: 'name', dir: 'asc' });
  assert.deepEqual(nextSort({ by: 'name', dir: 'asc' }, 'activity', 'desc'), { by: 'activity', dir: 'desc' });

  const columns = [{ id: 'name', fixed: true }, { id: 'phone' }, { id: 'email' }, { id: 'tags' }];
  assert.deepEqual(toggleColumn(columns, ['name', 'phone'], 'tags', true), ['name', 'phone', 'tags']);
  assert.deepEqual(
    toggleColumn(columns, ['name', 'tags'], 'phone', true),
    ['name', 'phone', 'tags'],
    'conserva el orden de la definición',
  );
  assert.deepEqual(toggleColumn(columns, ['name', 'phone'], 'phone', false), ['name']);
  assert.deepEqual(
    toggleColumn(columns, ['name', 'phone'], 'name', false),
    ['name', 'phone'],
    'una columna fija no se oculta',
  );
  assert.deepEqual(toggleColumn(columns, ['name', 'phone'], 'email', true, 2), ['name', 'phone'], 'no pasa del máximo');
  assert.deepEqual(toggleColumn(columns, ['phone'], 'nada', true), ['phone']);
});

test('el constructor de condiciones produce la forma canónica del servidor', () => {
  const fields = [
    { name: 'name', label: 'Nombre', ops: ['contains', 'not_contains'] },
    {
      name: 'consent',
      label: 'Consentimiento',
      ops: ['is'],
      options: [
        { value: 'opted_in', label: 'Acepta' },
        { value: 'opted_out', label: 'No desea' },
      ],
    },
    {
      name: 'tag',
      label: 'Etiqueta',
      ops: ['any', 'all', 'none'],
      options: [
        { value: 't1', label: 'VIP' },
        { value: 't2', label: 'Alumno' },
      ],
    },
    {
      name: 'activity',
      label: 'Última actividad',
      ops: ['in_last_days', { op: 'between_days', label: 'entre' }],
      valueType: 'number',
    },
    { name: 'email', label: 'Correo', ops: ['has', 'not_has'] },
    { name: 'quiet', label: 'No molestar', ops: [{ op: 'is', valueType: 'boolean' }] },
    { name: 'attr', key: 'ciudad', label: 'Ciudad', ops: ['eq'] },
    { name: 'attr', key: 'edad', label: 'Edad', ops: ['gte'], valueType: 'number' },
  ];
  assert.deepEqual(emptyConditions(), { version: 1, match: 'any', groups: [] });
  assert.deepEqual(LIMITS, { groups: 5, rules: 8, values: 50 });

  // Cada operador sabe qué valor pide.
  const types = field => Object.fromEntries(operatorsOf(field).map(item => [item.op, item.valueType]));
  assert.deepEqual(types(fields[0]), { contains: 'text', not_contains: 'text' });
  assert.deepEqual(types(fields[1]), { is: 'select' });
  assert.deepEqual(types(fields[2]), { any: 'multi', all: 'multi', none: 'multi' });
  assert.deepEqual(types(fields[3]), { in_last_days: 'number', between_days: 'range' });
  assert.deepEqual(types(fields[4]), { has: 'none', not_has: 'none' });
  assert.deepEqual(
    operatorsOf(fields[4]).map(item => item.label),
    ['tiene dato', 'no tiene dato'],
  );
  assert.equal(operatorsOf(fields[3])[1].label, 'entre');

  assert.deepEqual(defaultRule(fields[2]), { field: 'tag', op: 'any', value: [] });
  assert.deepEqual(defaultRule(fields[4]), { field: 'email', op: 'has' }, 'sin valor cuando el operador no lo pide');
  assert.deepEqual(
    defaultRule(fields[6]),
    { field: 'attr', op: 'eq', key: 'ciudad', value: '' },
    'un atributo lleva su clave',
  );

  const problem = rule => ruleProblem(rule, fields);
  assert.equal(problem({ field: 'name', op: 'contains', value: '  ' }), 'Escribe un valor.');
  assert.equal(problem({ field: 'name', op: 'contains', value: 'ana' }), '');
  assert.equal(problem({ field: 'consent', op: 'is', value: '' }), 'Elige una opción.');
  assert.equal(problem({ field: 'tag', op: 'any', value: [] }), 'Elige al menos una opción.');
  assert.equal(
    problem({ field: 'tag', op: 'any', value: Array.from({ length: 51 }, (_, i) => `t${i}`) }),
    'Como mucho 50 opciones.',
  );
  assert.equal(problem({ field: 'activity', op: 'in_last_days', value: null }), 'Escribe un número.');
  assert.equal(
    problem({ field: 'activity', op: 'between_days', value: { from: 30, to: null } }),
    'Escribe los dos valores.',
  );
  assert.equal(
    problem({ field: 'activity', op: 'between_days', value: { from: 90, to: 30 } }),
    'El primer valor debe ser el menor.',
  );
  assert.equal(problem({ field: 'activity', op: 'between_days', value: { from: 30, to: 90 } }), '');
  assert.equal(problem({ field: 'email', op: 'has' }), '');
  assert.equal(problem({ field: 'quiet', op: 'is', value: false }), '');
  assert.equal(problem({ field: 'name', op: 'inventado', value: 'x' }), 'Elige una condición.');
  assert.equal(
    problem({ field: 'opportunity', op: 'exists', where: { stages: ['nuevo'] } }),
    '',
    'una condición que el constructor no edita la juzga el servidor',
  );
  assert.equal(
    problem({ field: 'attr', key: 'edad', op: 'gte', value: null }),
    'Escribe un número.',
    'los atributos se distinguen por su clave',
  );
  assert.equal(problem({ field: 'attr', key: 'ciudad', op: 'eq', value: 'Puebla' }), '');

  const definition = {
    version: 1,
    match: 'any',
    groups: [
      {
        match: 'all',
        rules: [
          { field: 'tag', op: 'any', value: ['t1', 't2'] },
          { field: 'consent', op: 'is', value: 'opted_in' },
        ],
      },
      {
        match: 'all',
        rules: [
          { field: 'email', op: 'not_has' },
          { field: 'name', op: 'contains', value: '' },
        ],
      },
    ],
  };
  assert.deepEqual(conditionProblems(definition, fields), [{ group: 1, rule: 1, message: 'Escribe un valor.' }]);
  assert.equal(
    describeConditions(definition, fields),
    'Etiqueta tiene alguna de VIP o Alumno y Consentimiento es Acepta; o Correo no tiene dato y Nombre contiene',
  );
  assert.equal(describeConditions(emptyConditions(), fields), '');
  assert.equal(
    describeConditions(
      {
        match: 'all',
        groups: [
          {
            match: 'any',
            rules: [
              { field: 'quiet', op: 'is', value: true },
              { field: 'opportunity', op: 'exists' },
            ],
          },
        ],
      },
      fields,
    ),
    'No molestar es sí o condición avanzada (opportunity)',
  );

  // La forma canónica: versión, dos niveles, sin grupos vacíos, dentro de los topes y sin tocar lo desconocido.
  const messy = {
    match: 'cualquiera',
    extra: true,
    groups: [
      { rules: [] },
      {
        match: 'any',
        rules: [{ field: 'opportunity', op: 'exists', where: { stages: ['nuevo'] } }, { nope: true }, null],
      },
      {
        rules: Array.from({ length: 12 }, () => ({
          field: 'tag',
          op: 'any',
          value: Array.from({ length: 60 }, (_, i) => `t${i}`),
        })),
      },
      ...Array.from({ length: 9 }, () => ({ rules: [{ field: 'email', op: 'has' }] })),
    ],
  };
  const canonical = normalizeConditions(messy);
  assert.deepEqual(Object.keys(canonical), ['version', 'match', 'groups']);
  assert.deepEqual([canonical.version, canonical.match, canonical.groups.length], [1, 'any', 5]);
  assert.deepEqual(canonical.groups[0], {
    match: 'any',
    rules: [{ field: 'opportunity', op: 'exists', where: { stages: ['nuevo'] } }],
  });
  assert.deepEqual(
    [canonical.groups[1].match, canonical.groups[1].rules.length, canonical.groups[1].rules[0].value.length],
    ['all', 8, 50],
  );
  assert.deepEqual(normalizeConditions(null), emptyConditions());
  assert.deepEqual(normalizeConditions({ match: 'all', groups: 'no' }), { version: 1, match: 'all', groups: [] });
  assert.deepEqual(normalizeConditions(definition), definition, 'una definición ya canónica no cambia');
});
