import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

test('aprender de la IA: una respuesta de Claude aceptada queda como borrador, sin datos personales; aprobada, esa pregunta ya no llama a la IA', async t => {
  // Anthropic de mentira (el SDK respeta ANTHROPIC_BASE_URL): devuelve una respuesta que cita una entrada del conocimiento recibido
  let answer =
      '¡Hola, Ana! Sí: el curso es en línea, así que puedes tomarlo desde cualquier país con conexión a internet.',
    calls = 0;
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      calls++;
      const body = JSON.parse(raw),
        id = (String(body.system).match(/\[([0-9a-f-]{36})\] P:/) || [])[1];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_' + calls,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: JSON.stringify({ answer, used_ids: [id], confidence: 0.9 }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 300, output_tokens: 60 },
        }),
      );
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  const dir = await mkdtemp(join(tmpdir(), 'crm-learn-')),
    code = randomUUID(),
    password = 'Password-learn-2026!';
  let logs = '',
    db = null;
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dir,
      ADMIN_INVITE_CODE: code,
      APP_ORIGIN: '',
      NODE_ENV: 'test',
      AI_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: 'sk-ant-prueba-local',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + stub.address().port,
      AI_MONTHLY_CALL_LIMIT: '50',
      AI_MONTHLY_TOKEN_LIMIT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 10000);
    server.stderr.on('data', b => (logs += b));
    server.stdout.on('data', b => {
      const m = String(b).match(/http:\/\/127.0.0.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(Error(logs));
    });
  });
  t.after(async () => {
    try {
      db?.close();
    } catch {}
    if (server.exitCode === null)
      await new Promise(r => {
        server.once('exit', r);
        server.kill();
      });
    await new Promise(r => stub.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  async function call(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const r = await fetch(origin + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(result));
    return { ...result, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Administración',
    password,
    inviteCode: code,
  });
  db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  const rs = (await call('/api/replies/settings', admin.cookie)).settings.find(x => x.brand_id === 'globalvet');
  await call(
    '/api/replies/brands/globalvet',
    admin.cookie,
    { mode: 'autonomous', providerEnabled: true, expectedRevision: rs.revision },
    'PATCH',
  );
  const drafts = () =>
    db
      .prepare("SELECT * FROM knowledge_entries WHERE brand_id='globalvet' AND status='draft' AND created_by IS NULL")
      .all();
  // cada pregunta la hace un cliente nuevo (así no interviene el tope de preguntas sin reconocer); devuelve la última decisión del motor y el mensaje enviado
  let n = 0;
  const ask = async text => {
    const u = await call('/api/auth/register', '', { username: 'cliente' + ++n, name: 'Ana Pérez', password });
    const conv = (await call('/api/conversations', u.cookie, { courseId: 'aves', channel: 'whatsapp' })).conversation
      .id;
    await call('/api/conversations/' + conv + '/messages', u.cookie, { text, clientRef: randomUUID() }, 'POST', 201);
    for (let i = 0; i < 50; i++) {
      await sleep(150);
      const log = db
        .prepare('SELECT * FROM reply_log WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1')
        .get(conv);
      if (log)
        return {
          log,
          sources: JSON.parse(log.sources),
          sent:
            db
              .prepare(
                "SELECT text FROM messages WHERE conversation_id=? AND sender_kind='automation' ORDER BY seq DESC LIMIT 1",
              )
              .get(conv)?.text || '',
        };
    }
    assert.fail('sin decisión del motor para «' + text + '»');
  };

  // 1) Claude contesta; el cliente recibe su texto completo y queda un borrador limpio
  const QUESTION =
    'Vivo en Colombia, ¿puedo tomar el curso desde allá? Mi cel es 55 1234 5678 y mi correo ana.privada@ejemplo.com';
  const first = await ask(QUESTION);
  assert.equal(calls, 1);
  assert.match(first.log.reason, /^Proveedor de IA:/);
  assert.match(first.sent, /^¡Hola, Ana! Sí: el curso es en línea/);
  let d = drafts();
  assert.equal(d.length, 1);
  const draft = d[0];
  assert.equal(draft.status, 'draft');
  assert.equal(draft.created_by, null);
  assert.equal(draft.course_id, 'aves');
  assert.equal(draft.topic, 'general');
  assert.match(draft.question, /^Vivo en Colombia, ¿puedo tomar el curso desde allá\?/);
  assert.doesNotMatch(
    draft.question,
    /5512|55 1234|5678|ana\.privada|@/,
    'la pregunta se guarda sin teléfono ni correo',
  );
  assert.equal(
    draft.answer,
    'Sí: el curso es en línea, así que puedes tomarlo desde cualquier país con conexión a internet.',
    'sin el saludo con el nombre del cliente',
  );
  assert.equal(db.prepare('SELECT count(*) n FROM knowledge_versions WHERE entry_id=?').get(draft.id).n, 1);
  const listed = (await call('/api/replies/knowledge?brand=globalvet', admin.cookie)).entries.find(
    e => e.id === draft.id,
  );
  assert.equal(listed.status, 'draft');
  assert.equal(listed.created_by, null);

  // 2) un borrador NO se usa para responder: la misma pregunta vuelve a consultar a la IA, y no se duplica el borrador
  const again = await ask('Vivo en Colombia, ¿puedo tomar el curso desde allá?');
  assert.equal(calls, 2);
  assert.match(again.log.reason, /^Proveedor de IA:/);
  assert.equal(drafts().length, 1);

  // 3) lo que no debe volverse conocimiento no se guarda: precios (los rechaza el validador) y datos de contacto
  answer = 'El curso cuesta $500 pesos y lo puedes tomar desde cualquier lugar.';
  const priced = await ask('¿Sirve si trabajo en otro estado de la república y viajo mucho?');
  assert.match(priced.log.reason, /Proveedor descartado/);
  assert.equal(drafts().length, 1);
  answer = 'Claro, para eso escríbenos al 5512345678 y te explicamos todo con detalle.';
  await ask('¿Atienden dudas los fines de semana por otro medio distinto?');
  assert.equal(drafts().length, 1, 'una respuesta con un teléfono no queda como borrador');
  // 3b) datos de la persona en la RESPUESTA (el proveedor recibe su memoria): aunque el motor la acepte y el cliente la reciba, no se aprende de ella
  answer = 'Claro, Ana: el curso es en línea y lo puedes tomar desde tu casa sin problema.';
  const named = await ask('¿Lo puedo tomar desde mi casa sin ir a ningún lado?');
  assert.match(named.log.reason, /^Proveedor de IA:/);
  assert.equal(drafts().length, 1, 'una respuesta que nombra al cliente no queda como borrador');
  answer = 'Sí, llámanos al 55 1234 5678 y con gusto te orientamos sobre el curso.';
  const phoned = await ask('¿Tienen algún medio para orientarme mejor sobre esto?');
  assert.match(phoned.log.reason, /^Proveedor de IA:/);
  assert.equal(drafts().length, 1, 'un teléfono con separadores tampoco');
  answer = 'Como ya preguntaste antes, el curso es totalmente en línea.';
  const history = await ask('¿Me repites si hace falta ir a algún sitio?');
  assert.match(history.log.reason, /^Proveedor de IA:/);
  assert.equal(drafts().length, 1, 'una respuesta que habla de la historia del cliente tampoco');
  // 3c) el nombre del cliente dentro de su PREGUNTA se quita antes de guardarla
  answer = 'Este curso está enfocado en aves de corral; para otras especies conviene revisar otro programa.';
  await ask('Soy Ana Pérez y trabajo con ganado, ¿este curso aplica para bovinos también?');
  d = drafts();
  assert.equal(d.length, 2);
  const second = d.find(x => x.id !== draft.id);
  assert.doesNotMatch(second.question, /\bana\b|p[eé]rez/i, 'sin el nombre de quien preguntó');
  assert.match(second.question, /trabajo con ganado, ¿este curso aplica para bovinos también\?$/);
  // 3d) descartar un borrador de la IA que nunca se aprobó lo BORRA con su historial (no se conserva texto salido de una conversación)
  const gone = await call('/api/replies/knowledge/' + second.id + '/archive', admin.cookie, {
    expectedRevision: second.revision,
  });
  assert.equal(gone.entry.deleted, true);
  assert.equal(db.prepare('SELECT count(*) n FROM knowledge_entries WHERE id=?').get(second.id).n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM knowledge_versions WHERE entry_id=?').get(second.id).n, 0);
  assert.equal(drafts().length, 1);
  const before = calls;

  // 4) al aprobarlo, esa pregunta se contesta sola con el conocimiento: ya no llama a la IA
  answer = 'ESTO NO DEBE USARSE';
  await call('/api/replies/knowledge/' + draft.id + '/approve', admin.cookie, { expectedRevision: draft.revision });
  const learned = await ask('Vivo en Colombia, ¿puedo tomar el curso desde allá?');
  assert.equal(calls, before, 'la pregunta aprendida no consulta a la IA');
  assert.ok(learned.sources.some(s => s.type === 'knowledge' && s.id === draft.id));
  assert.equal(learned.log.model, null);
  assert.match(learned.sent, /Sí: el curso es en línea/);
  assert.doesNotMatch(learned.sent, /ESTO NO DEBE USARSE/);
  assert.equal(
    (await call('/api/ai/status', admin.cookie)).provider.usage.calls,
    before,
    'el contador de llamadas coincide con las consultas reales',
  );
});
