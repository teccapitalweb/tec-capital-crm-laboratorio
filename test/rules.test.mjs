// Reglas por mensaje de punta a punta (docs/PLAN_REGLAS.md), con el servidor real: almacén con revisión y clientRef,
// orden de la lista, cada acción, el orden de atención (persona → recorrido en curso → reglas → recorrido que arranca →
// asistente), sus guardas (automatización, nivel del asistente, persona a cargo, baja, ventana, modo escucha, tope de
// respuestas seguidas), «una vez» y descanso, una regla que falla, el alcance por marca y «Probar» sin efectos.
// Nada depende de que el reloj avance entre dos líneas: el descanso se prueba moviendo la hora de la bitácora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, metaText } from './helpers/fake-meta.mjs';

const MIGRATION = 'rules/0001-rules';
const ref = () => randomUUID();
const kw = (words, mode = 'contains') => ({ type: 'keyword', words, mode });

async function lab(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-reglas-'));
  const code = randomUUID();
  const env = { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' };
  const server = await startServer({ dir, env });
  const db = openDb(dir);
  t.after(async () => {
    try {
      db.close();
    } catch {
      /* ya cerrada */
    }
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  assertSchemaCurrent(db);
  const origin = server.origin;
  const admin = await registerAdmin(origin, code);
  const api = (path, options = {}) => call(origin, path, { cookie: admin, ...options });
  let n = 0;
  const logs = { logs: () => server.logs() };
  // Espera a que el trabajo del asistente para ese mensaje termine (lo atienda quien lo atienda).
  const settle = id =>
    until(
      () => {
        const job = db.prepare('SELECT state FROM jobs WHERE message_id=?').get(id);
        return job && job.state !== 'pending';
      },
      'se atendió el mensaje ' + id,
      logs,
    );
  async function customer(name = 'Ana Pérez', courseId = 'aves') {
    const u = await call(origin, '/api/auth/register', {
      body: { username: 'persona' + ++n, name, password: PASSWORD },
    });
    const conv = (
      await call(origin, '/api/conversations', { cookie: u.cookie, body: { courseId, channel: 'whatsapp' } })
    ).conversation.id;
    const send = async text =>
      (
        await call(origin, '/api/conversations/' + conv + '/messages', {
          cookie: u.cookie,
          body: { text, clientRef: ref() },
          expected: 201,
        })
      ).id;
    // Manda y espera: devuelve la fila de reply_log (si alguien contestó) y la respuesta.
    const say = async text => {
      const id = await send(text);
      await settle(id);
      const log = db.prepare('SELECT * FROM reply_log WHERE trigger_message_id=?').get(id) ?? null;
      const reply = log?.reply_message_id
        ? db.prepare('SELECT * FROM messages WHERE id=?').get(log.reply_message_id)
        : null;
      return { id, log, reply };
    };
    return { conv, cookie: u.cookie, send, say };
  }
  async function enableAutomation(brandId = 'globalvet', enabled = true) {
    const current = (await api('/api/automation')).brands.find(b => b.id === brandId);
    await api('/api/automation/brands/' + brandId, {
      method: 'PATCH',
      body: { enabled, expectedRevision: current.revision },
    });
  }
  async function replyMode(mode, brandId = 'globalvet') {
    const cur = (await api('/api/replies/settings')).settings.find(x => x.brand_id === brandId);
    await api('/api/replies/brands/' + brandId, { method: 'PATCH', body: { mode, expectedRevision: cur.revision } });
  }
  // Crea una regla y, si se pide, la enciende. Devuelve su vista.
  async function rule(definition, { title = 'Regla ' + ++n, brandId = 'globalvet', activate = true } = {}) {
    let { rule: r } = await api('/api/rules', {
      body: { brandId, title, definition: { v: 1, ...definition }, clientRef: ref() },
      expected: 201,
    });
    if (activate)
      ({ rule: r } = await api('/api/rules/' + r.id + '/activate', { body: { expectedRevision: r.revision } }));
    return r;
  }
  async function setStatus(r, action) {
    const fresh = (await api('/api/rules/' + r.id)).rule;
    return (await api('/api/rules/' + r.id + '/' + action, { body: { expectedRevision: fresh.revision } })).rule;
  }
  const tag = (name, brandId = 'globalvet') => {
    const id = randomUUID();
    db.prepare('INSERT INTO contact_tags(id,brand_id,name,name_key,created_at) VALUES(?,?,?,?,1)').run(
      id,
      brandId,
      name,
      name.toLowerCase(),
    );
    return id;
  };
  const material = (title, body, brandId = 'globalvet', status = 'approved') => {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO content_templates(id,brand_id,title,scenario,channel,body,status,revision,created_at,updated_at) VALUES(?,?,?,'general','all',?,?,1,1,1)",
    ).run(id, brandId, title, body, status);
    return id;
  };
  const contactOf = conv =>
    db
      .prepare(
        'SELECT o.contact_id id FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=?',
      )
      .get(conv)?.id;
  const tagsOf = conv =>
    db
      .prepare('SELECT tag_id FROM contact_tag_links WHERE contact_id=?')
      .all(contactOf(conv))
      .map(r => r.tag_id);
  const runs = ruleId =>
    db
      .prepare('SELECT * FROM automation_rule_runs WHERE rule_id=? ORDER BY created_at,rowid')
      .all(ruleId)
      .map(r => ({ ...r, actions: JSON.parse(r.actions) }));
  const conversation = conv => db.prepare('SELECT * FROM conversations WHERE id=?').get(conv);
  const ruleMessages = conv =>
    db.prepare("SELECT * FROM messages WHERE conversation_id=? AND client_ref LIKE 'rule:%' ORDER BY seq").all(conv);
  return {
    dir,
    db,
    origin,
    admin,
    api,
    server,
    customer,
    enableAutomation,
    replyMode,
    rule,
    setStatus,
    tag,
    material,
    contactOf,
    tagsOf,
    runs,
    conversation,
    ruleMessages,
    settle,
  };
}

test('migración rules/0001 sobre una base ya publicada: aditiva, una sola vez y lo guardado persiste', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-reglas-mig-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let db = openDatabase(dir);
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => m.name !== MIGRATION)) });
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'automation_rule%'").get().n, 0);
  const conversations = db.prepare('SELECT count(*) n FROM conversations').get().n;
  assert.deepEqual(migrate(db, { backup: false }).applied, [MIGRATION]);
  assertSchemaCurrent(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'automation_rule%' ORDER BY name")
    .all()
    .map(r => r.name);
  assert.deepEqual(tables, ['automation_rule_runs', 'automation_rule_settings', 'automation_rules']);
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, conversations);
  // Lo guardado sobrevive a cerrar y abrir, y la migración no se vuelve a aplicar.
  db.prepare(
    "INSERT INTO automation_rules(id,brand_id,title,trigger,definition,position,created_at,updated_at) VALUES('r1','globalvet','Precio','keyword','{}',0,1,1)",
  ).run();
  db.close();
  db = openDatabase(dir);
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'no se aplica dos veces');
  assert.equal(db.prepare("SELECT status FROM automation_rules WHERE id='r1'").get().status, 'draft');
  const fresh = await mkdtemp(join(tmpdir(), 'crm-reglas-nueva-'));
  t.after(() => rm(fresh, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const other = openDatabase(fresh);
  migrate(other, { backup: false });
  assert.deepEqual(schemaShape(db), schemaShape(other), 'una base actualizada y una nueva quedan iguales');
  other.close();
  db.close();
});

test('almacén: borrador arriba, clientRef, revisión, encender con referencias, orden, permisos, marca y «Probar» sin efectos', async t => {
  const L = await lab(t);
  const { api, db } = L;
  const definition = { v: 1, trigger: kw(['precio']), actions: [{ type: 'send_text', text: 'Hola, {{nombre}}' }] };
  // Sin clientRef no se crea; con el mismo clientRef no se duplica (reintento).
  await api('/api/rules', { body: { brandId: 'globalvet', title: 'x', definition }, expected: 400 });
  const clientRef = ref();
  const first = await api('/api/rules', {
    body: { brandId: 'globalvet', title: 'Precio', definition, clientRef },
    expected: 201,
  });
  const again = await api('/api/rules', { body: { brandId: 'globalvet', title: 'Otra', definition, clientRef } });
  assert.equal(again.rule.id, first.rule.id);
  assert.equal(again.duplicate, true);
  assert.equal(db.prepare('SELECT count(*) n FROM automation_rules').get().n, 1);
  assert.equal(first.rule.status, 'draft', 'nace en borrador: no corre');
  // Problemas de la definición: 400 con la lista.
  const invalid = await api('/api/rules', {
    body: { brandId: 'globalvet', title: 'Mal', definition: { trigger: kw([]), actions: [] }, clientRef: ref() },
    expected: 400,
  });
  assert.equal(invalid.code, 'rule_invalid');
  assert.ok(invalid.details.problems.length >= 2);
  // Una regla nueva entra arriba de la lista.
  const second = await L.rule(
    { trigger: kw(['horario']), actions: [{ type: 'send_text', text: 'Horario' }] },
    {
      title: 'Horario',
      activate: false,
    },
  );
  let list = await api('/api/rules?brand=globalvet');
  assert.deepEqual(
    list.rules.map(r => r.title),
    ['Horario', 'Precio'],
  );
  // Revisión: guardar con una revisión vieja da 409; el reintento con la vieja también.
  const saved = await api('/api/rules/' + first.rule.id, {
    method: 'PATCH',
    body: { title: 'Precio del curso', expectedRevision: first.rule.revision },
  });
  assert.equal(saved.rule.revision, first.rule.revision + 1);
  const conflict = await api('/api/rules/' + first.rule.id, {
    method: 'PATCH',
    body: { title: 'Tarde', expectedRevision: first.rule.revision },
    expected: 409,
  });
  assert.equal(conflict.code, 'stale_record');
  // No se enciende si lo que usa no está listo (material sin aprobar).
  const draftMaterial = L.material('Borrador', 'Texto', 'globalvet', 'draft');
  const withMaterial = await L.rule(
    { trigger: kw(['temario']), actions: [{ type: 'send_material', materialId: draftMaterial }] },
    { activate: false },
  );
  assert.ok(withMaterial.issues.length);
  const notReady = await api('/api/rules/' + withMaterial.id + '/activate', {
    body: { expectedRevision: withMaterial.revision },
    expected: 409,
  });
  assert.equal(notReady.code, 'rule_not_ready');
  // Reordenar: con el candado del orden y la lista completa.
  list = await api('/api/rules?brand=globalvet');
  const ids = list.rules.map(r => r.id).reverse();
  await api('/api/rules/order', {
    method: 'PUT',
    body: { brandId: 'globalvet', ids: ids.slice(1), expectedOrderRevision: list.settings.orderRevision },
    expected: 409,
  });
  const ordered = await api('/api/rules/order', {
    method: 'PUT',
    body: { brandId: 'globalvet', ids, expectedOrderRevision: list.settings.orderRevision },
  });
  assert.equal(ordered.orderRevision, list.settings.orderRevision + 1);
  await api('/api/rules/order', {
    method: 'PUT',
    body: { brandId: 'globalvet', ids, expectedOrderRevision: list.settings.orderRevision },
    expected: 409,
  });
  list = await api('/api/rules?brand=globalvet');
  assert.deepEqual(
    list.rules.map(r => r.id),
    ids,
  );
  // El panel del orden de atención: cinco pasos, en el orden del despachador.
  assert.deepEqual(
    list.attention.steps.map(s => s.key),
    ['person', 'flow_in_progress', 'rules', 'flow_start', 'assistant'],
  );
  // Archivar la saca de la lista.
  await L.setStatus(second, 'archive');
  list = await api('/api/rules?brand=globalvet');
  assert.ok(!list.rules.some(r => r.id === second.id));

  // Permisos y marca: un cliente no ve nada; un asesor de OdonTeck no ve ni toca las reglas de GlobalVet.
  const outsider = await L.customer('Curioso');
  await call(L.origin, '/api/rules?brand=globalvet', { cookie: outsider.cookie, expected: 403 });
  await call(L.origin, '/api/rules/' + first.rule.id, { cookie: outsider.cookie, expected: 403 });
  const agent = (
    await call(L.origin, '/api/auth/register', {
      body: { username: 'asesor-odon', name: 'Asesor', password: PASSWORD },
    })
  ).cookie;
  const agentId = db.prepare("SELECT id FROM users WHERE username='asesor-odon'").get().id;
  db.prepare("UPDATE users SET role='agent' WHERE id=?").run(agentId);
  db.prepare("INSERT INTO brand_members(user_id,brand_id) VALUES(?,'odonteck')").run(agentId);
  await call(L.origin, '/api/rules?brand=globalvet', { cookie: agent, expected: 404 });
  await call(L.origin, '/api/rules/' + first.rule.id, { cookie: agent, expected: 404 });
  const own = await call(L.origin, '/api/rules?brand=odonteck', { cookie: agent });
  assert.deepEqual(own.rules, []);
  assert.deepEqual(
    own.brands.map(b => b.id),
    ['odonteck'],
  );
  await call(L.origin, '/api/rules', {
    cookie: agent,
    body: { brandId: 'odonteck', title: 'x', definition, clientRef: ref() },
    expected: 403,
  });

  // «Probar» no escribe ni envía nada, aunque la regla responda.
  await L.enableAutomation();
  await L.setStatus(first.rule, 'activate');
  const count = () =>
    ['messages', 'reply_log', 'automation_rule_runs', 'chatflow_sessions', 'audit'].map(
      table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
    );
  const before = count();
  const tried = await api('/api/rules/test', {
    body: { brandId: 'globalvet', text: '¿Cuál es el precio?', courseId: 'aves' },
  });
  assert.equal(tried.sent, false);
  assert.equal(tried.answeredBy, 'rule');
  const fired = tried.rules.find(r => r.ruleId === first.rule.id);
  assert.equal(fired.voice, true);
  assert.equal(fired.actions[0].preview, 'Hola, Ana');
  // Una definición sin guardar se prueba en su lugar.
  const draftTry = await api('/api/rules/test', {
    body: {
      brandId: 'globalvet',
      text: 'quiero inscribirme',
      draft: { definition: { trigger: kw(['inscribirme']), actions: [{ type: 'send_text', text: 'Claro' }] } },
    },
  });
  assert.equal(draftTry.answeredBy, 'rule');
  assert.equal(draftTry.rules[0].draft, true);
  const none = await api('/api/rules/test', { body: { brandId: 'globalvet', text: 'buenas tardes' } });
  assert.equal(none.answeredBy, 'assistant');
  assert.deepEqual(count(), before, '«Probar» no dejó nada escrito');
});

test('reglas atendiendo: acciones, orden de la lista, orden de atención, una vez, descanso y tope de respuestas seguidas', async t => {
  const L = await lab(t);
  const { api, db } = L;
  // Sin reglas, aun con la automatización encendida, todo responde como siempre.
  await L.enableAutomation();
  const plain = await L.customer('Beto Ruiz');
  const hello = await plain.say('¿Cuál es el precio?');
  assert.ok(hello.log, 'contestó el asistente');
  assert.notEqual(hello.log.intent, 'rule');
  assert.equal(db.prepare('SELECT count(*) n FROM automation_rule_runs').get().n, 0);

  // Texto con datos del catálogo y de la persona; el contador sube.
  const price = await L.rule(
    {
      trigger: kw(['precio', 'costo']),
      actions: [{ type: 'send_text', text: 'Hola, {{nombre}}. El precio de {{curso}} es {{precio}}.' }],
    },
    { title: 'Precio' },
  );
  const ana = await L.customer('Ana Pérez');
  const asked = await ana.say('¿Cuál es el COSTO?');
  assert.equal(asked.log.intent, 'rule');
  assert.equal(asked.log.action, 'replied');
  assert.match(asked.reply.text, /^Hola, Ana\. El precio de .+ es .+\.$/);
  assert.doesNotMatch(asked.reply.text, /\{\{/);
  assert.deepEqual(JSON.parse(asked.log.sources)[0], { type: 'rule', id: price.id, revision: price.revision });
  let view = (await api('/api/rules/' + price.id)).rule;
  assert.equal(view.executions, 1);
  assert.ok(view.lastRunAt);
  assert.equal(L.runs(price.id)[0].outcome, 'executed');
  // Un mensaje que no coincide lo contesta el asistente.
  const other = await ana.say('buenas tardes');
  assert.notEqual(other.log?.intent, 'rule');

  // Orden de la lista: dos reglas con la misma palabra; habla la de arriba. Reordenar cambia quién habla.
  const promo = await L.rule(
    { trigger: kw(['precio']), actions: [{ type: 'send_text', text: 'Tenemos promoción.' }] },
    { title: 'Promoción' },
  );
  const bea = await L.customer('Bea Gil');
  assert.equal((await bea.say('precio')).reply.text, 'Tenemos promoción.');
  let list = await api('/api/rules?brand=globalvet');
  await api('/api/rules/order', {
    method: 'PUT',
    body: {
      brandId: 'globalvet',
      ids: list.rules.map(r => r.id).reverse(),
      expectedOrderRevision: list.settings.orderRevision,
    },
  });
  const beaAgain = await bea.say('precio, por favor');
  assert.match(beaAgain.reply.text, /^Hola, Bea/);
  // La de abajo coincidió pero otra ya había respondido: queda en la bitácora como omitida.
  const skipped = L.runs(promo.id).at(-1);
  assert.equal(skipped.outcome, 'skipped');
  assert.equal(skipped.actions[0].reason, 'voice_taken');
  await L.setStatus(promo, 'pause');

  // Acciones silenciosas: la etiqueta se pone y contesta el asistente con el dato nuevo.
  const interest = L.tag('Interesado');
  const silent = await L.rule(
    { trigger: kw(['interesa']), actions: [{ type: 'add_tag', tagId: interest }] },
    { title: 'Etiqueta' },
  );
  const caro = await L.customer('Caro Díaz');
  const tagged = await caro.say('me interesa el curso');
  assert.notEqual(tagged.log?.intent, 'rule', 'una regla silenciosa no toma la voz');
  assert.deepEqual(L.tagsOf(caro.conv), [interest]);
  // Reintento del mismo trabajo: la regla no corre dos veces.
  db.prepare("UPDATE jobs SET state='pending',due_at=? WHERE message_id=?").run(Date.now() - 1000, tagged.id);
  await L.settle(tagged.id);
  assert.equal(L.runs(silent.id).length, 1);
  // Quitar etiqueta.
  await L.rule({ trigger: kw(['quitame']), actions: [{ type: 'remove_tag', tagId: interest }] }, { title: 'Quitar' });
  await caro.say('quítame de esa lista');
  assert.deepEqual(L.tagsOf(caro.conv), []);

  // Material aprobado del catálogo, con su instantánea comercial; sin aprobar ya no sale y contesta el asistente.
  const syllabus = L.material('Temario', 'El temario de {{curso}} está listo.');
  const mat = await L.rule(
    { trigger: kw(['temario']), actions: [{ type: 'send_material', materialId: syllabus }] },
    { title: 'Temario' },
  );
  const dan = await L.customer('Dan Ortiz');
  const sent = await dan.say('¿me pasas el temario?');
  assert.equal(sent.log.intent, 'rule');
  assert.match(sent.reply.text, /El temario de .+ está listo\./);
  assert.ok(sent.reply.commercial_snapshot, 'sale con su instantánea del catálogo');
  db.prepare("UPDATE content_templates SET status='draft' WHERE id=?").run(syllabus);
  const dropped = await dan.say('el temario otra vez');
  assert.notEqual(dropped.log?.intent, 'rule');
  assert.equal(L.runs(mat.id).at(-1).actions[0].reason, 'material_unavailable');
  await L.setStatus(mat, 'pause');

  // Una vez por conversación.
  const once = await L.rule(
    {
      trigger: kw(['gracias']),
      actions: [{ type: 'send_text', text: 'A ti.' }],
      options: { limit: 'once_conversation' },
    },
    { title: 'Gracias' },
  );
  const eva = await L.customer('Eva Mora');
  assert.equal((await eva.say('gracias')).log.intent, 'rule');
  assert.notEqual((await eva.say('gracias de nuevo')).log?.intent, 'rule');
  assert.equal(L.runs(once.id).length, 1, 'no corrió: su límite la dejó fuera antes de ejecutarse');
  await L.setStatus(once, 'pause');

  // Descanso: no vuelve a correr hasta que pasa; se adelanta la hora de su última vez (sin esperar al reloj).
  const rest = await L.rule(
    {
      trigger: kw(['ubicación']),
      actions: [{ type: 'send_text', text: 'Es en línea.' }],
      options: { limit: 'cooldown', cooldownMinutes: 60 },
    },
    { title: 'Ubicación' },
  );
  const fer = await L.customer('Fer Ríos');
  assert.equal((await fer.say('ubicación')).log.intent, 'rule');
  assert.notEqual((await fer.say('ubicación?')).log?.intent, 'rule');
  db.prepare('UPDATE automation_rule_runs SET created_at=created_at-? WHERE rule_id=?').run(61 * 60_000, rest.id);
  assert.equal((await fer.say('¿ubicación?')).log.intent, 'rule');
  await L.setStatus(rest, 'pause');

  // Tope de respuestas seguidas de reglas (ningún bucle con otro sistema automático): con tope 2, la tercera la
  // contesta el asistente y la racha vuelve a empezar.
  const settings = (await api('/api/rules?brand=globalvet')).settings;
  await api('/api/rules/settings/globalvet', {
    method: 'PATCH',
    body: { maxConsecutive: 2, expectedRevision: settings.revision },
  });
  const gil = await L.customer('Gil Soto');
  assert.equal((await gil.say('precio')).log.intent, 'rule');
  assert.equal((await gil.say('precio')).log.intent, 'rule');
  const capped = await gil.say('precio');
  assert.notEqual(capped.log?.intent, 'rule');
  assert.equal(L.runs(price.id).at(-1).actions[0].reason, 'consecutive_cap');
  assert.equal((await gil.say('precio')).log.intent, 'rule');
  await api('/api/rules/settings/globalvet', {
    method: 'PATCH',
    body: { maxConsecutive: 3, expectedRevision: settings.revision },
    expected: 409,
  });
});

test('orden de atención: persona, recorrido en curso, regla, recorrido que arranca y asistente; pasar, estados y una regla que falla', async t => {
  const L = await lab(t);
  const { api, db } = L;
  await L.enableAutomation();
  // Un recorrido publicado que arranca con el primer mensaje y otro sólo para iniciar desde una regla.
  const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
  const graph = text => ({
    v: 1,
    start: 'n1',
    variables: [],
    nodes: [
      node('n1', 'start'),
      node('n2', 'buttons', {
        header: { kind: 'none' },
        text,
        footer: '',
        options: [
          { id: 'si', label: 'Sí', do: { type: 'goto' } },
          { id: 'no', label: 'No', do: { type: 'goto' } },
        ],
      }),
      node('n3', 'end', { text: 'Listo.' }),
    ],
    edges: [
      { from: 'n1', port: 'next', to: 'n2' },
      { from: 'n2', port: 'opt:si', to: 'n3' },
      { from: 'n2', port: 'opt:no', to: 'n3' },
    ],
  });
  async function publish(name, start, text) {
    let { flow } = await api('/api/chatflows', {
      body: { brandId: 'globalvet', name, graph: graph(text), start, clientRef: ref() },
      expected: 201,
    });
    ({ flow } = await api('/api/chatflows/' + flow.id + '/publish', { body: { expectedRevision: flow.revision } }));
    ({ flow } = await api('/api/chatflows/' + flow.id + '/activate', { body: { expectedRevision: flow.revision } }));
    return flow;
  }
  const welcome = await publish('Bienvenida', { type: 'first_message' }, '¿Te interesa el curso?');
  const enroll = await publish('Inscripción', { type: 'manual' }, '¿Quieres inscribirte ya?');
  const session = conv =>
    db.prepare('SELECT * FROM chatflow_sessions WHERE conversation_id=? ORDER BY started_at DESC,rowid DESC').get(conv);

  // Una regla gana a un recorrido que arranca; el recorrido arranca si ninguna regla habla.
  const startRule = await L.rule(
    { trigger: kw(['inscribirme']), actions: [{ type: 'start_flow', flowId: enroll.id }] },
    { title: 'Inscribirme' },
  );
  const ana = await L.customer('Ana Pérez');
  const started = await ana.say('Hola, quiero inscribirme');
  assert.equal(started.log.intent, 'rule');
  assert.equal(started.reply.text.startsWith('¿Quieres inscribirte ya?'), true);
  let s = session(ana.conv);
  assert.equal(s.flow_id, enroll.id);
  assert.equal(s.started_by, 'rule');
  assert.deepEqual(
    JSON.parse(started.log.sources).map(x => x.type),
    ['rule', 'flow'],
  );
  // Recorrido en curso: va antes que las reglas, aunque la palabra clave vuelva a coincidir.
  const consumed = await ana.say('Sí');
  assert.equal(consumed.log.intent, 'flow');
  assert.equal(session(ana.conv).outcome, 'completed');
  const runsBefore = L.runs(startRule.id).length;
  const bob = await L.customer('Bob Luna');
  await bob.say('quiero inscribirme');
  const inFlow = await bob.say('inscribirme sí');
  assert.equal(L.runs(startRule.id).length, runsBefore + 1, 'en un recorrido en curso la regla no corre');
  assert.notEqual(inFlow.log?.intent, 'rule');
  // Ninguna regla coincide: arranca el recorrido de bienvenida.
  const cam = await L.customer('Cam Paz');
  const greeted = await cam.say('Buenas tardes');
  assert.equal(greeted.log.intent, 'flow');
  assert.equal(session(cam.conv).flow_id, welcome.id);
  // Una persona del equipo tomó el chat: nada automático (ni regla).
  const dora = await L.customer('Dora Vega');
  await dora.say('quiero inscribirme');
  await api('/api/conversations/' + dora.conv + '/messages', {
    body: { text: 'Te atiendo yo', clientRef: ref() },
    expected: 201,
  });
  const taken = L.runs(startRule.id).length;
  const late = await dora.send('quiero inscribirme');
  assert.equal(db.prepare('SELECT count(*) n FROM jobs WHERE message_id=?').get(late).n, 0);
  assert.equal(L.runs(startRule.id).length, taken);
  await L.setStatus(startRule, 'pause');
  await api('/api/chatflows/' + welcome.id + '/pause', {
    body: { expectedRevision: (await api('/api/chatflows/' + welcome.id)).flow.revision },
  });

  // Pasar con una persona (cola): asistente apagado en la conversación, en espera, con aviso propio de la marca.
  const handoff = await L.rule(
    {
      trigger: kw(['queja']),
      actions: [{ type: 'handoff', to: 'queue', text: 'Te paso con alguien del equipo, {{nombre}}.' }],
    },
    { title: 'Queja' },
  );
  const eli = await L.customer('Eli Cano');
  const passed = await eli.say('tengo una queja');
  assert.equal(passed.log.intent, 'rule');
  assert.equal(passed.log.action, 'escalated');
  assert.equal(passed.reply.text, 'Te paso con alguien del equipo, Eli.');
  assert.deepEqual([L.conversation(eli.conv).bot_enabled, L.conversation(eli.conv).status], [0, 'waiting']);
  await L.setStatus(handoff, 'pause');

  // Estados: Pendiente (no se envía nada) y Resuelta.
  const pend = await L.rule(
    { trigger: kw(['lo pienso']), actions: [{ type: 'set_status', status: 'pending' }] },
    { title: 'Pendiente' },
  );
  const fio = await L.customer('Fio Ríos');
  const thinking = await fio.say('lo pienso y te aviso');
  assert.equal(thinking.log.intent, 'rule');
  assert.equal(thinking.log.action, 'skipped');
  assert.equal(thinking.reply, null);
  assert.equal(L.conversation(fio.conv).state, 'pending');
  await L.setStatus(pend, 'pause');
  await L.rule(
    { trigger: kw(['ya quedó']), actions: [{ type: 'set_status', status: 'solved' }] },
    { title: 'Resolver' },
  );
  const gus = await L.customer('Gus Mar');
  await gus.say('ya quedó, gracias');
  assert.deepEqual([L.conversation(gus.conv).status, L.conversation(gus.conv).state], ['resolved', 'solved']);

  // Una regla que falla: lo suyo se deshace (la etiqueta no queda), se anota y contesta la siguiente del orden.
  const vip = L.tag('VIP');
  const broken = await L.rule(
    { trigger: kw(['factura']), actions: [{ type: 'add_tag', tagId: vip }] },
    { title: 'Rota' },
  );
  const backup = await L.rule(
    { trigger: kw(['factura']), actions: [{ type: 'send_text', text: 'Te ayudo con tu factura.' }] },
    { title: 'Respaldo' },
  );
  // «Rota» queda arriba y con una acción que el servidor no sabe ejecutar (una definición dañada a mano).
  const list = await api('/api/rules?brand=globalvet');
  const ids = [broken.id, ...list.rules.map(r => r.id).filter(id => id !== broken.id)];
  await api('/api/rules/order', {
    method: 'PUT',
    body: { brandId: 'globalvet', ids, expectedOrderRevision: list.settings.orderRevision },
  });
  db.prepare('UPDATE automation_rules SET definition=? WHERE id=?').run(
    JSON.stringify({ ...broken.definition, actions: [{ type: 'add_tag', tagId: vip }, { type: 'dañada' }] }),
    broken.id,
  );
  const hal = await L.customer('Hal Paz');
  const helped = await hal.say('necesito mi factura');
  assert.equal(helped.reply.text, 'Te ayudo con tu factura.');
  assert.deepEqual(JSON.parse(helped.log.sources)[0].id, backup.id);
  assert.deepEqual(L.tagsOf(hal.conv), [], 'lo que hizo la regla rota se deshizo');
  assert.equal(L.runs(broken.id)[0].outcome, 'failed');
  assert.ok((await api('/api/rules/' + broken.id)).rule.lastError);
  assert.ok(db.prepare("SELECT 1 FROM automation_events WHERE kind='rule_error'").get());
});

test('guardas: automatización apagada, nivel del asistente, baja, ventana cerrada y alcance por marca', async t => {
  const L = await lab(t);
  const { db } = L;
  const r = await L.rule({
    trigger: { type: 'any_message' },
    actions: [{ type: 'send_text', text: 'Hola desde una regla.' }],
  });
  // Automatización apagada: la regla no corre.
  const ana = await L.customer('Ana Pérez');
  assert.notEqual((await ana.say('hola')).log?.intent, 'rule');
  assert.equal(L.runs(r.id).length, 0);
  // Encendida pero con el asistente en «Sugerir al asesor»: tampoco.
  await L.enableAutomation();
  await L.replyMode('suggest');
  assert.notEqual((await ana.say('hola otra vez')).log?.intent, 'rule');
  assert.equal(L.runs(r.id).length, 0);
  await L.replyMode('templates');
  assert.equal((await ana.say('hola de nuevo')).log.intent, 'rule');
  // La persona pide la baja con palabras: la atiende el asistente, no la regla.
  const bye = await ana.say('baja');
  assert.equal(bye.log.intent, 'opt_out');
  // Contacto que ya pidió la baja: la regla no le escribe.
  const bea = await L.customer('Bea Gil');
  await L.api('/api/crm/contacts/' + L.contactOf(bea.conv) + '/consent', {
    method: 'PUT',
    body: { status: 'opted_out', note: 'Prueba' },
  });
  await bea.say('hola');
  assert.equal(L.runs(r.id).at(-1).actions[0].reason, 'opted_out');
  assert.equal(L.ruleMessages(bea.conv).length, 0);
  // Ventana de 24 horas cerrada (canal simulado): un mensaje viejo que aún espera respuesta no recibe texto libre.
  const cam = await L.customer('Cam Luna');
  await cam.say('hola');
  db.prepare(
    "INSERT INTO channel_settings(brand_id,enabled,enforce_window,delivery_delay_ms,failure_rate,revision,updated_by,updated_at) VALUES('globalvet',1,1,0,0,1,NULL,?) ON CONFLICT(brand_id) DO UPDATE SET enabled=1,enforce_window=1",
  ).run(Date.now());
  db.prepare("UPDATE messages SET created_at=created_at-? WHERE conversation_id=? AND sender_kind='customer'").run(
    25 * 3600_000,
    cam.conv,
  );
  const old = randomUUID();
  const customerId = L.conversation(cam.conv).customer_id;
  db.prepare(
    "INSERT INTO messages(id,conversation_id,sender_id,sender_kind,text,client_ref,created_at) VALUES(?,?,?,'customer',?,?,?)",
  ).run(old, cam.conv, customerId, 'hola, ¿siguen ahí?', old, Date.now() - 25 * 3600_000);
  const sentBefore = L.ruleMessages(cam.conv).length;
  db.prepare('INSERT INTO jobs(id,conversation_id,message_id,due_at) VALUES(?,?,?,?)').run(
    randomUUID(),
    cam.conv,
    old,
    Date.now(),
  );
  await until(
    () => db.prepare('SELECT 1 FROM automation_rule_runs WHERE source_key=?').get('msg:' + old),
    'la regla revisó el mensaje viejo',
  );
  const closed = db.prepare('SELECT * FROM automation_rule_runs WHERE source_key=?').get('msg:' + old);
  assert.equal(closed.outcome, 'skipped');
  assert.equal(JSON.parse(closed.actions)[0].reason, 'window_closed');
  assert.equal(L.ruleMessages(cam.conv).length, sentBefore);
  db.prepare("UPDATE channel_settings SET enabled=0,enforce_window=0 WHERE brand_id='globalvet'").run();
  // Alcance por marca: una regla de OdonTeck que atiende cualquier mensaje no toca a GlobalVet, y viceversa.
  await L.enableAutomation('odonteck');
  const odon = await L.rule(
    { trigger: { type: 'any_message' }, actions: [{ type: 'send_text', text: 'Hola desde OdonTeck.' }] },
    { brandId: 'odonteck' },
  );
  await L.setStatus(r, 'pause');
  const gv = await L.customer('Gil Soto');
  assert.notEqual((await gv.say('hola')).log?.intent, 'rule');
  assert.equal(L.runs(odon.id).length, 0);
  const od = await L.customer('Lia Cano', 'odontologia');
  const odHello = await od.say('hola');
  assert.equal(odHello.reply.text, 'Hola desde OdonTeck.');
  assert.ok(L.runs(odon.id).every(x => L.conversation(x.conversation_id).brand_id === 'odonteck'));
});

test('WhatsApp real: un número en modo escucha no recibe respuestas de reglas y un webhook repetido no repite la regla', async t => {
  const wl = await whatsappLab(t, { AI_PROVIDER: '' });
  const origin = wl.origin();
  const api = (path, options = {}) => call(origin, path, { cookie: wl.admin, ...options });
  const current = (await api('/api/automation')).brands.find(b => b.id === 'globalvet');
  await api('/api/automation/brands/globalvet', {
    method: 'PATCH',
    body: { enabled: true, expectedRevision: current.revision },
  });
  let { rule } = await api('/api/rules', {
    body: {
      brandId: 'globalvet',
      title: 'Saludo',
      definition: {
        v: 1,
        trigger: kw(['hola']),
        actions: [{ type: 'send_text', text: 'Hola, gracias por escribir.' }],
      },
      clientRef: ref(),
    },
    expected: 201,
  });
  ({ rule } = await api('/api/rules/' + rule.id + '/activate', { body: { expectedRevision: rule.revision } }));
  const db = wl.db;
  assert.equal((await metaText(origin, '5215511112222', 'wamid.regla.1', 'Hola')).status, 200);
  assert.equal((await metaText(origin, '5215511112222', 'wamid.regla.1', 'Hola')).status, 200);
  await until(() => db.prepare('SELECT 1 FROM automation_rule_runs WHERE rule_id=?').get(rule.id), 'la regla atendió');
  const conv = db.prepare('SELECT conversation_id id FROM automation_rule_runs WHERE rule_id=?').get(rule.id).id;
  await until(
    () => db.prepare("SELECT 1 FROM reply_log WHERE conversation_id=? AND intent='rule'").get(conv),
    'bitácora',
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM messages WHERE conversation_id=? AND client_ref LIKE 'rule:%'").get(conv).n,
    1,
  );
  // Modo escucha: lo que escribe otra persona se guarda, pero ninguna regla le contesta.
  db.prepare("UPDATE wa_numbers SET mode='listen' WHERE phone_number_id=?").run(NUMBER);
  const runs = db.prepare('SELECT count(*) n FROM automation_rule_runs').get().n;
  const heard = await metaText(origin, '5215533334444', 'wamid.regla.2', 'Hola');
  assert.match(heard.body.results[0].result, /^escucha/);
  assert.equal(db.prepare('SELECT count(*) n FROM automation_rule_runs').get().n, runs);
});
