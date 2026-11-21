// Conector de Claude: armar recorridos, secuencias y accesos en BORRADOR (docs/PLAN_MCP_CLAUDE.md). Protocolo, permiso
// propio, alcance por marca, mismas rutas que la pantalla, idempotencia, revisión vigente, simulador sin efectos y todo
// lo que el conector NO puede hacer (publicar, activar, encender, inscribir, enviar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TOOLS, invalid } from '../server/mcp.mjs';
import { DRAFT_SCOPE, DRAFT_TOOLS, ROUTES, createDraftTools, routeAllowed } from '../server/lib/mcp-drafts.mjs';
import { FEW } from '../server/lib/mcp-call.mjs';
import { EXAMPLE_GRAPH, flowGuide } from '../server/lib/flow-guide.mjs';
import { NODE_TYPES, repairGraph, validateGraph } from '../public/kit/shared/flow-model.js';
import { unsupportedProblems } from '../public/kit/shared/flow-support.js';
import { START_TYPES, KEYWORD_MODES } from '../server/modules/chatflows/module.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

const FORBIDDEN =
  /^(status|estado|enabled|encendid[oa]|activ[oa]|publicad[oa]|published|publicar|activar|enviar|inscribir)$/i;
// Todas las claves de propiedades de un esquema, a cualquier profundidad.
function keysOf(schema, out = []) {
  for (const [k, s] of Object.entries(schema?.properties || {})) {
    out.push(k);
    keysOf(s, out);
    if (s.items) keysOf(s.items, out);
  }
  return out;
}

test('herramientas de borradores: permiso propio, sin nada que publique, active, encienda o envíe', () => {
  const names = DRAFT_TOOLS.map(t => t.name);
  assert.deepEqual(names.sort(), [
    'actualizar_recorrido',
    'actualizar_secuencia',
    'crear_recorrido',
    'crear_secuencia',
    'escribir_acceso',
    'guia_recorridos',
    'listar_accesos',
    'listar_recorridos',
    'listar_secuencias',
    'listas_de_la_marca',
    'probar_recorrido',
    'revisar_recorrido',
    'ver_recorrido',
    'ver_secuencia',
  ]);
  for (const t of DRAFT_TOOLS) {
    assert.equal(t.scope, DRAFT_SCOPE, t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.doesNotMatch(t.name, /publicar|activar|pausar|archivar|borrar|eliminar|encender|inscribir|enviar|cobrar/);
    const bad = keysOf(t.inputSchema).filter(k => FORBIDDEN.test(k));
    assert.deepEqual(bad, [], t.name + ' no tiene datos de estado');
    assert.ok(TOOLS.includes(t), 'el conector la anuncia');
  }
  // sólo estas rutas de los módulos; publicar, activar, pausar, archivar, iniciar, encender, inscribir y enviar no
  for (const [name, method, path] of [
    ['chatflows', 'GET', '/api/chatflows'],
    ['chatflows', 'GET', '/api/chatflows/lists'],
    ['chatflows', 'POST', '/api/chatflows'],
    ['chatflows', 'GET', '/api/chatflows/f-1'],
    ['chatflows', 'PUT', '/api/chatflows/f-1/draft'],
    ['chatflows', 'POST', '/api/chatflows/f-1/validate'],
    ['chatflows', 'POST', '/api/chatflows/f-1/simulate'],
    ['sequences', 'POST', '/api/sequences'],
    ['sequences', 'PUT', '/api/sequences/s-1'],
    ['course-access', 'PUT', '/api/course-access/editions/e1'],
    ['course-access', 'POST', '/api/course-access/editions/e1/preview'],
  ])
    assert.ok(routeAllowed(name, method, path), method + ' ' + path);
  for (const [name, method, path] of [
    ['chatflows', 'POST', '/api/chatflows/f-1/publish'],
    ['chatflows', 'POST', '/api/chatflows/f-1/activate'],
    ['chatflows', 'POST', '/api/chatflows/f-1/pause'],
    ['chatflows', 'POST', '/api/chatflows/f-1/archive'],
    ['chatflows', 'POST', '/api/chatflows/f-1/duplicate'],
    ['chatflows', 'POST', '/api/chatflows/f-1/suggestions'],
    ['chatflows', 'POST', '/api/chatflows/files'],
    ['chatflows', 'POST', '/api/chatflows/conversations/c-1'],
    ['chatflows', 'DELETE', '/api/chatflows/conversations/c-1'],
    ['chatflows', 'GET', '/api/chatflows/f-1/sessions'],
    ['chatflows', 'GET', '/api/chatflows/f-1/log'],
    ['chatflows', 'PUT', '/api/chatflows/f-1/draft/../publish'],
    ['chatflows', 'DELETE', '/api/chatflows/f-1'],
    ['sequences', 'POST', '/api/sequences/s-1/enable'],
    ['sequences', 'POST', '/api/sequences/s-1/disable'],
    ['sequences', 'POST', '/api/sequences/s-1/archive'],
    ['sequences', 'POST', '/api/sequences/s-1/preview'],
    ['sequences', 'POST', '/api/sequences/conversations/c-1'],
    ['sequences', 'POST', '/api/sequences/enrollments/x/stop'],
    ['course-access', 'POST', '/api/course-access/editions/e1/send-pending'],
    ['course-access', 'POST', '/api/course-access/enrollments/x/send'],
    ['inbox', 'GET', '/api/inbox'],
    ['chatflows', 'GET', '/api/sequences'],
  ])
    assert.equal(routeAllowed(name, method, path), false, method + ' ' + path);
  assert.ok(ROUTES.every(([, method]) => ['GET', 'POST', 'PUT'].includes(method)));

  // el esquema se hace cumplir también por dentro del grafo, los ajustes y el inicio
  const create = DRAFT_TOOLS.find(t => t.name === 'crear_recorrido').inputSchema;
  const ok = { nombre: 'Venta', clientRef: 'ref-12345678', grafo: { nodes: [], edges: [] } };
  assert.equal(invalid(create, ok), null);
  assert.match(invalid(create, { ...ok, estado: 'published' }), /Dato no reconocido: estado/);
  assert.match(invalid(create, { ...ok, grafo: { nodes: [], edges: [], status: 'active' } }), /grafo\.status/);
  assert.match(invalid(create, { ...ok, grafo: { nodes: ['x'], edges: [] } }), /«grafo\.nodes» debe ser una lista/);
  assert.match(invalid(create, { ...ok, grafo: { nodes: [] } }), /Falta: grafo\.edges/);
  assert.match(invalid(create, { ...ok, inicio: { type: 'siempre' } }), /inicio\.type» sólo admite/);
  assert.match(invalid(create, { ...ok, inicio: { type: 'manual', activo: true } }), /inicio\.activo/);
  assert.match(invalid(create, { ...ok, ajustes: { channels: ['correo'] } }), /channels» sólo admite/);
  assert.match(invalid(create, { ...ok, ajustes: { enabled: true } }), /ajustes\.enabled/);
  assert.match(invalid(create, { ...ok, ajustes: { reentry: { cooldownMinutes: 5, x: 1 } } }), /reentry\.x/);
  assert.equal(invalid(create, { ...ok, ajustes: { reentry: 'once_conversation', maxMisses: 2 } }), null);
  assert.match(invalid(create, { ...ok, ajustes: { maxMisses: 9 } }), /fuera del rango/);
  assert.match(invalid(create, { nombre: 'x' }), /Falta: clientRef/);
  const seq = DRAFT_TOOLS.find(t => t.name === 'actualizar_secuencia').inputSchema;
  assert.match(invalid(seq, { secuenciaId: 's', revision: 1, enabled: true }), /Dato no reconocido: enabled/);
  const acc = DRAFT_TOOLS.find(t => t.name === 'escribir_acceso').inputSchema;
  assert.match(invalid(acc, { aperturaId: 'e', revision: 0, texto: 'x', enabled: true }), /Dato no reconocido/);
  assert.match(invalid(acc, { aperturaId: 'e', revision: 0, texto: 'x'.repeat(2001) }), /demasiado largo/);
});

test('la guía sale del modelo compartido y su ejemplo pasa la revisión', () => {
  const guide = flowGuide({ startTypes: START_TYPES, keywordModes: KEYWORD_MODES });
  assert.deepEqual(
    guide.tiposDePaso.map(t => t.tipo),
    Object.keys(NODE_TYPES),
  );
  const size = JSON.stringify(guide).length;
  assert.ok(size < 40_000, 'compacta: ' + size);
  const buttons = guide.tiposDePaso.find(t => t.tipo === 'buttons');
  assert.equal(buttons.esperaRespuesta, true);
  assert.ok(buttons.salidasSegunDatos);
  assert.ok(buttons.campos.some(f => f.campo === 'options' && f.cadaElemento.some(x => x.campo === 'do.type')));
  assert.ok(guide.tiposDePaso.find(t => t.tipo === 'webhook').noDisponible);
  assert.deepEqual(guide.tiposDePaso.find(t => t.tipo === 'handoff').valoresQueElServidorNoEjecuta, [
    { campo: 'to', valores: ['last'] },
  ]);
  assert.deepEqual(Object.keys(guide.inicio.tipos), Object.keys(START_TYPES));
  // con «tipos» sólo trae el detalle de esos
  const one = flowGuide({ startTypes: START_TYPES, keywordModes: KEYWORD_MODES, tipos: ['enroll'] });
  assert.ok(one.tiposDePaso.find(t => t.tipo === 'enroll').salidas);
  assert.equal(one.tiposDePaso.find(t => t.tipo === 'buttons').salidas, undefined);
  // el ejemplo: sin reparaciones, sin errores ni avisos y nada que el servidor no ejecute
  const { graph, repairs } = repairGraph(EXAMPLE_GRAPH);
  assert.deepEqual(repairs, []);
  const result = validateGraph(graph, { courses: [{ id: 'k', title: 'Curso' }] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(unsupportedProblems(graph, { settings: { channels: ['whatsapp'] } }), []);
});

test('armar recorridos, secuencias y accesos en borrador de punta a punta, sin publicar ni enviar nada', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-mcp-borradores-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' } });
  let db = null;
  t.after(async () => {
    try {
      db?.close();
    } catch {}
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = server.origin;
  const admin = await registerAdmin(origin, code);
  db = openDb(dir);
  const api = (path, options = {}) => call(origin, path, { cookie: admin, ...options });
  const keyFor = async (brandId, scopes, name = 'Claude ' + scopes.join(' ')) =>
    (await api('/api/integrations/keys', { body: { brandId, name, scopes }, expected: 201 })).token;
  let rid = 0;
  const rpc = async (token, method, params) => {
    const id = ++rid;
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.id, id);
    return body;
  };
  const tool = async (token, name, args = {}) => {
    const r = (await rpc(token, 'tools/call', { name, arguments: args })).result;
    return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
  };
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const sideEffects = () => ({
    messages: count('SELECT count(*) n FROM messages'),
    sessions: count('SELECT count(*) n FROM chatflow_sessions'),
    orders: count('SELECT count(*) n FROM orders'),
    enrollments: count('SELECT count(*) n FROM sequence_enrollments'),
    deliveries: count('SELECT count(*) n FROM course_access_deliveries'),
    versions: count('SELECT count(*) n FROM chatflow_versions'),
    conversations: count('SELECT count(*) n FROM conversations'),
    steps: count("SELECT count(*) n FROM automation_steps WHERE state IN ('pending','reserved')"),
  });

  // una persona real escribe antes: sus datos no deben salir por estas herramientas
  const ana = await call(origin, '/api/auth/register', {
    body: { username: 'ana', name: 'Ana Pérez Privada', password: PASSWORD },
  });
  const conv = (
    await call(origin, '/api/conversations', { cookie: ana.cookie, body: { courseId: 'aves', channel: 'whatsapp' } })
  ).conversation.id;
  await call(origin, '/api/conversations/' + conv + '/messages', {
    cookie: ana.cookie,
    body: { text: 'Hola, mi teléfono es 5512345678', clientRef: randomUUID() },
    expected: 201,
  });
  await until(
    () => db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation'").get(conv),
    'respuesta del asistente',
  );

  const drafts = await keyFor('globalvet', [DRAFT_SCOPE]);
  const reader = await keyFor('globalvet', ['editions']);
  const other = await keyFor('odonteck', [DRAFT_SCOPE]);

  // ---- 1) protocolo y permiso propio
  const init = (await rpc(drafts, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })).result;
  assert.match(init.instructions, /BORRADORES/);
  assert.match(init.instructions, /lo hace una persona en el CRM/);
  const listed = (await rpc(drafts, 'tools/list')).result.tools.map(x => x.name);
  for (const t of DRAFT_TOOLS) assert.ok(listed.includes(t.name), t.name);
  assert.ok(!listed.some(n => /publicar|activar|encender|inscribir|enviar/.test(n)));
  for (const name of ['publicar_recorrido', 'activar_recorrido', 'encender_secuencia', 'enviar_accesos'])
    assert.equal((await rpc(drafts, 'tools/call', { name, arguments: {} })).error.code, -32602, name);
  assert.match((await tool(reader, 'guia_recorridos')).error, /no tiene el permiso «Claude: armar recorridos/);
  assert.match((await tool(reader, 'listar_recorridos')).error, /no tiene el permiso/);
  for (const [name, args] of [
    ['buscar_contactos', {}],
    ['listar_conversaciones', {}],
    ['ver_conversacion', { conversacionId: conv }],
    ['listar_pedidos', {}],
    ['actualizar_curso', { cursoId: 'aves', version: 1, titulo: 'x' }],
  ])
    assert.match((await tool(drafts, name, args)).error, /no tiene el permiso/, name + ': sin contactos ni mensajes');
  const sum = await tool(drafts, 'resumen');
  assert.deepEqual(Object.keys(sum).sort(), ['llave', 'marca', 'permisos', 'puedeModificar', 'recorridosPorEstado']);
  assert.match(sum.puedeModificar, /nunca publica/);

  // ---- 2) guía y listas (las del editor, con ids reales de la marca)
  const guide = await tool(drafts, 'guia_recorridos');
  assert.ok(guide.tiposDePaso.length === Object.keys(NODE_TYPES).length);
  assert.deepEqual(guide.ejemplo.grafo, JSON.parse(JSON.stringify(EXAMPLE_GRAPH)));
  const { listas } = await tool(drafts, 'listas_de_la_marca');
  const editor = (await api('/api/chatflows/lists?brand=globalvet')).lists;
  assert.deepEqual(listas, editor, 'las mismas listas que recibe el editor');
  assert.ok(listas.courses.some(k => k.id === 'aves'));
  assert.ok(
    listas.courses.every(k => db.prepare('SELECT brand_id FROM courses WHERE id=?').get(k.id).brand_id === 'globalvet'),
  );

  // ---- 3) crear el borrador: saludo → ¿qué curso? → ficha → botones → inscripción con enlace de pago o una persona
  const before = sideEffects();
  const clientRef = 'mcp-' + randomUUID();
  const graph = JSON.parse(JSON.stringify(EXAMPLE_GRAPH));
  const made = await tool(drafts, 'crear_recorrido', {
    nombre: 'Venta guiada (Claude)',
    descripcion: 'Armado desde el conector',
    inicio: { type: 'first_message' },
    grafo: graph,
    clientRef,
  });
  assert.equal(made.guardado, true, JSON.stringify(made));
  assert.equal(made.duplicado, false);
  assert.equal(made.estado, 'draft');
  assert.equal(made.versionPublicada, null);
  assert.equal(made.revision, 1);
  assert.deepEqual(made.problemas.errores, [], JSON.stringify(made.problemas));
  assert.equal(made.problemas.listoParaPublicar, true);
  const row = db.prepare('SELECT * FROM chatflows WHERE id=?').get(made.recorridoId);
  assert.equal(row.brand_id, 'globalvet');
  assert.equal(row.status, 'draft');
  assert.equal(row.published_version, null);
  assert.deepEqual(JSON.parse(row.start), { type: 'first_message' });
  const stored = JSON.parse(row.draft);
  assert.ok(stored.nodes.every(n => Number.isInteger(n.x) && Number.isInteger(n.y)));
  assert.ok(
    new Set(stored.nodes.map(n => n.x + ':' + n.y)).size === stored.nodes.length,
    'acomodado, sin pasos encimados',
  );
  const auditOf = action => count('SELECT count(*) n FROM audit WHERE action=?', action);
  assert.equal(auditOf('mcp.flow.create'), 1);
  assert.equal(auditOf('chatflow.created'), 1, 'la misma ruta que la pantalla');
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  assert.equal(
    db.prepare("SELECT user_id FROM audit WHERE action='mcp.flow.create'").get().user_id,
    adminId,
    'a nombre de quien creó la llave',
  );
  // un reintento con el mismo clientRef no crea otro
  const again = await tool(drafts, 'crear_recorrido', { nombre: 'Otro nombre', grafo: graph, clientRef });
  assert.equal(again.duplicado, true);
  assert.equal(again.recorridoId, made.recorridoId);
  assert.equal(count("SELECT count(*) n FROM chatflows WHERE brand_id='globalvet'"), 1);
  assert.equal(auditOf('mcp.flow.create'), 1);

  // ---- 4) revisar: cero errores, igual que la pantalla
  const review = await tool(drafts, 'revisar_recorrido', { recorridoId: made.recorridoId });
  assert.equal(review.listoParaPublicar, true);
  assert.deepEqual(review.errores, []);
  const screen = await api('/api/chatflows/' + made.recorridoId);
  assert.deepEqual(review.errores, screen.issues.errors);
  assert.deepEqual(review.avisos, screen.issues.warnings);

  // ---- 5) probar con respuestas: lo que vería la persona; no escribe nada
  const course = listas.courses.find(k => k.id === 'aves');
  const sim = await tool(drafts, 'probar_recorrido', {
    recorridoId: made.recorridoId,
    respuestas: [course.title, 'Sí, inscribirme'],
  });
  assert.match(sim.aviso, /no se envió nada/);
  const said = sim.conversacion.map(m => m.de + ': ' + m.texto).join('\n');
  assert.match(said, /Gracias por escribirnos/);
  assert.ok(sim.conversacion.some(m => m.de === 'persona' && m.texto === course.title));
  assert.ok(
    sim.conversacion.some(m => (m.botones || []).includes('Sí, inscribirme')),
    said,
  );
  assert.ok(sim.conversacion.some(m => m.de === 'persona' && m.texto === 'Sí, inscribirme'));
  assert.equal(sim.termino, true, JSON.stringify(sim));
  assert.deepEqual(sim.respuestasSinUsar, []);
  assert.ok(sim.notas.some(n => /no se cambia ninguna conversación/.test(n)));
  assert.deepEqual(sideEffects(), before, 'crear, revisar y probar no envían, no inscriben ni mueven nada');
  const still = db.prepare('SELECT status,published_version,revision FROM chatflows WHERE id=?').get(made.recorridoId);
  assert.deepEqual({ ...still }, { status: 'draft', published_version: null, revision: 1 }, 'sigue en borrador');

  // ---- 6) un grafo con problemas: se guarda como borrador y devuelve los problemas de la pantalla
  const broken = await tool(drafts, 'crear_recorrido', {
    nombre: 'Con problemas',
    grafo: {
      nodes: [
        { id: 'a', type: 'start', data: {} },
        { id: 'b', type: 'buttons', data: { text: '', options: [] } },
        { id: 'c', type: 'webhook', data: {} },
      ],
      edges: [
        { from: 'a', port: 'next', to: 'b' },
        { from: 'b', port: 'no-existe', to: 'c' },
      ],
    },
    clientRef: 'mcp-' + randomUUID(),
  });
  assert.equal(broken.problemas.listoParaPublicar, false);
  assert.ok(broken.problemas.errores.length >= 2);
  assert.deepEqual(broken.problemas.errores, (await api('/api/chatflows/' + broken.recorridoId)).issues.errors);
  assert.ok(
    broken.reparaciones.some(r => /conexión/.test(r)),
    'avisa de la conexión que no llevaba a ningún lado',
  );
  // probar un borrador sin errores funciona; el simulador del borrador con errores también contesta (como la pantalla)
  const revised = await tool(drafts, 'revisar_recorrido', {
    recorridoId: broken.recorridoId,
    grafo: graph,
  });
  assert.equal(revised.listoParaPublicar, true, 'revisa un grafo enviado sin guardarlo');
  assert.equal(db.prepare('SELECT revision FROM chatflows WHERE id=?').get(broken.recorridoId).revision, 1);

  // ---- 7) actualizar el borrador: revisión vigente; una vieja se rechaza
  assert.match(
    (await tool(drafts, 'actualizar_recorrido', { recorridoId: made.recorridoId, revision: 0, nombre: 'Viejo' })).error,
    /Alguien más guardó|Recárgalo/,
  );
  assert.match(
    (await tool(drafts, 'actualizar_recorrido', { recorridoId: made.recorridoId, revision: 1 })).error,
    /al menos un cambio/,
  );
  const renamed = await tool(drafts, 'actualizar_recorrido', {
    recorridoId: made.recorridoId,
    revision: 1,
    nombre: 'Venta guiada v2',
    ajustes: { maxMisses: 3 },
  });
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.nombre, 'Venta guiada v2');
  const kept = JSON.parse(db.prepare('SELECT settings FROM chatflows WHERE id=?').get(made.recorridoId).settings);
  assert.equal(kept.maxMisses, 3);
  assert.equal(kept.timeoutMinutes, 1440, 'lo que no se mandó se conserva');
  assert.equal(auditOf('mcp.flow.update'), 1);
  // no hay forma de cambiar el estado: ni con datos de más ni con herramientas que no existen
  for (const extra of [{ estado: 'active' }, { status: 'published' }, { publicar: true }, { versionPublicada: 1 }])
    assert.match(
      (await tool(drafts, 'actualizar_recorrido', { recorridoId: made.recorridoId, revision: 2, ...extra })).error,
      /Dato no reconocido/,
    );
  assert.match(
    (await tool(drafts, 'crear_recorrido', { nombre: 'x', clientRef: 'mcp-' + randomUUID(), estado: 'active' })).error,
    /Dato no reconocido: estado/,
  );

  // ---- 8) un recorrido publicado por una persona: el conector edita su borrador y lo que atiende NO cambia
  let flow = (await api('/api/chatflows/' + made.recorridoId)).flow;
  ({ flow } = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } }));
  ({ flow } = await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: flow.revision } }));
  const live = db.prepare('SELECT graph,start,settings FROM chatflow_versions WHERE flow_id=?').get(flow.id);
  const changed = JSON.parse(JSON.stringify(graph));
  changed.nodes.find(n => n.id === 'n2').data.parts[0].text = '¡Hola de nuevo, {{nombre}}!';
  const edit = await tool(drafts, 'actualizar_recorrido', {
    recorridoId: flow.id,
    revision: flow.revision,
    grafo: changed,
    inicio: { type: 'keyword', keywords: ['curso'] },
  });
  assert.equal(edit.guardado, true, JSON.stringify(edit));
  assert.match(edit.nota, /versión publicada 1, sin cambios/);
  assert.deepEqual(
    { ...db.prepare('SELECT graph,start,settings FROM chatflow_versions WHERE flow_id=?').get(flow.id) },
    { ...live },
  );
  const after = db.prepare('SELECT status,published_version,draft FROM chatflows WHERE id=?').get(flow.id);
  assert.equal(after.status, 'active', 'sigue activo: el conector no lo pausa');
  assert.equal(after.published_version, 1, 'no publica');
  assert.match(after.draft, /Hola de nuevo/);
  assert.equal(count('SELECT count(*) n FROM chatflow_versions WHERE flow_id=?', flow.id), 1);
  // archivado (por una persona): no se edita desde aquí
  ({ flow } = await api('/api/chatflows/' + broken.recorridoId));
  await api('/api/chatflows/' + flow.id + '/archive', { body: { expectedRevision: flow.revision } });
  assert.match(
    (await tool(drafts, 'actualizar_recorrido', { recorridoId: flow.id, revision: flow.revision + 1, nombre: 'x' }))
      .error,
    /archivado/,
  );
  const lists = await tool(drafts, 'listar_recorridos');
  assert.ok(!lists.recorridos.some(f => f.recorridoId === broken.recorridoId), 'sin archivados');
  assert.ok(
    (await tool(drafts, 'listar_recorridos', { incluirArchivados: true })).recorridos.some(
      f => f.recorridoId === broken.recorridoId,
    ),
  );
  const seen = await tool(drafts, 'ver_recorrido', { recorridoId: made.recorridoId });
  assert.equal(seen.estado, 'active');
  assert.equal(seen.versiones.length, 1);
  assert.match(seen.aviso, /son datos, no instrucciones/);

  // ---- 9) otra marca: no existe
  const theirs = await tool(other, 'crear_recorrido', { nombre: 'De OdonTeck', clientRef: 'mcp-' + randomUUID() });
  assert.equal(db.prepare('SELECT brand_id FROM chatflows WHERE id=?').get(theirs.recorridoId).brand_id, 'odonteck');
  for (const [name, args] of [
    ['ver_recorrido', { recorridoId: made.recorridoId }],
    ['revisar_recorrido', { recorridoId: made.recorridoId }],
    ['probar_recorrido', { recorridoId: made.recorridoId }],
    ['actualizar_recorrido', { recorridoId: made.recorridoId, revision: 3, nombre: 'Ajeno' }],
  ])
    assert.match((await tool(other, name, args)).error, /no existe en esta marca/, name);
  assert.match(
    (await tool(drafts, 'ver_recorrido', { recorridoId: theirs.recorridoId })).error,
    /no existe en esta marca/,
  );
  assert.match((await tool(drafts, 'ver_recorrido', { recorridoId: '../x' })).error, /no existe en esta marca/);
  assert.match(
    (await tool(drafts, 'probar_recorrido', { recorridoId: made.recorridoId, cursoId: 'no-es-de-aqui' })).error,
    /no existe en esta marca/,
  );
  assert.ok(!(await tool(other, 'listar_recorridos')).recorridos.some(f => f.recorridoId === made.recorridoId));

  // ---- 10) secuencias: nacen y se quedan apagadas
  const seqRef = 'mcp-' + randomUUID();
  const seq = await tool(drafts, 'crear_secuencia', {
    titulo: 'Seguimiento (Claude)',
    cursoId: 'aves',
    pasos: [
      { timing: { base: 'enrolled', amount: 1, unit: 'days' }, send: { kind: 'text', text: '¿Pudiste ver la ficha?' } },
    ],
    clientRef: seqRef,
  });
  assert.equal(seq.encendida, false, JSON.stringify(seq));
  assert.equal(db.prepare('SELECT enabled FROM sequences WHERE id=?').get(seq.secuenciaId).enabled, 0);
  assert.equal(
    (
      await tool(drafts, 'crear_secuencia', {
        titulo: 'x',
        pasos: [{ send: { kind: 'text', text: 'y' } }],
        clientRef: seqRef,
      })
    ).duplicado,
    true,
  );
  assert.match(
    (await tool(drafts, 'crear_secuencia', { titulo: 'x', pasos: [], clientRef: 'mcp-' + randomUUID(), enabled: true }))
      .error,
    /Dato no reconocido: enabled/,
  );
  assert.match(
    (await tool(drafts, 'crear_secuencia', { titulo: 'x', pasos: [], clientRef: 'mcp-' + randomUUID() })).error,
    /al menos un paso/,
  );
  assert.match(
    (
      await tool(drafts, 'crear_secuencia', {
        titulo: 'x',
        cursoId: db.prepare("SELECT id FROM courses WHERE brand_id='odonteck'").get().id,
        pasos: [{ send: { kind: 'text', text: 'y' } }],
        clientRef: 'mcp-' + randomUUID(),
      })
    ).error,
    /no existe en esta marca/,
  );
  const seqUp = await tool(drafts, 'actualizar_secuencia', {
    secuenciaId: seq.secuenciaId,
    revision: seq.revision,
    titulo: 'Seguimiento v2',
  });
  assert.equal(seqUp.titulo, 'Seguimiento v2');
  assert.equal(seqUp.encendida, false);
  assert.match(
    (
      await tool(drafts, 'actualizar_secuencia', {
        secuenciaId: seq.secuenciaId,
        revision: seq.revision,
        titulo: 'Vieja',
      })
    ).error,
    /Alguien más guardó/,
  );
  // una persona la enciende: desde aquí ya no se toca, y el conector no la apaga
  await api('/api/sequences/' + seq.secuenciaId + '/enable', { body: { expectedRevision: seqUp.revision } });
  const on = await tool(drafts, 'ver_secuencia', { secuenciaId: seq.secuenciaId });
  assert.equal(on.encendida, true);
  assert.match(
    (await tool(drafts, 'actualizar_secuencia', { secuenciaId: seq.secuenciaId, revision: on.revision, titulo: 'No' }))
      .error,
    /encendida/,
  );
  assert.deepEqual(
    { ...db.prepare('SELECT enabled,title FROM sequences WHERE id=?').get(seq.secuenciaId) },
    { enabled: 1, title: 'Seguimiento v2' },
  );
  assert.match((await tool(other, 'ver_secuencia', { secuenciaId: seq.secuenciaId })).error, /no existe en esta marca/);
  assert.ok((await tool(drafts, 'listar_secuencias')).secuencias.some(s => s.secuenciaId === seq.secuenciaId));
  assert.equal(auditOf('mcp.sequence.create'), 1);
  assert.equal(auditOf('mcp.sequence.update'), 1);

  // ---- 11) accesos del curso: el texto con la entrega apagada
  const acc = await tool(drafts, 'listar_accesos');
  const opening = acc.aperturas.find(e => e.cursoId === 'aves');
  assert.ok(opening, JSON.stringify(acc).slice(0, 400));
  assert.equal(opening.acceso.encendido, false);
  const wrote = await tool(drafts, 'escribir_acceso', {
    aperturaId: opening.aperturaId,
    revision: opening.acceso.revision,
    texto:
      '¡Bienvenida, {{nombre}}! Tu lugar en {{curso}} está listo. Enlace de las clases: https://clases.example/aves',
  });
  assert.equal(wrote.guardado, true, JSON.stringify(wrote));
  assert.equal(wrote.acceso.encendido, false);
  assert.match(wrote.comoSeVeria, /Bienvenida, Ana/);
  const accessRow = db
    .prepare('SELECT enabled,body,revision FROM course_access WHERE edition_id=?')
    .get(opening.aperturaId);
  assert.equal(accessRow.enabled, 0);
  assert.match(accessRow.body, /clases\.example/);
  assert.match(
    (
      await tool(drafts, 'escribir_acceso', {
        aperturaId: opening.aperturaId,
        revision: opening.acceso.revision,
        texto: 'Otro texto de accesos para la prueba',
      })
    ).error,
    /cambiaron/,
  );
  // una persona enciende la entrega: el conector ya no toca ese texto
  await api('/api/course-access/editions/' + opening.aperturaId, {
    method: 'PUT',
    body: { enabled: true, expectedRevision: accessRow.revision },
  });
  assert.match(
    (
      await tool(drafts, 'escribir_acceso', {
        aperturaId: opening.aperturaId,
        revision: accessRow.revision + 1,
        texto: 'Texto nuevo de accesos para la prueba',
      })
    ).error,
    /está encendida/,
  );
  const theirEdition = db.prepare("SELECT id FROM editions WHERE brand_id='odonteck'").get().id;
  assert.match(
    (
      await tool(drafts, 'escribir_acceso', {
        aperturaId: theirEdition,
        revision: 0,
        texto: 'Texto de accesos de otra marca',
      })
    ).error,
    /no existe en esta marca/,
  );
  assert.equal(auditOf('mcp.access.text'), 1);

  // ---- 12) nada de datos de clientes por estas herramientas, y nada enviado ni inscrito en todo el recorrido
  const everything = JSON.stringify([
    await tool(drafts, 'listas_de_la_marca'),
    await tool(drafts, 'listar_recorridos', { incluirArchivados: true }),
    await tool(drafts, 'ver_recorrido', { recorridoId: made.recorridoId }),
    await tool(drafts, 'listar_secuencias', { incluirArchivadas: true }),
    await tool(drafts, 'listar_accesos'),
  ]);
  assert.doesNotMatch(everything, /Ana Pérez Privada|5512345678/);
  const end = sideEffects();
  assert.deepEqual(
    { ...end, versions: before.versions },
    { ...before },
    'el conector no envió, no inscribió, no creó pedidos ni sesiones (la única versión la publicó una persona)',
  );

  // ---- 13) si quien creó la llave deja de administrar la marca (sigue en su equipo), la llave ya no escribe
  db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(adminId, 'globalvet');
  db.prepare("UPDATE users SET role='agent' WHERE id=?").run(adminId);
  assert.match(
    (await tool(drafts, 'crear_recorrido', { nombre: 'No debe', clientRef: 'mcp-' + randomUUID() })).error,
    /ya no administra la marca/,
  );
  assert.ok((await tool(drafts, 'guia_recorridos', { tipos: ['enroll'] })).tiposDePaso.length > 0, 'la guía sigue');
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminId);
});

// ---- revisión de seguridad del conector (docs/PLAN_MCP_CLAUDE.md)

// Módulos falsos en memoria para reproducir lo que una prueba de punta a punta no puede ordenar: que una persona
// encienda algo justo entre la comprobación del conector y su escritura.
async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function fakeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE brands(id TEXT PRIMARY KEY, created_at INTEGER);
    CREATE TABLE brand_members(user_id TEXT, brand_id TEXT);
    CREATE TABLE editions(id TEXT PRIMARY KEY, brand_id TEXT);
    INSERT INTO users(id,role) VALUES('u1','admin');
    INSERT INTO brands VALUES('b1',1);
    INSERT INTO editions VALUES('e1','b1');`);
  return db;
}

test('borradores: cifras con «menos de 3» y escritura con la revisión de la fila que se comprobó apagada', async () => {
  const db = fakeDb();
  const key = { id: 'k1', brand_id: 'b1', created_by: 'u1' };
  const send = (res, status, data) => {
    res.writeHead(status);
    res.end(JSON.stringify(data));
    return true;
  };
  // Secuencia apagada (revisión 5); al leerla, una persona la enciende (revisión 6).
  let seq = {
    id: 's1',
    brandId: 'b1',
    enabled: false,
    archived: false,
    revision: 5,
    title: 'T',
    steps: [],
    settings: {},
  };
  // Accesos apagados (revisión 7); al leerlos, una persona enciende la entrega (revisión 8).
  let access = { state: 'off', enabled: false, body: 'Hola', revision: 7, problems: [] };
  const card = () => ({
    editionId: 'e1',
    courseId: 'c1',
    courseTitle: 'Curso',
    editionName: 'Marzo',
    startsAt: null,
    status: 'published',
    hasGroup: false,
    enrolled: 1,
    delivered: 2,
    access,
  });
  const writes = [];
  const modules = {
    chatflows: {
      repo: { brandOf: () => 'b1' },
      async handle(req, res) {
        return send(res, 200, {
          brands: [],
          flows: [
            {
              id: 'f1',
              brandId: 'b1',
              name: 'R',
              status: 'active',
              publishedVersion: 1,
              start: { type: 'manual' },
              revision: 1,
              metrics: { sessions: 4, inProgress: 1, completed: 2, handoff: 0, left: 0, dropped: 1, excluded: 0 },
            },
          ],
        });
      },
    },
    sequences: {
      repo: { brandOf: () => 'b1' },
      async handle(req, res) {
        if (req.method === 'GET') {
          const out = { sequence: { ...seq } };
          seq = { ...seq, enabled: true, revision: 6 };
          return send(res, 200, out);
        }
        const input = await bodyOf(req);
        if (input.expectedRevision !== seq.revision) return send(res, 409, { error: 'Alguien más guardó.' });
        writes.push(['sequence', input.expectedRevision, seq.enabled]);
        return send(res, 200, { sequence: { ...seq, title: input.title, revision: seq.revision + 1 } });
      },
    },
    'course-access': {
      async handle(req, res, path) {
        if (req.method === 'GET') {
          const out = { editions: [card()], variables: [], limits: {} };
          access = { ...access, enabled: true, state: 'on', revision: 8 };
          return send(res, 200, out);
        }
        const input = await bodyOf(req);
        if (path.endsWith('/preview')) return send(res, 200, { text: input.body });
        if (input.expectedRevision !== access.revision) return send(res, 409, { error: 'Los accesos cambiaron.' });
        writes.push(['access', input.expectedRevision, access.enabled]);
        return send(res, 200, { edition: { ...card(), access: { ...access, body: input.body } } });
      },
    },
  };
  const tools = createDraftTools({
    db,
    crm: { canBrand: () => true },
    audit: () => {},
    module: name => modules[name],
    actorOf: () => ({ id: 'u1', role: 'admin' }),
  }).run;

  // «menos de 3» también aquí: 1 o 2 conversaciones no se dan exactas; 1 inscrito y 2 entregados, tampoco
  const flows = await tools.listar_recorridos(key, {});
  assert.deepEqual(flows.recorridos[0].metricas, {
    sessions: 4,
    inProgress: FEW,
    completed: FEW,
    handoff: 0,
    left: 0,
    dropped: FEW,
    excluded: 0,
  });
  const acc = await tools.listar_accesos(key);
  assert.deepEqual([acc.aperturas[0].inscritos, acc.aperturas[0].entregados], [FEW, FEW]);

  // una persona la enciende entre la lectura y la escritura: quien llama manda la revisión «nueva» (6) y no pasa
  seq = { ...seq, enabled: false, revision: 5 };
  await assert.rejects(tools.actualizar_secuencia(key, { secuenciaId: 's1', revision: 6, titulo: 'X' }), /Alguien más/);
  // con la revisión que sí leyó (5), el módulo la rechaza porque ya cambió (encendida, revisión 6)
  seq = { ...seq, enabled: false, revision: 5 };
  await assert.rejects(tools.actualizar_secuencia(key, { secuenciaId: 's1', revision: 5, titulo: 'X' }), /Alguien más/);
  access = { ...access, enabled: false, state: 'off', revision: 7 };
  await assert.rejects(tools.escribir_acceso(key, { aperturaId: 'e1', revision: 8, texto: 'Nuevo' }), /cambiaron/);
  access = { ...access, enabled: false, state: 'off', revision: 7 };
  await assert.rejects(tools.escribir_acceso(key, { aperturaId: 'e1', revision: 7, texto: 'Nuevo' }), /cambiaron/);
  assert.deepEqual(writes, [], 'nada se escribió sobre una secuencia o una entrega ya encendidas');
  db.close();
});

test('probar un recorrido desde el conector nunca consulta a la IA; «Probar» de la pantalla sigue igual', async t => {
  let aiCalls = 0;
  const stub = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      aiCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'x',
          content: [{ type: 'text', text: 'Sí: el curso es en línea.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'crm-mcp-sin-ia-'));
  const code = randomUUID();
  const server = await startServer({
    dir,
    env: {
      ADMIN_INVITE_CODE: code,
      AI_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: 'sk-ant-api03-prueba',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + stub.address().port,
      CHANNEL_CONNECTOR: '',
    },
  });
  let db = null;
  t.after(async () => {
    try {
      db?.close();
    } catch {}
    await server.stop();
    await new Promise(r => stub.close(r));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = server.origin;
  const admin = await registerAdmin(origin, code);
  db = openDb(dir);
  const api = (path, options = {}) => call(origin, path, { cookie: admin, ...options });
  const rs = (await api('/api/replies/settings')).settings.find(x => x.brand_id === 'globalvet');
  await api('/api/replies/brands/globalvet', {
    method: 'PATCH',
    body: { mode: 'autonomous', providerEnabled: true, expectedRevision: rs.revision },
  });
  const token = (
    await api('/api/integrations/keys', {
      body: { brandId: 'globalvet', name: 'Claude borradores', scopes: [DRAFT_SCOPE] },
      expected: 201,
    })
  ).token;
  let rid = 0;
  const tool = async (name, args = {}) => {
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
    });
    const out = (await r.json()).result;
    return out.isError ? { error: out.content[0].text } : JSON.parse(out.content[0].text);
  };
  const flow = await tool('crear_recorrido', {
    nombre: 'Sin IA',
    grafo: JSON.parse(JSON.stringify(EXAMPLE_GRAPH)),
    clientRef: 'mcp-' + randomUUID(),
  });
  const questions = [
    'Vivo en Colombia, ¿puedo tomar el curso desde allá?',
    // una pregunta que se parece al conocimiento (desde docs/PLAN_RESPUESTAS_DE_VENTA.md, la que no se parece a nada ni
    // siquiera querría la IA, aunque la marca tenga 6 respuestas o menos)
    '¿Puedo conectarme desde la computadora del trabajo si viajo mucho?',
    '¿Y si me mudo a Perú a medio curso puedo seguir tomando el curso?',
  ];
  const aiAudit = () => db.prepare("SELECT count(*) n FROM audit WHERE action='ai.call'").get().n;
  const audit0 = aiAudit();
  const sim = await tool('probar_recorrido', { recorridoId: flow.recorridoId, cursoId: 'aves', respuestas: questions });
  assert.equal(sim.error, undefined, sim.error);
  assert.equal(aiCalls, 0, 'el conector no llamó a la IA');
  assert.equal(aiAudit(), audit0, 'ni gastó del tope');
  const fromAssistant = sim.conversacion.filter(m => m.de === 'asistente');
  assert.ok(fromAssistant.length >= 1, JSON.stringify(sim.conversacion));
  assert.ok(fromAssistant.every(m => /Aquí contestaría el asistente de la marca/.test(m.texto)));
  assert.ok(sim.notas.some(n => /no se llamó a la IA/.test(n)));
  assert.match(sim.aviso, /no se consultó a la IA/);
  // la pantalla («Probar») sí consulta a la IA como siempre; un dato de más en el cuerpo no cambia nada
  let r = await api('/api/chatflows/' + flow.recorridoId + '/simulate', { body: { courseId: 'aves', ai: false } });
  for (const said of questions) {
    if (r.ended || !r.waiting) break;
    r = await api('/api/chatflows/' + flow.recorridoId + '/simulate', {
      body: { courseId: 'aves', state: r.state, input: { text: said }, ai: false, provider: false },
    });
  }
  assert.ok(aiCalls >= 1, 'la pantalla sigue consultando a la IA');
});
