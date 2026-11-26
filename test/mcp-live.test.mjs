import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countKinds, groupSessions, kindOf } from '../public/kit/shared/live-sessions.js';
import { flowDiagram } from '../server/modules/mcp-live/preview.mjs';
import { EXAMPLE_GRAPH } from '../server/lib/flow-guide.mjs';
import activity from '../server/modules/mcp-activity/module.mjs';
import { openDatabase } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin } from './helpers/crm.mjs';

// «Asistente en vivo» (docs/PLAN_ASISTENTE_EN_VIVO.md): la actividad del conector agrupada en sesiones, con la tarjeta
// de lo que dejó cada acción (leída de la base) y las propuestas; aviso en vivo por cada herramienta. Todos los datos
// son inventados.

test('sesiones: se cortan por conexión, marca y hueco de 15 minutos; clases y totales', () => {
  const row = (id, at, extra = {}) => ({
    id,
    at,
    brandId: 'globalvet',
    brandName: 'GlobalVet',
    source: { id: 'key:k1', kind: 'key', name: 'Claude' },
    kind: 'read',
    outcome: 'ok',
    entity: null,
    ...extra,
  });
  const m = 60_000;
  const rows = [
    row(1, 0),
    row(2, 5 * m, { kind: 'write', entity: { type: 'rule', id: 'r1', label: 'Regla' } }),
    row(3, 6 * m, { kind: 'write', entity: { type: 'proposal', id: 'p1', label: 'Propuesta' } }),
    row(4, 7 * m, { kind: 'write', outcome: 'rejected', entity: null }),
    row(5, 30 * m), // 23 minutos después: otra sesión
    row(6, 31 * m, { source: { id: 'oauth:g1', kind: 'oauth', name: 'App' } }), // otra conexión: otra sesión
    row(7, 32 * m, { brandId: 'odonteck', brandName: 'OdonTeck' }), // otra marca: otra sesión
  ];
  const sessions = groupSessions(rows);
  assert.equal(sessions.length, 4);
  // de la más reciente a la más antigua; dentro, las filas también
  assert.deepEqual(
    sessions.map(s => s.items.map(r => r.id)),
    [[7], [6], [5], [4, 3, 2, 1]],
  );
  const first = sessions[3];
  assert.equal(first.startedAt, 0);
  assert.equal(first.endedAt, 7 * m);
  assert.deepEqual(first.counts, { read: 1, create: 1, write: 0, propose: 1, deny: 1 });
  assert.equal(kindOf(rows[1]), 'create');
  assert.equal(kindOf(rows[2]), 'propose');
  assert.equal(kindOf(rows[3]), 'deny');
  assert.equal(kindOf({ kind: 'write', outcome: 'ok', entity: null }), 'write');
  assert.deepEqual(countKinds(rows), { total: 7, read: 4, create: 1, write: 0, propose: 1, deny: 1 });
  // el orden de entrada no importa y lo que no es fila se ignora
  assert.equal(groupSessions([...rows].reverse().concat([null, 'x']), { gapMs: 60 * m }).length, 3);
  assert.deepEqual(groupSessions([]), []);
});

test('diagrama de un recorrido: pasos por profundidad desde el Inicio, salidas con nombre, sólo texto plano', () => {
  const d = flowDiagram(EXAMPLE_GRAPH);
  assert.equal(d.start, 'n1');
  assert.equal(d.nodes.length, 8);
  assert.deepEqual(
    d.nodes.slice(0, 3).map(n => [n.id, n.depth, n.label]),
    [
      ['n1', 0, 'Inicio'],
      ['n2', 1, 'Mensaje'],
      ['n3', 2, '¿Qué curso te interesa?'],
    ],
  );
  assert.equal(d.nodes.find(n => n.id === 'n2').text, '¡Hola! Gracias por escribirnos a {{marca}}.');
  assert.ok(d.edges.some(e => e.from === 'n5' && e.to === 'n6' && e.label === 'Sí, inscribirme'));
  assert.ok(d.edges.every(e => d.nodes.some(n => n.id === e.from) && d.nodes.some(n => n.id === e.to)));
  assert.equal(d.truncated, false);
  // un grafo roto o ajeno no rompe nada
  assert.deepEqual(flowDiagram('{no es json'), { start: null, nodes: [], edges: [], truncated: false });
  assert.deepEqual(flowDiagram({ nodes: [{ id: 'x', type: 'message' }], edges: [] }).nodes, []);
  // un paso que nadie alcanza no sale
  const g = JSON.parse(JSON.stringify(EXAMPLE_GRAPH));
  g.nodes.push({ id: 'n9', type: 'message', title: 'Suelto', data: { text: '<b>x</b>' } });
  assert.equal(flowDiagram(g).nodes.length, 8);
});

test('record() avisa en vivo a la marca con el id de la fila y sigue registrando si el aviso falla', () => {
  const dir = join(tmpdir(), 'crm-live-record-' + randomUUID());
  const db = openDatabase(dir);
  migrate(db, { backup: false });
  assertSchemaCurrent(db);
  const emitted = [];
  const host = {
    db,
    fail: () => new Error('x'),
    json: () => {},
    access: {},
    realtime: {
      emit: (type, target) => {
        emitted.push([type, target]);
        if (emitted.length === 2) throw new Error('socket roto');
      },
    },
  };
  const api = activity.create(host);
  const key = { id: 'k-1', brand_id: 'globalvet', created_by: null };
  const tool = { name: 'listar_cursos', annotations: { readOnlyHint: true, title: 'Cursos' } };
  api.record({ key, tool });
  api.record({ key, tool }); // el aviso falla: la fila queda igual
  const rows = db.prepare('SELECT id,brand_id FROM mcp_activity ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0][0], 'mcp_activity.recorded');
  assert.deepEqual(emitted[0][1], { brandId: 'globalvet', data: { id: rows[0].id } });
  assert.equal(typeof rows[0].id, 'number');
  db.close();
});

test('mcp-live de punta a punta: actividad, propuestas, lo que dejó cada acción, marcas y nadie sin sesión', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-live-'));
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
  const api = (path, options = {}) => call(origin, path, { cookie: admin, ...options });
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const idOf = username => db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
  // una asesora de OTRA marca: no ve nada de GlobalVet
  const agentOd = await register('asesora-od', 'Asesora OdonTeck');
  db.prepare("UPDATE users SET role='agent' WHERE username='asesora-od'").run();
  db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(idOf('asesora-od'), 'odonteck');

  const key = (
    await api('/api/integrations/keys', {
      body: {
        brandId: 'globalvet',
        name: 'Claude de la prueba',
        scopes: ['knowledge', 'automation_drafts', 'proposals'],
      },
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
  const rule = await tool('crear_regla', {
    titulo: 'Horario (en vivo)',
    definicion: {
      trigger: { type: 'keyword', mode: 'contains', words: ['horario-vivo'] },
      actions: [{ type: 'send_text', text: 'Atendemos de 9 a 18 h. <b>sin negrita</b>' }],
    },
    clientRef: 'live-' + randomUUID(),
  });
  assert.ok(rule.reglaId, JSON.stringify(rule));
  const proposed = await tool('proponer_accion', { accion: 'activar_regla', id: rule.reglaId, nota: 'Lista.' });
  assert.ok(proposed.propuestaId, JSON.stringify(proposed));
  const knowledge = await tool('proponer_conocimiento', {
    pregunta: '¿Dan factura?',
    variantes: ['¿Emiten CFDI?'],
    respuesta: 'Por completar por el equipo.',
    tema: 'general',
  });
  assert.equal(knowledge.error, undefined, JSON.stringify(knowledge));
  assert.match((await tool('listar_cursos')).error, /permiso/); // sin el permiso: queda como rechazada
  await tool('herramienta_inventada');

  // ---- la pantalla: actividad plana, cifras de 24 h, marcas, conexiones y propuestas
  const live = await api('/api/mcp-live');
  assert.equal(live.allowed, true);
  assert.ok(live.items.length >= 5);
  assert.ok(live.items.every(r => typeof r.id === 'number' && r.brandId === 'globalvet'));
  assert.equal(live.items[0].id, Math.max(...live.items.map(r => r.id)), 'de la más nueva a la más antigua');
  assert.deepEqual(Object.keys(live.last24h).sort(), ['actions', 'creates', 'denied', 'proposes', 'reads']);
  assert.equal(live.last24h.actions, live.items.length);
  assert.ok(live.last24h.creates >= 2 && live.last24h.proposes === 1 && live.last24h.denied >= 2);
  assert.ok(live.brands.some(b => b.id === 'globalvet'));
  assert.ok(live.sources.some(s => s.name === 'Claude de la prueba'));
  assert.equal(live.proposals.pending.length, 1);
  assert.equal(live.proposals.pending[0].id, proposed.propuestaId);
  const sessions = groupSessions(live.items);
  assert.equal(sessions.length, 1, 'todo seguido: una sola sesión');
  assert.equal(sessions[0].counts.propose, 1);
  // la fila de la propuesta se liga por su id
  const propRow = live.items.find(r => r.entity?.type === 'proposal');
  assert.equal(propRow.entity.id, proposed.propuestaId);
  // sólo lo más nuevo que un id
  const mid = live.items[2].id;
  const fresh = await api('/api/mcp-live?after=' + mid);
  assert.deepEqual(
    fresh.items.map(r => r.id),
    live.items.filter(r => r.id > mid).map(r => r.id),
  );
  await api('/api/mcp-live?after=abc', { expected: 400 });
  // sólo las propuestas
  const props = await api('/api/mcp-live/proposals');
  assert.equal(props.pending.length, 1);
  assert.ok(Array.isArray(props.history));

  // ---- lo que dejó cada acción, leído de la base y como texto plano
  const ruleRow = live.items.find(r => r.entity?.type === 'rule');
  const e1 = (await api(`/api/mcp-live/entity/rule/${ruleRow.entity.id}?brand=globalvet`)).entity;
  assert.equal(e1.title, 'Horario (en vivo)');
  assert.equal(e1.label, 'Regla');
  assert.deepEqual(e1.screen, { view: 'reglas', label: 'Reglas' });
  assert.ok(
    e1.sends.items.some(i => i.value.includes('Atendemos de 9 a 18 h. <b>sin negrita</b>')),
    'texto tal cual',
  );
  const kRow = live.items.find(r => r.entity?.type === 'knowledge');
  const e2 = (await api(`/api/mcp-live/entity/knowledge/${kRow.entity.id}?brand=globalvet`)).entity;
  assert.equal(e2.title, '¿Dan factura?');
  assert.equal(e2.status, 'Borrador');
  assert.ok(e2.lines.some(l => l.label === 'Variantes' && l.value.includes('CFDI')));
  assert.ok(e2.lines.some(l => l.label === 'Respuesta'));
  // lo que no existe, otra marca o un tipo raro: no se muestra
  await api(`/api/mcp-live/entity/rule/${ruleRow.entity.id}?brand=odonteck`, { expected: 404 });
  await api('/api/mcp-live/entity/rule/no-existe?brand=globalvet', { expected: 404 });
  await api('/api/mcp-live/entity/contacto/x?brand=globalvet', { expected: 404 });
  await api(`/api/mcp-live/entity/rule/${ruleRow.entity.id}`, { expected: 400 });

  // ---- lo ya creado: una entrada por entidad que sigue existiendo, con su propuesta pendiente si la hay
  const flow = await tool('crear_recorrido', {
    nombre: 'Venta guiada (en vivo)',
    inicio: { type: 'first_message' },
    grafo: JSON.parse(JSON.stringify(EXAMPLE_GRAPH)),
    clientRef: 'live-' + randomUUID(),
  });
  assert.ok(flow.recorridoId, JSON.stringify(flow));
  const created = (await api('/api/mcp-live/created')).items;
  assert.deepEqual(
    created.map(x => x.type),
    ['flow', 'knowledge', 'rule'],
    'de la más reciente a la más antigua, sin propuestas',
  );
  const cRule = created.find(x => x.type === 'rule');
  assert.equal(cRule.title, 'Horario (en vivo)');
  assert.equal(cRule.proposalId, proposed.propuestaId, 'liga la propuesta pendiente');
  assert.equal(created.find(x => x.type === 'flow').proposalId, null);
  assert.ok(created.every(x => x.brandId === 'globalvet' && x.lastAt > 0 && x.touches >= 1 && x.screen));
  // el recorrido trae su diagrama
  const e3 = (await api(`/api/mcp-live/entity/flow/${flow.recorridoId}?brand=globalvet`)).entity;
  assert.equal(e3.diagram.nodes.length, 8);
  assert.deepEqual(e3.screen, { view: 'automatizacion', label: 'Automatización' });
  assert.equal((await api('/api/mcp-live/created?brand=globalvet')).items.length, 3);
  assert.deepEqual(
    (await api('/api/mcp-live/created?brand=odonteck')).items,
    [],
    'administración ve la otra marca: vacía',
  );
  await call(origin, '/api/mcp-live/created?brand=globalvet', { cookie: agentOd, expected: 404 });
  assert.deepEqual((await call(origin, '/api/mcp-live/created', { cookie: agentOd })).items, []);

  // ---- alcance: otra marca no ve GlobalVet; sin sesión o con llave no entra; sólo GET
  const od = await call(origin, '/api/mcp-live', { cookie: agentOd });
  assert.equal(od.items.length, 0);
  assert.equal(od.proposals.pending.length, 0);
  await call(origin, '/api/mcp-live?brand=globalvet', { cookie: agentOd, expected: 404 });
  await call(origin, '/api/mcp-live', { expected: 401 });
  // una llave del conector no es una sesión: no entra (401), y con sesión más llave tampoco (403)
  const withKey = await fetch(origin + '/api/mcp-live', { headers: { Authorization: 'Bearer ' + key } });
  assert.equal(withKey.status, 401);
  const both = await fetch(origin + '/api/mcp-live', { headers: { Authorization: 'Bearer ' + key, Cookie: admin } });
  assert.equal(both.status, 403);
  await api('/api/mcp-live', { method: 'POST', body: {}, expected: 405 });
  // el conector no tiene ninguna herramienta que lea esta pantalla
  const list = await fetch(origin + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
  });
  const names = (await list.json()).result.tools.map(x => x.name);
  assert.ok(!names.some(n => /vivo|live|actividad/.test(n)));
  assertSchemaCurrent(db);
});
