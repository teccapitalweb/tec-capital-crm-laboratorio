// Propuestas del asistente: los ocho puntos de la revisión de seguridad (docs/PLAN_MCP_CLAUDE.md, «Propuestas que
// aprueba una persona» → «Revisión de seguridad»). Cada prueba falla sin su corrección:
//  1. la tarjeta muestra lo que se enviará a los clientes (recorrido, secuencia, regla), recalculado desde la base;
//  2. el título es sólo la acción y el nombre va aparte, saneado;
//  3. tope por origen, ritmo al retirar, purga de las decididas e índices;
//  5. una propuesta de una llave revocada o caducada, de un permiso OAuth revocado o de un creador dado de baja no se
//     aprueba: pasa a «retirada» con su motivo;
//  6. una llave sólo ve y retira sus propias propuestas, y no se entera de la nota de otra;
//  7. la actividad de proponer y retirar guarda la propuesta, con una sola fila de auditoría;
//  8. publicar una apertura no cambia nada más que el estado ni genera eventos que la tarjeta no diga.
// (El punto 4, la purga de la actividad, está en test/mcp-actividad.test.mjs.) Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { fail } from '../server/app/http.mjs';
import { EXAMPLE_GRAPH } from '../server/lib/flow-guide.mjs';
import proposalsModule, { LIMITS, SOURCE_GONE, cleanName } from '../server/modules/mcp-proposals/module.mjs';
import { editionRoundTrip } from '../server/modules/mcp-proposals/actions.mjs';
import { PREVIEW, SENDS_TITLE, flowSends, ruleSends, sequenceSends } from '../server/modules/mcp-proposals/preview.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin } from './helpers/crm.mjs';

const ref = () => 'mcp-rev-' + randomUUID();
const DAY = 24 * 3600 * 1000;
const NAMES = {
  file: id => (id === 'f1' ? 'Temario.pdf' : null),
  material: () => 'Ficha aprobada',
  template: id => (id === 'w1' ? 'recordatorio_curso' : null),
  sequence: id => (id === 's1' ? 'Seguimiento de 3 días' : null),
  flow: () => 'Otro recorrido',
  tag: () => 'Interesado',
  user: () => 'Asesora',
  course: () => 'Aves',
};

test('vista previa de lo que se enviará: pasos en orden, nombres, tope de 12 y de 300 caracteres, texto plano', () => {
  const nodes = [{ id: 'n1', type: 'start', data: {} }];
  const edges = [];
  for (let i = 2; i <= 16; i++) {
    nodes.push({ id: 'n' + i, type: 'message', data: { parts: [{ kind: 'text', text: `Mensaje ${i} <b>x</b>` }] } });
    edges.push({ from: 'n' + (i - 1), port: 'next', to: 'n' + i });
  }
  nodes.push({ id: 'n99', type: 'message', data: { parts: [{ kind: 'text', text: 'Nunca se alcanza' }] } });
  const many = flowSends(JSON.stringify({ start: 'n1', nodes, edges }), NAMES);
  assert.equal(many.title, SENDS_TITLE);
  assert.match(many.note, /pudo escribirlos el asistente/);
  assert.equal(many.items.length, PREVIEW.items);
  assert.equal(many.more, 3, 'y 3 más');
  assert.equal(many.items[0].value, 'Mensaje 2 <b>x</b>', 'texto plano tal cual: la pantalla lo escapa');
  assert.equal(many.items[0].label, '1. Mensaje');
  assert.ok(!JSON.stringify(many).includes('Nunca se alcanza'), 'lo que no se alcanza no se envía');

  const long = 'x'.repeat(1000);
  const kinds = flowSends(
    {
      start: 'a',
      nodes: [
        { id: 'a', type: 'start', data: {} },
        { id: 'b', type: 'message', title: 'Saludo\u202e', data: { parts: [{ kind: 'text', text: long }] } },
        { id: 'c', type: 'template', data: { waTemplateId: 'w1' } },
        { id: 'd', type: 'sequence', data: { sequenceId: 's1' } },
        { id: 'e', type: 'message', data: { parts: [{ kind: 'media', fileId: 'f1', caption: 'El temario' }] } },
        {
          id: 'f',
          type: 'buttons',
          data: { text: '¿Te inscribo?', options: [{ id: 'o1', label: 'Sí', do: { type: 'goto' } }] },
        },
        { id: 'g', type: 'handoff', data: { text: 'Te paso con alguien.', to: 'queue' } },
        { id: 'h', type: 'tags', data: { add: ['t1'] } },
      ],
      edges: [
        { from: 'a', port: 'next', to: 'b' },
        { from: 'b', port: 'next', to: 'c' },
        { from: 'c', port: 'next', to: 'd' },
        { from: 'd', port: 'next', to: 'e' },
        { from: 'e', port: 'next', to: 'f' },
        { from: 'f', port: 'opt:o1', to: 'h' },
        { from: 'h', port: 'next', to: 'g' },
      ],
    },
    NAMES,
  );
  const v = kinds.items.map(x => x.value);
  assert.equal(v[0].length, PREVIEW.chars);
  assert.ok(v[0].endsWith('…'));
  assert.equal(kinds.items[0].label, '1. Saludo', 'sin caracteres de dirección');
  assert.equal(v[1], 'Envía la plantilla de WhatsApp «recordatorio_curso»');
  assert.match(v[2], /^Inscribe a la persona en la secuencia «Seguimiento de 3 días»/);
  assert.equal(v[3], '[Archivo «Temario.pdf»] El temario');
  assert.equal(v[4], '¿Te inscribo?\nBotones: Sí');
  assert.equal(v[5], 'Te paso con alguien.\nPasa la conversación a una persona del equipo');
  assert.equal(kinds.items.length, 6, 'las etiquetas no envían mensaje');

  const seq = sequenceSends(
    JSON.stringify([
      { timing: { base: 'enrolled', amount: 1, unit: 'days' }, send: { kind: 'text', text: '¿Viste la ficha?' } },
      { timing: { base: 'edition_start', daysBefore: 2, at: '10:00' }, send: { kind: 'template', templateId: 'w1' } },
    ]),
    NAMES,
  );
  assert.deepEqual(seq.items, [
    { label: 'Paso 1 · 1 día después de inscribirse', value: '¿Viste la ficha?' },
    { label: 'Paso 2 · 2 días antes del inicio, 10:00', value: 'Plantilla de WhatsApp «recordatorio_curso»' },
  ]);

  const rule = ruleSends(
    {
      trigger: { type: 'keyword', mode: 'contains', words: ['horario'] },
      actions: [
        { type: 'send_text', text: 'Abrimos de 9 a 18 h.' },
        { type: 'handoff', to: 'queue' },
      ],
      options: { limit: 'once_conversation' },
    },
    NAMES,
  );
  assert.deepEqual(rule.items, [
    {
      label: 'Cuándo se dispara',
      value: 'Contiene la palabra: «horario» · Una sola vez por conversación',
    },
    { label: 'Acción 1 · Responder con un texto', value: 'Abrimos de 9 a 18 h.' },
    { label: 'Acción 2 · Pasar con una persona', value: 'A la cola del equipo' },
  ]);
});

test('el nombre de la entidad va saneado: una línea, sin comillas, sin controles ni dirección, recortado', () => {
  assert.equal(
    cleanName('Info» ya revisado\ny aprobado por\u202e administración «ok\u0007'),
    'Info ya revisado y aprobado por administración ok',
  );
  assert.equal(cleanName('Dijo "sí" y “no” `x`'), 'Dijo sí y no x');
  assert.equal(cleanName('a\u2028b\u2029c\ufeff'), 'a b c');
  assert.equal(cleanName('n'.repeat(500)).length, LIMITS.nameLength);
  assert.equal(cleanName({ html: 1 }), '');
});

test('publicar una apertura desde aquí no cambia nada más que el estado: si cambiaría otro dato, no se propone', () => {
  const base = { name: 'Marzo', instructor: 'Docente', location: '', info_url: '', timezone: 'America/Mexico_City' };
  assert.deepEqual(editionRoundTrip({ ...base, legacy: 0 }), []);
  assert.deepEqual(editionRoundTrip({ ...base, instructor: '  Docente  ', legacy: 0 }), ['docente']);
  assert.deepEqual(editionRoundTrip({ ...base, name: 'x'.repeat(130), legacy: 1 }), [
    'nombre',
    'marca de apertura del catálogo anterior',
  ]);
});

test('propuestas: purga de las decididas a los 90 días, por trozos, e índices para cada consulta', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-propuestas-purga-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false });
  assertSchemaCurrent(db);
  const host = {
    db,
    fail,
    json: () => {},
    body: async () => ({}),
    audit: () => {},
    transaction,
    rate: () => {},
    access: {},
    services: {},
  };
  const api = proposalsModule.create(host);
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO mcp_proposals(id,brand_id,action,entity_type,entity_id,entity_revision,source_kind,source_id,status,
       created_at,updated_at,expires_at) VALUES(?,'globalvet','activar_regla','rule',?,1,'key','k1',?,?,?,?)`,
  );
  const old = now - LIMITS.keepDecidedMs - DAY;
  const statuses = ['approved', 'rejected', 'withdrawn', 'expired', 'stale', 'failed'];
  for (let i = 0; i < 1210; i++) insert.run(randomUUID(), 'r' + i, statuses[i % statuses.length], old, old, old);
  insert.run('viejo-pendiente', 'p1', 'pending', old, old, now + DAY);
  insert.run('viejo-aprobandose', 'p2', 'approving', old, old, now + DAY);
  insert.run('reciente', 'r-new', 'approved', now, now, now);
  assert.equal(api.purge(now), 1210, 'en una vuelta, por trozos de ' + LIMITS.purgeChunk);
  assert.deepEqual(
    db
      .prepare('SELECT id FROM mcp_proposals ORDER BY id')
      .all()
      .map(r => r.id),
    ['reciente', 'viejo-aprobandose', 'viejo-pendiente'],
    'las pendientes y las recientes se quedan',
  );
  assert.equal(typeof api.sweep().purged, 'number', 'el reloj también purga');

  const plan = sql => JSON.stringify(db.prepare('EXPLAIN QUERY PLAN ' + sql).all());
  assert.match(
    plan(
      "SELECT * FROM mcp_proposals WHERE brand_id IN ('globalvet') AND status NOT IN ('pending','approving') ORDER BY updated_at DESC LIMIT 50",
    ),
    /mcp_proposals_history/,
  );
  assert.match(
    plan(
      "SELECT * FROM mcp_proposals WHERE brand_id='globalvet' AND source_kind='key' AND source_id='k1' ORDER BY created_at DESC LIMIT 50",
    ),
    /mcp_proposals_source/,
  );
  assert.match(
    plan("SELECT * FROM mcp_proposals WHERE status='pending' AND expires_at<=1"),
    /mcp_proposals_due|mcp_proposals_brand/,
  );
  assert.match(
    plan(
      "SELECT id FROM mcp_proposals WHERE status NOT IN ('pending','approving') AND updated_at<1 ORDER BY updated_at LIMIT 500",
    ),
    /mcp_proposals_decided/,
  );
});

test('propuestas de punta a punta: lo que se enviará, nombre aparte, origen propio y vigente, actividad y apertura', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-propuestas-rev-'));
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
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const creator = await register('creadora', 'Creadora de prueba');
  db.prepare("UPDATE users SET role='admin' WHERE username='creadora'").run();

  const ALL = ['proposals', 'automation_drafts', 'config_drafts'];
  const keyFor = async (cookie, name, scopes = ALL) => {
    const made = await call(origin, '/api/integrations/keys', {
      cookie,
      body: { brandId: 'globalvet', name, scopes },
      expected: 201,
    });
    return { token: made.token, id: db.prepare('SELECT id FROM api_keys WHERE name=?').get(name).id };
  };
  let rid = 0;
  const tool = async (token, name, args = {}) => {
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
    });
    const out = (await r.json()).result;
    return out.isError ? { error: out.content[0].text } : JSON.parse(out.content[0].text);
  };
  const ok = async (...a) => {
    const r = await tool(...a);
    assert.equal(r.error, undefined, a[1] + ': ' + r.error);
    return r;
  };
  const decide = async (id, expected = 200) => {
    const r = await fetch(origin + `/api/mcp-proposals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: admin, Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const out = await r.json();
    assert.equal(r.status, expected, JSON.stringify(out));
    return out;
  };
  const overview = () => call(origin, '/api/mcp-proposals', { cookie: admin });
  const card = async id => (await overview()).pending.find(p => p.id === id);
  const proposal = id => db.prepare('SELECT * FROM mcp_proposals WHERE id=?').get(id);
  const ruleDef = word => ({
    trigger: { type: 'keyword', mode: 'contains', words: [word] },
    actions: [{ type: 'send_text', text: 'Nuestro horario es de 9 a 18 h. <i>Gracias</i>' }],
  });
  const newRule = async (token, title, word = 'rev-' + randomUUID().slice(0, 8)) =>
    (await ok(token, 'crear_regla', { titulo: title, definicion: ruleDef(word), clientRef: ref() })).reglaId;

  const A = await keyFor(admin, 'Asistente A');
  const B = await keyFor(admin, 'Asistente B');

  // ================= 1. lo que se enviará a los clientes
  const graph = JSON.parse(JSON.stringify(EXAMPLE_GRAPH));
  graph.nodes[1].data.parts[0].text = 'Hola <b>de la prueba</b>, gracias por escribir a {{marca}}.';
  const flow = await ok(A.token, 'crear_recorrido', {
    nombre: 'Recorrido de la revisión',
    inicio: { type: 'first_message' },
    grafo: graph,
    clientRef: ref(),
  });
  const pFlow = await ok(A.token, 'proponer_accion', { accion: 'publicar_recorrido', id: flow.recorridoId });
  const flowCard = await card(pFlow.propuestaId);
  assert.equal(flowCard.sends.title, 'Lo que se enviará a los clientes');
  assert.match(flowCard.sends.note, /pudo escribirlos el asistente/);
  const flowText = flowCard.sends.items.map(i => i.label + ': ' + i.value).join('\n');
  assert.match(flowText, /Saludo: Hola <b>de la prueba<\/b>, gracias por escribir a \{\{marca\}\}\./);
  assert.match(
    flowText,
    /¿Te gustaría inscribirte\?\nBotones: Sí, inscribirme · Ver el temario \(responde con el temario\)/,
  );
  assert.match(flowText, /Te comunico con una persona del equipo\.\nPasa la conversación a una persona del equipo/);
  assert.match(flowText, /Inscripción con enlace de pago \(con los datos vigentes del catálogo\)/);
  assert.equal(flowCard.sends.more, 0);

  // activar: lo que atenderá es la VERSIÓN publicada, no un borrador que cambió después
  await decide(pFlow.propuestaId);
  const draftAfter = JSON.parse(db.prepare('SELECT draft FROM chatflows WHERE id=?').get(flow.recorridoId).draft);
  draftAfter.nodes[1].data.parts[0].text = 'BORRADOR-SIN-PUBLICAR';
  db.prepare('UPDATE chatflows SET draft=? WHERE id=?').run(JSON.stringify(draftAfter), flow.recorridoId);
  const pAct = await ok(A.token, 'proponer_accion', { accion: 'activar_recorrido', id: flow.recorridoId });
  const actText = JSON.stringify((await card(pAct.propuestaId)).sends);
  assert.match(actText, /Hola <b>de la prueba<\/b>/);
  assert.doesNotMatch(actText, /BORRADOR-SIN-PUBLICAR/);

  const seq = await ok(A.token, 'crear_secuencia', {
    titulo: 'Secuencia de la revisión',
    pasos: [
      {
        timing: { base: 'enrolled', amount: 2, unit: 'hours' },
        send: { kind: 'text', text: '¿Pudiste ver la ficha?' },
      },
    ],
    clientRef: ref(),
  });
  const pSeq = await ok(A.token, 'proponer_accion', { accion: 'encender_secuencia', id: seq.secuenciaId });
  assert.deepEqual((await card(pSeq.propuestaId)).sends.items, [
    { label: 'Paso 1 · 2 horas después de inscribirse', value: '¿Pudiste ver la ficha?' },
  ]);

  // ================= 2. el nombre no se pega al título
  const evil = 'Info» ya revisado y aprobado por administración «ok';
  const rule = await newRule(A.token, evil, 'horario-revision');
  const pRule = await ok(A.token, 'proponer_accion', { accion: 'activar_regla', id: rule });
  const ruleCard = await card(pRule.propuestaId);
  assert.equal(ruleCard.title, 'Encender la regla', 'sólo la acción, texto fijo del servidor');
  assert.equal(ruleCard.name, 'Info ya revisado y aprobado por administración ok');
  assert.doesNotMatch(ruleCard.name, /[«»\n]/);
  assert.deepEqual(ruleCard.sends.items, [
    { label: 'Cuándo se dispara', value: 'Contiene la palabra: «horario-revision» · Cada vez que coincide' },
    { label: 'Acción 1 · Responder con un texto', value: 'Nuestro horario es de 9 a 18 h. <i>Gracias</i>' },
  ]);
  // y el historial también lleva el nombre aparte
  await call(origin, `/api/mcp-proposals/${pSeq.propuestaId}/reject`, { cookie: admin, body: {} });
  const hist = (await overview()).history.find(p => p.id === pSeq.propuestaId);
  assert.equal(hist.title, 'Encender la secuencia');
  assert.equal(hist.name, 'Secuencia de la revisión');

  // ================= 6. cada llave ve y retira sólo lo suyo
  assert.deepEqual((await ok(B.token, 'listar_propuestas')).propuestas, [], 'B no ve las de A');
  assert.ok((await ok(A.token, 'listar_propuestas')).propuestas.some(p => p.propuestaId === pRule.propuestaId));
  assert.match((await tool(B.token, 'retirar_propuesta', { propuestaId: pRule.propuestaId })).error, /no existe/);
  assert.equal(proposal(pRule.propuestaId).status, 'pending');
  const already = await tool(B.token, 'proponer_accion', { accion: 'activar_regla', id: rule, nota: 'otra' });
  assert.match(already.error, /Ya hay una propuesta pendiente para eso mismo \(regla\)/);
  assert.doesNotMatch(already.error, /Asistente A|Administración/);

  // ================= 7. la actividad de proponer y retirar lleva la propuesta; una sola auditoría por acción
  const activityOf = (toolName, keyId) =>
    db.prepare('SELECT * FROM mcp_activity WHERE tool=? AND key_id=? ORDER BY id DESC LIMIT 1').get(toolName, keyId);
  const auditCount = (action, id) =>
    db.prepare('SELECT count(*) n FROM audit WHERE action=? AND entity_id=?').get(action, id).n;
  const proposed = activityOf('proponer_accion', A.id);
  assert.deepEqual([proposed.entity_type, proposed.entity_id], ['proposal', pRule.propuestaId]);
  assert.equal(auditCount('mcp.proposal.create', pRule.propuestaId), 1);
  await ok(A.token, 'retirar_propuesta', { propuestaId: pRule.propuestaId });
  const withdrawn = activityOf('retirar_propuesta', A.id);
  assert.deepEqual([withdrawn.entity_type, withdrawn.entity_id], ['proposal', pRule.propuestaId]);
  assert.equal(auditCount('mcp.proposal.withdraw', pRule.propuestaId), 1);
  const page = await call(origin, '/api/mcp-activity?source=key:' + A.id, { cookie: admin });
  assert.deepEqual(page.items.find(i => i.tool === 'retirar_propuesta').entity, {
    type: 'proposal',
    label: 'Propuesta',
    id: pRule.propuestaId,
  });

  // ================= 3. tope por origen y ritmo al retirar
  const fill = db.prepare(
    `INSERT INTO mcp_proposals(id,brand_id,action,entity_type,entity_id,entity_revision,source_kind,source_id,
       proposed_by,status,created_at,updated_at,expires_at) VALUES(?,'globalvet','activar_regla','rule',?,1,'key',?,NULL,'pending',?,?,?)`,
  );
  const countMine = db.prepare(
    "SELECT count(*) n FROM mcp_proposals WHERE source_id=? AND status IN ('pending','approving')",
  );
  const filler = [];
  const another = await newRule(A.token, 'Regla para el tope por origen');
  // Las filas de relleno apuntan a reglas que no existen, y el mantenimiento (cada segundo en las pruebas) las marca
  // obsoletas. Si esa vuelta cae justo entre rellenar y proponer, la propuesta entra: se deshace y se repite el tramo.
  let capped;
  for (let attempt = 0; attempt < 6 && !capped; attempt++) {
    for (let i = countMine.get(A.id).n; i < LIMITS.pendingPerSource; i++) {
      const id = randomUUID();
      filler.push(id);
      fill.run(id, `relleno-${attempt}-${i}`, A.id, Date.now(), Date.now(), Date.now() + DAY);
    }
    const tried = await tool(A.token, 'proponer_accion', { accion: 'activar_regla', id: another });
    if (tried.error) capped = tried.error;
    else db.prepare('DELETE FROM mcp_proposals WHERE id=?').run(tried.propuestaId);
  }
  assert.match(capped, new RegExp(`Esta llave o conexión ya tiene ${LIMITS.pendingPerSource} propuestas pendientes`));
  // otra llave de la misma marca sí puede (el tope es por origen; el de la marca es otro)
  const pOther = await ok(B.token, 'proponer_accion', { accion: 'activar_regla', id: another });
  for (const id of filler) db.prepare('DELETE FROM mcp_proposals WHERE id=?').run(id);
  const W = await keyFor(admin, 'Asistente que retira mucho', ['proposals']);
  for (let i = 0; i < LIMITS.withdrawPerMinute; i++)
    assert.match((await tool(W.token, 'retirar_propuesta', { propuestaId: 'x' + i })).error, /no existe/);
  assert.match((await tool(W.token, 'retirar_propuesta', { propuestaId: 'otra' })).error, /Demasiados intentos/);

  // ================= 5. el origen debe seguir vigente para aprobar
  // a) llave revocada: al aprobar no se ejecuta nada y queda retirada con el motivo
  await call(origin, `/api/integrations/keys/${B.id}/revoke`, { cookie: admin, body: {} });
  const refused = await decide(pOther.propuestaId, 409);
  assert.equal(refused.code, 'source_inactive');
  assert.equal(refused.error, SOURCE_GONE);
  assert.deepEqual(
    [proposal(pOther.propuestaId).status, proposal(pOther.propuestaId).error],
    ['withdrawn', SOURCE_GONE],
  );
  assert.equal(db.prepare('SELECT status FROM automation_rules WHERE id=?').get(another).status, 'draft');
  // b) creadora dada de baja: al listar en la pantalla ya no aparece pendiente; queda en el historial con el motivo
  const C = await keyFor(creator, 'Asistente de la creadora');
  const cRule = await newRule(C.token, 'Regla de la creadora');
  const pC = await ok(C.token, 'proponer_accion', { accion: 'activar_regla', id: cRule });
  db.prepare("UPDATE users SET disabled=1 WHERE username='creadora'").run();
  const listed = await overview();
  assert.equal(
    listed.pending.some(p => p.id === pC.propuestaId),
    false,
  );
  const gone = listed.history.find(p => p.id === pC.propuestaId);
  assert.deepEqual([gone.status, gone.statusLabel, gone.error], ['withdrawn', 'Retirada', SOURCE_GONE]);
  await decide(pC.propuestaId, 409);
  // c) llave caducada: la retira el reloj del módulo, sin que nadie abra la pantalla
  const E = await keyFor(admin, 'Asistente que caduca');
  const eRule = await newRule(E.token, 'Regla de la llave que caduca');
  const pE = await ok(E.token, 'proponer_accion', { accion: 'activar_regla', id: eRule });
  db.prepare('UPDATE api_keys SET expires_at=? WHERE id=?').run(Date.now() - 1000, E.id);
  for (let i = 0; i < 80 && proposal(pE.propuestaId).status === 'pending'; i++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual([proposal(pE.propuestaId).status, proposal(pE.propuestaId).error], ['withdrawn', SOURCE_GONE]);
  // d) permiso OAuth revocado
  const redirect = 'http://127.0.0.1:4545/callback';
  const client = await (
    await fetch(origin + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Asistente OAuth de la revisión', redirect_uris: [redirect] }),
    })
  ).json();
  const verifier = randomBytes(32).toString('base64url');
  const consent = await (
    await fetch(
      origin +
        '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: redirect,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
          state: 's',
          resource: origin + '/mcp',
        }),
      { headers: { Cookie: admin } },
    )
  ).text();
  const attr = name => consent.match(new RegExp(`data-${name}="([^"]+)"`))?.[1];
  const decision = await (
    await fetch(origin + '/oauth/decision', {
      method: 'POST',
      headers: { Cookie: admin, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: attr('request'),
        csrf: attr('csrf'),
        decision: 'allow',
        brandId: 'globalvet',
        scopes: ['proposals', 'automation_drafts'],
      }),
    })
  ).json();
  const tokens = await (
    await fetch(origin + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(decision.redirect).searchParams.get('code'),
        redirect_uri: redirect,
        client_id: client.client_id,
        code_verifier: verifier,
      }),
    })
  ).json();
  const oRule = await newRule(tokens.access_token, 'Regla del asistente OAuth');
  const pO = await ok(tokens.access_token, 'proponer_accion', { accion: 'activar_regla', id: oRule });
  assert.deepEqual(
    (await ok(tokens.access_token, 'listar_propuestas')).propuestas.map(p => p.propuestaId),
    [pO.propuestaId],
    'el permiso OAuth ve sólo lo suyo',
  );
  const grantId = db.prepare('SELECT id FROM mcp_oauth_grants').get().id;
  const revoke = await fetch(origin + `/api/mcp-oauth/connections/${grantId}/revoke`, {
    method: 'POST',
    headers: { Cookie: admin, Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(revoke.status, 200);
  assert.equal((await decide(pO.propuestaId, 409)).code, 'source_inactive');
  assert.equal(db.prepare('SELECT status FROM automation_rules WHERE id=?').get(oRule).status, 'draft');

  // ================= 8. publicar una apertura: sólo cambia el estado, y la tarjeta dice qué pasa con los avisos
  const ed = await ok(A.token, 'crear_apertura_borrador', {
    cursoId: 'aves',
    nombre: 'Mayo 2027 (revisión)',
    inicio: '2027-05-01 19:00',
    fin: '2027-05-01 21:00',
    zona: 'America/Mexico_City',
    docente: 'Docente de la revisión',
    modalidad: 'online',
    precio: 1500,
    cupo: 20,
    cupoDisponible: 20,
    clientRef: ref(),
  });
  const pEd = await ok(A.token, 'proponer_accion', { accion: 'publicar_apertura', id: ed.aperturaId });
  const edCard = await card(pEd.propuestaId);
  assert.match(edCard.effect, /no cambia su precio ni su cupo/);
  assert.match(edCard.effect, /destinos de webhooks configurados/);
  const detail = Object.fromEntries(edCard.details.map(d => [d.label, d.value]));
  assert.equal(detail.Docente, 'Docente de la revisión');
  assert.ok(detail.Fin && detail.Inicio && detail.Precio && detail.Cupo);
  const before = db.prepare('SELECT * FROM editions WHERE id=?').get(ed.aperturaId);
  const events = () => db.prepare('SELECT count(*) n FROM domain_events WHERE entity_id=?').get(ed.aperturaId).n;
  const eventsBefore = events();
  await decide(pEd.propuestaId);
  const after = db.prepare('SELECT * FROM editions WHERE id=?').get(ed.aperturaId);
  const strip = ({ status, revision, updated_at, ...rest }) => rest;
  assert.equal(after.status, 'published');
  assert.deepEqual(strip(after), strip(before), 'aprobar no cambió nada más que el estado');
  assert.equal(events(), eventsBefore, 'sin eventos de precio ni de cupo por publicarla');
  // si el catálogo guardaría otro dato distinto (aquí, el docente con espacios), no se propone desde aquí
  const ed2 = await ok(A.token, 'crear_apertura_borrador', {
    cursoId: 'aves',
    nombre: 'Junio 2027 (revisión)',
    inicio: '2027-06-01 19:00',
    zona: 'America/Mexico_City',
    modalidad: 'online',
    precio: 1500,
    clientRef: ref(),
  });
  db.prepare("UPDATE editions SET instructor='  Docente con espacios  ' WHERE id=?").run(ed2.aperturaId);
  const notReady = await tool(A.token, 'proponer_accion', { accion: 'publicar_apertura', id: ed2.aperturaId });
  assert.match(notReady.error, /cambiaría además: docente/);
});
