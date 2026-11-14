// Mapeo de columnas de la importación de contactos: qué destino tiene cada columna del archivo, la sugerencia
// automática, la plantilla de la exportación del proveedor anterior y la lectura de una fila ya mapeada.
// Funciones puras: sin base de datos, sin red y sin estado.
import { headerKey, unprotectCell } from '../../lib/csv.mjs';
import { canonicalPhone } from '../../lib/identity-keys.mjs';

// Destinos fijos. `attr:<clave>` liga la columna a un dato propio de contacto activo de la marca.
export const TARGETS = Object.freeze({
  ignore: 'Ignorar',
  name: 'Nombre',
  phone: 'Teléfono',
  countryCode: 'Código de país',
  email: 'Correo',
  tags: 'Etiquetas',
  consent: 'Consentimiento (acepta promociones)',
  createdAt: 'Fecha de alta',
});
const SINGLE = new Set(['name', 'phone', 'countryCode', 'email', 'consent', 'createdAt']);

// Encabezados conocidos (comparados con headerKey: sin mayúsculas, acentos, espacios ni signos).
const ALIASES = {
  name: ['name', 'nombre', 'fullname', 'nombrecompleto', 'contactname', 'cliente'],
  countryCode: ['countrycode', 'codigodepais', 'codigopais', 'pais', 'lada'],
  phone: [
    'phone',
    'phonenumber',
    'telefono',
    'tel',
    'celular',
    'movil',
    'mobile',
    'whatsapp',
    'whatsappnumber',
    'waid',
  ],
  email: ['email', 'correo', 'correoelectronico', 'mail', 'emailaddress'],
  consent: ['allowcampaign', 'allowbroadcast', 'optedin', 'optin', 'consentimiento', 'aceptapromociones'],
  tags: ['tags', 'etiquetas', 'labels', 'tag', 'etiqueta'],
  createdAt: ['created', 'createdat', 'fechadealta', 'alta', 'fechaalta'],
};
const ALIAS = new Map(Object.entries(ALIASES).flatMap(([target, list]) => list.map(alias => [alias, target])));
// Columnas de la exportación del proveedor anterior que no tienen destino en el CRM (no hay SMS, por ejemplo).
const PREVIOUS_IGNORED = new Set(['allowsms', 'contactstatus', 'lastupdated', 'source', 'id', 'channel', 'channelid']);

export const TEMPLATES = Object.freeze([
  {
    id: 'previous-provider',
    label: 'Exportación del proveedor anterior',
    hint: 'Name, CountryCode, Phone, Allow Campaign y Allow SMS; desde la sexta columna, datos de contacto.',
  },
]);

const isTarget = (target, attributeKeys) =>
  Object.hasOwn(TARGETS, target) || (target.startsWith('attr:') && attributeKeys.has(target.slice(5)));

// ¿Parece la exportación del proveedor anterior? Sus tres primeras columnas son siempre las mismas.
export function looksLikePrevious(header) {
  const keys = header.slice(0, 3).map(headerKey);
  return keys[0] === 'name' && keys[1] === 'countrycode' && ['phone', 'phonenumber'].includes(keys[2]);
}

// Sugerencia de destino para cada columna. `attributes`: [{key, label}] activos de la marca. Con la plantilla del
// proveedor anterior, desde la sexta columna sólo se buscan datos de contacto (así lo exporta esa herramienta).
export function suggestMapping(
  header,
  attributes,
  { template = looksLikePrevious(header) ? 'previous-provider' : '' } = {},
) {
  const byAttribute = new Map();
  for (const a of attributes) {
    byAttribute.set(headerKey(a.key), a.key);
    byAttribute.set(headerKey(a.label), a.key);
  }
  const used = new Set();
  const targets = header.map((cell, index) => {
    const key = headerKey(cell);
    if (!key) return 'ignore';
    if (template === 'previous-provider' && PREVIOUS_IGNORED.has(key)) return 'ignore';
    const fixed = template === 'previous-provider' && index >= 5 ? null : ALIAS.get(key);
    if (fixed && (!SINGLE.has(fixed) || !used.has(fixed))) {
      used.add(fixed);
      return fixed;
    }
    const attribute = byAttribute.get(key);
    if (attribute && !used.has('attr:' + attribute)) {
      used.add('attr:' + attribute);
      return 'attr:' + attribute;
    }
    return 'ignore';
  });
  return { template, targets };
}

// Comprueba un mapeo enviado por la pantalla. Devuelve la lista de destinos limpia o lanza con el problema.
export function checkMapping(targets, header, attributeKeys, invalid) {
  if (!Array.isArray(targets) || targets.length !== header.length)
    throw invalid('Indica un destino para cada columna del archivo.');
  const seen = new Map();
  const clean = targets.map((raw, index) => {
    const target = typeof raw === 'string' ? raw : 'ignore';
    if (!isTarget(target, attributeKeys))
      throw invalid(`La columna «${header[index] || index + 1}» tiene un destino que no existe en esta marca.`);
    if (target !== 'ignore' && target !== 'tags') {
      if (seen.has(target))
        throw invalid(
          `Dos columnas van al mismo destino: «${header[seen.get(target)] || seen.get(target) + 1}» y «${header[index] || index + 1}».`,
        );
      seen.set(target, index);
    }
    return target;
  });
  if (!clean.includes('phone') && !clean.includes('email'))
    throw invalid('Elige la columna del teléfono (o, si no hay, la del correo): con ella se reconoce a cada contacto.');
  return clean;
}

const TRUE = new Set(['true', 'verdadero', 'si', 'sí', 'yes', '1', 'acepta', 'x']);
const FALSE = new Set(['false', 'falso', 'no', '0', 'nodesea', 'rechaza']);

// Una fila del archivo como fila mapeada para applyRow: {name, phone, countryCode, email, tags, consent, createdAt,
// attrs}. Las celdas protegidas contra fórmulas por una exportación del CRM («'+52…») vuelven a su valor; lo demás se
// guarda como texto, también lo que empieza con «=», «+», «-» o «@» (al exportarse se vuelve a neutralizar).
// Devuelve además `problems` con lo que no se pudo leer de la fila.
export function mapRow(cells, targets) {
  const row = { name: '', phone: '', countryCode: '', email: '', tags: [], consent: null, createdAt: '', attrs: {} };
  const problems = [];
  targets.forEach((target, index) => {
    if (target === 'ignore') return;
    const value = unprotectCell(String(cells[index] ?? '').trim());
    if (target === 'tags') {
      for (const tag of value.split(/[;,]/))
        if (tag.trim() && !row.tags.includes(tag.trim().replace(/\s+/g, ' ')))
          row.tags.push(tag.trim().replace(/\s+/g, ' '));
    } else if (target === 'consent') {
      const key = headerKey(value);
      if (!key) row.consent = null;
      else if (TRUE.has(key) || TRUE.has(value.toLowerCase())) row.consent = true;
      else if (FALSE.has(key)) row.consent = false;
      else
        problems.push({
          code: 'consent_invalid',
          column: index,
          value,
          message: 'El consentimiento debe ser TRUE o FALSE (sí o no).',
        });
    } else if (target.startsWith('attr:')) {
      if (value) row.attrs[target.slice(5)] = value;
    } else row[target] = value;
  });
  return { row, problems };
}

// Clave con la que dos filas del mismo archivo son la misma persona: el teléfono canónico o, sin teléfono, el correo.
export function identityOf(row) {
  if (row.phone) {
    const phone = canonicalPhone(row.phone, countryOptions(row.countryCode));
    return phone.key ? 'tel:' + phone.key : null;
  }
  return row.email ? 'mail:' + row.email.trim().toLowerCase() : null;
}

// El código de país de su columna, si viene («52», «+52», «52.0»); si no, México.
export function countryOptions(countryCode) {
  const digits = String(countryCode ?? '')
    .replace(/\.0+$/, '')
    .replace(/\D/g, '');
  return digits && digits.length <= 3 ? { defaultCountry: digits } : {};
}
