import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isOpen, serviceDeadline, validateHolidays } from '../server/service-hours.mjs';

const week = [null, [540, 1080], [540, 1080], [540, 1080], [540, 1080], [540, 1080], null];

test('festivos: cierran el día completo en la zona de la marca y mueven los plazos', () => {
  const base = { timezone: 'America/Mexico_City', hours: week },
    withHoliday = { ...base, holidays: [{ date: '2026-12-25', name: 'Navidad' }] };
  const noon = Date.UTC(2026, 11, 25, 18, 0); // viernes 25 dic, 12:00 en Ciudad de México
  assert.equal(isOpen(noon, base), true);
  assert.equal(isOpen(noon, withHoliday), false);
  // el festivo es una fecha local: 24 dic 23:30 local ya es 25 dic en UTC pero no es festivo en México
  assert.equal(isOpen(Date.UTC(2026, 11, 25, 5, 30), { ...withHoliday, hours: Array(7).fill([0, 1440]) }), true);
  assert.equal(isOpen(Date.UTC(2026, 11, 25, 6, 30), { ...withHoliday, hours: Array(7).fill([0, 1440]) }), false); // 00:30 local del 25
  // jueves 24 dic 17:50 + 30 min: 10 min ese día; sin festivo termina el viernes 09:20; con festivo (y fin de semana) el lunes 09:20
  const start = Date.UTC(2026, 11, 24, 23, 50);
  assert.equal(serviceDeadline(start, 30, base), Date.UTC(2026, 11, 25, 15, 20));
  assert.equal(serviceDeadline(start, 30, withHoliday), Date.UTC(2026, 11, 28, 15, 20));
  // otra zona: el mismo 25 dic cuenta según su propio calendario
  assert.equal(
    isOpen(Date.UTC(2026, 11, 25, 15, 0), {
      timezone: 'America/New_York',
      hours: week,
      holidays: [{ date: '2026-12-25' }],
    }),
    false,
  );
  assert.equal(
    isOpen(Date.UTC(2026, 11, 25, 15, 0), {
      timezone: 'America/New_York',
      hours: week,
      holidays: [{ date: '2026-12-24' }],
    }),
    true,
  );
  // políticas anteriores sin festivos siguen funcionando
  assert.equal(isOpen(noon, { timezone: 'America/Mexico_City', hours: week }), true);
});

test('festivos: validación de fechas, duplicados, rango y orden', () => {
  const now = Date.UTC(2026, 9, 31);
  assert.equal(validateHolidays(undefined, now), undefined);
  assert.deepEqual(validateHolidays([], now), []);
  assert.deepEqual(validateHolidays([{ date: '2026-12-25', name: '  Navidad   2026 ' }, '2026-01-01'], now), [
    { date: '2026-01-01', name: '' },
    { date: '2026-12-25', name: 'Navidad 2026' },
  ]);
  for (const bad of [
    ['2026-02-30'],
    ['2026-13-01'],
    ['25/12/2026'],
    [{ date: '2026-12-25' }, { date: '2026-12-25' }],
    ['2010-01-01'],
    ['2040-01-01'],
    '2026-12-25',
    [null],
    Array.from({ length: 151 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)),
  ])
    assert.throws(() => validateHolidays(bad, now), Error, JSON.stringify(bad).slice(0, 40));
});

test('festivos por API: se guardan por marca con revisión, quedan en el historial y cierran la atención', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-holidays-')),
    code = randomUUID(),
    password = 'Password-holidays-2026!';
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

  const config = () => call('/api/operations/brands/globalvet', admin.cookie);
  const first = (await config()).settings;
  assert.deepEqual(first.holidays, []);
  const save = (changes, cookie = admin.cookie, expected = 200) =>
    call(
      '/api/operations/brands/globalvet',
      cookie,
      {
        expectedRevision: first.revision,
        hours: first.hours,
        timezone: first.timezone,
        routingEnabled: false,
        slaEnabled: true,
        memberIds: [],
        firstMinutes: 30,
        nextMinutes: 60,
        ...changes,
      },
      'PATCH',
      expected,
    );
  await save({ holidays: [{ date: '2030-01-01' }] }, agent.cookie, 403);
  await save({ holidays: [{ date: '2026-02-31' }] }, admin.cookie, 400);
  await save({ holidays: '2026-12-25' }, admin.cookie, 400);
  await save({ holidays: [{ date: '2026-12-25' }, { date: '2026-12-25' }] }, admin.cookie, 400);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const saved = (
    await save({
      hours: Array(7).fill([0, 1440]),
      holidays: [{ date: today, name: 'Hoy de prueba' }, { date: '2099-01-01' }].slice(0, 1),
    })
  ).settings;
  assert.deepEqual(saved.holidays, [{ date: today, name: 'Hoy de prueba' }]);
  assert.equal(saved.revision, first.revision + 1);
  // sin enviar `holidays`, la lista se conserva
  const kept = (
    await call(
      '/api/operations/brands/globalvet',
      admin.cookie,
      {
        expectedRevision: saved.revision,
        hours: saved.hours,
        timezone: saved.timezone,
        routingEnabled: false,
        slaEnabled: true,
        memberIds: [],
        firstMinutes: 30,
        nextMinutes: 60,
      },
      'PATCH',
    )
  ).settings;
  assert.deepEqual(kept.holidays, saved.holidays);
  // otra marca no se ve afectada
  assert.deepEqual((await call('/api/operations/brands/odonteck', admin.cookie)).settings.holidays, []);
  // el historial de configuración incluye los festivos
  const history = (await call('/api/operations/brands/globalvet/history', admin.cookie)).events;
  assert.ok(history.some(e => JSON.stringify(e.details.next?.holidays) === JSON.stringify(saved.holidays)));
  // hoy es festivo: con horario 24 h el chat que pide asesor aparece fuera de horario
  const conv = (await call('/api/conversations', client.cookie, { courseId: 'aves', channel: 'whatsapp' }))
    .conversation;
  await call(
    '/api/conversations/' + conv.id + '/messages',
    client.cookie,
    { text: 'Quiero un asesor', clientRef: randomUUID() },
    'POST',
    201,
  );
  let item;
  for (let i = 0; i < 20 && !item; i++) {
    await new Promise(r => setTimeout(r, 250));
    item = (await call('/api/operations/queue', admin.cookie)).conversations?.find(x => x.id === conv.id);
  }
  assert.ok(item, 'el chat está en la cola');
  assert.equal(item.inHours, false);
  // quitar el festivo restablece la atención
  const cleared = (
    await call(
      '/api/operations/brands/globalvet',
      admin.cookie,
      {
        expectedRevision: kept.revision,
        hours: kept.hours,
        timezone: kept.timezone,
        routingEnabled: false,
        slaEnabled: true,
        memberIds: [],
        firstMinutes: 30,
        nextMinutes: 60,
        holidays: [],
      },
      'PATCH',
    )
  ).settings;
  assert.deepEqual(cleared.holidays, []);
  assert.equal(
    (await call('/api/operations/queue', admin.cookie)).conversations.find(x => x.id === conv.id).inHours,
    true,
  );
});
