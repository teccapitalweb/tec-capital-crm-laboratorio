// API v1 de escritura: llaves con permisos, caducidad y rotación; idempotencia; formato único de error; límites; y la
// API de contactos (docs/PLAN_API_ESCRITURA.md). Servidor real. Todo lo de aquí es inventado: nombres, teléfonos,
// correos y llaves (las llaves las crea cada prueba y se descartan con su base temporal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/database.mjs';
import { migrate, NAMED } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { openDb } from './helpers/crm.mjs';

const PASSWORD = 'Password-api-escritura-2026!';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const folder = prefix => mkdtemp(join(tmpdir(), prefix));
const remove = dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

test('migración api/0001: una base que ya existía queda igual que una nueva y sus llaves no ganan permisos', async t => {
  const oldDir = await folder('crm-api-old-');
  const freshDir = await folder('crm-api-new-');
  const old = openDatabase(oldDir);
  const fresh = openDatabase(freshDir);
  t.after(async () => {
    old.close();
    fresh.close();
    await remove(oldDir);
    await remove(freshDir);
  });
  migrate(old, { backup: false, registry: defineRegistry(NAMED.filter(m => !m.name.startsWith('api/'))) });
  old
    .prepare(
      "INSERT INTO api_keys(id,brand_id,name,prefix,key_hash,scopes,created_at) VALUES('k1','globalvet','Panel','tcw_abcdef','00','[\"contacts\"]',1)",
    )
    .run();
  migrate(old, { backup: false });
  assertSchemaCurrent(old);
  migrate(old, { backup: false });
  assertSchemaCurrent(old);
  migrate(fresh, { backup: false });
  assert.deepEqual(schemaShape(old), schemaShape(fresh));
  const key = old.prepare("SELECT * FROM api_keys WHERE id='k1'").get();
  assert.equal(key.scopes, '["contacts"]');
  assert.equal(key.expires_at, null);
  assert.equal(key.rotated_from, null);
  assert.equal(old.prepare('SELECT count(*) n FROM api_requests').get().n, 0);
});

async function lab(t, env = {}) {
  const dir = await folder('crm-api-write-');
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, ...env } });
  let db = null;
  t.after(async () => {
    db?.close();
    await server.stop();
    await remove(dir);
  });
  const origin = server.origin;
  // Con sesión (administración).
  const call = async (path, cookie, body, method = body === undefined ? 'GET' : 'POST', expected = 200) => {
    const response = await fetch(origin + path, {
      method,
      headers: { Cookie: cookie ?? '', Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
    return { ...data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  // Con llave (sin sesión ni Origin, como un sistema externo).
  const api = async (method, path, token, { body, raw, type = 'application/json', idem, expected } = {}) => {
    const headers = { ...(token ? { Authorization: 'Bearer ' + token } : {}) };
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = type;
    if (idem) headers['Idempotency-Key'] = idem;
    const response = await fetch(origin + path, {
      method,
      headers,
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (expected !== undefined) assert.equal(response.status, expected, `${method} ${path}: ${text.slice(0, 300)}`);
    return { status: response.status, headers: response.headers, body: data };
  };
  const admin = (
    await call('/api/auth/register', '', {
      username: 'admin',
      name: 'Administración',
      password: PASSWORD,
      inviteCode: code,
    })
  ).cookie;
  const mkKey = async (scopes, over = {}, expected = 201) =>
    call(
      '/api/integrations/keys',
      admin,
      { brandId: 'globalvet', name: 'Llave ' + scopes.join('+'), scopes, ...over },
      'POST',
      expected,
    );
  return { origin, call, api, admin, mkKey, db: () => (db ??= openDb(dir)), logs: () => server.logs() };
}

// Error con el formato único: { error, code, status, requestId } y la misma X-Request-Id en la cabecera.
function assertError(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.code, code, JSON.stringify(res.body));
  assert.equal(res.body.status, status);
  assert.equal(typeof res.body.error, 'string');
  assert.match(res.body.requestId, /^req_[a-f0-9]{24}$/);
  assert.equal(res.headers.get('x-request-id'), res.body.requestId);
}

test('servidor real: llaves de escritura, idempotencia, errores, consentimiento y contactos por la API', async t => {
  const { call, api, admin, mkKey, db, logs } = await lab(t);
  const read = await mkKey(['contacts']);
  const write = await mkKey(['contacts', 'contacts_write']);
  const writeOnly = await mkKey(['contacts_write']);
  const consentKey = await mkKey(['contacts', 'contacts_write', 'consent_write']);
  const templatesKey = await mkKey(['templates']);
  const other = await mkKey(['contacts', 'contacts_write'], { brandId: 'odonteck' });
  const tokens = [read, write, writeOnly, consentKey, templatesKey, other].map(k => k.token);

  // ---- llaves: caducidad obligatoria al escribir, opcional al leer; el permiso de plantillas aún no se puede dar
  assert.equal(read.key.expiresAt, null);
  assert.equal(read.key.kind, 'read');
  assert.equal(write.key.kind, 'write');
  assert.equal(write.key.expiresAt - write.key.createdAt, 180 * DAY);
  await mkKey(['contacts_write'], { expiresInDays: 400 }, 400);
  await mkKey(['messages_send_template'], {}, 400);
  const short = await mkKey(['contacts'], { expiresInDays: 7 });
  assert.equal(short.key.expiresAt - short.key.createdAt, 7 * DAY);
  const listing = await call('/api/integrations', admin);
  assert.equal(listing.scopeKinds.contacts_write, 'write');
  assert.ok(listing.plannedScopes.messages_send_template);

  // ---- /me
  const me = await api('GET', '/api/v1/me', write.token, { expected: 200 });
  assert.deepEqual(me.body.permissions, [
    { name: 'contacts', kind: 'read' },
    { name: 'contacts_write', kind: 'write' },
  ]);
  assert.equal(me.body.key.expiresAt, write.key.expiresAt);
  assert.equal(me.body.actorActive, true);
  assert.equal(me.body.limits.writePerMinute, 300);
  assert.equal(me.body.limits.batchMax, 100);
  assert.equal(me.headers.get('x-key-expires'), new Date(write.key.expiresAt).toISOString());
  assert.equal(me.headers.get('ratelimit-limit'), '120');
  assert.ok(Number(me.headers.get('ratelimit-remaining')) < 120);

  // ---- una llave de lectura no escribe; formato único de error
  assertError(
    await api('POST', '/api/v1/contacts', read.token, { body: { phone: '5512345678' } }),
    403,
    'scope_missing',
  );
  assertError(await api('POST', '/api/v1/contacts', '', { body: { phone: '5512345678' } }), 401, 'unauthorized');
  assertError(await api('GET', '/api/v1/no-existe', write.token), 404, 'not_found');
  const wrongMethod = await api('DELETE', '/api/v1/contacts', write.token);
  assertError(wrongMethod, 405, 'method_not_allowed');
  assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
  assertError(
    await api('POST', '/api/v1/contacts', write.token, { raw: 'phone=55', type: 'text/plain' }),
    415,
    'unsupported_media_type',
  );
  assertError(await api('POST', '/api/v1/contacts', write.token, { raw: '{"phone":' }), 400, 'invalid_json');
  assertError(await api('POST', '/api/v1/contacts', write.token, { raw: '[]' }), 400, 'invalid_json');
  assertError(
    await api('POST', '/api/v1/contacts', write.token, { body: { phone: '5512345678', name: 'x'.repeat(300 * 1024) } }),
    413,
    'payload_too_large',
  );
  assertError(
    await api('POST', '/api/v1/contacts', write.token, { body: { name: 'Sin teléfono' } }),
    400,
    'invalid_request',
  );
  assertError(
    await api('POST', '/api/v1/contacts', write.token, { body: { phone: '5512345678', apodo: 'x' } }),
    400,
    'invalid_request',
  );
  const badPhone = await api('POST', '/api/v1/contacts', write.token, { body: { phone: '12' } });
  assertError(badPhone, 422, 'phone_invalid');
  assert.ok(!JSON.stringify(badPhone.body).includes('"12"'), 'el error no repite el dato');

  // ---- alta y actualización por teléfono, sin duplicar
  const created = await api('POST', '/api/v1/contacts', write.token, {
    body: { phone: '5512345678', name: 'Paciente Inventado', email: 'paciente.inventado@example.com' },
    expected: 201,
  });
  assert.equal(created.body.contact.created, true);
  assert.equal(created.body.result, 'created');
  assert.ok(!JSON.stringify(created.body).includes('5512345678'), 'la respuesta de escritura no trae el teléfono');
  const id = created.body.contact.id;
  for (const phone of ['+52 55 1234 5678', '5215512345678', '52 1 55 1234 5678']) {
    const again = await api('POST', '/api/v1/contacts', write.token, {
      body: { phone, name: 'Otro Nombre' },
      expected: 200,
    });
    assert.equal(again.body.contact.id, id, phone);
    assert.equal(again.body.contact.created, false);
  }
  assert.equal(
    db()
      .prepare(
        "SELECT count(*) n FROM contacts WHERE brand_id='globalvet' AND phone_key=(SELECT phone_key FROM contacts WHERE id=?)",
      )
      .get(id).n,
    1,
  );
  let view = (await api('GET', '/api/v1/contacts/' + id, read.token, { expected: 200 })).body.contact;
  assert.equal(view.name, 'Paciente Inventado', 'sin overwriteName no se pisa el nombre');
  assert.equal(view.source, 'api');
  assert.equal(view.phone, '+525512345678');
  await api('POST', '/api/v1/contacts', write.token, {
    body: { phone: '5512345678', name: 'Nombre Corregido', overwriteName: true },
    expected: 200,
  });
  view = (await api('GET', '/api/v1/contacts/' + id, read.token)).body.contact;
  assert.equal(view.name, 'Nombre Corregido');
  // Leer pide el permiso «contacts» (la llave sólo de escritura no ve teléfonos)
  assertError(await api('GET', '/api/v1/contacts/' + id, writeOnly.token), 403, 'scope_missing');
  // Una llave que sólo escribe no sondea si un teléfono ya es contacto: alta, lote y PATCH piden también «contacts»
  // y la respuesta para un número dado de alta y para uno nuevo es la misma (con los dos permisos, sí informa: arriba).
  const probe = async phone => {
    const r = await api('POST', '/api/v1/contacts', writeOnly.token, { body: { phone } });
    assertError(r, 403, 'scope_missing');
    return { status: r.status, body: { ...r.body, requestId: null } };
  };
  assert.deepEqual(await probe('5512345678'), await probe('5591112233'));
  assertError(
    await api('POST', '/api/v1/contacts/batch', writeOnly.token, {
      idem: 'sondeo-0001',
      body: { contacts: [{ phone: '5512345678' }] },
    }),
    403,
    'scope_missing',
  );
  assertError(
    await api('PATCH', '/api/v1/contacts/' + id, writeOnly.token, { body: { phone: '5591112233' } }),
    403,
    'scope_missing',
  );
  assert.equal(db().prepare("SELECT count(*) n FROM contacts WHERE phone='+525591112233'").get().n, 0);
  assert.deepEqual(
    (await api('POST', `/api/v1/contacts/${id}/tags`, writeOnly.token, { body: { add: ['Por id'] }, expected: 200 }))
      .body.tags,
    ['Por id'],
    'por id (que no se adivina) sí escribe',
  );
  await api('POST', `/api/v1/contacts/${id}/tags`, write.token, { body: { remove: ['Por id'] }, expected: 200 });
  assert.equal(
    (await api('POST', '/api/v1/contacts/lookup', read.token, { body: { phone: '+52 55 1234 5678' }, expected: 200 }))
      .body.contact.id,
    id,
  );
  assertError(
    await api('POST', '/api/v1/contacts/lookup', read.token, { body: { phone: '5599990000' } }),
    404,
    'not_found',
  );
  // Las rutas de lectura de siempre siguen igual
  assert.ok((await api('GET', '/api/v1/contacts', read.token, { expected: 200 })).body.contacts.some(c => c.id === id));

  // ---- otra marca: 404 sin revelar que existe; el mismo teléfono es otro contacto en su marca
  assertError(await api('GET', '/api/v1/contacts/' + id, other.token), 404, 'not_found');
  assertError(
    await api('PATCH', '/api/v1/contacts/' + id, other.token, { body: { name: 'Intruso' } }),
    404,
    'not_found',
  );
  assertError(
    await api('POST', `/api/v1/contacts/${id}/tags`, other.token, { body: { add: ['x'] } }),
    404,
    'not_found',
  );
  assertError(
    await api('PUT', `/api/v1/contacts/${id}/consent`, other.token, { body: { status: 'opted_out' } }),
    404,
    'not_found',
  );
  assertError(await api('GET', '/api/v1/contacts/' + randomUUID(), read.token), 404, 'not_found');
  const theirs = await api('POST', '/api/v1/contacts', other.token, {
    body: { phone: '5512345678', name: 'Persona Odonteck' },
    expected: 201,
  });
  assert.notEqual(theirs.body.contact.id, id);
  assert.equal(
    db().prepare('SELECT brand_id FROM contacts WHERE id=?').get(theirs.body.contact.id).brand_id,
    'odonteck',
  );

  // ---- idempotencia
  const idemBody = { phone: '5523456789', name: 'Alumno Repetido' };
  const first = await api('POST', '/api/v1/contacts', write.token, {
    body: idemBody,
    idem: 'alta-alumno-0001',
    expected: 201,
  });
  const replay = await api('POST', '/api/v1/contacts', write.token, {
    body: idemBody,
    idem: 'alta-alumno-0001',
    expected: 201,
  });
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.headers.get('idempotent-replayed'), 'true');
  assert.equal(first.headers.get('idempotent-replayed'), null);
  assertError(
    await api('POST', '/api/v1/contacts', write.token, {
      body: { ...idemBody, name: 'Otro' },
      idem: 'alta-alumno-0001',
    }),
    409,
    'idempotency_key_reused',
  );
  // La misma clave en otra llave es otra clave
  await api('POST', '/api/v1/contacts', consentKey.token, { body: idemBody, idem: 'alta-alumno-0001', expected: 200 });
  assertError(
    await api('POST', '/api/v1/contacts', write.token, { body: idemBody, idem: 'corta' }),
    400,
    'invalid_request',
  );
  // Dos peticiones a la vez con la misma clave: un solo efecto
  const together = { phone: '5534567890', name: 'Alumna Simultánea' };
  const pair = await Promise.all([
    api('POST', '/api/v1/contacts', write.token, { body: together, idem: 'simultanea-0001' }),
    api('POST', '/api/v1/contacts', write.token, { body: together, idem: 'simultanea-0001' }),
  ]);
  assert.deepEqual(
    pair.map(r => r.status),
    [201, 201],
  );
  assert.equal(pair[0].body.contact.id, pair[1].body.contact.id);
  assert.equal(pair.filter(r => r.headers.get('idempotent-replayed') === 'true').length, 1);
  assert.equal(db().prepare("SELECT count(*) n FROM api_requests WHERE idem_key='simultanea-0001'").get().n, 1);
  // Y sin clave, el teléfono sigue siendo la segunda barrera: un contacto
  const race = await Promise.all(
    [1, 2, 3].map(() =>
      api('POST', '/api/v1/contacts', write.token, { body: { phone: '5545678901', name: 'Carrera' } }),
    ),
  );
  assert.equal(new Set(race.map(r => r.body.contact.id)).size, 1);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 200, 201]);
  // La clave vale 7 días: pasada, se libera y la misma clave vuelve a servir
  db()
    .prepare("UPDATE api_requests SET created_at=created_at-? WHERE idem_key='alta-alumno-0001'")
    .run(8 * DAY);
  const later = await api('POST', '/api/v1/contacts', write.token, {
    body: { ...idemBody, name: 'Otro' },
    idem: 'alta-alumno-0001',
    expected: 200,
  });
  assert.equal(later.headers.get('idempotent-replayed'), null);

  // ---- lote: filas independientes, clave obligatoria, tope
  assertError(
    await api('POST', '/api/v1/contacts/batch', write.token, { body: { contacts: [{ phone: '5556789012' }] } }),
    400,
    'idempotency_key_required',
  );
  const batch = await api('POST', '/api/v1/contacts/batch', write.token, {
    idem: 'lote-0001',
    body: {
      contacts: [{ phone: '5556789012', name: 'Lote Uno' }, { phone: 'no-es-telefono' }, { phone: '5512345678' }],
    },
    expected: 200,
  });
  assert.equal(batch.body.results[0].created, true);
  assert.equal(batch.body.results[1].error.code, 'phone_invalid');
  assert.equal(batch.body.results[2].id, id);
  assert.equal(db().prepare("SELECT units FROM api_requests WHERE idem_key='lote-0001'").get().units, 3);
  const many = Array.from({ length: 101 }, (_, i) => ({ phone: '55' + String(10000000 + i) }));
  assertError(
    await api('POST', '/api/v1/contacts/batch', write.token, { idem: 'lote-0002', body: { contacts: many } }),
    400,
    'invalid_request',
  );

  // ---- consentimiento
  assertError(
    await api('POST', '/api/v1/contacts', write.token, {
      body: { phone: '5567890123', consent: { status: 'opted_in', source: 'Formulario de inscripción' } },
    }),
    403,
    'scope_missing',
  );
  assertError(
    await api('POST', '/api/v1/contacts', consentKey.token, {
      body: { phone: '5567890123', consent: { status: 'opted_in' } },
    }),
    400,
    'invalid_request',
  );
  const accepted = await api('POST', '/api/v1/contacts', consentKey.token, {
    body: {
      phone: '5567890123',
      name: 'Acepta Mensajes',
      consent: { status: 'opted_in', source: 'Formulario de inscripción', evidence: 'Casilla marcada' },
    },
    expected: 201,
  });
  assert.equal(accepted.body.consent, 'opted_in');
  const acceptedId = accepted.body.contact.id;
  const row = db().prepare('SELECT status,source,note FROM contact_consent WHERE contact_id=?').get(acceptedId);
  assert.equal(row.status, 'opted_in');
  assert.equal(row.source, 'api');
  assert.match(row.note, /Formulario de inscripción/);
  // Baja con contacts_write; la API no la levanta (409 en la ruta; aviso en el alta)
  const optOut = await api('PUT', `/api/v1/contacts/${acceptedId}/consent`, write.token, {
    body: { status: 'opted_out' },
    expected: 200,
  });
  assert.equal(optOut.body.consent.status, 'opted_out');
  assertError(
    await api('PUT', `/api/v1/contacts/${acceptedId}/consent`, consentKey.token, {
      body: { status: 'opted_in', source: 'Formulario de inscripción' },
    }),
    409,
    'consent_locked',
  );
  const locked = await api('POST', '/api/v1/contacts', consentKey.token, {
    body: { phone: '5567890123', consent: { status: 'opted_in', source: 'Formulario de inscripción' } },
    expected: 200,
  });
  assert.equal(locked.body.warnings[0].code, 'consent_locked');
  assert.equal(
    db().prepare('SELECT status FROM contact_consent WHERE contact_id=?').get(acceptedId).status,
    'opted_out',
  );
  assertError(
    await api('PUT', `/api/v1/contacts/${acceptedId}/consent`, consentKey.token, { body: { status: 'quizas' } }),
    400,
    'invalid_request',
  );

  // ---- datos propios (atributos)
  await call(
    '/api/attributes',
    admin,
    { brandId: 'globalvet', key: 'nivel', label: 'Nivel', type: 'text' },
    'POST',
    201,
  );
  await call(
    '/api/attributes',
    admin,
    { brandId: 'globalvet', key: 'curp_prueba', label: 'Clave personal', type: 'text', personal: true },
    'POST',
    201,
  );
  await api('PATCH', '/api/v1/contacts/' + id, write.token, {
    body: { attributes: { nivel: 'Básico' } },
    expected: 200,
  });
  assert.equal((await api('GET', '/api/v1/contacts/' + id, read.token)).body.contact.attributes.nivel, 'Básico');
  await api('PATCH', '/api/v1/contacts/' + id, write.token, { body: { attributes: { nivel: '' } }, expected: 200 });
  assert.equal((await api('GET', '/api/v1/contacts/' + id, read.token)).body.contact.attributes.nivel, undefined);
  assertError(
    await api('PATCH', '/api/v1/contacts/' + id, write.token, { body: { attributes: { inventado: 'x' } } }),
    422,
    'attribute_unknown',
  );
  assertError(
    await api('PATCH', '/api/v1/contacts/' + id, write.token, { body: { attributes: { origen: 'x' } } }),
    422,
    'attribute_read_only',
  );
  // Un dato personal no lo escribe quien no puede verlo (sin «contacts» ni siquiera llega a la ruta)
  assertError(
    await api('PATCH', '/api/v1/contacts/' + id, writeOnly.token, {
      body: { attributes: { curp_prueba: 'XAXX010101' } },
    }),
    403,
    'scope_missing',
  );
  await api('PATCH', '/api/v1/contacts/' + id, write.token, {
    body: { attributes: { curp_prueba: 'XAXX010101' } },
    expected: 200,
  });
  assert.ok(
    db().prepare("SELECT count(*) n FROM domain_events WHERE type='contacto.atributo_cambiado'").get().n >= 2,
    'el cambio de un dato por la API publica su evento',
  );

  // ---- PATCH con revisión
  const current = (await api('GET', '/api/v1/contacts/' + id, read.token)).body.contact;
  assertError(
    await api('PATCH', '/api/v1/contacts/' + id, write.token, {
      body: { email: 'nuevo@example.com', expectedUpdatedAt: current.updatedAt - 1 },
    }),
    409,
    'stale_revision',
  );
  const patched = await api('PATCH', '/api/v1/contacts/' + id, write.token, {
    body: { email: 'nuevo@example.com', expectedUpdatedAt: current.updatedAt },
    expected: 200,
  });
  assert.equal(patched.body.result, 'updated');
  const kept = await api('PATCH', '/api/v1/contacts/' + id, write.token, {
    body: { phone: '5599887766' },
    expected: 200,
  });
  assert.equal(kept.body.warnings[0].code, 'phone_kept');

  // ---- etiquetas por nombre
  const tagged = await api('POST', `/api/v1/contacts/${id}/tags`, write.token, {
    body: { add: ['Inscrito API', 'Recordatorio'] },
    expected: 200,
  });
  assert.deepEqual(tagged.body.tags, ['Inscrito API', 'Recordatorio']);
  const untagged = await api('POST', `/api/v1/contacts/${id}/tags`, write.token, {
    body: { remove: ['inscrito api'] },
    expected: 200,
  });
  assert.deepEqual(untagged.body.tags, ['Recordatorio']);
  await api('POST', '/api/v1/contacts', write.token, {
    body: { phone: '5512345678', tags: { add: ['Desde alta'], remove: ['Recordatorio'] } },
    expected: 200,
  });
  assert.deepEqual((await api('GET', '/api/v1/contacts/' + id, read.token)).body.contact.tags, ['Desde alta']);
  assertError(
    await api('POST', `/api/v1/contacts/${id}/tags`, write.token, {
      body: { add: ['Una etiqueta demasiado larga para el límite'] },
    }),
    422,
    'tag_invalid',
  );

  // ---- listas
  const list = (
    await call(
      '/api/audiences',
      admin,
      { brandId: 'globalvet', kind: 'list', name: 'Recordatorios de prueba' },
      'POST',
      201,
    )
  ).audience;
  assert.ok((await api('GET', '/api/v1/lists', read.token, { expected: 200 })).body.lists.some(l => l.id === list.id));
  const ghost = randomUUID();
  const added = await api('POST', `/api/v1/lists/${list.id}/contacts`, write.token, {
    body: { contactIds: [id, theirs.body.contact.id, ghost] },
    expected: 200,
  });
  assert.equal(added.body.added, 1);
  assert.deepEqual(added.body.unknown.sort(), [theirs.body.contact.id, ghost].sort());
  assert.equal(
    (await api('POST', `/api/v1/lists/${list.id}/contacts`, write.token, { body: { contactIds: [id] }, expected: 200 }))
      .body.added,
    0,
  );
  assertError(
    await api('POST', `/api/v1/lists/${list.id}/contacts`, other.token, {
      body: { contactIds: [theirs.body.contact.id] },
    }),
    404,
    'not_found',
  );

  // ---- plantillas: sólo las aprobadas de la marca de la llave
  const insertTemplate = (brand, name, status) =>
    db()
      .prepare(
        "INSERT INTO wa_templates(id,brand_id,name,language,category,body,variables,status,created_at,updated_at) VALUES(?,?,?,'es_MX','utility','Hola {{1}}, tu clase es mañana.','[\"nombre\"]',?,1,1)",
      )
      .run(randomUUID(), brand, name, status);
  insertTemplate('globalvet', 'recordatorio_clase_prueba', 'approved');
  insertTemplate('globalvet', 'borrador_prueba', 'draft');
  insertTemplate('odonteck', 'recordatorio_otra_marca', 'approved');
  assertError(await api('GET', '/api/v1/templates', read.token), 403, 'scope_missing');
  const templates = (await api('GET', '/api/v1/templates', templatesKey.token, { expected: 200 })).body.templates;
  assert.deepEqual(
    templates.map(x => x.name),
    ['recordatorio_clase_prueba'],
  );
  assert.equal(templates[0].parameters[0].key, 'nombre');

  // ---- rotación con convivencia, revocación y caducidad
  const rotated = await call(`/api/integrations/keys/${write.key.id}/rotate`, admin, {}, 'POST', 201);
  assert.equal(rotated.key.rotatedFrom, write.key.id);
  assert.deepEqual(rotated.key.scopes, write.key.scopes);
  assert.equal(rotated.previous.state, 'grace');
  assert.ok(rotated.previous.expiresAt <= Date.now() + 72 * HOUR);
  await call(`/api/integrations/keys/${write.key.id}/rotate`, admin, {}, 'POST', 409);
  await api('GET', '/api/v1/me', rotated.token, { expected: 200 });
  await api('POST', '/api/v1/contacts', write.token, { body: { phone: '5512345678' }, expected: 200 }); // la anterior, durante la convivencia
  db()
    .prepare('UPDATE api_keys SET expires_at=? WHERE id=?')
    .run(Date.now() - 1000, write.key.id); // pasaron las 72 horas
  assertError(
    await api('POST', '/api/v1/contacts', write.token, { body: { phone: '5512345678' } }),
    401,
    'key_expired',
  );
  await api('POST', '/api/v1/contacts', rotated.token, { body: { phone: '5512345678' }, expected: 200 });
  assert.equal((await call('/api/integrations', admin)).keys.find(k => k.id === write.key.id).state, 'expired');
  await call(`/api/integrations/keys/${short.key.id}/revoke`, admin, {}, 'POST');
  assertError(await api('GET', '/api/v1/me', short.token), 401, 'unauthorized');

  // ---- registro y auditoría sin la llave ni datos personales
  const requests = JSON.stringify(db().prepare('SELECT * FROM api_requests').all());
  const audit = JSON.stringify(db().prepare("SELECT * FROM audit WHERE action LIKE 'api.%'").all());
  assert.ok(db().prepare("SELECT count(*) n FROM audit WHERE action='api.contact.upsert'").get().n > 0);
  assert.equal(
    db().prepare('SELECT count(*) n FROM api_requests WHERE key_id=?').get(read.key.id).n,
    0,
    'una llave sin permiso de escritura no llega a escribir',
  );
  assert.ok(
    db().prepare('SELECT count(*) n FROM api_requests WHERE status=422').get().n > 0,
    'un intento fallido queda registrado',
  );
  for (const token of [...tokens, rotated.token]) {
    for (const [where, text] of [
      ['api_requests', requests],
      ['auditoría', audit],
      ['registros del servidor', logs()],
    ])
      assert.ok(!text.includes(token) && !text.includes(token.slice(4)), 'la llave no aparece en ' + where);
  }
  for (const personal of ['5512345678', 'paciente.inventado', 'Formulario de inscripción'])
    assert.ok(!requests.includes(personal), 'api_requests no guarda ' + personal);

  // ---- quien creó la llave deja de administrar: la llave ya no escribe
  db().prepare("UPDATE users SET role='agent' WHERE username='admin'").run();
  assertError(
    await api('POST', '/api/v1/contacts', rotated.token, { body: { phone: '5512345678' } }),
    403,
    'actor_inactive',
  );
  assert.equal((await api('GET', '/api/v1/me', rotated.token, { expected: 200 })).body.actorActive, false);
});

test('servidor real: límites por llave con sus cabeceras y 429 con Retry-After', async t => {
  const { api, mkKey } = await lab(t, { API_WRITE_PER_MINUTE: '3', API_READ_PER_MINUTE: '4' });
  const key = await mkKey(['contacts', 'contacts_write']);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/api/v1/contacts', key.token, { body: { phone: '5590000000', name: 'Límite' } });
    assert.ok([200, 201].includes(r.status));
    seen.push([r.headers.get('ratelimit-limit'), r.headers.get('ratelimit-remaining')]);
    assert.ok(Number(r.headers.get('ratelimit-reset')) >= 1);
  }
  assert.deepEqual(seen, [
    ['3', '2'],
    ['3', '1'],
    ['3', '0'],
  ]);
  const limited = await api('POST', '/api/v1/contacts', key.token, { body: { phone: '5590000000' } });
  assertError(limited, 429, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  // La lectura lleva su propia cuenta
  const r = await api('GET', '/api/v1/me', key.token, { expected: 200 });
  assert.equal(r.headers.get('ratelimit-limit'), '4');
  // Otra llave de la misma marca no hereda el límite
  const otherKey = await mkKey(['contacts', 'contacts_write']);
  await api('POST', '/api/v1/contacts', otherKey.token, { body: { phone: '5590000000' }, expected: 200 });
});
