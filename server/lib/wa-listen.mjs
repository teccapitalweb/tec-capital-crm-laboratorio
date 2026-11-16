// Modo escucha de un número de WhatsApp (I-11, docs/PLAN_CAMBIO_DE_NUMERO.md; diseño de identidad y mudanza §7.5).
//
// Antes del corte, el número real se conecta al CRM mientras el proveedor anterior sigue atendiendo. En escucha el CRM
// recibe, identifica y CUENTA cada mensaje, pero no guarda su contenido, no crea conversación, no responde y no envía
// nada, salvo a los teléfonos de la lista de prueba (`wa_numbers.listen_allow`, hasta diez).
//
// Esta biblioteca no tiene rutas y la usa server/whatsapp.mjs directamente (no depende de que cargue un módulo: un
// número en escucha nunca debe caer al camino normal por un módulo que falló):
//   gate(m)                         la puerta ÚNICA de salida: connectors.mjs la llama antes de CADA envío a Meta
//                                   (chat, asistente, plantillas, difusiones, programados, recordatorios). Lanza 409
//                                   `number_listen_only` si el número está en escucha y el destino no es de prueba.
//   canSendFrom(numberId, {to, recipient}) → {ok, test?, code?, message?}   la misma decisión, para preguntar antes.
//   allowed(number, phone)          ¿ese teléfono está en la lista de prueba del número?
//   firstSeen / countPerson / countError / onStatus   contadores por día (dentro de la transacción del llamador).
//   stats(numberId, {days})         los contadores de los últimos días y lo que sigue en cuarentena.
//
// Privacidad: de un mensaje en escucha sólo queda su referencia de Meta (para no contarlo dos veces) y el cliente
// interno de quien escribió (para contar personas distintas); nunca el texto, el archivo ni el teléfono.
import { phoneKey } from './identity-keys.mjs';

export const MODES = Object.freeze(['live', 'listen']);
export const MAX_ALLOW = 10;
const KEEP_DAYS = 35; // lo que se guarda para no contar dos veces
const TIMEZONE = 'America/Mexico_City'; // el día de los contadores: el de la operación, como el del proveedor anterior
const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const dayOf = t => dayFormat.format(new Date(t));

export const LISTEN_ONLY =
  'Este número está en modo escucha: el proveedor anterior sigue atendiendo y el CRM no envía nada por él, salvo a los teléfonos de prueba. Pásalo a activo en Gestión → Cambio de número.';

// La lista de prueba como se guarda: claves de teléfono canónicas, sin repetir, como mucho diez.
export function parseAllow(value) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      list = [];
    }
  }
  return Array.isArray(list) ? list.filter(k => typeof k === 'string' && k) : [];
}
export function normalizeAllow(input) {
  if (!Array.isArray(input)) return { error: 'La lista de prueba es una lista de teléfonos.' };
  const keys = [];
  for (const raw of input) {
    const key = typeof raw === 'string' && raw.trim() ? phoneKey(raw, { international: true }) : null;
    if (!key) return { error: 'Revisa la lista de prueba: hay un teléfono que no es válido (con lada de país).' };
    if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length > MAX_ALLOW) return { error: `La lista de prueba admite hasta ${MAX_ALLOW} teléfonos del equipo.` };
  return { keys };
}

export function createListen({ db, now = Date.now }) {
  const statements = new Map();
  const q = sql => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  const numberRow = id => q('SELECT * FROM wa_numbers WHERE phone_number_id=?').get(String(id ?? ''));
  const isListen = number => number?.mode === 'listen';

  function allowed(number, phone) {
    if (!phone) return false;
    const key = phoneKey(String(phone), { international: true });
    return Boolean(key && parseAllow(number?.listen_allow).includes(key));
  }

  function canSendFrom(numberId, { to = null } = {}) {
    const number = numberRow(numberId);
    if (!isListen(number)) return { ok: true };
    // sólo por teléfono: quien no comparte su número (identificador de usuario) no puede estar en la lista de prueba
    if (allowed(number, to)) return { ok: true, test: true };
    return { ok: false, code: 'number_listen_only', message: LISTEN_ONLY };
  }
  // La puerta: síncrona, sin red ni transacción; la llama connectors.mjs justo antes de pedirle a Meta un envío.
  function gate(m) {
    const verdict = canSendFrom(m?.from, { to: m?.to ?? null, recipient: m?.recipient ?? null });
    if (!verdict.ok) throw Object.assign(new Error(verdict.message), { status: 409, code: verdict.code });
  }

  // ---- Contadores por día. Dentro de la transacción del entrante (o del procesador de webhooks): sin abrir otra.
  const bump = (number, t, column) =>
    q(
      `INSERT INTO wa_listen_days(phone_number_id,day,brand_id,${column}) VALUES(?,?,?,1) ON CONFLICT(phone_number_id,day) DO UPDATE SET ${column}=${column}+1`,
    ).run(number.phone_number_id, dayOf(t), number.brand_id);
  const seen = (number, t, kind, ref) =>
    q('INSERT OR IGNORE INTO wa_listen_seen(phone_number_id,day,kind,ref) VALUES(?,?,?,?)').run(
      number.phone_number_id,
      dayOf(t),
      kind,
      ref,
    ).changes === 1;

  // El mensaje se cuenta una sola vez (Meta reintenta): false si ya estaba contado.
  function firstSeen(number, providerRef, t = now()) {
    if (!seen(number, t, 'message', String(providerRef).slice(0, 200))) return false;
    bump(number, t, 'received');
    // limpieza ligera: lo de hace más de KEEP_DAYS días ya no puede repetirse
    q('DELETE FROM wa_listen_seen WHERE day<?').run(dayOf(t - KEEP_DAYS * 86_400_000));
    return true;
  }
  function countPerson(number, userId, t = now()) {
    if (seen(number, t, 'person', dayOf(t) + ':' + userId)) bump(number, t, 'people');
  }
  function countError(number, t = now()) {
    try {
      bump(number, t, 'errors');
    } catch {
      // el contador nunca tapa el error original
    }
  }
  // Oyente de estados (connectors.on('message.status')): un estado que no se casó con ningún mensaje del CRM y llega
  // a un número en escucha es de un mensaje que envió el proveedor anterior. Se cuenta y no se toca nada más.
  function onStatus(data, context) {
    const number = numberRow(data?.account?.externalId);
    if (!isListen(number) || context?.applied) return null;
    bump(number, now(), 'statuses');
    return 'escucha: estado de un mensaje del proveedor anterior, contado';
  }

  // ---- Lectura: los últimos `days` días (el más reciente primero) y la cuarentena «sin identidad» de este número.
  function stats(numberId, { days = 7, t = now() } = {}) {
    const number = numberRow(numberId);
    if (!number) return null;
    const list = [];
    for (let i = 0; i < days; i++) list.push(dayOf(t - i * 86_400_000));
    const unique = [...new Set(list)];
    const rows = new Map(
      q('SELECT * FROM wa_listen_days WHERE phone_number_id=? AND day>=? ORDER BY day DESC')
        .all(number.phone_number_id, unique.at(-1))
        .map(r => [r.day, r]),
    );
    const unidentified = new Map();
    let quarantine = 0;
    // la cuarentena guarda la carga (14 días) con el número de destino; se cuenta lo que sigue sin resolver
    for (const r of q(
      "SELECT payload,received_at FROM webhook_inbox WHERE kind='channel' AND provider='meta' AND state='failed' AND error IN ('no_identifier','no_phone') AND payload IS NOT NULL ORDER BY seq DESC LIMIT 2000",
    ).all()) {
      let to = null;
      try {
        const stored = JSON.parse(r.payload);
        to = String((stored?.event ?? stored)?.data?.to ?? '');
      } catch {
        continue;
      }
      if (to !== number.phone_number_id) continue;
      quarantine++;
      const day = dayOf(r.received_at);
      unidentified.set(day, (unidentified.get(day) ?? 0) + 1);
    }
    return {
      quarantine,
      days: unique.map(day => {
        const r = rows.get(day);
        return {
          day,
          received: r?.received ?? 0,
          people: r?.people ?? 0,
          unidentified: unidentified.get(day) ?? 0,
          statuses: r?.statuses ?? 0,
          errors: r?.errors ?? 0,
        };
      }),
    };
  }

  return { isListen, allowed, canSendFrom, gate, firstSeen, countPerson, countError, onStatus, stats };
}
