// Revisión de seguridad del alta de catálogo por el conector (docs/PLAN_MCP_CLAUDE.md, «Dar de alta el catálogo de una
// consultora» → «Revisión de seguridad»). Una prueba por punto: (1) temario y bienvenida completos en la tarjeta;
// (2) no se descarta un borrador a medio dar de alta; (3) una llave no archiva la imagen en borrador de otra;
// (4) crear un borrador no revela los títulos de otra conexión, y el choque se resuelve al aprobar; (5) el límite de
// subidas por IP sólo cuenta con una ficha abierta; (6) los avisos de un retiro se recalculan al aprobar y uno nuevo lo
// detiene, igual que un problema nuevo; (7) tope de bytes por marca y día; y los caracteres de control y de dirección
// del texto fuera de lo que se publica. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftRow } from '../server/lib/course-draft-rules.mjs';
import { UPLOAD_LIMITS } from '../server/modules/mcp-uploads/module.mjs';
import { ACTIONS } from '../server/modules/mcp-proposals/actions.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin } from './helpers/crm.mjs';

const FAIL_MARK = '[falla-imagen]';
const ref = () => 'mcp-rev-' + randomUUID();
const png = tag =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('imagen-' + tag + '-' + randomUUID()),
  ]);
const ch = code => String.fromCharCode(code);

test('borrador: sin caracteres de control ni de dirección del texto en lo que se publica', () => {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const row = draftRow(
    {
      titulo: ch(0x202e) + 'Curso' + ch(0x07) + '\nde prueba' + ch(0x200f),
      temario: 'Tema 1\r\nTema 2' + ch(0x2066) + ch(0x00) + '\n\tTema 3' + ch(0x85),
      bienvenida: 'Hola' + ch(0x202d) + '\nbienvenida' + ch(0x1b),
      apertura: {
        nombre: 'Enero' + ch(0x0b) + ' 2027' + ch(0x061c),
        docente: ch(0x202a) + 'Docente' + ch(0x0c),
        lugar: 'Aula\n1' + ch(0x2069),
      },
    },
    null,
    { zoneDefault: 'America/Mexico_City', fail },
  );
  assert.equal(row.title, 'Curso de prueba');
  assert.equal(row.syllabus, 'Tema 1\nTema 2\n Tema 3');
  assert.equal(row.welcome, 'Hola\nbienvenida');
  assert.equal(row.edition_name, 'Enero 2027');
  assert.equal(row.instructor, 'Docente');
  assert.equal(row.location, 'Aula 1');
  // el lote: archivar un curso no entra en «Seleccionar todas» y sus avisos se confirman al aprobar
  assert.equal(ACTIONS.archivar_curso.selectAll, false);
  assert.equal(ACTIONS.archivar_curso.confirmWarnings, true);
  assert.equal(UPLOAD_LIMITS.bytesPerBrandPerDay, 100 * 1024 * 1024);
});

test('revisión de seguridad del alta de catálogo: siete puntos de punta a punta', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-catalogo-rev-'));
  const code = randomUUID();
  const server = await startServer({
    dir,
    env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '', MCP_TEST_FAIL_FLYER_TITLE: FAIL_MARK },
  });
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
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const approver = await register('aprobadora-rev', 'Aprobadora de prueba');
  db.prepare("UPDATE users SET role='admin' WHERE username='aprobadora-rev'").run();
  const customer = await register('cliente-rev', 'Cliente de prueba');
  const keyFor = async (brandId, scopes = ['config_drafts', 'proposals']) => {
    const name = 'Claude ' + randomUUID().slice(0, 8);
    const made = await api('/api/integrations/keys', { body: { brandId, name, scopes }, expected: 201 });
    return { token: made.token, id: db.prepare('SELECT id FROM api_keys WHERE name=?').get(name).id };
  };
  let rid = 0;
  const tool = async (token, name, args = {}) => {
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
    });
    const out = await r.json();
    if (out.error) return { rpcError: out.error.message };
    return out.result.isError ? { error: out.result.content[0].text } : JSON.parse(out.result.content[0].text);
  };
  const ok = async (...a) => {
    const r = await tool(...a);
    assert.equal(r.error, undefined, a[1] + ': ' + r.error);
    return r;
  };
  const upload = async (url, bytes) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes });
    return { status: r.status, body: await r.json() };
  };
  const decide = (id, expected = 200, body = {}) =>
    fetch(origin + `/api/mcp-proposals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: approver, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => {
      const out = await r.json();
      assert.equal(r.status, expected, `approve ${id}: ${JSON.stringify(out)}`);
      return out;
    });
  const cardOf = async id =>
    (await call(origin, '/api/mcp-proposals', { cookie: approver })).pending.find(p => p.id === id);
  const gv = await keyFor('globalvet');
  const gv2 = await keyFor('globalvet');
  const od = await keyFor('odonteck');
  const draft = async (token, title, extra = {}) =>
    ok(token, 'crear_curso_borrador', {
      titulo: title,
      temario: 'Tema de prueba',
      apertura: { nombre: 'Marzo 2027', inicio: '2027-03-10 18:00', docente: 'Docente', precio: 700 },
      clientRef: ref(),
      ...extra,
    });

  // Cada punto en su propia subprueba: si uno falla, los demás se siguen comprobando.
  let L = null;
  let ed = null;
  await t.test('(5) el límite de subidas por IP sólo cuenta con una ficha abierta', async () => {
    const used = await ok(gv.token, 'preparar_subida_imagen', {
      cursoBorradorId: (await draft(gv.token, 'Curso para la ficha usada')).cursoBorradorId,
    });
    assert.equal((await upload(used.direccion, png('u'))).status, 201);
    const expired = await ok(gv.token, 'preparar_subida_imagen', {
      cursoBorradorId: (await draft(gv.token, 'Curso para la ficha vencida')).cursoBorradorId,
    });
    db.prepare("UPDATE mcp_upload_tokens SET expires_at=? WHERE status='open'").run(Date.now() - 1000);
    // inexistente, usada y vencida: la misma respuesta
    const bad = [
      await upload(origin + '/subida-imagen/tci_' + 'B'.repeat(43), png('x')),
      await upload(used.direccion, png('x')),
      await upload(expired.direccion, png('x')),
    ];
    for (const r of bad) assert.deepEqual(r, bad[0]);
    assert.equal(bad[0].status, 404);
    // alguien sin ficha agota su propio límite (fichas malas)…
    let tooMany = 0;
    for (let i = 0; i < UPLOAD_LIMITS.uploadsPerMinutePerIp; i++)
      if ((await upload(origin + '/subida-imagen/tci_' + String(i).padStart(43, 'C'), png('y'))).status === 429)
        tooMany += 1;
    assert.ok(tooMany > 0, 'las fichas malas tienen su propio límite');
    // …pero no el de quien sí tiene una ficha abierta (desde la misma IP)
    const fresh = await ok(gv.token, 'preparar_subida_imagen', {
      cursoBorradorId: (await draft(gv.token, 'Curso para la ficha buena')).cursoBorradorId,
    });
    const good = await upload(fresh.direccion, png('ok'));
    assert.equal(good.status, 201, JSON.stringify(good.body));
  });
  await t.test('(1) temario y bienvenida completos en la tarjeta (alta y publicar apertura)', async () => {
    const longSyllabus =
      Array.from({ length: 60 }, (_, i) => `Tema largo ${i + 1} de prueba`).join('\n') + '\nFIN-TEMARIO';
    const longWelcome = 'Hola, {{nombre}}. ' + 'Bienvenida larga de prueba. '.repeat(40) + 'FIN-BIENVENIDA';
    assert.ok(longSyllabus.length > 300 && longWelcome.length > 300);
    L = await draft(gv.token, 'Curso con temario largo', { temario: longSyllabus, bienvenida: longWelcome });
    const pL = await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: L.cursoBorradorId });
    const cardL = await cardOf(pL.propuestaId);
    const sendsL = Object.fromEntries(cardL.sends.items.map(i => [i.label, i.value]));
    const course = (
      await api('/api/catalogue/courses', {
        body: { brandId: 'globalvet', title: 'Curso de una persona con temario largo', syllabus: longSyllabus },
        expected: 201,
      })
    ).item;
    ed = db.prepare("SELECT * FROM editions WHERE course_id=? AND status='draft'").get(course.id);
    await ok(gv.token, 'actualizar_apertura_borrador', {
      aperturaId: ed.id,
      revision: ed.revision,
      nombre: 'Mayo 2027',
      inicio: '2027-05-05 18:00',
      precio: 600,
    });
    const pPub = await ok(gv.token, 'proponer_accion', { accion: 'publicar_apertura', id: ed.id });
    const pubDetail = Object.fromEntries((await cardOf(pPub.propuestaId)).details.map(d => [d.label, d.value]));
    assert.equal(pubDetail.Temario, longSyllabus);
    assert.equal(sendsL.Temario, longSyllabus, 'el temario completo, sin recortar');
    assert.equal(sendsL.Bienvenida, longWelcome.trim(), 'la bienvenida completa');
  });
  await t.test('(2) no se descarta un borrador a medio dar de alta', async () => {
    const H = await draft(gv.token, 'Curso a medias ' + FAIL_MARK);
    const hImg = await ok(gv.token, 'preparar_subida_imagen', { cursoBorradorId: H.cursoBorradorId });
    assert.equal((await upload(hImg.direccion, png('h'))).status, 201);
    const pH = await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: H.cursoBorradorId });
    assert.equal((await decide(pH.propuestaId, 409)).code, 'proposal_failed');
    const hNow = (await ok(gv.token, 'listar_cursos_borrador')).cursos.find(
      c => c.cursoBorradorId === H.cursoBorradorId,
    );
    const refused = await tool(gv.token, 'descartar_curso_borrador', {
      cursoBorradorId: H.cursoBorradorId,
      revision: hNow.revision,
    });
    assert.match(refused.error, /No se descarta: en un intento anterior ya quedó hecho en el catálogo: curso creado/);
    assert.equal(db.prepare('SELECT status FROM mcp_course_drafts WHERE id=?').get(H.cursoBorradorId).status, 'draft');
  });
  await t.test('(3) una llave no archiva la imagen en borrador que subió otra a la misma apertura', async () => {
    const prep1 = await ok(gv.token, 'preparar_subida_imagen', { aperturaId: ed.id });
    const up1 = await upload(prep1.direccion, png('k1'));
    assert.equal(up1.status, 201);
    const p1 = await ok(gv.token, 'proponer_accion', { accion: 'aprobar_imagen', id: up1.body.imagenId });
    const prep2 = await ok(gv2.token, 'preparar_subida_imagen', { aperturaId: ed.id });
    const up2 = await upload(prep2.direccion, png('k2'));
    assert.equal(up2.status, 201);
    assert.equal(up2.body.sustituyoBorradoresAnteriores, 0, 'la de otra llave no se sustituye');
    assert.equal(db.prepare('SELECT status FROM flyers WHERE id=?').get(up1.body.imagenId).status, 'draft');
    assert.equal(db.prepare('SELECT status FROM mcp_proposals WHERE id=?').get(p1.propuestaId).status, 'pending');
    // la del mismo origen sí se sustituye
    const up3 = await upload(
      (await ok(gv2.token, 'preparar_subida_imagen', { aperturaId: ed.id })).direccion,
      png('k3'),
    );
    assert.equal(up3.body.sustituyoBorradoresAnteriores, 1);
    assert.equal(db.prepare('SELECT status FROM flyers WHERE id=?').get(up2.body.imagenId).status, 'archived');
    assert.equal(db.prepare('SELECT status FROM flyers WHERE id=?').get(up1.body.imagenId).status, 'draft');
  });
  await t.test('(4) no se revelan los títulos de otra conexión; el choque se resuelve al aprobar', async () => {
    const mine = await draft(gv.token, 'Curso con título compartido');
    assert.match(
      (await tool(gv.token, 'crear_curso_borrador', { titulo: 'curso con TÍTULO compartido', clientRef: ref() })).error,
      /un borrador tuyo/,
      'del mismo origen sí se rechaza',
    );
    const theirs = await draft(gv2.token, 'Curso con título compartido');
    assert.equal(theirs.estado, 'draft', 'otra conexión puede usar el título sin saber del borrador ajeno');
    assert.equal(
      theirs.loQueFalta.some(m => /título/.test(m)),
      false,
    );
    const pMine = await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: mine.cursoBorradorId });
    await decide(pMine.propuestaId);
    const clash = await tool(gv2.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: theirs.cursoBorradorId });
    assert.match(clash.error, /Ya hay un curso de la marca con ese título/);
    assert.equal(db.prepare("SELECT count(*) n FROM courses WHERE title='Curso con título compartido'").get().n, 1);
  });
  await t.test('(6) los avisos de un retiro se recalculan al aprobar', async () => {
    const arch = (
      await api('/api/catalogue/courses', {
        body: { brandId: 'globalvet', title: 'Curso para archivar con avisos', syllabus: 'Tema' },
        expected: 201,
      })
    ).item;
    const aEd = db.prepare("SELECT * FROM editions WHERE course_id=? AND status='draft'").get(arch.id);
    await api('/api/catalogue/editions/' + aEd.id, {
      method: 'PATCH',
      body: {
        name: 'Junio 2027',
        startsAt: Date.parse('2027-06-01T18:00:00Z'),
        endsAt: null,
        timezone: 'America/Mexico_City',
        instructor: '',
        modality: 'online',
        location: '',
        infoUrl: '',
        capacity: null,
        availableSeats: null,
        price: 500,
        sessionPrice: null,
        currency: 'MXN',
        status: 'published',
        expectedRevision: aEd.revision,
      },
    });
    const pArch = await ok(gv.token, 'proponer_accion', { accion: 'archivar_curso', id: arch.id });
    const seenCard = await cardOf(pArch.propuestaId);
    assert.equal(seenCard.selectAll, false, '«Seleccionar todas» no lo incluye');
    assert.ok(seenCard.warnings.some(w => /apertura publicada/.test(w)));
    assert.equal(
      seenCard.warnings.some(w => /conversación abierta/.test(w)),
      false,
    );
    // después de verla, alguien abre una conversación del curso: aparece un aviso nuevo
    await call(origin, '/api/conversations', { cookie: customer, body: { courseId: arch.id, channel: 'whatsapp' } });
    const changed = await decide(pArch.propuestaId, 409, { warningsSeen: seenCard.warnings });
    assert.equal(changed.code, 'warnings_changed');
    assert.match(changed.error, /una conversación abierta/);
    assert.equal(db.prepare('SELECT active FROM courses WHERE id=?').get(arch.id).active, 1, 'no se ejecutó');
    assert.equal(db.prepare('SELECT status FROM mcp_proposals WHERE id=?').get(pArch.propuestaId).status, 'pending');
    // un problema que aparece después (curso por omisión de un número) tampoco deja aprobar
    db.prepare(
      "INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,created_at,updated_at) VALUES('pn-rev','globalvet',?,'Número de prueba',1,1)",
    ).run(arch.id);
    assert.equal((await decide(pArch.propuestaId, 409, { warningsSeen: [] })).code, 'not_ready');
    db.prepare("DELETE FROM wa_numbers WHERE phone_number_id='pn-rev'").run();
    // con los avisos de hoy vistos, se aprueba
    const nowCard = await cardOf(pArch.propuestaId);
    await decide(pArch.propuestaId, 200, { warningsSeen: nowCard.warnings });
    assert.equal(db.prepare('SELECT active FROM courses WHERE id=?').get(arch.id).active, 0);
  });
  await t.test('(7) tope de bytes por marca y día', async () => {
    const odDraft = await draft(od.token, 'Curso de odonteck para el tope');
    const prepOd = await ok(od.token, 'preparar_subida_imagen', { cursoBorradorId: odDraft.cursoBorradorId });
    const big = randomUUID();
    db.prepare(
      "INSERT INTO library_files(id,brand_id,filename,mime,size,storage_name,created_at) VALUES(?,'odonteck','relleno.png','image/png',?,'no-existe.png',?)",
    ).run(big, UPLOAD_LIMITS.bytesPerBrandPerDay - 10, Date.now());
    db.prepare(
      `INSERT INTO mcp_upload_tokens(id,brand_id,course_draft_id,token_hash,source_kind,source_id,created_by,status,file_id,
         created_at,expires_at,used_at) VALUES(?,'odonteck',?,?,'key',?,?,'done',?,?,?,?)`,
    ).run(
      randomUUID(),
      odDraft.cursoBorradorId,
      'relleno-' + randomUUID(),
      od.id,
      db.prepare("SELECT id FROM users WHERE username='admin'").get().id,
      big,
      Date.now(),
      Date.now(),
      Date.now(),
    );
    const capped = await upload(prepOd.direccion, png('tope'));
    assert.equal(capped.status, 429);
    assert.match(capped.body.error, /100 MB de imágenes hoy/);
    // la otra marca no se ve afectada
    const gvAgain = await ok(gv.token, 'preparar_subida_imagen', { cursoBorradorId: L.cursoBorradorId });
    assert.equal((await upload(gvAgain.direccion, png('gv'))).status, 201);
  });
});
