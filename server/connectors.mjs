import { createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { createWebhookInbox } from './app/webhook-inbox.mjs';
import { createPeerHash, loadPeerKey } from './lib/peer-key.mjs';

// Contrato de conectores (Fase 1 · bloque 6). Define la interfaz que tendrán los proveedores reales de canal (Meta:
// WhatsApp Cloud API, Instagram, Messenger) y de pago (Stripe, Conekta), y la cumple hoy con adaptadores simulados.
// El CRM sólo habla con esta interfaz: cuando una consultora entregue sus accesos se cambia el proveedor por entorno
// (CHANNEL_CONNECTOR / PAYMENT_CONNECTOR) sin tocar el resto del código. Los webhooks entran por rutas públicas,
// se verifica su firma con el secreto del proveedor, se traducen a eventos normalizados y se aplican una sola vez.
//
// Eventos normalizados (lo que el resto del CRM entiende):
//   {id, type:'message.status',  data:{providerRef, state:'sent'|'delivered'|'read'|'failed', reason?, at?}}
//   {id, type:'message.inbound', data:{channel, from, text, providerRef, referral?}}   (se registra; el laboratorio no mapea identidades)
//   {id, type:'payment.succeeded', data:{orderId?|reference?, providerRef, method?, amountCents?}}
//   {id, type:'payment.failed',    data:{orderId?|reference?, providerRef, reason?}}
// Contrato 1.1 (docs/PLAN_CONTRATO_CANAL.md): todo aditivo, las claves de 1.0 se conservan y las nuevas sólo viajan
// cuando el proveedor las dio.
//   message.inbound  + peer:{ids:[{kind:'wa_phone'|'wa_bsuid'|'wa_parent_bsuid', value}], name, username}
//                    + account:{provider, externalId (número que recibe), scopeId (cuenta), displayPhone}
//                    + replyTo:{providerRef} · forwarded · interaction:{kind:'button'|'list'|'template_button', id,
//                      title, payload, description} · reaction:{emoji, providerRef} · media.voice · location · contacts
//                    + system:{kind, newPhone, newUserId}
//   message.status   + code (número del fallo) · detail · pricing:{billable, category, type, model} · callback
//                    + recipient:{phone, userId} · account
//   template.update  {account, scopeId, templateId, name, language, field:'status'|'quality'|'category', value, previous, reason}
//   account.update   {account, scopeId, field:'status'|'quality'|'limit'|'name'|'review'|'restriction'|'capability'|'alert', value, previous, details}
//   user.preference  {account, scopeId, peer, category, value:'stop'|'resume', at}
export const CONTRACT_VERSION = '1.1';
// Versiones que el lector de la bandeja entiende: una carga guardada con cualquiera de ellas se procesa.
export const CONTRACT_VERSIONS = Object.freeze(['1.0', '1.1']);
const fail = (status, message) => Object.assign(new Error(message), { status });
const hex = n => randomBytes(n).toString('hex');
export const FAILURES = [
  'El número no está disponible en el canal simulado',
  'El proveedor simulado rechazó el mensaje por límite de velocidad',
  'Tiempo de espera agotado en el proveedor simulado',
];
export function hmacHex(secret, raw) {
  return createHmac('sha256', String(secret)).update(raw).digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'),
    y = Buffer.from(String(b || ''), 'utf8');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
const missingOf = (env, names) => names.filter(n => !String(env[n] || '').trim());

// ---- Bandeja de entrada de webhooks (docs/PLAN_RECEPCION_DURADERA.md): quién escribe y carril de orden de un evento.
// Primer identificador de quien escribe. Con el contrato 1.1 vendrá en data.peer.ids (teléfono o identificador de
// usuario); mientras parseWebhook no lo entregue es el campo suelto de hoy (from). Vacío: no se sabe quién escribe.
export function peerIdentifier(data) {
  for (const id of Array.isArray(data?.peer?.ids) ? data.peer.ids : []) {
    const value = String((id && typeof id === 'object' ? id.value : id) ?? '').trim();
    if (value) return value;
  }
  return String(data?.from ?? data?.fromUserId ?? '').trim();
}
// Dentro de un carril los eventos se procesan de uno en uno y en orden de llegada; carriles distintos, a la vez.
//   entrante de canal   in:<proveedor>:<número o cuenta que recibe>:<huella del primer identificador de quien escribe>
//   estado de mensaje   st:<proveedor>:<referencia del mensaje>
//   pago                pay:<proveedor>:<pedido, referencia o id del evento>
//   cualquier otro      ev:<proveedor>:<id del evento>
// El identificador de la persona va como huella CON LLAVE (`peerHash`, de server/lib/peer-key.mjs): el carril sólo se
// compara, se queda en la fila después de vaciar la carga y no debe permitir recuperar el teléfono.
export function laneOf(kind, provider, ev, peerHash) {
  if (typeof peerHash !== 'function') throw new TypeError('laneOf necesita la huella con llave (peerHash).');
  const d = ev?.data || {};
  if (kind === 'channel' && ev.type === 'message.inbound') {
    const who = peerIdentifier(d);
    if (who) return 'in:' + provider + ':' + String(d.account?.externalId ?? d.to ?? '') + ':' + peerHash(who);
  }
  if (kind === 'channel' && ev.type === 'message.status' && d.providerRef)
    return 'st:' + provider + ':' + d.providerRef;
  if (kind === 'payment') return 'pay:' + provider + ':' + (d.orderId || d.reference || ev.id);
  return 'ev:' + provider + ':' + ev.id;
}
// Cuánto espera la petición del webhook a que sus eventos terminen, para devolver su resultado como siempre.
// WEBHOOK_INBOX_WAIT_MS: 0 = responder en cuanto se guardan. Siempre por debajo de los 10 s del botón «Probar webhook».
export function inboxWaitMs(env) {
  const raw = String(env.WEBHOOK_INBOX_WAIT_MS ?? '').trim(),
    n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(9000, n) : env.NODE_ENV === 'test' ? 8000 : 3000;
}

// ---- Lector tolerante de la bandeja (docs/PLAN_CONTRATO_CANAL.md). La carga se guarda como {v, event}: v es la
// versión del contrato con la que se recibió. Se procesan las versiones de la misma familia (1.0, 1.1 y cualquier 1.x
// posterior, que sólo añade claves) y la forma sin sobre; una de otra familia (2.x, escrita por un despliegue más
// nuevo) queda en cuarentena para que la procese el código que la entiende.
const permanentError = message => Object.assign(new Error(message), { permanent: true });
const family = v => String(v).split('.')[0];
export function readStoredEvent(stored, provider = '') {
  const wrapped = Boolean(stored && typeof stored === 'object' && 'event' in stored);
  const v = wrapped ? String(stored.v ?? '1.0') : '1.0',
    event = wrapped ? stored.event : stored;
  if (!event || typeof event !== 'object') throw permanentError('El evento guardado no se puede leer.');
  if (family(v) !== family(CONTRACT_VERSION)) throw permanentError('contract_version');
  return { v, event: withContract(event, provider) };
}
// Completa un entrante con la forma 1.1 aunque se haya guardado con 1.0 o el proveedor no diera más datos: `peer.ids`
// lleva al menos el teléfono de `from`, y `account` el número que recibe. Las claves de 1.0 no se tocan.
export function withContract(ev, provider = '') {
  if (ev?.type !== 'message.inbound' || !ev.data || typeof ev.data !== 'object') return ev;
  const d = ev.data,
    phone = String(d.from ?? '').trim();
  const peer =
    d.peer && Array.isArray(d.peer.ids)
      ? d.peer
      : { ids: phone ? [{ kind: 'wa_phone', value: phone }] : [], name: d.name || null, username: null };
  const account =
    d.account ??
    (d.to
      ? {
          provider: provider === 'meta' ? 'meta-whatsapp' : provider || null,
          externalId: String(d.to),
          scopeId: null,
          displayPhone: null,
        }
      : null);
  return { ...ev, data: { ...d, peer, ...(account ? { account } : {}) } };
}
// Lo que queda en la bitácora de conectores: de un entrante, sólo metadatos; de un estado o un aviso de preferencias,
// el número de la persona enmascarado (nunca el teléfono ni el identificador completos).
const tail = v => (v ? '…' + String(v).slice(-4) : null);
function loggable(ev) {
  const d = ev?.data;
  if (!d || typeof d !== 'object') return ev;
  if (ev.type === 'message.status' && d.recipient)
    return { ...ev, data: { ...d, recipient: { phone: tail(d.recipient.phone), userId: tail(d.recipient.userId) } } };
  if (ev.type === 'user.preference')
    return {
      ...ev,
      data: { ...d, peer: { ids: (d.peer?.ids || []).map(id => ({ kind: id.kind, value: tail(id.value) })) } },
    };
  return ev;
}

// Qué debe entregar cada consultora (o el equipo técnico) para encender un proveedor real. Es la fuente de docs/CONECTORES.md.
export const REQUIREMENTS = {
  meta: {
    label: 'Meta · WhatsApp Cloud API, Instagram y Messenger',
    kind: 'channel',
    items: [
      {
        env: 'META_ACCESS_TOKEN',
        title: 'Token permanente de usuario de sistema',
        who: 'Consultora (administrador del Business Manager)',
        note: 'Con permisos whatsapp_business_messaging, whatsapp_business_management, pages_messaging e instagram_manage_messages, asignado a la WABA, la página y la cuenta de Instagram.',
      },
      {
        env: 'META_APP_SECRET',
        title: 'Secreto de la app de Meta',
        who: 'Equipo técnico',
        note: 'Con él se verifica la firma X-Hub-Signature-256 de cada webhook.',
      },
      {
        env: 'META_VERIFY_TOKEN',
        title: 'Token de verificación del webhook',
        who: 'Equipo técnico',
        note: 'Cadena que elegimos nosotros; Meta la repite al registrar la URL del webhook.',
      },
      {
        env: 'META_PHONE_NUMBER_ID',
        title: 'ID del número de WhatsApp',
        who: 'Consultora',
        note: 'Número dedicado (no puede seguir en la app WhatsApp Business del celular), con nombre para mostrar aprobado.',
      },
      {
        env: 'META_WABA_ID',
        title: 'ID de la cuenta de WhatsApp Business (WABA)',
        who: 'Consultora',
        optional: true,
        note: 'No hace falta para enviar y recibir; sí para mandar plantillas a aprobación y sincronizar su estado.',
      },
      {
        env: 'META_PAGE_ID',
        title: 'ID de la página de Facebook',
        who: 'Consultora',
        optional: true,
        note: 'Página conectada a la app, con la pestaña de mensajes habilitada.',
      },
      {
        env: 'META_IG_ACCOUNT_ID',
        title: 'ID de la cuenta profesional de Instagram',
        who: 'Consultora',
        optional: true,
        note: 'Cuenta profesional vinculada a la página; «Permitir acceso a mensajes» activado en la app de Instagram.',
      },
    ],
    notes: [
      'WhatsApp real ya envía y recibe (texto, botones, imágenes, PDF y plantillas aprobadas) con CHANNEL_CONNECTOR=meta; cada número se asigna a su marca en Operación → Conectores. Instagram y Messenger llegan después.',
      'La ventana de servicio de 24 h es la misma regla que ya se simula: el equipo no notará el cambio.',
      'Las conversaciones del laboratorio (perfiles de prueba) siguen simuladas aunque Meta esté activo.',
      'Meta cobra por mensaje según categoría; el costo estimado del modo presentación usa tarifas orientativas.',
    ],
  },
  stripe: {
    label: 'Stripe · tarjeta, OXXO y SPEI',
    kind: 'payment',
    items: [
      {
        env: 'STRIPE_SECRET_KEY',
        title: 'Clave secreta (modo prueba primero)',
        who: 'Consultora o administración',
        note: 'Cuenta Stripe de la razón social que factura; sk_test_… para ensayar, sk_live_… para cobrar.',
      },
      {
        env: 'STRIPE_WEBHOOK_SECRET',
        title: 'Secreto del endpoint de webhook',
        who: 'Equipo técnico',
        note: 'whsec_… del endpoint registrado para checkout.session.completed y pagos fallidos.',
      },
    ],
    notes: [
      'Los métodos OXXO y SPEI se habilitan en el panel de Stripe (México).',
      'El CRM crea la sesión de pago con la referencia del pedido en metadata y confirma sólo con el webhook firmado, nunca con el regreso del navegador.',
    ],
  },
  conekta: {
    label: 'Conekta · tarjeta, OXXO Pay y SPEI',
    kind: 'payment',
    items: [
      {
        env: 'CONEKTA_PRIVATE_KEY',
        title: 'Llave privada (sandbox primero)',
        who: 'Consultora o administración',
        note: 'Cuenta Conekta de la razón social que factura.',
      },
      {
        env: 'CONEKTA_WEBHOOK_SECRET',
        title: 'Secreto del webhook',
        who: 'Equipo técnico',
        note: 'La verificación de firma de Conekta se confirma con su documentación vigente al activar.',
      },
    ],
    notes: ['Alternativa mexicana a Stripe; se decide por comisiones y facturación de cada consultora.'],
  },
  simulated: {
    label: 'Simulado (laboratorio)',
    kind: 'ambos',
    items: [
      {
        env: 'CONNECTOR_WEBHOOK_SECRET',
        title: 'Secreto para firmar webhooks de prueba',
        who: 'Equipo técnico',
        note: 'Opcional. Con él se pueden enviar eventos firmados a /api/webhooks/*/simulated (y el botón «Probar webhook» funciona); sin él esas rutas responden 404.',
      },
    ],
    notes: ['Nada sale a internet: entregas, lecturas y pagos se simulan dentro del servidor.'],
  },
};

// ---- Adaptadores de canal
export function simulatedChannel({ env }) {
  return {
    provider: 'simulated',
    kind: 'channel',
    channels: ['whatsapp', 'instagram', 'facebook'],
    capabilities: {
      templates: true,
      buttons: true,
      media: true,
      readReceipts: true,
      referral: true,
      inboundWebhook: true,
    },
    configured: true,
    missing: [],
    webhooksEnabled: () => Boolean(env.CONNECTOR_WEBHOOK_SECRET),
    async send(m) {
      const failed = Math.random() * 100 < (m.failureRate || 0);
      return {
        providerRef: 'simch_' + hex(6),
        state: failed ? 'failed' : 'delivered',
        reason: failed ? FAILURES[Math.floor(Math.random() * FAILURES.length)] : null,
      };
    },
    verifyWebhook: (headers, raw) =>
      Boolean(env.CONNECTOR_WEBHOOK_SECRET) &&
      safeEqual(headers['x-lab-signature'], hmacHex(env.CONNECTOR_WEBHOOK_SECRET, raw)),
    parseWebhook(body) {
      const list = Array.isArray(body?.events) ? body.events : body?.type ? [body] : [];
      return list.map(e => ({
        id: String(e.id || ''),
        type: String(e.type || ''),
        data: e.data && typeof e.data === 'object' ? e.data : {},
      }));
    },
    challenge: () => null,
  };
}
// Errores de Meta en palabras del equipo. Nunca incluyen el token; el texto de Meta se recorta y sólo se usa cuando no hay una explicación propia.
const META_ERRORS = {
  190: 'El token de Meta venció o no es válido. Los tokens temporales duran 24 horas: genera uno nuevo o usa uno permanente de usuario de sistema (META_ACCESS_TOKEN).',
  10: 'Al token de Meta le falta permiso para este número (whatsapp_business_messaging y whatsapp_business_management).',
  200: 'Al token de Meta le falta permiso para este número (whatsapp_business_messaging y whatsapp_business_management).',
  4: 'Meta está limitando las peticiones de la app. Espera unos minutos.',
  80007: 'Meta está limitando las peticiones de la cuenta de WhatsApp Business. Espera unos minutos.',
  368: 'Meta bloqueó temporalmente la cuenta por incumplir sus políticas.',
  130429: 'Se alcanzó el límite de velocidad de envío de WhatsApp. Reintenta en un momento.',
  130472: 'Meta no entregó el mensaje a este número (forma parte de un experimento de Meta).',
  131000: 'Meta tuvo un error interno. Reintenta en un momento.',
  131005: 'Al token de Meta le falta permiso para este número.',
  131008: 'A la petición le faltó un dato obligatorio.',
  131009: 'Meta rechazó un dato del mensaje (número, texto o archivo).',
  131016: 'El servicio de WhatsApp no está disponible por ahora. Reintenta en un momento.',
  131021: 'El destinatario no puede ser el mismo número que envía.',
  131026:
    'No se pudo entregar: ese número no tiene WhatsApp, no ha aceptado sus condiciones o usa una versión muy antigua.',
  131030:
    'Ese número no está en la lista de destinatarios permitidos del número de prueba. Agrégalo en Meta → WhatsApp → Configuración de la API → «Para».',
  131031: 'Meta bloqueó la cuenta de WhatsApp Business.',
  131042: 'Hay un problema con el método de pago de la cuenta de WhatsApp Business en Meta.',
  131045: 'El número de WhatsApp todavía no está registrado en la API de la nube.',
  131047: 'Pasaron más de 24 horas desde el último mensaje de la persona: Meta sólo acepta una plantilla aprobada.',
  131048: 'Meta limitó los envíos de este número por reportes de spam.',
  131049: 'Meta decidió no entregar este mensaje para cuidar la experiencia de la persona. Inténtalo más tarde.',
  131051: 'WhatsApp no admite este tipo de mensaje.',
  131052: 'No se pudo descargar el archivo que envió la persona.',
  131053: 'WhatsApp no aceptó el archivo (formato o tamaño).',
  131056: 'Se enviaron demasiados mensajes seguidos a este número. Espera un momento.',
  131057: 'La cuenta de WhatsApp Business está en mantenimiento.',
  133010: 'El número de WhatsApp no está registrado en la API de la nube.',
  132000: 'La plantilla espera otra cantidad de datos de la que se envió: revisa sus variables.',
  132001: 'Meta no tiene esa plantilla aprobada con ese nombre e idioma. Sincroniza las plantillas y revisa su estado.',
  132005: 'El texto de la plantilla con sus datos quedó demasiado largo.',
  132007: 'Meta rechazó la plantilla por sus políticas de contenido.',
  132012: 'Un dato de la plantilla no tiene el formato que Meta espera.',
  132015: 'Meta pausó esta plantilla por baja calidad; no se puede enviar por ahora.',
  132016: 'Meta desactivó esta plantilla por baja calidad.',
};
export function explainMeta(error, status = 0) {
  const code = Number(error?.code) || 0,
    sub = Number(error?.error_subcode) || 0;
  if (code === 100)
    return sub === 33 || /does not exist|cannot be loaded/i.test(String(error?.message || ''))
      ? 'Meta no encuentra ese número: revisa META_PHONE_NUMBER_ID (es el «Identificador del número de teléfono», no el número) y que el token tenga acceso a él.'
      : 'Meta rechazó la petición por un dato no válido' +
          (error?.error_data?.details ? ': ' + String(error.error_data.details).slice(0, 140) : '.');
  if (META_ERRORS[code]) return META_ERRORS[code];
  if (code >= 200 && code < 300) return META_ERRORS[200];
  if (status === 401) return META_ERRORS[190];
  const detail = String(error?.error_user_msg || error?.error_data?.details || error?.title || error?.message || '')
    .replace(/\s+/g, ' ')
    .slice(0, 140);
  return (
    'Meta rechazó la operación' +
    (code ? ' (código ' + code + ')' : status ? ' (HTTP ' + status + ')' : '') +
    (detail ? ': ' + detail : '.')
  );
}

// ---- Lectura del webhook de Meta, contrato 1.1 (docs/PLAN_CONTRATO_CANAL.md). Cada función devuelve sólo las claves
// que Meta dio: un entrante o un estado de hoy, sin los datos nuevos, se traduce exactamente igual que con 1.0.
// Meta no ha confirmado todos los nombres de los campos del identificador de usuario (BSUID): se prueban varios.
const clip = (v, max) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max));
const lower = (v, max = 60) => clip(v, max)?.toLowerCase() ?? null;
const onlyDigits = v => String(v ?? '').replace(/\D/g, '');
// La cuenta de WhatsApp Business (entry.id) y el número que recibe o envía. Sin la cuenta no se añade nada: el
// número solo ya viaja en `to` desde 1.0.
function metaAccount(entry, v) {
  const scopeId = clip(entry?.id, 40);
  if (!scopeId) return null;
  return {
    provider: 'meta-whatsapp',
    externalId: clip(v?.metadata?.phone_number_id, 40),
    scopeId,
    displayPhone: clip(v?.metadata?.display_phone_number, 30),
  };
}
function metaStatusExtras(s, account) {
  const out = {},
    error = s.errors?.[0],
    code = Number(error?.code);
  if (Number.isInteger(code) && code > 0) out.code = code;
  const detail = clip(error?.error_data?.details || error?.message || error?.title, 300);
  if (detail) out.detail = detail;
  if (s.pricing && typeof s.pricing === 'object')
    out.pricing = {
      billable: typeof s.pricing.billable === 'boolean' ? s.pricing.billable : null,
      category: lower(s.pricing.category),
      type: lower(s.pricing.type),
      model: clip(s.pricing.pricing_model, 20),
    };
  const callback = clip(s.biz_opaque_callback_data, 512);
  if (callback) out.callback = callback;
  const phone = onlyDigits(s.recipient_id),
    userId = clip(s.recipient_user_id, 140);
  if (phone || userId) out.recipient = { phone: phone || null, userId };
  if (account) out.account = account;
  return out;
}
function metaInboundExtras(m, v, kind, account) {
  const out = {},
    phone = onlyDigits(m.from);
  const contacts = Array.isArray(v.contacts) ? v.contacts : [];
  const bsuidOf = c => clip(c?.user_id, 140);
  const contact =
    contacts.find(c => phone && c?.wa_id === m.from) ||
    contacts.find(c => bsuidOf(c) && bsuidOf(c) === clip(m.from_user_id || m.user_id, 140)) ||
    contacts[0];
  const bsuid = clip(m.from_user_id || m.user_id, 140) || bsuidOf(contact),
    parent = clip(m.from_parent_user_id, 140) || clip(contact?.parent_user_id, 140),
    username = clip(contact?.profile?.username || contact?.username, 80);
  if (bsuid || parent || username) {
    const ids = [];
    if (phone) ids.push({ kind: 'wa_phone', value: phone });
    if (bsuid) ids.push({ kind: 'wa_bsuid', value: bsuid });
    if (parent) ids.push({ kind: 'wa_parent_bsuid', value: parent });
    out.peer = { ids, name: clip(contact?.profile?.name, 120), username };
  }
  if (account) out.account = account;
  const quoted = clip(m.context?.id, 200);
  if (quoted) out.replyTo = { providerRef: quoted };
  if (m.context?.forwarded || m.context?.frequently_forwarded) out.forwarded = true;
  if (kind === 'button' && m.button)
    out.interaction = {
      kind: 'template_button',
      id: null,
      title: clip(m.button.text, 200),
      payload: clip(m.button.payload, 1000),
      description: null,
    };
  const chosen = m.interactive?.button_reply || m.interactive?.list_reply;
  if (chosen)
    out.interaction = {
      kind: m.interactive.button_reply ? 'button' : 'list',
      id: clip(chosen.id, 200),
      title: clip(chosen.title, 200),
      payload: null,
      description: clip(chosen.description, 300),
    };
  if (kind === 'reaction' && m.reaction)
    out.reaction = {
      emoji: String(m.reaction.emoji ?? '').slice(0, 16),
      providerRef: clip(m.reaction.message_id, 200),
    };
  if (m.location && typeof m.location === 'object')
    out.location = {
      latitude: Number(m.location.latitude) || null,
      longitude: Number(m.location.longitude) || null,
      name: clip(m.location.name, 200),
      address: clip(m.location.address, 300),
    };
  if (Array.isArray(m.contacts))
    out.contacts = m.contacts.slice(0, 5).map(c => ({
      name: clip(c?.name?.formatted_name, 120),
      phones: (Array.isArray(c?.phones) ? c.phones : [])
        .slice(0, 3)
        .map(p => clip(p?.phone || p?.wa_id, 30))
        .filter(Boolean),
    }));
  if (kind === 'system' && m.system)
    out.system = {
      kind: lower(m.system.type),
      newPhone: onlyDigits(m.system.wa_id || m.system.new_wa_id) || null,
      newUserId: clip(m.system.user_id || m.system.new_user_id, 140),
    };
  return out;
}
// Avisos de cuenta, número y plantillas (change.field distinto de «messages»). Meta no da un identificador por
// cambio: el id se compone de campo, entidad, valor e instante de la entrada, así la bitácora lo aplica una sola vez.
const TEMPLATE_FIELDS = {
  message_template_status_update: 'status',
  message_template_quality_update: 'quality',
  template_category_update: 'category',
};
const ACCOUNT_FIELDS = new Set([
  'phone_number_quality_update',
  'phone_number_name_update',
  'account_update',
  'account_review_update',
  'business_capability_update',
  'account_alerts',
]);
function accountFieldOf(field, v) {
  const event = String(v.event || '').toUpperCase();
  if (field === 'phone_number_quality_update')
    return ['FLAGGED', 'UNFLAGGED'].includes(event) ? ['quality', lower(event)] : ['limit', lower(v.current_limit)];
  if (field === 'phone_number_name_update') return ['name', lower(v.decision)];
  if (field === 'account_review_update') return ['review', lower(v.decision)];
  if (field === 'business_capability_update') return ['capability', null];
  if (field === 'account_alerts') return ['alert', lower(v.alert_type, 120)];
  if (/RESTRICTION|VIOLATION/.test(event)) return ['restriction', lower(event)];
  if (/VERIFIED|REVIEW/.test(event)) return ['review', lower(event)];
  return ['status', lower(event)];
}
function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj))
    if (value !== null && value !== undefined && value !== '') out[key] = value;
  return out;
}
function metaNoticeEvents(entry, field, v, account, peerHash) {
  const scopeId = clip(entry?.id, 40),
    when = Number(entry?.time) || null,
    stamp = when ? String(when) : peerHash(JSON.stringify(v)); // sin instante: huella con llave del contenido
  if (TEMPLATE_FIELDS[field]) {
    const kind = TEMPLATE_FIELDS[field];
    const value =
      kind === 'status'
        ? lower(v.event)
        : kind === 'quality'
          ? lower(v.new_quality_score)
          : lower(v.new_category || v.correct_category);
    const data = {
      account,
      scopeId,
      templateId: clip(v.message_template_id, 40),
      name: clip(v.message_template_name, 512),
      language: clip(v.message_template_language, 20),
      field: kind,
      value,
      previous:
        kind === 'quality' ? lower(v.previous_quality_score) : kind === 'category' ? lower(v.previous_category) : null,
      reason: v.reason && String(v.reason).toUpperCase() !== 'NONE' ? clip(v.reason, 300) : null,
    };
    return [{ id: [field, data.templateId || data.name, value, stamp].join(':'), type: 'template.update', data }];
  }
  if (ACCOUNT_FIELDS.has(field)) {
    const [kind, value] = accountFieldOf(field, v);
    const details = compact({
      event: clip(v.event, 60),
      displayPhone: clip(v.display_phone_number || v.phone_number, 30),
      requestedName: clip(v.requested_verified_name, 120),
      rejectionReason: clip(v.rejection_reason, 300),
      severity: clip(v.alert_severity, 30),
      status: clip(v.alert_status, 30),
      description: clip(v.alert_description, 500),
      maxDailyConversationsPerBusiness: clip(v.max_daily_conversations_per_business, 30),
      maxPhoneNumbersPerBusiness: clip(v.max_phone_numbers_per_business, 30),
      restriction: v.restriction_info ? clip(JSON.stringify(v.restriction_info), 500) : null,
      violation: v.violation_info ? clip(JSON.stringify(v.violation_info), 500) : null,
      ban: v.ban_info ? clip(JSON.stringify(v.ban_info), 500) : null,
    });
    const data = {
      account,
      scopeId,
      field: kind,
      value,
      previous: kind === 'limit' ? lower(v.old_limit) : null,
      details,
    };
    const entity = details.displayPhone || scopeId || 'cuenta';
    return [{ id: [field, entity, value, stamp].join(':'), type: 'account.update', data }];
  }
  if (field === 'user_preferences')
    return (Array.isArray(v.user_preferences) ? v.user_preferences : []).map(p => {
      const phone = onlyDigits(p?.wa_id),
        userId = clip(p?.user_id, 140);
      const ids = [];
      if (phone) ids.push({ kind: 'wa_phone', value: phone });
      if (userId) ids.push({ kind: 'wa_bsuid', value: userId });
      const at = Number(p?.timestamp) ? Number(p.timestamp) * 1000 : when ? when * 1000 : null;
      return {
        // la persona va como huella con llave: el id se guarda en claro en la bitácora y en la bandeja
        id: ['user_preferences', peerHash(phone || userId), lower(p?.value), at || stamp].join(':'),
        type: 'user.preference',
        data: { account, scopeId, peer: { ids }, category: lower(p?.category), value: lower(p?.value), at },
      };
    });
  return [];
}
const IMAGE_MIME = new Set(['image/jpeg', 'image/png']),
  MEDIA_HOSTS = ['fbsbx.com', 'facebook.com', 'fbcdn.net', 'whatsapp.net', 'whatsapp.com'];
// peerHash: huella con llave de la instalación (server/lib/peer-key.mjs) para los ids que dependen de una persona. Sin
// ella (un adaptador suelto en una prueba), la de PEER_HASH_KEY o una llave al azar de este proceso.
export function metaChannel({
  env,
  fetchImpl = (...a) => fetch(...a),
  peerHash = createPeerHash(loadPeerKey({ env })),
}) {
  const missing = missingOf(env, ['META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_PHONE_NUMBER_ID']);
  const STATE = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
  const production = env.NODE_ENV === 'production';
  // En producción el token sólo viaja a graph.facebook.com; META_GRAPH_URL existe para las pruebas con un Meta de mentira.
  const base = () =>
    String((!production && env.META_GRAPH_URL) || 'https://graph.facebook.com').replace(/\/+$/, '') +
    '/' +
    (/^v\d{1,3}\.\d$/.test(String(env.META_GRAPH_VERSION || '')) ? env.META_GRAPH_VERSION : 'v25.0');
  const token = () => {
    const t = String(env.META_ACCESS_TOKEN || '').trim();
    if (!/^[A-Za-z0-9_|.\-]{20,}$/.test(t))
      throw fail(
        503,
        'META_ACCESS_TOKEN no parece un token de Meta: revisa que la variable tenga sólo el token, sin espacios ni otras variables pegadas.',
      );
    return t;
  };
  const numberId = v => {
    const id = String(v || env.META_PHONE_NUMBER_ID || '').trim();
    if (!/^\d{5,25}$/.test(id))
      throw fail(503, 'El identificador del número de WhatsApp no es válido: son sólo dígitos (META_PHONE_NUMBER_ID).');
    return id;
  };
  async function graph(path, { method = 'GET', payload, form, timeout = 15000 } = {}) {
    const auth = 'Bearer ' + token();
    let r;
    try {
      r = await fetchImpl(base() + path, {
        method,
        headers: payload ? { Authorization: auth, 'Content-Type': 'application/json' } : { Authorization: auth },
        body: payload ? JSON.stringify(payload) : form,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw Object.assign(
        fail(
          502,
          'No se pudo conectar con Meta (' +
            (e?.name === 'TimeoutError' ? 'tiempo de espera agotado' : 'error de red') +
            ').',
        ),
        { network: true },
      );
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data?.error)
      throw Object.assign(fail(r.status >= 400 ? r.status : 502, explainMeta(data?.error, r.status)), {
        metaCode: Number(data?.error?.code) || 0,
      });
    return data;
  }
  const digits = v => String(v || '').replace(/\D/g, '');
  const wabaId = () => {
    const id = String(env.META_WABA_ID || '').trim();
    if (!/^\d{5,25}$/.test(id))
      throw fail(
        503,
        'Para las plantillas falta META_WABA_ID en el entorno: es el «Identificador de la cuenta de WhatsApp Business» que muestra Meta (sólo dígitos).',
      );
    return id;
  };
  const param = v =>
    String(v ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200) || '—'; // Meta no admite saltos de línea ni datos vacíos en una variable
  // México: el webhook entrega 521XXXXXXXXXX, pero la lista de destinatarios de un número de prueba suele tener 52XXXXXXXXXX.
  // Se envía tal como llegó y, sólo si Meta dice «no está en la lista» (131030), se reintenta una vez sin el 1.
  async function post(from, to, message) {
    const send = dest =>
      graph('/' + from + '/messages', {
        method: 'POST',
        payload: { messaging_product: 'whatsapp', recipient_type: 'individual', to: dest, ...message },
      });
    // Se reintenta sin el 1 ante cualquier rechazo de Meta que no sea del token, de límites o de la ventana de 24 h (131030 es el habitual,
    // pero Meta no siempre usa ese código). Si el reintento también falla, se informa el PRIMER motivo.
    const SKIP = new Set([190, 4, 10, 80007, 130429, 131047, 131056]);
    try {
      return await send(to);
    } catch (e) {
      if (!e.metaCode || SKIP.has(e.metaCode) || !/^521\d{10}$/.test(to)) throw e;
      try {
        return await send('52' + to.slice(3));
      } catch {
        throw e;
      }
    }
  }
  // Sube un archivo al número que envía y devuelve su identificador de Meta (sirve para mensajes y encabezados).
  async function uploadMedia(from, media) {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', media.mime);
    form.set('file', new Blob([media.buffer], { type: media.mime }), media.filename || 'archivo');
    const id = (await graph('/' + from + '/media', { method: 'POST', form, timeout: 30000 })).id;
    if (!id) throw fail(502, 'Meta no devolvió el identificador del archivo.');
    return String(id);
  }
  // Una plantilla de Meta tal como la lista la API → lo que el CRM necesita. «complex» conserva su significado de
  // siempre (lleva algo fuera del texto principal); «supported» dice si el CRM puede usarla (D-3: encabezado ninguno,
  // texto, imagen, video o documento; botones de respuesta, enlace, teléfono, copiar código o flujo) y, si no, por qué.
  function remoteTemplate(t) {
    const comps = Array.isArray(t.components) ? t.components : [],
      body = comps.find(c => c?.type === 'BODY'),
      header = comps.find(c => c?.type === 'HEADER'),
      btns = comps.find(c => c?.type === 'BUTTONS'),
      kinds = (btns?.buttons || []).map(b => String(b?.type || ''));
    const category = String(t.category || '').toLowerCase(),
      format = String(header?.format || 'TEXT').toUpperCase();
    let unsupported = '';
    if (category === 'authentication') unsupported = 'Es de autenticación.';
    else if (comps.some(c => ['CAROUSEL', 'LIMITED_TIME_OFFER'].includes(String(c?.type || '').toUpperCase())))
      unsupported = 'Es un carrusel o una oferta por tiempo limitado.';
    else if (header && !['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT'].includes(format))
      unsupported = 'Su encabezado es una ubicación o un producto.';
    else if (kinds.some(k => !['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'FLOW'].includes(k)))
      unsupported = 'Lleva un botón de catálogo, de código de acceso o de otro tipo que el CRM no envía.';
    return {
      metaId: String(t.id || ''),
      name: String(t.name || ''),
      language: String(t.language || ''),
      status: String(t.status || '').toLowerCase(),
      category,
      body: String(body?.text || ''),
      reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason).slice(0, 120) : '',
      quality: t.quality_score?.score ? String(t.quality_score.score).toLowerCase().slice(0, 20) : null,
      components: comps,
      supported: !unsupported,
      unsupported,
      complex: Boolean(
        (header && (format !== 'TEXT' || /\{\{/.test(String(header.text || '')))) ||
        (btns?.buttons || []).some(
          b => /\{\{/.test(String(b?.url || '')) || b?.type === 'COPY_CODE' || b?.type === 'OTP',
        ),
      ),
    };
  }
  async function listPage({ after = '', limit = 100 } = {}) {
    const d = await graph(
      '/' +
        wabaId() +
        '/message_templates?fields=name,language,status,category,components,rejected_reason,quality_score&limit=' +
        Math.max(1, Math.min(100, Number(limit) || 100)) +
        (after ? '&after=' + encodeURIComponent(after) : ''),
    );
    return {
      templates: (d.data || []).map(remoteTemplate),
      after: d.paging?.next ? String(d.paging?.cursors?.after || '') || null : null,
    };
  }
  // Componentes de Meta de una plantilla nueva o corregida. Una de sólo cuerpo produce exactamente lo de siempre.
  //   header: {format:'TEXT', text, example?} · {format:'IMAGE'|'DOCUMENT'|'VIDEO', handle}
  //   buttons: [{type:'quick_reply', text} · {type:'url', text, url, example?} · {type:'phone', text, phone}
  //             · {type:'copy_code', example}]
  function templateComponents({ body, examples = [], header, footer, buttons }) {
    const out = [];
    if (header?.format === 'TEXT')
      out.push({
        type: 'HEADER',
        format: 'TEXT',
        text: String(header.text || ''),
        ...(header.example ? { example: { header_text: [param(header.example)] } } : {}),
      });
    else if (header?.format)
      out.push({ type: 'HEADER', format: header.format, example: { header_handle: [String(header.handle || '')] } });
    out.push({
      type: 'BODY',
      text: body,
      ...(examples.length ? { example: { body_text: [examples.map(param)] } } : {}),
    });
    if (footer) out.push({ type: 'FOOTER', text: String(footer) });
    if (Array.isArray(buttons) && buttons.length)
      out.push({
        type: 'BUTTONS',
        buttons: buttons.map(b =>
          b.type === 'url'
            ? { type: 'URL', text: b.text, url: b.url, ...(b.example ? { example: [param(b.example)] } : {}) }
            : b.type === 'phone'
              ? { type: 'PHONE_NUMBER', text: b.text, phone_number: digits(b.phone) }
              : b.type === 'copy_code'
                ? { type: 'COPY_CODE', example: param(b.example).slice(0, 15) }
                : { type: 'QUICK_REPLY', text: b.text },
        ),
      });
    return out;
  }
  return {
    provider: 'meta',
    kind: 'channel',
    channels: ['whatsapp'],
    capabilities: {
      templates: true,
      buttons: true,
      media: true,
      readReceipts: true,
      referral: true,
      inboundWebhook: true,
    },
    configured: missing.length === 0,
    missing,
    webhooksEnabled: () => Boolean(env.META_APP_SECRET),
    // m: {to, from?, text, buttons?, media?:{buffer,mime,filename}, template?:{name,language,params}}. Devuelve la referencia de Meta (wamid); el estado «entregado»/«leído» llega después por webhook.
    async send(m) {
      if (missing.length) throw fail(503, 'Conector de Meta sin configurar: faltan ' + missing.join(', ') + '.');
      const to = digits(m.to),
        from = numberId(m.from);
      if (!/^\d{7,20}$/.test(to)) throw fail(400, 'La conversación no tiene un número de WhatsApp de destino.');
      if (m.template) {
        // plantilla aprobada: lo único que Meta deja salir con la ventana de 24 h cerrada. Con encabezado (texto o
        // archivo) y botones (enlace con dato, respuesta rápida con carga) si la plantilla los lleva (D-3).
        const params = (Array.isArray(m.template.params) ? m.template.params : []).map(param);
        const components = [],
          head = m.template.header;
        if (head?.type === 'text' && Array.isArray(head.params) && head.params.length)
          components.push({ type: 'header', parameters: head.params.map(t => ({ type: 'text', text: param(t) })) });
        else if (head?.type === 'image' || head?.type === 'document') {
          const id = head.mediaId || (head.media ? await uploadMedia(from, head.media) : null);
          if (!id) throw fail(422, 'La plantilla lleva un archivo en el encabezado y no se encontró ese archivo.');
          const filename = String(head.media?.filename || head.filename || 'archivo').slice(0, 120);
          components.push({
            type: 'header',
            parameters: [{ type: head.type, [head.type]: head.type === 'document' ? { id, filename } : { id } }],
          });
        }
        if (params.length) components.push({ type: 'body', parameters: params.map(t => ({ type: 'text', text: t })) });
        for (const b of Array.isArray(m.template.buttons) ? m.template.buttons : []) {
          const index = String(Math.max(0, Math.min(9, Number(b?.index) || 0)));
          if (b?.subType === 'url' && b.param !== undefined)
            components.push({
              type: 'button',
              sub_type: 'url',
              index,
              parameters: [{ type: 'text', text: param(b.param) }],
            });
          else if (b?.subType === 'quick_reply' && b.payload)
            components.push({
              type: 'button',
              sub_type: 'quick_reply',
              index,
              parameters: [{ type: 'payload', payload: String(b.payload).slice(0, 128) }],
            });
          else if (b?.subType === 'copy_code' && b.code)
            components.push({
              type: 'button',
              sub_type: 'copy_code',
              index,
              parameters: [{ type: 'coupon_code', coupon_code: param(b.code).slice(0, 15) }],
            });
        }
        const r = await post(from, to, {
          type: 'template',
          template: {
            name: String(m.template.name || ''),
            language: { code: String(m.template.language || 'es_MX') },
            ...(components.length ? { components } : {}),
          },
        });
        const ref = r.messages?.[0]?.id;
        if (!ref) throw fail(502, 'Meta aceptó la petición pero no devolvió la referencia del mensaje.');
        return { providerRef: ref, state: 'sent', reason: null };
      }
      const text = String(m.text || '')
          .trim()
          .slice(0, 4096),
        buttons = (Array.isArray(m.buttons) ? m.buttons : [])
          .map(b =>
            String(b || '')
              .trim()
              .slice(0, 20),
          )
          .filter(Boolean)
          .slice(0, 3),
        parts = [];
      if (m.media) {
        const id = await uploadMedia(from, m.media);
        const kind = IMAGE_MIME.has(m.media.mime) ? 'image' : 'document',
          withButtons = Boolean(buttons.length && text && text.length <= 1024),
          caption = !withButtons && text.length <= 1024 ? text : '';
        parts.push({
          type: kind,
          [kind]: {
            id,
            ...(caption ? { caption } : {}),
            ...(kind === 'document' ? { filename: String(m.media.filename || 'archivo').slice(0, 120) } : {}),
          },
        });
        if (withButtons)
          parts.push({
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text },
              action: { buttons: buttons.map((title, i) => ({ type: 'reply', reply: { id: 'b' + (i + 1), title } })) },
            },
          });
        else if (text && !caption) parts.push({ type: 'text', text: { body: text, preview_url: false } });
      } else if (!text) throw fail(422, 'Este mensaje no tiene texto ni un archivo que WhatsApp admita.');
      else if (buttons.length && text.length <= 1024)
        parts.push({
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text },
            action: { buttons: buttons.map((title, i) => ({ type: 'reply', reply: { id: 'b' + (i + 1), title } })) },
          },
        });
      else parts.push({ type: 'text', text: { body: text, preview_url: false } });
      let ref = null;
      for (const part of parts) {
        try {
          ref = (await post(from, to, part)).messages?.[0]?.id || ref;
        } catch (e) {
          if (!ref) throw e;
          return {
            providerRef: ref,
            state: 'sent',
            reason:
              'Sólo salió una parte del mensaje (el archivo); el texto no: ' + String(e?.message || '').slice(0, 140),
          };
        } // la persona ya recibió el archivo: reintentar lo duplicaría
      }
      if (!ref) throw fail(502, 'Meta aceptó la petición pero no devolvió la referencia del mensaje.');
      return { providerRef: ref, state: 'sent', reason: null };
    },
    // Descarga un archivo que envió la persona: primero su URL temporal y después los bytes, siempre con el token y sólo desde servidores de Meta.
    async fetchMedia(id, { maxBytes = 4 * 1024 * 1024 } = {}) {
      const info = await graph('/' + encodeURIComponent(String(id)));
      if (Number(info.file_size) > maxBytes) throw fail(413, 'El archivo supera el tamaño admitido.');
      let u;
      try {
        u = new URL(String(info.url || ''));
      } catch {
        throw fail(502, 'Meta no devolvió la dirección del archivo.');
      }
      if (
        production &&
        (u.protocol !== 'https:' || !MEDIA_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)))
      )
        throw fail(502, 'La dirección del archivo no es de Meta.');
      let r;
      try {
        r = await fetchImpl(u.href, {
          headers: { Authorization: 'Bearer ' + token() },
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        throw fail(502, 'No se pudo descargar el archivo desde Meta.');
      }
      if (!r.ok) throw fail(502, 'Meta no entregó el archivo (HTTP ' + r.status + ').');
      const buffer = Buffer.from(await r.arrayBuffer());
      if (!buffer.length || buffer.length > maxBytes) throw fail(413, 'El archivo supera el tamaño admitido.');
      return {
        buffer,
        mime: String(info.mime_type || '')
          .split(';')[0]
          .trim(),
      };
    },
    // Una página de plantillas de la cuenta de WhatsApp Business (hasta `limit`, 100 como mucho) y el cursor de la
    // siguiente (null si no hay más). Así una cuenta con cientos de plantillas se recorre sin tope fijo.
    listTemplatesPage: listPage,
    // Todas las plantillas de la cuenta, página por página (`maxPages` sólo protege de un cursor que no termina).
    async listTemplates({ maxPages = 100 } = {}) {
      const out = [];
      let after = '';
      for (let page = 0; page < maxPages; page++) {
        const r = await listPage({ after });
        out.push(...r.templates);
        after = r.after || '';
        if (!after) break;
      }
      return out;
    },
    // Manda una plantilla a revisión de Meta. body lleva {{1}}…{{n}}; examples, un valor de ejemplo por variable (Meta
    // lo exige). header, footer y buttons son opcionales (formato de templateComponents); sin ellos viaja lo de siempre.
    async createTemplate({ name, language, category, body, examples = [], header, footer, buttons }) {
      const d = await graph('/' + wabaId() + '/message_templates', {
        method: 'POST',
        payload: {
          name,
          language,
          category: String(category).toUpperCase(),
          components: templateComponents({ body, examples, header, footer, buttons }),
        },
      });
      return {
        metaId: String(d.id || ''),
        status: String(d.status || 'PENDING').toLowerCase(),
        category: String(d.category || category).toLowerCase(),
      };
    },
    // Corrige una plantilla rechazada (o en pausa) que ya existe en Meta: se manda de nuevo con sus componentes.
    // [por comprobar con Meta real: POST /{id-de-la-plantilla}]
    async editTemplate(metaId, { category, body, examples = [], header, footer, buttons }) {
      if (!/^\d{1,30}$/.test(String(metaId || ''))) throw fail(400, 'La plantilla no tiene identificador de Meta.');
      const d = await graph('/' + metaId, {
        method: 'POST',
        payload: {
          ...(category ? { category: String(category).toUpperCase() } : {}),
          components: templateComponents({ body, examples, header, footer, buttons }),
        },
      });
      if (d?.success === false) throw fail(502, 'Meta no confirmó la corrección de la plantilla.');
      return { ok: true };
    },
    // Borra una plantilla en Meta (por nombre y, si se conoce, por su identificador: así sólo se borra ese idioma).
    // [por comprobar con Meta real: DELETE /{WABA}/message_templates?name=&hsm_id=]
    async deleteTemplate({ name, metaId }) {
      const d = await graph(
        '/' +
          wabaId() +
          '/message_templates?name=' +
          encodeURIComponent(String(name || '')) +
          (metaId ? '&hsm_id=' + encodeURIComponent(String(metaId)) : ''),
        { method: 'DELETE' },
      );
      if (d?.success === false) throw fail(502, 'Meta no confirmó el borrado de la plantilla.');
      return { ok: true };
    },
    // Sube la muestra de un encabezado con archivo para mandar la plantilla a revisión y devuelve su identificador
    // («handle»). Es la subida por sesión de Meta: abrir la sesión con la app (META_APP_ID, no es secreto) y mandar los
    // bytes. [por comprobar con Meta real]
    async uploadSample({ buffer, mime }) {
      const app = String(env.META_APP_ID || '').trim();
      if (!/^\d{5,25}$/.test(app))
        throw fail(
          503,
          'Para mandar a revisión una plantilla con archivo en el encabezado falta META_APP_ID en el entorno (el identificador de la app de Meta, sólo dígitos).',
        );
      const session = await graph(
        '/' + app + '/uploads?file_length=' + buffer.length + '&file_type=' + encodeURIComponent(mime),
        { method: 'POST' },
      );
      const id = String(session?.id || '');
      if (!/^upload:[A-Za-z0-9_=:.\-]{1,400}$/.test(id)) throw fail(502, 'Meta no abrió la sesión de subida.');
      let r;
      try {
        r = await fetchImpl(base() + '/' + id, {
          method: 'POST',
          headers: { Authorization: 'OAuth ' + token(), file_offset: '0', 'Content-Type': mime },
          body: buffer,
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        throw Object.assign(fail(502, 'No se pudo conectar con Meta (subida del archivo de muestra).'), {
          network: true,
        });
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data?.error || !data?.h) throw fail(502, explainMeta(data?.error, r.status));
      return { handle: String(data.h) };
    },
    // ¿Qué apps reciben los avisos de la cuenta de WhatsApp Business? Si la lista está vacía, Meta no entrega los mensajes reales a nadie.
    async subscription() {
      const d = await graph('/' + wabaId() + '/subscribed_apps'),
        apps = (Array.isArray(d.data) ? d.data : []).map(a =>
          String(a?.whatsapp_business_api_data?.name || a?.name || 'app sin nombre').slice(0, 60),
        );
      return { subscribed: apps.length > 0, apps: apps.slice(0, 5) };
    },
    // Suscribe ESTA app (la del token) a los avisos de la cuenta. Es lo que hace que los mensajes reales lleguen al webhook.
    async subscribe() {
      const d = await graph('/' + wabaId() + '/subscribed_apps', { method: 'POST', payload: {} });
      if (d?.success === false) throw fail(502, 'Meta no confirmó la suscripción.');
      return { ok: true };
    },
    // Comprueba token y número sin enviar nada: lee los datos públicos del número.
    async ping(id) {
      if (missing.length) throw fail(503, 'Conector de Meta sin configurar: faltan ' + missing.join(', ') + '.');
      const d = await graph('/' + numberId(id) + '?fields=display_phone_number,verified_name,quality_rating');
      return {
        phoneNumberId: numberId(id),
        displayPhone: String(d.display_phone_number || ''),
        verifiedName: String(d.verified_name || ''),
        quality: String(d.quality_rating || ''),
      };
    },
    verifyWebhook: (headers, raw) =>
      Boolean(env.META_APP_SECRET) &&
      safeEqual(headers['x-hub-signature-256'], 'sha256=' + hmacHex(env.META_APP_SECRET, raw)),
    // Traduce el formato de Meta (entry[].changes[].value.statuses[] / messages[]) a eventos normalizados.
    parseWebhook(body) {
      const out = [];
      for (const entry of body?.entry || [])
        for (const change of entry.changes || []) {
          const v = change.value || {},
            account = metaAccount(entry, v);
          out.push(...metaNoticeEvents(entry, change.field, v, account, peerHash));
          for (const s of v.statuses || [])
            out.push({
              id: s.id + ':' + s.status,
              type: 'message.status',
              data: {
                providerRef: s.id,
                state: STATE[s.status] || 'sent',
                reason: s.errors?.[0] ? explainMeta(s.errors[0]) : null,
                at: s.timestamp ? Number(s.timestamp) * 1000 : null,
                ...metaStatusExtras(s, account),
              },
            });
          for (const m of v.messages || []) {
            const kind = String(m.type || 'text'),
              media = ['image', 'document', 'audio', 'video', 'sticker'].includes(kind) ? m[kind] || {} : null,
              loc = m.location;
            const text =
              m.text?.body ||
              m.button?.text ||
              m.interactive?.button_reply?.title ||
              m.interactive?.list_reply?.title ||
              media?.caption ||
              (loc
                ? 'Ubicación compartida: ' +
                  ([loc.name, loc.address].filter(Boolean).join(', ') || loc.latitude + ', ' + loc.longitude)
                : '') ||
              (Array.isArray(m.contacts)
                ? 'Contacto compartido: ' +
                  m.contacts
                    .map(c => c?.name?.formatted_name)
                    .filter(Boolean)
                    .join(', ')
                : '') ||
              '';
            out.push({
              id: m.id,
              type: 'message.inbound',
              data: {
                channel: change.field === 'messages' ? 'whatsapp' : change.field || 'whatsapp',
                from: m.from,
                to: v.metadata?.phone_number_id || null,
                name: String(
                  (v.contacts || []).find(c => c?.wa_id === m.from)?.profile?.name ||
                    v.contacts?.[0]?.profile?.name ||
                    '',
                ),
                kind,
                text: String(text),
                media: media?.id
                  ? {
                      id: String(media.id),
                      mime: String(media.mime_type || '')
                        .split(';')[0]
                        .trim(),
                      filename: media.filename ? String(media.filename) : null,
                      ...(media.voice ? { voice: true } : {}),
                    }
                  : null,
                providerRef: m.id,
                at: m.timestamp ? Number(m.timestamp) * 1000 : null,
                referral: m.referral
                  ? {
                      source: 'ad',
                      ad: m.referral.headline || m.referral.source_id || 'anuncio',
                      adId: m.referral.source_id ? String(m.referral.source_id) : null,
                      campaign: m.referral.source_type || null,
                      headline: m.referral.body || null,
                    }
                  : null,
                ...metaInboundExtras(m, v, kind, account),
              },
            });
          }
        }
      return out;
    },
    challenge(params) {
      return params.get('hub.mode') === 'subscribe' &&
        env.META_VERIFY_TOKEN &&
        safeEqual(params.get('hub.verify_token'), env.META_VERIFY_TOKEN)
        ? params.get('hub.challenge')
        : null;
    },
  };
}
// ---- Adaptadores de pago
export function simulatedPayment({ env }) {
  return {
    provider: 'simulated',
    kind: 'payment',
    capabilities: { card: true, oxxo: true, spei: false, transferReceipt: true, refunds: false },
    configured: true,
    missing: [],
    webhooksEnabled: () => Boolean(env.CONNECTOR_WEBHOOK_SECRET),
    async prepareCheckout(order) {
      return { providerRef: 'simpay_' + hex(6), url: (env.APP_ORIGIN || '').replace(/\/$/, '') + '/?pay=' + order.id };
    },
    verifyWebhook: (headers, raw) =>
      Boolean(env.CONNECTOR_WEBHOOK_SECRET) &&
      safeEqual(headers['x-lab-signature'], hmacHex(env.CONNECTOR_WEBHOOK_SECRET, raw)),
    parseWebhook(body) {
      const list = Array.isArray(body?.events) ? body.events : body?.type ? [body] : [];
      return list.map(e => ({
        id: String(e.id || ''),
        type: String(e.type || ''),
        data: e.data && typeof e.data === 'object' ? e.data : {},
      }));
    },
    challenge: () => null,
  };
}
export function stripePayment({ env, now = Date.now, toleranceMs = 5 * 60000 }) {
  const missing = missingOf(env, ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
  return {
    provider: 'stripe',
    kind: 'payment',
    capabilities: { card: true, oxxo: true, spei: true, transferReceipt: true, refunds: true },
    configured: missing.length === 0,
    missing,
    webhooksEnabled: () => Boolean(env.STRIPE_WEBHOOK_SECRET),
    async prepareCheckout() {
      if (missing.length) throw fail(503, 'Conector de Stripe sin configurar: faltan ' + missing.join(', ') + '.');
      throw fail(
        501,
        'La sesión de pago real se crea con la clave de la consultora; mientras tanto se usa el simulado.',
      );
    },
    // Stripe-Signature: t=<unix>,v1=<hmac(secret, `${t}.${raw}`)>
    verifyWebhook(headers, raw) {
      const parts = Object.fromEntries(
        String(headers['stripe-signature'] || '')
          .split(',')
          .map(p => p.split('=')),
      );
      if (!env.STRIPE_WEBHOOK_SECRET || !parts.t || !parts.v1) return false;
      if (Math.abs(now() - Number(parts.t) * 1000) > toleranceMs) return false;
      return safeEqual(
        parts.v1,
        hmacHex(
          env.STRIPE_WEBHOOK_SECRET,
          Buffer.concat([Buffer.from(parts.t + '.'), Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))]),
        ),
      );
    },
    parseWebhook(body) {
      const o = body?.data?.object || {},
        meta = o.metadata || {},
        base = {
          orderId: meta.orderId || null,
          reference: meta.reference || null,
          providerRef: o.id || body?.id || null,
        };
      if (body?.type === 'checkout.session.completed' || body?.type === 'checkout.session.async_payment_succeeded')
        return [
          {
            id: body.id,
            type: 'payment.succeeded',
            data: {
              ...base,
              method: (o.payment_method_types || [])[0] === 'oxxo' ? 'oxxo' : 'card',
              amountCents: o.amount_total ?? null,
            },
          },
        ];
      if (body?.type === 'checkout.session.async_payment_failed' || body?.type === 'payment_intent.payment_failed')
        return [
          {
            id: body.id,
            type: 'payment.failed',
            data: { ...base, reason: o.last_payment_error?.message || 'Pago no completado' },
          },
        ];
      return [];
    },
    challenge: () => null,
  };
}
export function conektaPayment({ env }) {
  const missing = missingOf(env, ['CONEKTA_PRIVATE_KEY', 'CONEKTA_WEBHOOK_SECRET']);
  return {
    provider: 'conekta',
    kind: 'payment',
    capabilities: { card: true, oxxo: true, spei: true, transferReceipt: true, refunds: true },
    configured: missing.length === 0,
    missing,
    webhooksEnabled: () => false,
    async prepareCheckout() {
      throw fail(
        missing.length ? 503 : 501,
        missing.length
          ? 'Conector de Conekta sin configurar: faltan ' + missing.join(', ') + '.'
          : 'La orden real se crea con la llave de la consultora; mientras tanto se usa el simulado.',
      );
    },
    verifyWebhook: () => false, // la verificación de firma de Conekta se implementa al activar, con su documentación vigente
    parseWebhook(body) {
      const o = body?.data?.object || {},
        meta = o.metadata || {};
      if (body?.type === 'order.paid')
        return [
          {
            id: body.id,
            type: 'payment.succeeded',
            data: {
              orderId: meta.orderId || null,
              reference: meta.reference || null,
              providerRef: o.id || null,
              method: o.charges?.data?.[0]?.payment_method?.type === 'oxxo' ? 'oxxo' : 'card',
              amountCents: o.amount ?? null,
            },
          },
        ];
      if (body?.type === 'order.expired' || body?.type === 'charge.declined')
        return [
          {
            id: body.id,
            type: 'payment.failed',
            data: {
              orderId: meta.orderId || null,
              reference: meta.reference || null,
              providerRef: o.id || null,
              reason: 'Pago no completado',
            },
          },
        ];
      return [];
    },
    challenge: () => null,
  };
}

export function createConnectors({
  db,
  env = process.env,
  channel,
  payments,
  body,
  json,
  audit,
  rate,
  selfOrigin,
  dataDir = null,
  now = Date.now,
  log = console,
}) {
  // Huella con llave de quien escribe (server/lib/peer-key.mjs): carril de la bandeja e ids que dependen de una persona.
  const peerHash = createPeerHash(loadPeerKey({ env, dataDir }));
  const channelProvider = ['simulated', 'meta'].includes(env.CHANNEL_CONNECTOR) ? env.CHANNEL_CONNECTOR : 'simulated';
  const paymentProvider = ['simulated', 'stripe', 'conekta'].includes(env.PAYMENT_CONNECTOR)
    ? env.PAYMENT_CONNECTOR
    : 'simulated';
  const adapters = {
    channel: { simulated: simulatedChannel({ env }), meta: metaChannel({ env, peerHash }) },
    payment: {
      simulated: simulatedPayment({ env }),
      stripe: stripePayment({ env, now }),
      conekta: conektaPayment({ env }),
    },
  };
  const selected = { channel: adapters.channel[channelProvider], payment: adapters.payment[paymentProvider] };
  // Un proveedor real sin configurar no rompe el laboratorio: el envío cae al simulado y el estado lo dice claramente.
  const effective = kind => (selected[kind].configured ? selected[kind] : adapters[kind].simulated);
  if (selected.channel.provider !== 'simulated' && !selected.channel.configured)
    log.warn(
      'Conector de canal',
      selected.channel.provider,
      'sin configurar: faltan',
      selected.channel.missing.join(', '),
      '· se usa el simulado',
    );
  if (selected.payment.provider !== 'simulated' && !selected.payment.configured)
    log.warn(
      'Conector de pago',
      selected.payment.provider,
      'sin configurar: faltan',
      selected.payment.missing.join(', '),
      '· se usa el simulado',
    );
  // Cada mensaje elige su camino: una conversación REAL (con número de WhatsApp de destino) sale por Meta; las del laboratorio siguen simuladas
  // aunque Meta esté activo. Una conversación real con Meta apagado o incompleto falla con un motivo claro: nunca se «entrega» de mentira.
  const metaLive = () => channelProvider === 'meta' && adapters.channel.meta.configured;
  const metaOff = {
    provider: 'meta',
    async send() {
      throw fail(
        503,
        channelProvider === 'meta'
          ? 'WhatsApp real sin configurar: faltan ' + adapters.channel.meta.missing.join(', ') + '.'
          : 'WhatsApp real está apagado (CHANNEL_CONNECTOR no es «meta»): el mensaje no salió.',
      );
    },
  };
  channel.useConnector(m => (m && m.to ? (metaLive() ? adapters.channel.meta : metaOff) : adapters.channel.simulated));
  payments.useConnector(() => effective('payment'));
  let inbound = null;
  const useInbound = fn => {
    inbound = fn;
  }; // lo fija whatsapp.mjs: convierte un entrante real en cliente, conversación y mensaje
  // Bandeja de entrada de webhooks (docs/PLAN_RECEPCION_DURADERA.md): la petición guarda cada evento y responde; el
  // trabajador de la bandeja los procesa aparte con processInboxRow, con reintentos y en orden por carril.
  const waitMs = inboxWaitMs(env);
  const inbox = createWebhookInbox({
    db,
    process: processInboxRow,
    kinds: Object.keys(adapters),
    paused: env.NODE_ENV === 'test' && env.WEBHOOK_INBOX_PAUSED === '1', // sólo pruebas: se guarda y no se procesa
    now,
    log,
  });
  // Al arrancar: ningún carril guarda una huella que no sea la de la llave vigente. Un evento terminado (o una
  // cuarentena ya vaciada) no vuelve a usar su carril: pierde la huella de la persona. Uno pendiente, reservado o en
  // cuarentena con carga recalcula la suya con la llave: así un carril guardado antes con SHA-256 sin llave, o con
  // otra llave, queda igual que el de los eventos nuevos de esa persona. Idempotente y acotado a la bandeja.
  function rekeyLanes() {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='webhook_inbox'").get()) return;
    transaction(db, () => {
      db.prepare(
        "UPDATE webhook_inbox SET lane='ev:'||provider||':'||event_id WHERE lane LIKE 'in:%' AND (state='done' OR payload IS NULL)",
      ).run();
      const set = db.prepare('UPDATE webhook_inbox SET lane=? WHERE seq=?');
      for (const row of db
        .prepare("SELECT seq,kind,provider,payload FROM webhook_inbox WHERE lane LIKE 'in:%' AND payload IS NOT NULL")
        .all()) {
        try {
          const lane = laneOf(
            row.kind,
            row.provider,
            readStoredEvent(JSON.parse(row.payload), row.provider).event,
            peerHash,
          );
          set.run(lane.slice(0, 200), row.seq);
        } catch {
          // una carga ilegible no tiene a quién ordenar: conserva su carril y la bandeja la deja en cuarentena
        }
      }
    });
  }
  rekeyLanes();
  const requireAdmin = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'Los conectores los administra un administrador.');
  };
  const describe = kind => {
    const s = selected[kind],
      e = effective(kind);
    return {
      live: kind === 'channel' ? metaLive() : undefined,
      selected: s.provider,
      effective: e.provider,
      configured: s.configured,
      missing: s.missing,
      fallback: s.provider !== e.provider,
      capabilities: s.capabilities,
      channels: s.channels || null,
      webhooksEnabled: s.webhooksEnabled(),
      webhookPath: '/api/webhooks/' + kind + '/' + s.provider,
    };
  };
  function status() {
    return {
      contractVersion: CONTRACT_VERSION,
      channel: describe('channel'),
      payment: describe('payment'),
      requirements: REQUIREMENTS,
      env: {
        CHANNEL_CONNECTOR: channelProvider,
        PAYMENT_CONNECTOR: paymentProvider,
        hasLabSecret: Boolean(env.CONNECTOR_WEBHOOK_SECRET),
      },
      recentEvents: db
        .prepare(
          'SELECT kind,provider,event_id,type,result,created_at FROM connector_events ORDER BY seq DESC LIMIT 20',
        )
        .all(),
    };
  }
  // Oyentes del contrato 1.1 (docs/PLAN_CONTRATO_CANAL.md): otros módulos se apuntan a un tipo de evento de canal
  // sin editar este archivo. Se llaman en orden de `order` (menor primero) DESPUÉS de lo que hace el canal; deben ser
  // síncronos, no abrir transacción ni hacer red. Lo que devuelven (texto) se añade al resultado; un fallo de un
  // oyente se anota y no impide a los demás.
  //   connectors.on('message.status', data => costs.record(data), { order: 300, name: 'costos' })
  // Orden acordado para los estados (conciliación, fila 40): canal → difusiones (200) → costos (300).
  const LISTENED = new Set(['message.status', 'template.update', 'account.update', 'user.preference']);
  const listeners = new Map();
  function on(type, fn, { order = 100, name = 'oyente' } = {}) {
    if (!LISTENED.has(type)) throw new TypeError('Tipo de evento de canal sin oyentes: ' + String(type));
    if (typeof fn !== 'function') throw new TypeError('El oyente debe ser una función.');
    const list = [...(listeners.get(type) || []), { fn, order, name }].sort((a, b) => a.order - b.order);
    listeners.set(type, list);
    return () =>
      listeners.set(
        type,
        (listeners.get(type) || []).filter(l => l.fn !== fn),
      );
  }
  function notify(type, data, context) {
    const notes = [];
    for (const l of listeners.get(type) || []) {
      try {
        const note = l.fn(data, context);
        if (note && typeof note.then === 'function') throw new Error('el oyente debe ser síncrono');
        if (note) notes.push(String(note));
      } catch (e) {
        log.error('Channel listener failed:', l.name, type, e?.message);
        notes.push(l.name + ': error: ' + String(e?.message || e).slice(0, 120));
      }
    }
    return notes;
  }
  // Aplica un evento normalizado una sola vez por (proveedor, id). Devuelve texto legible del resultado.
  function apply(kind, provider, ev) {
    if (!ev.id || !ev.type) return { result: 'rechazado: evento sin id o tipo' };
    if (db.prepare('SELECT 1 FROM connector_events WHERE provider=? AND event_id=?').get(provider, ev.id))
      return { result: 'duplicado: ya se había procesado', duplicate: true };
    let result;
    try {
      if (kind === 'channel' && ev.type === 'message.status') {
        const r = channel.applyStatus(ev.data);
        result = r ? 'aplicado: mensaje ' + r : 'ignorado: no hay mensaje con esa referencia del proveedor';
        const notes = notify(ev.type, ev.data, { provider, applied: r });
        if (notes.length) result += ' · ' + notes.join(' · ');
      } else if (kind === 'channel' && LISTENED.has(ev.type)) {
        const notes = notify(ev.type, ev.data, { provider });
        result = notes.length
          ? 'aplicado: ' + notes.join(' · ')
          : 'registrado: todavía nada en el CRM atiende «' + ev.type + '»';
      } else if (kind === 'channel' && ev.type === 'message.inbound')
        result =
          provider === 'meta'
            ? 'registrado: WhatsApp real está apagado (CHANNEL_CONNECTOR no es «meta»); el mensaje no entró al CRM'
            : 'registrado: entrante recibido; el laboratorio no mapea identidades de clientes reales';
      else if (kind === 'payment' && (ev.type === 'payment.succeeded' || ev.type === 'payment.failed'))
        result = payments.providerEvent(ev, provider);
      else result = 'ignorado: tipo de evento no contemplado para este conector';
    } catch (e) {
      result = 'error: ' + String(e?.message || e).slice(0, 160);
    }
    const payload =
      ev.type === 'message.inbound'
        ? {
            id: ev.id,
            type: ev.type,
            data: {
              to: ev.data?.to || null,
              from: '…' + String(ev.data?.from || '').slice(-4),
              kind: ev.data?.kind || 'text',
            },
          }
        : loggable(ev); // de un entrante nunca se guarda el texto ni el número completo
    db.prepare(
      'INSERT OR IGNORE INTO connector_events(kind,provider,event_id,type,payload,result,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(
      kind,
      provider,
      String(ev.id).slice(0, 200),
      String(ev.type).slice(0, 80),
      JSON.stringify(payload).slice(0, 4000),
      result,
      now(),
    );
    return { result };
  }
  // Entrante real de WhatsApp. A diferencia de apply(): es asíncrono (descarga archivos) y un fallo inesperado NO marca el evento como
  // procesado, para que Meta lo reintente. En la bitácora sólo quedan metadatos: ni el texto ni el número completo.
  async function applyInbound(provider, ev) {
    if (!ev.id) return { result: 'rechazado: evento sin id o tipo' };
    if (db.prepare('SELECT 1 FROM connector_events WHERE provider=? AND event_id=?').get(provider, ev.id))
      return { result: 'duplicado: ya se había procesado', duplicate: true };
    const result = await inbound(ev.data, adapters.channel.meta);
    const safe = {
      id: ev.id,
      type: ev.type,
      data: {
        to: ev.data?.to || null,
        from: '…' + String(ev.data?.from || '').slice(-4),
        kind: ev.data?.kind || 'text',
        media: Boolean(ev.data?.media),
      },
    };
    db.prepare(
      'INSERT OR IGNORE INTO connector_events(kind,provider,event_id,type,payload,result,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(
      'channel',
      provider,
      String(ev.id).slice(0, 200),
      'message.inbound',
      JSON.stringify(safe),
      String(result).slice(0, 300),
      now(),
    );
    return { result };
  }
  // Lo que el trabajador de la bandeja ejecuta por cada evento guardado: la misma decisión que antes tomaba la petición,
  // con las mismas dos funciones. Lo que devuelve es el texto del resultado; si lanza, la bandeja reintenta (salvo 4xx
  // o permanent, que dejan la fila fallida y reprocesable).
  async function processInboxRow(row) {
    let stored = null;
    try {
      stored = JSON.parse(row.payload);
    } catch {
      // se trata abajo: una carga ilegible no mejora por reintentarla
    }
    // Se guarda como {v, event}: la versión del contrato con la que se recibió. El lector acepta 1.0 y 1.1 (y la
    // forma sin sobre) y completa el entrante con la forma 1.1.
    const { event: ev } = readStoredEvent(stored, row.provider);
    if (row.kind === 'channel' && row.provider === 'meta' && ev.type === 'message.inbound') {
      if (channelProvider === 'meta' && !metaLive())
        throw fail(
          503,
          'WhatsApp real está elegido pero le faltan datos (' + adapters.channel.meta.missing.join(', ') + ').',
        );
      if (inbound && metaLive()) {
        // Sin teléfono ni identificador de usuario no se sabe quién escribe: el entrante queda en cuarentena (fila
        // fallida con su carga), sin anotarse como procesado, para reprocesarlo cuando se sepa leer su identificador.
        if (!peerIdentifier(ev.data)) throw permanentError('no_identifier');
        // Sólo con identificador de usuario (BSUID), sin teléfono: el CRM todavía identifica por número. Queda en
        // cuarentena con su carga 1.1 completa, para reprocesarlo cuando la identidad por BSUID exista.
        if (!String(ev.data.from ?? '').trim()) throw permanentError('no_phone');
        return (await applyInbound(row.provider, ev)).result;
      }
    }
    return apply(row.kind, row.provider, ev).result;
  }
  async function rawBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw fail(413, 'Webhook demasiado grande.');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  // Rutas públicas (sin sesión ni comprobación de origen): verificación GET y recepción POST firmada.
  async function handlePublic(req, res, path, url, ip) {
    const x = path.match(/^\/api\/webhooks\/(channel|payment)\/([a-z]+)$/);
    if (!x) return false;
    const kind = x[1],
      adapter = adapters[kind][x[2]];
    if (!adapter) throw fail(404, 'Proveedor no reconocido.');
    if (req.method === 'GET') {
      rate('webhook-get:' + x[2], 60, 60000);
      const ch = adapter.challenge(url.searchParams);
      if (ch === null || ch === undefined) throw fail(403, 'Verificación rechazada.');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(ch));
      return true;
    }
    if (req.method !== 'POST') throw fail(405, 'Método no permitido.');
    if (!adapter.webhooksEnabled())
      throw fail(404, 'Webhooks desactivados para este proveedor: falta su secreto en el entorno.');
    const raw = await rawBody(req);
    if (!adapter.verifyWebhook(req.headers, raw)) throw fail(401, 'Firma del webhook no válida.');
    rate('webhook:' + kind + ':' + x[2], 1200, 60000); // por proveedor y sólo con firma válida: detrás del proxy todas las IP son la misma
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      throw fail(400, 'Cuerpo del webhook no válido.');
    }
    const events = adapter.parseWebhook(parsed),
      accepted = [];
    let blocked = null;
    // Recibir es guardar: cada evento queda en la bandeja (los de una petición, en una sola transacción) y lo procesa
    // su trabajador. No se guardan el que llega sin id o tipo ni el que ya se aplicó: se contestan como siempre.
    if (events.length)
      transaction(db, () => {
        for (const ev of events) {
          if (
            kind === 'channel' &&
            x[2] === 'meta' &&
            ev.type === 'message.inbound' &&
            channelProvider === 'meta' &&
            !metaLive()
          ) {
            // un entrante que el servidor no puede atender no se guarda (lo anterior de la petición, sí)
            blocked = fail(
              503,
              'WhatsApp real está elegido pero le faltan datos (' +
                adapters.channel.meta.missing.join(', ') +
                '); Meta reintentará el mensaje.',
            );
            return;
          }
          if (!ev.id || !ev.type) {
            accepted.push({ ev, fixed: { result: 'rechazado: evento sin id o tipo' } });
            continue;
          }
          if (db.prepare('SELECT 1 FROM connector_events WHERE provider=? AND event_id=?').get(x[2], ev.id)) {
            accepted.push({ ev, fixed: { result: 'duplicado: ya se había procesado', duplicate: true } });
            continue;
          }
          const row = inbox.accept({
            kind,
            provider: x[2],
            id: ev.id,
            type: ev.type,
            lane: laneOf(kind, x[2], ev, peerHash),
            payload: { v: CONTRACT_VERSION, event: ev },
          });
          accepted.push({ ev, row });
        }
      });
    inbox.wake();
    if (blocked) throw blocked;
    // La petición espera un tiempo acotado a que sus eventos terminen; si terminan, responde con su resultado de siempre.
    const rows = await inbox.settled(
      accepted.filter(a => a.row).map(a => a.row.seq),
      waitMs,
    );
    const results = accepted.map(({ ev, fixed, row }) => {
      if (fixed) return { id: ev.id, type: ev.type, ...fixed };
      const r = rows.get(row.seq) || row;
      if (r.state === 'done')
        return {
          id: ev.id,
          type: ev.type,
          result: r.result,
          ...(row.existing && row.state === 'done' ? { duplicate: true } : {}),
        };
      if (r.state === 'failed')
        return { id: ev.id, type: ev.type, result: 'error: ' + String(r.error || '').slice(0, 160) };
      return { id: ev.id, type: ev.type, result: 'en cola: se procesa en segundo plano', queued: true };
    });
    json(res, 200, { received: events.length, results });
    return true;
  }
  // Prueba firmada desde la interfaz: construye un evento real del laboratorio y lo manda al propio webhook simulado.
  async function test(input, user) {
    if (!env.CONNECTOR_WEBHOOK_SECRET)
      throw fail(409, 'Define CONNECTOR_WEBHOOK_SECRET en el entorno para probar webhooks firmados.');
    let kind, ev;
    if (input.kind === 'payment') {
      const o = db
        .prepare('SELECT * FROM orders WHERE id=? OR reference=? ORDER BY created_at DESC LIMIT 1')
        .get(String(input.order || ''), String(input.order || '').toUpperCase());
      if (!o) throw fail(404, 'Pedido no encontrado: indica su referencia TC-… o su id.');
      kind = 'payment';
      ev = {
        id: 'test_' + randomUUID(),
        type: input.type === 'payment.failed' ? 'payment.failed' : 'payment.succeeded',
        data: {
          orderId: o.id,
          reference: o.reference,
          providerRef: 'simpay_' + hex(6),
          method: ['card', 'oxxo'].includes(input.method) ? input.method : 'card',
          reason: 'Rechazo de prueba',
        },
      };
    } else {
      const m = input.message
        ? db
            .prepare('SELECT id,provider_ref FROM messages WHERE id=? OR provider_ref=?')
            .get(String(input.message), String(input.message))
        : db
            .prepare(
              "SELECT id,provider_ref FROM messages WHERE sender_kind IN ('agent','automation') ORDER BY seq DESC LIMIT 1",
            )
            .get();
      if (!m) throw fail(404, 'No hay mensajes salientes para probar.');
      const ref = m.provider_ref || 'simch_' + hex(6);
      if (!m.provider_ref) db.prepare('UPDATE messages SET provider_ref=? WHERE id=?').run(ref, m.id);
      kind = 'channel';
      ev = {
        id: 'test_' + randomUUID(),
        type: 'message.status',
        data: {
          providerRef: ref,
          state: ['delivered', 'read', 'failed'].includes(input.state) ? input.state : 'read',
          reason: input.state === 'failed' ? 'Fallo de prueba' : null,
          at: now(),
        },
      };
    }
    const raw = JSON.stringify({ events: [ev] }),
      r = await fetch(selfOrigin() + '/api/webhooks/' + kind + '/simulated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-lab-signature': hmacHex(env.CONNECTOR_WEBHOOK_SECRET, raw) },
        body: raw,
        signal: AbortSignal.timeout(10000),
      });
    const data = await r.json().catch(() => ({}));
    audit(user, 'connectors.test', ev.id);
    return { status: r.status, sent: ev, response: data };
  }
  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/connectors')) return false;
    requireAdmin(user);
    if (path === '/api/connectors' && req.method === 'GET') {
      json(res, 200, status());
      return true;
    }
    if (path === '/api/connectors/test' && req.method === 'POST') {
      json(res, 200, await test(await body(req), user));
      return true;
    }
    // Bandeja de entrada de webhooks: qué está en cola o falló (sin la carga, que lleva textos y números) y reproceso
    // de una fila fallida, por ejemplo un entrante en cuarentena por «no_identifier».
    if (path === '/api/connectors/inbox' && req.method === 'GET') {
      const p = new URL(req.url, 'http://localhost').searchParams;
      json(res, 200, {
        stats: inbox.stats(),
        items: inbox.list({ state: p.get('state') || 'failed', limit: p.get('limit') }),
      });
      return true;
    }
    const again = path.match(/^\/api\/connectors\/inbox\/(\d{1,15})\/retry$/);
    if (again && req.method === 'POST') {
      const item = inbox.retry(Number(again[1]));
      audit(user, 'connectors.inbox.retry', again[1]);
      json(res, 200, { item });
      return true;
    }
    throw fail(404, 'Ruta de conectores no encontrada.');
  }
  return { status, handle, handlePublic, apply, effective, selected, adapters, useInbound, metaLive, inbox, on };
}
