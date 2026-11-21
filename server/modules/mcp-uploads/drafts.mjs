// Cursos en borrador del conector (docs/PLAN_MCP_CLAUDE.md, «Dar de alta un curso»). Un curso nuevo NO entra al
// catálogo hasta que una persona aprueba la propuesta «dar_de_alta_curso» (server/modules/mcp-proposals): mientras
// tanto vive en mcp_course_drafts, que no lee el catálogo, ni el asistente, ni la experiencia del cliente.
//
//  · Cada llave o conexión sólo ve y toca sus propios borradores (como sus propuestas): uno de otro origen «no existe».
//  · Idempotente por clientRef (dentro del origen). Un título que ya tiene un curso de la marca (activo o archivado) o
//    un borrador vivo de la marca se rechaza.
//  · Se valida con las reglas del alta (server/lib/course-draft-rules.mjs); lo que falta se guarda y se dice.
//  · Guardar exige la revisión vigente y sólo vale mientras siga en borrador y sin nada creado todavía en el catálogo.
//    Cambiarlo (también su imagen) sube la revisión: una propuesta hecha antes queda obsoleta.
//  · Sin red ni await dentro de una transacción.
import { randomUUID } from 'node:crypto';
import { draftReview, draftRow, localText, titleKey } from '../../lib/course-draft-rules.mjs';

export const DRAFT_LIMITS = Object.freeze({ livePerSource: 40, livePerBrand: 60, list: 100 });
const REF_OK = /^[A-Za-z0-9-]{16,100}$/;
const ID_OK = /^[A-Za-z0-9-]{1,64}$/;

export function createCourseDrafts({ db, repo, fail, transaction, now = Date.now }) {
  const zoneOf = brandId =>
    db.prepare('SELECT timezone FROM operation_settings WHERE brand_id=?').get(brandId)?.timezone ||
    'America/Mexico_City';

  // Títulos parecidos (uno contiene al otro) y si ya está tomado tal cual: contra los cursos del catálogo de la marca
  // y, con `source`, contra los borradores vivos de ESE origen (nunca los de otra llave o conexión).
  function titleCheck(d, source = null) {
    const key = titleKey(d.title);
    const others = repo.titlesOf(d.brand_id, d.id, d.course_id, source);
    const taken = key.length > 0 && others.some(t => titleKey(t) === key);
    const similar =
      key.length >= 3
        ? others.filter(
            t =>
              titleKey(t) !== key &&
              (titleKey(t).includes(key) || key.includes(titleKey(t))) &&
              titleKey(t).length >= 3,
          )
        : [];
    return { taken, similar: [...new Set(similar)].slice(0, 5) };
  }
  // Lo que falta y los avisos, con la base de hoy.
  function review(d) {
    const { taken, similar } = titleCheck(d);
    return draftReview(d, { now: now(), takenTitle: taken, similar });
  }
  const done = d => [d.course_id && 'curso creado', d.flyer_id && 'imagen creada'].filter(Boolean);

  function view(d) {
    const r = d.status === 'draft' ? review(d) : { missing: [], warnings: [] };
    const file = repo.file(d.brand_id, d.file_id);
    return {
      cursoBorradorId: d.id,
      estado: d.status,
      titulo: d.title,
      temario: d.syllabus,
      bienvenida: d.welcome || null,
      apertura: {
        nombre: d.edition_name,
        inicio: localText(d.starts_at, d.timezone),
        fin: localText(d.ends_at, d.timezone),
        zona: d.timezone,
        docente: d.instructor || null,
        modalidad: d.modality,
        lugar: d.location || null,
        enlace: d.info_url || null,
        cupo: d.capacity,
        precio: d.price_cents === null ? null : d.price_cents / 100,
        moneda: d.currency,
      },
      imagen: file ? { archivoId: file.id, formato: file.mime } : null,
      revision: d.revision,
      loQueFalta: r.missing,
      avisos: r.warnings,
      listoParaProponer: d.status === 'draft' && r.missing.length === 0,
      ...(done(d).length ? { yaHecho: done(d) } : {}),
      ...(d.status === 'created'
        ? { creado: { cursoId: d.course_id, aperturaId: d.edition_id, imagenId: d.flyer_id } }
        : {}),
    };
  }

  const own = (key, source, id) => {
    const d =
      typeof id === 'string' && ID_OK.test(id)
        ? repo.ownDraft(key.brand_id, source.sourceKind, source.sourceId, id)
        : null;
    if (!d) throw fail(404, 'Ese curso en borrador no existe para esta llave o conexión.', { code: 'not_found' });
    return d;
  };

  function create(key, source, actor, a) {
    if (typeof a.clientRef !== 'string' || !REF_OK.test(a.clientRef))
      throw fail(400, 'clientRef debe tener de 16 a 100 letras, números o guiones.');
    const brandId = key.brand_id;
    const before = repo.draftByRef(brandId, source.sourceKind, source.sourceId, a.clientRef);
    if (before) return { draft: before, duplicate: true };
    const row = draftRow(a, null, { zoneDefault: zoneOf(brandId), fail });
    const t = now();
    const id = randomUUID();
    const draft = { id, brand_id: brandId, ...row, course_id: null };
    if (titleCheck(draft, source).taken)
      throw fail(409, 'Ya hay un curso de la marca (o un borrador tuyo) con ese título: usa otro.', {
        code: 'title_taken',
      });
    return transaction(db, () => {
      const again = repo.draftByRef(brandId, source.sourceKind, source.sourceId, a.clientRef);
      if (again) return { draft: again, duplicate: true };
      if (repo.liveDraftsBySource(brandId, source.sourceKind, source.sourceId) >= DRAFT_LIMITS.livePerSource)
        throw fail(409, `Esta llave o conexión ya tiene ${DRAFT_LIMITS.livePerSource} cursos en borrador.`, {
          code: 'draft_limit',
        });
      if (repo.liveDraftsByBrand(brandId) >= DRAFT_LIMITS.livePerBrand)
        throw fail(409, `La marca ya tiene ${DRAFT_LIMITS.livePerBrand} cursos en borrador.`, { code: 'draft_limit' });
      repo.insertDraft({
        id,
        brand_id: brandId,
        ...row,
        source_kind: source.sourceKind,
        source_id: source.sourceId,
        created_by: actor.id,
        client_ref: a.clientRef,
        revision: 1,
        status: 'draft',
        created_at: t,
        updated_at: t,
      });
      return { draft: repo.draft(brandId, id), duplicate: false };
    });
  }

  function update(key, source, a) {
    const d = own(key, source, a.cursoBorradorId);
    if (d.status !== 'draft') throw fail(409, 'Ese curso ya no está en borrador.', { code: 'not_draft' });
    if (d.course_id)
      throw fail(
        409,
        'Una parte ya se creó en el catálogo en un intento anterior: termina el alta con otra propuesta o cámbialo en el Catálogo.',
        { code: 'partly_created' },
      );
    if (a.revision !== d.revision)
      throw fail(409, 'El curso en borrador cambió: vuelve a leerlo (listar_cursos_borrador).', {
        code: 'stale_record',
      });
    if (['titulo', 'temario', 'bienvenida', 'apertura'].every(k => a[k] === undefined))
      throw fail(400, 'Manda al menos un cambio.');
    const row = draftRow(a, d, { zoneDefault: zoneOf(d.brand_id), fail });
    if (titleCheck({ ...d, ...row }, source).taken)
      throw fail(409, 'Ya hay un curso de la marca (o un borrador tuyo) con ese título: usa otro.', {
        code: 'title_taken',
      });
    const saved = transaction(db, () => repo.saveDraft(d.brand_id, d.id, d.revision, row, now()));
    if (!saved) throw fail(409, 'El curso en borrador cambió: vuelve a leerlo.', { code: 'stale_record' });
    return repo.draft(d.brand_id, d.id);
  }

  function discard(key, source, a) {
    const d = own(key, source, a.cursoBorradorId);
    if (d.status !== 'draft') throw fail(409, 'Ese curso ya no está en borrador.', { code: 'not_draft' });
    // A medio dar de alta: descartarlo dejaría en el catálogo lo ya creado sin seguimiento.
    if (d.course_id)
      throw fail(
        409,
        `No se descarta: en un intento anterior ya quedó hecho en el catálogo: ${done(d).join(' y ')}. Termina el alta con otra propuesta o retíralo en el Catálogo.`,
        { code: 'partly_created' },
      );
    if (a.revision !== d.revision)
      throw fail(409, 'El curso en borrador cambió: vuelve a leerlo.', { code: 'stale_record' });
    const saved = transaction(db, () => repo.saveDraft(d.brand_id, d.id, d.revision, { status: 'discarded' }, now()));
    if (!saved) throw fail(409, 'El curso en borrador cambió: vuelve a leerlo.', { code: 'stale_record' });
    return repo.draft(d.brand_id, d.id);
  }

  // La imagen subida se liga al borrador (sustituye la anterior) y sube su revisión.
  function attachFile(brandId, draftId, fileId) {
    return transaction(db, () => {
      const d = repo.draft(brandId, draftId);
      if (!d || d.status !== 'draft' || d.course_id) return false;
      return repo.saveDraft(brandId, d.id, d.revision, { file_id: fileId }, now());
    });
  }

  const list = (key, source) =>
    repo.ownDrafts(key.brand_id, source.sourceKind, source.sourceId, DRAFT_LIMITS.list).map(view);

  // Para el alta (la propuesta): avance paso a paso y fin.
  const progress = (brandId, id, fields) => repo.launchProgress(brandId, id, fields, now());
  const markCreated = (brandId, id) => repo.markCreated(brandId, id, now());

  return { create, update, discard, list, view, own, review, titleCheck, attachFile, progress, markCreated };
}
