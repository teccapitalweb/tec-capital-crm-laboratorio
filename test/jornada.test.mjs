import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ALERTS, blocks, detectAlerts, median, planArrivals } from '../server/modules/jornada/plan.mjs';
import { buildPrompt, cleanLine, costCents, customerLine } from '../server/modules/jornada/ai.mjs';
import { buildReport } from '../server/modules/jornada/report.mjs';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

// Jornada simulada (docs/PLAN_JORNADA_SIMULADA.md): clientes de mentira que llegan a goteo durante un tiempo, el
// asistente y el equipo los atienden, y se supervisa en vivo con alertas. Todos los datos son inventados.

test('planificar llegadas: dentro del tiempo, ordenadas, la primera de inmediato, por ritmo', () => {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const startAt = 1_000_000;
  for (const rhythm of ['goteo', 'parejo', 'rafagas']) {
    const plan = planArrivals({ count: 40, startAt, minutes: 300, rhythm, personas: ['curioso', 'precio'], rnd });
    assert.equal(plan.length, 40);
    assert.equal(plan[0].plannedAt, startAt, rhythm + ': la primera llega al empezar');
    for (let i = 1; i < plan.length; i++) assert.ok(plan[i].plannedAt >= plan[i - 1].plannedAt, 'ordenadas');
    assert.ok(
      plan.every(a => a.plannedAt >= startAt && a.plannedAt < startAt + 300 * 60_000),
      'dentro del tiempo',
    );
    assert.ok(plan.every(a => ['curioso', 'precio'].includes(a.persona)));
    assert.ok(plan.every(a => ['whatsapp', 'instagram', 'facebook'].includes(a.channel)));
  }
  // goteo: el tercio del medio junta más que los extremos
  const g = planArrivals({ count: 300, startAt, minutes: 300, rhythm: 'goteo', personas: ['curioso'], rnd });
  const tercio = i => g.filter(a => Math.floor(((a.plannedAt - startAt) / (300 * 60_000)) * 3) === i).length;
  assert.ok(tercio(1) > tercio(0) && tercio(1) > tercio(2), `pico en medio: ${tercio(0)} ${tercio(1)} ${tercio(2)}`);
  assert.deepEqual(planArrivals({ count: 0, startAt, minutes: 10, personas: [] }), []);
  // bloques de 15 minutos
  const b = blocks({
    startAt,
    minutes: 60,
    arrivals: [
      { plannedAt: startAt, state: 'arrived' },
      { plannedAt: startAt + 20 * 60_000, state: 'planned' },
      { plannedAt: startAt + 59 * 60_000, state: 'planned' },
    ],
    now: startAt + 16 * 60_000,
  });
  assert.equal(b.length, 4);
  assert.deepEqual(
    b.map(x => [x.planned, x.arrived, x.current]),
    [
      [1, 1, false],
      [1, 0, true],
      [0, 0, false],
      [1, 0, false],
    ],
  );
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([]), null);
});

test('detectar alertas: espera, persona que tarda, no supo, pasó sin motivo, molesto; cada una según su aviso', () => {
  const now = 10_000_000,
    min = 60_000;
  const base = {
    conversationId: 'c1',
    name: 'Ana · demo',
    status: 'open',
    assignedTo: null,
    lastCustomerAt: now - 6 * min,
    lastOutboundAt: now - 7 * min,
    lastCustomerText: '¿y se puede pagar en dos partes?',
    previousCustomerText: '',
    lastAutomationText: '',
  };
  const kinds = (c, cfg = {}) => detectAlerts(c, { ...DEFAULT_ALERTS, ...cfg }, now).map(a => a.kind);
  assert.deepEqual(kinds(base), ['sin_respuesta']);
  assert.match(detectAlerts(base, DEFAULT_ALERTS, now)[0].text, /Ana · demo lleva 6 min sin respuesta/);
  assert.deepEqual(kinds({ ...base, lastCustomerAt: now - 2 * min }), [], 'todavía no pasa el tiempo elegido');
  assert.deepEqual(kinds({ ...base, lastCustomerAt: now - 2 * min }, { waitMinutes: 1 }), ['sin_respuesta']);
  assert.deepEqual(kinds({ ...base, lastOutboundAt: now - min }), [], 'ya le contestaron');
  assert.deepEqual(kinds({ ...base, assignedTo: 'u1', assigneeName: 'Ana' }), ['persona_tarda']);
  assert.deepEqual(kinds({ ...base, assignedTo: 'u1' }, { persona_tarda: false }), []);
  assert.deepEqual(kinds({ ...base, status: 'resolved' }), []);
  const noSupo = {
    ...base,
    lastOutboundAt: now,
    lastAutomationText: 'Esa pregunta todavía no la tengo a la mano.\n\nLo que sí puedo…',
    previousCustomerText: '¿cuánto dura cada clase?',
  };
  assert.deepEqual(kinds(noSupo), ['no_supo']);
  assert.match(detectAlerts(noSupo, DEFAULT_ALERTS, now)[0].text, /cuánto dura cada clase/);
  const paso = {
    ...base,
    lastOutboundAt: now,
    lastAutomationText: 'Te paso con una persona del equipo.',
    previousCustomerText: 'ok gracias',
  };
  assert.deepEqual(kinds(paso), ['paso_sin_motivo']);
  assert.deepEqual(kinds({ ...paso, previousCustomerText: 'quiero hablar con alguien del equipo' }), []);
  const molesto = { ...base, lastOutboundAt: now, lastCustomerText: 'llevo 3 días esperando respuesta' };
  assert.deepEqual(kinds(molesto), [], 'apagado por omisión');
  assert.deepEqual(kinds(molesto, { molesto: true }), ['molesto']);
  assert.deepEqual(detectAlerts(null, DEFAULT_ALERTS, now), []);
});

test('Claude actúa cada cliente: el guion manda qué decir, Claude pone las palabras; costo estimado y limpieza', async () => {
  const persona = { label: 'Sensible al precio', description: 'Pregunta el precio y regatea.' };
  const transcript = [
    { kind: 'customer', text: 'hola, info del curso' },
    { kind: 'automation', text: '🎓 Precio: $1,200 MXN. ¿Quieres el temario?' },
  ];
  const { system, messages } = buildPrompt({
    persona,
    gist: '¿Hay descuento?',
    transcript,
    brandName: 'GlobalVet',
    courseTitle: 'Aves',
    human: false,
  });
  assert.match(system, /Sensible al precio/);
  assert.match(system, /«¿Hay descuento\?»/);
  assert.match(system, /No inventes nombres, teléfonos, correos/);
  // el cliente es «assistant» y el negocio «user»; termina en user para que el modelo hable
  assert.deepEqual(
    messages.map(m => m.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(messages.at(-1).content, '🎓 Precio: $1,200 MXN. ¿Quieres el temario?');
  assert.equal(buildPrompt({ persona, gist: 'hola', transcript: [], brandName: 'X' }).messages.at(-1).role, 'user');
  assert.equal(cleanLine('Cliente: "¿y hay descuento?"'), '¿y hay descuento?');
  assert.equal(cleanLine('(no responde)'), '');
  assert.equal(costCents('claude-sonnet-5-5', 1_000_000, 100_000), 450);
  assert.equal(costCents('claude-haiku-5-5', 1_000_000, 0), 100);
  // con un proveedor de mentira: usa act() y limpia; sin texto, dice por qué
  const calls = [];
  const fake = {
    act: async x => (
      calls.push(x),
      { text: '«pues sí, pero ¿no hay algún descuento? 🙏»', usage: { input_tokens: 10, output_tokens: 5 }, model: 'm' }
    ),
  };
  const out = await customerLine(fake, { persona, gist: '¿Hay descuento?', transcript, brandName: 'GlobalVet' });
  assert.equal(out.text, 'pues sí, pero ¿no hay algún descuento? 🙏');
  assert.equal(calls[0].kind, 'jornada');
  const none = await customerLine(
    { act: async () => ({ text: null, reason: 'tope' }) },
    { persona, gist: 'x', transcript: [] },
  );
  assert.equal(none.text, null);
  assert.equal(none.reason, 'tope');
});

test('informe: agrupa los fallos con ejemplo y qué hacer', () => {
  const alerts = [
    {
      kind: 'no_supo',
      text: 'El asistente no supo: «¿cuánto dura cada clase?»',
      detail: 'Luis · demo',
      conversationId: 'c1',
    },
    {
      kind: 'no_supo',
      text: 'El asistente no supo: «¿Cuánto dura cada clase?»',
      detail: 'Ana · demo',
      conversationId: 'c2',
    },
    {
      kind: 'paso_sin_motivo',
      text: 'Pasó a persona sin motivo claro',
      detail: 'Sofía · demo · después de «ok gracias»',
      conversationId: 'c3',
    },
    { kind: 'sin_respuesta', text: 'Mariana · demo lleva 6 min sin respuesta', detail: '', conversationId: 'c4' },
    { kind: 'persona_tarda', text: 'Jorge · demo lleva 9 min sin respuesta de Ana', detail: '', conversationId: 'c5' },
  ];
  const conversations = [
    { id: 'c1', name: 'Luis · demo', state: 'closed', last: { kind: 'automation', text: 'x' } },
    { id: 'c6', name: 'Diego · demo', state: 'assistant', last: { kind: 'customer', text: '¿me contestan?' } },
  ];
  const r = buildReport({
    alerts,
    conversations,
    byPersona: { curioso: { total: 3, done: 2, waiting: 1 } },
    stats: { arrived: 6, assistantOnly: 4, handled: 1, paid: 1, agentMedianMs: 60_000 },
    personaLabels: { curioso: 'Curioso' },
  });
  assert.deepEqual(
    r.groups.map(g => [g.kind, g.count, g.action]),
    [
      ['no_supo', 2, 'knowledge'],
      ['paso_sin_motivo', 1, 'evaluation'],
      ['esperas', 2, 'review'],
      ['sin_cerrar', 1, 'review'],
    ],
  );
  assert.equal(r.groups[0].payload.question, '¿cuánto dura cada clase?');
  assert.equal(r.groups[1].payload.cases[0].inputText, 'ok gracias');
  assert.equal(r.groups[1].payload.cases[0].expectAction, 'replied');
  assert.match(r.groups[2].detail, /9 min/);
  assert.equal(r.summary.problems, 6);
  assert.deepEqual(r.personas, [{ id: 'curioso', label: 'Curioso', total: 3, done: 2, waiting: 1 }]);
  assert.deepEqual(buildReport({}).groups, []);
});

test('migración jornada/0002: columnas de IA aditivas sobre la 0001', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-jornada-mig2-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== 'jornada/0002-ai')) });
  db.prepare(
    'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
  ).run('u-mig2', 'mig2', 'Persona', 'unused', 'admin', 800002, 1, 1);
  db.prepare(
    "INSERT INTO jornada_runs(id,brand_id,title,count,minutes,rhythm,personas,state,starts_at,ends_at,created_by,created_at,updated_at) VALUES('r1','globalvet','x',1,1,'goteo','[]','finished',1,2,'u-mig2',1,1)",
  ).run();
  assert.deepEqual(migrate(db, { backup: false }).applied, ['jornada/0002-ai']);
  assertSchemaCurrent(db);
  const r = db.prepare('SELECT ai,ai_cap_cents,ai_calls FROM jornada_runs WHERE id=?').get('r1');
  assert.deepEqual({ ...r }, { ai: 'guiones', ai_cap_cents: 300, ai_calls: 0 });
});

test('migración jornada/0001: sobre una base ya publicada, aditiva y una sola vez', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-jornada-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => !m.name.startsWith('jornada/'))) });
  const before = db.prepare('SELECT count(*) n FROM simulator_runs').get().n;
  assert.deepEqual(migrate(db, { backup: false }).applied, ['jornada/0001-jornada', 'jornada/0002-ai']);
  assertSchemaCurrent(db);
  assert.equal(db.prepare('SELECT count(*) n FROM jornada_runs').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM simulator_runs').get().n, before);
  assert.deepEqual(migrate(db, { backup: false }).applied, []);
});

test('jornada de punta a punta: crear, llegadas a tiempo, vista en vivo, chat, pausa, terminar, archivar y permisos', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-jornada-'));
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
  const agent = (
    await call(origin, '/api/auth/register', { body: { username: 'asesora', name: 'Asesora', password: PASSWORD } })
  ).cookie;
  db.prepare("UPDATE users SET role='agent' WHERE username='asesora'").run();
  const agentId = db.prepare("SELECT id FROM users WHERE username='asesora'").get().id;
  db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(agentId, 'globalvet');

  // opciones y permisos
  const opts = await api('/api/jornada');
  assert.equal(opts.enabled, true);
  assert.deepEqual(opts.runs, []);
  assert.ok(opts.options.personas.some(p => p.id === 'curioso'));
  assert.ok(opts.options.team.some(u => u.id === agentId));
  await call(origin, '/api/jornada', { cookie: agent, expected: 403 });
  await call(origin, '/api/jornada', { expected: 401 });

  // validaciones
  await api('/api/jornada', { body: { brandId: 'globalvet', count: 0, minutes: 10 }, expected: 400 });
  await api('/api/jornada', { body: { brandId: 'globalvet', count: 2, minutes: 0 }, expected: 400 });
  await api('/api/jornada', { body: { brandId: 'no-existe', count: 2, minutes: 10 }, expected: 404 });
  await api('/api/jornada', {
    body: { brandId: 'globalvet', count: 2, minutes: 10, personas: ['marciano'] },
    expected: 400,
  });

  // crear: 2 clientes en 1 minuto, ritmo rápido, la asesora atiende lo que pasa a persona
  const made = await api('/api/jornada', {
    body: {
      brandId: 'globalvet',
      title: 'Prueba corta',
      count: 2,
      minutes: 1,
      rhythm: 'parejo',
      pace: 'rapida',
      personas: ['curioso', 'desconocido'],
      assigneeId: agentId,
      alerts: { waitMinutes: 1, molesto: true },
    },
    expected: 201,
  });
  const run = made.run;
  assert.equal(run.state, 'running');
  assert.equal(run.planned, 2);
  assert.equal(run.assigneeName, 'Asesora');
  assert.equal(run.alertsConfig.waitMinutes, 1);
  assert.equal(run.alertsConfig.molesto, true);
  assert.ok(run.blocks.length >= 1 && run.blocks[0].planned === 2);
  // una sola en curso por marca
  await api('/api/jornada', { body: { brandId: 'globalvet', count: 1, minutes: 5 }, expected: 409 });

  // las llegadas se suman solas (la primera de inmediato) y cada una empieza a hablar por la API pública
  const view = () => api('/api/jornada/' + run.id).then(d => d.run);
  await until(async () => (await view()).stats.arrived >= 1, 'la primera llegada', { ms: 10_000, logs: server.logs });
  await until(
    async () => (await view()).conversations.some(c => c.id && c.last),
    'el primer cliente escribe y el asistente contesta',
    { ms: 20_000, logs: server.logs },
  );
  let v = await view();
  const c = v.conversations.find(x => x.id);
  assert.match(c.name, /· demo$/);
  assert.ok(['assistant', 'waiting', 'agent', 'closed'].includes(c.state));
  assert.ok(v.stats.arrived >= 1 && v.stats.arrived <= 2);
  assert.equal(typeof v.elapsedMs, 'number');
  const lista = await api('/api/jornada');
  assert.equal(lista.runs[0].id, run.id);
  assert.ok(lista.runs[0].arrived >= 1);

  // el chat de la jornada, como texto plano; otra conversación no es de esta jornada
  const chat = await api(`/api/jornada/${run.id}/conversations/${c.id}`);
  assert.ok(chat.messages.length >= 1);
  assert.equal(chat.messages[0].kind, 'customer');
  assert.equal(chat.messages[0].who, 'Cliente simulado');
  await api(`/api/jornada/${run.id}/conversations/${randomUUID()}`, { expected: 404 });
  // la asesora no ve nada de esto (sólo administración) y otra marca tampoco
  await call(origin, '/api/jornada/' + run.id, { cookie: agent, expected: 403 });

  // pausa y reanudar: las planeadas se corren el tiempo de la pausa
  const antes = db
    .prepare('SELECT planned_at,state FROM jornada_arrivals WHERE run_id=? ORDER BY planned_at')
    .all(run.id);
  const p = await api(`/api/jornada/${run.id}/pause`, { body: {} });
  assert.equal(p.run.state, 'paused');
  await api(`/api/jornada/${run.id}/pause`, { body: {}, expected: 409 });
  await new Promise(r => setTimeout(r, 700));
  const r2 = await api(`/api/jornada/${run.id}/resume`, { body: {} });
  assert.equal(r2.run.state, 'running');
  const despues = db
    .prepare('SELECT planned_at,state FROM jornada_arrivals WHERE run_id=? ORDER BY planned_at')
    .all(run.id);
  for (let i = 0; i < antes.length; i++)
    if (antes[i].state === 'planned' && despues[i].state === 'planned')
      assert.ok(despues[i].planned_at > antes[i].planned_at, 'la llegada planeada se corrió');
  assert.ok(db.prepare('SELECT paused_ms FROM jornada_runs WHERE id=?').get(run.id).paused_ms >= 600);

  // IA: en este servidor el motor es el simulado, así que «Claude actúa cada cliente» no se puede elegir
  assert.equal(opts.options.ai.available, false);
  await api('/api/jornada', { body: { brandId: 'odonteck', count: 1, minutes: 5, ai: 'claude' }, expected: 409 });
  assert.equal(v.ai.mode, 'guiones');
  assert.equal(v.ai.capCents, 300);

  // informe (vista previa en curso) y sus botones: un borrador de conocimiento y casos del banco
  const rep = (await api(`/api/jornada/${run.id}/report`)).report;
  assert.ok(Array.isArray(rep.groups) && rep.summary.arrived >= 1);
  const k1 = await api(`/api/jornada/${run.id}/report/knowledge`, {
    body: { question: '¿cuánto dura cada clase?' },
    expected: 201,
  });
  assert.equal(k1.created, true);
  assert.equal(db.prepare('SELECT status FROM knowledge_entries WHERE id=?').get(k1.entry.id).status, 'draft');
  assert.equal(db.prepare('SELECT brand_id FROM knowledge_entries WHERE id=?').get(k1.entry.id).brand_id, 'globalvet');
  const k2 = await api(`/api/jornada/${run.id}/report/knowledge`, {
    body: { question: '¿Cuánto dura cada clase?' },
    expected: 201,
  });
  assert.equal(k2.created, false, 'la misma pregunta no se repite');
  await api(`/api/jornada/${run.id}/report/knowledge`, { body: { question: 'x' }, expected: 400 });
  const ev = await api(`/api/jornada/${run.id}/report/evaluation`, {
    body: {
      cases: [
        { inputText: 'ok gracias', expectAction: 'replied', title: 'No pasar a persona por un «ok»' },
        { inputText: 'x' },
      ],
    },
    expected: 201,
  });
  assert.equal(ev.cases.length, 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM eval_cases WHERE brand_id='globalvet' AND tags='jornada'").get().n,
    1,
  );

  // alertas: resolver una inexistente responde 409; la lista viene ordenada (activas primero)
  await api(`/api/jornada/${run.id}/alerts/${randomUUID()}/resolve`, { body: {}, expected: 409 });
  assert.ok(Array.isArray(v.alerts));

  // terminar: lo planeado que no llegó se salta y la demo del simulador se detiene
  const f = await api(`/api/jornada/${run.id}/finish`, { body: {} });
  assert.equal(f.run.state, 'finished');
  assert.equal(
    db.prepare("SELECT count(*) n FROM jornada_arrivals WHERE run_id=? AND state='planned'").get(run.id).n,
    0,
  );
  const simId = db.prepare('SELECT simulator_run_id FROM jornada_runs WHERE id=?').get(run.id).simulator_run_id;
  assert.ok(simId);
  assert.ok(
    ['stopped', 'finished'].includes(db.prepare('SELECT state FROM simulator_runs WHERE id=?').get(simId).state),
  );
  await api(`/api/jornada/${run.id}/finish`, { body: {}, expected: 409 });
  // archivar cierra los chats demo
  const a = await api(`/api/jornada/${run.id}/archive`, { body: {} });
  assert.equal(a.run.state, 'archived');
  assert.equal(db.prepare('SELECT state FROM simulator_runs WHERE id=?').get(simId).state, 'archived');
  assert.equal(db.prepare('SELECT status FROM conversations WHERE id=?').get(c.id).status, 'resolved');
  assert.deepEqual((await api('/api/jornada')).runs, [], 'las archivadas no se listan');
  // y ya se puede empezar otra en la marca
  const otra = await api('/api/jornada', {
    body: { brandId: 'globalvet', count: 1, minutes: 1, pace: 'rapida' },
    expected: 201,
  });
  await api(`/api/jornada/${otra.run.id}/finish`, { body: {} });
  assertSchemaCurrent(db);
});
