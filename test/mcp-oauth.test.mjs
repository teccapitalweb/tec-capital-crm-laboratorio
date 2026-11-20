import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/server.mjs';
import { call, openDb, PASSWORD } from './helpers/crm.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import { openDatabase } from '../server/database.mjs';
import { runLadder } from '../server/migrations/ladder.mjs';
import { NAMED } from '../server/migrations/registry.mjs';
import { applyNamed, defineRegistry } from '../server/migrations/named.mjs';
import { createMetadataFetcher, redirectAllowed, validateMetadata } from '../server/lib/mcp-oauth-clients.mjs';

// Conectar un asistente con un clic (docs/PLAN_MCP_OAUTH.md): el CRM como servidor de autorización OAuth 2.1 del
// conector MCP. Un cliente escrito a mano hace lo que hace la aplicación del asistente, y cada garantía de seguridad
// tiene aquí su caso negativo.
const sha = v => createHash('sha256').update(String(v)).digest('hex');
const b64 = buf => buf.toString('base64url');
const pkce = () => {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash('sha256').update(verifier).digest()) };
};

// Servidor de mentira que publica documentos de metadatos (y respuestas raras para las pruebas de la descarga).
async function documentServer(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404);
      return res.end();
    }
    route(req, res);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { base: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(d => server.close(d)) };
}

test('la migración mcp-oauth llega a una base ya publicada sin tocar lo que había', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-oauth-mig-'));
  let server = null,
    db = null;
  t.after(async () => {
    try {
      db?.close();
    } catch {}
    await server?.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // la base tal como está publicada: escalera más todas las migraciones con nombre anteriores a ésta
  db = openDatabase(dir);
  runLadder(db);
  applyNamed(db, defineRegistry(NAMED.filter(m => !m.name.startsWith('mcp-oauth/'))), { log: () => {} });
  db.prepare(
    'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
  ).run('old-user', 'old', 'Anterior', 'unused', 'customer', 800000, 1, 1);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='mcp_oauth_grants'").get(), undefined);
  db.close();
  server = await startServer({ dir });
  db = openDb(dir);
  assertSchemaCurrent(db);
  assert.equal(db.prepare("SELECT name FROM users WHERE id='old-user'").get().name, 'Anterior');
  for (const table of [
    'mcp_oauth_clients',
    'mcp_oauth_requests',
    'mcp_oauth_grants',
    'mcp_oauth_codes',
    'mcp_oauth_tokens',
  ])
    assert.equal(db.prepare('SELECT count(*) n FROM ' + table).get().n, 0, table);
  const columns = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mcp_oauth_%'")
    .all()
    .flatMap(r =>
      db
        .prepare(`PRAGMA table_info(${r.name})`)
        .all()
        .map(c => c.name),
    );
  assert.ok(!columns.includes('contact_id') && !columns.includes('person_id'), 'sin datos de personas del negocio');
});

test('las direcciones de regreso y los metadatos de una aplicación se validan estrictamente', () => {
  const ok = 'https://app.example.com/cb';
  assert.equal(redirectAllowed([ok], ok), true);
  assert.equal(redirectAllowed([ok], ok + '/'), false, 'coincidencia exacta');
  assert.equal(redirectAllowed([ok], 'https://app.example.com/cb?x=1'), false);
  assert.equal(redirectAllowed([ok], 'https://app.example.com.evil.example/cb'), false);
  // aplicaciones locales: el puerto cambia en cada arranque; el equipo, la ruta y la consulta no
  assert.equal(redirectAllowed(['http://localhost/callback'], 'http://localhost:3118/callback'), true);
  assert.equal(redirectAllowed(['http://127.0.0.1:4000/callback'], 'http://127.0.0.1:5000/callback'), true);
  assert.equal(redirectAllowed(['http://localhost/callback'], 'http://127.0.0.1:3118/callback'), false);
  assert.equal(redirectAllowed(['http://localhost/callback'], 'http://localhost:3118/otra'), false);
  for (const bad of [
    'http://app.example.com/cb',
    'javascript:alert(1)',
    'https://app.example.com/cb#x',
    'https://user:pw@app.example.com/cb',
    'custom-app:/cb',
  ])
    assert.throws(() => validateMetadata({ client_name: 'App', redirect_uris: [bad] }), /dirección de regreso/, bad);
  assert.throws(() => validateMetadata({ redirect_uris: [ok] }), /nombre/);
  assert.throws(() => validateMetadata({ client_name: 'App', redirect_uris: [] }), /redirect_uris/);
  assert.throws(
    () => validateMetadata({ client_name: 'App', redirect_uris: [ok], grant_types: ['password'] }),
    /authorization_code/,
  );
  assert.throws(
    () => validateMetadata({ client_name: 'App', redirect_uris: [ok], response_types: ['token'] }),
    /response_type=code/,
  );
  assert.throws(
    () =>
      validateMetadata(
        { client_name: 'App', redirect_uris: [ok], token_endpoint_auth_method: 'private_key_jwt' },
        { document: true },
      ),
    /públicas/,
  );
  const m = validateMetadata({
    client_name: 'App\u0000<b>',
    redirect_uris: [ok, ok],
    client_uri: 'https://app.example.com/x',
  });
  assert.deepEqual(m.redirects, [ok]);
  assert.equal(m.uri, 'https://app.example.com');
});

test('descargar el documento de una aplicación no abre la puerta a la red interna (SSRF)', async t => {
  const big = 'x'.repeat(20 * 1024);
  const docs = await documentServer({
    '/redirige.json': (req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    },
    '/grande.json': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ relleno: big }));
    },
    '/otro.json': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          client_id: 'https://otra.example/doc',
          client_name: 'X',
          redirect_uris: ['https://a.example/cb'],
        }),
      );
    },
  });
  t.after(docs.close);
  const strict = createMetadataFetcher({
    // un dominio público que «resuelve» a la red interna: se rechaza en la conexión, sin llegar a conectar
    lookup: (host, options, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]),
  });
  for (const id of [
    'http://cimd.example/doc.json',
    'https://cimd.example:8443/doc.json',
    'https://127.0.0.1/doc.json',
    'https://localhost/doc.json',
    'https://intranet/doc.json',
    'https://cimd.example/',
    'https://u:p@cimd.example/doc.json',
    'https://cimd.example/doc.json#x',
  ])
    await assert.rejects(strict.fetchClient(id), /no es válida/, id);
  await assert.rejects(strict.fetchClient('https://cimd.example/doc.json'), /red interna/);
  const local = createMetadataFetcher({ allowLocal: true });
  await assert.rejects(local.fetchClient(docs.base + '/redirige.json'), /no se siguen redirecciones/);
  await assert.rejects(local.fetchClient(docs.base + '/grande.json'), /demasiado grande/);
  await assert.rejects(local.fetchClient(docs.base + '/otro.json'), /no corresponde a su dirección/);
});

test('conectar un asistente con un clic: descubrimiento, permiso, fichas, renovación, revocación y cada defensa', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-oauth-'));
  const invite = randomUUID();
  // La aplicación de mentira publica su documento de metadatos en 127.0.0.1 (sólo con el interruptor de pruebas).
  let docBase = '';
  const docs = await documentServer({
    '/client.json': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' });
      res.end(
        JSON.stringify({
          client_id: docBase + '/client.json',
          client_name: 'Asistente de documento',
          redirect_uris: ['http://localhost/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      );
    },
    '/ajeno.json': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          client_id: 'https://otro.example/x',
          client_name: 'X',
          redirect_uris: ['https://a.example/cb'],
        }),
      );
    },
  });
  docBase = docs.base;
  const server = await startServer({
    dir,
    env: { ADMIN_INVITE_CODE: invite, AI_PROVIDER: '', CHANNEL_CONNECTOR: '', MCP_OAUTH_TEST_LOCAL_CLIENTS: '1' },
  });
  let db = null;
  t.after(async () => {
    try {
      db?.close();
    } catch {}
    await server.stop();
    await docs.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = server.origin;
  const RESOURCE = origin + '/mcp';

  // ---- personas: administración, una asesora de GlobalVet y un cliente
  const admin = (
    await call(origin, '/api/auth/register', {
      body: { username: 'admin', name: 'Administración', password: PASSWORD, inviteCode: invite },
    })
  ).cookie;
  db = openDb(dir);
  assertSchemaCurrent(db);
  const inv = await call(origin, '/api/team/invites', {
    cookie: admin,
    body: { username: 'asesora', brandIds: ['globalvet'] },
    expected: 201,
  });
  const agentUser = await call(origin, '/api/auth/register', {
    body: { username: 'asesora', name: 'Asesora <b>Uno</b>', password: PASSWORD, inviteCode: inv.token },
  });
  let agent = agentUser.cookie;
  const customer = (
    await call(origin, '/api/auth/register', { body: { username: 'cliente1', name: 'Cliente', password: PASSWORD } })
  ).cookie;

  // ---- utilidades del cliente de mentira
  const rawFetch = (path, init = {}) => fetch(origin + path, { redirect: 'manual', ...init });
  const authorizePath = params => '/oauth/authorize?' + new URLSearchParams(params);
  const page = async (params, cookie = '') => {
    const r = await rawFetch(authorizePath(params), { headers: cookie ? { Cookie: cookie } : {} });
    return {
      status: r.status,
      headers: r.headers,
      text: r.status === 302 ? '' : await r.text(),
      location: r.headers.get('location'),
    };
  };
  const attr = (html, name) => html.match(new RegExp(`data-${name}="([^"]+)"`))?.[1];
  const decide = (cookie, body, originHeader = origin) =>
    rawFetch('/oauth/decision', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        ...(originHeader ? { Origin: originHeader } : {}),
      },
      body: JSON.stringify(body),
    });
  const form = async (path, params) => {
    const r = await rawFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  const register = (body, type = 'application/json') =>
    rawFetch('/oauth/register', { method: 'POST', headers: { 'Content-Type': type }, body: JSON.stringify(body) });
  let rid = 0;
  const mcp = async (token, method, params, headers = {}) => {
    const r = await rawFetch('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }),
    });
    return { status: r.status, body: await r.json(), challenge: r.headers.get('www-authenticate') };
  };
  const tool = async (token, name, args = {}) => {
    const r = await mcp(token, 'tools/call', { name, arguments: args });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = r.body.result;
    return c.isError ? { error: c.content[0].text } : JSON.parse(c.content[0].text);
  };
  // El flujo completo hasta el código, con la sesión de `cookie`.
  async function grant({
    cookie = admin,
    client,
    redirect,
    brandId = 'globalvet',
    scopes = ['editions'],
    state = 'estado-' + rid++,
  }) {
    const p = pkce();
    const consent = await page(
      {
        response_type: 'code',
        client_id: client,
        redirect_uri: redirect,
        code_challenge: p.challenge,
        code_challenge_method: 'S256',
        state,
        resource: RESOURCE,
        scope: 'editions contacts',
      },
      cookie,
    );
    assert.equal(consent.status, 200, consent.text.slice(0, 300));
    const request = attr(consent.text, 'request'),
      csrf = attr(consent.text, 'csrf');
    assert.ok(request && csrf, 'la página de permiso trae su solicitud y su código contra falsificación');
    const r = await decide(cookie, { request, csrf, decision: 'allow', brandId, scopes });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    const back = new URL(body.redirect);
    assert.equal(back.searchParams.get('state'), state);
    assert.equal(back.searchParams.get('iss'), origin);
    return { code: back.searchParams.get('code'), verifier: p.verifier, redirect, client, consent };
  }
  const exchange = g =>
    form('/oauth/token', {
      grant_type: 'authorization_code',
      code: g.code,
      redirect_uri: g.redirect,
      client_id: g.client,
      code_verifier: g.verifier,
      resource: RESOURCE,
    });

  // ---- 1) descubrimiento
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const prm = await (await rawFetch(path)).json();
    assert.equal(prm.resource, RESOURCE, path);
    assert.deepEqual(prm.authorization_servers, [origin]);
    assert.ok(prm.scopes_supported.includes('editions'));
    assert.deepEqual(prm.bearer_methods_supported, ['header']);
  }
  const as = await (await rawFetch('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, origin);
  assert.equal(as.authorization_endpoint, origin + '/oauth/authorize');
  assert.equal(as.token_endpoint, origin + '/oauth/token');
  assert.equal(as.registration_endpoint, origin + '/oauth/register');
  assert.equal(as.revocation_endpoint, origin + '/oauth/revoke');
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(as.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(as.response_types_supported, ['code']);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal((await rawFetch('/.well-known/otra-cosa')).status, 404);

  // ---- 2) el 401 de /mcp dice dónde empezar
  const anon = await mcp(null, 'ping');
  assert.equal(anon.status, 401);
  assert.equal(anon.challenge, `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
  const fake = await mcp('tca_' + 'a'.repeat(43), 'ping');
  assert.equal(fake.status, 401);
  assert.match(fake.challenge, /error="invalid_token"/);
  // la sesión del CRM nunca sirve en /mcp, ni como cookie ni como ficha
  assert.equal((await mcp(null, 'ping', undefined, { Cookie: admin })).status, 401);
  assert.equal((await mcp(admin, 'ping')).status, 401);

  // ---- 3) registro dinámico: estricto
  const reg = await register({
    client_name: 'Asistente <img src=x onerror=alert(1)>',
    redirect_uris: ['http://127.0.0.1:4545/callback', 'https://app.example.com/cb'],
    token_endpoint_auth_method: 'client_secret_post',
  });
  assert.equal(reg.status, 201);
  const client = await reg.json();
  assert.match(client.client_id, /^tcc_/);
  assert.equal(client.token_endpoint_auth_method, 'none', 'cliente público: sin secreto');
  assert.equal(client.client_secret, undefined);
  for (const bad of [
    { client_name: 'X', redirect_uris: ['http://evil.example/cb'] },
    { client_name: 'X', redirect_uris: ['https://a.example/cb#f'] },
    { client_name: 'X', redirect_uris: 'https://a.example/cb' },
    { redirect_uris: ['https://a.example/cb'] },
    { client_name: 'X', redirect_uris: ['https://a.example/cb'], grant_types: ['client_credentials'] },
  ]) {
    const r = await register(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match((await r.json()).error, /^invalid_(redirect_uri|client_metadata)$/);
  }
  assert.equal(
    (await register({ client_name: 'X', redirect_uris: ['https://a.example/cb'] }, 'text/plain')).status,
    400,
  );
  const huge = await register({
    client_name: 'X',
    redirect_uris: ['https://a.example/cb'],
    relleno: 'x'.repeat(20000),
  });
  assert.equal(huge.status, 413);

  // ---- 4) antes de comprobar la aplicación y su regreso, los errores se quedan en el CRM (nunca redirige)
  const base = {
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:5555/callback',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
    state: 's1',
    resource: RESOURCE,
  };
  for (const params of [
    { ...base, client_id: 'tcc_' + 'x'.repeat(24) },
    { ...base, client_id: '' },
    { ...base, redirect_uri: 'https://evil.example/cb' },
    { ...base, redirect_uri: 'http://127.0.0.1:5555/otra' },
    { ...base, client_id: docBase + '/ajeno.json' },
  ]) {
    const r = await page(params, admin);
    assert.equal(r.status, 400, JSON.stringify(params));
    assert.equal(r.location, null, 'sin redirección a una dirección sin comprobar');
    assert.match(r.text, /No se pudo conectar el asistente/);
  }
  // …y después, vuelven a la aplicación con el error de OAuth
  const errorOf = async params => new URL((await page(params, admin)).location).searchParams.get('error');
  assert.equal(await errorOf({ ...base, response_type: 'token' }), 'unsupported_response_type');
  assert.equal(await errorOf({ ...base, code_challenge: undefined }), 'invalid_request');
  assert.equal(await errorOf({ ...base, code_challenge_method: 'plain' }), 'invalid_request');
  assert.equal(await errorOf({ ...base, resource: 'https://otro.example/mcp' }), 'invalid_target');
  assert.equal(
    (await page({ ...base, response_type: 'token' }, admin)).location.startsWith('http://127.0.0.1:5555/callback?'),
    true,
  );

  // ---- 5) sin sesión: entrar; cliente: no puede; página protegida contra marcos y caché
  const noSession = await page(base);
  assert.equal(noSession.status, 200);
  assert.match(noSession.text, /Entra al CRM para continuar/);
  assert.equal(attr(noSession.text, 'request'), undefined, 'sin sesión no se abre ninguna solicitud');
  const asCustomer = await page(base, customer);
  assert.match(asCustomer.text, /Esta cuenta no puede conectar asistentes/);
  assert.equal(attr(asCustomer.text, 'request'), undefined);
  const consent = await page(base, admin);
  assert.equal(consent.headers.get('x-frame-options'), 'DENY');
  assert.match(consent.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(consent.headers.get('cache-control'), 'no-store');
  assert.ok(!consent.text.includes('<img src=x'), 'el nombre que declara la aplicación se escapa');
  assert.match(consent.text, /Asistente &lt;img/);
  assert.match(consent.text, /Nombre que declara la aplicación/);
  assert.match(consent.text, /un programa de esta misma computadora/, 'aviso de regreso local');
  assert.match(consent.text, /value="editions" data-brands="[^"]*" checked/);
  for (const personal of ['contacts', 'conversations', 'orders'])
    assert.match(consent.text, new RegExp(`value="${personal}" data-brands="[^"]*">`), personal + ' sin marcar');
  // pedir permisos en la dirección no los marca
  assert.ok(
    !/value="contacts"[^>]*checked/.test((await page({ ...base, scope: 'contacts conversations' }, admin)).text),
  );

  // ---- 6) la decisión: misma sesión, mismo origen y código contra falsificación
  const request = attr(consent.text, 'request'),
    csrf = attr(consent.text, 'csrf');
  const allow = { request, csrf, decision: 'allow', brandId: 'globalvet', scopes: ['editions'] };
  assert.equal((await decide(admin, allow, 'https://evil.example')).status, 403, 'otro origen');
  assert.equal((await decide(admin, allow, null)).status, 403, 'sin Origin');
  assert.equal((await decide(admin, { ...allow, csrf: b64(randomBytes(32)) })).status, 403, 'código falso');
  assert.equal((await decide(admin, { ...allow, csrf: undefined })).status, 403, 'sin código');
  assert.equal((await decide(customer, allow)).status, 400, 'la solicitud es de otra persona');
  assert.equal((await decide(agent, allow)).status, 400, 'la solicitud es de otra persona');
  assert.equal((await decide('', allow)).status, 401, 'sin sesión');
  assert.equal((await decide(admin, { ...allow, brandId: 'no-existe' })).status, 404);
  assert.equal((await decide(admin, { ...allow, scopes: ['inventado'] })).status, 403);
  assert.equal((await decide(admin, { ...allow, scopes: [] })).status, 400);
  const denied = await decide(admin, { request, csrf, decision: 'deny' });
  assert.equal(new URL((await denied.json()).redirect).searchParams.get('error'), 'access_denied');
  assert.equal((await decide(admin, allow)).status, 400, 'una solicitud se decide una sola vez');

  // ---- 7) el flujo completo con administración: código → fichas → herramientas
  const loop = 'http://127.0.0.1:5555/callback';
  const g1 = await grant({ client: client.client_id, redirect: loop, scopes: ['editions', 'catalog_write'] });
  const t1 = await exchange(g1);
  assert.equal(t1.status, 200, JSON.stringify(t1.body));
  assert.equal(t1.headers.get('cache-control'), 'no-store');
  assert.match(t1.body.access_token, /^tca_[A-Za-z0-9_-]{43}$/);
  assert.match(t1.body.refresh_token, /^tcr_[A-Za-z0-9_-]{43}$/);
  assert.equal(t1.body.token_type, 'Bearer');
  assert.equal(t1.body.expires_in, 3600);
  assert.equal(t1.body.scope, 'editions catalog_write');
  // sólo se guardan huellas; nada de fichas en la base ni en la bitácora
  const stored = db
    .prepare('SELECT token_hash FROM mcp_oauth_tokens')
    .all()
    .map(r => r.token_hash);
  assert.ok(stored.includes(sha(t1.body.access_token)) && stored.includes(sha(t1.body.refresh_token)));
  const dump = JSON.stringify([
    db.prepare('SELECT * FROM mcp_oauth_tokens').all(),
    db.prepare('SELECT * FROM mcp_oauth_codes').all(),
    db.prepare('SELECT * FROM mcp_oauth_grants').all(),
    db.prepare('SELECT * FROM mcp_oauth_requests').all(),
    db.prepare('SELECT * FROM audit').all(),
  ]);
  for (const secret of [t1.body.access_token, t1.body.refresh_token, g1.code, csrf]) assert.ok(!dump.includes(secret));
  const init = await mcp(t1.body.access_token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'prueba', version: '1' },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'tec-capital-crm');
  assert.ok((await mcp(t1.body.access_token, 'tools/list')).body.result.tools.length > 10);
  const sum = await tool(t1.body.access_token, 'resumen');
  assert.equal(sum.marca.id, 'globalvet');
  assert.deepEqual(sum.permisos, ['editions', 'catalog_write']);
  assert.match(
    (await tool(t1.body.access_token, 'buscar_contactos')).error,
    /no tiene el permiso/,
    'mismas comprobaciones de permiso',
  );
  const foreign = db.prepare("SELECT id FROM courses WHERE brand_id='odonteck'").get().id;
  assert.match((await tool(t1.body.access_token, 'ver_curso', { cursoId: foreign })).error, /no existe en esta marca/);
  // escribir: firma quien autorizó, con la misma bitácora que una llave
  const curso = await tool(t1.body.access_token, 'ver_curso', { cursoId: 'aves' });
  const saved = await tool(t1.body.access_token, 'actualizar_curso', {
    cursoId: 'aves',
    version: curso.version,
    temario: curso.temario + '\nTema añadido por OAuth',
  });
  assert.equal(saved.guardado, true);
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  assert.equal(
    db.prepare("SELECT user_id FROM audit WHERE action='mcp.course.update' ORDER BY id DESC").get().user_id,
    adminId,
  );
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action='mcp.oauth.granted' AND user_id=?").get(adminId));
  // la ficha no sirve en ninguna otra ruta
  assert.equal(
    (await rawFetch('/api/v1/me', { headers: { Authorization: 'Bearer ' + t1.body.access_token } })).status,
    401,
  );
  assert.equal(
    (await rawFetch('/api/crm', { headers: { Authorization: 'Bearer ' + t1.body.access_token } })).status,
    401,
  );
  // ni la página web de otro sitio puede usarla
  assert.equal((await mcp(t1.body.access_token, 'ping', undefined, { Origin: 'https://evil.example' })).status, 403);

  // ---- 8) renovación con rotación; reutilizar una ficha vieja revoca todo el permiso
  const refresh = rt =>
    form('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: client.client_id,
      resource: RESOURCE,
    });
  assert.equal(
    (
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t1.body.refresh_token,
        client_id: 'tcc_otra',
      })
    ).body.error,
    'invalid_grant',
    'de otra aplicación',
  );
  assert.equal(
    (
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: t1.body.refresh_token,
        client_id: client.client_id,
        scope: 'editions contacts',
      })
    ).body.error,
    'invalid_scope',
    'no se amplía al renovar',
  );
  const t2 = await refresh(t1.body.refresh_token);
  assert.equal(t2.status, 200, JSON.stringify(t2.body));
  assert.notEqual(t2.body.refresh_token, t1.body.refresh_token);
  assert.equal((await mcp(t2.body.access_token, 'ping')).status, 200);
  const reuse = await refresh(t1.body.refresh_token);
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, 'invalid_grant');
  assert.equal((await mcp(t2.body.access_token, 'ping')).status, 401, 'la reutilización revocó el permiso entero');
  assert.equal((await refresh(t2.body.refresh_token)).body.error, 'invalid_grant');
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action='mcp.oauth.refresh_reuse'").get());

  // ---- 8b) los permisos van en cada ficha: una ficha acotada no recupera los demás, renovar no amplía y lo que la
  // persona pierde después también se le quita a la ficha
  const gs = await grant({ client: client.client_id, redirect: loop, scopes: ['editions', 'orders', 'catalog_write'] });
  const ts = (await exchange(gs)).body;
  assert.equal(ts.scope, 'orders editions catalog_write');
  assert.deepEqual(
    JSON.parse(db.prepare('SELECT scopes FROM mcp_oauth_tokens WHERE token_hash=?').get(sha(ts.access_token)).scopes),
    ['orders', 'editions', 'catalog_write'],
    'la ficha guarda sus permisos',
  );
  const narrow = await form('/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: ts.refresh_token,
    client_id: client.client_id,
    scope: 'editions catalog_write',
  });
  assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
  assert.equal(narrow.body.scope, 'editions catalog_write');
  assert.deepEqual((await tool(narrow.body.access_token, 'resumen')).permisos, ['editions', 'catalog_write']);
  assert.match(
    (await tool(narrow.body.access_token, 'listar_pedidos')).error,
    /no tiene el permiso/,
    'la ficha acotada no usa un permiso que el permiso concedido sí tiene',
  );
  const widen = await form('/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: narrow.body.refresh_token,
    client_id: client.client_id,
    scope: 'editions orders',
  });
  assert.equal(widen.body.error, 'invalid_scope', 'renovar no recupera lo que se dejó fuera');
  const kept = await refresh(narrow.body.refresh_token);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.scope, 'editions catalog_write', 'sin scope, la renovación conserva lo de la ficha anterior');
  assert.match((await tool(kept.body.access_token, 'listar_pedidos')).error, /no tiene el permiso/);
  // la persona deja de poder dar «modificar cursos» (deja de ser administración, sigue atendiendo la marca)
  const adminRow = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  db.prepare("UPDATE users SET role='agent' WHERE id=?").run(adminRow);
  db.prepare("INSERT INTO brand_members(user_id,brand_id) VALUES(?,'globalvet')").run(adminRow);
  assert.deepEqual((await tool(kept.body.access_token, 'resumen')).permisos, ['editions']);
  assert.match(
    (await tool(kept.body.access_token, 'actualizar_curso', { cursoId: 'aves', version: 1 })).error,
    /no tiene el permiso/,
  );
  const after = await refresh(kept.body.refresh_token);
  assert.equal(after.body.scope, 'editions', 'tampoco vuelve al renovar');
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminRow);
  db.prepare("DELETE FROM brand_members WHERE user_id=? AND brand_id='globalvet'").run(adminRow);
  assert.deepEqual(
    (await tool(after.body.access_token, 'resumen')).permisos,
    ['editions'],
    'una ficha emitida con menos no recupera nada aunque la persona vuelva a poder',
  );

  // ---- 9) el código: un solo uso, ligado a la aplicación, al regreso, a PKCE y al recurso; caduca
  const g2 = await grant({ client: client.client_id, redirect: loop });
  assert.equal(
    (
      await form('/oauth/token', {
        grant_type: 'authorization_code',
        code: g2.code,
        redirect_uri: loop,
        client_id: client.client_id,
        code_verifier: pkce().verifier,
      })
    ).body.error,
    'invalid_grant',
    'verificador equivocado',
  );
  assert.equal((await exchange(g2)).body.error, 'invalid_grant', 'un intento fallido también gasta el código');
  const g3 = await grant({ client: client.client_id, redirect: loop });
  const t3 = await exchange(g3);
  assert.equal(t3.status, 200);
  assert.equal((await exchange(g3)).body.error, 'invalid_grant', 'código reutilizado');
  assert.equal((await mcp(t3.body.access_token, 'ping')).status, 401, 'reutilizar el código revoca lo que emitió');
  for (const [what, change] of [
    ['regreso distinto', { redirect_uri: 'http://127.0.0.1:5555/callback2' }],
    ['otra aplicación', { client_id: 'tcc_otra-aplicacion-de-prueba' }],
    ['otro recurso', { resource: 'https://otro.example/mcp' }],
    ['sin verificador', { code_verifier: '' }],
  ]) {
    const g = await grant({ client: client.client_id, redirect: loop });
    const r = await form('/oauth/token', {
      grant_type: 'authorization_code',
      code: g.code,
      redirect_uri: loop,
      client_id: client.client_id,
      code_verifier: g.verifier,
      resource: RESOURCE,
      ...change,
    });
    assert.equal(r.status, 400, what);
    assert.match(r.body.error, /^invalid_(grant|target)$/, what);
  }
  const g4 = await grant({ client: client.client_id, redirect: loop });
  db.prepare('UPDATE mcp_oauth_codes SET expires_at=0 WHERE code_hash=?').run(sha(g4.code));
  assert.equal((await exchange(g4)).body.error, 'invalid_grant', 'código vencido');
  assert.equal(
    (await form('/oauth/token', { grant_type: 'password', username: 'admin', password: PASSWORD })).body.error,
    'unsupported_grant_type',
  );
  assert.equal((await form('/oauth/token', { grant_type: 'client_credentials' })).body.error, 'unsupported_grant_type');

  // ---- 10) ficha de acceso vencida y revocación por la aplicación
  const g5 = await grant({ client: client.client_id, redirect: loop });
  const t5 = (await exchange(g5)).body;
  db.prepare('UPDATE mcp_oauth_tokens SET expires_at=0 WHERE token_hash=?').run(sha(t5.access_token));
  const expired = await mcp(t5.access_token, 'ping');
  assert.equal(expired.status, 401);
  assert.match(expired.challenge, /error="invalid_token"/);
  const t6 = (await refresh(t5.refresh_token)).body;
  assert.equal((await mcp(t6.access_token, 'ping')).status, 200);
  const revoked = await form('/oauth/revoke', { token: t6.refresh_token, client_id: client.client_id });
  assert.equal(revoked.status, 200);
  assert.equal((await mcp(t6.access_token, 'ping')).status, 401);
  assert.equal((await refresh(t6.refresh_token)).body.error, 'invalid_grant');
  assert.equal(
    (await form('/oauth/revoke', { token: 'tcr_desconocida' })).status,
    200,
    'revocar algo desconocido no dice nada',
  );

  // ---- 11) la asesora: sólo lo que puede dar, sólo en su marca, y deja de servir si pierde el acceso
  const agentConsent = await page(base, agent);
  assert.match(agentConsent.text, /value="editions"/);
  for (const adminOnly of ['catalog_write', 'knowledge', 'automation_drafts'])
    assert.ok(!agentConsent.text.includes(`value="${adminOnly}"`), adminOnly + ' no se ofrece');
  assert.ok(!agentConsent.text.includes('value="odonteck"'), 'sólo sus marcas');
  const ar = attr(agentConsent.text, 'request'),
    ac = attr(agentConsent.text, 'csrf');
  const escalate = await decide(agent, {
    request: ar,
    csrf: ac,
    decision: 'allow',
    brandId: 'globalvet',
    scopes: ['editions', 'catalog_write'],
  });
  assert.equal(escalate.status, 403, 'pedir de más');
  assert.equal(
    (await decide(agent, { request: ar, csrf: ac, decision: 'allow', brandId: 'odonteck', scopes: ['editions'] }))
      .status,
    404,
    'marca ajena',
  );
  const ga = await grant({
    cookie: agent,
    client: client.client_id,
    redirect: loop,
    scopes: ['editions', 'conversations'],
  });
  const ta = (await exchange(ga)).body;
  assert.equal(ta.scope, 'editions conversations');
  assert.deepEqual((await tool(ta.access_token, 'resumen')).permisos, ['editions', 'conversations']);
  const agentId = db.prepare("SELECT id FROM users WHERE username='asesora'").get().id;
  // pierde la marca → la ficha deja de servir; la renovación también
  await call(origin, '/api/team/members/' + agentId, {
    cookie: admin,
    method: 'PATCH',
    body: { brandIds: ['odonteck'] },
  });
  assert.equal((await mcp(ta.access_token, 'ping')).status, 401);
  assert.equal((await refresh(ta.refresh_token)).body.error, 'invalid_grant');
  // suspendida → tampoco (otro permiso, de antes de suspenderla)
  await call(origin, '/api/team/members/' + agentId, {
    cookie: admin,
    method: 'PATCH',
    body: { brandIds: ['globalvet'] },
  });
  agent = (await call(origin, '/api/auth/login', { body: { username: 'asesora', password: PASSWORD } })).cookie;
  const gb = await grant({ cookie: agent, client: client.client_id, redirect: loop });
  const tb = (await exchange(gb)).body;
  assert.equal((await mcp(tb.access_token, 'ping')).status, 200);
  await call(origin, '/api/team/members/' + agentId, {
    cookie: admin,
    method: 'PATCH',
    body: { brandIds: ['globalvet'], disabled: true },
  });
  assert.equal((await mcp(tb.access_token, 'ping')).status, 401);
  await call(origin, '/api/team/members/' + agentId, {
    cookie: admin,
    method: 'PATCH',
    body: { brandIds: ['globalvet'] },
  });
  agent = (await call(origin, '/api/auth/login', { body: { username: 'asesora', password: PASSWORD } })).cookie;
  assert.equal((await mcp(tb.access_token, 'ping')).status, 200, 'el acceso se mira en cada uso');

  // ---- 12) «Asistentes conectados»: administración ve todo lo de sus marcas; los demás, lo suyo
  const adminList = await call(origin, '/api/mcp-oauth/connections', { cookie: admin });
  assert.equal(adminList.mcpUrl, RESOURCE);
  assert.equal(adminList.canSeeAll, true);
  const agentConn = adminList.connections.find(c => c.id && c.userName.startsWith('Asesora'));
  assert.ok(agentConn, 'administración ve la conexión de la asesora');
  assert.ok(!JSON.stringify(adminList).match(/tca_|tcr_/), 'la lista no lleva fichas');
  const agentList = await call(origin, '/api/mcp-oauth/connections', { cookie: agent });
  assert.equal(agentList.canSeeAll, false);
  assert.ok(agentList.connections.length >= 1 && agentList.connections.every(c => c.mine));
  const adminConn = adminList.connections.find(c => c.mine);
  await call(origin, `/api/mcp-oauth/connections/${adminConn.id}/revoke`, { cookie: agent, body: {}, expected: 404 });
  await call(origin, '/api/mcp-oauth/connections', { cookie: customer, expected: 403 });
  await call(origin, `/api/mcp-oauth/connections/${agentConn.id}/revoke`, { cookie: admin, body: {} });
  const left = db.prepare('SELECT revoked_at,revoked_by FROM mcp_oauth_grants WHERE id=?').get(agentConn.id);
  assert.ok(left.revoked_at);
  assert.equal(left.revoked_by, adminId);

  // ---- 13) aplicación con documento de metadatos (como lo hacen las aplicaciones de Claude)
  const docClient = docBase + '/client.json';
  const gd = await grant({ client: docClient, redirect: 'http://localhost:7777/callback' });
  assert.match(gd.consent.text, /Identidad publicada en/);
  assert.match(gd.consent.text, /Asistente de documento/);
  const td = await form('/oauth/token', {
    grant_type: 'authorization_code',
    code: gd.code,
    redirect_uri: 'http://localhost:7777/callback',
    client_id: docClient,
    code_verifier: gd.verifier,
  });
  assert.equal(td.status, 200, JSON.stringify(td.body));
  assert.equal((await tool(td.body.access_token, 'resumen')).marca.id, 'globalvet');
  const wrongRedirect = await page(
    { ...base, client_id: docClient, redirect_uri: 'http://127.0.0.1:7777/callback' },
    admin,
  );
  assert.equal(wrongRedirect.status, 400);

  // ---- 14) deja de ser administración → la ficha deja de servir; vuelve → vuelve a servir
  const g7 = await grant({ client: client.client_id, redirect: loop, scopes: ['editions', 'catalog_write'] });
  const t7 = (await exchange(g7)).body;
  db.prepare("UPDATE users SET role='agent' WHERE id=?").run(adminId);
  assert.equal((await mcp(t7.access_token, 'ping')).status, 401, 'sin administración y sin marcas, nada');
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminId);
  assert.equal((await mcp(t7.access_token, 'ping')).status, 200);

  // ---- 15) la llave de la API sigue igual
  const key = (
    await call(origin, '/api/integrations/keys', {
      cookie: admin,
      body: { brandId: 'globalvet', name: 'Claude terminal', scopes: ['editions'] },
      expected: 201,
    })
  ).token;
  assert.equal((await tool(key, 'resumen')).llave, 'Claude terminal');
  const badKey = await mcp('tcw_' + 'x'.repeat(32), 'ping');
  assert.equal(badKey.status, 401);
  assert.match(badKey.challenge, /resource_metadata=/);

  // ---- 16) el registro sin autenticación tiene tope por dirección
  let limited = false;
  for (let i = 0; i < 25 && !limited; i++)
    limited = (await register({ client_name: 'Relleno ' + i, redirect_uris: ['https://a.example/cb'] })).status === 429;
  assert.ok(limited, 'el registro dinámico se frena por dirección');
  assert.ok(!server.logs().match(/tca_|tcr_/), 'las fichas no salen en el registro del servidor');
});
