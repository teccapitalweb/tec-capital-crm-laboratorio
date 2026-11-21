import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/server.mjs';
import { call, openDb, PASSWORD } from './helpers/crm.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { openDatabase } from '../server/database.mjs';
import { migrate } from '../server/migrations/index.mjs';
import { runLadder } from '../server/migrations/ladder.mjs';
import { NAMED } from '../server/migrations/registry.mjs';
import { applyNamed, defineRegistry } from '../server/migrations/named.mjs';
import { TOOLS } from '../server/mcp.mjs';
import { SCOPES } from '../server/integrations.mjs';
import activity from '../server/modules/mcp-activity/module.mjs';
import { KEEP_MS } from '../server/modules/mcp-activity/repo.mjs';
import { TOOL_LABELS, ENTITY_LABELS } from '../server/lib/mcp-activity-labels.mjs';

// Actividad del asistente (docs/PLAN_MCP_CLAUDE.md): una fila por cada herramienta que ejecuta el conector, con llave o
// con OAuth, sin argumentos ni respuestas; la lee sólo el equipo, por marca, y el conector no puede leerla ni borrarla.
const SENTINEL = 'CENTINELA-actividad-7f3a9c';
const cleanup = async (t, dir, parts) =>
  t.after(async () => {
    try {
      parts.db?.close();
    } catch {}
    await parts.server?.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

test('la migración mcp-activity llega a una base ya publicada sin tocar lo que había', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-actividad-mig-'));
  const parts = {};
  await cleanup(t, dir, parts);
  parts.db = openDatabase(dir);
  runLadder(parts.db);
  applyNamed(parts.db, defineRegistry(NAMED.filter(m => !m.name.startsWith('mcp-activity/'))), { log: () => {} });
  parts.db
    .prepare(
      'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run('old-user', 'old', 'Anterior', 'unused', 'customer', 800000, 1, 1);
  assert.equal(parts.db.prepare("SELECT 1 FROM sqlite_master WHERE name='mcp_activity'").get(), undefined);
  parts.db.close();
  parts.server = await startServer({ dir });
  parts.db = openDb(dir);
  assertSchemaCurrent(parts.db);
  assert.equal(parts.db.prepare("SELECT name FROM users WHERE id='old-user'").get().name, 'Anterior');
  assert.equal(parts.db.prepare('SELECT count(*) n FROM mcp_activity').get().n, 0);
  const columns = parts.db
    .prepare('PRAGMA table_info(mcp_activity)')
    .all()
    .map(c => c.name);
  for (const forbidden of ['arguments', 'args', 'input', 'result', 'response', 'message', 'text', 'contact_id'])
    assert.ok(!columns.includes(forbidden), 'sin columna ' + forbidden);
});

test('cada herramienta tiene su texto y el conector no puede leer ni borrar la actividad', async () => {
  for (const tool of TOOLS) assert.ok(TOOL_LABELS[tool.name], 'texto para ' + tool.name);
  for (const label of Object.values(TOOL_LABELS)) assert.match(label, /^[A-ZÁÉÍÓÚ][^{}<>]+$/);
  assert.ok(Object.keys(ENTITY_LABELS).length >= 10);
  // ninguna herramienta habla de la actividad, y las rutas que el conector puede pedir no la incluyen
  for (const tool of TOOLS) assert.doesNotMatch(tool.name + ' ' + tool.description, /actividad|activity|bit[aá]cora/i);
  for (const file of ['server/lib/mcp-drafts.mjs', 'server/lib/mcp-config.mjs', 'server/lib/mcp-insights.mjs'])
    assert.doesNotMatch(await readFile(file, 'utf8'), /mcp-activity|mcp_activity/, file);
  const mcp = await readFile('server/mcp.mjs', 'utf8');
  assert.deepEqual(mcp.match(/mcp-activity'\)[^;]*/g), ["mcp-activity')?.record(entry)"], 'el conector sólo registra');
  assert.doesNotMatch(mcp, /mcp_activity/);
});

test('retención: se borra lo de más de 90 días, por trozos; un registro que falla no lanza', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-actividad-ret-'));
  const parts = {};
  await cleanup(t, dir, parts);
  const db = (parts.db = openDatabase(dir));
  migrate(db, { backup: false });
  assertSchemaCurrent(db);
  const api = activity.create({ db, fail: () => new Error('x'), json: () => {}, access: {} });
  const key = { id: 'k1', brand_id: 'globalvet', created_by: null };
  const tool = TOOLS.find(x => x.name === 'resumen');
  api.record({ key, tool });
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO mcp_activity(brand_id,source,key_id,tool,kind,outcome,created_at) VALUES('globalvet','key','k1','resumen','read','ok',?)",
  );
  for (let i = 0; i < 620; i++) insert.run(now - KEEP_MS - 1000 - i);
  insert.run(now - KEEP_MS + 60_000); // dentro de los 90 días
  assert.equal(api.purge(), 500, 'por trozos de 500');
  assert.equal(api.purge(), 120);
  assert.equal(api.purge(), 0);
  assert.equal(db.prepare('SELECT count(*) n FROM mcp_activity').get().n, 2);
  // sin marca la fila no se puede escribir: lo dice en la consola y no lanza
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    assert.doesNotThrow(() => api.record({ key: { id: 'k2' }, tool }));
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /mcp-activity: no se pudo registrar/);
  assert.ok(
    activity.timers.some(x => x.name === 'purga'),
    'la purga corre sola con un reloj',
  );
});

test('actividad del asistente de punta a punta: llave y OAuth, rechazos, privacidad, alcance y filtros', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-actividad-'));
  const invite = randomUUID();
  const parts = {};
  await cleanup(t, dir, parts);
  parts.server = await startServer({ dir, env: { ADMIN_INVITE_CODE: invite, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' } });
  const origin = parts.server.origin;
  const admin = (
    await call(origin, '/api/auth/register', {
      body: { username: 'admin', name: 'Administración', password: PASSWORD, inviteCode: invite },
    })
  ).cookie;
  const db = (parts.db = openDb(dir));
  assertSchemaCurrent(db);
  const keyFor = async (brandId, name, scopes) =>
    (await call(origin, '/api/integrations/keys', { cookie: admin, body: { brandId, name, scopes }, expected: 201 }))
      .token;
  const reader = await keyFor('globalvet', 'Llave de consulta', ['editions', 'contacts']);
  const writer = await keyFor('globalvet', 'Llave de borradores', ['knowledge']);
  const other = await keyFor('odonteck', 'Llave de Odonteck', ['editions']);

  let rid = 0;
  const rpc = async (token, method, params) => {
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const tool = async (token, name, args = {}) => {
    const r = (await rpc(token, 'tools/call', { name, arguments: args })).result;
    return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
  };
  const rows = () => db.prepare('SELECT * FROM mcp_activity ORDER BY id').all();

  // ---- llamadas con llave: bien, sin permiso, inválida, inexistente, no encontrada y una escritura
  assert.equal((await tool(reader, 'resumen')).marca.id, 'globalvet');
  assert.ok((await tool(reader, 'buscar_contactos', { texto: SENTINEL })).contactos);
  assert.match((await tool(reader, 'listar_pedidos')).error, /permiso/);
  assert.match((await tool(reader, 'listar_cursos', { incluirBorradores: SENTINEL })).error, /sí o no/);
  assert.equal((await rpc(reader, 'tools/call', { name: SENTINEL, arguments: {} })).error.code, -32602);
  assert.match((await tool(reader, 'ver_curso', { cursoId: SENTINEL })).error, /no existe/);
  const draft = await tool(writer, 'proponer_conocimiento', {
    pregunta: '¿' + SENTINEL + '?',
    respuesta: SENTINEL + ' respuesta',
  });
  assert.equal(draft.estado, 'draft');
  await tool(other, 'resumen');
  // tools/list, ping e initialize no son llamadas a herramientas: no dejan fila
  await rpc(reader, 'tools/list');
  await rpc(reader, 'ping');

  let all = rows();
  assert.equal(all.length, 8, 'una fila por cada tools/call');
  const byTool = name => all.filter(r => r.tool === name);
  assert.deepEqual(
    all.map(r => [r.tool, r.kind, r.outcome, r.reason]),
    [
      ['resumen', 'read', 'ok', null],
      ['buscar_contactos', 'read', 'ok', null],
      ['listar_pedidos', 'read', 'rejected', 'scope'],
      ['listar_cursos', 'read', 'invalid', 'invalid'],
      [null, 'unknown', 'invalid', 'unknown_tool'],
      ['ver_curso', 'read', 'rejected', 'not_found'],
      ['proponer_conocimiento', 'write', 'ok', null],
      ['resumen', 'read', 'ok', null],
    ],
  );
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const readerKey = db.prepare("SELECT id FROM api_keys WHERE name='Llave de consulta'").get().id;
  assert.ok(all.slice(0, 6).every(r => r.source === 'key' && r.key_id === readerKey && r.grant_id === null));
  assert.ok(all.every(r => r.user_id === adminId));
  assert.deepEqual(
    [byTool('proponer_conocimiento')[0].entity_type, byTool('proponer_conocimiento')[0].entity_id],
    ['knowledge', draft.entradaId],
  );
  assert.equal(all.at(-1).brand_id, 'odonteck');
  // privacidad: nada de lo que mandó el asistente queda en la actividad
  assert.doesNotMatch(JSON.stringify(all), new RegExp(SENTINEL));

  // ---- una conexión con OAuth también deja su fila
  const register = await fetch(origin + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Asistente de prueba', redirect_uris: ['http://127.0.0.1:4545/callback'] }),
  });
  const client = await register.json();
  const verifier = randomBytes(32).toString('base64url');
  const consent = await (
    await fetch(
      origin +
        '/oauth/authorize?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: client.client_id,
          redirect_uri: 'http://127.0.0.1:4545/callback',
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
        scopes: ['editions'],
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
        redirect_uri: 'http://127.0.0.1:4545/callback',
        client_id: client.client_id,
        code_verifier: verifier,
      }),
    })
  ).json();
  assert.match(tokens.access_token, /^tca_/);
  assert.ok((await tool(tokens.access_token, 'listar_cursos')).cursos);
  assert.match((await tool(tokens.access_token, 'listar_conocimiento')).error, /permiso/);
  const grantId = db.prepare('SELECT id FROM mcp_oauth_grants').get().id;
  all = rows();
  assert.deepEqual(
    all.slice(-2).map(r => [r.source, r.grant_id, r.key_id, r.user_id, r.tool, r.outcome, r.reason]),
    [
      ['oauth', grantId, null, adminId, 'listar_cursos', 'ok', null],
      ['oauth', grantId, null, adminId, 'listar_conocimiento', 'rejected', 'scope'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(all), /tca_|tcw_/, 'ninguna ficha ni llave en claro');

  // ---- la API con sesión: textos en español llano, nombres (nunca valores) y filtros
  const list = async (query = '', cookie = admin, expected = 200) =>
    call(origin, '/api/mcp-activity' + query, { cookie, expected });
  const page = await list();
  assert.equal(page.allowed, true);
  assert.equal(page.retentionDays, 90);
  assert.equal(page.items.length, 10);
  assert.equal(page.items[0].text, 'Rechazada: no tenía el permiso «' + SCOPES.knowledge + '»');
  assert.equal(page.items[0].detail, 'Herramienta: Conocimiento del asistente');
  assert.equal(page.items[0].source.kind, 'oauth');
  assert.equal(page.items[0].source.name, 'Asistente de prueba');
  const texts = page.items.map(i => i.text);
  assert.ok(texts.includes('Propuso una respuesta al conocimiento (borrador)'));
  assert.ok(texts.includes('Consultó el resumen de la marca'));
  assert.ok(texts.includes('Pidió una herramienta que no existe'));
  assert.ok(texts.some(x => /^Rechazada: no tenía el permiso «.+»$/.test(x)));
  const written = page.items.find(i => i.tool === 'proponer_conocimiento');
  assert.deepEqual(written.entity, { type: 'knowledge', label: 'Respuesta del conocimiento', id: draft.entradaId });
  assert.equal(written.source.name, 'Llave de borradores');
  assert.equal(written.userName, 'Administración');
  assert.doesNotMatch(JSON.stringify(page), new RegExp(SENTINEL + '|tcw_|tca_|key_hash'));
  assert.ok(page.sources.some(s => s.id === 'key:' + readerKey && s.name === 'Llave de consulta'));
  assert.ok(page.sources.some(s => s.id === 'oauth:' + grantId && s.kind === 'oauth'));

  assert.ok((await list('?source=key:' + readerKey)).items.every(i => i.source.id === 'key:' + readerKey));
  assert.equal((await list('?source=key:' + readerKey)).items.length, 6);
  assert.equal((await list('?source=oauth:' + grantId)).items.length, 2);
  assert.deepEqual(
    (await list('?writes=1')).items.map(i => i.tool),
    ['proponer_conocimiento'],
  );
  assert.ok((await list('?problems=1')).items.every(i => i.outcome !== 'ok'));
  assert.equal((await list('?problems=1')).items.length, 5);
  assert.deepEqual(
    (await list('?brand=odonteck')).items.map(i => [i.brandId, i.tool]),
    [['odonteck', 'resumen']],
  );
  assert.equal((await list('?from=' + (Date.now() + 60_000))).items.length, 0);
  assert.equal((await list('?to=1')).items.length, 0);
  // paginación por cursor
  const first = await list('?limit=4');
  assert.equal(first.items.length, 4);
  assert.ok(first.next);
  const second = await list('?limit=4&before=' + first.next);
  assert.equal(second.items.length, 4);
  assert.ok(second.items.every(i => i.id < first.items.at(-1).id));
  const last = await list('?limit=4&before=' + second.next);
  assert.equal(last.items.length, 2);
  assert.equal(last.next, null);
  assert.equal((await list('?limit=5000')).items.length, 10, 'tope de filas');
  await list('?brand=no-existe', admin, 404);
  await list('?source=' + encodeURIComponent('key:x y'), admin, 400);
  await call(origin, '/api/mcp-activity', { cookie: '', expected: 401 });

  // ---- alcance: una asesora de GlobalVet (no administra llaves ni asistentes) no ve nada, ni pidiendo su marca
  const inv = await call(origin, '/api/team/invites', {
    cookie: admin,
    body: { username: 'asesora', brandIds: ['globalvet'] },
    expected: 201,
  });
  const agent = (
    await call(origin, '/api/auth/register', {
      body: { username: 'asesora', name: 'Asesora', password: PASSWORD, inviteCode: inv.token },
    })
  ).cookie;
  const agentPage = await list('', agent);
  assert.equal(agentPage.allowed, false);
  assert.deepEqual([agentPage.items, agentPage.sources, agentPage.brands], [[], [], []]);
  await list('?brand=globalvet', agent, 404);
  await list('?source=key:' + readerKey, agent);
  assert.equal((await list('?source=key:' + readerKey, agent)).items.length, 0);

  // ---- si el registro no se puede escribir, la herramienta responde igual
  db.exec('DROP TABLE mcp_activity');
  assert.equal((await tool(reader, 'resumen')).marca.id, 'globalvet');
  assert.match(parts.server.logs(), /mcp-activity: no se pudo registrar/);
});
