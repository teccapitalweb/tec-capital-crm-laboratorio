import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_ROWS = 500,
  MAX_BYTES = 1_000_000;
const norm = v =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
export const COLUMNS = [
  'marca',
  'curso',
  'temario',
  'edicion',
  'inicio',
  'fin',
  'zona_horaria',
  'docente',
  'modalidad',
  'lugar',
  'enlace',
  'cupo',
  'cupo_disponible',
  'precio',
  'moneda',
  'estado',
  'promo_nombre',
  'promo_precio',
  'promo_inicio',
  'promo_fin',
  'promo_estado',
];
const MODALITY = {
  online: 'online',
  presencial: 'in_person',
  in_person: 'in_person',
  hibrida: 'hybrid',
  hybrid: 'hybrid',
};
const STATUS = { borrador: 'draft', draft: 'draft', publicada: 'published', published: 'published' };

export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, ''),
    first = src.split(/\r?\n/, 1)[0],
    delimiter = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [],
    cell = '',
    quoted = false,
    line = 1,
    start = 1;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some(c => c.trim() !== '')) rows.push({ line: start, cells: row });
    row = [];
    start = line + 1;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      endRow();
      line++;
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) endRow();
  return rows;
}

// Fecha local en una zona IANA -> instante UTC (ms). No usa la zona del dispositivo.
export function zonedToUtc(text, zone) {
  const m = String(text)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0] = m.slice(1).map(v => (v === undefined ? undefined : Number(v))),
    guess = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(guess).getUTCMonth() !== mo - 1 || h > 23 || mi > 59) return null;
  const offset = at => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(new Date(at))
        .map(x => [x.type, x.value]),
    );
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc);
  return utc;
}

export const TEMPLATE_CSV =
  [
    COLUMNS.join(','),
    'GlobalVet,Plan sanitario para aves,"Prevención de enfermedades\nBioseguridad",Edición noviembre,2026-11-20 18:00,2026-11-20 20:00,America/Mexico_City,Dra. Ejemplo,online,,https://ejemplo.com/curso,100,100,379,MXN,borrador,Preventa,299,2026-10-01 00:00,2026-11-10 23:59,borrador',
  ].join('\n') + '\n';

export function createCatalogueImport({ db, catalogue, crm, body, json, audit, now = Date.now }) {
  const requireAdmin = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'Sólo administración importa catálogo.');
  };
  const brands = () => db.prepare('SELECT id,name FROM brands').all();

  // Convierte cada fila en datos normalizados y detecta errores sin escribir nada.
  function analyse(csv, user) {
    if (typeof csv !== 'string' || !csv.trim()) throw fail(400, 'Pega o carga el contenido del archivo CSV.');
    if (Buffer.byteLength(csv) > MAX_BYTES) throw fail(413, 'El archivo supera 1 MB.');
    const table = parseCsv(csv);
    if (table.length < 2) throw fail(400, 'El archivo necesita encabezados y al menos una fila.');
    const header = table[0].cells.map(norm).map(h => h.replace(/\s+/g, '_')),
      missing = ['marca', 'curso', 'precio'].filter(c => !header.includes(c));
    if (missing.length) throw fail(400, 'Faltan columnas obligatorias: ' + missing.join(', ') + '.');
    const unknown = header.filter(h => h && !COLUMNS.includes(h));
    if (table.length - 1 > MAX_ROWS) throw fail(400, 'Máximo ' + MAX_ROWS + ' filas por archivo.');
    const all = brands(),
      rows = [],
      seen = new Map();
    for (const { line, cells } of table.slice(1)) {
      const get = name => {
          const i = header.indexOf(name);
          return i < 0 ? '' : String(cells[i] ?? '').trim();
        },
        errors = [];
      const brand = all.find(b => norm(b.id) === norm(get('marca')) || norm(b.name) === norm(get('marca')));
      if (!brand) errors.push('La marca «' + get('marca') + '» no existe. Créala primero en el catálogo.');
      else
        try {
          crm.requireBrand(user, brand.id);
        } catch {
          errors.push('Sin acceso a la marca ' + brand.name + '.');
        }
      const title = get('curso');
      if (title.length < 3) errors.push('El curso necesita un título de al menos 3 caracteres.');
      const zone = get('zona_horaria') || 'America/Mexico_City';
      let zoneOk = true;
      try {
        new Intl.DateTimeFormat('es-MX', { timeZone: zone });
      } catch {
        zoneOk = false;
        errors.push('Zona horaria no válida: ' + zone + '.');
      }
      const when = (col, label) => {
        const v = get(col);
        if (!v) return null;
        const t = zoneOk ? zonedToUtc(v, zone) : null;
        if (t === null) errors.push(label + ' debe verse como 2026-11-20 18:00 (hora local de la zona).');
        return t;
      };
      const startsAt = when('inicio', 'El inicio'),
        endsAt = when('fin', 'El fin');
      const price = get('precio')
        .replace(/[$\s]/g, '')
        .replace(/,(?=\d{3}\b)/g, '');
      if (price === '' || !Number.isFinite(Number(price)) || Number(price) < 0)
        errors.push('El precio debe ser un número, por ejemplo 379 o 379.50.');
      const modalityText = norm(get('modalidad') || 'online'),
        modality = MODALITY[modalityText];
      if (!modality) errors.push('Modalidad: usa online, presencial o hibrida.');
      const status = STATUS[norm(get('estado') || 'borrador')];
      if (!status) errors.push('Estado: usa borrador o publicada.');
      const promoName = get('promo_nombre'),
        promo = promoName
          ? {
              name: promoName,
              price: get('promo_precio'),
              startsAt: when('promo_inicio', 'El inicio de la promoción'),
              endsAt: when('promo_fin', 'El fin de la promoción'),
              status: STATUS[norm(get('promo_estado') || 'borrador')],
            }
          : null;
      if (promo) {
        if (!Number.isFinite(Number(promo.price)) || promo.price === '')
          errors.push('El precio de la promoción no es válido.');
        if (promo.startsAt === null || promo.endsAt === null) errors.push('La promoción necesita inicio y fin.');
        if (!promo.status) errors.push('Estado de promoción: usa borrador o publicada.');
        if (Number.isFinite(Number(promo.price)) && Number(promo.price) >= Number(price))
          errors.push('La promoción debe costar menos que el precio regular.');
      }
      const editionName = get('edicion') || 'Edición general',
        key = norm(brand?.id) + '|' + norm(title) + '|' + norm(editionName);
      if (seen.has(key)) errors.push('Repite curso y edición de la fila ' + seen.get(key) + '.');
      else seen.set(key, line);
      let courseAction = null,
        editionAction = null,
        promoAction = null;
      if (brand) {
        const course = db
          .prepare('SELECT * FROM courses WHERE brand_id=? AND active=1')
          .all(brand.id)
          .find(c => norm(c.title) === norm(title));
        courseAction = course ? 'existente' : 'crear';
        if (!course && !get('temario')) errors.push('Un curso nuevo necesita temario.');
        const edition =
          course &&
          db
            .prepare("SELECT * FROM editions WHERE course_id=? AND status!='archived'")
            .all(course.id)
            .find(e => norm(e.name) === norm(editionName));
        editionAction = edition ? 'existente' : 'crear';
        const promos = edition
          ? db.prepare("SELECT name FROM promotions WHERE edition_id=? AND status!='archived'").all(edition.id)
          : [];
        promoAction = promo ? (promos.some(p => norm(p.name) === norm(promo.name)) ? 'existente' : 'crear') : null;
      }
      rows.push({
        line,
        errors,
        brandId: brand?.id || null,
        brandName: brand?.name || get('marca'),
        title,
        syllabus: get('temario'),
        edition: {
          name: editionName,
          startsAt,
          endsAt,
          timezone: zone,
          instructor: get('docente'),
          modality,
          location: get('lugar'),
          infoUrl: get('enlace'),
          capacity: get('cupo'),
          availableSeats: get('cupo_disponible'),
          price,
          currency: (get('moneda') || 'MXN').toUpperCase(),
          status,
        },
        promotion: promo,
        actions: { course: courseAction, edition: editionAction, promotion: promoAction },
      });
    }
    return { rows, unknownColumns: unknown, fileHash: createHash('sha256').update(csv).digest('hex') };
  }
  const summary = a => {
    const count = (k, v) => a.rows.filter(r => !r.errors.length && r.actions[k] === v).length;
    return {
      rows: a.rows.length,
      valid: a.rows.filter(r => !r.errors.length).length,
      withErrors: a.rows.filter(r => r.errors.length).length,
      coursesToCreate: count('course', 'crear'),
      editionsToCreate: count('edition', 'crear'),
      promotionsToCreate: count('promotion', 'crear'),
      existing: a.rows.filter(r => !r.errors.length && r.actions.edition === 'existente').length,
    };
  };

  // Ejecuta una ruta del catálogo en el mismo proceso, con el mismo usuario: reutiliza sus validaciones, historial y revisiones.
  async function dispatch(user, method, path, input) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method, url: path, headers: {} });
    let status = 0,
      payload = null;
    const res = {
      writeHead(s) {
        status = s;
      },
      end(d) {
        payload = d ? JSON.parse(d) : null;
      },
    };
    try {
      await catalogue.handle(req, res, path, user);
    } catch (e) {
      return { error: e.message, status: e.status || 500 };
    }
    return status >= 400
      ? { error: payload?.error || payload?.message || 'Error ' + status, status }
      : { item: payload?.item };
  }

  async function apply(user, analysis) {
    const results = [];
    for (const r of analysis.rows) {
      const out = { line: r.line, course: null, edition: null, promotion: null, error: null };
      if (r.errors.length) {
        out.error = r.errors[0];
        results.push(out);
        continue;
      }
      let course = db
          .prepare('SELECT * FROM courses WHERE brand_id=? AND active=1')
          .all(r.brandId)
          .find(c => norm(c.title) === norm(r.title)),
        created = false;
      if (!course) {
        const c = await dispatch(user, 'POST', '/api/catalogue/courses', {
          brandId: r.brandId,
          title: r.title,
          syllabus: r.syllabus,
        });
        if (c.error) {
          out.error = 'Curso: ' + c.error;
          results.push(out);
          continue;
        }
        course = c.item;
        created = true;
        out.course = { id: course.id, action: 'creado' };
      } else out.course = { id: course.id, action: 'existente' };
      let edition = db
        .prepare("SELECT * FROM editions WHERE course_id=? AND status!='archived'")
        .all(course.id)
        .find(e => norm(e.name) === norm(r.edition.name));
      if (edition) out.edition = { id: edition.id, action: 'existente' };
      else {
        const input = {
          name: r.edition.name,
          startsAt: r.edition.startsAt,
          endsAt: r.edition.endsAt,
          timezone: r.edition.timezone,
          instructor: r.edition.instructor,
          modality: r.edition.modality,
          location: r.edition.location,
          infoUrl: r.edition.infoUrl,
          capacity: r.edition.capacity,
          availableSeats: r.edition.availableSeats,
          price: r.edition.price,
          currency: r.edition.currency,
          status: r.edition.status,
        };
        const draft = created
          ? db
              .prepare("SELECT * FROM editions WHERE course_id=? AND status='draft' ORDER BY created_at LIMIT 1")
              .get(course.id)
          : null;
        const e = draft
          ? await dispatch(user, 'PATCH', '/api/catalogue/editions/' + draft.id, {
              ...input,
              expectedRevision: draft.revision,
            })
          : await dispatch(user, 'POST', '/api/catalogue/editions', { ...input, courseId: course.id });
        if (e.error) {
          out.error = 'Edición: ' + e.error;
          results.push(out);
          continue;
        }
        edition = e.item;
        out.edition = { id: edition.id, action: 'creada' };
      }
      if (r.promotion) {
        const known = db
          .prepare("SELECT * FROM promotions WHERE edition_id=? AND status!='archived'")
          .all(edition.id)
          .find(p => norm(p.name) === norm(r.promotion.name));
        if (known) out.promotion = { id: known.id, action: 'existente' };
        else {
          const p = await dispatch(user, 'POST', '/api/catalogue/promotions', {
            editionId: edition.id,
            name: r.promotion.name,
            price: r.promotion.price,
            startsAt: r.promotion.startsAt,
            endsAt: r.promotion.endsAt,
            status: r.promotion.status,
          });
          if (p.error) {
            out.error = 'Promoción: ' + p.error;
            results.push(out);
            continue;
          }
          out.promotion = { id: p.item.id, action: 'creada' };
        }
      }
      results.push(out);
    }
    return results;
  }

  const publicRows = a =>
    a.rows.map(r => ({
      line: r.line,
      brand: r.brandName,
      course: r.title,
      edition: r.edition.name,
      price: r.edition.price,
      currency: r.edition.currency,
      status: r.edition.status,
      promotion: r.promotion?.name || null,
      actions: r.actions,
      errors: r.errors,
    }));

  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/catalogue/import')) return false;
    requireAdmin(user);
    if (path === '/api/catalogue/import/template' && req.method === 'GET') {
      json(res, 200, { csv: TEMPLATE_CSV, columns: COLUMNS });
      return true;
    }
    if (req.method !== 'POST' || !['/api/catalogue/import/preview', '/api/catalogue/import/apply'].includes(path))
      throw fail(404, 'Ruta de importación no encontrada.');
    const input = await body(req),
      analysis = analyse(input.csv, user);
    if (path.endsWith('/preview')) {
      json(res, 200, {
        fileHash: analysis.fileHash,
        unknownColumns: analysis.unknownColumns,
        summary: summary(analysis),
        rows: publicRows(analysis),
      });
      return true;
    }
    if (input.fileHash !== analysis.fileHash)
      throw fail(409, 'El archivo cambió desde la vista previa. Vuelve a previsualizar.');
    if (!analysis.rows.some(r => !r.errors.length)) throw fail(400, 'No hay filas válidas para importar.');
    const results = await apply(user, analysis);
    audit(user, 'catalogue.import', analysis.fileHash.slice(0, 16));
    json(res, 200, {
      fileHash: analysis.fileHash,
      applied: results.filter(r => !r.error).length,
      failed: results.filter(r => r.error).length,
      results,
    });
    return true;
  }
  return { handle, analyse, summary, apply };
}
