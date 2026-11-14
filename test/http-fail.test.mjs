import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, errorBody } from '../server/app/http.mjs';
import { startServer } from './helpers/server.mjs';

const UNEXPECTED = 'No se pudo completar la operación. Vuelve a intentarlo.';

test('fail: sin extras es el error de siempre; con code, field y details los lleva en el error', () => {
  const plain = fail(404, 'Contacto no disponible.');
  assert.ok(plain instanceof Error);
  assert.equal(plain.message, 'Contacto no disponible.');
  assert.deepEqual({ ...plain }, { status: 404 }, 'sin extras no añade ningún campo');
  assert.deepEqual({ ...fail(400, 'x', undefined) }, { status: 400 });
  assert.deepEqual({ ...fail(400, 'x', null) }, { status: 400 });
  assert.deepEqual({ ...fail(400, 'x', {}) }, { status: 400 });

  const coded = fail(409, 'Otra persona cambió este contacto.', { code: 'stale_record' });
  assert.deepEqual({ ...coded }, { status: 409, code: 'stale_record' });

  const full = fail(422, 'El teléfono no es válido.', {
    code: 'recipient_invalid',
    field: 'to.phone',
    details: { reason: 'too_short', digits: 7 },
  });
  assert.deepEqual(
    { ...full },
    { status: 422, code: 'recipient_invalid', field: 'to.phone', details: { reason: 'too_short', digits: 7 } },
  );
  for (const code of ['not_found', 'mfa_required', 'idempotency_key_reused', 'blocked', 'e2e_ok'])
    assert.equal(fail(400, 'x', { code }).code, code);
});

test('fail: un code, field o details mal escrito se rechaza al momento, no llega a un cliente', () => {
  for (const code of ['STALE_RECORD', 'Stale_record', 'stale-record', 'stale.record', 'stale record', '_x', 'x_', ''])
    assert.throws(() => fail(409, 'x', { code }), /minúsculas con guion bajo/, 'code: ' + JSON.stringify(code));
  for (const code of [409, null, ['stale_record'], 'a'.repeat(61)])
    assert.throws(() => fail(409, 'x', { code }), TypeError);
  for (const field of ['', 7, null, ['phone'], 'a'.repeat(101)])
    assert.throws(() => fail(400, 'x', { field }), /dato de entrada/);
  const loop = {};
  loop.self = loop;
  for (const details of ['texto', 5, null, ['a'], loop, { big: 10n }])
    assert.throws(() => fail(400, 'x', { details }), /details/);
  // Una clave que no existe no se pierde en silencio: quien la escribió se entera.
  assert.throws(() => fail(409, 'x', { codigo: 'stale_record' }), /«codigo» no se admite/);
  assert.throws(() => fail(409, 'x', { code: 'duplicate', activeOpportunityId: 'o1' }), /va en details/);
  assert.throws(() => fail(409, 'x', 'stale_record'), /tercer parámetro/);
  assert.throws(() => fail(409, 'x', ['stale_record']), /tercer parámetro/);
});

test('errorBody: { error, code?, field?, details? } y nada más; un fallo inesperado no revela nada', () => {
  assert.deepEqual(errorBody(fail(404, 'Ruta no disponible.')), { error: 'Ruta no disponible.' });
  assert.deepEqual(errorBody(fail(409, 'Cambió.', { code: 'stale_record' })), {
    error: 'Cambió.',
    code: 'stale_record',
  });
  assert.deepEqual(
    errorBody(fail(422, 'Falta el teléfono.', { code: 'invalid_request', field: 'phone', details: { min: 10 } })),
    { error: 'Falta el teléfono.', code: 'invalid_request', field: 'phone', details: { min: 10 } },
  );
  assert.deepEqual(errorBody(fail(400, 'x', { details: {} })), { error: 'x', details: {} });

  // Lo que el CRM ya devolvía sigue igual: los códigos en mayúsculas de followup.mjs y activeOpportunityId.
  const legacy = Object.assign(new Error('Ya existe otra oportunidad activa.'), {
    status: 409,
    code: 'ACTIVE_INTEREST',
    activeOpportunityId: 'opp-1',
  });
  assert.deepEqual(errorBody(legacy), {
    error: 'Ya existe otra oportunidad activa.',
    code: 'ACTIVE_INTEREST',
    activeOpportunityId: 'opp-1',
  });
  // Propiedades que no son del contrato (las de CsvError, por ejemplo) no salen.
  const csv = Object.assign(new Error('El archivo supera 2 MB.'), { status: 413, code: 'too_large', limit: 2e6 });
  assert.deepEqual(errorBody(csv), { error: 'El archivo supera 2 MB.', code: 'too_large' });

  // Sin status: texto fijo, sin el mensaje interno ni el código del sistema.
  const internal = Object.assign(new Error('SQLITE_CONSTRAINT: users.username'), { code: 'ERR_SQLITE_ERROR' });
  assert.deepEqual(errorBody(internal), { error: UNEXPECTED });
  assert.deepEqual(errorBody(new TypeError('x is not a function')), { error: UNEXPECTED });
  for (const odd of [null, undefined, 'texto', {}]) assert.deepEqual(errorBody(odd), { error: UNEXPECTED });

  // Un error ajeno con field o details de otro tipo, o que no se puede escribir como JSON, no rompe la respuesta.
  const loop = {};
  loop.self = loop;
  for (const extra of [{ details: loop }, { details: 'texto' }, { details: ['a'] }, { field: 7 }, { field: '' }])
    assert.deepEqual(errorBody(Object.assign(new Error('x'), { status: 400, ...extra })), { error: 'x' });

  // El cuerpo es una copia: cambiar después el objeto original no cambia lo que se responde.
  const details = { rows: [1, 2] };
  const body = errorBody(fail(400, 'x', { details }));
  details.rows.push(3);
  assert.deepEqual(body.details, { rows: [1, 2] });
});

test('el servidor real responde los errores con el formato de siempre', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-http-fail-'));
  const code = randomUUID();
  const password = 'Password-http-fail-2026!';
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code } });
  t.after(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const send = async (path, { cookie = '', method = 'GET', body, origin = server.origin, raw } = {}) => {
    const response = await fetch(server.origin + path, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  };
  const register = async (username, inviteCode) => {
    const made = await send('/api/auth/register', {
      method: 'POST',
      body: { username, name: 'Prueba ' + username, password, inviteCode },
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    return { cookie: made.cookie, user: made.body.user };
  };

  // Sin sesión, ruta desconocida, cuerpo ilegible y origen ajeno: sólo `error`, con el texto de siempre.
  assert.deepEqual(await send('/api/crm'), {
    status: 401,
    body: { error: 'Inicia sesión para continuar.' },
    cookie: undefined,
  });
  const admin = await register('admin', code);
  const customer = await register('cliente');
  const unknown = await send('/api/zzz-no-existe', { cookie: admin.cookie });
  assert.deepEqual([unknown.status, unknown.body], [404, { error: 'Ruta no disponible.' }]);
  const broken = await send('/api/auth/login', { method: 'POST', raw: '{no es json' });
  assert.deepEqual([broken.status, broken.body], [400, { error: 'Solicitud no válida.' }]);
  const foreign = await send('/api/profile', { method: 'POST', cookie: admin.cookie, body: {}, origin: '' });
  assert.deepEqual([foreign.status, foreign.body], [403, { error: 'Origen no permitido.' }]);
  const forbidden = await send('/api/team', { cookie: customer.cookie });
  assert.deepEqual([forbidden.status, forbidden.body], [403, { error: 'Este espacio es para el equipo autorizado.' }]);

  // Los dos códigos que ya existían llegan igual: mayúsculas, y activeOpportunityId junto a `code`.
  const chat = await send('/api/conversations', {
    method: 'POST',
    cookie: customer.cookie,
    body: { courseId: 'aves', channel: 'whatsapp' },
  });
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  const snapshot = async () => (await send('/api/crm', { cookie: admin.cookie })).body;
  const first = (await snapshot()).opportunities.find(o => o.conversation_id === chat.body.conversation.id);
  const patch = (id, body) => send('/api/crm/opportunities/' + id, { method: 'PATCH', cookie: admin.cookie, body });
  const stale = await patch(first.id, {
    stage: 'interesado',
    ownerId: admin.user.id,
    expectedRevision: first.revision + 5,
  });
  assert.deepEqual(
    [stale.status, stale.body],
    [409, { error: 'Otra persona cambió este registro. Recarga sus datos antes de guardar.', code: 'STALE_RECORD' }],
  );
  const lost = await patch(first.id, { stage: 'perdida', lostReason: 'Otro horario' });
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  const active = await send('/api/crm/opportunities', {
    method: 'POST',
    cookie: admin.cookie,
    body: {
      contactId: first.contact_id,
      courseId: 'aves',
      ownerId: admin.user.id,
      nextAction: 'Nuevo seguimiento',
      dueAt: Date.now() + 86400000,
    },
  });
  assert.equal(active.status, 201, JSON.stringify(active.body));
  const conflict = await patch(first.id, { stage: 'interesado', ownerId: admin.user.id });
  assert.deepEqual(
    [conflict.status, conflict.body],
    [
      409,
      {
        error: 'Ya existe otra oportunidad activa para este contacto y curso. Puedes abrirla para continuar.',
        code: 'ACTIVE_INTEREST',
        activeOpportunityId: active.body.id,
      },
    ],
  );
});
