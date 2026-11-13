import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildVerdicts, estimate, dayKey, daysBetween, keyMs, VERDICTS } from '../server/ads-engine.mjs';

const TODAY = '2026-11-10',
  DAY = 86400000;
const ed = (o = {}) => ({
  id: 'e1',
  brandId: 'b1',
  brandName: 'Marca',
  courseId: 'c1',
  course: 'Curso',
  name: 'Edición',
  startKey: '2026-11-24',
  min: 8,
  enrolled: 0,
  launchKey: '2026-11-04',
  captures: {},
  ...o,
});
const one = (e, ctx = {}) =>
  buildVerdicts({ today: TODAY, editions: [e], history: new Map(), runs: new Map(), rate14: {}, ...ctx })[0];
const cap = (spendPesos, messages) => ({ [TODAY]: { spend: spendPesos * 100, messages } });

test('motor de Pauta: los seis veredictos y sus reglas (port del panel de tráfico de IPCIL)', () => {
  assert.deepEqual(Object.keys(VERDICTS), ['escalar', 'nova', 'subir', 'hoy', 'ok', 'espera']);
  // recién lanzada, sin ventas: todavía no hay señal
  assert.equal(one(ed({ launchKey: '2026-11-09' })).type, 'espera');
  // cuatro días o más sin ninguna venta: no va a llegar, y si hay muchos mensajes sin cerrar se revisa primero a ventas
  const nova = one(ed({ captures: cap(5000, 40) }));
  assert.equal(nova.type, 'nova');
  assert.equal(nova.salesFail, true);
  assert.match(nova.action, /ventas tiene que revisar/);
  assert.match(one(ed({ captures: cap(1000, 3) })).action, /no va a llegar\. Baja o detén la pauta/);
  // muy por encima del mínimo y con días por delante: escalar; poco por encima: sólo mantener
  assert.equal(one(ed({ enrolled: 12, startKey: '2026-11-20' })).type, 'escalar');
  assert.equal(one(ed({ enrolled: 9, startKey: '2026-11-20' })).type, 'ok');
  // le falta, pero hay tiempo y ritmo: súbele, con cuánto más invertir calculado con el costo por alumno
  const sub = one(ed({ enrolled: 4, startKey: '2026-11-22', captures: cap(3000, 30) }), { rate14: { c1: 0.2 } });
  assert.equal(sub.type, 'subir');
  assert.match(sub.action, /súbele ahora/);
  assert.match(sub.action, /más de pauta/);
  assert.ok(sub.investCents > 0);
  // casi sin ventas y sin ritmo: no va a llegar
  assert.equal(one(ed({ enrolled: 1, startKey: '2026-11-15' })).type, 'nova');
  // el día de abrir
  assert.equal(one(ed({ startKey: TODAY, enrolled: 3 })).type, 'hoy');
  assert.equal(one(ed({ startKey: TODAY, enrolled: 8 })).type, 'ok');
  // ordenados por urgencia: escalar, no van, subir, hoy, ok, espera
  const many = buildVerdicts({
    today: TODAY,
    editions: [
      ed({ id: 'a', launchKey: '2026-11-09' }),
      ed({ id: 'b', enrolled: 12, startKey: '2026-11-20' }),
      ed({ id: 'c', captures: cap(1000, 3) }),
    ],
    history: new Map(),
    runs: new Map(),
    rate14: {},
  });
  assert.deepEqual(
    many.map(v => v.type),
    ['escalar', 'nova', 'espera'],
  );
});

test('motor de Pauta: proyección con historial, relanzamiento y diagnóstico contra la corrida anterior y las demás campañas', () => {
  // historial: tres corridas de 10 alumnos que a 14 días de abrir llevaban el 40 %
  const mkRun = startKey => {
    const startMs = keyMs(startKey);
    return { startMs, final: 10, times: [...Array(4).fill(startMs - 15 * DAY), ...Array(6).fill(startMs - 2 * DAY)] };
  };
  const history = new Map([['c1', [mkRun('2026-08-01'), mkRun('2026-09-01'), mkRun('2026-10-01')]]]);
  assert.equal(estimate({ history, courseId: 'c1', current: 4, daysLeft: 14, rate14: {} }), 10);
  assert.equal(
    estimate({ history, courseId: 'c1', current: 6, daysLeft: 14, rate14: {} }),
    13,
    'tope: 1.3 veces lo más que ha llevado el curso',
  );
  assert.equal(
    estimate({ history: new Map(), courseId: 'c1', current: 3, daysLeft: 10, rate14: { c1: 0.3 } }),
    6,
    'sin historial, el ritmo de 14 días',
  );
  assert.equal(one(ed({ enrolled: 5, startKey: TODAY.replace('10', '24') }), { history }).type, 'escalar');

  // relanzamiento: la corrida anterior cerró sin llegar al mínimo (dos seguidas)
  const run = (key, total, extra = {}) => ({
    key,
    total,
    launchKey: key.slice(0, 8) + '01',
    times: Array(total).fill(keyMs(key) - 5 * DAY),
    captures: {},
    ...extra,
  });
  const runs = new Map([['c1', [run('2026-09-20', 3), run('2026-10-20', 2)]]]);
  const rl = one(ed({ enrolled: 1, captures: cap(2000, 12) }), { runs });
  assert.match(
    rl.relaunchText,
    /Relanzamiento: la corrida del .* cerró al 25% del mínimo · van 2 corridas seguidas sin abrir/,
  );
  const good = one(ed({ enrolled: 12, startKey: '2026-11-20' }), { runs: new Map([['c1', [run('2026-10-20', 3)]]]) });
  assert.match(good.relaunchText, /sí está funcionando/);

  // misma fecha de la corrida pasada: 60 mensajes y 6000 de pauta a los 9 días; 12 alumnos al final
  const prevRun = run('2026-10-20', 12, {
    launchKey: '2026-10-11',
    times: [...Array(8).fill(keyMs('2026-10-11') + 3 * DAY), ...Array(4).fill(keyMs('2026-10-18'))],
    captures: { '2026-10-17': { spend: 600000, messages: 60 } },
  });
  const R = new Map([['c1', [prevRun]]]);
  const lowSpend = one(ed({ enrolled: 3, captures: cap(2000, 25) }), { runs: R });
  assert.ok(
    lowSpend.notes.some(n => n.kind === 'pauta' && /33%/.test(n.text)),
    'va bajo en pauta',
  );
  const noLeads = one(ed({ enrolled: 3, captures: cap(5000, 20) }), { runs: R });
  assert.ok(
    noLeads.notes.some(n => n.kind === 'ads' && /Ads no está trayendo mensajes/.test(n.text)),
    'misma inversión, menos mensajes: es Ads',
  );
  const noSales = one(ed({ enrolled: 2, captures: cap(6000, 55) }), { runs: R });
  assert.ok(
    noSales.notes.some(n => n.kind === 'ventas'),
    'llegan mensajes y no se convierten: es ventas',
  );
  assert.equal(noSales.salesFail, true);
  // sin corrida anterior se compara con las demás campañas de la marca
  const others = [
    ed({ id: 'x', captures: cap(1000, 100), enrolled: 10 }),
    ed({ id: 'y', captures: cap(1000, 100), enrolled: 10 }),
    ed({ id: 'z', captures: cap(9000, 50), enrolled: 1 }),
  ];
  const z = buildVerdicts({ today: TODAY, editions: others, history: new Map(), runs: new Map(), rate14: {} }).find(
    v => v.editionId === 'z',
  );
  assert.ok(z.notes.some(n => n.kind === 'ads' && /el anuncio no jala/.test(n.text)));
});

test('Pauta por API: acceso, captura diaria, veredictos, acciones atendidas, decisiones del gerente y reporte', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-ads-')),
    code = randomUUID(),
    password = 'Password-ads-2026!';
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
    trafi = await reg('trafiquer'),
    other = await reg('otro'),
    client = await reg('cliente');
  for (const [u, brands] of [
    [trafi, ['globalvet']],
    [other, ['odonteck']],
  ]) {
    const inv = await call(
      '/api/team/invites',
      admin.cookie,
      { username: u === trafi ? 'trafiquer' : 'otro', brandIds: brands },
      'POST',
      201,
    );
    await call('/api/team/accept', u.cookie, { token: inv.token });
  }

  // acceso: administración siempre; el equipo sólo con la función; los clientes nunca
  await call('/api/ads/overview', client.cookie, undefined, 'GET', 403);
  await call('/api/ads/overview', '', undefined, 'GET', 401);
  await call('/api/ads/overview', trafi.cookie, undefined, 'GET', 403);
  assert.equal((await call('/api/ads/me', trafi.cookie)).allowed, false);
  await call('/api/ads/access', trafi.cookie, { userId: 'x', enabled: true }, 'PUT', 403);
  const users = (await call('/api/ads/access', admin.cookie)).members;
  const tId = users.find(m => m.username === 'trafiquer').id;
  await call(
    '/api/ads/access',
    admin.cookie,
    { userId: users.find(m => m.role === 'admin').id, enabled: true },
    'PUT',
    400,
  );
  assert.equal(
    (await call('/api/ads/access', admin.cookie, { userId: tId, enabled: true }, 'PUT')).members.find(m => m.id === tId)
      .enabled,
    true,
  );
  assert.equal((await call('/api/ads/me', trafi.cookie)).allowed, true);

  // dos ediciones en venta de GlobalVet (futuras) y una de OdonTeck
  const day = 86400000,
    base = {
      courseId: 'aves',
      name: 'Lanzamiento A',
      startsAt: Date.now() + 14 * day,
      endsAt: Date.now() + 14 * day + 7200000,
      timezone: 'America/Mexico_City',
      instructor: 'Docente',
      modality: 'online',
      location: 'Aula',
      capacity: 20,
      availableSeats: 20,
      infoUrl: 'https://example.com/c',
      price: 500,
      currency: 'MXN',
      status: 'published',
    };
  const edA = (await call('/api/catalogue/editions', admin.cookie, base, 'POST', 201)).item,
    edB = (
      await call(
        '/api/catalogue/editions',
        admin.cookie,
        { ...base, name: 'Lanzamiento B', startsAt: Date.now() + 20 * day, endsAt: Date.now() + 20 * day + 7200000 },
        'POST',
        201,
      )
    ).item;
  const odonCourse = (await call('/api/catalogue', admin.cookie)).courses.find(c => c.brand_id === 'odonteck').id;
  const edO = (
    await call(
      '/api/catalogue/editions',
      admin.cookie,
      { ...base, courseId: odonCourse, name: 'Lanzamiento Odon' },
      'POST',
      201,
    )
  ).item;

  // la captura trae las ediciones de las marcas del usuario, sin tocar otras
  const sheet = await call('/api/ads/capture', trafi.cookie);
  const names = sheet.rows.map(r => r.edition);
  assert.ok(
    names.includes('Lanzamiento A') && names.includes('Lanzamiento B') && !names.includes('Lanzamiento Odon'),
    'sólo las marcas del trafiquer',
  );
  assert.ok(sheet.rows.every(r => r.spendCents === null && r.prev === null && r.min === 8));
  // validaciones
  const put = (rows, extra = {}, cookie = trafi.cookie, expected = 200) =>
    call('/api/ads/capture', cookie, { day: sheet.today, rows, ...extra }, 'PUT', expected);
  await put([], {}, trafi.cookie, 400);
  await put([{ editionId: edA.id, spend: -1, messages: 3 }], {}, trafi.cookie, 400);
  await put([{ editionId: edA.id, spend: 100, messages: 2.5 }], {}, trafi.cookie, 400);
  await put([{ editionId: edA.id, spend: 100, messages: 3 }], { day: '2999-01-01' }, trafi.cookie, 400);
  await put([{ editionId: edA.id, spend: 100, messages: 3 }], { day: '2020-01-01' }, trafi.cookie, 400);
  await put([{ editionId: edO.id, spend: 100, messages: 3 }], {}, trafi.cookie, 404); // OdonTeck no es de su marca
  // captura de hoy y corrección (el mismo día se reemplaza, no se duplica)
  await put([
    { editionId: edA.id, spend: 1500, messages: 40, launchedOn: sheet.today },
    { editionId: edB.id, spend: 800.5, messages: 10 },
  ]);
  const re = await put([{ editionId: edA.id, spend: 2000, messages: 55 }]);
  const a = re.rows.find(r => r.editionId === edA.id);
  assert.deepEqual([a.spendCents, a.messages], [200000, 55]);
  assert.equal(re.rows.find(r => r.editionId === edB.id).spendCents, 80050);
  // día anterior: aparece como «captura anterior» del día siguiente de la hoja
  const yesterday = dayKey(Date.now() - day);
  await put([{ editionId: edA.id, spend: 900, messages: 20 }], { day: yesterday });
  const prev = (await call('/api/ads/capture?day=' + sheet.today, trafi.cookie)).rows.find(
    r => r.editionId === edA.id,
  ).prev;
  assert.deepEqual([prev.day, prev.spendCents, prev.messages], [yesterday, 90000, 20]);

  // veredictos: ordenados, con costo por mensaje y la marca como alcance
  const ov = await call('/api/ads/overview', trafi.cookie);
  assert.ok(ov.verdicts.length >= 2 && ov.verdicts.every(v => v.brandId === 'globalvet' && v.title && v.action));
  const va = ov.verdicts.find(v => v.editionId === edA.id);
  assert.equal(va.messages, 55);
  assert.equal(va.spendCents, 200000);
  assert.equal(va.cplCents, Math.round(200000 / 55));
  assert.equal(va.capturedToday, true);
  assert.equal(va.type, 'espera', 'recién lanzada hoy');
  assert.equal(va.done, null);
  await call('/api/ads/overview?brand=odonteck', trafi.cookie, undefined, 'GET', 404);

  // acciones atendidas: se marcan con nota, las ven todos y se pueden desmarcar
  await call('/api/ads/actions', trafi.cookie, { editionId: edO.id }, 'POST', 404);
  await call('/api/ads/actions', trafi.cookie, { editionId: edA.id, note: 'Subí a $500 por día' }, 'POST');
  const marked = (await call('/api/ads/overview', admin.cookie)).verdicts.find(v => v.editionId === edA.id).done;
  assert.equal(marked.note, 'Subí a $500 por día');
  assert.match(marked.by, /trafiquer/);
  assert.equal((await call('/api/ads/actions/' + edA.id, trafi.cookie, undefined, 'DELETE')).removed, true);
  assert.equal((await call('/api/ads/overview', admin.cookie)).verdicts.find(v => v.editionId === edA.id).done, null);

  // decisiones del gerente: sólo administración las crea; llegan al trafiquer con aviso y se aplican con nota
  await call('/api/ads/decisions', trafi.cookie, { editionId: edA.id, type: 'subir_pauta' }, 'POST', 403);
  await call('/api/ads/decisions', admin.cookie, { editionId: edA.id, type: 'inventada' }, 'POST', 400);
  await call('/api/ads/decisions', admin.cookie, { editionId: edA.id, type: 'posponer_apertura' }, 'POST', 400);
  await call(
    '/api/ads/decisions',
    admin.cookie,
    { editionId: edA.id, type: 'subir_pauta', budget: 'abc' },
    'POST',
    400,
  );
  const ref = randomUUID(),
    made = (
      await call(
        '/api/ads/decisions',
        admin.cookie,
        { editionId: edA.id, type: 'subir_pauta', budget: 800, reason: 'Va muy bien', clientRef: ref },
        'POST',
        201,
      )
    ).decision;
  assert.equal(made.status, 'pending');
  assert.equal(made.budgetCents, 80000);
  assert.equal(made.kpis.messages, 55, 'queda la foto de las cifras al momento de decidir');
  assert.equal(
    (
      await call(
        '/api/ads/decisions',
        admin.cookie,
        { editionId: edA.id, type: 'subir_pauta', budget: 800, reason: 'Va muy bien', clientRef: ref },
        'POST',
        201,
      )
    ).decision.id,
    made.id,
    'reintento idempotente',
  );
  const pend = (await call('/api/ads/decisions?status=pending', trafi.cookie)).decisions;
  assert.deepEqual(
    pend.map(d => d.id),
    [made.id],
  );
  const avisos = await call('/api/operations/notifications', trafi.cookie);
  assert.ok(
    avisos.items.some(n => n.kind === 'ads' && /Subir pauta/.test(n.title)),
    'aviso al trafiquer',
  );
  await call('/api/ads/decisions/' + made.id + '/cancel', trafi.cookie, {}, 'POST', 403);
  const applied = (
    await call(
      '/api/ads/decisions/' + made.id + '/apply',
      trafi.cookie,
      { note: 'Presupuesto a $800/día en Meta' },
      'POST',
    )
  ).decision;
  assert.deepEqual([applied.status, applied.appliedNote], ['applied', 'Presupuesto a $800/día en Meta']);
  assert.match(applied.appliedBy, /trafiquer/);
  await call('/api/ads/decisions/' + made.id + '/apply', trafi.cookie, {}, 'POST', 409);
  const postponed = (
    await call(
      '/api/ads/decisions',
      admin.cookie,
      { editionId: edB.id, type: 'posponer_apertura', newDate: dayKey(Date.now() + 40 * day), reason: 'No llega' },
      'POST',
      201,
    )
  ).decision;
  assert.equal(
    (await call('/api/ads/decisions/' + postponed.id + '/cancel', admin.cookie, { note: 'Se resolvió' }, 'POST'))
      .decision.status,
    'cancelled',
  );
  assert.equal((await call('/api/ads/decisions', admin.cookie)).decisions.length, 2);

  // reporte por lanzamiento: totales y costo por mensaje y por alumno
  const rep = await call('/api/ads/report?brand=globalvet', trafi.cookie);
  const ra = rep.rows.find(r => r.editionId === edA.id);
  assert.deepEqual([ra.spendCents, ra.messages, ra.cplCents], [200000, 55, 3636]);
  assert.equal(ra.min, 8);
  assert.equal(rep.totals.spendCents, 200000 + 80050);
  assert.equal(
    (await call('/api/ads/report', admin.cookie)).rows.some(r => r.editionId === edO.id),
    true,
    'administración ve todas las marcas',
  );
  // quitar la función corta el acceso de inmediato
  await call('/api/ads/access', admin.cookie, { userId: tId, enabled: false }, 'PUT');
  await call('/api/ads/overview', trafi.cookie, undefined, 'GET', 403);
  assert.equal(daysBetween('2026-11-10', '2026-11-24'), 14);
});
