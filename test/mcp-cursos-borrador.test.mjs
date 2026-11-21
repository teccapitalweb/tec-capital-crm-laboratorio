// Dar de alta un curso nuevo por el conector (docs/PLAN_MCP_CLAUDE.md, «Dar de alta un curso»). El curso vive como
// BORRADOR del conector (mcp_course_drafts) y no entra al catálogo hasta que una persona aprueba «dar_de_alta_curso».
// Se comprueba: herramientas y validación con las reglas del alta; idempotencia; título repetido; otra marca u otro
// origen no lo ven ni lo tocan; un borrador no aparece en el catálogo del equipo, en lo que ve un cliente ni en la lista
// de cursos del asistente; imagen ligada al borrador (sin flyer) y su sustitución; la propuesta con todo lo que se
// creará y su miniatura; obsolescencia; permisos de quien aprueba; el alta de punta a punta a nombre de quien aprueba;
// el alta a medias (falla la imagen) y su reintento sin duplicar; descartar; y tres borradores con imagen aprobados en
// el orden del lote que se ofrecen con su imagen. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftReview, draftRow, titleKey } from '../server/lib/course-draft-rules.mjs';
import { ACTIONS } from '../server/modules/mcp-proposals/actions.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin } from './helpers/crm.mjs';

const FAIL_MARK = '[falla-imagen]';
const ref = () => 'mcp-curso-' + randomUUID();
const png = tag =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('imagen-de-curso-' + tag + '-' + randomUUID()),
  ]);
const fail = (status, message) => Object.assign(new Error(message), { status });

test('reglas del borrador de curso: forma, lo que falta y avisos', () => {
  const opts = { zoneDefault: 'America/Mexico_City', fail };
  const row = draftRow({ titulo: '  Curso  ', apertura: { inicio: '2027-02-01 19:00', precio: 10.5 } }, null, opts);
  assert.equal(row.title, 'Curso');
  assert.equal(row.price_cents, 1050);
  assert.equal(row.timezone, 'America/Mexico_City');
  assert.equal(row.modality, 'online');
  for (const [apertura, re] of [
    [{ inicio: 'mañana' }, /El inicio debe verse/],
    [{ zona: 'Marte/Base' }, /Zona horaria no válida/],
    [{ precio: 10.555 }, /dos decimales/],
    [{ precio: 1_000_001 }, /1 000 000/],
    [{ cupo: 0 }, /cupo/],
    [{ enlace: 'ftp://ejemplo.test' }, /https:\/\//],
    [{ inicio: '2027-02-01 19:00', fin: '2027-02-01 18:00' }, /posterior al inicio/],
    [{ moneda: 'ARS' }, /Moneda/],
  ])
    assert.throws(() => draftRow({ titulo: 'Curso', apertura }, null, opts), re, JSON.stringify(apertura));
  const r = draftReview({ ...row, syllabus: '', edition_name: '', file_id: null, instructor: '' }, { now: Date.now() });
  assert.ok(r.missing.some(m => /temario/.test(m)));
  assert.ok(r.missing.some(m => /nombre de la apertura/.test(m)));
  assert.ok(r.warnings.some(w => /No tiene imagen/.test(w)));
  assert.ok(r.warnings.some(w => /No tiene docente/.test(w)));
  const past = draftReview({ ...row, starts_at: Date.now() - 1000 }, { now: Date.now() });
  assert.ok(past.missing.some(m => /El inicio ya pasó/.test(m)));
  assert.equal(titleKey('  Nutrición   AVES '), 'nutricion aves');
  assert.equal(ACTIONS.dar_de_alta_curso.batchOrder, 0);
  assert.equal(ACTIONS.dar_de_alta_curso.sourceBound, true);
  assert.equal(ACTIONS.dar_de_alta_curso.permission, 'course_launch');
});

test('alta de cursos por el conector: borrador, imagen, propuesta, alta, alta a medias y lote', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-cursos-borrador-'));
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
  assertSchemaCurrent(db);
  const api = (path, options = {}) => call(origin, path, { cookie: admin, ...options });
  const register = async (username, name) =>
    (await call(origin, '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const idOf = username => db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
  const approver = await register('aprobadora-alta', 'Aprobadora de prueba');
  db.prepare("UPDATE users SET role='admin' WHERE username='aprobadora-alta'").run();
  const approverId = idOf('aprobadora-alta');
  const agent = await register('asesor-alta', 'Asesor de prueba');
  db.prepare("UPDATE users SET role='agent' WHERE username='asesor-alta'").run();
  db.prepare("INSERT INTO brand_members(user_id,brand_id) VALUES(?,'globalvet')").run(idOf('asesor-alta'));
  const customer = await register('cliente-alta', 'Cliente de prueba');

  const keyFor = async (brandId, scopes) => {
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
  const decide = (cookie, id, expected = 200) =>
    fetch(origin + `/api/mcp-proposals/${id}/approve`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    }).then(async r => {
      const out = await r.json();
      assert.equal(r.status, expected, `approve ${id}: ${JSON.stringify(out)}`);
      return out;
    });
  const customerFlyer = async (courseId, editionId) => {
    const r = await fetch(origin + `/api/courses/${courseId}/flyer?editionId=${editionId}`, {
      headers: { Cookie: customer },
    });
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
  };
  const coursesTitled = title => db.prepare('SELECT * FROM courses WHERE title=?').all(title);

  const ALL = ['config_drafts', 'proposals', 'editions'];
  const gv = await keyFor('globalvet', ALL);
  const gv2 = await keyFor('globalvet', ALL);
  const od = await keyFor('odonteck', ALL);
  const coursesBefore = db.prepare('SELECT count(*) n FROM courses').get().n;
  const flyersBefore = db.prepare('SELECT count(*) n FROM flyers').get().n;

  // ================= crear el borrador: lo que falta, idempotencia y validación
  const refA = ref();
  const a0 = await ok(gv.token, 'crear_curso_borrador', { titulo: 'Curso del conector A', clientRef: refA });
  assert.equal(a0.estado, 'draft');
  assert.equal(a0.duplicado, false);
  assert.equal(a0.listoParaProponer, false);
  for (const re of [/temario/, /nombre de la apertura/, /inicio/, /precio/])
    assert.ok(
      a0.loQueFalta.some(m => re.test(m)),
      re + ' ' + JSON.stringify(a0.loQueFalta),
    );
  const again = await ok(gv.token, 'crear_curso_borrador', { titulo: 'Otro título', clientRef: refA });
  assert.equal(again.duplicado, true);
  assert.equal(again.cursoBorradorId, a0.cursoBorradorId);
  assert.equal(again.titulo, 'Curso del conector A', 'el mismo clientRef devuelve el mismo, sin cambiarlo');
  assert.match(
    (await tool(gv.token, 'crear_curso_borrador', { titulo: 'X1', apertura: { inicio: 'pronto' }, clientRef: ref() }))
      .error,
    /El inicio debe verse/,
  );
  assert.match(
    (await tool(gv.token, 'crear_curso_borrador', { titulo: 'X2', apertura: { cupo: 0 }, clientRef: ref() })).error,
    /fuera del rango/,
  );
  assert.match(
    (await tool(gv.token, 'crear_curso_borrador', { titulo: 'X3', apertura: { extra: 1 }, clientRef: ref() })).error,
    /Dato no reconocido: apertura.extra/,
  );
  // título repetido: con un curso del catálogo (sin importar mayúsculas ni acentos) o con otro borrador vivo
  const existing = db.prepare("SELECT title FROM courses WHERE brand_id='globalvet' AND active=1 LIMIT 1").get().title;
  assert.match(
    (await tool(gv.token, 'crear_curso_borrador', { titulo: existing.toUpperCase(), clientRef: ref() })).error,
    /Ya hay un curso/,
  );
  // del mismo origen, sin importar acentos, mayúsculas ni espacios, se rechaza; desde otro origen no se revela (el
  // choque se resuelve al aprobar: test/mcp-catalogo-revision.test.mjs, punto 4)
  assert.match(
    (await tool(gv.token, 'crear_curso_borrador', { titulo: 'curso  del conector Á', clientRef: ref() })).error,
    /Ya hay un curso de la marca \(o un borrador tuyo\)/,
  );
  assert.equal(
    (await ok(gv2.token, 'crear_curso_borrador', { titulo: 'Curso del conector a (otra conexión)', clientRef: ref() }))
      .estado,
    'draft',
  );
  // completar el borrador
  const A = await ok(gv.token, 'actualizar_curso_borrador', {
    cursoBorradorId: a0.cursoBorradorId,
    revision: a0.revision,
    temario: 'Tema A1 de prueba\nTema A2 de prueba',
    bienvenida: 'Hola, {{nombre}}. Te comparto {{curso}}.',
    apertura: {
      nombre: 'Enero 2027',
      inicio: '2027-01-20 19:00',
      fin: '2027-01-20 21:00',
      zona: 'America/Mexico_City',
      docente: 'Docente de prueba',
      modalidad: 'hybrid',
      lugar: 'Aula de prueba',
      enlace: 'https://ejemplo.test/curso-a',
      cupo: 25,
      precio: 1450.5,
      moneda: 'MXN',
    },
  });
  assert.equal(A.listoParaProponer, true, JSON.stringify(A.loQueFalta));
  assert.equal(A.apertura.inicio, '2027-01-20 19:00');
  assert.ok(A.avisos.some(w => /No tiene imagen/.test(w)));
  assert.match(
    (
      await tool(gv.token, 'actualizar_curso_borrador', {
        cursoBorradorId: A.cursoBorradorId,
        revision: a0.revision,
        titulo: 'Viejo',
      })
    ).error,
    /cambió/,
  );

  // ---- otro origen u otra marca no lo ven ni lo tocan
  assert.equal(
    (await ok(gv2.token, 'listar_cursos_borrador')).cursos.some(c => c.cursoBorradorId === A.cursoBorradorId),
    false,
  );
  assert.ok((await ok(gv.token, 'listar_cursos_borrador')).cursos.some(c => c.cursoBorradorId === A.cursoBorradorId));
  for (const token of [gv2.token, od.token]) {
    assert.match(
      (
        await tool(token, 'actualizar_curso_borrador', {
          cursoBorradorId: A.cursoBorradorId,
          revision: A.revision,
          titulo: 'Robado',
        })
      ).error,
      /no existe/,
    );
    assert.match(
      (await tool(token, 'preparar_subida_imagen', { cursoBorradorId: A.cursoBorradorId })).error,
      /no existe/,
    );
    assert.match(
      (await tool(token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: A.cursoBorradorId })).error,
      /no existe/,
    );
  }

  // ---- un borrador no entra al catálogo: ni el del equipo, ni lo que ve un cliente, ni la lista del asistente
  assert.equal(db.prepare('SELECT count(*) n FROM courses').get().n, coursesBefore);
  assert.equal(
    (await api('/api/catalogue')).courses.some(c => c.title === A.titulo),
    false,
  );
  const boot = await call(origin, '/api/bootstrap', { cookie: customer });
  assert.equal(
    boot.courses.some(c => c.title === A.titulo),
    false,
  );
  assert.equal(
    (await ok(gv.token, 'listar_cursos')).cursos.some(c => c.titulo === A.titulo),
    false,
  );

  // ================= imagen ligada al borrador: archivo en la biblioteca, sin flyer; la segunda sustituye
  assert.match(
    (await tool(gv.token, 'preparar_subida_imagen', { cursoBorradorId: A.cursoBorradorId, aperturaId: 'x' })).error,
    /uno de los dos/,
  );
  const p1 = await ok(gv.token, 'preparar_subida_imagen', { cursoBorradorId: A.cursoBorradorId });
  assert.equal(p1.cursoBorrador.cursoBorradorId, A.cursoBorradorId);
  const u1 = await upload(p1.direccion, png('a1'));
  assert.equal(u1.status, 201, JSON.stringify(u1.body));
  assert.equal(u1.body.cursoBorradorId, A.cursoBorradorId);
  assert.equal(u1.body.revision, A.revision + 1, 'cambiar la imagen sube la revisión');
  const imgA = png('a2');
  const u2 = await upload(
    (await ok(gv.token, 'preparar_subida_imagen', { cursoBorradorId: A.cursoBorradorId })).direccion,
    imgA,
  );
  assert.equal(u2.status, 201);
  assert.equal(u2.body.sustituyoImagenAnterior, 1);
  assert.notEqual(u2.body.archivoId, u1.body.archivoId);
  assert.equal(db.prepare('SELECT count(*) n FROM flyers').get().n, flyersBefore, 'todavía no hay flyer');
  assert.equal(
    db.prepare('SELECT brand_id FROM library_files WHERE id=?').get(u2.body.archivoId).brand_id,
    'globalvet',
  );
  let a = (await ok(gv.token, 'listar_cursos_borrador')).cursos.find(c => c.cursoBorradorId === A.cursoBorradorId);
  assert.equal(a.imagen.archivoId, u2.body.archivoId);
  assert.equal(
    a.avisos.some(w => /No tiene imagen/.test(w)),
    false,
  );

  // ================= proponer: la tarjeta muestra todo lo que se creará y la imagen
  const prop1 = await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: A.cursoBorradorId });
  assert.equal(prop1.estado, 'pending');
  const view = await call(origin, '/api/mcp-proposals', { cookie: approver });
  const card = view.pending.find(p => p.id === prop1.propuestaId);
  assert.equal(card.title, 'Dar de alta el curso');
  assert.equal(card.name, A.titulo);
  assert.equal(card.batchOrder, 0);
  assert.match(card.effect, /PUBLICADA/);
  assert.match(card.effect, /el asistente lo ofrece/);
  const sends = Object.fromEntries(card.sends.items.map(i => [i.label, i.value]));
  assert.equal(sends.Curso, A.titulo);
  assert.match(sends.Temario, /Tema A1 de prueba/);
  assert.equal(sends.Apertura, 'Enero 2027');
  assert.match(sends.Inicio, /2027/);
  assert.match(sends.Inicio, /enero/);
  assert.equal(sends.Modalidad, 'Híbrida');
  assert.equal(sends.Docente, 'Docente de prueba');
  assert.equal(sends.Lugar, 'Aula de prueba');
  assert.match(sends.Precio, /1,450\.50/);
  assert.equal(sends.Cupo, '25');
  assert.equal(card.image.url, '/api/library/files/' + u2.body.archivoId);
  assert.deepEqual(card.problems, []);

  // ---- obsoleta: el borrador cambia después de proponer
  a = (await ok(gv.token, 'listar_cursos_borrador')).cursos.find(c => c.cursoBorradorId === A.cursoBorradorId);
  await ok(gv.token, 'actualizar_curso_borrador', {
    cursoBorradorId: A.cursoBorradorId,
    revision: a.revision,
    apertura: { cupo: 30 },
  });
  assert.equal((await decide(approver, prop1.propuestaId, 409)).code, 'stale_proposal');
  assert.equal(coursesTitled(A.titulo).length, 0, 'obsoleta: no se creó nada');
  const prop2 = await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: A.cursoBorradorId });
  // ---- sin el permiso de la acción no se aprueba
  await decide(agent, prop2.propuestaId, 403);
  assert.equal(coursesTitled(A.titulo).length, 0);

  // ================= el alta: curso activo, apertura publicada con los datos del borrador, imagen vigente
  await decide(approver, prop2.propuestaId);
  const [course] = coursesTitled(A.titulo);
  assert.ok(course, 'el curso se creó');
  assert.equal(course.active, 1);
  assert.equal(course.syllabus, 'Tema A1 de prueba\nTema A2 de prueba');
  const editions = db.prepare('SELECT * FROM editions WHERE course_id=?').all(course.id);
  assert.equal(editions.length, 1, 'reutiliza la apertura inicial del curso');
  const ed = editions[0];
  assert.equal(ed.status, 'published');
  assert.equal(ed.name, 'Enero 2027');
  assert.equal(ed.price_cents, 145050);
  assert.equal(ed.capacity, 30);
  assert.equal(ed.modality, 'hybrid');
  assert.equal(ed.instructor, 'Docente de prueba');
  const flyer = db.prepare('SELECT * FROM flyers WHERE edition_id=?').get(ed.id);
  assert.equal(flyer.status, 'approved');
  assert.equal(flyer.file_id, u2.body.archivoId);
  assert.equal(flyer.approved_by, approverId, 'a nombre de quien aprobó');
  const createdBy = db
    .prepare("SELECT actor_id FROM catalogue_events WHERE entity_kind='course' AND entity_id=? ORDER BY seq LIMIT 1")
    .get(course.id).actor_id;
  assert.equal(createdBy, approverId);
  a = (await ok(gv.token, 'listar_cursos_borrador')).cursos.find(c => c.cursoBorradorId === A.cursoBorradorId);
  assert.equal(a.estado, 'created');
  assert.deepEqual(a.creado, { cursoId: course.id, aperturaId: ed.id, imagenId: flyer.id });
  const boot2 = await call(origin, '/api/bootstrap', { cookie: customer });
  assert.ok(boot2.courses.some(c => c.id === course.id));
  assert.ok(boot2.editions.some(e => e.id === ed.id));
  const seen = await customerFlyer(course.id, ed.id);
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.bytes, imgA, 'el cliente recibe la imagen aprobada');
  // ya dado de alta: no se vuelve a proponer ni a cambiar
  assert.match(
    (await tool(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: A.cursoBorradorId })).error,
    /ya se dio de alta/,
  );

  // ================= alta a medias: falla la imagen; el reintento sigue sin duplicar
  const mk = async (title, n) => {
    const d = await ok(gv.token, 'crear_curso_borrador', {
      titulo: title,
      temario: `Tema ${n} de prueba`,
      apertura: { nombre: 'Febrero 2027', inicio: `2027-02-1${n} 18:00`, docente: 'Docente', precio: 900 + n },
      clientRef: ref(),
    });
    const bytes = png('d' + n);
    const up = await upload(
      (await ok(gv.token, 'preparar_subida_imagen', { cursoBorradorId: d.cursoBorradorId })).direccion,
      bytes,
    );
    assert.equal(up.status, 201);
    return { ...d, bytes };
  };
  const B = await mk('Curso del conector B ' + FAIL_MARK, 1);
  const pb = await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: B.cursoBorradorId });
  const half = await decide(approver, pb.propuestaId, 409);
  assert.equal(half.code, 'proposal_failed');
  assert.match(half.error, /Quedó hecho: crear el curso, publicar la apertura\./);
  assert.match(half.error, /Falta: crear la imagen, aprobar la imagen\./);
  assert.equal(db.prepare('SELECT status FROM mcp_proposals WHERE id=?').get(pb.propuestaId).status, 'failed');
  assert.equal(coursesTitled(B.titulo).length, 1);
  const bRow = db.prepare('SELECT * FROM mcp_course_drafts WHERE id=?').get(B.cursoBorradorId);
  assert.equal(bRow.status, 'draft');
  assert.ok(bRow.course_id && bRow.edition_id && !bRow.flyer_id);
  // un borrador a medio crear no se cambia desde aquí
  assert.match(
    (
      await tool(gv.token, 'actualizar_curso_borrador', {
        cursoBorradorId: B.cursoBorradorId,
        revision: bRow.revision,
        titulo: 'Otro',
      })
    ).error,
    /ya se creó en el catálogo/,
  );
  const pb2 = await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: B.cursoBorradorId });
  assert.ok(
    pb2.avisos.some(w => /Un intento anterior ya creó parte/.test(w)),
    JSON.stringify(pb2.avisos),
  );
  await decide(approver, pb2.propuestaId);
  const bCourses = coursesTitled(B.titulo);
  assert.equal(bCourses.length, 1, 'el reintento no duplica el curso');
  assert.equal(db.prepare('SELECT count(*) n FROM editions WHERE course_id=?').get(bCourses[0].id).n, 1);
  const bFlyers = db.prepare('SELECT * FROM flyers WHERE course_id=?').all(bCourses[0].id);
  assert.equal(bFlyers.length, 1);
  assert.equal(bFlyers[0].status, 'approved');
  assert.equal(db.prepare('SELECT status FROM mcp_course_drafts WHERE id=?').get(B.cursoBorradorId).status, 'created');

  // ================= descartar: la propuesta hecha antes queda obsoleta y no se puede volver a proponer
  const C = await mk('Curso del conector C', 2);
  const pc = await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: C.cursoBorradorId });
  const cNow = (await ok(gv.token, 'listar_cursos_borrador')).cursos.find(c => c.cursoBorradorId === C.cursoBorradorId);
  await ok(gv.token, 'descartar_curso_borrador', { cursoBorradorId: C.cursoBorradorId, revision: cNow.revision });
  assert.equal((await decide(approver, pc.propuestaId, 409)).code, 'stale_proposal');
  assert.match(
    (await tool(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: C.cursoBorradorId })).error,
    /se descartó/,
  );
  assert.equal(coursesTitled(C.titulo).length, 0);

  // ================= tres borradores con imagen → proponer → aprobar en el orden del lote → se ofrecen con su imagen
  const three = [];
  for (const n of [3, 4, 5]) three.push(await mk(`Curso del conector lote ${n}`, n));
  const props = [];
  for (const d of three)
    props.push(await ok(gv.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: d.cursoBorradorId }));
  const queue = (await call(origin, '/api/mcp-proposals', { cookie: approver })).pending
    .filter(p => props.some(x => x.propuestaId === p.id))
    .sort((x, y) => x.batchOrder - y.batchOrder);
  assert.equal(queue.length, 3);
  for (const p of queue) await decide(approver, p.id);
  const boot3 = await call(origin, '/api/bootstrap', { cookie: customer });
  for (const d of three) {
    const [k] = coursesTitled(d.titulo);
    const e = db.prepare('SELECT * FROM editions WHERE course_id=?').get(k.id);
    assert.ok(
      boot3.editions.some(x => x.id === e.id),
      d.titulo + ' se ofrece',
    );
    const img = await customerFlyer(k.id, e.id);
    assert.equal(img.status, 200);
    assert.deepEqual(img.bytes, d.bytes, d.titulo + ' con su imagen');
  }
  assert.ok((await ok(gv.token, 'listar_cursos')).cursos.some(c => c.titulo === three[0].titulo));
});
