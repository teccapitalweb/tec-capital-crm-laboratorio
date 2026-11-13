import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/database.mjs';
import { migrateCRM } from '../server/crm.mjs';
import { migrateFollowup } from '../server/followup.mjs';
import { migrateCatalogue } from '../server/catalogue-schema.mjs';
import { migrateOperations } from '../server/operations-schema.mjs';
import { migrateAutomation, migrateRecipes } from '../server/automation-schema.mjs';
import { createAnalytics } from '../server/analytics.mjs';

const DAY = 86400000,
  T = Date.UTC(2026, 9, 31, 18, 0, 0);
const q = (o = {}) => new URLSearchParams(o);

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-analytics-')),
    db = openDatabase(dir);
  for (const m of [migrateCRM, migrateFollowup, migrateCatalogue, migrateOperations, migrateAutomation, migrateRecipes])
    m(db);
  t.after(async () => {
    try {
      db.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  for (const [id, role, n] of [
    ['adm', 'admin', 1],
    ['ag1', 'agent', 2],
    ['ag2', 'agent', 3],
    ['u1', 'customer', 4],
  ])
    db.prepare(
      'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, id, 'Persona ' + id, 'x', role, n, T, T);
  const brandOf = id => db.prepare('SELECT brand_id FROM courses WHERE id=?').get(id).brand_id;
  const crm = {
    brandsFor: u =>
      u.role === 'admin'
        ? db.prepare('SELECT id,name FROM brands').all()
        : [{ id: brandOf('aves'), name: 'GlobalVet' }],
  };
  const analytics = createAnalytics({ db, crm, json() {}, now: () => T });
  const opp = (id, course, stage, { owner = null, age = 2 * DAY, lost = '' } = {}) => {
    const brand = brandOf(course),
      at = T - age;
    db.prepare('INSERT OR IGNORE INTO contacts(id,brand_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(
      'ct-' + id,
      brand,
      'C ' + id,
      at,
      at,
    );
    db.prepare(
      'INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,owner_id,lost_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, 'ct-' + id, brand, course, stage, owner, lost, at, at);
  };
  const ev = (opportunity, to, ago) =>
    db
      .prepare("INSERT INTO crm_events(opportunity_id,actor_id,kind,details,created_at) VALUES(?,NULL,'stage',?,?)")
      .run(opportunity, JSON.stringify({ to }), T - ago);
  const conv = (id, course, channel, opportunityId = null, age = DAY) => {
    db.prepare(
      'INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run(id, 'u1', brandOf(course), course, channel, T - age, T - age);
    if (opportunityId) db.prepare('INSERT INTO conversation_opportunities VALUES(?,?)').run(id, opportunityId);
  };
  const response = (brand, actor, kind, waitMs, within, ago = DAY) =>
    db
      .prepare("INSERT INTO operation_events(brand_id,actor_id,kind,details,created_at) VALUES(?,?,'response',?,?)")
      .run(
        brand,
        actor,
        JSON.stringify({ waitingSince: T - ago, respondedAt: T - ago + waitMs, withinTarget: within, kind }),
        T - ago,
      );
  const task = (id, opportunityId, course, owner, status, dueAgo, doneAgo = null) =>
    db
      .prepare(
        'INSERT INTO tasks(id,opportunity_id,brand_id,title,owner_id,due_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        opportunityId,
        brandOf(course),
        'Tarea ' + id,
        owner,
        T - dueAgo,
        status,
        T - 10 * DAY,
        doneAgo === null ? T - 10 * DAY : T - doneAgo,
      );
  return {
    db,
    analytics,
    brandOf,
    opp,
    ev,
    conv,
    response,
    task,
    admin: { id: 'adm', role: 'admin' },
    agent: { id: 'ag1', role: 'agent' },
  };
}

test('analítica: embudo por cohorte, resultados por fecha del evento y desglose por curso', async t => {
  const { analytics, opp, ev, conv, admin, brandOf } = await fixture(t);
  opp('o1', 'aves', 'ganada', { owner: 'ag1' });
  ev('o1', 'interesado', 2 * DAY);
  ev('o1', 'inscripcion', DAY * 1.5);
  ev('o1', 'ganada', 2 * DAY - 3600000);
  opp('o2', 'aves', 'inscripcion', { owner: 'ag1' });
  ev('o2', 'interesado', DAY);
  ev('o2', 'inscripcion', DAY / 2);
  opp('o3', 'aves', 'perdida', { owner: 'ag2', lost: 'Precio' });
  ev('o3', 'interesado', 3 * DAY);
  ev('o3', 'perdida', 5 * DAY - 1000);
  opp('o4', 'nutricion', 'nuevo', { owner: 'ag2' });
  opp('o5', 'aves', 'ganada', { age: 100 * DAY });
  ev('o5', 'ganada', DAY); // cohorte antigua: cuenta como venta del periodo, no en el embudo
  opp('o6', 'odontologia', 'interesado');
  conv('c1', 'aves', 'whatsapp', 'o1');
  conv('c2', 'aves', 'instagram', 'o2');
  conv('c3', 'aves', 'whatsapp');
  conv('c4', 'odontologia', 'facebook', 'o6');
  conv('old', 'aves', 'whatsapp', null, 90 * DAY);
  const global = brandOf('aves'),
    r = analytics.build(admin, q({ brand: global }));
  assert.deepEqual(r.funnel, {
    created: 4,
    interesado: 3,
    inscripcion: 2,
    ganada: 1,
    perdida: 1,
    abiertas: 2,
    conversion: 25,
  });
  assert.equal(r.totals.opportunities, 4);
  assert.equal(r.totals.won, 2);
  assert.equal(r.totals.lost, 1);
  assert.equal(r.totals.conversations, 3);
  assert.deepEqual(r.lossReasons, [{ reason: 'Precio', count: 1 }]);
  assert.deepEqual(r.channels, [
    { channel: 'whatsapp', conversations: 2, won: 1 },
    { channel: 'instagram', conversations: 1, won: 0 },
    { channel: 'facebook', conversations: 0, won: 0 },
  ]);
  const aves = r.byCourse.find(c => c.id === 'aves');
  assert.equal(aves.created, 3);
  assert.equal(aves.conversion, 33.3);
  assert.equal(r.byCourse.find(c => c.id === 'nutricion').created, 1);
  assert.equal(r.byBrand.length, 1);
  const all = analytics.build(admin, q());
  assert.equal(all.byBrand.length, 2);
  assert.equal(all.funnel.created, 5);
  assert.ok(all.scope.brands.length >= 3);
  assert.equal(r.period.days, 30);
  const short = analytics.build(admin, q({ brand: global, days: '1' }));
  assert.equal(short.funnel.created, 0);
  assert.equal(short.funnel.conversion, null);
  assert.equal(
    r.trend.reduce((n, d) => n + d.conversations, 0),
    3,
  );
  assert.equal(
    r.trend.reduce((n, d) => n + d.won, 0),
    2,
  );
  assert.ok(r.trend.length >= 30);
});

test('analítica: tiempos de respuesta, objetivo cumplido y desempeño por asesor con privacidad', async t => {
  const { analytics, opp, ev, response, task, admin, agent, brandOf } = await fixture(t);
  const brand = brandOf('aves');
  opp('o1', 'aves', 'ganada', { owner: 'ag1' });
  ev('o1', 'ganada', DAY);
  opp('o2', 'aves', 'nuevo', { owner: 'ag1' });
  opp('o3', 'aves', 'nuevo', { owner: 'ag2' });
  response(brand, 'ag1', 'first', 60000, true);
  response(brand, 'ag1', 'next', 120000, false, 2 * DAY);
  response(brand, 'ag2', 'first', 300000, true, 3 * DAY);
  response(brand, 'ag2', 'first', 10000, null, 4 * DAY);
  response(brand, 'ag1', 'first', 999999, true, 200 * DAY); // fuera del periodo
  task('t1', 'o1', 'aves', 'ag1', 'open', DAY);
  task('t2', 'o1', 'aves', 'ag1', 'done', 5 * DAY, 2 * DAY);
  task('t3', 'o3', 'aves', 'ag2', 'open', -DAY);
  task('t4', 'o3', 'aves', 'ag2', 'done', 9 * DAY, 100 * DAY);
  const r = analytics.build(admin, q({ brand }));
  assert.deepEqual(r.response.first, { count: 3, medianMs: 60000, p90Ms: 300000 });
  assert.deepEqual(r.response.next, { count: 1, medianMs: 120000, p90Ms: 120000 });
  assert.deepEqual(r.response.target, { measured: 3, within: 2, rate: 66.7 });
  assert.deepEqual(r.tasks, { open: 2, overdue: 1, doneInPeriod: 1 });
  const a1 = r.agents.find(a => a.id === 'ag1'),
    a2 = r.agents.find(a => a.id === 'ag2');
  assert.equal(r.agentsScope, 'todos');
  assert.equal(a1.created, 2);
  assert.equal(a1.won, 1);
  assert.equal(a1.responses, 2);
  assert.equal(a1.medianResponseMs, 60000);
  assert.equal(a1.withinTargetRate, 50);
  assert.equal(a1.tasksOverdue, 1);
  assert.equal(a1.tasksDone, 1);
  assert.equal(a2.responses, 2);
  assert.equal(a2.tasksDone, 0);
  assert.equal(a2.tasksOverdue, 0);
  const own = analytics.build(agent, q({ brand }));
  assert.equal(own.agentsScope, 'propio');
  assert.deepEqual(
    own.agents.map(a => a.id),
    ['ag1'],
  );
  assert.equal(JSON.stringify(own).includes('Persona ag2'), false);
});

test('analítica: permisos por marca y validación de parámetros', async t => {
  const { analytics, agent, admin, brandOf } = await fixture(t);
  assert.throws(() => analytics.build(agent, q({ brand: brandOf('odontologia') })), /no disponible/);
  assert.deepEqual(
    analytics.build(agent, q()).scope.brands.map(b => b.id),
    [brandOf('aves')],
  );
  for (const bad of [{ days: '0' }, { days: '400' }, { days: 'abc' }, { days: '7', tz: 'Mar/Nada' }])
    assert.throws(() => analytics.build(admin, q(bad)), /periodo|Zona/);
  assert.equal(analytics.build(admin, q({ days: '7', tz: 'UTC' })).trend.length >= 7, true);
});

test('analítica por API: sesión, rol y alcance', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-analytics-http-')),
    code = randomUUID(),
    password = 'Password-analytics-2026!';
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
  const reg = (username, inviteCode) =>
    call('/api/auth/register', '', { username, name: 'Prueba ' + username, password, inviteCode });
  const admin = await reg('admin', code),
    agent = await reg('asesor'),
    client = await reg('cliente');
  const inv = await call(
    '/api/team/invites',
    admin.cookie,
    { username: 'asesor', brandIds: ['globalvet'] },
    'POST',
    201,
  );
  await call('/api/team/accept', agent.cookie, { token: inv.token });
  await call('/api/analytics', '', undefined, 'GET', 401);
  await call('/api/analytics', client.cookie, undefined, 'GET', 403);
  const a = await call('/api/analytics?days=7', admin.cookie);
  assert.equal(a.agentsScope, 'todos');
  assert.ok(a.scope.brands.length >= 3);
  assert.equal(a.period.days, 7);
  const s = await call('/api/analytics', agent.cookie);
  assert.deepEqual(
    s.scope.brands.map(b => b.id),
    ['globalvet'],
  );
  assert.equal(s.agentsScope, 'propio');
  await call('/api/analytics?brand=odonteck', agent.cookie, undefined, 'GET', 404);
  await call('/api/analytics?days=0', admin.cookie, undefined, 'GET', 400);
});
