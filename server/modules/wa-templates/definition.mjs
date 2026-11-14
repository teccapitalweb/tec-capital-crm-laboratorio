// Definición canónica de una plantilla de WhatsApp (wa_templates.components) y su validación (diseño de difusiones
// §6.2 a §6.4). Funciones puras: sin base de datos ni red.
//
// Forma canónica:
//   { type: 'standard',
//     header: { type: 'none' } | { type: 'text', text: 'Hola {{1}}', vars: [Var] }
//           | { type: 'image' | 'document', fileId, filename, mime },
//     body:   { text: 'Hola {{1}}, …', vars: [Var] },
//     footer: { text } | null,
//     buttons: [ { type: 'quick_reply', text } | { type: 'url', text, url: 'https://…/{{1}}', var: Var | null }
//              | { type: 'phone', text, phone } | { type: 'copy_code', code: Var } | { type: 'flow', text } ] }
//   Var = { key: 'nombre' | 'fijo.vigencia' | … | null, sample, fallback }   (key null: plantilla adoptada sin indicar
//   de dónde sale ese dato; no se ofrece en el chat hasta completarla)
//
// El editor escribe con variables POR NOMBRE ({{nombre}}, {{fijo.vigencia}}, {{nombre|Hola}}); a Meta viajan
// numeradas por componente (cada uno empieza en 1). La gramática y la numeración son las de server/lib/variables.mjs.
import { cleanParam, extract, toNumbered } from '../../lib/variables.mjs';

export const LANGUAGES = Object.freeze(['es_MX', 'es', 'es_ES', 'es_AR', 'es_CO', 'en_US', 'en', 'pt_BR']);
export const CATEGORIES = Object.freeze(['utility', 'marketing']);
export const PURPOSES = Object.freeze(['manual', 'notice']);
export const HEADER_FILE_TYPES = Object.freeze({ image: ['image/jpeg', 'image/png'], document: ['application/pdf'] });

// Datos que el chat sabe llenar con la conversación (los de siempre; sin datos de contacto).
export const CHAT_KEYS = Object.freeze({
  nombre: 'Nombre de la persona',
  curso: 'Curso',
  edicion: 'Edición',
  marca: 'Marca',
});
// Muestra por omisión (para Meta y para la vista previa) de los datos del chat.
export const SAMPLE = Object.freeze({
  nombre: 'María',
  curso: 'Plan sanitario para aves',
  edicion: 'Edición general',
  marca: 'GlobalVet',
});
// Fuentes propias de las plantillas (conciliación, fila 13): un valor fijo por envío, el cupón y el valor que manda
// quien llama por la API. No las llena el chat: una plantilla con ellas sólo sale en el chat si tienen respaldo.
const OWN = /^(fijo|llamada)\.[a-z0-9_]{1,30}$/;
export const isSourceKey = key => Object.hasOwn(CHAT_KEYS, key) || key === 'cupon' || OWN.test(key);
export const chatCanFill = v => Boolean(v.key && Object.hasOwn(CHAT_KEYS, v.key)) || Boolean(v.fallback);

const STATUS_LABELS = {
  draft: 'Borrador',
  pending: 'En revisión de Meta',
  approved: 'Aprobada',
  flagged: 'Aprobada · en observación por calidad',
  rejected: 'Rechazada',
  paused: 'Pausada por Meta',
  disabled: 'Desactivada por Meta',
  in_appeal: 'En apelación',
  pending_deletion: 'Borrada en Meta',
  deleted: 'Borrada en Meta',
  missing: 'Ya no está en Meta',
  archived: 'Archivada por Meta por falta de uso',
  limit_exceeded: 'Meta: límite de plantillas excedido',
};
export const statusLabel = status => STATUS_LABELS[status] ?? `Meta: ${status}`;
export const SENDABLE = Object.freeze(['approved', 'flagged']);

const REJECT_TEXT = [
  [/INVALID_FORMAT/, 'El formato no es válido: revisa variables, muestras y saltos de línea.'],
  [
    /TAG_CONTENT_MISMATCH|INCORRECT_CATEGORY|PROMOTIONAL/,
    'El contenido no corresponde a la categoría elegida (por ejemplo, promoción en una de utilidad).',
  ],
  [/ABUSIVE_CONTENT|SCAM/, 'Meta la consideró contraria a sus políticas de contenido.'],
];
export const rejectText = reason =>
  REJECT_TEXT.find(([pattern]) => pattern.test(String(reason || '')))?.[1] ??
  'Meta no indicó el motivo. Revísalo en WhatsApp Manager; ahí también se apela.';

const bad = (message, field) => Object.assign(new Error(message), { status: 400, field });
const asText = (value, max) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim()
        .slice(0, max)
    : '';
const PROMO = /descuento|promoci[oó]n|oferta|%|gratis/i;
const VARS_HINT = 'Usa {{nombre}}, {{curso}}, {{edicion}} o {{marca}}.';

// Texto de un componente con variables por nombre → texto numerado y sus variables con muestra y respaldo.
function numbered(raw, { field, samples, fallbacks, maxVars }) {
  for (const token of extract(raw)) {
    if (token.kind === 'numbered')
      throw bad('Usa los datos por su nombre: {{nombre}}, {{curso}}, {{edicion}} o {{marca}}.', field);
    if (token.kind === 'invalid' || !isSourceKey(token.key))
      throw bad(`«${token.raw}» no es un dato disponible. ${VARS_HINT}`, field);
  }
  const { text, keys, fallbacks: written } = toNumbered(raw);
  if (/\{\{|\}\}/.test(text.replace(/\{\{\d+\}\}/g, ''))) throw bad('Hay llaves sin cerrar en el texto.', field);
  if (keys.length > maxVars)
    throw bad(maxVars === 1 ? 'Este texto admite un solo dato.' : `El texto admite hasta ${maxVars} datos.`, field);
  const vars = keys.map(key => ({
    key,
    sample: cleanParam(samples?.[key] ?? SAMPLE[key] ?? '') || null,
    fallback: cleanParam(written[key] ?? fallbacks?.[key] ?? '') || null,
  }));
  return { text, vars };
}

// Convierte lo que escribe el editor (§6.3) en la definición canónica y devuelve también los avisos (no errores).
// `files` resuelve un archivo de la biblioteca de la marca: fileId → {id, filename, mime, size} o null.
// Lanza un error 400 con el primer problema (los mensajes que comprueba la prueba de siempre se conservan).
export function fromEditor(input, { files = () => null } = {}) {
  const samples = input.samples && typeof input.samples === 'object' ? input.samples : {};
  const fallbacks = input.fallbacks && typeof input.fallbacks === 'object' ? input.fallbacks : {};
  const warnings = [];
  const warn = (code, label) => warnings.push({ code, label });

  // ---- cuerpo
  const raw = asText(input.body, 1024);
  if (raw.length < 10) throw bad('Escribe el texto de la plantilla (al menos 10 caracteres).', 'body');
  if (/\t/.test(raw)) throw bad('El texto no admite tabuladores.', 'body');
  if (/\n\s*\n\s*\n/.test(raw)) throw bad('El texto no admite más de dos saltos de línea seguidos.', 'body');
  const body = numbered(raw, { field: 'body', samples, fallbacks, maxVars: 10 });
  if (/^\{\{\d+\}\}/.test(body.text) || /\{\{\d+\}\}$/.test(body.text))
    throw bad(
      'Meta no acepta que el texto empiece o termine con un dato: agrega una palabra antes y un punto después.',
      'body',
    );
  if (body.text.replace(/\{\{\d+\}\}/g, '').trim().length < body.vars.length * 8)
    throw bad('La plantilla tiene demasiados datos para tan poco texto: Meta la rechazaría.', 'body');

  // ---- encabezado
  const h = input.header && typeof input.header === 'object' ? input.header : { type: 'none' };
  let header = { type: 'none' };
  if (h.type === 'text') {
    const text = asText(h.text, 61);
    if (!text) throw bad('Escribe el texto del encabezado o quítalo.', 'header');
    if (text.length > 60) throw bad('El encabezado admite hasta 60 caracteres.', 'header');
    if (/[\n*_~`]/.test(text)) throw bad('El encabezado no admite saltos de línea ni formato.', 'header');
    header = { type: 'text', ...numbered(text, { field: 'header', samples, fallbacks, maxVars: 1 }) };
  } else if (h.type === 'image' || h.type === 'document') {
    header = { type: h.type, fileId: null, filename: null, mime: null };
    if (h.fileId) {
      const file = files(String(h.fileId));
      if (!file) throw bad('El archivo del encabezado no está en la biblioteca de la marca.', 'header');
      if (!HEADER_FILE_TYPES[h.type].includes(file.mime))
        throw bad(
          h.type === 'image' ? 'El encabezado con imagen admite JPG o PNG.' : 'El encabezado con documento admite PDF.',
          'header',
        );
      if (file.size > 4 * 1024 * 1024) throw bad('El archivo del encabezado no puede pasar de 4 MB.', 'header');
      Object.assign(header, { fileId: file.id, filename: file.filename, mime: file.mime });
    }
  } else if (h.type && h.type !== 'none') throw bad('El encabezado puede ser texto, imagen o documento.', 'header');

  // ---- pie
  const footerText = asText(input.footer, 61);
  if (footerText.length > 60) throw bad('El pie admite hasta 60 caracteres.', 'footer');
  if (/\{\{/.test(footerText)) throw bad('El pie no admite datos.', 'footer');
  if (/\n/.test(footerText)) throw bad('El pie no admite saltos de línea.', 'footer');
  const footer = footerText ? { text: footerText } : null;

  // ---- botones
  const list = Array.isArray(input.buttons) ? input.buttons : [];
  if (list.length > 10) throw bad('Una plantilla admite hasta 10 botones.', 'buttons');
  const buttons = [];
  const seen = new Set();
  for (const b of list) {
    const type = String(b?.type || '');
    const label = asText(b?.text, 26);
    if (type !== 'copy_code') {
      if (!label) throw bad('Cada botón necesita su texto.', 'buttons');
      if (label.length > 25) throw bad(`El texto del botón «${label}» pasa de 25 caracteres.`, 'buttons');
      if (/\{\{/.test(label)) throw bad('El texto de un botón no admite datos.', 'buttons');
    }
    if (type === 'quick_reply') {
      if (seen.has(label.toLowerCase())) throw bad(`Hay dos botones de respuesta «${label}».`, 'buttons');
      seen.add(label.toLowerCase());
      buttons.push({ type, text: label });
    } else if (type === 'url') {
      const url = asText(b?.url, 2001);
      if (!/^https:\/\/[^\s/]+\.[^\s]+$/.test(url) || url.length > 2000)
        throw bad('El enlace de un botón debe empezar con https:// y medir hasta 2,000 caracteres.', 'buttons');
      const tokens = extract(url);
      let v = null;
      if (tokens.length) {
        if (tokens.length > 1 || !url.endsWith(tokens[0].raw))
          throw bad('El enlace admite un solo dato y debe ir al final.', 'buttons');
        const conv = numbered(url, { field: 'buttons', samples, fallbacks, maxVars: 1 });
        v = conv.vars[0];
        buttons.push({ type, text: label, url: conv.text, var: v });
      } else buttons.push({ type, text: label, url, var: null });
    } else if (type === 'phone') {
      const phone = String(b?.phone ?? '').replace(/[\s()-]/g, '');
      if (!/^\+?[1-9]\d{7,14}$/.test(phone))
        throw bad('El teléfono del botón va en formato internacional, por ejemplo +5215512345678.', 'buttons');
      buttons.push({ type, text: label, phone: phone.startsWith('+') ? phone : '+' + phone });
    } else throw bad('Los botones pueden ser de respuesta rápida, de enlace o de teléfono.', 'buttons');
  }
  if (buttons.filter(b => b.type === 'url').length > 2)
    throw bad('Una plantilla admite hasta 2 botones de enlace.', 'buttons');
  if (buttons.filter(b => b.type === 'phone').length > 1)
    throw bad('Una plantilla admite un solo botón de teléfono.', 'buttons');
  const groups = buttons.map(b => (b.type === 'quick_reply' ? 'q' : 'c')).join('');
  if (/q+c+q|c+q+c/.test(groups))
    throw bad('Los botones de respuesta rápida van juntos y los demás juntos, sin intercalar.', 'buttons');
  if (buttons.length > 3) warn('many_buttons', 'WhatsApp muestra los demás botones tras «Ver todas las opciones».');

  const definition = { type: 'standard', header, body, footer, buttons };
  const category = CATEGORIES.includes(input.category) ? input.category : 'utility';
  if (category === 'utility' && PROMO.test(raw))
    warn('promo_in_utility', 'Meta podría aprobarla como marketing y cobrarla así.');
  if (
    category === 'marketing' &&
    !footer &&
    !buttons.some(b => b.type === 'quick_reply' && /baja|detener|no recibir/i.test(b.text))
  )
    warn('no_opt_out', 'Conviene un pie o un botón para dejar de recibir promociones.');
  return { definition, warnings };
}

// Todas las variables de una definición, cada una con dónde vive (para resolverlas y para «falta indicar sus datos»).
export function varsOf(def) {
  const out = [];
  if (def?.header?.type === 'text') for (const v of def.header.vars ?? []) out.push({ ...v, where: 'header' });
  for (const v of def?.body?.vars ?? []) out.push({ ...v, where: 'body' });
  (def?.buttons ?? []).forEach((b, index) => {
    if (b.type === 'url' && b.var) out.push({ ...b.var, where: 'button', index });
    if (b.type === 'copy_code' && b.code) out.push({ ...b.code, where: 'button', index });
  });
  return out;
}
export const needsMapping = def => varsOf(def).some(v => !v.key);

const fill = (text, values) => String(text ?? '').replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? '…');
const sampleOf = v => v.sample || SAMPLE[v.key] || v.fallback || (v.key ? `{{${v.key}}}` : '…');

// Vista previa con las muestras: lo que dibuja el editor como un mensaje.
export function preview(def) {
  return {
    header:
      def.header?.type === 'text'
        ? { type: 'text', text: fill(def.header.text, def.header.vars.map(sampleOf)) }
        : def.header?.type && def.header.type !== 'none'
          ? { type: def.header.type, fileId: def.header.fileId ?? null, filename: def.header.filename ?? null }
          : null,
    body: fill(def.body.text, def.body.vars.map(sampleOf)),
    footer: def.footer?.text ?? null,
    buttons: (def.buttons ?? []).map(b => ({ type: b.type, text: b.text || 'Copiar código' })),
  };
}

// Lo que el editor necesita para volver a abrir una plantilla: el texto con las variables por nombre.
export function toEditor(def) {
  const named = (text, vars) =>
    String(text ?? '').replace(/\{\{(\d+)\}\}/g, (raw, n) => {
      const v = vars?.[Number(n) - 1];
      return v?.key ? `{{${v.key}}}` : raw;
    });
  const samples = {};
  const fallbacks = {};
  for (const v of varsOf(def)) {
    if (!v.key) continue;
    if (v.sample && v.sample !== SAMPLE[v.key]) samples[v.key] = v.sample;
    if (v.fallback) fallbacks[v.key] = v.fallback;
  }
  return {
    header:
      def.header?.type === 'text'
        ? { type: 'text', text: named(def.header.text, def.header.vars) }
        : { type: def.header?.type ?? 'none', fileId: def.header?.fileId ?? null },
    body: named(def.body?.text, def.body?.vars),
    footer: def.footer?.text ?? '',
    buttons: (def.buttons ?? []).map(b =>
      b.type === 'url'
        ? { type: 'url', text: b.text, url: b.var ? named(b.url, [b.var]) : b.url }
        : b.type === 'phone'
          ? { type: 'phone', text: b.text, phone: b.phone }
          : { type: b.type, text: b.text ?? '' },
    ),
    samples,
    fallbacks,
  };
}

// Comprobación previa a mandar a Meta: que no falte ninguna muestra ni el archivo del encabezado.
export function submitProblems(def) {
  const problems = [];
  for (const v of varsOf(def))
    if (!(v.sample || SAMPLE[v.key])) problems.push(`Falta la muestra de {{${v.key}}}: Meta la exige para revisarla.`);
  if ((def.header?.type === 'image' || def.header?.type === 'document') && !def.header.fileId)
    problems.push('Falta el archivo de muestra del encabezado.');
  return problems;
}

// Argumentos del adaptador de Meta para crear o corregir la plantilla (el adaptador arma el JSON de Meta).
export function toMetaArgs(def, { handle = null } = {}) {
  const sample = v => cleanParam(sampleOf(v));
  return {
    body: def.body.text,
    examples: def.body.vars.map(sample),
    header:
      def.header?.type === 'text'
        ? { format: 'TEXT', text: def.header.text, example: def.header.vars[0] ? sample(def.header.vars[0]) : null }
        : def.header?.type === 'image' || def.header?.type === 'document'
          ? { format: def.header.type.toUpperCase(), handle }
          : undefined,
    footer: def.footer?.text || undefined,
    buttons: def.buttons.length
      ? def.buttons.map(b =>
          b.type === 'url'
            ? { type: 'url', text: b.text, url: b.url, example: b.var ? sample(b.var) : undefined }
            : b.type === 'phone'
              ? { type: 'phone', text: b.text, phone: b.phone }
              : b.type === 'copy_code'
                ? { type: 'copy_code', example: sample(b.code) }
                : { type: 'quick_reply', text: b.text },
        )
      : undefined,
  };
}

// Una plantilla tal como la entrega Meta (sus componentes) → definición canónica. Las variables quedan sin fuente
// (key null) salvo que `keys` diga cuál llena cada una: {body:[…], header:'…', buttons:{índice:'…'}}.
export function fromMeta(components, keys = {}) {
  const comps = Array.isArray(components) ? components : [];
  const find = type => comps.find(c => String(c?.type || '').toUpperCase() === type);
  const slots = text => [...new Set([...String(text ?? '').matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))];
  const vars = (text, samples, list) =>
    slots(text).map((n, i) => ({
      key: list?.[i] ?? null,
      sample: cleanParam(samples?.[n - 1] ?? '') || null,
      fallback: null,
    }));
  const h = find('HEADER');
  const format = String(h?.format || 'TEXT').toUpperCase();
  const header = !h
    ? { type: 'none' }
    : format === 'TEXT'
      ? {
          type: 'text',
          text: String(h.text ?? ''),
          vars: vars(h.text, h.example?.header_text, keys.header ? [keys.header] : []),
        }
      : { type: format.toLowerCase(), fileId: null, filename: null, mime: null };
  const b = find('BODY');
  const f = find('FOOTER');
  const buttons = (find('BUTTONS')?.buttons ?? []).map((x, index) => {
    const type = String(x?.type || '').toUpperCase();
    if (type === 'URL') {
      const urlVars = vars(x.url, Array.isArray(x.example) ? x.example : [], [keys.buttons?.[index]]);
      return { type: 'url', text: String(x.text ?? ''), url: String(x.url ?? ''), var: urlVars[0] ?? null };
    }
    if (type === 'PHONE_NUMBER')
      return { type: 'phone', text: String(x.text ?? ''), phone: String(x.phone_number ?? '') };
    if (type === 'COPY_CODE')
      return {
        type: 'copy_code',
        code: { key: keys.buttons?.[index] ?? null, sample: cleanParam(x.example ?? '') || null, fallback: null },
      };
    if (type === 'FLOW') return { type: 'flow', text: String(x.text ?? '') };
    return { type: 'quick_reply', text: String(x.text ?? '') };
  });
  return {
    type: 'standard',
    header,
    body: { text: String(b?.text ?? ''), vars: vars(b?.text, b?.example?.body_text?.[0], keys.body) },
    footer: f?.text ? { text: String(f.text) } : null,
    buttons,
  };
}

// Definición de una fila: la de `components` o, si falta (filas de antes del relleno), la armada de body/variables.
export function definitionOf(row) {
  try {
    const def = JSON.parse(row.components);
    if (def && def.body) return def;
  } catch {}
  let keys = [];
  try {
    keys = JSON.parse(row.variables);
  } catch {}
  return {
    type: 'standard',
    header: { type: 'none' },
    body: {
      text: row.body,
      vars: (Array.isArray(keys) ? keys : []).map(key => ({ key, sample: null, fallback: null })),
    },
    footer: null,
    buttons: [],
  };
}
