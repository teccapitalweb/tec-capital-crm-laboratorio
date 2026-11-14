import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { backoff } from './automation.mjs';
import { EVENT_TYPES } from './events.mjs';

// API pública de lectura y webhooks salientes (docs/PLAN_API_PUBLICA.md).
//  · API v1 (sólo lectura): llaves por marca con permisos (events, orders, contacts, editions), cabecera `Authorization: Bearer tcw_…`. Sólo se guarda el
//    hash de la llave; el valor completo se muestra una vez. Límite de ritmo por llave y por IP ante llaves malas. Sin sesión ni Origin.
//  · Webhooks salientes: administración registra direcciones HTTPS por marca; cada evento de dominio de esa marca que coincide con el filtro se encola
//    (una fila por destino y evento, idempotente) y un temporizador lo envía FUERA de cualquier transacción, firmado con HMAC-SHA-256, con reintentos
//    de espera creciente y desactivación automática del destino tras muchas fallas seguidas. Los destinos privados o internos se rechazan (SSRF).
const fail = (status, message) => Object.assign(new Error(message), { status });
const safeError = e =>
  String(e?.message || e)
    .replace(/[\x00-\x1f]+/g, ' ')
    .slice(0, 200);
const sha = v => createHash('sha256').update(String(v)).digest('hex');
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const API_VERSION = '1';
export const SUBSCRIBER = 'webhooks.out';
export const SCOPES = {
  events: 'Eventos del negocio',
  orders: 'Pedidos (importes y estados)',
  contacts: 'Contactos (con teléfono y correo)',
  editions: 'Aperturas, precios y cupos',
  // Sólo los usa el conector de Claude (POST /mcp, docs/PLAN_MCP_CLAUDE.md); la API v1 no tiene rutas para ellos.
  conversations: 'Claude: ver conversaciones y mensajes (datos personales)',
  knowledge: 'Claude: leer el conocimiento del asistente y proponer borradores',
  catalog_write: 'Claude: MODIFICAR cursos y aperturas (fecha, docente, precio, cupo, temario)',
};
// Qué permiso (además de `events`) hace falta para ver el CONTENIDO de cada tipo de evento por la API de lectura. Sin él se entrega el sobre (tipo, marca, entidad,
// fecha) con `data` vacío y `redacted: true`. Un tipo sin clasificar se trata como restringido. Los webhooks no se filtran así: los registra administración y es ella
// quien decide qué eventos manda a qué destino.
export const EVENT_NEEDS = {
  'pedido.creado': 'orders',
  'pedido.cupon_aplicado': 'orders',
  'pedido.cancelado': 'orders',
  'pedido.vencido': 'orders',
  'comprobante.recibido': 'orders',
  'pago.confirmado': 'orders',
  'pago.rechazado': 'orders',
  'reembolso.registrado': 'orders',
  'comision.pagada': 'orders',
  'pago.condonado': 'orders',
  'inscripcion.activada': 'orders',
  'inscripcion.cancelada': 'orders',
  'conversacion.abierta': 'contacts',
  'oportunidad.etapa': 'contacts',
  'mensaje.entregado': 'contacts',
  'mensaje.fallido': 'contacts',
  'baja.registrada': 'contacts',
  'persona.fusionada': 'contacts',
  'certificado.emitido': 'contacts',
  'certificado.revocado': 'contacts',
  'encuesta.enviada': 'contacts',
  'encuesta.respondida': 'contacts',
  'historico.importado': 'contacts',
  'apertura.abierta': 'editions',
  'apertura.en_curso': 'editions',
  'apertura.cerrada': 'editions',
  'apertura.cancelada': 'editions',
  'sesion.programada': 'editions',
  'sesion.proxima': 'editions',
  'sesion.realizada': 'editions',
  'sesion.cancelada': 'editions',
  'asistencia.registrada': 'editions',
  'grabacion.disponible': 'editions',
  'catalogo.precio_cambiado': 'editions',
  'edicion.cupo_cambiado': 'editions',
  'edicion.cupo_agotado': 'editions',
  'edicion.cupo_liberado': 'editions',
  'edicion.cupo_bajo': 'editions',
};
export const LIMITS = {
  maxKeys: 20,
  maxEndpoints: 10,
  maxAttempts: 6,
  disableAfter: 15,
  timeoutMs: 8000,
  batch: 10,
  page: 200,
  perKeyPerMinute: 120,
};

// Firma de cada envío: `TC-Signature: t=<unix>,v1=<hex(hmac-sha256(secreto, t + "." + cuerpo))>`. La verificación del lado receptor usa la misma regla.
export function signWebhook(secret, t, raw) {
  return createHmac('sha256', String(secret))
    .update(String(t) + '.' + raw)
    .digest('hex');
}
export function verifyWebhook(secret, header, raw, { now = Date.now, toleranceMs = 5 * 60000 } = {}) {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map(p => p.trim().split('=')),
  );
  if (!secret || !/^\d{10}$/.test(parts.t || '') || Math.abs(now() / 1000 - Number(parts.t)) > toleranceMs / 1000)
    return false;
  const a = Buffer.from(String(parts.v1 || ''), 'utf8'),
    b = Buffer.from(signWebhook(secret, parts.t, raw), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
// Direcciones que no se aceptan como destino: loopback, redes privadas, enlace local (incluye el servicio de metadatos de la nube), CGNAT, multicast y reservadas.
export function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const b = v6bytes(ip);
    if (b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff)
      return isPrivateAddress(b.slice(12).join('.')); // ::ffff:a.b.c.d (IPv4 mapeada)
    if (b.slice(0, 12).every(x => x === 0)) return true; // ::, ::1 y ::a.b.c.d (IPv4 compatible)
    if ((b[0] & 0xe0) !== 0x20) return true; // NEGAR POR OMISIÓN: sólo unicast global 2000::/3 (deja fuera ULA, enlace local, multicast, 64:ff9b::/96 NAT64, 100::/64…)
    if (b[0] === 0x20 && b[1] === 0x01) {
      if (b[2] <= 0x01) return true;
      if (b[2] === 0x0d && b[3] === 0xb8) return true;
    } // 2001::/23 (Teredo y reservadas) y 2001:db8::/32 (documentación)
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(b.slice(2, 6).join('.')); // 6to4: el IPv4 va dentro de la dirección
    if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return true; // 3fff::/20 (documentación)
    return false;
  }
  return true;
}
// IPv6 a 16 bytes (acepta «::», cola con IPv4 y zona). Sólo se llama con direcciones que net.isIP ya validó.
function v6bytes(ip) {
  let s = ip.toLowerCase();
  const z = s.indexOf('%');
  if (z >= 0) s = s.slice(0, z);
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const [a, b, c, d] = m[2].split('.').map(Number);
    s = m[1] + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, rest] = s.split('::'),
    h = head ? head.split(':') : [],
    r = rest === undefined ? [] : rest ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - r.length)).fill('0'), ...r];
  return groups.flatMap(g => {
    const n = parseInt(g || '0', 16);
    return [n >> 8, n & 255];
  });
}
// Valida el destino: HTTPS, sin credenciales, y que el dominio resuelva sólo a direcciones públicas. Se vuelve a comprobar en cada envío (el DNS puede cambiar).
export async function assertPublicUrl(raw, { allowPrivate = false, allowInsecure = false, lookup = dns.lookup } = {}) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw fail(400, 'La dirección del webhook no es válida.');
  }
  if (String(raw).length > 500) throw fail(400, 'La dirección es demasiado larga.');
  if (u.username || u.password) throw fail(400, 'La dirección no puede llevar usuario ni contraseña.');
  if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:'))
    throw fail(400, 'El webhook debe usar HTTPS.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!allowPrivate) {
    if (host === 'localhost' || /\.(localhost|local|internal|lan)$/.test(host))
      throw fail(400, 'La dirección apunta a una red interna; no se permite.');
    let addrs;
    if (net.isIP(host)) addrs = [{ address: host }];
    else {
      try {
        addrs = await lookup(host, { all: true });
      } catch {
        throw fail(400, 'No se pudo resolver el dominio del webhook.');
      }
    }
    if (!addrs.length || addrs.some(a => isPrivateAddress(a.address)))
      throw fail(400, 'La dirección apunta a una red privada o interna; no se permite.');
  }
  return u.toString();
}

export function createIntegrations({
  db,
  crm,
  events,
  body,
  json,
  audit,
  rate,
  now = Date.now,
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
  lookup = dns.lookup,
  baseDelayMs = 5000,
  capDelayMs = 15 * 60000,
  workerId = randomUUID(),
  leaseMs = 45_000,
}) {
  const urlOpts = () => ({
    allowPrivate: env.WEBHOOK_ALLOW_PRIVATE === '1',
    allowInsecure: env.WEBHOOK_ALLOW_PRIVATE === '1',
    lookup,
  });
  const brandName = id => db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name || id;
  const parse = (v, d) => {
    try {
      return JSON.parse(v);
    } catch {
      return d;
    }
  };
  const keyView = r => ({
    id: r.id,
    brandId: r.brand_id,
    brandName: brandName(r.brand_id),
    name: r.name,
    prefix: r.prefix,
    scopes: parse(r.scopes, []),
    status: r.status,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at || null,
    revokedAt: r.revoked_at || null,
  });
  const endpointView = r => {
    const s = db
      .prepare(
        "SELECT sum(state='pending') pending,sum(state='done') done,sum(state='failed') failed,max(updated_at) last FROM webhook_deliveries WHERE endpoint_id=?",
      )
      .get(r.id);
    return {
      id: r.id,
      brandId: r.brand_id,
      brandName: brandName(r.brand_id),
      url: r.url,
      description: r.description,
      events: parse(r.events, ['*']),
      status: r.status,
      failureCount: r.failure_count,
      disabledReason: r.disabled_reason || null,
      revision: r.revision,
      secretHint: '…' + r.secret.slice(-4),
      createdAt: r.created_at,
      stats: { pending: s.pending || 0, done: s.done || 0, failed: s.failed || 0, last: s.last || null },
    };
  };
  const requireAdmin = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'Las integraciones las administra administración.');
  };
  const brandOf = (user, id) => {
    if (typeof id !== 'string' || !db.prepare('SELECT 1 FROM brands WHERE id=?').get(id))
      throw fail(400, 'Elige la marca.');
    crm.requireBrand(user, id);
    return id;
  };
  const newSecret = () => 'whsec_' + randomBytes(24).toString('base64url');

  // ---- llaves de la API
  function createKey(user, input) {
    const brandId = brandOf(user, input.brandId),
      name = text(input.name, 60);
    if (name.length < 2) throw fail(400, 'Ponle un nombre a la llave (para quién o para qué es).');
    const scopes = [...new Set(Array.isArray(input.scopes) ? input.scopes : [])];
    if (!scopes.length || scopes.some(s => !SCOPES[s])) throw fail(400, 'Elige al menos un permiso válido.');
    if (
      db.prepare("SELECT count(*) n FROM api_keys WHERE brand_id=? AND status='active'").get(brandId).n >=
      LIMITS.maxKeys
    )
      throw fail(409, 'Esta marca ya tiene ' + LIMITS.maxKeys + ' llaves activas. Revoca alguna.');
    const token = 'tcw_' + randomBytes(24).toString('base64url'),
      id = randomUUID(),
      t = now();
    db.prepare(
      'INSERT INTO api_keys(id,brand_id,name,prefix,key_hash,scopes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, brandId, name, token.slice(0, 10), sha(token), JSON.stringify(scopes), user.id, t);
    return { key: keyView(db.prepare('SELECT * FROM api_keys WHERE id=?').get(id)), token };
  }
  function revokeKey(user, id) {
    const k = db.prepare('SELECT * FROM api_keys WHERE id=?').get(id);
    if (!k) throw fail(404, 'Llave no disponible.');
    crm.requireBrand(user, k.brand_id);
    if (k.status === 'revoked') throw fail(409, 'La llave ya estaba revocada.');
    db.prepare("UPDATE api_keys SET status='revoked',revoked_at=? WHERE id=?").run(now(), id);
    return keyView(db.prepare('SELECT * FROM api_keys WHERE id=?').get(id));
  }
  // ---- destinos de webhooks
  function eventsFilter(v) {
    const list = [...new Set(Array.isArray(v) && v.length ? v : ['*'])];
    if (list.length > 80 || list.some(t => t !== '*' && !EVENT_TYPES[t]))
      throw fail(400, 'Algún tipo de evento no existe.');
    return list.includes('*') ? ['*'] : list;
  }
  async function createEndpoint(user, input) {
    const brandId = brandOf(user, input.brandId),
      url = await assertPublicUrl(input.url, urlOpts()),
      description = text(input.description, 120),
      list = eventsFilter(input.events);
    if (db.prepare('SELECT count(*) n FROM webhook_endpoints WHERE brand_id=?').get(brandId).n >= LIMITS.maxEndpoints)
      throw fail(409, 'Esta marca ya tiene ' + LIMITS.maxEndpoints + ' destinos. Elimina alguno.');
    const id = randomUUID(),
      secret = newSecret(),
      t = now();
    db.prepare(
      'INSERT INTO webhook_endpoints(id,brand_id,url,description,events,secret,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, brandId, url, description, JSON.stringify(list), secret, user.id, t, t);
    return { endpoint: endpointView(db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id)), secret };
  }
  const endpointOf = (user, id) => {
    const w = db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id);
    if (!w) throw fail(404, 'Destino no disponible.');
    crm.requireBrand(user, w.brand_id);
    return w;
  };
  async function updateEndpoint(user, id, input) {
    const w = endpointOf(user, id);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== w.revision)
      throw fail(409, 'Otra persona cambió este destino. Vuelve a abrirlo.');
    const url = input.url === undefined ? w.url : await assertPublicUrl(input.url, urlOpts()),
      description = input.description === undefined ? w.description : text(input.description, 120),
      list = input.events === undefined ? parse(w.events, ['*']) : eventsFilter(input.events);
    let status = w.status,
      failures = w.failure_count,
      reason = w.disabled_reason;
    if (input.status !== undefined) {
      if (!['active', 'paused'].includes(input.status)) throw fail(400, 'Estado no válido.');
      status = input.status;
      if (status === 'active') {
        failures = 0;
        reason = null;
      }
    }
    const changed = db
      .prepare(
        'UPDATE webhook_endpoints SET url=?,description=?,events=?,status=?,failure_count=?,disabled_reason=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
      )
      .run(url, description, JSON.stringify(list), status, failures, reason, now(), id, w.revision).changes;
    if (!changed) throw fail(409, 'Este destino cambió mientras lo editabas.');
    return endpointView(db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id));
  }
  function rotate(user, id) {
    const w = endpointOf(user, id),
      secret = newSecret();
    db.prepare('UPDATE webhook_endpoints SET secret=?,revision=revision+1,updated_at=? WHERE id=?').run(
      secret,
      now(),
      w.id,
    );
    return { endpoint: endpointView(db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id)), secret };
  }
  function remove(user, id) {
    const w = endpointOf(user, id);
    db.prepare('DELETE FROM webhook_deliveries WHERE endpoint_id=?').run(w.id);
    db.prepare('DELETE FROM webhook_endpoints WHERE id=?').run(w.id);
    return true;
  }
  const deliveriesOf = (user, id) => {
    const w = endpointOf(user, id);
    return db
      .prepare(
        'SELECT d.id,d.state,d.attempts,d.last_status lastStatus,d.error,d.next_attempt_at nextAttemptAt,d.created_at createdAt,d.updated_at updatedAt,e.type,e.seq FROM webhook_deliveries d JOIN domain_events e ON e.seq=d.event_seq WHERE d.endpoint_id=? ORDER BY d.created_at DESC LIMIT 50',
      )
      .all(w.id);
  };
  function retryDelivery(user, id) {
    const d = db
      .prepare(
        'SELECT d.*,w.brand_id FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id WHERE d.id=?',
      )
      .get(id);
    if (!d) throw fail(404, 'Entrega no disponible.');
    crm.requireBrand(user, d.brand_id);
    if (d.state !== 'failed') throw fail(409, 'Sólo se reintenta una entrega fallida.');
    const t = now();
    db.prepare(
      "UPDATE webhook_deliveries SET state='pending',attempts=0,error=NULL,next_attempt_at=?,updated_at=? WHERE id=?",
    ).run(t, t, id);
    return true;
  }

  // ---- envío
  const envelope = ev => ({
    id: 'evt_' + ev.seq,
    type: ev.type,
    createdAt: new Date(ev.created_at).toISOString(),
    brandId: ev.brand_id,
    entity: { kind: ev.entity_kind, id: ev.entity_id },
    data: ev.payload,
    apiVersion: API_VERSION,
  });
  async function post(w, payload, deliveryId) {
    const url = await assertPublicUrl(w.url, urlOpts()),
      raw = JSON.stringify(payload),
      t = String(Math.floor(now() / 1000));
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TEC-Capital-Webhooks/' + API_VERSION,
        'TC-Event': payload.type,
        'TC-Delivery': deliveryId,
        'TC-Timestamp': t,
        'TC-Signature': 't=' + t + ',v1=' + signWebhook(w.secret, t, raw),
      },
      body: raw,
    });
    try {
      await res.body?.cancel();
    } catch {}
    return res.status;
  }
  async function test(user, id) {
    const w = endpointOf(user, id),
      started = now();
    let status = null,
      error = null;
    try {
      status = await post(
        w,
        {
          id: 'evt_test',
          type: 'webhook.test',
          createdAt: new Date(started).toISOString(),
          brandId: w.brand_id,
          entity: { kind: 'webhook', id: w.id },
          data: { message: 'Prueba de conexión desde TEC Capital.' },
          apiVersion: API_VERSION,
        },
        'test-' + randomUUID(),
      );
      if (status < 200 || status >= 300) error = 'El destino respondió ' + status;
    } catch (e) {
      error = safeError(e);
    }
    return { ok: !error, status, error, ms: now() - started };
  }
  // Suscriptor de eventos de dominio: sólo ENCOLA (rápido, local, idempotente); el envío por red lo hace tick().
  function enqueue(ev) {
    const t = now();
    for (const w of db
      .prepare("SELECT id,events FROM webhook_endpoints WHERE brand_id=? AND status='active'")
      .all(ev.brand_id)) {
      const list = parse(w.events, ['*']);
      if (!list.includes('*') && !list.includes(ev.type)) continue;
      db.prepare(
        "INSERT OR IGNORE INTO webhook_deliveries(id,endpoint_id,event_seq,state,attempts,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'pending',0,?,?,?)",
      ).run(randomUUID(), w.id, ev.seq, t, t, t);
    }
  }
  for (const type of Object.keys(EVENT_TYPES)) events.subscribe(type, SUBSCRIBER, enqueue);
  let running = false,
    lastPurge = 0;
  async function tick() {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
      const started = now(),
        due = db
          .prepare(
            "SELECT d.*,w.url,w.secret,w.status wstatus FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id WHERE d.state='pending' AND d.next_attempt_at<=? AND (d.lease_until IS NULL OR d.lease_until<=?) ORDER BY d.next_attempt_at LIMIT ?",
          )
          .all(started, started, LIMITS.batch);
      for (const d of due) {
        // Reclamo con arrendamiento (docs/PLAN_RECEPCION_DURADERA.md): la entrega sigue «pending» mientras se envía;
        // otro proceso no la toma con el arrendamiento vigente y el resultado sólo lo anota quien lo conserva.
        if (
          !db
            .prepare(
              "UPDATE webhook_deliveries SET lease_owner=?,lease_until=? WHERE id=? AND state='pending' AND attempts=? AND (lease_until IS NULL OR lease_until<=?)",
            )
            .run(workerId, now() + leaseMs, d.id, d.attempts, now()).changes
        )
          continue;
        const finish = (state, fields) =>
          db
            .prepare(
              'UPDATE webhook_deliveries SET state=?,attempts=?,last_status=?,error=?,next_attempt_at=?,updated_at=?,lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?',
            )
            .run(
              state,
              fields.attempts,
              fields.status ?? null,
              fields.error ?? null,
              fields.next ?? d.next_attempt_at,
              now(),
              d.id,
              workerId,
            );
        if (d.wstatus !== 'active') {
          finish('failed', {
            attempts: d.attempts,
            error: 'El destino está pausado o desactivado. Reactívalo y reintenta.',
          });
          continue;
        }
        const ev = events.get(d.event_seq);
        if (!ev) {
          finish('failed', { attempts: d.attempts, error: 'El evento ya no existe.' });
          continue;
        }
        const attempt = d.attempts + 1;
        let status = null,
          error = null;
        try {
          status = await post(d, envelope(ev), d.id);
          if (status < 200 || status >= 300) error = 'El destino respondió ' + status;
        } catch (e) {
          error = safeError(e);
        }
        if (!error) {
          finish('done', { attempts: attempt, status });
          db.prepare('UPDATE webhook_endpoints SET failure_count=0 WHERE id=?').run(d.endpoint_id);
          sent++;
        } else if (attempt >= LIMITS.maxAttempts) {
          finish('failed', { attempts: attempt, status, error });
          log.error('Webhook failed:', ev.type, error.slice(0, 80));
          const w = db.prepare('SELECT failure_count FROM webhook_endpoints WHERE id=?').get(d.endpoint_id);
          if (w && w.failure_count + 1 >= LIMITS.disableAfter)
            db.prepare(
              "UPDATE webhook_endpoints SET status='disabled',failure_count=failure_count+1,disabled_reason=?,revision=revision+1,updated_at=? WHERE id=?",
            ).run(
              'Se desactivó tras ' +
                LIMITS.disableAfter +
                ' entregas fallidas seguidas. Revisa el destino y reactívalo.',
              now(),
              d.endpoint_id,
            );
          else db.prepare('UPDATE webhook_endpoints SET failure_count=failure_count+1 WHERE id=?').run(d.endpoint_id);
        } else
          finish('pending', {
            attempts: attempt,
            status,
            error,
            next: now() + backoff(attempt, baseDelayMs, capDelayMs),
          });
      }
      if (now() - lastPurge > 3600e3) {
        lastPurge = now();
        db.prepare(
          "DELETE FROM webhook_deliveries WHERE (state='done' AND updated_at<?) OR (state='failed' AND updated_at<?)",
        ).run(now() - 7 * 86400e3, now() - 30 * 86400e3);
      }
      return sent;
    } finally {
      running = false;
    }
  }

  // ---- API v1 (lectura), pública con llave
  const cursor = v => {
    const m = String(v || '').match(/^(\d+)(?::([a-f0-9-]{8,40}))?$/);
    return m ? { ts: Number(m[1]), id: m[2] || '' } : { ts: 0, id: '' };
  };
  const limitOf = v => Math.min(LIMITS.page, Math.max(1, Number(v) || 100));
  const need = (key, scope) => {
    if (!parse(key.scopes, []).includes(scope)) throw fail(403, 'Esta llave no tiene el permiso «' + scope + '».');
  };
  // Llave de la cabecera Authorization: la usan la API v1 y el conector de Claude. Los intentos con llaves falsas se frenan por IP.
  function authenticate(req, ip) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(tcw_[A-Za-z0-9_-]{20,64})$/);
    if (!m) {
      rate('apibad:' + ip, 30);
      throw fail(401, 'Falta la llave de la API (Authorization: Bearer tcw_…).');
    }
    const key = db.prepare("SELECT * FROM api_keys WHERE key_hash=? AND status='active'").get(sha(m[1]));
    if (!key) {
      rate('apibad:' + ip, 30);
      throw fail(401, 'Llave no válida o revocada.');
    }
    rate('api:' + key.id, LIMITS.perKeyPerMinute);
    if (!key.last_used_at || now() - key.last_used_at > 60000)
      db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), key.id);
    return key;
  }
  async function handlePublic(req, res, path, url, ip) {
    if (!path.startsWith('/api/v1/')) return false;
    if (req.method !== 'GET') throw fail(405, 'La API v1 es de sólo lectura por ahora.');
    const key = authenticate(req, ip);
    const q = url.searchParams,
      limit = limitOf(q.get('limit')),
      brand = key.brand_id;
    if (path === '/api/v1/me') {
      json(res, 200, {
        apiVersion: API_VERSION,
        brand: { id: brand, name: brandName(brand) },
        key: { name: key.name, prefix: key.prefix },
        scopes: parse(key.scopes, []),
        eventTypes: Object.keys(EVENT_TYPES),
        eventScopes: EVENT_NEEDS,
      });
      return true;
    }
    if (path === '/api/v1/events') {
      need(key, 'events');
      const after = Number(q.get('after')) || 0,
        type = q.get('type'),
        have = parse(key.scopes, []);
      if (type && !EVENT_TYPES[type]) throw fail(400, 'Tipo de evento no existe.');
      const rows = db
        .prepare(
          'SELECT * FROM domain_events WHERE brand_id=? AND seq>?' +
            (type ? ' AND type=?' : '') +
            ' ORDER BY seq LIMIT ?',
        )
        .all(...[brand, after, ...(type ? [type] : []), limit])
        .map(e => {
          const ok = have.includes(EVENT_NEEDS[e.type]),
            env = envelope({ ...e, payload: ok ? parse(e.payload, {}) : {} });
          return { ...env, seq: e.seq, ...(ok ? {} : { redacted: true, requires: EVENT_NEEDS[e.type] || null }) };
        });
      json(res, 200, { events: rows, next: rows.length ? rows.at(-1).seq : after, hasMore: rows.length === limit });
      return true;
    }
    if (path === '/api/v1/orders') {
      need(key, 'orders');
      const c = cursor(q.get('after')),
        status = q.get('status');
      if (status && !['pending', 'review', 'paid', 'cancelled', 'expired'].includes(status))
        throw fail(400, 'Estado no válido.');
      const rows = db
        .prepare(
          'SELECT id,reference,status,amount_cents,currency,contact_id,course_id,edition_id,promotion_id,coupon_code,discount_cents,method,plan,kind,source,created_at,paid_at,updated_at FROM orders WHERE brand_id=? AND (updated_at>? OR (updated_at=? AND id>?))' +
            (status ? ' AND status=?' : '') +
            ' ORDER BY updated_at,id LIMIT ?',
        )
        .all(...[brand, c.ts, c.ts, c.id, ...(status ? [status] : []), limit]);
      json(res, 200, {
        orders: rows.map(o => ({
          id: o.id,
          reference: o.reference,
          status: o.status,
          amountCents: o.amount_cents,
          discountCents: o.discount_cents,
          couponCode: o.coupon_code || null,
          currency: o.currency,
          contactId: o.contact_id,
          courseId: o.course_id,
          editionId: o.edition_id,
          method: o.method || null,
          plan: o.plan,
          kind: o.kind,
          source: o.source,
          createdAt: o.created_at,
          paidAt: o.paid_at || null,
          updatedAt: o.updated_at,
        })),
        next: rows.length ? rows.at(-1).updated_at + ':' + rows.at(-1).id : q.get('after') || null,
        hasMore: rows.length === limit,
      });
      return true;
    }
    if (path === '/api/v1/contacts') {
      need(key, 'contacts');
      const c = cursor(q.get('after'));
      const rows = db
        .prepare(
          'SELECT id,name,phone,email,source,created_at,updated_at FROM contacts WHERE brand_id=? AND (updated_at>? OR (updated_at=? AND id>?)) ORDER BY updated_at,id LIMIT ?',
        )
        .all(brand, c.ts, c.ts, c.id, limit);
      json(res, 200, {
        contacts: rows.map(x => ({
          id: x.id,
          name: x.name,
          phone: x.phone || null,
          email: x.email || null,
          source: x.source,
          createdAt: x.created_at,
          updatedAt: x.updated_at,
        })),
        next: rows.length ? rows.at(-1).updated_at + ':' + rows.at(-1).id : q.get('after') || null,
        hasMore: rows.length === limit,
      });
      return true;
    }
    if (path === '/api/v1/editions') {
      need(key, 'editions');
      const rows = db
        .prepare(
          "SELECT e.id,e.course_id,k.title course_title,e.name,e.starts_at,e.ends_at,e.modality,e.capacity,e.available_seats,e.price_cents,e.currency,e.status,e.info_url,e.updated_at FROM editions e JOIN courses k ON k.id=e.course_id WHERE e.brand_id=? AND e.status='published' ORDER BY e.starts_at,e.id LIMIT ?",
        )
        .all(brand, limit);
      json(res, 200, {
        editions: rows.map(e => ({
          id: e.id,
          courseId: e.course_id,
          courseTitle: e.course_title,
          name: e.name,
          startsAt: e.starts_at || null,
          endsAt: e.ends_at || null,
          modality: e.modality,
          capacity: e.capacity ?? null,
          availableSeats: e.available_seats ?? null,
          priceCents: e.price_cents,
          currency: e.currency,
          infoUrl: e.info_url || null,
          updatedAt: e.updated_at,
        })),
      });
      return true;
    }
    throw fail(404, 'Ruta de la API no encontrada.');
  }

  // ---- administración (con sesión, sólo administración)
  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/integrations')) return false;
    if (user.role === 'customer') throw fail(403, 'Las integraciones son para administración.');
    requireAdmin(user);
    const p = new URL(req.url, 'http://x').searchParams;
    let x;
    if (path === '/api/integrations' && req.method === 'GET') {
      const brand = p.get('brand');
      if (brand && !db.prepare('SELECT 1 FROM brands WHERE id=?').get(brand)) throw fail(404, 'Marca no disponible.');
      if (brand) crm.requireBrand(user, brand);
      const keys = (
        brand
          ? db.prepare('SELECT * FROM api_keys WHERE brand_id=? ORDER BY created_at DESC').all(brand)
          : db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all()
      )
        .filter(k => crm.canBrand(user, k.brand_id))
        .map(keyView);
      const endpoints = (
        brand
          ? db.prepare('SELECT * FROM webhook_endpoints WHERE brand_id=? ORDER BY created_at DESC').all(brand)
          : db.prepare('SELECT * FROM webhook_endpoints ORDER BY created_at DESC').all()
      )
        .filter(w => crm.canBrand(user, w.brand_id))
        .map(endpointView);
      json(res, 200, {
        keys,
        endpoints,
        scopes: SCOPES,
        eventTypes: Object.entries(EVENT_TYPES).map(([type, t]) => ({ type, title: t.title, entity: t.entity })),
        apiVersion: API_VERSION,
      });
      return true;
    }
    if (path === '/api/integrations/keys' && req.method === 'POST') {
      rate('integ:' + user.id, 30);
      const out = createKey(user, await body(req));
      audit(user, 'apikey.create', out.key.id);
      json(res, 201, out);
      return true;
    }
    if ((x = path.match(/^\/api\/integrations\/keys\/([a-f0-9-]+)\/revoke$/)) && req.method === 'POST') {
      const k = revokeKey(user, x[1]);
      audit(user, 'apikey.revoke', x[1]);
      json(res, 200, { key: k });
      return true;
    }
    if (path === '/api/integrations/webhooks' && req.method === 'POST') {
      rate('integ:' + user.id, 30);
      const out = await createEndpoint(user, await body(req));
      audit(user, 'webhook.create', out.endpoint.id);
      json(res, 201, out);
      return true;
    }
    if ((x = path.match(/^\/api\/integrations\/webhooks\/([a-f0-9-]+)(?:\/(rotate|test|deliveries))?$/))) {
      const id = x[1],
        act = x[2];
      if (!act && req.method === 'PATCH') {
        const e = await updateEndpoint(user, id, await body(req));
        audit(user, 'webhook.update', id);
        json(res, 200, { endpoint: e });
        return true;
      }
      if (!act && req.method === 'DELETE') {
        remove(user, id);
        audit(user, 'webhook.delete', id);
        json(res, 200, { ok: true });
        return true;
      }
      if (act === 'rotate' && req.method === 'POST') {
        const out = rotate(user, id);
        audit(user, 'webhook.rotate', id);
        json(res, 200, out);
        return true;
      }
      if (act === 'test' && req.method === 'POST') {
        rate('integ-test:' + user.id, 20);
        json(res, 200, await test(user, id));
        return true;
      }
      if (act === 'deliveries' && req.method === 'GET') {
        json(res, 200, { deliveries: deliveriesOf(user, id) });
        return true;
      }
    }
    if ((x = path.match(/^\/api\/integrations\/deliveries\/([a-f0-9-]+)\/retry$/)) && req.method === 'POST') {
      retryDelivery(user, x[1]);
      audit(user, 'webhook.retry', x[1]);
      json(res, 200, { ok: true });
      return true;
    }
    throw fail(404, 'Ruta de integraciones no encontrada.');
  }
  return {
    handle,
    handlePublic,
    tick,
    enqueue,
    createKey,
    test,
    authenticate,
    scopesOf: key => parse(key.scopes, []),
    scopeName: s => SCOPES[s] || s,
  };
}
