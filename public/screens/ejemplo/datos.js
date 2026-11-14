/**
 * Servidor de mentira para la pantalla de ejemplo: datos en memoria detrás de un `fetch` falso.
 *
 * Por qué así: la pantalla usa `createApi({ fetch: fakeFetch })`, es decir, el mismo cliente, los mismos
 * errores ({error, code}) y las mismas reglas (paginación por cursor, clientRef, expectedRevision) que
 * tendrá con el servidor de verdad. Para convertir el ejemplo en una pantalla real basta con usar
 * `ctx.api` y borrar este archivo. Ningún dato de aquí es real ni sale del navegador.
 */

const NOMBRES = [
  'Ana',
  'Luis',
  'María',
  'Jorge',
  'Sofía',
  'Diego',
  'Valeria',
  'Carlos',
  'Fernanda',
  'Miguel',
  'Lucía',
  'Andrés',
  'Paola',
  'Ricardo',
];
const APELLIDOS = [
  'Pérez',
  'García',
  'Hernández',
  'López',
  'Martínez',
  'Ramírez',
  'Torres',
  'Flores',
  'Vargas',
  'Castillo',
  'Rojas',
];
export const ETIQUETAS = [
  { value: 'alumno', label: 'Alumno' },
  { value: 'interesado', label: 'Interesado' },
  { value: 'egresado', label: 'Egresado' },
  { value: 'beca', label: 'Beca' },
];
export const CONSENTIMIENTOS = [
  { value: 'opted_in', label: 'Acepta mensajes' },
  { value: 'unknown', label: 'Sin registro' },
  { value: 'opted_out', label: 'No desea mensajes' },
];

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** 137 contactos deterministas: siempre los mismos, para que las pruebas de interfaz sean repetibles. */
function seed() {
  return Array.from({ length: 137 }, (_, index) => {
    const name = `${NOMBRES[index % NOMBRES.length]} ${APELLIDOS[(index * 7) % APELLIDOS.length]}`;
    return {
      id: `c${String(index + 1).padStart(3, '0')}`,
      name,
      phone: `+52 55 ${String(1000 + ((index * 7919) % 9000))} ${String(1000 + ((index * 104729) % 9000))}`,
      email: index % 4 === 0 ? '' : `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@ejemplo.test`,
      consent: CONSENTIMIENTOS[index % 3].value,
      tags: ETIQUETAS.filter((_, position) => (index + position) % 3 === 0).map(tag => tag.value),
      notes: '',
      quiet: index % 9 === 0,
      activityAt: NOW - ((index * 37) % 120) * DAY - index * 60_000,
      createdAt: NOW - (120 + index) * DAY,
      revision: 1,
    };
  });
}

let contacts = seed();
const answered = new Map(); // clientRef → respuesta ya dada: un reintento no repite el cambio

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (status, error, code) => reply(status, code ? { error, code } : { error });
const plain = text =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9 ]/g, '');

/** ¿Cumple el contacto una condición de la forma canónica? Sólo los campos que declara la pantalla. */
function matchesRule(contact, rule) {
  switch (rule.field) {
    case 'name':
      return plain(contact.name).includes(plain(String(rule.value ?? ''))) === (rule.op === 'contains');
    case 'consent':
      return contact.consent === rule.value;
    case 'tag': {
      const wanted = Array.isArray(rule.value) ? rule.value : [];
      const any = wanted.some(tag => contact.tags.includes(tag));
      return rule.op === 'none' ? !any : rule.op === 'all' ? wanted.every(tag => contact.tags.includes(tag)) : any;
    }
    case 'activity': {
      const recent = contact.activityAt >= NOW - Number(rule.value ?? 0) * DAY;
      return rule.op === 'in_last_days' ? recent : !recent;
    }
    case 'quiet':
      return contact.quiet === (rule.value !== false);
    case 'email':
      return (contact.email !== '') === (rule.op === 'has');
    default:
      return true;
  }
}

function matches(contact, definition) {
  const groups = definition?.groups ?? [];
  if (!groups.length) return true;
  const verdicts = groups.map(group =>
    group.match === 'any'
      ? group.rules.some(rule => matchesRule(contact, rule))
      : group.rules.every(rule => matchesRule(contact, rule)),
  );
  return definition.match === 'all' ? verdicts.every(Boolean) : verdicts.some(Boolean);
}

const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name, 'es'),
  activity: (a, b) => a.activityAt - b.activityAt,
  created: (a, b) => a.createdAt - b.createdAt,
};

function listContacts(params) {
  const q = plain(params.get('q') ?? '');
  if (q === 'error') return fail(500, 'No se pudo completar la operación. Vuelve a intentarlo.');
  let definition = null;
  try {
    definition = params.get('filter') ? JSON.parse(params.get('filter')) : null;
  } catch {
    return fail(400, 'El filtro no es válido.');
  }
  const [by, dir] = (params.get('sort') ?? 'activity:desc').split(':');
  const limit = Math.min(50, Math.max(1, Number(params.get('limit')) || 50));
  const start = Math.max(0, Number(params.get('cursor')) || 0);
  const found = contacts
    .filter(contact => !q || plain(`${contact.name} ${contact.phone} ${contact.email}`).includes(q))
    .filter(contact => matches(contact, definition))
    .sort((a, b) => (SORTS[by] ?? SORTS.activity)(a, b) * (dir === 'asc' ? 1 : -1) || a.id.localeCompare(b.id));
  const page = found.slice(start, start + limit);
  return reply(200, {
    contacts: page,
    nextCursor: start + limit < found.length ? String(start + limit) : null,
    total: found.length,
  });
}

function saveContact(id, body) {
  const at = contacts.findIndex(contact => contact.id === id);
  if (at === -1) return fail(404, 'Ese contacto ya no existe.');
  const current = contacts[at];
  if (body.expectedRevision !== current.revision)
    return fail(409, 'Otra persona cambió este registro. Recarga sus datos antes de guardar.', 'STALE_RECORD');
  const changes = { ...body };
  delete changes.expectedRevision;
  delete changes.clientRef;
  contacts[at] = { ...current, ...changes, id, revision: current.revision + 1, activityAt: Date.now() };
  return reply(200, { contact: contacts[at] });
}

function createContact(body) {
  if (!String(body.name ?? '').trim()) return fail(400, 'Escribe el nombre del contacto.');
  if (body.phone && contacts.some(contact => contact.phone === body.phone))
    return reply(409, { error: 'Ya hay un contacto con ese teléfono.', code: 'DUPLICATE' });
  const data = { ...body };
  delete data.clientRef;
  const id = `n${String(contacts.length + 1).padStart(3, '0')}`;
  const contact = {
    email: '',
    consent: 'unknown',
    tags: [],
    notes: '',
    quiet: false,
    ...data,
    id,
    activityAt: Date.now(),
    createdAt: Date.now(),
    revision: 1,
  };
  contacts = [contact, ...contacts];
  return reply(201, { contact });
}

/** Actividad de mentira de una hora de un día: nada de noche, más a mediodía y entre semana. */
function activity(day, hour) {
  if (hour < 7 || hour > 21) return 0;
  return Math.max(0, Math.round(9 - Math.abs(13 - hour) + (day < 5 ? 4 : -3) + ((day * hour) % 4)));
}

function stats() {
  const days = Array.from({ length: 14 }, (_, index) =>
    new Date(NOW - (13 - index) * DAY).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }),
  );
  const wave = (index, base, swing) => Math.round(base + swing * Math.sin(index / 2) + (index % 3) * 2);
  const sent = days.map((_, index) => wave(index + 2, 26, 7));
  return reply(200, {
    days,
    received: days.map((_, index) => wave(index, 32, 9)),
    sent,
    // Igual que el periodo anterior, para que el ejemplo enseñe también la tarjeta «sin cambio».
    sentPrevious: sent.reduce((total, value) => total + value, 0),
    previous: days.map((_, index) => wave(index + 5, 27, 6)),
    byCategory: {
      service: days.map((_, index) => wave(index, 18, 5)),
      marketing: days.map((_, index) => wave(index + 4, 9, 4)),
      utility: days.map((_, index) => wave(index + 1, 5, 2)),
    },
    failures: [
      { label: 'Número sin WhatsApp', value: 31 },
      { label: 'Fuera de la ventana de 24 horas', value: 18 },
      { label: 'Plantilla en pausa por calidad', value: 7 },
      { label: 'Persona que no desea mensajes', value: 4 },
    ],
    funnel: [
      { label: 'Destinatarios', value: 1200 },
      { label: 'Enviados', value: 1164 },
      { label: 'Entregados', value: 1101 },
      { label: 'Leídos', value: 842 },
      { label: 'Respondieron', value: 126 },
    ],
    hours: Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (_, hour) => activity(day, hour))),
    outcomes: [
      { key: 'read', label: 'Leídos', value: 842 },
      { key: 'delivered', label: 'Entregados sin leer', value: 259 },
      { key: 'failed', label: 'Fallidos', value: 60 },
    ],
    failed: 60,
    failedChange: 0.2,
    firstReply: '4 min',
    freeUsed: 412,
    freeLimit: 1000,
  });
}

/** Marca un contacto como cambiado «por otra persona»: sube su revisión sin pasar por la pantalla. */
export function touchElsewhere(id) {
  const at = contacts.findIndex(contact => contact.id === id);
  if (at === -1) return null;
  contacts[at] = {
    ...contacts[at],
    notes: `${contacts[at].notes} (editado desde otro equipo)`.trim(),
    revision: contacts[at].revision + 1,
  };
  return contacts[at];
}

/**
 * El `fetch` falso. Tarda un poco, respeta la señal de cancelación y responde con el mismo formato que
 * el servidor: JSON y, en los fallos, {error, code}.
 */
export async function fakeFetch(input, init = {}) {
  const target = new URL(String(input), 'http://ejemplo.invalid');
  const method = (init.method ?? 'GET').toUpperCase();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 180);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(init.signal.reason ?? new DOMException('Cancelada', 'AbortError'));
    });
  });

  const body = init.body ? JSON.parse(init.body) : {};
  // Idempotencia: la misma referencia de cliente recibe la misma respuesta y no repite el cambio.
  if (body.clientRef && answered.has(body.clientRef)) return answered.get(body.clientRef).clone();
  const remember = response => {
    if (body.clientRef && response.ok) answered.set(body.clientRef, response.clone());
    return response;
  };

  const path = target.pathname;
  if (method === 'GET' && path === '/api/ejemplo/contacts') return listContacts(target.searchParams);
  if (method === 'GET' && path === '/api/ejemplo/stats') return stats();
  if (method === 'POST' && path === '/api/ejemplo/contacts') return remember(createContact(body));
  if (method === 'POST' && path === '/api/ejemplo/contacts/archive') {
    const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
    const before = contacts.length;
    contacts = contacts.filter(contact => !ids.has(contact.id));
    return remember(reply(200, { archived: before - contacts.length }));
  }
  const one = path.match(/^\/api\/ejemplo\/contacts\/([a-z0-9]+)$/);
  if (one && method === 'GET') {
    const contact = contacts.find(item => item.id === one[1]);
    return contact ? reply(200, { contact }) : fail(404, 'Ese contacto ya no existe.');
  }
  if (one && method === 'PATCH') return remember(saveContact(one[1], body));
  return fail(404, 'No encontrado.');
}
