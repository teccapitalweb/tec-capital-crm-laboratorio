// Dar de alta un curso con su imagen desde una conexión OAuth («Conectar con un clic», docs/PLAN_MCP_OAUTH.md), no
// con una llave `tcw_`. La subida pública vuelve a comprobar que el origen sigue vigente y conserva el permiso de
// preparar configuración; con OAuth eso se pregunta a `grantInUse` del módulo mcp-oauth, que antes no devolvía los
// permisos y hacía que toda subida respondiera 403 `source_inactive`. La ficha de acceso se obtiene por el flujo real
// (registro de la aplicación, página de permiso con la sesión de una persona, código con PKCE e intercambio), igual
// que test/mcp-oauth.test.mjs. Todos los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin } from './helpers/crm.mjs';

const b64 = buf => buf.toString('base64url');
const pkce = () => {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
};
const png = tag =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('imagen-oauth-' + tag + '-' + randomUUID()),
  ]);

test('OAuth: curso en borrador con imagen → alta aprobada por una persona; sin permiso o desconectado, no', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-oauth-catalogo-'));
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
  const RESOURCE = origin + '/mcp';
  const admin = await registerAdmin(origin, code);
  db = openDb(dir);
  const approver = (
    await call(origin, '/api/auth/register', {
      body: { username: 'aprobadora-oauth', name: 'Aprobadora de prueba', password: PASSWORD },
    })
  ).cookie;
  db.prepare("UPDATE users SET role='admin' WHERE username='aprobadora-oauth'").run();
  const approverId = db.prepare("SELECT id FROM users WHERE username='aprobadora-oauth'").get().id;

  // ---- el flujo real de «Conectar con un clic»: registrar la aplicación, permiso con la sesión, código y ficha
  const rawFetch = (path, init = {}) => fetch(origin + path, { redirect: 'manual', ...init });
  const attr = (html, name) => html.match(new RegExp(`data-${name}="([^"]+)"`))?.[1];
  async function connect(name, scopes) {
    const reg = await rawFetch('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: name, redirect_uris: ['http://127.0.0.1:4646/callback'] }),
    });
    assert.equal(reg.status, 201);
    const client = (await reg.json()).client_id;
    const p = pkce();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client,
      redirect_uri: 'http://127.0.0.1:4646/callback',
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
      state: 'estado-' + randomUUID(),
      resource: RESOURCE,
      scope: scopes.join(' '),
    });
    const consent = await rawFetch('/oauth/authorize?' + query, { headers: { Cookie: admin } });
    const text = await consent.text();
    assert.equal(consent.status, 200, text.slice(0, 300));
    const decision = await rawFetch('/oauth/decision', {
      method: 'POST',
      headers: { Cookie: admin, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: attr(text, 'request'),
        csrf: attr(text, 'csrf'),
        decision: 'allow',
        brandId: 'globalvet',
        scopes,
      }),
    });
    const back = new URL((await decision.json()).redirect);
    const token = await rawFetch('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code'),
        redirect_uri: 'http://127.0.0.1:4646/callback',
        client_id: client,
        code_verifier: p.verifier,
        resource: RESOURCE,
      }),
    });
    const body = await token.json();
    assert.equal(token.status, 200, JSON.stringify(body));
    assert.match(body.access_token, /^tca_/);
    const list = await call(origin, '/api/mcp-oauth/connections', { cookie: admin });
    return { token: body.access_token, id: list.connections.find(c => c.clientName === name).id };
  }
  let rid = 0;
  const tool = async (token, name, args = {}) => {
    const r = await rawFetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
    });
    const out = await r.json();
    assert.equal(r.status, 200, JSON.stringify(out));
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

  const conn = await connect('Asistente OAuth de catálogo', ['config_drafts', 'proposals']);

  // ================= curso en borrador → imagen → propuesta → una persona aprueba → publicado con su imagen
  const d = await ok(conn.token, 'crear_curso_borrador', {
    titulo: 'Curso por OAuth de prueba',
    temario: 'Tema 1 de prueba\nTema 2 de prueba',
    apertura: { nombre: 'Julio 2027', inicio: '2027-07-07 18:00', docente: 'Docente de prueba', precio: 990 },
    clientRef: 'oauth-cat-' + randomUUID(),
  });
  assert.equal(d.listoParaProponer, true, JSON.stringify(d.loQueFalta));
  const prep = await ok(conn.token, 'preparar_subida_imagen', { cursoBorradorId: d.cursoBorradorId });
  const bytes = png('alta');
  const up = await upload(prep.direccion, bytes);
  assert.equal(up.status, 201, 'la subida con OAuth: ' + JSON.stringify(up.body));
  assert.equal(up.body.cursoBorradorId, d.cursoBorradorId);
  const proposal = await ok(conn.token, 'proponer_accion', { accion: 'dar_de_alta_curso', id: d.cursoBorradorId });
  const approved = await fetch(origin + `/api/mcp-proposals/${proposal.propuestaId}/approve`, {
    method: 'POST',
    headers: { Cookie: approver, Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(approved.status, 200, JSON.stringify(await approved.clone().json()));
  const course = db.prepare("SELECT * FROM courses WHERE title='Curso por OAuth de prueba'").get();
  assert.equal(course.active, 1);
  const edition = db.prepare('SELECT * FROM editions WHERE course_id=?').get(course.id);
  assert.equal(edition.status, 'published');
  const flyer = db.prepare('SELECT * FROM flyers WHERE edition_id=?').get(edition.id);
  assert.equal(flyer.status, 'approved');
  assert.equal(flyer.approved_by, approverId);
  assert.equal(flyer.file_id, up.body.archivoId);

  // ================= imagen de una apertura en borrador que ya existe, por OAuth: queda como imagen en borrador
  const other = (
    await call(origin, '/api/catalogue/courses', {
      cookie: admin,
      body: { brandId: 'globalvet', title: 'Curso de una persona para OAuth', syllabus: 'Tema de prueba' },
      expected: 201,
    })
  ).item;
  const draftEdition = db.prepare("SELECT id FROM editions WHERE course_id=? AND status='draft'").get(other.id).id;
  const prepEd = await ok(conn.token, 'preparar_subida_imagen', { aperturaId: draftEdition });
  const upEd = await upload(prepEd.direccion, png('apertura'));
  assert.equal(upEd.status, 201, JSON.stringify(upEd.body));
  assert.equal(db.prepare('SELECT status FROM flyers WHERE id=?').get(upEd.body.imagenId).status, 'draft');

  // ================= (a) una conexión SIN config_drafts no prepara la subida
  const narrow = await connect('Asistente OAuth sin configuración', ['proposals']);
  assert.match(
    (await tool(narrow.token, 'preparar_subida_imagen', { aperturaId: draftEdition })).error,
    /no tiene el permiso «Claude: preparar en BORRADOR/,
  );

  // ================= (b) se desconecta entre preparar y subir: 403 source_inactive y nada se escribe
  const brief = await connect('Asistente OAuth que se desconecta', ['config_drafts', 'proposals']);
  const d2 = await ok(brief.token, 'crear_curso_borrador', {
    titulo: 'Curso por OAuth que se desconecta',
    clientRef: 'oauth-cat-' + randomUUID(),
  });
  const prep2 = await ok(brief.token, 'preparar_subida_imagen', { cursoBorradorId: d2.cursoBorradorId });
  await call(origin, `/api/mcp-oauth/connections/${brief.id}/revoke`, { cookie: admin, body: {} });
  const files = db.prepare('SELECT count(*) n FROM library_files').get().n;
  const gone = await upload(prep2.direccion, png('desconectada'));
  assert.equal(gone.status, 403);
  assert.equal(gone.body.code, 'source_inactive');
  assert.equal(db.prepare('SELECT count(*) n FROM library_files').get().n, files);
  assert.equal(db.prepare('SELECT file_id FROM mcp_course_drafts WHERE id=?').get(d2.cursoBorradorId).file_id, null);
});
