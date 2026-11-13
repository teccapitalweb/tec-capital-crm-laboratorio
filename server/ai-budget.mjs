// Tope de gasto de la IA (docs/PLAN_CONOCIMIENTO_POR_LOTE.md). Cada llamada real al proveedor deja una fila en `audit` (acción
// `ai.call`, con tipo, modelo y tokens) y, antes de la siguiente llamada, se compara el mes en curso contra los topes de entorno:
// AI_MONTHLY_CALL_LIMIT (llamadas; 1000 por omisión, 0 = sin tope) y AI_MONTHLY_TOKEN_LIMIT (tokens de entrada + salida; 0 = sin tope).
// Al alcanzarlo el proveedor deja de llamar y la conversación pasa a una persona, como si no hubiera respuesta. No hace falta
// esquema nuevo. Las respuestas simuladas no cuentan: sólo las llamadas reales.
export function createAiBudget({ db, env = process.env, now = Date.now }) {
  const limit = (v, d) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  const callLimit = limit(env.AI_MONTHLY_CALL_LIMIT, 1000),
    tokenLimit = limit(env.AI_MONTHLY_TOKEN_LIMIT, 0);
  const monthStart = () => {
    const d = new Date(now());
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  };
  function usage() {
    let calls = 0,
      input = 0,
      output = 0;
    const byKind = {};
    for (const r of db
      .prepare("SELECT entity_id FROM audit WHERE action='ai.call' AND created_at>=?")
      .all(monthStart())) {
      let x = {};
      try {
        x = JSON.parse(r.entity_id);
      } catch {}
      calls++;
      input += Number(x.in) || 0;
      output += Number(x.out) || 0;
      byKind[x.kind || 'otro'] = (byKind[x.kind || 'otro'] || 0) + 1;
    }
    const tokens = input + output,
      blocked = (callLimit > 0 && calls >= callLimit) || (tokenLimit > 0 && tokens >= tokenLimit);
    return {
      month: new Date(monthStart()).toISOString().slice(0, 7),
      calls,
      inputTokens: input,
      outputTokens: output,
      tokens,
      byKind,
      callLimit,
      tokenLimit,
      blocked,
    };
  }
  function check() {
    const u = usage();
    if (callLimit > 0 && u.calls >= callLimit)
      return (
        'Se alcanzó el tope mensual de llamadas a la IA (' +
        callLimit +
        '). Un administrador puede subir AI_MONTHLY_CALL_LIMIT; mientras tanto responde una persona.'
      );
    if (tokenLimit > 0 && u.tokens >= tokenLimit)
      return (
        'Se alcanzó el tope mensual de tokens de la IA (' +
        tokenLimit +
        '). Un administrador puede subir AI_MONTHLY_TOKEN_LIMIT; mientras tanto responde una persona.'
      );
    return null;
  }
  function record({ kind, model, input = 0, output = 0 }) {
    db.prepare('INSERT INTO audit(user_id,action,entity_id,created_at) VALUES(NULL,?,?,?)').run(
      'ai.call',
      JSON.stringify({
        kind,
        model: String(model || '').slice(0, 60),
        in: Number(input) || 0,
        out: Number(output) || 0,
      }),
      now(),
    );
  }
  return { check, record, usage };
}
