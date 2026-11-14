import { randomUUID, createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { parseCsv } from './catalogue-import.mjs';
import { normalizePhone } from './persons-schema.mjs';
import { phoneKey } from './lib/identity-keys.mjs';

// Puente con IPCIL (Fase 2 · bloque 2.8). Mientras no exista el IPCIL nuevo, los históricos del panel actual (Firebase)
// entran por archivo JSON o CSV con los nombres de campo del propio panel (alumnos, cursos, aperturas, certificados,
// pagos). Sólo lectura: cada alumno se liga a la persona del CRM (contacto en la marca + identidad única por teléfono o
// correo), las ventas y certificados cuelgan de esa persona y se enseñan en su ficha y en Finanzas como «histórico»;
// nada entra al libro de ventas ni devenga comisiones. Los folios IPCI-AAAA-NNNNN importados adelantan la secuencia del
// año para que el CRM no repita folios. Idempotente por (marca, tipo, id externo); cada importación es un lote que se puede quitar.
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
export const KINDS = {
  curso: 'Cursos',
  apertura: 'Aperturas',
  alumno: 'Alumnos (inscripciones)',
  venta: 'Ventas (pagos registrados)',
  certificado: 'Certificados',
};
export const FIELDS = {
  curso: { required: ['nombre'], optional: ['id', 'precio', 'creditos', 'fechaCurso', 'comisionVendedor'] },
  apertura: {
    required: ['cursoId|cursoNombre'],
    optional: ['id', 'nombre', 'fechaInicio', 'fechaFin', 'estado', 'sesiones'],
  },
  alumno: {
    required: ['nombre', 'telefono|email'],
    optional: [
      'id',
      'cursoId',
      'cursoNombre',
      'aperturaId',
      'estado',
      'fecha',
      'vendedor',
      'saldo',
      'certificadoId',
      'pagos (lista de {fecha, monto, metodo})',
    ],
  },
  venta: { required: ['alumnoId', 'monto'], optional: ['id', 'fecha', 'metodo', 'concepto'] },
  certificado: { required: ['folio'], optional: ['id', 'alumnoId', 'cursoId', 'cursoNombre', 'fecha', 'creditos'] },
};
export const EXAMPLE = {
  origen: 'ipcil',
  cursos: [{ id: 'c1', nombre: 'Nutrición en perros y gatos', precio: 4500, creditos: 2 }],
  aperturas: [
    { id: 'g1', cursoId: 'c1', nombre: 'Grupo 3', fechaInicio: '2025-03-01', estado: 'iniciado', sesiones: 8 },
  ],
  alumnos: [
    {
      id: 'a1',
      nombre: 'Ana Pérez',
      telefono: '5512345678',
      email: 'ana@ejemplo.test',
      cursoId: 'c1',
      aperturaId: 'g1',
      estado: 'activo',
      fecha: '2025-02-20',
      vendedor: 'Laura',
      saldo: 0,
      pagos: [
        { fecha: '2025-02-20', monto: 2250, metodo: 'transferencia' },
        { fecha: '2025-03-05', monto: 2250, metodo: 'tarjeta' },
      ],
    },
  ],
  certificados: [{ id: 'ce1', folio: 'IPCI-2025-00042', alumnoId: 'a1', cursoId: 'c1', fecha: '2025-05-01' }],
};
export const normalizeEmail = v => {
  const s = text(v, 150).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
};
// Fechas del panel: ISO, DD/MM/AAAA, milisegundos, segundos o {seconds} de Firestore. Sólo fecha → mediodía UTC para no cambiar de día.
export function when(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') {
    const s = v.seconds ?? v._seconds;
    return Number.isFinite(Number(s)) ? Number(s) * 1000 : null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? (v < 1e11 ? v * 1000 : v) : null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], 12);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], 12);
  if (/^\d{10,13}$/.test(s)) return when(Number(s));
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : null;
}
// Importes en pesos (número o texto con $ y comas) → centavos enteros.
export function cents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n =
    typeof v === 'number'
      ? v
      : Number(
          String(v)
            .replace(/[^0-9.,-]/g, '')
            .replace(/,(?=\d{3}(\D|$))/g, '')
            .replace(',', '.'),
        );
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
const hash = (...parts) =>
  createHash('sha1')
    .update(
      parts
        .map(p =>
          String(p ?? '')
            .trim()
            .toLowerCase(),
        )
        .join('|'),
    )
    .digest('hex')
    .slice(0, 20);
const str = (o, ...keys) => {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return text(v, 200);
  }
  return '';
};

// Lee el documento: JSON (objeto con listas por tipo, o lista cuando se indica el tipo) o CSV (una lista; `pagos` como JSON en la celda).
export function parseDocument(content, format, kind) {
  const doc = { cursos: [], aperturas: [], alumnos: [], ventas: [], certificados: [] };
  const plural = {
    curso: 'cursos',
    apertura: 'aperturas',
    alumno: 'alumnos',
    venta: 'ventas',
    certificado: 'certificados',
  };
  if (format === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(String(content || ''));
    } catch {
      throw fail(400, 'El archivo no es JSON válido.');
    }
    if (Array.isArray(parsed)) {
      if (!plural[kind]) throw fail(400, 'Para una lista JSON indica el tipo de registros.');
      doc[plural[kind]] = parsed;
      return doc;
    }
    if (!parsed || typeof parsed !== 'object')
      throw fail(400, 'El JSON debe ser un objeto con listas (cursos, aperturas, alumnos, ventas, certificados).');
    for (const [k, p] of Object.entries(plural)) {
      const list = parsed[p] ?? parsed[k];
      if (list !== undefined) {
        if (!Array.isArray(list)) throw fail(400, '«' + p + '» debe ser una lista.');
        doc[p] = list;
      }
    }
    return doc;
  }
  if (format === 'csv') {
    if (!plural[kind]) throw fail(400, 'Indica el tipo de registros del CSV.');
    const rows = parseCsv(String(content || ''));
    if (rows.length < 2) throw fail(400, 'El CSV necesita una fila de encabezados y al menos una de datos.');
    const head = rows[0].cells.map(c => c.trim());
    doc[plural[kind]] = rows.slice(1).map(r => {
      const o = { _line: r.line };
      head.forEach((h, i) => {
        let v = r.cells[i] ?? '';
        if (h === 'pagos' && v.trim()) {
          try {
            v = JSON.parse(v);
          } catch {
            v = v;
          }
        }
        o[h] = typeof v === 'string' ? v.trim() : v;
      });
      return o;
    });
    return doc;
  }
  throw fail(400, 'Formato no admitido: usa json o csv.');
}
// Normaliza y valida; devuelve registros listos para guardar y los errores por fila. Las ventas salen de `ventas` y de `alumnos[].pagos`.
export function normalize(doc) {
  const out = { curso: [], apertura: [], alumno: [], venta: [], certificado: [] },
    errors = [];
  const err = (kind, i, row, message) => errors.push({ kind, row: row?._line || i + 1, message });
  doc.cursos.forEach((c, i) => {
    const nombre = str(c, 'nombre', 'titulo', 'title');
    if (!nombre) return err('curso', i, c, 'Falta el nombre del curso.');
    out.curso.push({
      external_id: str(c, 'id') || 'curso:' + hash(nombre),
      title: nombre,
      amount_cents: cents(c.precio ?? c.price),
      occurred_at: when(c.fechaCurso ?? c.fecha),
      status: str(c, 'estado'),
      data: { creditos: c.creditos ?? null, comisionVendedor: c.comisionVendedor ?? null },
    });
  });
  doc.aperturas.forEach((a, i) => {
    const curso = str(a, 'cursoId', 'cursoNombre', 'curso');
    if (!curso) return err('apertura', i, a, 'Falta el curso de la apertura (cursoId o cursoNombre).');
    const nombre = str(a, 'nombre', 'grupo') || 'Apertura';
    out.apertura.push({
      external_id: str(a, 'id') || 'apertura:' + hash(curso, nombre, a.fechaInicio),
      title: nombre + ' · ' + curso,
      occurred_at: when(a.fechaInicio ?? a.fecha),
      status: str(a, 'estado'),
      data: {
        cursoId: str(a, 'cursoId'),
        cursoNombre: str(a, 'cursoNombre', 'curso'),
        fechaFin: when(a.fechaFin),
        sesiones: Number(a.sesiones) || null,
      },
    });
  });
  doc.alumnos.forEach((a, i) => {
    const nombre = str(a, 'nombre', 'name');
    const phone = normalizePhone(str(a, 'telefono', 'whatsapp', 'phone')),
      email = normalizeEmail(str(a, 'email', 'correo'));
    if (nombre.length < 2) return err('alumno', i, a, 'Falta el nombre del alumno.');
    if (!phone && !email)
      return err('alumno', i, a, 'El alumno necesita teléfono (10 dígitos o +52…) o correo válido.');
    const ext = str(a, 'id') || 'alumno:' + hash(nombre, phone, email, a.cursoId);
    out.alumno.push({
      external_id: ext,
      title: nombre,
      person: { name: nombre, phone, email },
      occurred_at: when(a.fecha ?? a.creadoEn ?? a.fechaProgramada),
      status: str(a, 'estado'),
      amount_cents: cents(a.saldo),
      data: {
        cursoId: str(a, 'cursoId'),
        cursoNombre: str(a, 'cursoNombre', 'curso'),
        aperturaId: str(a, 'aperturaId'),
        vendedor: str(a, 'vendedor', 'vendedorNombre', 'vendedorId'),
        certificadoId: str(a, 'certificadoId'),
        saldoCents: cents(a.saldo),
        sesiones: Number(a.sesiones) || null,
      },
    });
    (Array.isArray(a.pagos) ? a.pagos : []).forEach((p, j) => {
      const monto = cents(p?.monto ?? p?.importe ?? p?.total);
      if (!(monto > 0))
        return err('venta', i, a, 'Pago ' + (j + 1) + ' del alumno «' + nombre + '» sin importe válido.');
      out.venta.push({
        external_id: str(p, 'id') || ext + ':pago:' + (j + 1),
        title: 'Pago ' + (j + 1) + ' · ' + nombre,
        alumnoExt: ext,
        amount_cents: monto,
        occurred_at: when(p.fecha ?? p.fechaPago ?? p.creadoEn),
        status: str(p, 'estado') || 'pagado',
        data: { metodo: str(p, 'metodo', 'metodoPago', 'formaPago'), concepto: str(p, 'concepto', 'nota') },
      });
    });
  });
  doc.ventas.forEach((v, i) => {
    const alumno = str(v, 'alumnoId', 'alumno');
    const monto = cents(v.monto ?? v.importe ?? v.total);
    if (!alumno) return err('venta', i, v, 'Falta alumnoId.');
    if (!(monto > 0)) return err('venta', i, v, 'Importe no válido.');
    out.venta.push({
      external_id: str(v, 'id') || 'venta:' + hash(alumno, v.fecha, monto),
      title: str(v, 'concepto') || 'Pago',
      alumnoExt: alumno,
      amount_cents: monto,
      occurred_at: when(v.fecha ?? v.fechaPago),
      status: str(v, 'estado') || 'pagado',
      data: { metodo: str(v, 'metodo', 'metodoPago', 'formaPago'), concepto: str(v, 'concepto', 'nota') },
    });
  });
  doc.certificados.forEach((c, i) => {
    const folio = str(c, 'folio').toUpperCase();
    if (!folio) return err('certificado', i, c, 'Falta el folio.');
    out.certificado.push({
      external_id: str(c, 'id') || 'certificado:' + folio,
      title: folio,
      folio,
      alumnoExt: str(c, 'alumnoId', 'alumno'),
      occurred_at: when(c.fecha ?? c.creadoEn ?? c.fechaEmision),
      status: str(c, 'estado') || 'emitido',
      data: {
        cursoId: str(c, 'cursoId'),
        cursoNombre: str(c, 'cursoNombre', 'curso'),
        creditos: c.creditos ?? null,
        alumnoNombre: str(c, 'alumnoNombre', 'nombre'),
      },
    });
  });
  return { records: out, errors };
}
const FOLIO = /^IPCI-(\d{4})-(\d{5})$/;

export function createLegacy({ db, crm, persons, events, body, json, audit, broadcast, now = Date.now }) {
  const requireAdmin = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'Los históricos los importa administración.');
  };
  const brandName = id => db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name || id;
  const exists = (brandId, kind, ext) =>
    db
      .prepare('SELECT id,person_id FROM legacy_records WHERE brand_id=? AND kind=? AND external_id=?')
      .get(brandId, kind, ext);
  function parse(input) {
    const brandId = text(input.brandId, 60);
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(404, 'Marca no encontrada.');
    const format = input.format === 'csv' ? 'csv' : 'json',
      kind = text(input.kind, 20) || null,
      content = String(input.content || '');
    if (!content.trim()) throw fail(400, 'Pega o adjunta el contenido del archivo.');
    if (content.length > 5_000_000) throw fail(413, 'El archivo supera 5 MB: divídelo.');
    const { records, errors } = normalize(parseDocument(content, format, kind));
    const counts = {};
    for (const k of Object.keys(KINDS)) {
      const list = records[k];
      let existing = 0;
      for (const r of list) if (exists(brandId, k, r.external_id)) existing++;
      counts[k] = {
        total: list.length,
        existing,
        new: list.length - existing,
        invalid: errors.filter(e => e.kind === k).length,
      };
    }
    return {
      brandId,
      format,
      kind,
      records,
      errors,
      counts,
      filename: text(input.filename, 160),
      note: text(input.note, 300),
    };
  }
  function preview(input, user) {
    requireAdmin(user);
    const p = parse(input);
    return {
      brand: { id: p.brandId, name: brandName(p.brandId) },
      format: p.format,
      counts: p.counts,
      errors: p.errors.slice(0, 50),
      errorCount: p.errors.length,
      sample: Object.fromEntries(
        Object.entries(p.records).map(([k, v]) => [
          k,
          v.slice(0, 3).map(r => ({
            external_id: r.external_id,
            title: r.title,
            amount_cents: r.amount_cents ?? null,
            occurred_at: r.occurred_at ?? null,
            status: r.status,
          })),
        ]),
      ),
    };
  }
  // Persona del alumno: identidad existente (teléfono/correo) → su contacto en la marca; si no, contacto nuevo en la marca y persona por persons.attach.
  function ensureContact(brandId, { name, phone, email }) {
    const pid =
      (phone &&
        db.prepare("SELECT person_id FROM person_identities WHERE kind='phone' AND value=?").get(phone)?.person_id) ||
      (email &&
        db.prepare("SELECT person_id FROM person_identities WHERE kind='email' AND value=?").get(email)?.person_id) ||
      null;
    if (pid) {
      const c = db
        .prepare('SELECT * FROM contacts WHERE persona_id=? AND brand_id=? ORDER BY created_at LIMIT 1')
        .get(pid, brandId);
      if (c) return { contact: c, personId: pid, created: false };
    }
    const id = randomUUID(),
      t = now();
    db.prepare(
      "INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,source,created_at,updated_at) VALUES(?,?,?,?,?,?,'ipcil',?,?)",
    ).run(id, brandId, name, phone || '', phoneKey(phone) ?? '', email || '', t, t);
    const c = db.prepare('SELECT * FROM contacts WHERE id=?').get(id),
      attached = persons.attach(c, 'ipcil');
    return {
      contact: db.prepare('SELECT * FROM contacts WHERE id=?').get(id),
      personId: attached || db.prepare('SELECT persona_id FROM contacts WHERE id=?').get(id)?.persona_id || null,
      created: true,
    };
  }
  function apply(input, user) {
    requireAdmin(user);
    const p = parse(input);
    const total = Object.values(p.records).reduce((n, l) => n + l.length, 0);
    if (!total)
      throw fail(
        400,
        'No hay registros válidos que importar.' + (p.errors.length ? ' Revisa los errores de la vista previa.' : ''),
      );
    const t = now(),
      batchId = randomUUID(),
      done = {
        curso: 0,
        apertura: 0,
        alumno: 0,
        venta: 0,
        certificado: 0,
        repeated: 0,
        personsCreated: 0,
        personsLinked: 0,
        unlinked: 0,
        foliosAdvanced: 0,
      };
    transaction(db, () => {
      db.prepare(
        "INSERT INTO legacy_batches(id,brand_id,source,format,filename,note,counts,imported_by,imported_at) VALUES(?,?,'ipcil',?,?,?,'{}',?,?)",
      ).run(batchId, p.brandId, p.format, p.filename, p.note, user.id, t);
      const insert = db.prepare(
        'INSERT OR IGNORE INTO legacy_records(id,batch_id,brand_id,kind,external_id,person_id,contact_id,title,amount_cents,currency,occurred_at,status,folio,data,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      const put = (kind, r, personId = null, contactId = null) => {
        const n = insert.run(
          randomUUID(),
          batchId,
          p.brandId,
          kind,
          r.external_id,
          personId,
          contactId,
          r.title,
          r.amount_cents ?? null,
          'MXN',
          r.occurred_at ?? null,
          r.status || '',
          r.folio || null,
          JSON.stringify(r.data || {}),
          t,
        ).changes;
        if (n) done[kind]++;
        else done.repeated++;
        return n;
      };
      for (const r of p.records.curso) put('curso', r);
      for (const r of p.records.apertura) put('apertura', r);
      const personOf = new Map(); // id externo del alumno → persona
      for (const r of p.records.alumno) {
        const prev = exists(p.brandId, 'alumno', r.external_id);
        if (prev) {
          personOf.set(r.external_id, prev.person_id);
          done.repeated++;
          continue;
        }
        const { contact, personId, created } = ensureContact(p.brandId, r.person);
        if (created) done.personsCreated++;
        else done.personsLinked++;
        personOf.set(r.external_id, personId);
        put('alumno', r, personId, contact.id);
      }
      const resolve = ext => {
        if (!ext) return null;
        if (personOf.has(ext)) return personOf.get(ext);
        const prev = exists(p.brandId, 'alumno', ext);
        return prev?.person_id || null;
      };
      for (const r of p.records.venta) {
        const pid = resolve(r.alumnoExt);
        if (!pid) done.unlinked++;
        put('venta', r, pid);
      }
      for (const r of p.records.certificado) {
        const pid = resolve(r.alumnoExt);
        if (r.alumnoExt && !pid) done.unlinked++;
        if (put('certificado', r, pid)) {
          const m = FOLIO.exec(r.folio);
          if (m) {
            db.prepare(
              'INSERT INTO certificate_sequences(year,last) VALUES(?,?) ON CONFLICT(year) DO UPDATE SET last=max(last,excluded.last)',
            ).run(Number(m[1]), Number(m[2]));
            done.foliosAdvanced++;
          }
        }
      }
      db.prepare('UPDATE legacy_batches SET counts=? WHERE id=?').run(JSON.stringify(done), batchId);
      events.publish({
        type: 'historico.importado',
        brandId: p.brandId,
        entityKind: 'batch',
        entityId: batchId,
        payload: {
          source: 'ipcil',
          format: p.format,
          filename: p.filename || null,
          counts: {
            curso: done.curso,
            apertura: done.apertura,
            alumno: done.alumno,
            venta: done.venta,
            certificado: done.certificado,
          },
          repeated: done.repeated,
          personsCreated: done.personsCreated,
        },
        actorId: user.id,
        source: 'legacy',
      });
    });
    audit(user, 'legacy.import', batchId);
    broadcast('crm', null, { brandId: p.brandId });
    return { batch: batch(batchId), counts: done, errors: p.errors.slice(0, 50), errorCount: p.errors.length };
  }
  const batch = id => {
    const b = db
      .prepare(
        'SELECT b.*,u.name imported_by_name FROM legacy_batches b LEFT JOIN users u ON u.id=b.imported_by WHERE b.id=?',
      )
      .get(id);
    return b
      ? {
          ...b,
          counts: JSON.parse(b.counts || '{}'),
          brand_name: brandName(b.brand_id),
          records: db.prepare('SELECT count(*) n FROM legacy_records WHERE batch_id=?').get(id).n,
        }
      : null;
  };
  function overview(user, brandParam) {
    requireAdmin(user);
    const ids = crm
      .brandsFor(user)
      .map(b => b.id)
      .filter(id => !brandParam || brandParam === 'all' || id === brandParam);
    if (!ids.length) return { batches: [], totals: {}, kinds: KINDS };
    const ph = ids.map(() => '?').join(',');
    const totals = {};
    for (const k of Object.keys(KINDS)) {
      const r = db
        .prepare(
          `SELECT count(*) n,COALESCE(sum(amount_cents),0) cents,count(DISTINCT person_id) persons FROM legacy_records WHERE brand_id IN (${ph}) AND kind=?`,
        )
        .get(...ids, k);
      totals[k] = { n: r.n, cents: r.cents, persons: r.persons };
    }
    return {
      batches: db
        .prepare(`SELECT id FROM legacy_batches WHERE brand_id IN (${ph}) ORDER BY imported_at DESC LIMIT 50`)
        .all(...ids)
        .map(b => batch(b.id)),
      totals,
      kinds: KINDS,
    };
  }
  function records(user, { brand, kind, q, limit }) {
    requireAdmin(user);
    const ids = crm
      .brandsFor(user)
      .map(b => b.id)
      .filter(id => !brand || brand === 'all' || id === brand);
    if (!ids.length) return [];
    const where = [`r.brand_id IN (${ids.map(() => '?').join(',')})`],
      args = [...ids];
    if (KINDS[kind]) {
      where.push('r.kind=?');
      args.push(kind);
    }
    if (q) {
      where.push('(r.title LIKE ? OR r.external_id LIKE ? OR r.folio LIKE ? OR p.name LIKE ?)');
      const like = '%' + String(q).slice(0, 80) + '%';
      args.push(like, like, like, like);
    }
    return db
      .prepare(
        `SELECT r.*,p.name person_name FROM legacy_records r LEFT JOIN persons p ON p.id=r.person_id WHERE ${where.join(' AND ')} ORDER BY r.occurred_at DESC,r.created_at DESC LIMIT ?`,
      )
      .all(...args, Math.min(500, Math.max(1, Number(limit) || 100)))
      .map(r => ({ ...r, data: JSON.parse(r.data || '{}'), brand_name: brandName(r.brand_id) }));
  }
  // Ficha de persona: sólo las marcas visibles para quien consulta (el llamador pasa el conjunto permitido).
  function forPerson(personId, allowed) {
    return db
      .prepare(
        "SELECT * FROM legacy_records WHERE person_id=? AND kind IN ('alumno','venta','certificado') ORDER BY occurred_at DESC,created_at DESC LIMIT 100",
      )
      .all(personId)
      .filter(r => allowed.has(r.brand_id))
      .map(r => ({
        id: r.id,
        kind: r.kind,
        kindLabel: KINDS[r.kind],
        brand_id: r.brand_id,
        brand_name: brandName(r.brand_id),
        title: r.title,
        amount_cents: r.amount_cents,
        currency: r.currency,
        occurred_at: r.occurred_at,
        status: r.status,
        folio: r.folio,
        data: JSON.parse(r.data || '{}'),
      }));
  }
  // Finanzas: ventas históricas del periodo (fuera del libro, sin comisiones).
  function financeSummary(ids, from, to) {
    if (!ids.length) return { sales: 0, salesCents: 0, byBrand: [] };
    const ph = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT brand_id,count(*) n,COALESCE(sum(amount_cents),0) cents FROM legacy_records WHERE kind='venta' AND brand_id IN (${ph}) AND occurred_at>=? AND occurred_at<? GROUP BY brand_id ORDER BY cents DESC`,
      )
      .all(...ids, from, to);
    return {
      sales: rows.reduce((n, r) => n + r.n, 0),
      salesCents: rows.reduce((n, r) => n + r.cents, 0),
      byBrand: rows.map(r => ({ id: r.brand_id, name: brandName(r.brand_id), sales: r.n, salesCents: r.cents })),
      undated: db
        .prepare(
          `SELECT count(*) n FROM legacy_records WHERE kind='venta' AND brand_id IN (${ph}) AND occurred_at IS NULL`,
        )
        .get(...ids).n,
    };
  }
  function remove(id, user) {
    requireAdmin(user);
    const b = db.prepare('SELECT * FROM legacy_batches WHERE id=?').get(id);
    if (!b) throw fail(404, 'Lote no encontrado.');
    const n = transaction(db, () => {
      const r = db.prepare('DELETE FROM legacy_records WHERE batch_id=?').run(id).changes;
      db.prepare('DELETE FROM legacy_batches WHERE id=?').run(id);
      return r;
    });
    audit(user, 'legacy.remove', id);
    broadcast('crm', null, { brandId: b.brand_id });
    return n; // los contactos y personas creados se conservan: son datos de la empresa
  }
  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/legacy')) return false;
    const p = new URL(req.url, 'http://localhost').searchParams;
    let x;
    if (path === '/api/legacy' && req.method === 'GET') {
      json(res, 200, overview(user, p.get('brand')));
      return true;
    }
    if (path === '/api/legacy/format' && req.method === 'GET') {
      requireAdmin(user);
      json(res, 200, { kinds: KINDS, fields: FIELDS, example: EXAMPLE });
      return true;
    }
    if (path === '/api/legacy/records' && req.method === 'GET') {
      json(res, 200, {
        records: records(user, {
          brand: p.get('brand'),
          kind: p.get('kind'),
          q: p.get('q') || '',
          limit: p.get('limit'),
        }),
      });
      return true;
    }
    if (path === '/api/legacy/preview' && req.method === 'POST') {
      json(res, 200, preview(await body(req), user));
      return true;
    }
    if (path === '/api/legacy/apply' && req.method === 'POST') {
      json(res, 201, apply(await body(req), user));
      return true;
    }
    if ((x = path.match(/^\/api\/legacy\/batches\/([a-f0-9-]{36})$/)) && req.method === 'DELETE') {
      json(res, 200, { removed: remove(x[1], user) });
      return true;
    }
    throw fail(404, 'Ruta de históricos no encontrada.');
  }
  return { handle, preview, apply, overview, records, forPerson, financeSummary, remove };
}
