// Conectar un asistente con un clic (docs/PLAN_MCP_OAUTH.md). El CRM es su propio servidor de autorización OAuth 2.1
// para el recurso /mcp (el conector de server/mcp.mjs), según la especificación de autorización de MCP:
//  · Descubrimiento: /.well-known/oauth-protected-resource[/mcp] (RFC 9728) y /.well-known/oauth-authorization-server
//    (RFC 8414). El 401 de /mcp apunta a ellos con WWW-Authenticate (lo pone server/mcp.mjs con challenge()).
//  · La aplicación se presenta con su documento de metadatos (client_id = dirección HTTPS) o se registra sola (RFC 7591).
//  · Código de autorización con PKCE S256 obligatorio, indicador de recurso (RFC 8707), fichas opacas con huella, de una
//    hora, y fichas de renovación que rotan (usar una vieja revoca todo el permiso). Revocación (RFC 7009).
//  · La persona entra con su sesión normal del equipo y elige UNA marca y los permisos, con la misma regla que las llaves:
//    escribir exige administración (lo mismo que piden las herramientas que escriben a quien firma). Todo se vuelve a
//    comprobar al aprobar y en CADA uso: si la persona pierde la marca, la suspenden o deja de poder, el permiso deja de
//    servir.
//  · Para el conector, un permiso vale exactamente como una llave creada por esa persona con esos permisos: mismas
//    comprobaciones, misma firma, misma bitácora y mismo límite por minuto.
// Rutas: públicas /oauth/* (sin sesión ni Origin: cada una se defiende sola) y, con sesión, /api/mcp-oauth/* para la
// pantalla «Asistentes conectados». Las de /.well-known/ las pasa server/index.mjs a wellKnown().
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { TOOLS } from '../../mcp.mjs';
import { LIMITS as API_LIMITS, SCOPES, SCOPE_KINDS } from '../../integrations.mjs';
import { createMetadataFetcher, isLoopback, redirectAllowed, validateMetadata } from '../../lib/mcp-oauth-clients.mjs';
import { createRepo } from './repo.mjs';
import { consentPage, errorPage, loginPage, notAllowedPage } from './page.mjs';

const MIN = 60_000;
export const OAUTH_LIMITS = Object.freeze({
  requestMs: 10 * MIN, // la pantalla de permiso abierta
  codeMs: 60_000, // el código de autorización
  accessMs: 60 * MIN, // la ficha de acceso
  refreshMs: 30 * 24 * 60 * MIN, // la ficha de renovación (cada renovación da otra)
  keepSpentMs: 10 * MIN, // un código gastado se conserva un rato para reconocer su reutilización
  unusedClientMs: 24 * 60 * MIN, // una aplicación registrada que nunca obtuvo permiso se borra al día
  maxClients: 1000,
  maxGrantsPerUser: 20,
  maxRequestsPerUser: 20,
  bodyBytes: 16 * 1024,
  authorizePerMinute: 60,
  tokenPerMinute: 120,
  registerPerHour: 20,
  revokePerMinute: 60,
});

// Conectar un asistente es, por ahora, cosa de administración, igual que crear una llave de la API: cualquier
// permiso, también los de lectura, exige este permiso del catálogo en esa marca.
const ADMIN_PERMISSION = 'developer.keys.manage';
// Una renovación en paralelo de la MISMA ficha (la aplicación lo hace a veces) no se trata como robo durante este
// rato: la perdedora recibe invalid_grant sin revocar nada. Fuera de él, o con una ficha más vieja, se revoca todo.
const REFRESH_GRACE_MS = 10_000;
// Permisos que dejan ver datos personales: nunca vienen marcados.
const PERSONAL = new Set(['contacts', 'conversations', 'orders']);
const PRECHECKED = ['editions'];

const sha = v => createHash('sha256').update(String(v)).digest('hex');
const sameHash = (a, b) => {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const b64url = buf => buf.toString('base64url');
const newToken = prefix => prefix + b64url(randomBytes(32)); // 256 bits
const TOKEN = /^Bearer\s+(tca_[A-Za-z0-9_-]{43})$/;

// Error del protocolo OAuth: { error, error_description }. Nunca lleva la ficha ni el código que se recibió.
const oauthError = (status, error, description) => Object.assign(new Error(description), { status, oauth: error });

export default {
  name: 'mcp-oauth',
  public: {
    prefixes: ['/oauth'],
    handle: (api, req, res, path, url, ip) => api.handlePublic(req, res, path, url, ip),
  },
  timers: [{ name: 'limpieza', everyMs: 60_000, testEveryMs: 1000, run: api => api.sweep() }],
  create(host) {
    const { db, transaction, fail, json, audit, rate, access } = host;
    const repo = createRepo(db);
    const now = () => Date.now();
    // ---- dirección pública. En producción sale SÓLO de APP_ORIGIN: sin ella no se anuncia OAuth (nada de tomar la
    // dirección de la cabecera Host, que la escribe quien llama). Fuera de producción (pruebas, uso local) se deduce del
    // pedido.
    const configured = String(process.env.APP_ORIGIN || '')
      .split(',')[0]
      .trim()
      .replace(/\/+$/, '');
    const fixedOrigin = /^https?:\/\/[^\s/]+$/.test(configured) ? new URL(configured).origin : null;
    const missingOrigin = Boolean(host.production) && !fixedOrigin;
    const disabled = process.env.MCP_OAUTH_DISABLED === '1' || missingOrigin;
    const REQUIRED =
      'mcp-oauth: APP_ORIGIN es obligatorio en producción para conectar asistentes con OAuth; queda apagado (las llaves de la API siguen funcionando).';
    if (missingOrigin) console.error(REQUIRED);
    let lastRefusalLog = 0;
    // Sólo las pruebas: la aplicación de mentira publica su documento en http://127.0.0.1.
    const allowLocal = process.env.NODE_ENV === 'test' && process.env.MCP_OAUTH_TEST_LOCAL_CLIENTS === '1';
    const fetcher = createMetadataFetcher({ allowLocal });
    // Los permisos del conector: los de sus herramientas, en el orden de la pantalla de llaves.
    const MCP_SCOPES = Object.keys(SCOPES).filter(s => TOOLS.some(t => t.scope === s));

    function originOf(req) {
      if (fixedOrigin) return fixedOrigin;
      const name = String(req.headers.host || '')
        .toLowerCase()
        .replace(/[^a-z0-9.:\-\[\]]/g, '');
      const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
      return (secure ? 'https' : 'http') + '://' + name;
    }
    const resourceOf = req => originOf(req) + '/mcp';
    const metadataUrl = req => originOf(req) + '/.well-known/oauth-protected-resource/mcp';
    // Forma canónica de un indicador de recurso (RFC 8707): minúsculas en esquema y dominio, sin puerto por omisión,
    // sin barra final ni fragmento. null si no es una dirección.
    function canonical(raw) {
      if (typeof raw !== 'string' || !raw || raw.length > 300 || raw.includes('#')) return null;
      try {
        const u = new URL(raw);
        if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search) return null;
        return u.origin + u.pathname.replace(/\/+$/, '');
      } catch {
        return null;
      }
    }

    // ---- quién puede conceder qué
    const userRow = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
    const isStaff = u => u && !u.disabled && ['admin', 'agent'].includes(u.role);
    const grantable = (user, brandId) => (access.can(user, ADMIN_PERMISSION, brandId) ? [...MCP_SCOPES] : []);
    // Los permisos que siguen valiendo HOY de un permiso concedido: [] si la persona ya no puede nada en esa marca.
    function effective(grant) {
      const u = userRow(grant.user_id);
      if (!isStaff(u) || !host.services.crm.canBrand(u, grant.brand_id)) return [];
      const allowed = new Set(grantable(u, grant.brand_id));
      let scopes = [];
      try {
        scopes = JSON.parse(grant.scopes);
      } catch {}
      return scopes.filter(s => allowed.has(s));
    }

    // ---- lectura de cuerpos pequeños (formulario o JSON)
    async function readBody(req) {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > OAUTH_LIMITS.bodyBytes)
          throw oauthError(413, 'invalid_request', 'La solicitud es demasiado grande.');
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const type = String(req.headers['content-type'] || '').toLowerCase();
      if (type.startsWith('application/json')) {
        try {
          const data = JSON.parse(text || '{}');
          if (data && typeof data === 'object' && !Array.isArray(data)) return data;
        } catch {}
        throw oauthError(400, 'invalid_request', 'JSON no válido.');
      }
      if (type.startsWith('application/x-www-form-urlencoded')) {
        const out = {};
        for (const [k, v] of new URLSearchParams(text)) {
          if (Object.hasOwn(out, k)) throw oauthError(400, 'invalid_request', 'Parámetro repetido: ' + k.slice(0, 40));
          out[k] = v;
        }
        return out;
      }
      throw oauthError(400, 'invalid_request', 'Usa application/x-www-form-urlencoded.');
    }
    const str = (v, max = 500) => (typeof v === 'string' && v.length <= max ? v : '');

    function sendOauth(res, status, data, extra = {}) {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        ...extra,
      });
      res.end(JSON.stringify(data));
    }
    function sendHtml(res, status, markup) {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'X-Frame-Options': 'DENY',
      });
      res.end(markup);
    }
    const withParams = (base, params) => {
      const u = new URL(base);
      for (const [k, v] of Object.entries(params))
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
      return u.toString();
    };

    // ---- aplicaciones
    async function resolveClient(clientId, ip) {
      if (/^https?:\/\//.test(clientId)) {
        // El límite cuenta sólo descargas reales, por dirección y documento: un documento en caché nunca se bloquea
        // por el tráfico de otras personas.
        const c = await fetcher.fetchClient(clientId, {
          beforeDownload: () => rate('oauth-document:' + ip + ':' + sha(clientId).slice(0, 16), 30),
        });
        return { id: clientId, kind: 'document', name: c.name, uri: c.uri, host: c.host, redirects: c.redirects };
      }
      const row = /^tcc_[A-Za-z0-9_-]{22,64}$/.test(clientId) ? repo.clientById.get(clientId) : null;
      if (!row) throw fail(400, 'La aplicación no está registrada en este CRM.', { code: 'invalid_client' });
      return {
        id: row.id,
        kind: 'registered',
        name: row.name,
        uri: row.uri,
        host: null,
        redirects: JSON.parse(row.redirect_uris),
      };
    }

    // ---- /.well-known/
    function wellKnown(req, res, path) {
      if (disabled) return false;
      const doc =
        path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp'
          ? {
              resource: resourceOf(req),
              authorization_servers: [originOf(req)],
              scopes_supported: MCP_SCOPES,
              bearer_methods_supported: ['header'],
              resource_name: 'CRM (conector MCP)',
            }
          : path === '/.well-known/oauth-authorization-server'
            ? (o => ({
                issuer: o,
                authorization_endpoint: o + '/oauth/authorize',
                token_endpoint: o + '/oauth/token',
                registration_endpoint: o + '/oauth/register',
                revocation_endpoint: o + '/oauth/revoke',
                response_types_supported: ['code'],
                response_modes_supported: ['query'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                code_challenge_methods_supported: ['S256'],
                token_endpoint_auth_methods_supported: ['none'],
                revocation_endpoint_auth_methods_supported: ['none'],
                scopes_supported: MCP_SCOPES,
                client_id_metadata_document_supported: true,
                authorization_response_iss_parameter_supported: true,
              }))(originOf(req))
            : null;
      if (!doc) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendOauth(res, 405, { error: 'invalid_request' }, { Allow: 'GET' });
        return true;
      }
      // Metadatos públicos: se pueden leer desde cualquier origen; nunca se guardan en cachés intermedias.
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(doc));
      return true;
    }

    // ---- GET /oauth/authorize
    async function authorize(req, res, url, ip) {
      rate('oauth-authorize:' + ip, OAUTH_LIMITS.authorizePerMinute);
      const p = url.searchParams;
      const one = name => {
        const all = p.getAll(name);
        if (all.length > 1) throw fail(400, 'El parámetro «' + name + '» viene repetido.');
        return all[0] ?? '';
      };
      // TODOS los errores antes del permiso se muestran AQUÍ, sin redirigir: la aplicación pudo registrarse sola con
      // cualquier dirección de regreso, así que mandar a alguien ahí sin que haya hecho nada sería prestar el CRM como
      // redirector (RFC 9700 §4.11.2). Sólo se vuelve a la aplicación después de «Permitir» o «Cancelar».
      let client, redirectUri, challenge, state, resource;
      try {
        const clientId = one('client_id');
        if (!clientId) throw fail(400, 'Falta el identificador de la aplicación (client_id).');
        client = await resolveClient(clientId, ip);
        redirectUri = one('redirect_uri');
        if (!redirectUri || !redirectAllowed(client.redirects, redirectUri))
          throw fail(400, 'La dirección de regreso no coincide con la que registró la aplicación.');
        state = one('state');
        if (state.length > 500) throw fail(400, 'El dato «state» es demasiado largo.');
        for (const name of ['response_type', 'code_challenge', 'code_challenge_method', 'resource', 'scope']) one(name);
        if (p.get('response_type') !== 'code')
          throw fail(400, 'La aplicación pidió un tipo de respuesta que el CRM no admite (sólo «code»).');
        challenge = p.get('code_challenge') ?? '';
        if (p.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
          throw fail(400, 'La aplicación no usó PKCE con S256, que el CRM exige.');
        resource = resourceOf(req);
        if (p.has('resource') && canonical(p.get('resource')) !== resource)
          throw fail(400, 'La aplicación pidió permiso para otro servicio; este CRM sólo autoriza ' + resource + '.');
      } catch (e) {
        if (!e.status) throw e;
        sendHtml(res, 400, errorPage(e.message));
        return;
      }

      const user = host.readSession(req);
      if (!user) return sendHtml(res, 200, loginPage(client));
      const brands = isStaff(user)
        ? access
            .brandIds(user)
            .map(id => ({ id, scopes: grantable(user, id) }))
            .filter(b => b.scopes.length)
        : [];
      if (!brands.length)
        return sendHtml(
          res,
          200,
          notAllowedPage(
            user,
            'Por ahora sólo administración puede conectar asistentes al CRM, igual que crear una llave de la API. Pide a una persona de administración que lo conecte.',
          ),
        );
      const csrf = newToken('');
      const id = randomUUID();
      const t = now();
      const redirectHost = new URL(redirectUri).host;
      repo.requestInsert.run(
        id,
        sha(csrf),
        user.id,
        client.id,
        client.kind,
        client.name,
        client.host,
        redirectUri,
        challenge,
        state,
        resource,
        str(p.get('scope') ?? '', 300) || null,
        t,
        t + OAUTH_LIMITS.requestMs,
      );
      repo.requestTrim.run(user.id, user.id, OAUTH_LIMITS.maxRequestsPerUser);
      const names = Object.fromEntries(
        db
          .prepare('SELECT id,name FROM brands')
          .all()
          .map(b => [b.id, b.name]),
      );
      sendHtml(
        res,
        200,
        consentPage({
          request: id,
          csrf,
          client,
          redirectHost,
          loopback: isLoopback(new URL(redirectUri)),
          user,
          brands: brands.map(b => ({ id: b.id, name: names[b.id] || b.id })),
          scopes: MCP_SCOPES.filter(s => brands.some(b => b.scopes.includes(s))).map(s => ({
            key: s,
            label: SCOPES[s],
            kind: SCOPE_KINDS[s] === 'write' ? 'write' : 'read',
            personal: PERSONAL.has(s),
            brands: brands.filter(b => b.scopes.includes(s)).map(b => b.id),
          })),
          checked: PRECHECKED,
        }),
      );
    }

    // ---- POST /oauth/decision (la página de permiso, con la sesión y desde el mismo origen)
    async function decide(req, res, ip) {
      if (!host.originAllowed(req)) throw fail(403, 'Origen no permitido.');
      rate('oauth-decision:' + ip, 30);
      const user = host.readSession(req);
      if (!user) throw fail(401, 'Tu sesión terminó. Vuelve a entrar.');
      const input = await host.body(req);
      const r = typeof input.request === 'string' ? repo.requestById.get(input.request) : null;
      if (!r || r.expires_at < now() || r.user_id !== user.id)
        throw fail(400, 'Esta solicitud venció o ya se usó. Vuelve a empezar desde la aplicación del asistente.', {
          code: 'request_expired',
        });
      if (typeof input.csrf !== 'string' || !sameHash(sha(input.csrf), r.csrf_hash))
        throw fail(403, 'La solicitud no es válida. Vuelve a empezar desde la aplicación del asistente.', {
          code: 'csrf',
        });
      const iss = originOf(req);
      if (input.decision === 'deny') {
        repo.requestDelete.run(r.id);
        return json(res, 200, {
          redirect: withParams(r.redirect_uri, { error: 'access_denied', state: r.state, iss }),
        });
      }
      if (input.decision !== 'allow') throw fail(400, 'Decisión no válida.');
      const fresh = userRow(user.id);
      if (!isStaff(fresh)) throw fail(403, 'Esta cuenta no puede conectar asistentes.');
      const brandId = typeof input.brandId === 'string' ? input.brandId : '';
      const allowed = brandId ? grantable(fresh, brandId) : [];
      if (!allowed.length) throw fail(404, 'Marca no disponible.', { code: 'not_found' });
      const scopes = Array.isArray(input.scopes) ? [...new Set(input.scopes)] : [];
      if (!scopes.length || scopes.length > 30 || scopes.some(s => typeof s !== 'string'))
        throw fail(400, 'Marca al menos un permiso.', { code: 'invalid_scope' });
      const extra = scopes.filter(s => !allowed.includes(s));
      if (extra.length)
        throw fail(403, 'Tu acceso no permite dar ese permiso en esta marca.', {
          code: 'invalid_scope',
          details: { scopes: extra.slice(0, 10).map(s => String(s).slice(0, 40)) },
        });
      if (repo.grantsActiveOfUser.get(user.id).n >= OAUTH_LIMITS.maxGrantsPerUser)
        throw fail(409, 'Ya tienes ' + OAUTH_LIMITS.maxGrantsPerUser + ' asistentes conectados. Desconecta alguno.', {
          code: 'too_many',
        });
      const code = newToken('');
      const grantId = randomUUID();
      const t = now();
      transaction(db, () => {
        if (!repo.requestDelete.run(r.id).changes) throw fail(400, 'Esta solicitud ya se usó.');
        repo.grantInsert.run(
          grantId,
          r.client_id,
          r.client_kind,
          r.client_name,
          r.client_host,
          r.redirect_uri,
          user.id,
          brandId,
          JSON.stringify(MCP_SCOPES.filter(s => scopes.includes(s))),
          r.resource,
          t,
        );
        repo.codeInsert.run(
          sha(code),
          grantId,
          r.client_id,
          r.redirect_uri,
          r.code_challenge,
          r.resource,
          t,
          t + OAUTH_LIMITS.codeMs,
        );
        if (r.client_kind === 'registered') repo.clientUsed.run(t, r.client_id);
      });
      audit(user, 'mcp.oauth.granted', grantId);
      json(res, 200, { redirect: withParams(r.redirect_uri, { code, state: r.state, iss }) });
    }

    // ---- revocar todo un permiso (desconectar, reutilización detectada, revocación pedida por la aplicación)
    function revokeGrant(grantId, actor, reason) {
      const done = transaction(db, () => {
        const changed = repo.grantRevoke.run(now(), actor?.id ?? null, reason, grantId).changes;
        repo.tokensOfGrantDelete.run(grantId);
        repo.codesOfGrantSpend.run(now(), grantId);
        return changed;
      });
      if (done) audit(actor, 'mcp.oauth.revoked', grantId);
      return done;
    }

    // Cada ficha guarda los permisos con que se emitió: al usarla vale la INTERSECCIÓN de esos y los que la persona
    // sigue pudiendo dar hoy (effective). Así una ficha acotada no recupera lo que no pidió y una pérdida de acceso
    // posterior también la recorta.
    const scopesOf = row => {
      try {
        const list = JSON.parse(row.scopes);
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    };
    const within = (grant, row) => {
      const own = scopesOf(row);
      return effective(grant).filter(s => own.includes(s));
    };
    function issue(grant, scopes) {
      const access_token = newToken('tca_'),
        refresh_token = newToken('tcr_'),
        t = now(),
        list = JSON.stringify(scopes);
      repo.tokenInsert.run(sha(access_token), grant.id, 'access', list, t, t + OAUTH_LIMITS.accessMs);
      repo.tokenInsert.run(sha(refresh_token), grant.id, 'refresh', list, t, t + OAUTH_LIMITS.refreshMs);
      return {
        access_token,
        token_type: 'Bearer',
        expires_in: Math.floor(OAUTH_LIMITS.accessMs / 1000),
        refresh_token,
        scope: scopes.join(' '),
      };
    }

    // ---- POST /oauth/token
    async function token(req, res, ip) {
      rate('oauth-token:' + ip, OAUTH_LIMITS.tokenPerMinute);
      const p = await readBody(req);
      const clientId = str(p.client_id, 300);
      if (p.grant_type === 'authorization_code') {
        const code = str(p.code, 100);
        const row = code ? repo.codeByHash.get(sha(code)) : null;
        if (!row) throw oauthError(400, 'invalid_grant', 'Código no válido.');
        // Un código sirve UNA vez, acierte o no: un segundo intento revoca lo que emitió el primero.
        if (row.used_at || !repo.codeSpend.run(now(), row.code_hash).changes) {
          if (revokeGrant(row.grant_id, null, 'code_reuse')) audit(null, 'mcp.oauth.code_reuse', row.grant_id);
          throw oauthError(400, 'invalid_grant', 'Este código ya se usó.');
        }
        if (row.expires_at < now()) throw oauthError(400, 'invalid_grant', 'El código venció.');
        if (!clientId || clientId !== row.client_id)
          throw oauthError(400, 'invalid_grant', 'El código es de otra aplicación.');
        if (str(p.redirect_uri) !== row.redirect_uri)
          throw oauthError(400, 'invalid_grant', 'La dirección de regreso no coincide.');
        const verifier = str(p.code_verifier, 128);
        if (
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !sameHash(b64url(createHash('sha256').update(verifier).digest()), row.code_challenge)
        )
          throw oauthError(400, 'invalid_grant', 'La verificación PKCE no coincide.');
        if (p.resource !== undefined && canonical(p.resource) !== row.resource)
          throw oauthError(400, 'invalid_target', 'El recurso no coincide.');
        const grant = repo.grantById.get(row.grant_id);
        const scopes = grant && !grant.revoked_at ? effective(grant) : [];
        if (!scopes.length) throw oauthError(400, 'invalid_grant', 'El permiso ya no es válido.');
        return sendOauth(
          res,
          200,
          transaction(db, () => issue(grant, scopes)),
        );
      }
      if (p.grant_type === 'refresh_token') {
        const refresh = str(p.refresh_token, 100);
        const row = refresh ? repo.tokenByHash.get(sha(refresh)) : null;
        if (!row || row.kind !== 'refresh') throw oauthError(400, 'invalid_grant', 'Ficha de renovación no válida.');
        const grant = repo.grantById.get(row.grant_id);
        if (!grant || grant.revoked_at) throw oauthError(400, 'invalid_grant', 'El permiso fue revocado.');
        if (!clientId || clientId !== grant.client_id)
          throw oauthError(400, 'invalid_grant', 'Ficha de otra aplicación.');
        // Rotación: cada ficha de renovación sirve una vez. Si llega una ya usada, alguien la copió: se revoca todo.
        // Excepción: la inmediatamente anterior, dentro de los 10 segundos de su rotación, es una renovación en paralelo
        // de la propia aplicación; se rechaza sin revocar, para no desconectar a quien ganó.
        const reused = () => {
          const last = repo.lastSpentRefresh.get(grant.id);
          if (last && last.token_hash === row.token_hash && now() - last.used_at <= REFRESH_GRACE_MS)
            return oauthError(400, 'invalid_grant', 'Esta ficha de renovación acaba de usarse; usa la nueva.');
          revokeGrant(grant.id, null, 'refresh_reuse');
          audit(null, 'mcp.oauth.refresh_reuse', grant.id);
          return oauthError(400, 'invalid_grant', 'Esta ficha de renovación ya se usó; el permiso quedó revocado.');
        };
        if (row.used_at) throw reused();
        if (row.expires_at < now()) throw oauthError(400, 'invalid_grant', 'La ficha de renovación venció.');
        if (p.resource !== undefined && canonical(p.resource) !== grant.resource)
          throw oauthError(400, 'invalid_target', 'El recurso no coincide.');
        // Lo que tenía la ficha que se renueva (nunca más) y que la persona todavía puede dar; se puede acotar más.
        let scopes = within(grant, row);
        if (!scopes.length) throw oauthError(400, 'invalid_grant', 'Quien lo autorizó ya no tiene ese acceso.');
        if (typeof p.scope === 'string' && p.scope.trim()) {
          const asked = p.scope
            .trim()
            .split(/\s+/)
            .filter(s => s !== 'offline_access');
          if (asked.some(s => !scopes.includes(s)))
            throw oauthError(400, 'invalid_scope', 'No se puede ampliar el permiso al renovar.');
          if (asked.length) scopes = scopes.filter(s => asked.includes(s));
        }
        // Se gasta al final (una petición mal formada no la quema) y de forma atómica: de dos usos a la vez, uno pierde.
        const issued = transaction(db, () =>
          repo.tokenSpend.run(now(), row.token_hash).changes ? issue(grant, scopes) : null,
        );
        if (!issued) throw reused();
        return sendOauth(res, 200, issued);
      }
      throw oauthError(400, 'unsupported_grant_type', 'Sólo authorization_code y refresh_token.');
    }

    // ---- POST /oauth/register (RFC 7591): sin autenticación por naturaleza; límites por dirección y en total.
    async function register(req, res, ip) {
      rate('oauth-register:' + ip, OAUTH_LIMITS.registerPerHour, 3600_000);
      if (!String(req.headers['content-type'] || '').startsWith('application/json'))
        throw oauthError(400, 'invalid_client_metadata', 'Usa application/json.');
      const input = await readBody(req);
      let meta;
      try {
        meta = validateMetadata(input);
      } catch (e) {
        throw oauthError(
          400,
          e.code === 'invalid_redirect_uri' ? 'invalid_redirect_uri' : 'invalid_client_metadata',
          e.message,
        );
      }
      if (repo.clientCount.get().n >= OAUTH_LIMITS.maxClients)
        throw oauthError(
          503,
          'temporarily_unavailable',
          'Hay demasiadas aplicaciones registradas. Inténtalo más tarde.',
        );
      const id = 'tcc_' + b64url(randomBytes(18));
      const t = now();
      repo.clientInsert.run(id, meta.name, meta.uri, JSON.stringify(meta.redirects), t);
      sendOauth(res, 201, {
        client_id: id,
        client_id_issued_at: Math.floor(t / 1000),
        client_name: meta.name,
        ...(meta.uri ? { client_uri: meta.uri } : {}),
        redirect_uris: meta.redirects,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }

    // ---- POST /oauth/revoke (RFC 7009): responde 200 siempre; revoca todo el permiso de esa ficha.
    async function revoke(req, res, ip) {
      rate('oauth-revoke:' + ip, OAUTH_LIMITS.revokePerMinute);
      const p = await readBody(req);
      const value = str(p.token, 100);
      const row = value ? repo.tokenByHash.get(sha(value)) : null;
      if (row) {
        const grant = repo.grantById.get(row.grant_id);
        if (grant && (!p.client_id || p.client_id === grant.client_id)) revokeGrant(grant.id, null, 'client_revoked');
      }
      sendOauth(res, 200, {});
    }

    async function handlePublic(req, res, path, url, ip) {
      if (missingOrigin && /^\/oauth\/(authorize|decision|token|register|revoke)$/.test(path)) {
        // Producción sin APP_ORIGIN: apagado y diciendo por qué (en el registro, como mucho una vez por minuto).
        if (now() - lastRefusalLog > 60_000) {
          lastRefusalLog = now();
          console.error(REQUIRED);
        }
        sendOauth(res, 503, {
          error: 'temporarily_unavailable',
          error_description: 'La conexión con un clic está apagada en este servidor.',
        });
        return true;
      }
      if (disabled) return false;
      const routes = {
        '/oauth/authorize': ['GET', () => authorize(req, res, url, ip)],
        '/oauth/decision': ['POST', () => decide(req, res, ip)],
        '/oauth/token': ['POST', () => token(req, res, ip)],
        '/oauth/register': ['POST', () => register(req, res, ip)],
        '/oauth/revoke': ['POST', () => revoke(req, res, ip)],
      };
      const route = routes[path];
      if (!route) return false; // /oauth/consent.js y /oauth/consent.css los sirve la carpeta public/
      const machine = path !== '/oauth/authorize' && path !== '/oauth/decision';
      try {
        if (req.method !== route[0]) throw oauthError(405, 'invalid_request', 'Método no permitido.');
        await route[1]();
      } catch (e) {
        if (!machine && !e.oauth) throw e; // la página y la decisión responden con el formato de siempre
        if (!e.status) console.error('OAuth del conector falló:', e?.name);
        const status = e.status || 500;
        sendOauth(res, status === 401 && e.oauth !== 'invalid_client' ? 400 : status, {
          error: e.oauth || (status === 429 ? 'slow_down' : status >= 500 ? 'server_error' : 'invalid_request'),
          error_description: e.status ? e.message : 'Error interno.',
        });
      }
      return true;
    }

    // ---- /mcp: la ficha de acceso del encabezado Authorization. Devuelve un objeto con la forma de una llave de la API
    // (marca, quien la creó, permisos) para que el conector la trate igual.
    function authenticate(req, ip) {
      const m = TOKEN.exec(String(req.headers.authorization || ''));
      const unauthorized = (message, code = 'invalid_token') => fail(401, message, { code });
      if (!m) {
        rate('apibad:' + ip, 30);
        throw unauthorized(
          'Falta la llave de la API o el permiso del asistente (Authorization: Bearer …).',
          'unauthorized',
        );
      }
      const row = repo.tokenByHash.get(sha(m[1]));
      if (!row || row.kind !== 'access') {
        rate('apibad:' + ip, 30);
        throw unauthorized('Permiso no válido o revocado.');
      }
      if (row.expires_at <= now()) throw unauthorized('El permiso caducó: la aplicación debe renovarlo.');
      const grant = repo.grantById.get(row.grant_id);
      if (!grant || grant.revoked_at) throw unauthorized('Permiso revocado.');
      if (grant.resource !== resourceOf(req)) throw unauthorized('Este permiso es para otro recurso.');
      const scopes = within(grant, row);
      if (!scopes.length)
        throw unauthorized('Quien autorizó este asistente ya no tiene acceso a la marca: hay que volver a conectarlo.');
      rate('api:oauth:' + grant.id, API_LIMITS.perKeyPerMinute);
      if (!grant.last_used_at || now() - grant.last_used_at > 60_000) repo.grantUsed.run(now(), grant.id);
      return {
        id: 'oauth:' + grant.id,
        brand_id: grant.brand_id,
        created_by: grant.user_id,
        name: grant.client_name,
        scopes: JSON.stringify(scopes),
        status: 'active',
      };
    }
    // ¿Sigue vigente este permiso, sin ficha de por medio? La misma regla de authenticate para el permiso (no revocado y
    // con algún permiso que la persona aún puede conceder en su marca). Devuelve el objeto con forma de llave o null. La
    // usa el conector para saber si el origen de una propuesta sigue vigente (server/mcp.mjs, sourceActive).
    function grantInUse(grantId) {
      if (disabled || typeof grantId !== 'string') return null;
      const grant = repo.grantById.get(grantId);
      if (!grant || grant.revoked_at) return null;
      const scopes = effective(grant);
      // Con sus permisos vigentes, como el objeto de authenticate: quien pregunta «¿conserva tal permiso?» (la subida de
      // imágenes del conector) los lee de aquí. Sin ellos, una conexión OAuth parecía no tener ninguno.
      return scopes.length
        ? {
            id: 'oauth:' + grant.id,
            brand_id: grant.brand_id,
            created_by: grant.user_id,
            name: grant.client_name,
            scopes: JSON.stringify(scopes),
            status: 'active',
          }
        : null;
    }
    // Cabecera del 401 de /mcp: dónde están los metadatos para empezar el flujo.
    function challenge(req, error) {
      return (
        'Bearer resource_metadata="' +
        metadataUrl(req) +
        '"' +
        (error?.code === 'invalid_token' ? ', error="invalid_token"' : '')
      );
    }

    // ---- pantalla «Asistentes conectados» (con sesión)
    const view = (g, user) => ({
      id: g.id,
      clientName: g.client_name,
      clientHost: g.client_host || null,
      redirectHost: (() => {
        try {
          return new URL(g.redirect_uri).host;
        } catch {
          return null;
        }
      })(),
      brandId: g.brand_id,
      brandName: g.brand_name,
      scopes: JSON.parse(g.scopes).map(s => ({
        key: s,
        label: SCOPES[s] || s,
        kind: SCOPE_KINDS[s] === 'write' ? 'write' : 'read',
      })),
      userName: g.user_name,
      mine: g.user_id === user.id,
      createdAt: g.created_at,
      lastUsedAt: g.last_used_at || null,
    });
    async function handle(req, res, path, user) {
      host.requireStaff(user);
      if (req.method === 'GET' && path === '/api/mcp-oauth/connections') {
        const adminBrands = access.brandIds(user, ADMIN_PERMISSION);
        const rows = adminBrands.length
          ? [
              ...repo.listForBrands(adminBrands),
              ...repo.listForUser(user.id).filter(g => !adminBrands.includes(g.brand_id)),
            ]
          : repo.listForUser(user.id);
        json(res, 200, {
          mcpUrl: disabled ? null : resourceOf(req),
          enabled: !disabled,
          canSeeAll: adminBrands.length > 0,
          connections: rows.map(g => view(g, user)),
        });
        return true;
      }
      const m = path.match(/^\/api\/mcp-oauth\/connections\/([a-f0-9-]{36})\/revoke$/);
      if (m && req.method === 'POST') {
        const g = repo.grantById.get(m[1]);
        if (!g || (g.user_id !== user.id && !access.can(user, ADMIN_PERMISSION, g.brand_id)))
          throw fail(404, 'Conexión no disponible.', { code: 'not_found' });
        if (!g.revoked_at) revokeGrant(g.id, user, 'disconnected');
        json(res, 200, { ok: true });
        return true;
      }
      return false;
    }

    function sweep() {
      const t = now();
      return repo.sweep(t, {
        codesBefore: t - OAUTH_LIMITS.keepSpentMs,
        clientsBefore: t - OAUTH_LIMITS.unusedClientMs,
      });
    }

    return { handle, handlePublic, wellKnown, authenticate, grantInUse, challenge, sweep, enabled: !disabled };
  },
};
