// Propuesta «pausar_recorrido» y el aviso de choque de palabras al activar (docs/PLAN_MCP_CLAUDE.md, «Propuestas que
// aprueba una persona»). Prueba real del 21 nov 2026: un recorrido viejo con la palabra «reptiles» se metió antes que
// el nuevo. Se comprueba, con el servidor real: la tarjeta de activar avisa qué recorrido activo arrancaría antes y con
// qué palabra; pausar avisa con datos de la base (conversaciones en curso, la marca sin recorridos activos), deja
// terminar las conversaciones en curso y va antes que activar en un lote; lo aprueba una persona con permiso de
// automatización, a su nombre; el conector no puede pausar por sí mismo. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS } from '../server/mcp.mjs';
import { PROPOSALS_SCOPE } from '../server/lib/mcp-proposals.mjs';
import { ACTIONS, startClashes, startWords } from '../server/modules/mcp-proposals/actions.mjs';
import { TOOL_LABELS } from '../server/lib/mcp-activity-labels.mjs';
import { EXAMPLE_GRAPH } from '../server/lib/flow-guide.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

const ref = () => 'mcp-pausa-' + randomUUID();
const keyword = (...keywords) => ({ type: 'keyword', keywords, mode: 'contains' });

test('choque de inicios: la misma regla que el motor (palabra clave antes que primer mensaje; el más antiguo gana)', () => {
  const e = (start, createdAt = 200, id = 'nuevo') => ({
    id,
    created_at: createdAt,
    published_start: JSON.stringify(start),
  });
  const o = (name, start, createdAt = 100, id = 'viejo') => ({ id, name, createdAt, start });
  // palabra clave contra palabra clave más antigua: avisa con el nombre y la palabra
  let w = startClashes(e(keyword('quiero el curso de reptiles', 'serpientes')), [
    o('Reptiles viejo', keyword('reptiles')),
  ]);
  assert.equal(w.length, 1);
  assert.match(
    w[0],
    /^El recorrido activo «Reptiles viejo» arrancaría antes con la palabra «quiero el curso de reptiles»/,
  );
  // el otro es más nuevo: gana el que se activa (no avisa)
  assert.deepEqual(startClashes(e(keyword('reptiles'), 100), [o('Más nuevo', keyword('reptiles'), 300)]), []);
  // palabras que no coinciden; o el otro empieza por primer mensaje (la palabra clave le gana): no avisa
  assert.deepEqual(startClashes(e(keyword('aves')), [o('Reptiles', keyword('reptiles'))]), []);
  assert.deepEqual(startClashes(e(keyword('aves')), [o('Bienvenida', { type: 'first_message' })]), []);
  // mismo tipo sin palabras: el más antiguo siempre arranca antes
  w = startClashes(e({ type: 'first_message' }), [o('Bienvenida', { type: 'first_message' })]);
  assert.match(w[0], /«Bienvenida» tiene el mismo inicio \(primer mensaje de la conversación\) y es más antiguo/);
  assert.deepEqual(startClashes(e({ type: 'first_message' }), [o('Cualquiera', { type: 'any_message' })]), []);
  // a mano no compite con nadie; y el mismo recorrido no choca consigo mismo
  assert.deepEqual(startClashes(e({ type: 'manual' }), [o('Bienvenida', { type: 'manual' })]), []);
  assert.deepEqual(startClashes(e(keyword('x'), 200, 'f'), [o('Yo', keyword('x'), 100, 'f')]), []);
  assert.equal(
    startWords(JSON.stringify(keyword('reptiles', 'serpientes'))),
    'Palabras clave: «reptiles», «serpientes»',
  );
  assert.equal(startWords(null), 'Sin inicio publicado');
  // la acción: lista cerrada, permiso de automatización, antes que activar en un lote, por la ruta de «Pausar»
  const a = ACTIONS.pausar_recorrido;
  assert.equal(a.permission, 'automation');
  assert.equal(a.scope, 'automation_drafts');
  assert.ok(a.batchOrder < (ACTIONS.activar_recorrido.batchOrder ?? 1));
  const [mod, method, path, payload] = a.request({ id: 'f-1' }, 7);
  assert.deepEqual(
    [mod, method, path, payload],
    ['chatflows', 'POST', '/api/chatflows/f-1/pause', { expectedRevision: 7 }],
  );
  assert.equal('stopSessions' in payload, false, 'deja terminar las conversaciones en curso');
  // ninguna herramienta del conector pausa (ni activa, ni aprueba): sólo se propone
  assert.deepEqual(
    TOOLS.filter(t => /paus|activ|aprob|approve/.test(t.name)).map(t => t.name),
    [],
  );
  assert.ok(TOOL_LABELS.proponer_accion);
});

test('pausar un recorrido desde una propuesta: avisos con datos, permiso de quien aprueba, lote y nada por el conector', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-propuestas-pausa-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' } });
  let db = null;
  t.after(async () => {
    try {
      db?.close();
    } catch {
      // ya estaba cerrada
    }
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const { origin } = server;
  const admin = await registerAdmin(origin, code);
  db = openDb(dir);
  assertSchemaCurrent(db);
  const api = (path, options = {}) => call(origin, path, { cookie: admin, ...options });
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const idOf = username => db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
  const approver = await register('aprobadora', 'Aprobadora de prueba');
  db.prepare("UPDATE users SET role='admin' WHERE username='aprobadora'").run();
  const approverId = idOf('aprobadora');
  const agent = await register('asesor-gv', 'Asesor de prueba');
  db.prepare("UPDATE users SET role='agent' WHERE username='asesor-gv'").run();
  db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(idOf('asesor-gv'), 'globalvet');

  const key = (
    await api('/api/integrations/keys', {
      body: { brandId: 'globalvet', name: 'Claude pausa', scopes: [PROPOSALS_SCOPE, 'automation_drafts'] },
      expected: 201,
    })
  ).token;
  let rid = 0;
  const tool = async (name, args = {}) => {
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
    });
    const out = await r.json();
    if (out.error) return { rpcError: out.error.message };
    return out.result.isError ? { error: out.result.content[0].text } : JSON.parse(out.result.content[0].text);
  };
  const ok = async (...a) => {
    const r = await tool(...a);
    assert.equal(r.error, undefined, a[0] + ': ' + r.error);
    return r;
  };
  const decide = (cookie, id, expected = 200) =>
    fetch(origin + `/api/mcp-proposals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    }).then(async r => {
      const out = await r.json();
      assert.equal(r.status, expected, JSON.stringify(out));
      return out;
    });
  const cards = async () => (await call(origin, '/api/mcp-proposals', { cookie: approver })).pending;
  const flowRow = id => db.prepare('SELECT status,revision,updated_by FROM chatflows WHERE id=?').get(id);

  // Un recorrido viejo, activo, que empieza con «reptiles»; uno nuevo, publicado, con sus propias palabras.
  const current = (await api('/api/automation')).brands.find(b => b.id === 'globalvet');
  await api('/api/automation/brands/globalvet', {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: current.revision },
  });
  const make = async (nombre, inicio, { activate }) => {
    const f = await ok('crear_recorrido', {
      nombre,
      inicio,
      grafo: JSON.parse(JSON.stringify(EXAMPLE_GRAPH)),
      clientRef: ref(),
    });
    let r = await api('/api/chatflows/' + f.recorridoId + '/publish', { body: { expectedRevision: f.revision } });
    if (activate)
      r = await api('/api/chatflows/' + f.recorridoId + '/activate', { body: { expectedRevision: r.flow.revision } });
    return f.recorridoId;
  };
  const old = await make('Reptiles viejo', keyword('reptiles'), { activate: true });
  await new Promise(done => setTimeout(done, 5)); // el nuevo es más reciente
  const fresh = await make('Reptiles nuevo', keyword('quiero el curso de reptiles', 'serpientes'), { activate: false });

  // Una persona del laboratorio escribe «reptiles»: entra al recorrido viejo y queda esperando sus botones.
  const u = await call(origin, '/api/auth/register', {
    body: { username: 'cliente-pausa', name: 'Clienta de prueba', password: PASSWORD },
  });
  const conv = (
    await call(origin, '/api/conversations', { cookie: u.cookie, body: { courseId: 'aves', channel: 'whatsapp' } })
  ).conversation.id;
  await call(origin, '/api/conversations/' + conv + '/messages', {
    cookie: u.cookie,
    body: { text: 'Hola, me interesa lo de reptiles', clientRef: ref() },
    expected: 201,
  });
  const session = () =>
    db
      .prepare('SELECT state,flow_id FROM chatflow_sessions WHERE conversation_id=? ORDER BY started_at DESC')
      .get(conv);
  await until(() => session()?.state === 'waiting', 'la conversación quedó dentro del recorrido viejo', {
    logs: server.logs,
  });
  assert.equal(session().flow_id, old);

  // ---- activar el nuevo: la tarjeta avisa qué recorrido activo arrancaría antes y con qué palabra
  const pAct = await ok('proponer_accion', { accion: 'activar_recorrido', id: fresh });
  assert.ok(
    pAct.avisos.some(w => /«Reptiles viejo» arrancaría antes con la palabra «quiero el curso de reptiles»/.test(w)),
    JSON.stringify(pAct.avisos),
  );
  // ---- pausar el viejo: lo deja el conector, pero NO lo pausa
  const pPause = await ok('proponer_accion', { accion: 'pausar_recorrido', id: old });
  assert.equal(pPause.que, 'Pausar el recorrido «Reptiles viejo»');
  assert.equal(flowRow(old).status, 'active', 'proponer no pausa');
  // el conector no puede llamar a la ruta de pausar (ni con su llave)
  const direct = await fetch(origin + '/api/chatflows/' + old + '/pause', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: flowRow(old).revision }),
  });
  assert.ok([401, 403].includes(direct.status), String(direct.status));
  assert.equal((await tool('pausar_recorrido', { recorridoId: old })).rpcError?.includes('desconocida'), true);
  assert.equal(flowRow(old).status, 'active');

  let list = await cards();
  const pauseCard = list.find(p => p.id === pPause.propuestaId);
  const actCard = list.find(p => p.id === pAct.propuestaId);
  assert.equal(pauseCard.title, 'Pausar el recorrido');
  assert.match(pauseCard.effect, /deja de empezar conversaciones nuevas/);
  assert.match(pauseCard.effect, /Las conversaciones que ya están dentro lo terminan con normalidad/);
  assert.deepEqual(pauseCard.problems, []);
  assert.ok(
    pauseCard.warnings.includes(
      'Hay una conversación dentro de este recorrido ahora mismo: lo terminan con normalidad; no empieza ninguna nueva.',
    ),
  );
  assert.ok(pauseCard.warnings.some(w => /^Es el único recorrido activo de la marca/.test(w)));
  assert.deepEqual(
    pauseCard.details.map(d => [d.label, d.value]),
    [
      ['Inicio que deja de valer', 'Palabras clave: «reptiles»'],
      ['Conversaciones en curso', '1 (lo terminan)'],
    ],
  );
  assert.ok(pauseCard.batchOrder < actCard.batchOrder, 'en un lote se pausa antes de activar');
  assert.ok(actCard.details.some(d => d.label === 'Inicio' && /«serpientes»/.test(d.value)));

  // ---- quien no administra la automatización no aprueba; quien sí, a su nombre
  await decide(agent, pPause.propuestaId, 403);
  assert.equal(flowRow(old).status, 'active');
  await decide(approver, pPause.propuestaId);
  assert.deepEqual(
    { ...flowRow(old), revision: undefined },
    { status: 'paused', revision: undefined, updated_by: approverId },
  );
  assert.equal(
    db.prepare("SELECT user_id FROM audit WHERE action='chatflow.pause' AND entity_id=?").get(old)?.user_id,
    approverId,
  );
  assert.equal(session().state, 'waiting', 'la conversación en curso no se cortó');

  // ---- con el viejo en pausa, activar el nuevo ya no avisa del choque; y pausar otra vez no se propone
  list = await cards();
  assert.ok(!list.find(p => p.id === pAct.propuestaId).warnings.some(w => /arrancaría antes/.test(w)));
  assert.match((await tool('proponer_accion', { accion: 'pausar_recorrido', id: old })).error, /ya está en pausa/);
  await decide(approver, pAct.propuestaId);
  assert.equal(flowRow(fresh).status, 'active');
  // un recorrido que no está activo no se pausa
  const draftOnly = await ok('crear_recorrido', {
    nombre: 'Sin activar',
    grafo: JSON.parse(JSON.stringify(EXAMPLE_GRAPH)),
    clientRef: ref(),
  });
  assert.match(
    (await tool('proponer_accion', { accion: 'pausar_recorrido', id: draftOnly.recorridoId })).error,
    /no está activo/,
  );
  // con el viejo en pausa, el nuevo es el único activo: proponer pausarlo lo avisa
  const pLast = await ok('proponer_accion', { accion: 'pausar_recorrido', id: fresh });
  assert.ok(
    pLast.avisos.some(w => /único recorrido activo/.test(w)),
    JSON.stringify(pLast.avisos),
  );
});
