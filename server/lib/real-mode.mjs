// Modo real por marca (docs/PLAN_MODO_REAL.md): una marca que atiende clientes de verdad no dice «chat de prueba»,
// «precio de ejemplo» ni «pago de prueba», y no acepta métodos de pago simulados. Apagado por omisión: sin fila en
// brand_real_mode (o con enabled=0) la marca sigue en laboratorio y todo se comporta como siempre.
//
// Aquí sólo hay funciones: leer el interruptor y pasar un texto armado por el sistema a su versión real. Los textos
// propios del asistente (y sus equivalentes reales) viven en server/reply-copy.mjs; esta biblioteca no inventa datos:
// sólo cambia las frases de laboratorio conocidas y quita las oraciones que avisan de la prueba.
import { LAB_SWAPS } from '../reply-copy.mjs';

// Lo que delata al laboratorio en un texto para el cliente. Es estrecho a propósito: «laboratorio» o «simulado» a secas
// pueden ser parte de un curso real («Bioseguridad en el laboratorio», «práctica simulada»), así que sólo cuentan las
// frases con las que el CRM avisa de la prueba.
export const LAB_WORDING =
  /chat de prueba|pagos? de prueba|tarjetas? de prueba|precios? de ejemplo|son de ejemplo|comprobante de ejemplo|(?:aviso|certificado|encuesta|ficha|inscripción|datos|cifras) de práctica|pagos? simulad[oa]s?|tarjeta simulada|pasarela simulada|\(simulad[oa]s?\)|(?:^|[\s(])laboratorio\s*:|en este laboratorio|\(laboratorio\)|cobros? reales?|ningún cobro real|no se cobra nada real|no constituye una oferta comercial real/i;

// ¿La marca atiende clientes reales? Una lectura por llave primaria; si la tabla aún no existe (base a medio migrar en
// una prueba), la marca sigue en laboratorio.
export function isRealBrand(db, brandId) {
  if (!brandId) return false;
  try {
    return db.prepare('SELECT enabled FROM brand_real_mode WHERE brand_id=?').get(brandId)?.enabled === 1;
  } catch {
    return false;
  }
}

export function realModeOf(db, brandId) {
  const row = db.prepare('SELECT * FROM brand_real_mode WHERE brand_id=?').get(brandId);
  return (
    row || { brand_id: brandId, enabled: 0, payment_instructions: '', revision: 0, updated_by: null, updated_at: null }
  );
}

// Oraciones de una línea: corta después de «.», «!», «?» o «)» seguidos de espacio.
const sentences = line => line.split(/(?<=[.!?)])\s+/);

// Texto armado por el sistema → versión para un cliente real. Determinista y sin red: primero los cambios exactos de
// reply-copy (p. ej. las formas de pago), luego «Precio de ejemplo:» → «Precio:», y al final se quitan las oraciones
// (o renglones) que avisan de la prueba. Lo demás (precio, fechas, enlaces, nombres) queda igual.
export function realText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [lab, real] of LAB_SWAPS) out = out.split(lab).join(real);
  out = out
    .replace(/precio de ejemplo\s*:/gi, m => (m[0] === 'P' ? 'Precio:' : 'precio:'))
    .replace(/\s*\((?:simulad[oa]|laboratorio)\)/gi, '')
    // fecha heredada de los cursos de demostración («Fecha de práctica por confirmar»): se dice sin «de práctica»
    .replace(/(fecha) de práctica (por confirmar)/gi, '$1 $2');
  if (!LAB_WORDING.test(out)) return out;
  const lines = out.split('\n').map(line => {
    if (!LAB_WORDING.test(line)) return line;
    const kept = sentences(line).filter(s => !LAB_WORDING.test(s));
    return kept.length ? kept.join(' ') : null;
  });
  return lines
    .filter(l => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Atajo de los servicios: el texto tal cual para una marca de laboratorio y su versión real para una marca real.
export const forBrand = (db, brandId, text) => (isRealBrand(db, brandId) ? realText(text) : text);
