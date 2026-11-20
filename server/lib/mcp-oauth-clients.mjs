// Identidad de las aplicaciones que piden permiso para usar el conector MCP con OAuth (docs/PLAN_MCP_OAUTH.md).
//
// Dos maneras de presentarse, las dos sin secreto (clientes públicos con PKCE):
//  · Documento de metadatos del cliente (Client ID Metadata Document): el `client_id` es una dirección HTTPS y el CRM
//    descarga de ahí un JSON con el nombre y las direcciones de regreso. Es una petición a una dirección que eligió
//    quien llama, así que se defiende igual que los webhooks salientes (server/integrations.mjs) y un poco más:
//    sólo HTTPS al puerto 443, sin usuario ni contraseña, sin redirecciones, sin direcciones internas (se comprueban
//    EN LA CONEXIÓN, con la dirección que de verdad se usa, para que un DNS que cambia no cuele una red privada),
//    con tiempo máximo y tamaño máximo, y con caché acotada.
//  · Registro dinámico (RFC 7591): la aplicación manda los mismos datos por POST y el CRM le da un `client_id` propio.
//
// Aquí sólo se valida y se descarga; las rutas, los límites por dirección y la base están en server/modules/mcp-oauth.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { fail } from '../app/http.mjs';
import { isPrivateAddress } from '../integrations.mjs';

export const CLIENT_LIMITS = Object.freeze({
  nameMax: 80,
  uriMax: 300,
  redirectMax: 500,
  redirects: 10,
  documentBytes: 16 * 1024,
  fetchTimeoutMs: 5000,
  cacheEntries: 100,
  cacheMinMs: 60_000,
  cacheMaxMs: 3600_000,
  cacheDefaultMs: 600_000,
});

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const clean = (v, max) =>
  typeof v === 'string'
    ? v
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

// ¿Dirección de regreso aceptable? HTTPS, o http sólo hacia esta misma computadora (aplicaciones de escritorio y de
// terminal, RFC 8252). Sin fragmento, sin usuario ni contraseña. Devuelve la URL o null.
export function parseRedirect(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > CLIENT_LIMITS.redirectMax || /[\s\x00-\x1f]/.test(raw))
    return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hash || raw.includes('#') || u.username || u.password) return null;
  if (u.protocol === 'https:') return u.hostname ? u : null;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u;
  return null;
}
export const isLoopback = u => u.protocol === 'http:' && LOOPBACK.has(u.hostname);

// ¿La dirección pedida es una de las registradas? Comparación EXACTA del texto; la única excepción es la de las
// aplicaciones locales: en http://127.0.0.1 / localhost el puerto cambia en cada arranque y no cuenta (RFC 8252 §7.3),
// pero el nombre del equipo, la ruta y la consulta sí.
export function redirectAllowed(registered, asked) {
  const u = parseRedirect(asked);
  if (!u) return false;
  for (const r of registered) {
    if (r === asked) return true;
    const v = parseRedirect(r);
    if (
      v &&
      isLoopback(v) &&
      isLoopback(u) &&
      v.hostname === u.hostname &&
      v.pathname === u.pathname &&
      v.search === u.search
    )
      return true;
  }
  return false;
}

// Metadatos de una aplicación, de un registro dinámico o de su documento. Lo que no se entiende se rechaza; lo que no
// se usa se ignora. El nombre y el sitio son lo que LA APLICACIÓN DICE de sí misma: se muestran como tales.
export function validateMetadata(input, { document = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw fail(400, 'Los datos de la aplicación no son válidos.', { code: 'invalid_client_metadata' });
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > CLIENT_LIMITS.redirects)
    throw fail(400, 'Faltan las direcciones de regreso (redirect_uris), de 1 a 10.', {
      code: 'invalid_redirect_uri',
    });
  const redirects = [];
  for (const r of uris) {
    if (!parseRedirect(r))
      throw fail(400, 'Cada dirección de regreso debe ser https:// o http://127.0.0.1 / localhost, sin fragmento.', {
        code: 'invalid_redirect_uri',
      });
    if (!redirects.includes(r)) redirects.push(r);
  }
  const grants = input.grant_types ?? ['authorization_code'];
  if (
    !Array.isArray(grants) ||
    !grants.includes('authorization_code') ||
    grants.some(g => !['authorization_code', 'refresh_token'].includes(g))
  )
    throw fail(400, 'Sólo se admite authorization_code (con refresh_token).', { code: 'invalid_client_metadata' });
  const responses = input.response_types ?? ['code'];
  if (!Array.isArray(responses) || responses.some(r => r !== 'code'))
    throw fail(400, 'Sólo se admite response_type=code.', { code: 'invalid_client_metadata' });
  // Un documento que dice autenticarse con firma o secreto no es un cliente público: no se puede atender sin secreto.
  const auth = input.token_endpoint_auth_method;
  if (document && auth !== undefined && auth !== 'none')
    throw fail(400, 'Sólo se admiten aplicaciones públicas (token_endpoint_auth_method=none).', {
      code: 'invalid_client_metadata',
    });
  let uri = null;
  if (input.client_uri !== undefined && input.client_uri !== null && input.client_uri !== '') {
    const raw = clean(input.client_uri, CLIENT_LIMITS.uriMax + 1);
    let u = null;
    try {
      u = new URL(raw);
    } catch {}
    if (!u || u.protocol !== 'https:' || raw.length > CLIENT_LIMITS.uriMax || u.username || u.password)
      throw fail(400, 'client_uri debe ser una dirección https://.', { code: 'invalid_client_metadata' });
    uri = u.origin;
  }
  const name = clean(input.client_name, CLIENT_LIMITS.nameMax);
  if (!document && name.length < 2)
    throw fail(400, 'Falta el nombre de la aplicación (client_name).', { code: 'invalid_client_metadata' });
  return { name, uri, redirects };
}

// Descarga y comprueba el documento de metadatos de `clientId`. `allowLocal` sólo existe para las pruebas (la
// aplicación de mentira escucha en 127.0.0.1); el módulo nunca lo enciende en producción.
export function createMetadataFetcher({
  allowLocal = false,
  lookup = dns.lookup,
  now = Date.now,
  timeoutMs = CLIENT_LIMITS.fetchTimeoutMs,
} = {}) {
  const cache = new Map();

  // ¿Este client_id es una dirección de documento que el CRM aceptaría descargar? Devuelve la URL o lanza.
  function documentUrl(clientId) {
    const bad = () => fail(400, 'La dirección de la aplicación no es válida.', { code: 'invalid_client' });
    if (typeof clientId !== 'string' || clientId.length > CLIENT_LIMITS.uriMax) throw bad();
    let u;
    try {
      u = new URL(clientId);
    } catch {
      throw bad();
    }
    if (u.username || u.password || u.hash || clientId.includes('#')) throw bad();
    if (u.pathname === '/' || !u.pathname) throw bad(); // el documento lleva ruta (no es la raíz del sitio)
    if (u.toString() !== clientId) throw bad(); // sin formas raras: el texto ya es la forma canónica
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (allowLocal) {
      if (!['https:', 'http:'].includes(u.protocol)) throw bad();
      return u;
    }
    if (u.protocol !== 'https:' || u.port !== '') throw bad(); // sólo HTTPS al puerto 443
    if (
      net.isIP(host) ||
      host === 'localhost' ||
      !host.includes('.') ||
      /\.(localhost|local|internal|lan|home|corp)$/.test(host)
    )
      throw bad();
    return u;
  }

  // Resolución que comprueba la dirección en el momento de conectar (no antes): así no hay ventana entre comprobar
  // y usar que un DNS de corta vida pueda aprovechar.
  const guardedLookup = (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
      if (!list.length || (!allowLocal && list.some(a => isPrivateAddress(a.address))))
        return callback(Object.assign(new Error('Dirección interna rechazada.'), { code: 'EPRIVATE' }));
      if (options?.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };

  function download(u) {
    return new Promise((resolve, reject) => {
      const lib = u.protocol === 'https:' ? https : http;
      let settled = false;
      const done = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const req = lib.request(
        u,
        {
          method: 'GET',
          lookup: guardedLookup,
          headers: { Accept: 'application/json', 'User-Agent': 'crm-mcp-oauth/1' },
          agent: false,
        },
        res => {
          if (res.statusCode !== 200) {
            res.resume();
            return done(fail(400, 'El documento de la aplicación no respondió 200 (no se siguen redirecciones).'));
          }
          const declared = Number(res.headers['content-length']);
          if (declared > CLIENT_LIMITS.documentBytes) {
            res.destroy();
            return done(fail(400, 'El documento de la aplicación es demasiado grande.'));
          }
          const chunks = [];
          let size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > CLIENT_LIMITS.documentBytes) {
              res.destroy();
              done(fail(400, 'El documento de la aplicación es demasiado grande.'));
            } else chunks.push(chunk);
          });
          res.on('end', () =>
            done(null, { text: Buffer.concat(chunks).toString('utf8'), cacheControl: res.headers['cache-control'] }),
          );
          res.on('error', () => done(fail(400, 'No se pudo leer el documento de la aplicación.')));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        done(fail(400, 'El documento de la aplicación tardó demasiado.'));
      }, timeoutMs);
      req.on('error', error =>
        done(
          error?.code === 'EPRIVATE'
            ? fail(400, 'La dirección de la aplicación apunta a una red interna; no se permite.')
            : fail(400, 'No se pudo descargar el documento de la aplicación.'),
        ),
      );
      req.end();
    });
  }

  const ttlOf = header => {
    const m = /max-age=(\d+)/i.exec(String(header || ''));
    const ms = m ? Number(m[1]) * 1000 : CLIENT_LIMITS.cacheDefaultMs;
    return Math.min(CLIENT_LIMITS.cacheMaxMs, Math.max(CLIENT_LIMITS.cacheMinMs, ms));
  };

  // { name, uri, redirects, host }: el nombre declarado y el dominio que publica el documento (ése sí es verificable).
  async function fetchClient(clientId) {
    const u = documentUrl(clientId);
    const hit = cache.get(clientId);
    if (hit && hit.until > now()) return hit.client;
    const { text, cacheControl } = await download(u);
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw fail(400, 'El documento de la aplicación no es JSON.', { code: 'invalid_client' });
    }
    if (!doc || typeof doc !== 'object' || doc.client_id !== clientId)
      throw fail(400, 'El documento de la aplicación no corresponde a su dirección (client_id).', {
        code: 'invalid_client',
      });
    const meta = validateMetadata(doc, { document: true });
    const client = { ...meta, name: meta.name || u.hostname, host: u.hostname };
    if (cache.size >= CLIENT_LIMITS.cacheEntries) cache.delete(cache.keys().next().value);
    cache.set(clientId, { client, until: now() + ttlOf(cacheControl) });
    return client;
  }
  return { fetchClient, documentUrl, cacheSize: () => cache.size };
}
