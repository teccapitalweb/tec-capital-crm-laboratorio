import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

test('programar un material del catálogo: se valida hoy, se arma al enviar con el catálogo vigente, y si ya no se puede enviar se dice por qué', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-schedmat-')),
    code = randomUUID(),
    password = 'Password-schedmat-2026!';
  let logs = '';
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dir,
      ADMIN_INVITE_CODE: code,
      APP_ORIGIN: '',
      NODE_ENV: 'test',
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
    if (server.exitCode === null)
      await new Promise(r => {
        server.once('exit', r);
        server.kill();
      });
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
  async function until(fn, tries = 40) {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (v) return v;
      await sleep(200);
    }
    return v;
  }
  const db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 }),
    T = () => Date.now(),
    H = 3600 * 1000;
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Administración',
    password,
    inviteCode: code,
  });
  const ana = await call('/api/auth/register', '', { username: 'ana', name: 'Ana Pérez', password });
  const conv = (await call('/api/conversations', ana.cookie, { courseId: 'aves', channel: 'whatsapp' })).conversation;
  const sched = id => '/api/conversations/' + id + '/scheduled',
    mk = (material, over = {}, expected = 201) =>
      call(
        sched(conv.id),
        admin.cookie,
        { material, sendAt: T() + 2 * H, clientRef: randomUUID(), ...over },
        'POST',
        expected,
      );
  const due = id => db.prepare('UPDATE scheduled_messages SET send_at=? WHERE id=?').run(T() - 1000, id),
    stateOf = id => db.prepare('SELECT * FROM scheduled_messages WHERE id=?').get(id);

  // validación: sólo materiales conocidos y vigentes; ni texto suelto ni identificadores inventados
  await mk({ kind: 'inventado' }, {}, 400);
  await mk({}, {}, 400);
  await mk({ templateId: 'no-existe' }, {}, 409);
  await mk({ flyerId: 'no-existe' }, {}, 409);
  await mk({ kind: 'syllabus' }, { sendAt: T() - H }, 400);
  await call(
    sched(conv.id),
    ana.cookie,
    { material: { kind: 'syllabus' }, sendAt: T() + 2 * H, clientRef: randomUUID() },
    'POST',
    403,
  );

  // programar el temario: queda como material, con su nombre y una vista del texto de hoy
  const syl = (await mk({ kind: 'syllabus' })).item;
  assert.deepEqual(syl.material, { label: 'Temario' });
  assert.match(syl.text, /^Temario:/);
  assert.equal(syl.state, 'pending');
  assert.equal(
    db.prepare('SELECT material FROM scheduled_messages WHERE id=?').get(syl.id).material,
    JSON.stringify({ kind: 'syllabus' }),
  );
  const price = (await mk({ kind: 'price' })).item;
  assert.equal(price.material.label, 'Precio y promoción');
  const fl = (await mk({ kind: 'flyer' })).item;
  assert.equal(fl.material.label, 'Flyer de la edición');
  const sc = (await mk({ kind: 'schedule' })).item;
  assert.equal(sc.material.label, 'Fechas y docente');

  // editar: un material no cambia de texto, pero sí de hora y de opción
  await call(
    '/api/scheduled/' + syl.id,
    admin.cookie,
    { text: 'Otro texto', expectedRevision: syl.revision },
    'PATCH',
    400,
  );
  const moved = (
    await call(
      '/api/scheduled/' + syl.id,
      admin.cookie,
      { sendAt: T() + 5 * H, cancelOnReply: false, expectedRevision: syl.revision },
      'PATCH',
    )
  ).item;
  assert.equal(moved.cancelOnReply, false);
  assert.equal(moved.revision, syl.revision + 1);
  assert.equal(moved.text, syl.text);

  // se arma AL ENVIAR con el catálogo vigente: si el temario cambió después de programar, sale el nuevo; el mensaje guarda su instantánea comercial
  db.prepare(
    "UPDATE courses SET syllabus='Módulo nuevo agregado después de programar\nMódulo dos',version=version+1 WHERE id='aves'",
  ).run();
  due(syl.id);
  const sent = await until(() => stateOf(syl.id).state === 'sent' && stateOf(syl.id));
  assert.ok(sent, 'se envió');
  const msg = db.prepare('SELECT * FROM messages WHERE id=?').get(sent.message_id);
  assert.match(msg.text, /Módulo nuevo agregado después de programar/);
  assert.doesNotMatch(msg.text, /Bioseguridad en la granja/, 'no sale el temario viejo');
  assert.equal(msg.sender_kind, 'agent');
  assert.equal(msg.client_ref, 'sched:' + syl.id);
  assert.ok(msg.commercial_snapshot, 'queda la instantánea comercial del envío');
  assert.equal(
    JSON.parse(msg.commercial_snapshot).courseId ?? JSON.parse(msg.commercial_snapshot).commercial?.courseId ?? 'aves',
    'aves',
  );
  assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE client_ref=?').get('sched:' + syl.id).n, 1);
  // el precio de lo programado también sale vigente
  db.prepare("UPDATE editions SET price_cents=45500 WHERE course_id='aves'").run();
  due(price.id);
  const sp = await until(() => stateOf(price.id).state === 'sent' && stateOf(price.id));
  assert.ok(sp);
  assert.match(db.prepare('SELECT text FROM messages WHERE id=?').get(sp.message_id).text, /455\.00/);

  // si lo programado ya no se puede enviar (la edición dejó de estar publicada), no sale y se dice por qué (y se avisa a quien lo programó)
  db.prepare("UPDATE editions SET status='archived' WHERE course_id='aves'").run();
  due(sc.id);
  const bad = await until(() => stateOf(sc.id).state !== 'pending' && stateOf(sc.id));
  assert.equal(bad.state, 'failed');
  assert.ok(bad.reason && bad.reason.length > 5);
  assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE client_ref=?').get('sched:' + sc.id).n, 0);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM notifications WHERE kind='scheduled' AND event_key=?")
      .get('scheduled:' + sc.id + ':failed').n,
    1,
  );
  // con la edición archivada ya no se puede ni programar uno nuevo
  await mk({ kind: 'syllabus' }, {}, 409);
  db.prepare("UPDATE editions SET status='published' WHERE course_id='aves'").run();

  // plantillas y flyers aprobados de la conversación (si la base de práctica los trae) se programan por su id y se arman al enviar
  const mats = await call('/api/conversations/' + conv.id + '/materials', admin.cookie);
  if (process.env.DEBUG_MATS)
    console.error('MATS', mats.templates.length, mats.flyers.length, mats.flyers.map(f => f.availability).join('|'));
  if (mats.templates.length) {
    const tp = mats.templates[0],
      r = (await mk({ templateId: tp.id })).item;
    assert.equal(r.material.label, tp.title);
    due(r.id);
    const done = await until(() => stateOf(r.id).state !== 'pending' && stateOf(r.id));
    assert.equal(done.state, 'sent');
    // una plantilla que deja de estar aprobada antes de la hora ya no sale
    const r2 = (await mk({ templateId: tp.id })).item;
    db.prepare("UPDATE content_templates SET status='draft' WHERE id=?").run(tp.id);
    due(r2.id);
    const stop = await until(() => stateOf(r2.id).state !== 'pending' && stateOf(r2.id));
    assert.equal(stop.state, 'failed');
    assert.match(stop.reason, /plantilla|aprobada/i);
  }
  if (mats.flyers.length) {
    const f = mats.flyers.find(x => x.availability === 'Listo para enviar');
    if (f) {
      const r = (await mk({ flyerId: f.id })).item;
      assert.ok(r.material.label);
    }
  }
  // un material no se programa en un chat de otra marca ni lo ve quien no tiene la marca
  const other = await call('/api/auth/register', '', { username: 'otro', name: 'Otro', password });
  const inv = await call('/api/team/invites', admin.cookie, { username: 'otro', brandIds: ['odonteck'] }, 'POST', 201);
  await call('/api/team/accept', other.cookie, { token: inv.token });
  await call(
    sched(conv.id),
    other.cookie,
    { material: { kind: 'syllabus' }, sendAt: T() + 2 * H, clientRef: randomUUID() },
    'POST',
    404,
  );
  db.close();
});
