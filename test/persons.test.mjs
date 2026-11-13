import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/database.mjs';
import { migrateCRM } from '../server/crm.mjs';
import { migrateFollowup } from '../server/followup.mjs';
import { migrateCatalogue } from '../server/catalogue-schema.mjs';
import { migrateOperations, migrateHolidays } from '../server/operations-schema.mjs';
import { migrateAutomation, migrateRecipes } from '../server/automation-schema.mjs';
import { migrateContacts, migrateConsent } from '../server/contacts-schema.mjs';
import { migrateMfa } from '../server/mfa-schema.mjs';
import { migrateReplies } from '../server/replies-schema.mjs';
import { migrateSimulator } from '../server/simulator-schema.mjs';
import { migrateChannel } from '../server/channel-schema.mjs';
import { migratePayments } from '../server/payments-schema.mjs';
import { migrateConnectors } from '../server/connectors-schema.mjs';
import { migrateEvaluation } from '../server/evaluation-schema.mjs';
import { migrateCoordination } from '../server/coordination-schema.mjs';
import { migrateFinance } from '../server/finance-schema.mjs';
import { migratePersons, normalizePhone, normalizeEmail, normalizeName } from '../server/persons-schema.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';

const upTo20 = db => {
  migrateCRM(db);
  migrateFollowup(db);
  migrateCatalogue(db);
  migrateOperations(db);
  migrateAutomation(db);
  migrateRecipes(db);
  migrateContacts(db);
  migrateConsent(db);
  migrateHolidays(db);
  migrateMfa(db);
  migrateReplies(db);
  migrateSimulator(db);
  migrateChannel(db);
  migratePayments(db);
  migrateConnectors(db);
  migrateEvaluation(db);
  migrateCoordination(db);
  migrateFinance(db);
};

test('normalización de teléfono (México por omisión), correo y nombre', () => {
  for (const [raw, want] of [
    ['5512345678', '+525512345678'],
    ['55 1234 5678', '+525512345678'],
    ['+52 55 1234 5678', '+525512345678'],
    ['52 55 1234 5678', '+525512345678'],
    ['521 55 1234 5678', '+525512345678'],
    ['044 55 1234 5678', '+525512345678'],
    ['0052 55 1234 5678', '+525512345678'],
    ['+1 (415) 555-2671', '+14155552671'],
    ['123', ''],
    ['', ''],
    ['abc', ''],
    ['+1', ''],
  ])
    assert.equal(normalizePhone(raw), want, raw);
  assert.equal(normalizePhone('3001234567', '57'), '+573001234567');
  assert.equal(normalizeEmail(' Ana.Perez@Mail.COM '), 'ana.perez@mail.com');
  assert.equal(normalizeEmail('sin-arroba'), '');
  assert.equal(normalizeEmail('a@b'), '');
  assert.equal(normalizeName('  María  José Pérez '), 'maria jose perez');
});

test('migración v21: relleno de personas por perfil, teléfono y correo; consentimiento más estricto proyectado; idempotente', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-persons-')),
    db = openDatabase(dir);
  upTo20(db);
  t.after(async () => {
    try {
      db.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });
  const t0 = Date.now();
  db.prepare(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-ana','ana','Ana Pérez','x','customer',1,?,?)",
  ).run(t0, t0);
  const contact = (id, brand, name, phone = '', email = '', userId = null) =>
    db
      .prepare(
        'INSERT INTO contacts(id,brand_id,source_user_id,name,phone,email,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(id, brand, userId, name, phone, email, userId ? 'laboratorio' : 'manual', t0, t0);
  contact('c-gv-ana', 'globalvet', 'Ana Pérez', '', '', 'u-ana');
  contact('c-od-ana', 'odonteck', 'Ana Pérez', '55 1234 5678', 'ana@mail.com', 'u-ana'); // mismo perfil en dos marcas
  contact('c-de-ana', 'dermalysse', 'Ana P.', '+52 55 1234 5678', ''); // mismo teléfono normalizado
  contact('c-gv-luis', 'globalvet', 'Luis Gómez', '', 'LUIS@MAIL.COM');
  contact('c-od-luis', 'odonteck', 'Luis Gomez', '', 'luis@mail.com'); // mismo correo
  contact('c-gv-sola', 'globalvet', 'Persona Sola', '123', 'no-es-correo'); // sin identidad utilizable
  db.prepare(
    "INSERT INTO contact_consent(contact_id,brand_id,status,source,note,updated_at) VALUES('c-od-ana','odonteck','opted_out','staff','Pidió la baja',?)",
  ).run(t0);
  db.prepare(
    "INSERT INTO contact_consent(contact_id,brand_id,status,source,note,updated_at) VALUES('c-gv-luis','globalvet','opted_in','staff','',?)",
  ).run(t0);
  migratePersons(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 21);
  const pid = id => db.prepare('SELECT persona_id FROM contacts WHERE id=?').get(id).persona_id;
  assert.ok(pid('c-gv-ana'));
  assert.equal(pid('c-gv-ana'), pid('c-od-ana'), 'mismo perfil → misma persona');
  assert.equal(pid('c-od-ana'), pid('c-de-ana'), 'mismo teléfono → misma persona');
  assert.equal(pid('c-gv-luis'), pid('c-od-luis'), 'mismo correo → misma persona');
  assert.notEqual(pid('c-gv-sola'), pid('c-gv-ana'));
  assert.equal(db.prepare('SELECT count(*) n FROM persons').get().n, 3);
  const ana = db.prepare('SELECT * FROM persons WHERE id=?').get(pid('c-gv-ana'));
  assert.equal(ana.source_user_id, 'u-ana');
  assert.equal(ana.consent_brand_id, 'odonteck');
  assert.equal(ana.phone, '+525512345678');
  assert.equal(ana.email, 'ana@mail.com');
  assert.equal(ana.consent_status, 'opted_out', 'el consentimiento de la persona es el más estricto');
  assert.deepEqual(
    db
      .prepare('SELECT kind,value FROM person_identities WHERE person_id=? ORDER BY kind')
      .all(ana.id)
      .map(r => ({ kind: r.kind, value: r.value })),
    [
      { kind: 'email', value: 'ana@mail.com' },
      { kind: 'phone', value: '+525512345678' },
      { kind: 'profile', value: 'u-ana' },
    ],
  );
  const gv = db.prepare("SELECT status,note,actor_id FROM contact_consent WHERE contact_id='c-gv-ana'").get();
  assert.equal(gv.status, 'opted_out', 'la baja se proyecta a los demás contactos de la persona');
  assert.notEqual(gv.note, 'Pidió la baja', 'la nota se queda en la marca de origen');
  assert.equal(db.prepare("SELECT note FROM contact_consent WHERE contact_id='c-od-ana'").get().note, 'Pidió la baja');
  assert.equal(db.prepare("SELECT status FROM contact_consent WHERE contact_id='c-od-luis'").get().status, 'opted_in');
  assert.equal(db.prepare('SELECT count(*) n FROM person_consent_events').get().n, 2);
  db.close();
  const again = openDatabase(dir);
  upTo20(again);
  migratePersons(again);
  assert.equal(again.prepare('SELECT count(*) n FROM persons').get().n, 3);
  again.close();
});

test('personas por API: dos conversaciones de la misma persona en marcas distintas comparten ficha; alcance; consentimiento a nivel persona; candidaturas y fusión; exportación', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-persons-api-')),
    code = randomUUID(),
    password = 'Password-persons-2026!';
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
  const sleep = ms => new Promise(r => setTimeout(r, ms)),
    msgs = id => '/api/conversations/' + id + '/messages';
  async function until(fn, tries = 40) {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (v) return v;
      await sleep(250);
    }
    return v;
  }
  assert.equal((await fetch(origin + '/persons.js')).status, 200);
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Administración',
    password,
    inviteCode: code,
  });
  const agent = await call('/api/auth/register', '', { username: 'asesor', name: 'Asesora GlobalVet', password });
  const inv = await call(
    '/api/team/invites',
    admin.cookie,
    { username: 'asesor', brandIds: ['globalvet'] },
    'POST',
    201,
  );
  await call('/api/team/accept', agent.cookie, { token: inv.token });
  const ana = await call('/api/auth/register', '', { username: 'ana', name: 'Ana Pérez', password });

  // la misma clienta escribe a dos marcas: dos contactos, una persona
  const cGv = (await call('/api/conversations', ana.cookie, { courseId: 'aves', channel: 'whatsapp' })).conversation;
  const cOd = (await call('/api/conversations', ana.cookie, { courseId: 'odontologia', channel: 'instagram' }))
    .conversation;
  await call('/api/persons', ana.cookie, undefined, 'GET', 403);
  const all = (await call('/api/persons?brand=all', admin.cookie)).persons;
  assert.equal(all.length, 1);
  const p = all[0];
  assert.equal(p.name, 'Ana Pérez');
  assert.equal(p.profile, true);
  assert.deepEqual(p.brands.map(b => b.id).sort(), ['globalvet', 'odonteck']);
  assert.equal(p.otherBrands, 0);
  assert.equal(p.opportunities, 2);
  // la asesora de GlobalVet ve la persona, pero sólo su marca
  const mine = (await call('/api/persons?brand=all', agent.cookie)).persons;
  assert.equal(mine.length, 1);
  assert.deepEqual(
    mine[0].brands.map(b => b.id),
    ['globalvet'],
  );
  assert.equal(mine[0].otherBrands, 1);
  assert.equal(mine[0].opportunities, 1);
  const dAgent = await call('/api/persons/' + p.id, agent.cookie),
    gvContact = dAgent.contacts[0];
  assert.equal(dAgent.contacts.length, 1);
  assert.equal(dAgent.opportunities.length, 1);
  assert.equal(dAgent.identities.find(i => i.kind === 'profile').value, 'perfil del laboratorio');
  assert.deepEqual(dAgent.candidates, []);
  const dAdmin = await call('/api/persons/' + p.id, admin.cookie);
  assert.equal(dAdmin.contacts.length, 2);
  assert.equal(dAdmin.opportunities.length, 2);
  assert.equal(
    (await call('/api/crm/contacts/' + dAdmin.contacts[0].id, admin.cookie)).contact.persona_id,
    p.id,
    'la ficha del contacto enlaza a la persona',
  );
  assert.equal((await call('/api/persons?brand=all&q=perez', agent.cookie)).persons.length, 1);
  assert.equal((await call('/api/persons?brand=all&q=nadie', agent.cookie)).persons.length, 0);

  // edición de la persona: sólo administración o quien tiene acceso a todas sus marcas; teléfono normalizado; un teléfono de otra persona no se roba
  await call(
    '/api/persons/' + p.id,
    agent.cookie,
    { phone: '55 1234 5678', expectedRevision: p.revision },
    'PATCH',
    403,
  );
  assert.equal(dAgent.person.canEdit, false);
  assert.equal(dAdmin.person.canEdit, true);
  await call('/api/persons/' + p.id, admin.cookie, { phone: '12', expectedRevision: p.revision }, 'PATCH', 400);
  await call('/api/persons/' + p.id, admin.cookie, { phone: '55 1234 5678', expectedRevision: 99 }, 'PATCH', 409);
  const edited = (
    await call(
      '/api/persons/' + p.id,
      admin.cookie,
      { phone: '55 1234 5678', email: 'Ana@Mail.com', expectedRevision: p.revision },
      'PATCH',
    )
  ).person;
  assert.equal(edited.phone, '+525512345678');
  assert.equal(edited.email, 'ana@mail.com');
  // un contacto manual en Dermalysse con el mismo teléfono se une solo a la persona
  const manual = (
    await call(
      '/api/crm/contacts',
      admin.cookie,
      { brandId: 'dermalysse', name: 'Ana P', phone: '+52 55 1234 5678' },
      'POST',
      201,
    )
  ).id;
  assert.equal(
    (await call('/api/crm/contacts/' + manual, admin.cookie)).contact.persona_id,
    p.id,
    'mismo teléfono → misma persona',
  );
  assert.equal((await call('/api/persons?brand=all', admin.cookie)).persons[0].brands.length, 3);
  // la asesora de GlobalVet no ve teléfono, correo ni identidades que sólo respaldan otras marcas; sí el perfil (su contacto lo tiene)
  const redacted = await call('/api/persons/' + p.id, agent.cookie);
  assert.equal(redacted.person.phone, '');
  assert.equal(redacted.person.email, '');
  assert.deepEqual(
    redacted.identities.map(i => i.kind),
    ['profile'],
  );
  assert.equal((await call('/api/persons?brand=all', agent.cookie)).persons[0].phone, '');
  assert.equal((await call('/api/persons/' + p.id, admin.cookie)).person.phone, '+525512345678');
  assert.equal((await call('/api/persons?brand=all&q=1234', admin.cookie)).persons.length, 1);
  assert.equal(
    (await call('/api/persons?brand=all&q=1234', agent.cookie)).persons.length,
    0,
    'la búsqueda no sondea teléfonos de otras marcas',
  );
  assert.equal((await call('/api/persons?brand=all&q=Ana', agent.cookie)).persons.length, 1);
  // mismo nombre completo en otra persona: candidatura para revisar, no unión automática
  const homonimo = (
    await call(
      '/api/crm/contacts',
      admin.cookie,
      { brandId: 'globalvet', name: 'Ana Pérez', phone: '5599887766' },
      'POST',
      201,
    )
  ).id;
  const other = (await call('/api/crm/contacts/' + homonimo, admin.cookie)).contact.persona_id;
  assert.notEqual(other, p.id);
  await call('/api/persons/candidates', agent.cookie, undefined, 'GET', 403);
  const cands = (await call('/api/persons/candidates', admin.cookie)).candidates;
  assert.equal(cands.length, 1);
  assert.equal(cands[0].reason, 'name');
  // otra persona intenta registrar el correo de Ana → conflicto de identidad para revisar
  const conflicto = (
    await call(
      '/api/crm/contacts',
      admin.cookie,
      { brandId: 'odonteck', name: 'Anita Perez Lopez', email: 'ana@mail.com' },
      'POST',
      201,
    )
  ).id;
  assert.equal(
    (await call('/api/crm/contacts/' + conflicto, admin.cookie)).contact.persona_id,
    p.id,
    'mismo correo → misma persona aunque el nombre difiera',
  );

  // consentimiento a nivel persona: la baja por mensaje en una marca aplica a todas
  await call(msgs(cGv.id), ana.cookie, { text: 'BAJA', clientRef: randomUUID() }, 'POST', 201);
  const after = await until(async () => {
    const d = await call('/api/persons/' + p.id, admin.cookie);
    return d.consent.status === 'opted_out' ? d : null;
  });
  assert.ok(after, 'la baja llega a la persona');
  assert.equal(after.consent.source, 'customer_message');
  for (const c of after.contacts)
    assert.equal(
      (await call('/api/crm/contacts/' + c.id + '/consent', admin.cookie)).consent.status,
      'opted_out',
      'proyectada a ' + c.brand_name,
    );
  assert.ok(
    after.consentHistory.some(h => h.brand_name === 'GlobalVet'),
    'el historial recuerda la marca donde se registró',
  );
  assert.equal(
    (await call('/api/events?brand=odonteck&type=baja.registrada', admin.cookie)).events.length,
    1,
    'evento por cada marca de la persona',
  );
  await call(
    '/api/persons/' + p.id + '/consent',
    agent.cookie,
    { status: 'opted_in', note: 'Quiere volver' },
    'PUT',
    403,
  ); // reactivar sólo administración
  await call('/api/persons/' + p.id + '/consent', admin.cookie, { status: 'opted_in', note: 'ok' }, 'PUT', 400);
  assert.equal(
    (
      await call(
        '/api/persons/' + p.id + '/consent',
        admin.cookie,
        { status: 'opted_in', note: 'Escribió para volver a recibir avisos' },
        'PUT',
      )
    ).consent.status,
    'opted_in',
  );
  assert.equal((await call('/api/crm/contacts/' + manual + '/consent', admin.cookie)).consent.status, 'opted_in');
  // y al revés: registrar consentimiento desde un contacto actualiza la persona
  await call(
    '/api/crm/contacts/' + manual + '/consent',
    admin.cookie,
    { status: 'opted_out', note: 'Baja desde Dermalysse' },
    'PUT',
  );
  assert.equal((await call('/api/persons/' + p.id, admin.cookie)).consent.status, 'opted_out');
  // la asesora de GlobalVet ve que la persona está de baja, pero no la nota, la marca ni quién lo registró desde Dermalysse
  const seen = await call('/api/persons/' + p.id, agent.cookie);
  assert.equal(seen.consent.status, 'opted_out');
  assert.equal(seen.consent.note, '');
  assert.equal(seen.consent.redacted, true);
  assert.ok(!JSON.stringify(seen).includes('Baja desde Dermalysse'));
  assert.ok(seen.consentHistory.some(h => h.redacted && h.brand_name === null));
  assert.ok(
    seen.consentHistory.some(h => h.brand_name === 'GlobalVet' && !h.redacted),
    'lo registrado en su marca sí se ve completo',
  );
  assert.ok(
    JSON.stringify(await call('/api/persons/' + p.id, admin.cookie)).includes('Baja desde Dermalysse'),
    'administración ve todo',
  );
  const gvConsent = await call('/api/crm/contacts/' + gvContact.id + '/consent', agent.cookie);
  assert.equal(gvConsent.consent.status, 'opted_out');
  assert.equal(gvConsent.consent.source, 'person');
  assert.ok(
    !JSON.stringify(gvConsent).includes('Dermalysse'),
    'el contacto de GlobalVet recibe el estado, no la nota de otra marca',
  );
  assert.equal(gvConsent.consent.actor_id, null);
  assert.equal(
    (await call('/api/crm/contacts/' + manual + '/consent', admin.cookie)).consent.note,
    'Baja desde Dermalysse',
    'la marca de origen conserva la nota',
  );
  const same = (
    await call('/api/persons/' + p.id + '/consent', agent.cookie, { status: 'opted_out', note: 'ya estaba' }, 'PUT')
  ).consent;
  assert.equal(same.unchanged, true);
  assert.equal(same.note, '');
  assert.equal(same.redacted, true, 'registrar sin cambio tampoco revela la nota de otra marca');
  await call(
    '/api/persons/' + p.id + '/consent',
    admin.cookie,
    { status: 'opted_in', note: 'Reactivada para la prueba de fusión' },
    'PUT',
  );

  // fusión de personas (homónima → Ana): vista previa, token, permisos, resultado
  await call('/api/persons/merge-preview', agent.cookie, { keepId: p.id, mergeId: other }, 'POST', 403);
  const bad = (await call('/api/persons/merge-preview', admin.cookie, { keepId: other, mergeId: p.id }, 'POST')).plan;
  assert.equal(bad.canMerge, false);
  assert.match(bad.problems[0], /perfil del laboratorio/);
  const plan = (await call('/api/persons/merge-preview', admin.cookie, { keepId: p.id, mergeId: other }, 'POST')).plan;
  assert.equal(
    plan.canMerge,
    false,
    'ambas tienen contacto en GlobalVet: primero se fusionan los contactos de la marca',
  );
  assert.match(plan.problems[0], /GlobalVet/);
  // se fusionan los dos contactos de GlobalVet (flujo existente) y la persona huérfana desaparece
  const gvContacts = (await call('/api/persons/' + p.id, admin.cookie)).contacts.filter(
    c => c.brand_id === 'globalvet',
  );
  assert.equal(gvContacts.length, 1);
  const prev = (
    await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: gvContacts[0].id, mergeId: homonimo }, 'POST')
  ).plan;
  assert.equal(prev.canMerge, true);
  await call('/api/crm/contacts/merge', admin.cookie, {
    keepId: gvContacts[0].id,
    mergeId: homonimo,
    previewToken: prev.previewToken,
  });
  await call('/api/persons/' + other, admin.cookie, undefined, 'GET', 404);
  assert.equal(
    (await call('/api/persons/candidates', admin.cookie)).candidates.length,
    0,
    'la candidatura desaparece con la persona',
  );
  assert.equal((await call('/api/persons/' + p.id, admin.cookie)).person.phone, '+525512345678');
  // fusión directa de personas: dos contactos manuales sin identidad común, en marcas distintas
  const x1 = (
      await call(
        '/api/crm/contacts',
        admin.cookie,
        { brandId: 'globalvet', name: 'Carlos Ruiz', phone: '5511112222' },
        'POST',
        201,
      )
    ).id,
    x2 = (
      await call(
        '/api/crm/contacts',
        admin.cookie,
        { brandId: 'dermalysse', name: 'Carlos Ruiz', email: 'carlos@mail.com' },
        'POST',
        201,
      )
    ).id;
  const pa = (await call('/api/crm/contacts/' + x1, admin.cookie)).contact.persona_id,
    pb = (await call('/api/crm/contacts/' + x2, admin.cookie)).contact.persona_id;
  assert.notEqual(pa, pb);
  const cand = (await call('/api/persons/candidates', admin.cookie)).candidates;
  assert.equal(cand.length, 1);
  assert.equal(cand[0].reason, 'name');
  await call(
    '/api/crm/contacts/' + x1 + '/consent',
    admin.cookie,
    { status: 'opted_out', note: 'Carlos pidió la baja' },
    'PUT',
  ); // la persona conservada está de baja
  const pl = (await call('/api/persons/merge-preview', admin.cookie, { keepId: pa, mergeId: pb }, 'POST')).plan;
  assert.equal(pl.canMerge, true);
  assert.equal(pl.moves.contacts, 1);
  assert.equal(pl.moves.fill.email, true);
  assert.equal(pl.moves.consent, null);
  await call('/api/persons/merge', admin.cookie, { keepId: pa, mergeId: pb, previewToken: 'viejo' }, 'POST', 409);
  const merged = await call('/api/persons/merge', admin.cookie, {
    keepId: pa,
    mergeId: pb,
    previewToken: pl.previewToken,
  });
  assert.equal(merged.keepId, pa);
  const carlosOther = await call('/api/crm/contacts/' + x2 + '/consent', admin.cookie);
  assert.equal(carlosOther.consent.source, 'person');
  assert.ok(
    !carlosOther.consent.note.includes('Carlos pidió'),
    'la nota de la marca de origen no viaja a la otra marca',
  );
  const carlos = await call('/api/persons/' + pa, admin.cookie);
  assert.equal(carlos.contacts.length, 2);
  assert.equal(carlos.person.email, 'carlos@mail.com');
  assert.equal(carlos.person.phone, '+525511112222');
  assert.equal(
    (await call('/api/crm/contacts/' + x2 + '/consent', admin.cookie)).consent.status,
    'opted_out',
    'el contacto que llega hereda la baja de la persona conservada',
  );
  assert.equal((await call('/api/persons/candidates', admin.cookie)).candidates.length, 0);
  assert.equal(
    (await call('/api/events?brand=all&type=persona.fusionada', admin.cookie)).events.length,
    2,
    'un evento por marca de la persona conservada',
  );
  // descartar una candidatura
  const y1 = (await call('/api/crm/contacts', admin.cookie, { brandId: 'globalvet', name: 'Pedro Luna' }, 'POST', 201))
    .id;
  await call('/api/crm/contacts', admin.cookie, { brandId: 'odonteck', name: 'Pedro Luna' }, 'POST', 201);
  const c2 = (await call('/api/persons/candidates', admin.cookie)).candidates;
  assert.equal(c2.length, 1);
  await call('/api/persons/candidates/' + c2[0].id + '/dismiss', admin.cookie, {});
  assert.equal((await call('/api/persons/candidates', admin.cookie)).candidates.length, 0);
  await call('/api/persons/candidates/' + c2[0].id + '/dismiss', admin.cookie, {}, 'POST', 404);
  // exportación con identificador de persona
  const csv = await (
    await fetch(origin + '/api/crm/export/contacts.csv?brand=globalvet', {
      headers: { Cookie: admin.cookie, Origin: origin },
    })
  ).text();
  assert.match(csv.split('\r\n')[0], /,persona$/);
  assert.ok(csv.split('\r\n').some(l => l.startsWith('GlobalVet,Ana Pérez') && l.endsWith(',' + p.id)));
  const d = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    assertSchemaCurrent(d);
    assert.equal(
      d.prepare('SELECT count(*) n FROM contacts WHERE persona_id IS NULL').get().n,
      0,
      'todo contacto cuelga de una persona',
    );
    assert.equal(d.prepare('SELECT count(*) n FROM person_merges').get().n, 2);
  } finally {
    d.close();
  }
  void y1;
});
