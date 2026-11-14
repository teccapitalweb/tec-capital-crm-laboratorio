// Puerta de envío por número: ¿se puede enviar y cuánto queda del límite diario? (conciliación, fila 39).
//
// La salud del número y de la cuenta es de server/modules/channel-health/ (otro frente):
//   canSend(accountRef, category) → {ok, reason?}
//   limitsOf(accountRef)          → {limit, used, remaining}      (remaining null = sin límite)
// con accountRef = 'wa:' + phone_number_id. Si ese módulo está cargado, manda él; si no (o si falla), se aplica un
// tope conservador: el `daily_cap` de la marca (250 por omisión, el nivel más bajo de Meta) o el límite anotado en la
// cuenta (`wa_account.limit_value`). En los dos casos lo usado se compara también con lo que este motor contó (las
// personas distintas a las que el número escribió con difusiones reales en 24 h): un dato de salud con caché no deja
// pasar de largo el límite. Esta es la ÚNICA unión con channel-health; test/broadcasts-engine.test.mjs la prueba con un
// doble y con el módulo real.
//
// Qué hace el motor con cada «no» de la salud: llegar al límite no detiene la campaña (espera al día siguiente); lo
// demás la detiene con su motivo.
const STOP = Object.freeze({
  number_disabled: 'number_paused',
  payment_missing: 'payment_problem',
  quality_low: 'quality_low',
});

export function createSendGate({ health, fallbackLimit, usedToday, log = console }) {
  const module = () => {
    try {
      return health() ?? null;
    } catch {
      return null; // el módulo no existe: tope conservador
    }
  };
  function check(numberId, category, brandId) {
    const ownUsed = Math.max(0, Math.floor(Number(usedToday(numberId)) || 0));
    const h = module();
    if (h && typeof h.canSend === 'function' && typeof h.limitsOf === 'function') {
      const ref = String(numberId).startsWith('wa:') ? String(numberId) : 'wa:' + numberId;
      try {
        const verdict = h.canSend(ref, category) ?? { ok: true };
        const limits = h.limitsOf(ref) ?? {};
        const limit = Number.isFinite(limits.limit) ? limits.limit : null;
        const used = Math.max(Number.isFinite(limits.used) ? limits.used : 0, ownUsed);
        let remaining = Number.isFinite(limits.remaining) ? Math.max(0, Math.floor(limits.remaining)) : Infinity;
        if (limit !== null) remaining = Math.min(remaining, Math.max(0, limit - used));
        const reason = verdict.ok === false ? String(verdict.reason || 'number_restricted') : null;
        if (reason === 'limit_reached') remaining = 0;
        const blocking = reason && reason !== 'limit_reached' && reason !== 'invalid_category';
        return {
          ok: !blocking,
          reason: blocking ? (STOP[reason] ?? 'number_restricted') : null,
          detail: reason,
          limit,
          used,
          remaining,
          source: 'channel-health',
        };
      } catch (error) {
        log.error('Salud del número no disponible; se usa el tope conservador:', String(error?.message || error));
      }
    }
    const limit = Math.max(0, Math.floor(Number(fallbackLimit(numberId, brandId)) || 0));
    return {
      ok: true,
      reason: null,
      detail: null,
      limit,
      used: ownUsed,
      remaining: Math.max(0, limit - ownUsed),
      source: 'fallback',
    };
  }
  return { check };
}
