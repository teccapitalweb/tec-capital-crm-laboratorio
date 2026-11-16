// Pasos de recorrido que ya ejecuta el servidor (docs/PLAN_RECORRIDOS.md, «Tipos de paso»): Lista, Plantilla de
// WhatsApp, archivos en un Mensaje y en el encabezado de Botones, y «guardar el botón elegido». Con el servidor real:
// revisión al publicar, simulador, laboratorio de punta a punta, alcance por marca al publicar y al enviar, y WhatsApp
// real contra el Meta de mentira (lista interactiva, plantilla y un webhook repetido que no duplica nada).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, PNG, metaInbound, metaText } from './helpers/fake-meta.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';

const ref = () => randomUUID();
const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
const graphOf = (nodes, edges, variables = []) => ({
  v: 1,
  start: 'n1',
  variables,
  nodes: [node('n1', 'start'), ...nodes],
  edges: edges.map(([from, port, to]) => ({ from, port, to })),
});
const row = (id, title, description = '') => ({ id, title, description, do: { type: 'goto' } });
const COURSES = {
  header: 'Cursos',
  text: '¿Cuál te interesa, {{nombre}}?',
  footer: '',
  button: 'Ver cursos',
  sections: [
    { title: 'Aves', rows: [row('r1', 'Aves de corral', 'Básico'), row('r2', 'Aves exóticas')] },
    { title: 'Otros', rows: [row('r3', 'Cachorros'), row('r4', 'Gatos'), row('r5', 'Peces')] },
  ],
  saveAs: 'curso',
};

async function enable(api, brandId = 'globalvet') {
  const current = (await api('/api/automation')).brands.find(b => b.id === brandId);
  await api('/api/automation/brands/' + brandId, {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: current.revision },
  });
}
async function createFlow(api, { brandId = 'globalvet', graph, start = { type: 'first_message' }, settings = {} }) {
  return (
    await api('/api/chatflows', {
      body: { brandId, name: 'Pasos nuevos ' + ref().slice(0, 6), graph, start, settings, clientRef: ref() },
      expected: 201,
    })
  ).flow;
}
async function publish(api, flow, { activate = true } = {}) {
  let r = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } });
  if (activate)
    r = await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: r.flow.revision } });
  return r.flow;
}
const upload = (api, brandId = 'globalvet', clientRef = ref(), name = 'temario.png') =>
  api('/api/chatflows/files', {
    body: { brandId, clientRef, file: { name, type: 'image/png', base64: PNG.toString('base64') } },
    expected: 201,
  });

async function lab(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-pasos-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' } });
  const db = openDb(dir);
  t.after(async () => {
    db.close();
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const admin = await registerAdmin(server.origin, code);
  assertSchemaCurrent(db);
  const api = (path, options = {}) => call(server.origin, path, { cookie: admin, ...options });
  let n = 0;
  async function customer(name = 'Ana Pérez') {
    const u = await call(server.origin, '/api/auth/register', {
      body: { username: 'pasos' + ++n, name, password: PASSWORD },
    });
    const conv = (
      await call(server.origin, '/api/conversations', {
        cookie: u.cookie,
        body: { courseId: 'aves', channel: 'whatsapp' },
      })
    ).conversation.id;
    const send = async text =>
      (
        await call(server.origin, '/api/conversations/' + conv + '/messages', {
          cookie: u.cookie,
          body: { text, clientRef: ref() },
          expected: 201,
        })
      ).id;
    return { conv, cookie: u.cookie, send };
  }
  const outgoing = conv =>
    db.prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='automation' ORDER BY seq").all(conv);
  const session = conv =>
    db.prepare('SELECT * FROM chatflow_sessions WHERE conversation_id=? ORDER BY started_at DESC').get(conv);
  const logs = () => server.logs();
  return { server, db, api, admin, customer, outgoing, session, logs };
}

test('revisión al publicar: lista, archivos y «guardar el botón» pasan; plantilla sin número real, archivo de otra marca y material por espacio no', async t => {
  const L = await lab(t);
  const own = (await upload(L.api)).file;
  const other = (await upload(L.api, 'odonteck')).file;
  // Un archivo subido con el mismo clientRef no se sube dos veces; sin permiso de la marca no se sube.
  const clientRef = ref();
  const first = await upload(L.api, 'globalvet', clientRef);
  const again = await L.api('/api/chatflows/files', {
    body: {
      brandId: 'globalvet',
      clientRef,
      file: { name: 'temario.png', type: 'image/png', base64: PNG.toString('base64') },
    },
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.file.id, first.file.id);
  await L.api('/api/chatflows/files', {
    body: { brandId: 'globalvet', clientRef: ref(), file: { name: 'x.png', type: 'image/png', base64: 'aGVsbG8=' } },
    expected: 400,
  });
  // El editor recibe los archivos de SU marca (no los de otra) y si la marca tiene WhatsApp real.
  const lists = (await L.api('/api/chatflows/lists?brand=globalvet')).lists;
  assert.ok(lists.files.some(f => f.id === own.id));
  assert.ok(!lists.files.some(f => f.id === other.id));
  assert.equal(lists.realWhatsApp, false);
  assert.ok(Array.isArray(lists.waTemplates));
  // La lista de tipos no disponibles ya no incluye Lista ni Plantilla.
  const unavailable = (await L.api('/api/chatflows?brand=globalvet')).unavailable;
  assert.ok(!('list' in unavailable) && !('template' in unavailable));
  assert.ok('webhook' in unavailable);

  const good = graphOf(
    [
      node('m', 'message', { parts: [{ kind: 'media', fileId: own.id, caption: 'Temario' }] }),
      node('b', 'buttons', {
        header: { kind: 'media', fileId: own.id },
        text: '¿Seguimos?',
        options: [
          { id: 'si', label: 'Sí', do: { type: 'goto' } },
          { id: 'no', label: 'No', do: { type: 'goto' } },
        ],
        saveAs: 'respuesta',
      }),
      node('l', 'list', COURSES),
      node('e', 'end', { text: 'Gracias' }),
    ],
    [
      ['n1', 'next', 'm'],
      ['m', 'next', 'b'],
      ['b', 'opt:si', 'l'],
      ['b', 'opt:no', 'e'],
      ...['r1', 'r2', 'r3', 'r4', 'r5'].map(r => ['l', 'opt:' + r, 'e']),
    ],
  );
  const flow = await createFlow(L.api, { graph: good });
  const checked = await L.api('/api/chatflows/' + flow.id + '/validate', { body: {} });
  assert.deepEqual(checked.issues.errors, []);
  await publish(L.api, flow, { activate: false });

  const reject = async (graph, pattern) => {
    const f = await createFlow(L.api, { graph });
    const r = await L.api('/api/chatflows/' + f.id + '/publish', {
      body: { expectedRevision: f.revision },
      expected: 422,
    });
    const messages = r.details.issues.errors.map(e => e.message).join(' | ');
    assert.match(messages, pattern);
  };
  await reject(
    graphOf([node('m', 'message', { parts: [{ kind: 'media', fileId: other.id }] })], [['n1', 'next', 'm']]),
    /no existe en esta marca/,
  );
  await reject(
    graphOf(
      [
        node('b', 'buttons', {
          header: { kind: 'media', fileId: other.id },
          text: 'Hola',
          options: [{ id: 'a', label: 'A', do: { type: 'goto' } }],
        }),
      ],
      [['n1', 'next', 'b']],
    ),
    /no existe en esta marca/,
  );
  await reject(
    graphOf([node('t', 'template', { waTemplateId: randomUUID() })], [['n1', 'next', 't']]),
    /número real de WhatsApp/,
  );
  await reject(
    graphOf([node('m', 'message', { parts: [{ kind: 'slot', slot: 'presentacion' }] })], [['n1', 'next', 'm']]),
    /material por espacio/,
  );
  // Siguen rechazados: Servicio externo, Suscribir y Estado «Esperando».
  await reject(graphOf([node('w', 'webhook', {})], [['n1', 'next', 'w']]), /servicios externos/);
});

test('simulador: la lista espera y se elige por número; el archivo y la variable guardada se ven en la prueba', async t => {
  const L = await lab(t);
  const own = (await upload(L.api)).file;
  const graph = graphOf(
    [
      node('m', 'message', { parts: [{ kind: 'media', fileId: own.id, caption: 'Temario' }] }),
      node('l', 'list', COURSES),
      node('e', 'end', { text: 'Elegiste {{var.curso}}' }),
    ],
    [['n1', 'next', 'm'], ['m', 'next', 'l'], ...['r1', 'r2', 'r3', 'r4', 'r5'].map(r => ['l', 'opt:' + r, 'e'])],
  );
  const flow = await createFlow(L.api, { graph });
  const first = await L.api('/api/chatflows/' + flow.id + '/simulate', { body: { graph } });
  assert.equal(first.messages[0].media, own.name);
  assert.equal(first.messages[0].text, 'Temario');
  assert.equal(first.messages[1].list.button, 'Ver cursos');
  assert.equal(first.messages[1].list.sections[1].rows.length, 3);
  assert.match(first.messages[1].text, /^Cursos\n\n¿Cuál te interesa/);
  assert.deepEqual(
    first.messages[1].list.sections.flatMap(s => s.rows.map(r => r.title)),
    ['Aves de corral', 'Aves exóticas', 'Cachorros', 'Gatos', 'Peces'],
  );
  assert.equal(first.waiting.list, true);
  assert.equal(first.waiting.options.length, 5);
  const next = await L.api('/api/chatflows/' + flow.id + '/simulate', {
    body: { graph, state: first.state, input: { text: '4' } },
  });
  assert.equal(next.ended, true);
  assert.equal(next.messages.at(-1).text, 'Elegiste Gatos');
  assert.equal(next.state.vars.curso, 'Gatos');
  // Por la opción (lo que pulsa quien prueba).
  const tapped = await L.api('/api/chatflows/' + flow.id + '/simulate', {
    body: { graph, state: first.state, input: { optionId: 'r2' } },
  });
  assert.equal(tapped.messages.at(-1).text, 'Elegiste Aves exóticas');
  // Una plantilla en la prueba: en una marca sin número real no se puede ni probar (la revisión lo impide).
  const tpl = graphOf([node('t', 'template', { waTemplateId: randomUUID() })], [['n1', 'next', 't']]);
  const blocked = await L.api('/api/chatflows/' + flow.id + '/simulate', { body: { graph: tpl }, expected: 422 });
  assert.match(JSON.stringify(blocked.details.issues.errors), /número real de WhatsApp/);
});

test('laboratorio de punta a punta: archivo de la marca, lista en texto numerado, número elegido y variable; un archivo que cambió de marca no sale', async t => {
  const L = await lab(t);
  await enable(L.api);
  const own = (await upload(L.api)).file;
  const graph = graphOf(
    [
      node('m', 'message', {
        parts: [
          { kind: 'text', text: 'Hola, {{nombre}}.' },
          { kind: 'media', fileId: own.id, caption: 'El temario de {{curso}}' },
        ],
      }),
      node('l', 'list', COURSES),
      node('e', 'end', { text: 'Anotado: {{var.curso}}.' }),
    ],
    [['n1', 'next', 'm'], ['m', 'next', 'l'], ...['r1', 'r2', 'r3', 'r4', 'r5'].map(r => ['l', 'opt:' + r, 'e'])],
  );
  const flow = await publish(L.api, await createFlow(L.api, { graph }));
  const ana = await L.customer('Ana Pérez');
  await ana.send('Hola');
  const sent = await until(() => L.outgoing(ana.conv).length >= 3 && L.outgoing(ana.conv), 'el recorrido habló', {
    logs: L.logs,
  });
  assert.equal(sent[0].text, 'Hola, Ana.');
  // El archivo viaja como la ficha: en flyer_snapshot con su id de biblioteca, y la persona lo puede abrir.
  assert.equal(JSON.parse(sent[1].flyer_snapshot).libraryFileId, own.id);
  assert.match(sent[1].text, /El temario de/);
  const image = await fetch(L.server.origin + '/api/messages/' + sent[1].id + '/flyer', {
    headers: { Cookie: ana.cookie },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  // La lista: texto con las filas numeradas (el chat del laboratorio no dibuja listas) e `interactive` para WhatsApp.
  assert.match(sent[2].text, /¿Cuál te interesa, Ana\?\n\n1\. Aves de corral\n2\. Aves exóticas/);
  const interactive = JSON.parse(sent[2].interactive);
  assert.equal(interactive.type, 'list');
  assert.equal(interactive.sections[0].rows[0].id, 'l:r1');
  assert.equal(sent[2].buttons, null);
  assert.equal(L.session(ana.conv).state, 'waiting');
  await ana.send('5');
  await until(() => L.session(ana.conv).state === 'ended', 'el recorrido terminó', { logs: L.logs });
  assert.equal(L.outgoing(ana.conv).at(-1).text, 'Anotado: Peces.');
  assert.equal(JSON.parse(L.session(ana.conv).vars).curso, 'Peces');

  // Alcance por marca al ENVIAR: el archivo pasa (a mano, en la base) a otra marca; la versión publicada ya no lo manda.
  L.db.prepare("UPDATE library_files SET brand_id='odonteck' WHERE id=?").run(own.id);
  const bea = await L.customer('Bea Gil');
  await bea.send('Hola');
  await until(() => L.session(bea.conv)?.state === 'ended', 'la sesión terminó', { logs: L.logs });
  const s = L.session(bea.conv);
  assert.equal(s.outcome, 'handoff');
  const out = L.outgoing(bea.conv);
  assert.ok(!out.some(m => m.flyer_snapshot && JSON.parse(m.flyer_snapshot)?.libraryFileId), 'ningún archivo salió');
  assert.ok(
    L.db
      .prepare(
        "SELECT 1 FROM chatflow_events WHERE session_id=? AND event='error' AND detail LIKE '%biblioteca de la marca%'",
      )
      .get(s.id),
  );
  assert.equal(L.db.prepare('SELECT bot_enabled FROM conversations WHERE id=?').get(bea.conv).bot_enabled, 0);
  assert.equal(flow.status, 'active');
});

// Plantilla aprobada de la marca con dos respuestas rápidas.
function seedTemplate(db) {
  const id = randomUUID();
  const components = {
    type: 'standard',
    header: { type: 'none' },
    body: {
      text: 'Hola {{1}}, hay lugar en {{2}}. ¿Te aparto uno?',
      vars: ['nombre', 'curso'].map(key => ({ key, sample: 'Muestra', fallback: null })),
    },
    footer: { text: '' },
    buttons: [
      { type: 'quick_reply', text: 'Sí, apártalo' },
      { type: 'quick_reply', text: 'Ahora no' },
    ],
  };
  db.prepare(
    "INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,body,variables,components,status,revision,created_at,updated_at) VALUES(?,'globalvet','','lugar_disponible','es_MX','marketing',?,?,?,'approved',1,1,1)",
  ).run(id, components.body.text, JSON.stringify(['nombre', 'curso']), JSON.stringify(components));
  return id;
}

test('WhatsApp real (Meta de mentira): plantilla con su categoría, lista interactiva y un webhook repetido que no duplica', async t => {
  const W = await whatsappLab(t, { AI_PROVIDER: '' });
  const origin = W.origin();
  const api = (path, options = {}) => call(origin, path, { cookie: W.admin, ...options });
  await enable(api);
  const templateId = seedTemplate(W.db);
  const lists = (await api('/api/chatflows/lists?brand=globalvet')).lists;
  assert.equal(lists.realWhatsApp, true);
  const listed = lists.waTemplates.find(x => x.id === templateId);
  assert.deepEqual(listed.buttons, ['Sí, apártalo', 'Ahora no']);
  assert.equal(listed.status, 'approved');
  const graph = graphOf(
    [
      node('t', 'template', { waTemplateId: templateId, wait: true, buttons: listed.buttons }),
      node('l', 'list', COURSES),
      node('e', 'end', { text: 'Anotado: {{var.curso}}.' }),
      node('x', 'end', { text: 'Cuando quieras.' }),
    ],
    [
      ['n1', 'next', 't'],
      ['t', 'opt:1', 'l'],
      ['t', 'opt:2', 'x'],
      ...['r1', 'r2', 'r3', 'r4', 'r5'].map(r => ['l', 'opt:' + r, 'e']),
    ],
  );
  const flow = await publish(api, await createFlow(api, { graph }));
  assert.equal(flow.status, 'active');
  const from = '5215512345678';
  await metaText(origin, from, 'wamid.pasos.1', 'Hola');
  const conv = await until(
    () => W.db.prepare("SELECT conversation_id id FROM chatflow_sessions WHERE brand_id='globalvet'").get()?.id,
    'el recorrido inició',
  );
  // La plantilla sale como plantilla, con los datos de la persona y la categoría de costo de la plantilla.
  const tplSent = await until(() => W.meta.sent.find(m => m.type === 'template'), 'la plantilla salió a Meta');
  assert.equal(tplSent.template.name, 'lugar_disponible');
  assert.equal(tplSent.template.components.find(c => c.type === 'body').parameters.length, 2);
  const saved = W.db
    .prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='automation' AND wa_template IS NOT NULL")
    .get(conv);
  assert.equal(saved.category, 'marketing');
  assert.match(saved.client_ref, /^flow:/);
  // Pulsa «Sí, apártalo» en la plantilla: llega como botón de plantilla y sale la lista interactiva.
  const button = { type: 'button', button: { text: 'Sí, apártalo', payload: 'tpl:x:0' } };
  await metaInbound(origin, from, 'wamid.pasos.2', button);
  const listSent = await until(
    () => W.meta.sent.find(m => m.type === 'interactive' && m.interactive?.type === 'list'),
    'la lista salió a Meta',
  );
  assert.equal(listSent.interactive.action.button, 'Ver cursos');
  assert.equal(listSent.interactive.header.text, 'Cursos');
  assert.deepEqual(
    listSent.interactive.action.sections.flatMap(s => s.rows.map(r => r.id)),
    ['l:r1', 'l:r2', 'l:r3', 'l:r4', 'l:r5'],
  );
  assert.equal(listSent.interactive.action.sections[0].rows[0].description, 'Básico');
  // Elige una fila; Meta repite el mismo webhook: el recorrido avanza una sola vez.
  const tap = { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'l:r4', title: 'Gatos' } } };
  await metaInbound(origin, from, 'wamid.pasos.3', tap);
  await metaInbound(origin, from, 'wamid.pasos.3', tap);
  await until(
    () => W.db.prepare('SELECT state FROM chatflow_sessions WHERE conversation_id=?').get(conv).state === 'ended',
    'el recorrido terminó',
  );
  const closing = () => W.meta.sent.filter(m => m.type === 'text' && /Anotado: Gatos/.test(m.text?.body || ''));
  await until(() => closing().length > 0, 'el cierre salió a Meta');
  const thanks = closing();
  assert.equal(thanks.length, 1);
  assert.equal(
    W.db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND text LIKE 'Anotado:%'").get(conv).n,
    1,
    'un solo cierre en el CRM',
  );
  assert.equal(
    JSON.parse(W.db.prepare('SELECT vars FROM chatflow_sessions WHERE conversation_id=?').get(conv).vars).curso,
    'Gatos',
  );
  assert.equal(W.meta.sent.filter(m => m.type === 'template').length, 1, 'una sola plantilla');
  assert.ok(NUMBER);
});
