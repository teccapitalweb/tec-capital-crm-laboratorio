// Importar contactos por CSV (docs/PLAN_IMPORTAR_CONTACTOS.md; conciliación técnica, filas 14, 15 y 17).
//
//   GET  /api/contact-import?brand=                 historial de la marca y límites
//   POST /api/contact-import/uploads?brand=&name=&clientRef=   el CSV crudo en el cuerpo → 201 {import}
//   GET  /api/contact-import/<id>                   detalle: encabezados, muestra, mapeo, sugerencia, informe, trabajo
//   PUT  /api/contact-import/<id>/mapping           {expectedRevision, targets, options} → {import}
//   POST /api/contact-import/<id>/validate          {expectedRevision, clientRef} → 202 {import, job} (simulacro)
//   POST /api/contact-import/<id>/apply             {expectedRevision, clientRef, confirmConsent?} → 202 {import, job}
//   POST /api/contact-import/<id>/cancel            → {import}
//   GET  /api/contact-import/<id>/rows?phase=&filter=&after=   resultado por fila, de 50 en 50
//   GET  /api/contact-import/<id>/errors.csv?phase=             las filas con problema, para corregirlas
//
// Permiso `contacts.import` sobre la marca en todas. La vista previa y la importación corren como trabajos por trozos
// (módulo jobs): la vista previa aplica cada trozo dentro de un SAVEPOINT que se deshace (lo que cuenta es exactamente
// lo que haría la importación) y la importación lo confirma junto con su cursor.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sharedJobRunner } from '../../app/background-jobs.mjs';
import { decodeCsv, detectDelimiter, iterateCsv, toCsv } from '../../lib/csv.mjs';
import { createRepo } from './repo.mjs';
import { createRowWriter } from './rows.mjs';
import { TARGETS, TEMPLATES, checkMapping, identityOf, looksLikePrevious, mapRow, suggestMapping } from './mapping.mjs';

const PERMISSION = 'contacts.import';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_COLUMNS = 100;
const HARD_MAX_ROWS = 50_000;
// Hasta publicar la lista de contactos paginada, 2 000 filas por archivo (conciliación técnica, fila 14).
// IMPORT_MAX_ROWS lo sube hasta 50 000 cuando administración lo decide.
const maxRows = () => {
  const n = Number(process.env.IMPORT_MAX_ROWS);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, HARD_MAX_ROWS) : 2000;
};
const KEEP_MS = 7 * 24 * 3600 * 1000;
const SAMPLE = 20;
const ORIGIN_MIN = 10;
const ORIGIN_MAX = 200;
const EVENT = 'contactos.importados';
const ID = /^\/api\/contact-import\/([0-9a-f-]{36})(?:\/(mapping|validate|apply|cancel|rows|errors\.csv))?$/;
const KINDS = { preview: 'contact-import.preview', apply: 'contact-import.apply' };

const cleanName = value =>
  String(value ?? '')
    .replace(/[\\/]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 120) || 'contactos.csv';

export default {
  name: 'contact-import',
  create(host) {
    const { db } = host;
    const repo = createRepo(db);
    const now = () => Date.now();
    const fail = (status, message, extra) => host.fail(status, message, extra);
    const runner = sharedJobRunner(host);
    const jobs = () => runner;
    const attributes = () => host.module('attributes');
    // Audiencias: la lista que recibe a los contactos importados. Sin el módulo, la opción no se ofrece.
    const audiences = () => {
      try {
        return host.module('audiences');
      } catch {
        return null;
      }
    };
    const writer = createRowWriter({
      db,
      contacts: host.services.contacts,
      persons: host.services.persons,
      attributes,
    });
    const folder = () => join(host.dataDir ?? '.', 'imports');

    // El resultado de cada fila cuelga del contacto: una fusión lo pasa al que queda.
    host.personData.register({
      name: 'contact-import',
      tables: ['contact_import_rows'],
      merge: (keepId, mergedId) => ({ contact_import_rows: repo.moveContact(keepId, mergedId) }),
    });
    host.services.events?.registerTypes?.(
      {
        [EVENT]: {
          title: 'Contactos importados',
          entity: 'contact_import',
          payload: 'importId, filename, rows, created, updated, unchanged, skipped, errors',
        },
      },
      { entities: { contact_import: 'Importación de contactos' } },
    );
    host.services.integrations?.registerNeeds?.({ [EVENT]: 'contacts' });

    // ---- archivo

    // Texto del archivo guardado. Se guarda en memoria mientras se trabaja con él (una importación a la vez por marca).
    const texts = new Map();
    function textOf(record) {
      if (texts.has(record.id)) return texts.get(record.id);
      if (record.purged_at)
        throw Object.assign(fail(410, 'El archivo de esta importación ya se borró.', { code: 'import_purged' }), {
          permanent: true,
        });
      let text;
      try {
        text = readFileSync(join(folder(), record.storage_name), 'utf8');
      } catch {
        throw Object.assign(fail(410, 'No se encontró el archivo de esta importación.', { code: 'import_purged' }), {
          permanent: true,
        });
      }
      if (texts.size >= 4) texts.delete(texts.keys().next().value);
      texts.set(record.id, text);
      return text;
    }

    // Filas de datos desde un punto del archivo: {row, line, cells, end, nextLine}.
    function* dataRows(record, from) {
      let row = from.row;
      for (const item of iterateCsv(textOf(record), {
        delimiter: record.delimiter,
        offset: from.offset,
        line: from.line,
      })) {
        row++;
        yield { ...item, row };
      }
    }

    // Filas repetidas dentro del archivo (misma clave de teléfono o, sin teléfono, mismo correo): fila → primera.
    // Depende sólo del archivo y del mapeo, así que se recalcula si hace falta (por ejemplo, tras un reinicio).
    const plans = new Map();
    function duplicatesOf(record) {
      const key = `${record.id}:${record.revision}`;
      if (plans.has(key)) return plans.get(key);
      const first = new Map();
      const repeated = new Map();
      for (const item of dataRows(record, { offset: record.data_offset, line: record.data_line, row: 0 })) {
        const identity = identityOf(mapRow(item.cells, record.mapping.targets).row);
        if (!identity) continue;
        if (first.has(identity)) repeated.set(item.row, first.get(identity));
        else first.set(identity, item.row);
      }
      if (plans.size >= 4) plans.delete(plans.keys().next().value);
      plans.set(key, repeated);
      return repeated;
    }

    // ---- una fila del archivo

    function rowOptions(record) {
      const o = record.options;
      return {
        onExisting: o.onExisting === 'skip' ? 'skip' : 'update',
        nameFallback: o.nameFallback === 'error' ? 'error' : 'phone',
        consent: o.consent?.mode === 'declared' ? { mode: 'declared', origin: o.consent.origin } : { mode: 'none' },
        actorId: record.created_by ?? null,
        importId: record.id,
        label: record.filename,
      };
    }

    function processRow(record, item, duplicates, opts) {
      const header = record.header;
      const extra = item.cells.slice(header.length).find(cell => String(cell).trim());
      if (extra !== undefined)
        return {
          action: 'error',
          problem: 'row_shape',
          message: `La fila tiene más columnas (${item.cells.length}) que los encabezados (${header.length}).`,
        };
      const { row, problems } = mapRow(item.cells, record.mapping.targets);
      if (problems.length) {
        const p = problems[0];
        return {
          action: 'error',
          problem: p.code,
          message: p.message,
          detail: { column: header[p.column], value: p.value },
        };
      }
      if (duplicates.has(item.row))
        return {
          action: 'skipped',
          problem: 'duplicate_in_file',
          message: `Repite a la persona de la fila ${duplicates.get(item.row)} del archivo.`,
          detail: { first: duplicates.get(item.row) },
        };
      const out = writer.applyRow(record.brand_id, row, opts);
      const column =
        out.field === 'phone' || out.field === 'email' || out.field === 'name' || out.field === 'tags'
          ? header[record.mapping.targets.indexOf(out.field)]
          : out.field?.startsWith('attr:')
            ? header[record.mapping.targets.indexOf(out.field)]
            : undefined;
      return {
        action: out.action,
        contactId: out.action === 'error' ? null : out.contactId,
        problem: out.reason,
        message: out.message,
        detail:
          out.consent || column || out.value !== undefined
            ? { ...(out.consent ? { consent: out.consent } : {}), column, value: out.value }
            : null,
      };
    }

    // Un trozo de la vista previa o de la importación. Corre dentro de la transacción del ejecutor de trabajos.
    function step(phase, job, { limit }) {
      const brandId = job.brand_id;
      const record = repo.get(brandId, job.ref_id);
      const expected = phase === 'preview' ? 'validating' : 'applying';
      if (!record || record.state !== expected || record.revision !== job.params.revision)
        return { processed: 0, finished: true, result: { stale: true } };
      const cursor = job.cursor ?? { offset: record.data_offset, line: record.data_line, row: 0 };
      if (!job.cursor) repo.clearRows(brandId, record.id, phase);
      const duplicates = duplicatesOf(record);
      // Lo que puede quien lanzó este trabajo, calculado al lanzarlo (un trabajo sin ese dato no escribe nada ajeno).
      const opts = {
        ...rowOptions(record),
        actorId: job.created_by ?? record.created_by ?? null,
        allow: job.params.grants ?? { edit: false, tags: false, consent: false, phone: false },
      };
      const results = [];
      let next = cursor;
      let finished = true;
      // Al importar, quienes quedaron creados, actualizados o sin cambios entran en la lista destino (si la hay), en la
      // misma transacción del trozo: un trozo repetido tras un reinicio no los duplica.
      const listed = phase === 'apply' && record.audience_id ? [] : null;
      if (phase === 'preview') db.exec('SAVEPOINT import_preview');
      try {
        for (const item of dataRows(record, cursor)) {
          if (results.length >= limit) {
            finished = false;
            break;
          }
          const done = processRow(record, item, duplicates, opts);
          results.push({ row: item.row, line: item.line, ...done });
          if (listed && done.contactId && ['created', 'updated', 'unchanged'].includes(done.action))
            listed.push(done.contactId);
          next = { offset: item.end, line: item.nextLine, row: item.row };
        }
      } finally {
        // El simulacro: todo lo que escribieron las filas se deshace; sólo se guarda lo que habría pasado.
        if (phase === 'preview') {
          db.exec('ROLLBACK TO import_preview');
          db.exec('RELEASE import_preview');
        }
      }
      if (listed?.length)
        try {
          audiences()?.addContacts(brandId, record.audience_id, listed, {
            source: 'import',
            sourceRef: record.id,
            actorId: opts.actorId,
          });
        } catch (error) {
          // Si archivaron la lista a media importación, los contactos se siguen importando sin ella.
          if (error?.code !== 'audience_archived') throw error;
        }
      for (const r of results)
        repo.putRow(brandId, record.id, phase, phase === 'preview' ? { ...r, contactId: null } : r);
      if (!finished) return { processed: results.length, cursor: next, total: record.rows };
      const report = reportOf(brandId, record, phase);
      if (phase === 'apply' && record.audience_id)
        report.list = audiences()?.describe(brandId, record.audience_id) ?? null;
      const t = now();
      if (phase === 'preview')
        repo.setState(brandId, record.id, 'validated', { report, validatedRevision: record.revision }, t);
      else {
        repo.setState(brandId, record.id, 'done', { report, finishedAt: t }, t);
        host.services.events?.publish?.({
          type: EVENT,
          brandId,
          entityKind: 'contact_import',
          entityId: record.id,
          payload: { importId: record.id, filename: record.filename, ...report.totals },
          actorId: record.created_by ?? null,
          source: 'contact-import',
          dedupeKey: `${EVENT}:${record.id}`,
        });
      }
      texts.delete(record.id);
      return { processed: results.length, cursor: next, total: record.rows, finished: true, result: report.totals };
    }

    function reportOf(brandId, record, phase) {
      const totals = { rows: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };
      const consent = { optedIn: 0, optedOut: 0, keptOptOut: 0, notRecorded: 0 };
      const problems = {};
      const names = {
        error: 'errors',
        created: 'created',
        updated: 'updated',
        unchanged: 'unchanged',
        skipped: 'skipped',
      };
      const consentNames = {
        opted_in: 'optedIn',
        opted_out: 'optedOut',
        kept_opt_out: 'keptOptOut',
        not_recorded: 'notRecorded',
      };
      for (const r of repo.totals(brandId, record.id, phase)) {
        totals.rows += r.n;
        if (names[r.action]) totals[names[r.action]] += r.n;
        if (r.problem) problems[r.problem] = (problems[r.problem] ?? 0) + r.n;
        if (consentNames[r.consent]) consent[consentNames[r.consent]] += r.n;
      }
      return { phase, revision: record.revision, totals, consent, problems };
    }

    jobs().define(KINDS.preview, {
      permission: PERMISSION,
      step: (job, options) => step('preview', job, options),
      onCancel: job => {
        const record = repo.get(job.brand_id, job.ref_id);
        if (record?.state === 'validating') repo.setState(job.brand_id, record.id, 'uploaded', { report: {} }, now());
      },
      onFail: (job, error) => {
        const record = repo.get(job.brand_id, job.ref_id);
        if (record?.state === 'validating')
          repo.setState(
            job.brand_id,
            record.id,
            'uploaded',
            { report: { failed: String(error?.message ?? '') } },
            now(),
          );
      },
    });
    jobs().define(KINDS.apply, {
      permission: PERMISSION,
      step: (job, options) => step('apply', job, options),
      onCancel: job => {
        const record = repo.get(job.brand_id, job.ref_id);
        if (record?.state === 'applying') {
          const report = { ...reportOf(job.brand_id, record, 'apply'), cancelled: true };
          repo.setState(job.brand_id, record.id, 'cancelled', { report, finishedAt: now() }, now());
        }
      },
      onFail: (job, error) => {
        const record = repo.get(job.brand_id, job.ref_id);
        if (record?.state === 'applying') {
          const report = { ...reportOf(job.brand_id, record, 'apply'), failed: String(error?.message ?? '') };
          repo.setState(job.brand_id, record.id, 'failed', { report, finishedAt: now() }, now());
        }
      },
    });

    // ---- vistas

    const definitionsOf = brandId => attributes().definitions(brandId);
    function shape(record, { detail = false, user = null } = {}) {
      const job = record.job_id ? jobs().get(record.job_id) : null;
      const base = {
        id: record.id,
        brandId: record.brand_id,
        filename: record.filename,
        size: record.size,
        rows: record.rows,
        state: record.state,
        revision: record.revision,
        validatedRevision: record.validated_revision,
        report: record.report,
        options: record.options,
        job: job ? jobs().view(job) : null,
        createdAt: record.created_at,
        finishedAt: record.finished_at,
        purged: Boolean(record.purged_at),
      };
      if (!detail) return base;
      const definitions = definitionsOf(record.brand_id);
      let sample = [];
      if (!record.purged_at) {
        for (const item of dataRows(record, { offset: record.data_offset, line: record.data_line, row: 0 })) {
          sample.push(item.cells.slice(0, record.header.length));
          if (sample.length >= SAMPLE) break;
        }
      }
      // La muestra enseña teléfonos: sólo a quien puede verlos completos.
      if (!user || !host.access.can(user, 'contacts.phone', record.brand_id)) sample = [];
      return {
        ...base,
        encoding: record.encoding,
        delimiter: record.delimiter,
        header: record.header,
        sample,
        mapping: record.mapping,
        suggested: suggestMapping(record.header, definitions),
        targets: [
          ...Object.entries(TARGETS).map(([value, label]) => ({ value, label })),
          ...definitions.map(d => ({ value: 'attr:' + d.key, label: `Dato: ${d.label}`, type: d.type })),
        ],
        templates: TEMPLATES.map(t => ({
          ...t,
          detected: t.id === 'previous-provider' && looksLikePrevious(record.header),
        })),
        previous: repo.previous(record.brand_id, record.sha256, record.id),
        lists: user ? (audiences()?.importTargets(user, record.brand_id) ?? null) : null,
      };
    }

    function locate(user, id, { write = false } = {}) {
      const brandId = repo.brandOf(id);
      if (!brandId) throw fail(404, 'Importación no disponible.', { code: 'not_found' });
      host.access.require(user, PERMISSION, brandId);
      const record = repo.get(brandId, id);
      if (write && record.purged_at)
        throw fail(410, 'El archivo de esta importación ya se borró.', { code: 'import_purged' });
      return record;
    }
    function requireRevision(record, input) {
      if (input.expectedRevision !== record.revision)
        throw fail(409, 'La importación cambió mientras la revisabas. Vuelve a cargarla.', {
          code: 'stale_record',
          details: { revision: record.revision, state: record.state },
        });
    }
    const clientRefOf = input =>
      typeof input.clientRef === 'string' && input.clientRef.trim() ? input.clientRef.trim().slice(0, 100) : null;

    // ---- subir

    async function readRaw(req) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw fail(413, 'El archivo supera 8 MB.', { code: 'too_large' });
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }

    async function upload(req, user, url) {
      const brandId = url.searchParams.get('brand');
      host.access.require(user, PERMISSION, brandId);
      const clientRef = clientRefOf({ clientRef: url.searchParams.get('clientRef') });
      if (clientRef) {
        const previous = repo.byClientRef(brandId, clientRef);
        if (previous) return { status: 200, record: previous };
      }
      const bytes = await readRaw(req);
      if (!bytes.length) throw fail(400, 'El archivo está vacío.', { code: 'no_rows' });
      const { text, encoding } = decodeCsv(bytes);
      const delimiter = detectDelimiter(text, { candidates: [',', ';', '\t'] });
      const limit = maxRows();
      let header = null;
      let dataOffset = 0;
      let dataLine = 1;
      let rows = 0;
      try {
        for (const item of iterateCsv(text, { delimiter, maxColumns: MAX_COLUMNS, strictQuotes: true })) {
          if (!header) {
            header = item.cells.map(cell => String(cell).trim().slice(0, 120));
            dataOffset = item.end;
            dataLine = item.nextLine;
            continue;
          }
          rows++;
          if (rows > limit)
            throw fail(413, `El archivo tiene más de ${limit.toLocaleString('es-MX')} filas.`, {
              code: 'too_many_rows',
              details: { limit },
            });
        }
      } catch (error) {
        if (error?.name === 'CsvError')
          throw fail(error.status, error.message, { code: error.code, details: { line: error.line ?? null } });
        throw error;
      }
      if (!header || !rows)
        throw fail(400, 'El archivo necesita encabezados y al menos una fila.', { code: 'no_rows' });
      const id = randomUUID();
      const storageName = `${id}.csv`;
      mkdirSync(folder(), { recursive: true });
      writeFileSync(join(folder(), storageName), text, 'utf8');
      const definitions = definitionsOf(brandId);
      const t = now();
      try {
        host.transaction(db, () =>
          repo.insert(brandId, {
            id,
            filename: cleanName(url.searchParams.get('name')),
            sha256: createHash('sha256').update(bytes).digest('hex'),
            storageName,
            size: bytes.length,
            encoding,
            delimiter,
            rows,
            header,
            dataOffset,
            dataLine,
            mapping: suggestMapping(header, definitions),
            options: { onExisting: 'update', nameFallback: 'phone', consent: { mode: 'none' } },
            clientRef,
            createdBy: user.id,
            at: t,
          }),
        );
      } catch (error) {
        try {
          unlinkSync(join(folder(), storageName));
        } catch {
          // ya no estaba
        }
        throw error;
      }
      texts.set(id, text);
      host.audit(user, 'contact_import.upload', id);
      return { status: 201, record: repo.get(brandId, id) };
    }

    // ---- mapeo, vista previa, importación, cancelación

    function readOptions(input, current) {
      const raw = input && typeof input === 'object' ? input : {};
      const consent = raw.consent && typeof raw.consent === 'object' ? raw.consent : current.consent;
      const mode = consent?.mode === 'declared' ? 'declared' : 'none';
      const origin = String(consent?.origin ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      if (mode === 'declared' && (origin.length < ORIGIN_MIN || origin.length > ORIGIN_MAX))
        throw fail(
          400,
          `Escribe de dónde viene el permiso de estas personas (de ${ORIGIN_MIN} a ${ORIGIN_MAX} caracteres): por ejemplo, «Aceptaron promociones al inscribirse en el formulario del curso».`,
          { code: 'consent_origin', field: 'consent.origin' },
        );
      return {
        onExisting: (raw.onExisting ?? current.onExisting) === 'skip' ? 'skip' : 'update',
        nameFallback: (raw.nameFallback ?? current.nameFallback) === 'error' ? 'error' : 'phone',
        consent: mode === 'declared' ? { mode, origin } : { mode: 'none' },
      };
    }

    // La lista destino: {audienceId} (una lista activa) o {name} (una nueva que se crea al importar); null = ninguna.
    function readList(user, record, input) {
      const raw = input && typeof input === 'object' && Object.hasOwn(input, 'list') ? input.list : record.options.list;
      if (!raw) return null;
      const api = audiences();
      if (!api) throw fail(400, 'Las listas no están disponibles.', { code: 'mapping_invalid', field: 'options.list' });
      return api.importList(user, record.brand_id, raw);
    }

    function saveMapping(user, record, input) {
      requireRevision(record, input);
      if (['validating', 'applying', 'done', 'cancelled', 'failed'].includes(record.state))
        throw fail(409, 'Esta importación ya no se puede cambiar.', { code: 'import_state' });
      const keys = new Set(definitionsOf(record.brand_id).map(d => d.key));
      const targets = checkMapping(input.targets, record.header, keys, message =>
        fail(400, message, { code: 'mapping_invalid', field: 'targets' }),
      );
      const options = readOptions(input.options, record.options);
      const list = readList(user, record, input.options);
      if (list) options.list = list;
      host.transaction(db, () => repo.setMapping(record.brand_id, record.id, { targets }, options, now()));
      host.audit(user, 'contact_import.mapping', record.id);
      return repo.get(record.brand_id, record.id);
    }

    // Permisos de quien lanza la vista previa o la importación en esa marca. Se guardan en el trabajo y rigen cada fila.
    const GRANTS = {
      phone: 'contacts.phone',
      edit: 'contacts.edit',
      tags: 'contacts.tags.apply',
      consent: 'contacts.consent',
      audiences: 'audiences.edit',
    };
    const grantsOf = (user, brandId) =>
      Object.fromEntries(
        Object.entries(GRANTS).map(([key, permission]) => [key, host.access.can(user, permission, brandId)]),
      );
    // Un destino para el que no hay permiso se rechaza antes de lanzar, con la columna y el motivo: nunca se salta.
    function requireGrants(record, grants) {
      const personal = new Set(
        definitionsOf(record.brand_id)
          .filter(d => d.personal)
          .map(d => d.key),
      );
      record.mapping.targets.forEach((target, index) => {
        let permission = null;
        if (target === 'tags' && !grants.tags) permission = GRANTS.tags;
        else if (target === 'consent' && !grants.consent) permission = GRANTS.consent;
        else if (target.startsWith('attr:') && !grants.edit) permission = GRANTS.edit;
        else if (target.startsWith('attr:') && personal.has(target.slice(5)) && !grants.phone)
          permission = GRANTS.phone;
        if (!permission) return;
        const column = record.header[index] || `Columna ${index + 1}`;
        throw fail(
          400,
          `Tu acceso no incluye «${permission}»: no puedes importar la columna «${column}». Cámbiala a «Ignorar».`,
          { code: 'permission_denied', field: `targets.${index}`, details: { column, target, permission } },
        );
      });
      if (record.options.list && !grants.audiences)
        throw fail(400, 'Tu acceso no incluye «audiences.edit»: quita la lista destino.', {
          code: 'permission_denied',
          field: 'options.list',
          details: { permission: GRANTS.audiences },
        });
      if (record.options.onExisting !== 'skip' && !grants.edit)
        throw fail(
          400,
          'Tu acceso no incluye «contacts.edit»: elige «Dejarla como está» para los contactos que ya existen.',
          { code: 'permission_denied', field: 'options.onExisting', details: { permission: GRANTS.edit } },
        );
    }

    function launch(user, record, input, phase) {
      const clientRef = clientRefOf(input);
      const kind = KINDS[phase];
      // Un reintento con el mismo clientRef devuelve el trabajo ya creado.
      if (clientRef && record.job_id) {
        const job = jobs().get(record.job_id);
        if (job?.kind === kind && job.params.clientRef === clientRef) return record;
      }
      requireRevision(record, input);
      if (phase === 'preview' && !['uploaded', 'validated'].includes(record.state))
        throw fail(409, 'Esta importación ya no admite otra vista previa.', { code: 'import_state' });
      if (phase === 'apply') {
        if (record.state !== 'validated' || record.validated_revision !== record.revision)
          throw fail(409, 'Antes de importar revisa la vista previa con este mapeo.', { code: 'preview_required' });
        if (record.options.consent?.mode === 'declared' && input.confirmConsent !== true)
          throw fail(400, 'Confirma la declaración del origen del permiso antes de importar.', {
            code: 'consent_confirmation',
            field: 'confirmConsent',
          });
      }
      const grants = grantsOf(user, record.brand_id);
      requireGrants(record, grants);
      const busy = repo.busy(record.brand_id, record.id);
      if (busy)
        throw fail(409, 'Ya hay una importación en curso en esta marca. Espera a que termine.', {
          code: 'import_busy',
          details: { importId: busy.id },
        });
      return host.transaction(db, () => {
        const t = now();
        if (phase === 'apply' && record.options.consent?.mode === 'declared')
          repo.setOptions(
            record.brand_id,
            record.id,
            { ...record.options, consent: { ...record.options.consent, confirmedBy: user.id, confirmedAt: t } },
            t,
          );
        // La lista destino se crea (o se comprueba) al lanzar la importación, en la misma transacción.
        if (phase === 'apply' && record.options.list) {
          const api = audiences();
          if (!api) throw fail(409, 'Las listas no están disponibles.', { code: 'import_state' });
          const audienceId = api.resolveImportList(record.brand_id, record.options.list, {
            importId: record.id,
            actorId: user.id,
          });
          repo.setAudience(record.brand_id, record.id, audienceId, t);
        }
        const job = jobs().enqueue({
          kind,
          brandId: record.brand_id,
          createdBy: user.id,
          refId: record.id,
          total: record.rows,
          params: { revision: record.revision, clientRef, grants },
          clientRef: clientRef ? `${record.id}:${phase}:${clientRef}` : null,
        });
        repo.setState(
          record.brand_id,
          record.id,
          phase === 'preview' ? 'validating' : 'applying',
          { jobId: job.id },
          t,
        );
        return repo.get(record.brand_id, record.id);
      });
    }

    function cancel(user, record) {
      const after = host.transaction(db, () => {
        if (['validating', 'applying'].includes(record.state) && record.job_id) jobs().cancel(record.job_id);
        else if (['uploaded', 'validated'].includes(record.state))
          repo.setState(record.brand_id, record.id, 'cancelled', { finishedAt: now() }, now());
        else throw fail(409, 'Esta importación ya terminó.', { code: 'import_state' });
        return repo.get(record.brand_id, record.id);
      });
      host.audit(user, 'contact_import.cancel', record.id);
      return after;
    }

    // ---- resultados por fila

    const FILTERS = {
      all: null,
      errors: ['error'],
      created: ['created'],
      updated: ['updated'],
      unchanged: ['unchanged'],
      skipped: ['skipped'],
    };
    const rowView = (r, reveal) => {
      const detail = r.detail ? JSON.parse(r.detail) : {};
      return {
        row: r.row,
        line: r.line,
        action: r.action,
        contactId: r.contact_id,
        problem: r.problem,
        message: r.message,
        column: detail.column ?? null,
        value: reveal ? (detail.value ?? null) : detail.value ? '•••' : null,
        consent: detail.consent ?? null,
      };
    };
    const phaseOf = url => (url.searchParams.get('phase') === 'apply' ? 'apply' : 'preview');

    // ---- rutas

    async function handle(req, res, path, user, url) {
      if (path === '/api/contact-import' && req.method === 'GET') {
        const brandId = url.searchParams.get('brand');
        // Sin marca: las marcas en las que esta persona puede importar, para elegir una.
        if (!brandId) {
          host.requireStaff(user);
          const ids = new Set(host.access.brandIds(user, PERMISSION));
          host.json(res, 200, {
            brands: host.services.crm
              .brandsFor(user)
              .filter(brand => ids.has(brand.id))
              .map(brand => ({ id: brand.id, name: brand.name })),
          });
          return true;
        }
        host.access.require(user, PERMISSION, brandId);
        host.json(res, 200, {
          imports: repo.list(brandId).map(record => shape(record)),
          limits: {
            bytes: MAX_BYTES,
            rows: maxRows(),
            columns: MAX_COLUMNS,
            originMin: ORIGIN_MIN,
            originMax: ORIGIN_MAX,
          },
        });
        return true;
      }
      if (path === '/api/contact-import/uploads' && req.method === 'POST') {
        const { status, record } = await upload(req, user, url);
        host.json(res, status, { import: shapeFor(user, record) });
        return true;
      }
      const match = ID.exec(path);
      if (!match) return false;
      const [, id, action] = match;
      if (!action && req.method === 'GET') {
        host.json(res, 200, { import: shapeFor(user, locate(user, id)) });
        return true;
      }
      if (action === 'mapping' && req.method === 'PUT') {
        const input = await host.body(req);
        host.json(res, 200, { import: shapeFor(user, saveMapping(user, locate(user, id, { write: true }), input)) });
        return true;
      }
      if ((action === 'validate' || action === 'apply') && req.method === 'POST') {
        const input = await host.body(req);
        const record = launch(
          user,
          locate(user, id, { write: true }),
          input,
          action === 'validate' ? 'preview' : 'apply',
        );
        host.audit(user, action === 'apply' ? 'contact_import.apply' : 'contact_import.preview', record.id);
        host.json(res, 202, { import: shapeFor(user, record) });
        return true;
      }
      if (action === 'cancel' && req.method === 'POST') {
        host.json(res, 200, { import: shapeFor(user, cancel(user, locate(user, id))) });
        return true;
      }
      if (action === 'rows' && req.method === 'GET') {
        const record = locate(user, id);
        const filter = Object.hasOwn(FILTERS, url.searchParams.get('filter')) ? url.searchParams.get('filter') : 'all';
        const after = Math.max(0, Number.parseInt(url.searchParams.get('after') ?? '0', 10) || 0);
        const reveal = host.access.can(user, 'contacts.phone', record.brand_id);
        const list = repo.rows(record.brand_id, record.id, phaseOf(url), {
          actions: FILTERS[filter],
          after,
          limit: 51,
        });
        const page = list.slice(0, 50).map(r => rowView(r, reveal));
        host.json(res, 200, { rows: page, next: list.length > 50 ? page.at(-1).row : null });
        return true;
      }
      if (action === 'errors.csv' && req.method === 'GET') {
        const record = locate(user, id);
        const phase = phaseOf(url);
        const reveal = host.access.can(user, 'contacts.phone', record.brand_id);
        const lines = [];
        let after = 0;
        for (;;) {
          const list = repo.rows(record.brand_id, record.id, phase, {
            actions: ['error', 'skipped'],
            after,
            limit: 1000,
          });
          for (const r of list) {
            const v = rowView(r, reveal);
            lines.push([
              v.row,
              v.line,
              v.action === 'error' ? 'error' : 'omitida',
              v.column ?? '',
              v.message ?? '',
              v.value ?? '',
            ]);
          }
          if (list.length < 1000) break;
          after = list.at(-1).row;
        }
        const csv = toCsv(lines, { header: ['fila', 'linea', 'resultado', 'columna', 'problema', 'valor'], bom: true });
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="filas-con-problema.csv"',
          'Cache-Control': 'no-store',
        });
        res.end(csv);
        host.audit(user, 'contact_import.errors', record.id);
        return true;
      }
      return false;
    }

    const shapeFor = (user, record) => shape(record, { detail: true, user });

    // ---- limpieza: el archivo se borra a los 7 días de terminar (o de quedarse a medias)

    function purge({ at = now(), limit = 20 } = {}) {
      const before = at - KEEP_MS;
      let purged = 0;
      for (const brandId of repo.brandsWithPurgeable(before)) {
        for (const record of repo.purgeable(brandId, before, limit)) {
          try {
            unlinkSync(join(folder(), record.storage_name));
          } catch {
            // ya no estaba
          }
          texts.delete(record.id);
          host.transaction(db, () => repo.markPurged(brandId, record.id, at));
          purged++;
        }
      }
      return purged;
    }

    return {
      handle,
      // La función por fila, para las otras puertas de importación (lista de una audiencia, mudanza por API).
      applyRow: writer.applyRow,
      purge,
    };
  },
  timers: [{ name: 'limpieza', everyMs: 600_000, testEveryMs: 300, run: api => api.purge() }],
};
