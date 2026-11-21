// Dar de alta el catálogo de una consultora por el conector (docs/PLAN_MCP_CLAUDE.md, «Subir la imagen de un curso» y
// «Aprobar por lote»). Se comprueba: la migración de las direcciones de subida sobre una base ya publicada; la lectura
// con tope; la herramienta preparar_subida_imagen (permiso, marca, topes); la subida (feliz, ficha usada dos veces,
// vencida, de otra marca, tipo por bytes mágicos aunque el Content-Type mienta, demasiado grande, origen revocado entre
// preparar y subir, queda en borrador y no se envía, sustituye al borrador anterior del conector, topes); las acciones
// «aprobar_imagen» y «archivar_curso» de punta a punta con los permisos de quien aprueba, obsolescencia y avisos; y el
// recorrido completo: tres cursos → tres imágenes → proponer → aprobar en el orden del lote → los cursos se ofrecen
// con su imagen. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { NAMED, migrate } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { TOOLS } from '../server/mcp.mjs';
import { UPLOAD_TOOLS } from '../server/lib/mcp-uploads.mjs';
import { ACTIONS } from '../server/modules/mcp-proposals/actions.mjs';
import { UPLOAD_LIMITS, UPLOAD_ROUTES, readCapped } from '../server/modules/mcp-uploads/module.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin } from './helpers/crm.mjs';

const MIGRATIONS = ['mcp-uploads/0001-upload-tokens', 'mcp-uploads/0002-course-drafts'];
const ref = () => 'mcp-cat-' + randomUUID();
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = tag => Buffer.concat([Buffer.from(PNG_SIG), Buffer.from('imagen-de-prueba-' + tag + '-' + randomUUID())]);
const jpeg = tag => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-de-prueba-' + tag)]);
const webp = tag =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.from('vp8-' + tag)]);

test('subidas: herramienta, permiso, rutas cerradas y lectura con tope', async () => {
  assert.deepEqual(
    UPLOAD_TOOLS.map(t => t.name),
    [
      'crear_curso_borrador',
      'actualizar_curso_borrador',
      'listar_cursos_borrador',
      'descartar_curso_borrador',
      'preparar_subida_imagen',
    ],
  );
  const tool = UPLOAD_TOOLS.find(t => t.name === 'preparar_subida_imagen');
  for (const t of UPLOAD_TOOLS) assert.equal(t.scope, 'config_drafts');
  assert.equal(tool.scope, 'config_drafts');
  assert.ok(TOOLS.includes(tool));
  // el asistente lee el orden completo en la descripción
  assert.match(tool.description, /crear_curso_borrador.*preparar_subida_imagen.*cursoBorradorId.*dar_de_alta_curso/s);
  assert.match(UPLOAD_TOOLS[0].description, /NO entra al catálogo/);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['aperturaId', 'cursoBorradorId']);
  // la subida sólo toca tres rutas del catálogo: archivo, imagen en borrador y archivar el borrador anterior
  assert.equal(UPLOAD_ROUTES.length, 3);
  for (const [name, method, re] of UPLOAD_ROUTES) {
    assert.equal(name, 'catalogue');
    assert.equal(method, 'POST');
    assert.doesNotMatch(re.source, /approve|editions|courses|templates|promotions/);
  }
  assert.equal(UPLOAD_LIMITS.maxBytes, 4 * 1024 * 1024, 'el mismo tope de la biblioteca del catálogo');
  assert.equal(UPLOAD_LIMITS.tokenMs, 10 * 60_000);
  // la lectura se corta en cuanto pasa del tope: contesta sin esperar el resto del cuerpo
  let pushed = 0;
  const slow = new Readable({
    read() {
      setImmediate(() => this.push(pushed++ < 50 ? Buffer.alloc(600) : null));
    },
  });
  assert.equal(await readCapped(slow, 1000), null);
  assert.ok(pushed < 10, 'no esperó al final: ' + pushed);
  slow.destroy();
  assert.equal((await readCapped(Readable.from([Buffer.from('abc')]), 1000)).toString(), 'abc');
  // las acciones nuevas: cada una con su permiso de borradores, su permiso de quien aprueba y su orden en un lote
  assert.equal(ACTIONS.aprobar_imagen.scope, 'config_drafts');
  assert.equal(ACTIONS.aprobar_imagen.permission, 'content');
  assert.equal(ACTIONS.archivar_curso.permission, 'catalogue');
  assert.ok(ACTIONS.publicar_apertura.batchOrder < ACTIONS.aprobar_imagen.batchOrder);
  assert.ok(ACTIONS.aprobar_imagen.batchOrder < ACTIONS.archivar_curso.batchOrder);
});

test('migración mcp-uploads/0001: sobre una base ya publicada, sin filas y huella única', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-subidas-mig-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => !MIGRATIONS.includes(m.name))) });
  const flyers = db.prepare('SELECT count(*) n FROM flyers').get().n;
  assert.deepEqual(migrate(db, { backup: false }).applied, MIGRATIONS);
  assertSchemaCurrent(db);
  assert.equal(db.prepare('SELECT count(*) n FROM mcp_upload_tokens').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM flyers').get().n, flyers, 'no toca lo que había');
  const edition = db.prepare("SELECT id FROM editions WHERE brand_id='globalvet' LIMIT 1").get().id;
  const user = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,name,role,password_hash,test_number,created_at,last_seen) VALUES(?,?,?,'admin','x',?,1,1)",
  ).run(user, 'firma-' + user.slice(0, 8), 'Firma de prueba', 900_000 + Math.floor(Math.random() * 90_000));
  const insert = db.prepare(
    `INSERT INTO mcp_upload_tokens(id,brand_id,edition_id,token_hash,source_kind,source_id,created_by,status,created_at,
       expires_at) VALUES(?,'globalvet',?,?,'key','k-1',?,?,1,2)`,
  );
  insert.run('u-1', edition, 'huella-1', user, 'open');
  assert.throws(() => insert.run('u-2', edition, 'huella-1', user, 'open'), /UNIQUE/, 'una huella, una dirección');
  assert.throws(() => insert.run('u-3', edition, 'huella-3', user, 'inventado'), /CHECK/);
  assert.deepEqual(migrate(db, { backup: false }).applied, [], 'una sola vez');
});

test('catálogo por el conector: subir imágenes, proponer, aprobar en orden de lote, archivar un curso', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-catalogo-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' } });
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
  const approver = await register('aprobadora-cat', 'Aprobadora de prueba');
  db.prepare("UPDATE users SET role='admin' WHERE username='aprobadora-cat'").run();
  const approverId = idOf('aprobadora-cat');
  const agent = await register('asesor-cat', 'Asesor de prueba');
  db.prepare("UPDATE users SET role='agent' WHERE username='asesor-cat'").run();
  db.prepare("INSERT INTO brand_members(user_id,brand_id) VALUES(?,'globalvet')").run(idOf('asesor-cat'));
  const customer = await register('cliente-cat', 'Cliente de prueba');

  const keyFor = async (brandId, scopes) => {
    const name = 'Claude ' + scopes.join(' ') + ' ' + randomUUID().slice(0, 8);
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
  const upload = async (url, bytes, type = 'image/png') => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': type }, body: bytes });
    return { status: r.status, body: await r.json() };
  };
  const decide = (cookie, id, what = 'approve', expected = 200) =>
    fetch(origin + `/api/mcp-proposals/${id}/${what}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    }).then(async r => {
      const out = await r.json();
      assert.equal(r.status, expected, `${what} ${id}: ${JSON.stringify(out)}`);
      return out;
    });
  const flyerOf = id => db.prepare('SELECT * FROM flyers WHERE id=?').get(id);
  // La imagen que ve un cliente para una apertura (la que elige el catálogo para enviar).
  const customerFlyer = async (courseId, editionId) => {
    const r = await fetch(origin + `/api/courses/${courseId}/flyer?editionId=${editionId}`, {
      headers: { Cookie: customer },
    });
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
  };

  const ALL = ['config_drafts', 'proposals'];
  const gv = await keyFor('globalvet', ALL);
  const od = await keyFor('odonteck', ALL);
  const onlyProposals = await keyFor('globalvet', ['proposals']);

  // ================= tres cursos nuevos (los da de alta una persona en el Catálogo) con su apertura en borrador,
  // que el conector completa (actualizar_apertura_borrador)
  const courses = [];
  for (const n of [1, 2, 3]) {
    const c = (
      await api('/api/catalogue/courses', {
        body: {
          brandId: 'globalvet',
          title: `Curso de prueba del conector ${n}`,
          syllabus: `Tema ${n}.1 de prueba\nTema ${n}.2 de prueba\n` + 'Más temas de prueba. '.repeat(30),
        },
        expected: 201,
      })
    ).item;
    const draft = db.prepare("SELECT * FROM editions WHERE course_id=? AND status='draft'").get(c.id);
    const ed = await ok(gv.token, 'actualizar_apertura_borrador', {
      aperturaId: draft.id,
      revision: draft.revision,
      nombre: `Enero 2027 · grupo ${n}`,
      inicio: `2027-01-1${n} 19:00`,
      fin: `2027-01-1${n} 21:00`,
      zona: 'America/Mexico_City',
      docente: 'Docente de prueba',
      precio: 1000 + n,
      cupo: 20,
      cupoDisponible: 20,
    });
    assert.equal(ed.estado, 'draft');
    courses.push({ id: c.id, title: c.title, editionId: draft.id });
  }
  // un curso cuya única apertura está en borrador no se ofrece: ni en las aperturas que ve un cliente ni su imagen
  const boot = await call(origin, '/api/bootstrap', { cookie: customer });
  for (const c of courses) {
    assert.equal(
      boot.editions.some(e => e.course_id === c.id),
      false,
      'apertura en borrador fuera de la lista del cliente',
    );
    assert.equal((await customerFlyer(c.id, c.editionId)).status, 409);
  }

  // ================= preparar la subida: permiso, marca y apertura
  assert.match(
    (await tool(onlyProposals.token, 'preparar_subida_imagen', { aperturaId: courses[0].editionId })).error,
    /no tiene el permiso «Claude: preparar en BORRADOR aperturas/,
  );
  assert.match(
    (await tool(od.token, 'preparar_subida_imagen', { aperturaId: courses[0].editionId })).error,
    /no existe en esta marca/,
  );
  assert.match((await tool(gv.token, 'preparar_subida_imagen', { aperturaId: '../x' })).error, /no existe/);
  const prep = await ok(gv.token, 'preparar_subida_imagen', { aperturaId: courses[0].editionId });
  assert.match(prep.direccion, new RegExp('^' + origin + '/subida-imagen/tci_[A-Za-z0-9_-]{43}$'));
  assert.equal(prep.usos, 1);
  assert.equal(prep.venceEnMinutos, 10);
  assert.ok(prep.comando.includes('--data-binary') && prep.comando.includes(prep.direccion));
  assert.deepEqual(prep.limites.formatos, ['JPEG', 'PNG', 'WebP']);
  assert.equal(prep.apertura.cursoId, courses[0].id);
  // sólo se guarda la huella: la ficha no está en la base
  const token = prep.direccion.split('/').pop();
  assert.equal(
    db.prepare('SELECT count(*) n FROM mcp_upload_tokens WHERE token_hash LIKE ?').get('%' + token + '%').n,
    0,
  );
  const row = db.prepare('SELECT * FROM mcp_upload_tokens ORDER BY created_at DESC LIMIT 1').get();
  assert.equal(row.status, 'open');
  assert.equal(row.edition_id, courses[0].editionId);
  assert.equal(row.created_by, idOf('admin'));
  // la actividad del asistente registra la preparación (sin la dirección)
  const act = db
    .prepare("SELECT * FROM mcp_activity WHERE tool='preparar_subida_imagen' ORDER BY created_at DESC LIMIT 1")
    .get();
  assert.equal(act.outcome, 'ok');
  assert.equal(act.entity_type, 'upload');
  assert.doesNotMatch(JSON.stringify(act), /tci_/);

  // ---- tipo por su contenido: el Content-Type miente y no cuenta; SVG, HTML y GIF no pasan; la ficha sigue sin gastar
  for (const [body, type] of [
    ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/png'],
    ['<!doctype html><html><body>hola</body></html>', 'image/jpeg'],
    ['GIF89a-de-prueba', 'image/gif'],
    ['%PDF-1.4 de prueba', 'image/webp'],
  ]) {
    const r = await upload(prep.direccion, Buffer.from(body), type);
    assert.equal(r.status, 415, body);
    assert.match(r.body.error, /JPEG, PNG o WebP/);
  }
  assert.equal(db.prepare('SELECT status FROM mcp_upload_tokens WHERE id=?').get(row.id).status, 'open');
  // vacía
  assert.equal((await upload(prep.direccion, Buffer.alloc(0))).status, 400);
  // demasiado grande: se rechaza por su tamaño declarado sin leer el cuerpo
  const big = await new Promise((resolve, reject) => {
    const req = httpRequest(prep.direccion, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(UPLOAD_LIMITS.maxBytes + 1) },
    });
    req.on('response', res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode, connection: res.headers.connection, text });
      });
    });
    req.on('error', reject);
    req.write(Buffer.from(PNG_SIG));
  });
  assert.equal(big.status, 413);
  assert.equal(big.connection, 'close');
  assert.match(JSON.parse(big.text).error, /4 MB/);

  // ---- la feliz: PNG (el Content-Type dice JPEG: no importa), queda en BORRADOR a nombre de quien creó la llave
  const img1 = png('1');
  const up1 = await upload(prep.direccion, img1, 'image/jpeg');
  assert.equal(up1.status, 201, JSON.stringify(up1.body));
  assert.equal(up1.body.estado, 'draft');
  assert.equal(up1.body.formato, 'image/png');
  assert.equal(up1.body.aperturaId, courses[0].editionId);
  const f1 = flyerOf(up1.body.imagenId);
  assert.equal(f1.status, 'draft');
  assert.equal(f1.edition_id, courses[0].editionId);
  const lib1 = db.prepare('SELECT * FROM library_files WHERE id=?').get(f1.file_id);
  assert.equal(lib1.mime, 'image/png');
  assert.equal(lib1.created_by, idOf('admin'));
  assert.match(lib1.filename, /^Curso de prueba del conector 1\.png$/, 'el nombre lo pone el servidor');
  assert.equal(
    db.prepare("SELECT actor_id FROM catalogue_events WHERE entity_kind='flyer' AND entity_id=?").get(f1.id).actor_id,
    idOf('admin'),
    'historial del catálogo a nombre de quien firma',
  );
  assert.equal(
    db.prepare("SELECT user_id FROM audit WHERE action='mcp.flyer.upload' AND entity_id=?").get(f1.id).user_id,
    idOf('admin'),
  );
  // la ficha ya se gastó: una segunda subida no pasa
  const again = await upload(prep.direccion, png('otra'));
  assert.equal(again.status, 404);
  assert.match(again.body.error, /ya se usó o venció/);
  assert.equal(db.prepare('SELECT status FROM mcp_upload_tokens WHERE id=?').get(row.id).status, 'done');
  // una ficha inventada tampoco
  assert.equal((await upload(origin + '/subida-imagen/tci_' + 'A'.repeat(43), png('x'))).status, 404);
  assert.equal((await upload(origin + '/subida-imagen/cualquier-cosa', png('x'))).status, 404);
  // un borrador no se envía: la apertura sigue en borrador y nadie recibe la imagen
  assert.equal((await customerFlyer(courses[0].id, courses[0].editionId)).status, 409);

  // ---- vencida
  const prepOld = await ok(gv.token, 'preparar_subida_imagen', { aperturaId: courses[1].editionId });
  db.prepare("UPDATE mcp_upload_tokens SET expires_at=? WHERE status='open'").run(Date.now() - 1000);
  assert.equal((await upload(prepOld.direccion, png('vieja'))).status, 404);

  // ---- origen revocado entre preparar y subir: no se escribe nada y queda fallida
  const temp = await keyFor('globalvet', ALL);
  const prepRevoked = await ok(temp.token, 'preparar_subida_imagen', { aperturaId: courses[1].editionId });
  await api(`/api/integrations/keys/${temp.id}/revoke`, { body: {} });
  const flyersBefore = db.prepare('SELECT count(*) n FROM flyers').get().n;
  const revoked = await upload(prepRevoked.direccion, png('revocada'));
  assert.equal(revoked.status, 403);
  assert.match(revoked.body.error, /ya no está activa/);
  assert.equal(db.prepare('SELECT count(*) n FROM flyers').get().n, flyersBefore);
  assert.equal(
    db.prepare("SELECT count(*) n FROM mcp_upload_tokens WHERE source_id=? AND status='failed'").get(temp.id).n,
    1,
  );

  // ---- sustituye al borrador anterior del conector en la misma apertura (no los apila)
  const prepAgain = await ok(gv.token, 'preparar_subida_imagen', { aperturaId: courses[0].editionId });
  const img1b = jpeg('1b');
  const up1b = await upload(prepAgain.direccion, img1b, 'image/png');
  assert.equal(up1b.status, 201, JSON.stringify(up1b.body));
  assert.equal(up1b.body.formato, 'image/jpeg');
  assert.equal(up1b.body.sustituyoBorradoresAnteriores, 1);
  assert.equal(flyerOf(f1.id).status, 'archived');
  assert.equal(
    db.prepare("SELECT count(*) n FROM flyers WHERE edition_id=? AND status='draft'").get(courses[0].editionId).n,
    1,
  );

  // ---- imágenes de las otras dos aperturas (una WebP)
  const uploads = [{ ...up1b.body, bytes: img1b }];
  for (const [i, bytes] of [
    [1, png('2')],
    [2, webp('3')],
  ]) {
    const p = await ok(gv.token, 'preparar_subida_imagen', { aperturaId: courses[i].editionId });
    const u = await upload(p.direccion, bytes, 'application/octet-stream');
    assert.equal(u.status, 201, JSON.stringify(u.body));
    uploads.push({ ...u.body, bytes });
  }
  const listed = await ok(gv.token, 'listar_borradores_catalogo');
  for (const u of uploads)
    assert.ok(listed.imagenesEnBorrador.some(x => x.imagenId === u.imagenId && x.aperturaId === u.aperturaId));

  // ---- topes: imágenes en borrador por apertura (las de una persona cuentan) y direcciones abiertas por origen
  const extra = (
    await api('/api/catalogue/courses', {
      body: { brandId: 'globalvet', title: 'Curso de prueba para topes', syllabus: 'Tema de prueba' },
      expected: 201,
    })
  ).item;
  const extraEd = db.prepare("SELECT id FROM editions WHERE course_id=? AND status='draft'").get(extra.id).id;
  for (let i = 0; i < UPLOAD_LIMITS.draftsPerEdition; i++) {
    const file = await api('/api/catalogue/files', {
      body: {
        brandId: 'globalvet',
        file: { name: 'manual.png', type: 'image/png', base64: png('m' + i).toString('base64') },
      },
      expected: 201,
    });
    await api('/api/catalogue/flyers', {
      body: { editionId: extraEd, fileId: file.id, title: 'Manual ' + i, channel: 'all' },
      expected: 201,
    });
  }
  const prepFull = await ok(gv.token, 'preparar_subida_imagen', { aperturaId: extraEd });
  const full = await upload(prepFull.direccion, png('tope'));
  assert.equal(full.status, 409);
  assert.match(full.body.error, new RegExp(`ya tiene ${UPLOAD_LIMITS.draftsPerEdition} imágenes en borrador`));
  const fill = db.prepare(
    `INSERT INTO mcp_upload_tokens(id,brand_id,edition_id,token_hash,source_kind,source_id,created_by,status,created_at,
       expires_at) VALUES(?,'globalvet',?,?,'key',?,?,'open',?,?)`,
  );
  const open = db
    .prepare("SELECT count(*) n FROM mcp_upload_tokens WHERE source_id=? AND status='open' AND expires_at>?")
    .get(gv.id, Date.now()).n;
  for (let i = open; i < UPLOAD_LIMITS.openPerSource; i++)
    fill.run(randomUUID(), extraEd, 'relleno-' + randomUUID(), gv.id, idOf('admin'), Date.now(), Date.now() + 9e5);
  assert.match(
    (await tool(gv.token, 'preparar_subida_imagen', { aperturaId: extraEd })).error,
    new RegExp(`ya tiene ${UPLOAD_LIMITS.openPerSource} direcciones de subida sin usar`),
  );
  db.prepare("DELETE FROM mcp_upload_tokens WHERE token_hash LIKE 'relleno-%'").run();

  // ================= proponer: publicar las tres aperturas y aprobar las tres imágenes
  const pubs = [];
  const imgs = [];
  for (const [i, c] of courses.entries()) {
    pubs.push(await ok(gv.token, 'proponer_accion', { accion: 'publicar_apertura', id: c.editionId }));
    const pi = await ok(gv.token, 'proponer_accion', { accion: 'aprobar_imagen', id: uploads[i].imagenId });
    assert.ok(
      pi.avisos.some(w => /todavía no está publicada/.test(w)),
      'al proponer, la apertura sin publicar es un aviso',
    );
    imgs.push(pi);
  }
  // otra marca no propone sobre estas imágenes
  assert.match(
    (await tool(od.token, 'proponer_accion', { accion: 'aprobar_imagen', id: uploads[0].imagenId })).error,
    /no existe en esta marca/,
  );
  // la pantalla: la tarjeta de la imagen trae su miniatura (del mismo origen, servida con sesión) y a qué queda ligada
  const view = await call(origin, '/api/mcp-proposals', { cookie: approver });
  const imgCard = view.pending.find(p => p.id === imgs[0].propuestaId);
  assert.equal(imgCard.title, 'Aprobar la imagen del curso');
  assert.equal(imgCard.image.url, '/api/library/files/' + flyerOf(uploads[0].imagenId).file_id);
  assert.deepEqual(imgCard.problems, [], 'hay una propuesta pendiente de publicar su apertura: se puede en el lote');
  assert.ok(imgCard.batchOrder > view.pending.find(p => p.id === pubs[0].propuestaId).batchOrder);
  const imgDetail = Object.fromEntries(imgCard.details.map(d => [d.label, d.value]));
  assert.equal(imgDetail.Curso, courses[0].title);
  assert.equal(imgDetail.Apertura, 'Enero 2027 · grupo 1');
  // la miniatura: con sesión del equipo sí; sin sesión, no
  const thumb = await fetch(origin + imgCard.image.url, { headers: { Cookie: approver } });
  assert.equal(thumb.status, 200);
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), uploads[0].bytes);
  assert.notEqual((await fetch(origin + imgCard.image.url)).status, 200);
  // publicar la apertura muestra el curso, su temario COMPLETO, fechas, precio y docente
  const pubCard = view.pending.find(p => p.id === pubs[0].propuestaId);
  const pubDetail = Object.fromEntries(pubCard.details.map(d => [d.label, d.value]));
  assert.equal(pubDetail.Curso, courses[0].title);
  assert.match(pubDetail.Temario, /^Tema 1\.1 de prueba\nTema 1\.2 de prueba/);
  assert.equal(
    pubDetail.Temario,
    db.prepare('SELECT syllabus FROM courses WHERE id=?').get(courses[0].id).syllabus,
    'completo',
  );
  assert.match(pubDetail.Inicio, /2027/);
  assert.match(pubDetail.Precio, /1,001/);
  assert.equal(pubDetail.Docente, 'Docente de prueba');

  // ---- un asesor sin permiso de aprobar contenido no aprueba la imagen
  await decide(agent, imgs[0].propuestaId, 'approve', 403);
  // ---- fuera de orden: la imagen antes de publicar su apertura no se aprueba (sigue pendiente)
  const early = await decide(approver, imgs[0].propuestaId, 'approve', 409);
  assert.match(early.error, /Publica primero la apertura/);
  assert.equal(db.prepare('SELECT status FROM mcp_proposals WHERE id=?').get(imgs[0].propuestaId).status, 'pending');

  // ---- en el orden del lote: primero se publican las aperturas, después las imágenes
  const queue = view.pending
    .filter(p => [...pubs, ...imgs].some(x => x.propuestaId === p.id))
    .sort((a, b) => a.batchOrder - b.batchOrder);
  for (const p of queue) await decide(approver, p.id);
  for (const [i, c] of courses.entries()) {
    assert.equal(db.prepare('SELECT status FROM editions WHERE id=?').get(c.editionId).status, 'published');
    const f = flyerOf(uploads[i].imagenId);
    assert.equal(f.status, 'approved');
    assert.equal(f.approved_by, approverId, 'aprobada a nombre de quien aprueba');
    // se volvió a ligar a la apertura ya publicada (su revisión cambió al publicarla)
    const e = db.prepare('SELECT revision FROM editions WHERE id=?').get(c.editionId);
    assert.equal(JSON.parse(f.binding).edition, e.revision);
  }
  // ================= los cursos se ofrecen con su imagen
  const boot2 = await call(origin, '/api/bootstrap', { cookie: customer });
  for (const [i, c] of courses.entries()) {
    assert.ok(boot2.editions.some(e => e.id === c.editionId));
    const seen = await customerFlyer(c.id, c.editionId);
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.bytes, uploads[i].bytes, 'el cliente recibe exactamente la imagen aprobada');
  }
  // una imagen ya aprobada no se vuelve a proponer
  assert.match(
    (await tool(gv.token, 'proponer_accion', { accion: 'aprobar_imagen', id: uploads[0].imagenId })).error,
    /ya está aprobada/,
  );
  // el conector nunca aprueba: no hay herramienta y la subida no deja nada aprobado
  assert.equal(
    TOOLS.some(t => /aprobar|publicar|archivar/.test(t.name)),
    false,
  );

  // ---- obsoleta: la imagen cambia después de proponer (una persona la vuelve a guardar)
  const p4 = await ok(gv.token, 'preparar_subida_imagen', { aperturaId: courses[2].editionId });
  const up4 = await upload(p4.direccion, png('4'));
  assert.equal(up4.status, 201);
  const prop4 = await ok(gv.token, 'proponer_accion', { accion: 'aprobar_imagen', id: up4.body.imagenId });
  const f4 = flyerOf(up4.body.imagenId);
  await api('/api/catalogue/flyers/' + f4.id, {
    method: 'PATCH',
    body: {
      editionId: f4.edition_id,
      fileId: f4.file_id,
      title: 'Cambiada por una persona',
      channel: 'all',
      expectedRevision: f4.revision,
    },
  });
  const stale = await decide(approver, prop4.propuestaId, 'approve', 409);
  assert.equal(stale.code, 'stale_proposal');
  assert.equal(flyerOf(f4.id).status, 'draft');

  // ================= archivar un curso: avisos con datos de la base, bloqueo por número de WhatsApp y permisos
  const target = courses[1];
  // una conversación abierta del curso y una regla encendida que lo usa
  await call(origin, '/api/conversations', { cookie: customer, body: { courseId: target.id, channel: 'whatsapp' } });
  const ruleKey = await keyFor('globalvet', ['automation_drafts']);
  const rule = await ok(ruleKey.token, 'crear_regla', {
    titulo: 'Regla con curso (prueba)',
    definicion: {
      trigger: { type: 'keyword', mode: 'contains', words: ['curso-prueba-archivo'] },
      conditions: {
        match: 'all',
        groups: [{ match: 'all', rules: [{ field: 'course', op: 'in', value: [target.id] }] }],
      },
      actions: [{ type: 'send_text', text: 'Texto de prueba.' }],
    },
    clientRef: ref(),
  });
  db.prepare("UPDATE automation_rules SET status='active' WHERE id=?").run(rule.reglaId);
  // curso por omisión de un número: no se puede proponer
  db.prepare(
    "INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,created_at,updated_at) VALUES('pn-prueba-cat','globalvet',?,'Número de prueba',1,1)",
  ).run(target.id);
  const blocked = await tool(gv.token, 'proponer_accion', { accion: 'archivar_curso', id: target.id });
  assert.match(blocked.error, /curso por omisión de un número de WhatsApp \(Número de prueba\)/);
  db.prepare("DELETE FROM wa_numbers WHERE phone_number_id='pn-prueba-cat'").run();
  const arch = await ok(gv.token, 'proponer_accion', { accion: 'archivar_curso', id: target.id });
  assert.ok(
    arch.avisos.some(w => /una apertura publicada/.test(w)),
    JSON.stringify(arch.avisos),
  );
  assert.ok(
    arch.avisos.some(w => /una conversación abierta/.test(w)),
    JSON.stringify(arch.avisos),
  );
  assert.ok(
    arch.avisos.some(w => /una regla encendida/.test(w)),
    JSON.stringify(arch.avisos),
  );
  const archCard = (await call(origin, '/api/mcp-proposals', { cookie: approver })).pending.find(
    p => p.id === arch.propuestaId,
  );
  assert.match(archCard.effect, /Se puede reactivar en el Catálogo/);
  assert.equal(archCard.warnings.length, arch.avisos.length);
  // un asesor no archiva cursos (pide administración)
  await decide(agent, arch.propuestaId, 'approve', 403);
  await decide(approver, arch.propuestaId);
  assert.equal(db.prepare('SELECT active FROM courses WHERE id=?').get(target.id).active, 0);
  assert.equal(
    db.prepare("SELECT user_id FROM audit WHERE action='catalogue.course.archive' AND entity_id=?").get(target.id)
      .user_id,
    approverId,
  );
  // ya no se ofrece
  const boot3 = await call(origin, '/api/bootstrap', { cookie: customer });
  assert.equal(
    boot3.courses.some(c => c.id === target.id),
    false,
  );
  // obsoleta: el curso cambió después de proponer
  const other = courses[2];
  const archOther = await ok(gv.token, 'proponer_accion', { accion: 'archivar_curso', id: other.id });
  const k = db.prepare('SELECT * FROM courses WHERE id=?').get(other.id);
  await api('/api/catalogue/courses/' + k.id, {
    method: 'PATCH',
    body: { title: k.title, syllabus: k.syllabus + '\nTema nuevo', welcome: k.welcome, expectedRevision: k.version },
  });
  assert.equal((await decide(approver, archOther.propuestaId, 'approve', 409)).code, 'stale_proposal');
  assert.equal(db.prepare('SELECT active FROM courses WHERE id=?').get(other.id).active, 1);
  // otra marca no propone archivar un curso de ésta
  assert.match(
    (await tool(od.token, 'proponer_accion', { accion: 'archivar_curso', id: other.id })).error,
    /no existe en esta marca/,
  );
});
