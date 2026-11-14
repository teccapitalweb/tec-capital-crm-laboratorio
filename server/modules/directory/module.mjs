// Contactos a escala (docs/PLAN_CONTACTOS_A_ESCALA.md): la lista paginada, la búsqueda y el panel de la pantalla
// nueva «Contactos» (public/screens/contactos). Sólo lectura: crear y editar siguen en la vista actual.
//
//   GET /api/contacts?brand=all|<marca>&q=&filter=<JSON>&quick=a,b&sort=activity|name|created&dir=desc|asc&cursor=&limit=
//   GET /api/contacts?brand=…&ids=a,b,c (con los mismos q, filter y quick): las filas de esos contactos que siguen
//       cumpliendo la búsqueda y los filtros; lo usa la pantalla al llegar un aviso en vivo
//   GET /api/contacts/filters?brand=…   opciones del constructor de filtros (marcas, etiquetas, cursos, responsables)
//   GET /api/contacts/<id>              lo que muestra el panel del contacto
//
// El módulo se llama `directory` porque `contacts` ya es un servicio del servidor; reclama el prefijo /api/contacts.
// Cada consulta va acotada a las marcas en las que la persona tiene `contacts.view`; el teléfono pasa por
// host.access.phone y el correo se enmascara igual cuando falta `contacts.phone`.
//
// Avisos en vivo: un reloj lee el índice de cambios de contact_search y emite `contacts.changed` con los ids de cada
// marca (sin datos personales). La pantalla vuelve a pedir sólo esas filas.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LIMITS as CONDITION_LIMITS, validate as validateConditions } from '../../lib/conditions.mjs';
import { phoneKey } from '../../lib/identity-keys.mjs';
import { searchKey } from '../../lib/search-key.mjs';
import { CONTACT_FIELDS, SORTS, createRepo } from './repo.mjs';

export const PAGE_LIMIT = 50;
export const COUNT_CAP = 10_000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_QUERY = 100;
const MAX_FILTER = CONDITION_LIMITS.maxBytes;

// Filtros rápidos (los chips de la pantalla): cada uno es una condición de la gramática común.
const QUICK = {
  with_phone: () => ({ field: 'has_phone', op: 'is', value: true }),
  opted_in: () => ({ field: 'consent', op: 'eq', value: 'opted_in' }),
  active: () => ({ field: 'active_interest', op: 'is', value: true }),
  recent: () => ({ field: 'created', op: 'in_last_days', value: 30 }),
  mine: user => ({ field: 'owner', op: 'any', value: [user.id] }),
};
export const QUICK_FILTERS = Object.freeze(Object.keys(QUICK));

// Correo enmascarado para quien no puede ver datos completos: la primera letra y el dominio («a•••@correo.mx»).
function maskEmail(value) {
  const text = String(value ?? '');
  const at = text.lastIndexOf('@');
  if (!text) return '';
  return at > 0 ? text[0] + '•••' + text.slice(at) : '•••';
}

export default {
  name: 'directory',
  prefixes: ['/api/contacts'],
  create(host) {
    const repo = createRepo(host.db);
    const { access } = host;
    const bad = (message, field, code = 'invalid_input') => host.fail(400, message, { code, field });

    // ---- Cursor: el último valor de orden y el id, atado a la búsqueda que lo produjo y firmado. Así un cursor
    // escrito a mano o traído de otra búsqueda se rechaza (400) en lugar de devolver una página inventada. La llave
    // vive mientras vive el proceso: tras reiniciar, la pantalla vuelve a empezar la lista.
    const key = randomBytes(32);
    const sign = text => createHmac('sha256', key).update(text).digest('base64url').slice(0, 22);
    const fingerprint = query => sign(JSON.stringify(query)).slice(0, 12);
    function encodeCursor(next, query) {
      const body = Buffer.from(JSON.stringify({ v: next.v, i: next.i, f: fingerprint(query) })).toString('base64url');
      return body + '.' + sign(body);
    }
    function decodeCursor(text, query, sort) {
      const invalid = () =>
        bad('La página pedida ya no es válida. Vuelve a cargar la lista.', 'cursor', 'invalid_cursor');
      if (typeof text !== 'string' || text.length > 400 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/.test(text))
        throw invalid();
      const [body, mac] = text.split('.');
      const expected = Buffer.from(sign(body));
      if (!timingSafeEqual(Buffer.from(mac), expected)) throw invalid();
      let data;
      try {
        data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw invalid();
      }
      const valueOk = sort === 'name' ? typeof data?.v === 'string' : Number.isSafeInteger(data?.v);
      if (!valueOk || typeof data.i !== 'string' || !ID.test(data.i) || data.f !== fingerprint(query)) throw invalid();
      return { v: data.v, i: data.i };
    }

    // ---- Marcas: `brand` es obligatorio. «all» son todas las de la persona con `contacts.view`; un id, sólo ésa.
    function brandsFor(user, brand) {
      if (typeof brand !== 'string' || !brand) throw bad('Indica la marca (brand=all o su identificador).', 'brand');
      if (brand === 'all') {
        access.require(user, 'contacts.view'); // 403 si no tiene el permiso en ninguna marca
        const ids = access.brandIds(user, 'contacts.view');
        for (const id of ids) access.require(user, 'contacts.view', id);
        return ids;
      }
      access.require(user, 'contacts.view', brand); // 403 sin permiso; 404 si la marca no es suya
      return [brand];
    }

    // ---- Búsqueda: un teléfono (sólo dígitos y signos de teléfono, al menos cuatro dígitos) se busca por su clave;
    // lo demás, por palabras en el nombre y el correo, sin acentos. Quien no ve teléfonos completos en una marca sólo
    // busca por los cuatro últimos dígitos, que son los que ya ve.
    function searchFor(user, brandId, q) {
      if (!q) return null;
      const digits = q.replace(/\D/g, '');
      if (/^[\d\s+()./-]+$/.test(q) && digits.length >= 4) {
        if (!access.can(user, 'contacts.phone', brandId)) return { last4: digits.slice(-4) };
        return { phone: { key: phoneKey(q) ?? '', digits } };
      }
      const words = searchKey(q).split(/\s+/).filter(Boolean).slice(0, 8);
      return words.length ? { words } : null;
    }

    // ---- Filtros: la definición del constructor (JSON) y los rápidos, todo validado con la gramática común.
    function conditionsFor(user, url) {
      const list = [];
      const raw = url.searchParams.get('filter');
      let definition = null;
      if (raw) {
        if (raw.length > MAX_FILTER) throw bad('El filtro es demasiado grande.', 'filter', 'invalid_conditions');
        try {
          definition = JSON.parse(raw);
        } catch {
          throw bad('El filtro no se pudo leer.', 'filter', 'invalid_conditions');
        }
        const problems = validateConditions(definition, CONTACT_FIELDS, { sql: true });
        if (problems.length)
          throw host.fail(400, problems[0], { code: 'invalid_conditions', field: 'filter', details: { problems } });
      }
      const quick = (url.searchParams.get('quick') ?? '').split(',').filter(Boolean);
      for (const name of quick)
        if (!QUICK[name]) throw bad(`Filtro rápido desconocido: ${name.slice(0, 30)}.`, 'quick');
      const now = Date.now();
      if (definition) list.push(repo.compileConditions(definition, now));
      if (quick.length)
        list.push(
          repo.compileConditions(
            { version: 1, match: 'all', groups: [{ match: 'all', rules: quick.map(name => QUICK[name](user)) }] },
            now,
          ),
        );
      return { conditions: list, definition, quick: [...new Set(quick)].sort() };
    }

    // Lo que identifica una búsqueda, para atarle el cursor.
    function readQuery(user, url) {
      const brand = url.searchParams.get('brand');
      const brandIds = brandsFor(user, brand);
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length > MAX_QUERY) throw bad(`La búsqueda admite hasta ${MAX_QUERY} caracteres.`, 'q');
      const sort = url.searchParams.get('sort') ?? 'activity';
      if (!Object.hasOwn(SORTS, sort)) throw bad('Orden no válido: usa activity, name o created.', 'sort');
      const dir = url.searchParams.get('dir') ?? (sort === 'name' ? 'asc' : 'desc');
      if (dir !== 'asc' && dir !== 'desc') throw bad('El sentido del orden es asc o desc.', 'dir');
      const { conditions, definition, quick } = conditionsFor(user, url);
      // La búsqueda se arma por marca: el permiso de teléfono puede ser distinto en cada una.
      const filters = new Map(brandIds.map(id => [id, { search: searchFor(user, id, q), conditions }]));
      return { brand, brandIds, q, sort, dir, filters, identity: { brand, q, sort, dir, definition, quick } };
    }

    // Una fila tal como la ve la pantalla. El teléfono y el correo, completos o enmascarados según el permiso.
    function present(user, row, extra) {
      const full = access.can(user, 'contacts.phone', row.brand_id);
      const interests = extra.interests.get(row.id) ?? { total: 0, active: 0, latest: null };
      return {
        id: row.id,
        brandId: row.brand_id,
        brandName: extra.brands.get(row.brand_id) ?? row.brand_id,
        name: row.name,
        phone: access.phone(user, row.phone, row.brand_id) ?? '',
        phoneMasked: Boolean(row.phone) && !full,
        labNumber: row.test_number ? '#' + row.test_number : '',
        email: full ? row.email : maskEmail(row.email),
        source: row.source,
        createdAt: row.created_at,
        activityAt: row.activity_at,
        consent: row.consent,
        tags: extra.tags.get(row.id) ?? [],
        interests: { total: interests.total, active: interests.active },
        latest: interests.latest,
      };
    }
    const presentAll = (user, brandIds, rows) => {
      const extra = repo.extras(
        brandIds,
        rows.map(row => row.id),
      );
      return rows.map(row => present(user, row, extra));
    };

    // Una página: el repositorio pide cada marca por su índice y las mezcla. El total (aproximado: exacto hasta
    // 10 000) sólo va con la primera página, que es cuando la pantalla lo pinta.
    function listPage(user, url) {
      const query = readQuery(user, url);
      const limitText = url.searchParams.get('limit');
      const limit = limitText === null ? PAGE_LIMIT : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT)
        throw bad(`«limit» va de 1 a ${PAGE_LIMIT}.`, 'limit');
      const cursorText = url.searchParams.get('cursor');
      const after = cursorText ? decodeCursor(cursorText, query.identity, query.sort) : null;
      const page = repo.page(query.brandIds, {
        sort: query.sort,
        dir: query.dir,
        after,
        limit,
        filters: query.filters,
      });
      const result = {
        contacts: presentAll(user, query.brandIds, page.rows),
        nextCursor: page.next ? encodeCursor(page.next, query.identity) : null,
        sort: { by: query.sort, dir: query.dir },
      };
      if (!after) result.total = repo.count(query.brandIds, { filters: query.filters, cap: COUNT_CAP });
      return result;
    }

    function refreshRows(user, url) {
      const query = readQuery(user, url);
      const ids = [...new Set((url.searchParams.get('ids') ?? '').split(',').filter(Boolean))];
      if (!ids.length || ids.length > PAGE_LIMIT || !ids.every(id => ID.test(id)))
        throw bad(`«ids» lleva de 1 a ${PAGE_LIMIT} identificadores separados por comas.`, 'ids');
      const rows = repo.byIds(query.brandIds, ids, { filters: query.filters });
      return { contacts: presentAll(user, query.brandIds, rows) };
    }

    function detail(user, id, url) {
      if (!ID.test(id)) throw host.fail(404, 'Marca o registro no disponible.', { code: 'not_found' });
      const brand = url.searchParams.get('brand') ?? 'all';
      const brandIds = brandsFor(user, brand);
      const found = repo.detail(brandIds, id);
      if (!found) throw host.fail(404, 'Marca o registro no disponible.', { code: 'not_found' });
      const c = found.contact;
      access.require(user, 'contacts.view', c.brand_id);
      const full = access.can(user, 'contacts.phone', c.brand_id);
      const extra = { interests: new Map(), tags: new Map([[c.id, found.tags]]), brands: new Map() };
      extra.brands.set(c.brand_id, found.brandName);
      const row = present(user, c, extra);
      const active = found.opportunities.filter(o => !['ganada', 'perdida'].includes(o.stage)).length;
      return {
        contact: {
          ...row,
          email: full ? c.email : maskEmail(c.email),
          personId: c.persona_id ?? null,
          updatedAt: c.updated_at,
          interests: { total: found.opportunities.length, active },
          latest: found.opportunities[0]
            ? {
                stage: found.opportunities[0].stage,
                course: found.opportunities[0].course,
                owner: found.opportunities[0].owner ?? null,
              }
            : null,
        },
        consent: {
          status: found.consent?.status ?? 'unknown',
          source: found.consent?.source ?? null,
          note: found.consent?.note ?? '',
          updatedAt: found.consent?.updated_at ?? null,
          history: found.history.map(item => ({
            status: item.status,
            source: item.source,
            at: item.created_at,
            actor: item.actor ?? null,
          })),
        },
        opportunities: found.opportunities.map(o => ({
          id: o.id,
          stage: o.stage,
          course: o.course,
          edition: o.edition ?? null,
          owner: o.owner ?? null,
          lostReason: o.lost_reason || '',
          nextDue: o.next_due ?? null,
          createdAt: o.created_at,
          updatedAt: o.updated_at,
        })),
        conversation: found.conversation
          ? {
              id: found.conversation.id,
              channel: found.conversation.channel,
              status: found.conversation.status,
              course: found.conversation.course,
              assigned: found.conversation.assigned ?? null,
              updatedAt: found.conversation.updated_at,
            }
          : null,
        conversations: found.conversations,
      };
    }

    function filterOptions(user, url) {
      const brandIds = brandsFor(user, url.searchParams.get('brand'));
      const options = repo.options(brandIds);
      return {
        brands: options.brands,
        tags: options.tags.map(tag => ({ id: tag.id, name: tag.name, color: tag.color, brandId: tag.brand_id })),
        courses: options.courses.map(course => ({ id: course.id, title: course.title, brandId: course.brand_id })),
        owners: options.owners,
        sources: options.sources,
        quick: QUICK_FILTERS,
      };
    }

    // ---- Avisos en vivo: qué contactos cambiaron desde la última pasada, agrupados por marca.
    let seen = repo.lastRev();
    function tick() {
      const changes = repo.changesSince(seen);
      if (!changes.length) return 0;
      seen = changes.at(-1).rev;
      const byBrand = new Map();
      for (const change of changes) {
        if (!byBrand.has(change.brand_id)) byBrand.set(change.brand_id, new Set());
        byBrand.get(change.brand_id).add(change.contact_id);
      }
      for (const [brandId, ids] of byBrand) {
        const list = [...ids];
        for (let at = 0; at < list.length; at += PAGE_LIMIT)
          host.realtime.emit('contacts.changed', { brandId, data: { ids: list.slice(at, at + PAGE_LIMIT) } });
      }
      return changes.length;
    }

    return {
      tick,
      async handle(req, res, path, user, url) {
        if (req.method !== 'GET') return false;
        if (path === '/api/contacts') {
          host.json(res, 200, url.searchParams.has('ids') ? refreshRows(user, url) : listPage(user, url));
          return true;
        }
        if (path === '/api/contacts/filters') {
          host.json(res, 200, filterOptions(user, url));
          return true;
        }
        const match = path.match(/^\/api\/contacts\/([^/]+)$/);
        if (match) {
          host.json(res, 200, detail(user, match[1], url));
          return true;
        }
        return false;
      },
    };
  },
  timers: [{ name: 'avisos', everyMs: 1000, testEveryMs: 200, run: api => api.tick() }],
};
