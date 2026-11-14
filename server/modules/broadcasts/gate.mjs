// Puerta de envío por número: ¿se puede enviar y cuánto queda del límite diario? (conciliación, fila 39).
//
// La salud del número y de la cuenta es de otro módulo (server/modules/channel-health/, otro frente):
//   canSend(accountRef, category) → {ok, reason?}
//   limitsOf(accountRef)          → {limit, used, remaining}
// Si ese módulo está cargado, manda él. Si no (o si falla), se aplica un tope conservador: el `daily_cap` de la marca
// (250 por omisión, el nivel más bajo de Meta) o el límite anotado en la cuenta (`wa_account.limit_value`), contra los
// destinatarios distintos a los que este número escribió con plantilla en las últimas 24 horas. Esta es la ÚNICA unión
// con channel-health: test/broadcasts-engine.test.mjs la prueba con un doble.
//
// `accountRef` es el identificador del número de Meta (phone_number_id): el límite diario de Meta se cuenta por
// número (personas distintas en 24 h) y la calidad también es del número.
export function createSendGate({ health, fallbackLimit, usedToday, log = console }) {
  const module = () => {
    try {
      return health() ?? null;
    } catch {
      return null; // el módulo no existe todavía: tope conservador
    }
  };
  function check(accountRef, category, brandId) {
    const h = module();
    if (h && typeof h.canSend === 'function' && typeof h.limitsOf === 'function') {
      try {
        const verdict = h.canSend(accountRef, category) ?? { ok: true };
        const limits = h.limitsOf(accountRef) ?? {};
        const remaining = Number.isFinite(limits.remaining) ? Math.max(0, Math.floor(limits.remaining)) : Infinity;
        return {
          ok: verdict.ok !== false,
          reason: verdict.ok === false ? String(verdict.reason || 'number_restricted') : null,
          limit: Number.isFinite(limits.limit) ? limits.limit : null,
          used: Number.isFinite(limits.used) ? limits.used : null,
          remaining,
          source: 'channel-health',
        };
      } catch (error) {
        log.error('Salud del número no disponible; se usa el tope conservador:', String(error?.message || error));
      }
    }
    const limit = Math.max(0, Math.floor(Number(fallbackLimit(accountRef, brandId)) || 0));
    const used = Math.max(0, Math.floor(Number(usedToday(accountRef)) || 0));
    return { ok: true, reason: null, limit, used, remaining: Math.max(0, limit - used), source: 'fallback' };
  }
  return { check };
}
