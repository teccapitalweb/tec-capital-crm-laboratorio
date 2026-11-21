// Margen después de un archivo en WhatsApp real (docs/PLAN_WHATSAPP_REAL.md, «Orden de los mensajes»).
// WhatsApp entrega más tarde un mensaje con archivo (imagen, documento, video, audio) que uno de texto enviado justo
// después, aunque Meta los haya aceptado en orden: en el teléfono los botones llegaban antes que la imagen de la ficha.
// Tras aceptar Meta un archivo, el siguiente mensaje de ESA conversación espera este margen (o el aviso de «entregado»
// del archivo, si llega antes). Variable WA_MEDIA_GAP_MS: milisegundos, entre 0 (sin margen) y 30000. Por omisión
// 2500; con NODE_ENV=test, 0, para que las pruebas no esperen (la prueba del margen lo pone a propósito).
export const MEDIA_GAP_DEFAULT_MS = 2500;
export const MEDIA_GAP_MAX_MS = 30_000;

export function mediaGapMs(env = process.env) {
  const raw = env.WA_MEDIA_GAP_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '')
    return env.NODE_ENV === 'test' ? 0 : MEDIA_GAP_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return MEDIA_GAP_DEFAULT_MS;
  return Math.min(Math.max(Math.round(n), 0), MEDIA_GAP_MAX_MS);
}
