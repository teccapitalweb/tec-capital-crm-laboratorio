// Propuestas del asistente (docs/PLAN_MCP_CLAUDE.md, «Propuestas que aprueba una persona»).
//
// El conector de Claude (server/lib/mcp-proposals.mjs) deja una PROPUESTA de una acción de la lista cerrada de
// ./actions.mjs (publicar un recorrido, encender una secuencia…); una persona del equipo la aprueba o la rechaza con
// un botón en la pantalla «Propuestas del asistente». Reglas que cumple:
//  · El conector no puede aprobar por ninguna vía: no hay herramienta para eso; estas rutas exigen la sesión de cookie
//    del equipo (con la comprobación de Origin del servidor) y rechazan una petición que traiga Authorization (llave
//    `tcw_` o ficha OAuth) o que venga del propio conector en el mismo proceso.
//  · Aprobar ejecuta la acción real A NOMBRE DE QUIEN APRUEBA, por la misma ruta del módulo que usa el botón de su
//    pantalla: se comprueban SUS permisos y su alcance por marca, y la bitácora del módulo queda a su nombre.
//  · Con la revisión guardada al proponer como expectedRevision: si la entidad cambió después, la propuesta queda
//    «obsoleta» y no se ejecuta nada. Así se aprueba exactamente lo que se vio.
//  · Idempotente: el paso de «pendiente» a «aprobándose» es atómico y ocurre antes de ejecutar; un segundo clic o una
//    segunda pestaña encuentra la propuesta ya tomada. Nada de red ni await dentro de una transacción.
//  · Lo que muestra la tarjeta lo recalcula el servidor desde la base; la nota del asistente se devuelve aparte, como
//    texto plano que la pantalla escapa.
//
// Rutas (con sesión, bajo /api/mcp-proposals):
//   GET  /api/mcp-proposals?brand=          pendientes (con lo que pasará y sus avisos) e historial de las marcas de la
//                                           persona (inbox.view)
//   POST /api/mcp-proposals/:id/approve     {} → {proposal} · 409 si ya se decidió, cambió (obsoleta) o no se pudo
//   POST /api/mcp-proposals/:id/reject      {} → {proposal}
// Para el conector (host.module('mcp-proposals')): propose, listFor, withdraw.
// Tiempo real: 'mcp_proposals.changed' {brandId}.
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fromConnector } from '../../lib/connector-call.mjs';
import { problemsOf } from '../course-access/module.mjs';
import { whenWords } from '../../lib/course-draft-rules.mjs';
import { ACTIONS, EXEC_ROUTES, STATUS, actionOf } from './actions.mjs';
import { createRepo } from './repo.mjs';

const DAY = 24 * 3600 * 1000;
export const LIMITS = Object.freeze({
  // Caben las propuestas de un catálogo completo (publicar la apertura y aprobar la imagen de unos 20 cursos).
  pendingPerBrand: 60,
  // por origen: una misma llave o conexión no llena sola el tope de la marca
  pendingPerSource: 40,
  expiresMs: 7 * DAY,
  noteLength: 500,
  nameLength: 120,
  // Proponer un catálogo de ~40 en un minuto cabe; el conector además limita a 60 llamadas por minuto por llave.
  proposePerMinute: 60,
  withdrawPerMinute: 30,
  // Aprobar por lote llama a la ruta de aprobar una vez por propuesta, en serie: un lote del tope de la marca (60) más
  // algunos reintentos cabe en un minuto; pasado eso, el resto sigue pendiente y se dice.
  decidePerMinute: 90,
  history: 50,
  stuckMs: 10 * 60 * 1000,
  sweepRows: 500,
  // las decididas (aprobadas, rechazadas, retiradas, vencidas, obsoletas, fallidas) se borran a los 90 días, por trozos
  keepDecidedMs: 90 * DAY,
  purgeChunk: 500,
  purgeMaxChunks: 40,
});
export const SOURCE_GONE = 'La llave o conexión que la propuso ya no está activa.';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = '([a-f0-9-]{36})';

// Caracteres de control (salvo el salto de línea) e invisibles o de dirección del texto: se escriben por su código para
// que el archivo no lleve ninguno.
const INVISIBLE = new RegExp(
  '[' +
    [
      [0x00, 0x09],
      [0x0b, 0x1f],
      [0x7f, 0x7f],
      [0x200b, 0x200f],
      [0x202a, 0x202e],
      [0x2066, 0x2069],
    ]
      .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b))
      .join('') +
    ']',
  'g',
);

// Texto plano: sin caracteres de control (salvo el salto de línea), recortado.
export const cleanNote = v =>
  typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').trim().slice(0, LIMITS.noteLength) : '';

// El nombre de la entidad (lo escribió el equipo o el asistente) va aparte del título, rotulado «Nombre»: en una sola
// línea, sin caracteres de control ni de dirección del texto, sin comillas («» “” "" ‘’ '' ‹› `) y recortado. Así no
// puede cerrar unas comillas del servidor ni parecer una frase que el CRM afirma.
const QUOTES = /[«»“”„‟"‘’‚‛'‹›`]/g;
// Saltos de línea (también los de Unicode) y otros invisibles que INVISIBLE no cubre, por su código.
const NAME_BREAKS = new RegExp('[\\r\\n\\t' + String.fromCharCode(0x2028, 0x2029) + ']+', 'g');
const NAME_HIDDEN = new RegExp('[' + String.fromCharCode(0x80) + '-' + String.fromCharCode(0x9f, 0xfeff) + ']', 'g');
export function cleanName(v) {
  const text = (typeof v === 'string' ? v : '')
    .replace(NAME_BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(NAME_HIDDEN, '')
    .replace(QUOTES, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > LIMITS.nameLength ? text.slice(0, LIMITS.nameLength - 1).trimEnd() + '…' : text;
}

export default {
  name: 'mcp-proposals',
  create(host) {
    const { db, fail, json, body, audit, transaction } = host;
    const { crm, catalogue, content, automation } = host.services;
    const access = host.access;
    const repo = createRepo(db);
    // Los cursos en borrador y su alta viven en el módulo mcp-uploads.
    const uploads = () => {
      const found = host.module('mcp-uploads');
      if (!found?.launch) throw fail(503, 'Esa parte del CRM no está disponible ahora. Inténtalo más tarde.');
      return found;
    };
    // Sólo en pruebas: hace fallar UNA vez el paso de crear la imagen de un curso cuyo título lleva esta marca, para
    // comprobar el alta a medias y su reintento.
    const failMark = process.env.NODE_ENV === 'test' ? process.env.MCP_TEST_FAIL_FLYER_TITLE || '' : '';
    const failedOnce = new Set();
    const failFlyerOnce = d => {
      if (!failMark || !String(d.title).includes(failMark) || failedOnce.has(d.id)) return false;
      failedOnce.add(d.id);
      return true;
    };
    const now = () => Date.now();

    const emit = brandId => {
      try {
        host.realtime?.emit('mcp_proposals.changed', { brandId, data: { brandId } });
      } catch {
        // el aviso en vivo es una comodidad: no detiene la operación
      }
    };

    // ---- llamar a la ruta de un módulo en el mismo proceso, como la pantalla, a nombre de `user`. Sólo EXEC_ROUTES.
    // No lleva la marca del conector (server/lib/connector-call.mjs): quien actúa es una persona.
    const services = { catalogue };
    async function moduleCall(user, name, method, path, input) {
      if (!EXEC_ROUTES.some(([n, m, re]) => n === name && m === method && re.test(path)))
        throw fail(403, 'Esa acción no está disponible desde Propuestas.');
      const api = Object.hasOwn(services, name) ? services[name] : host.module(name);
      if (!api || typeof api.handle !== 'function')
        throw fail(503, 'Esa parte del CRM no está disponible ahora. Inténtalo más tarde.');
      const chunks = input === undefined ? [] : [Buffer.from(JSON.stringify(input))];
      const url = new URL('http://propuestas.local' + path);
      const req = Object.assign(Readable.from(chunks), { method, url: path, headers: {} });
      let status = 0;
      let payload = null;
      const res = {
        setHeader() {},
        writeHead(s) {
          status = s;
        },
        end(d) {
          payload = d ? JSON.parse(d) : null;
        },
      };
      const handled = await api.handle(req, res, path, user, url);
      if (handled === false) throw fail(404, 'Esa acción no está disponible.');
      if (status >= 400)
        throw fail(status, payload?.error || 'El CRM rechazó la acción.', {
          code: payload?.code,
          details: payload?.details,
        });
      return payload;
    }

    // ---- ¿puede esta persona decidir esta acción en esta marca? (pista para la pantalla; la ruta lo vuelve a exigir)
    const PERMISSION = {
      automation: [
        (u, b) => access.can(u, 'automation.manage', b),
        'Aprobarla pide poder administrar la automatización de esta marca.',
      ],
      access: [
        (u, b) => access.can(u, 'sales.access.manage', b),
        'Aprobarla pide poder administrar los accesos del curso de esta marca.',
      ],
      catalogue: [(u, b) => u.role === 'admin' && crm.canBrand(u, b), 'Aprobarla pide ser administración de la marca.'],
      // dar de alta un curso: lo que piden sus rutas (crear el curso y publicar la apertura: administración; crear y
      // aprobar la imagen: aprobar contenido)
      course_launch: [
        (u, b) => u.role === 'admin' && crm.canBrand(u, b) && Boolean(content?.access?.(u)?.approve),
        'Aprobarla pide ser administración de la marca y poder aprobar contenido.',
      ],
      content: [
        (u, b) => crm.canBrand(u, b) && Boolean(content?.access?.(u)?.approve),
        'Aprobarla pide poder aprobar textos de contenido.',
      ],
    };
    const canDecide = (user, row) => {
      const a = actionOf(row.action);
      const rule = a && PERMISSION[a.permission];
      return rule ? rule[0](user, row.brand_id) : false;
    };
    const whyNot = row => PERMISSION[actionOf(row.action)?.permission]?.[1] || 'No tienes permiso para esta acción.';

    // ---- revisar una acción sobre una entidad: existe, es de la marca, y desde su estado la acción tiene sentido.
    // Lo síncrono sale de la base; lo que revisa el módulo (errores de un recorrido, lo que le falta a una regla) se
    // pide a su ruta de lectura a nombre de `user`.
    // `mode`: 'propose' (al dejarla), 'view' (en la pantalla) o 'approve' (al aprobar, lo más estricto).
    function snapshot(brandId, action, entityId, mode = 'view') {
      const a = actionOf(action);
      if (!a || typeof entityId !== 'string' || !ID.test(entityId)) return null;
      const e = repo.entity(brandId, a.entity, entityId);
      if (!e) return null;
      const checked = a.check(e, {
        mode,
        now: now(),
        pendingPublish: editionId => repo.pendingPublish(brandId, editionId),
        courseUsage: courseId => repo.courseUsage(brandId, courseId),
        // un curso en borrador del conector: lo que le falta y sus avisos, con las reglas del alta
        launchReview: d => uploads().launch.review(d),
        when: whenWords,
        automationOn: (() => {
          try {
            return Boolean(automation?.enabledFor?.(brandId));
          } catch {
            return true;
          }
        })(),
        accessProblems: problemsOf,
        overlap: p => repo.promotionOverlap(p),
        // para «Lo que se enviará a los clientes»: nombres dentro de la marca y la versión publicada de un recorrido
        names: repo.names(brandId),
        versionGraph: (flowId, version) => repo.versionGraph(brandId, flowId, version),
      });
      return { a, e, name: a.name(e), revision: e.revision, ...checked };
    }
    const issueText = x => (typeof x === 'string' ? x : x?.message || x?.text || String(x?.code || ''));
    async function inspect(user, brandId, action, entityId, { strict = false, mode = 'view' } = {}) {
      const s = snapshot(brandId, action, entityId, mode);
      if (!s) return null;
      const problems = [...s.problems];
      const warnings = [...s.warnings];
      if (s.a.review && !s.problems.length) {
        try {
          const r = await moduleCall(user, s.a.review.module, s.a.review.method, s.a.review.path(entityId));
          const issues = s.a.review.issues(r) || {};
          problems.push(...(issues.errors || []).map(issueText));
          warnings.push(...(issues.warnings || []).map(issueText));
        } catch (error) {
          if (strict) throw error;
          warnings.push('No se pudo revisar ahora; la revisión se repite al aprobar.');
        }
      }
      return { ...s, problems, warnings };
    }

    // ---- vistas
    const sourceView = row => ({
      kind: row.source_kind,
      kindLabel: row.source_kind === 'oauth' ? 'Asistente conectado' : 'Llave de la API',
      name: row.source_name,
      ownerName: repo.userName(row.proposed_by),
    });
    function cardView(row, user, inspected) {
      const a = actionOf(row.action);
      const name = cleanName(inspected?.name ?? row.entity_name);
      const decide = canDecide(user, row);
      return {
        id: row.id,
        brandId: row.brand_id,
        brandName: repo.brandName(row.brand_id),
        action: row.action,
        // Sólo la acción, texto fijo del servidor. El nombre va aparte (`name`), rotulado y saneado.
        title: a?.label ?? 'Acción',
        name,
        entity: {
          type: row.entity_type,
          id: row.entity_id,
          name,
          exists: inspected ? true : inspected === null ? false : undefined,
          screen: a?.screen ?? null,
        },
        effect: a?.effect ?? '',
        details: (inspected?.details ?? []).map(([label, value]) => ({ label, value: String(value ?? '') })),
        // Lo que la entidad le dirá a los clientes, recalculado desde la base (null si la acción no envía nada).
        sends: inspected?.sends ?? null,
        // La imagen que se aprobaría: una dirección del mismo origen que sirve el catálogo con sesión y alcance por
        // marca (nunca una dirección externa ni algo que haya escrito el asistente).
        image:
          inspected?.image && /^\/api\/library\/files\/[a-f0-9-]{36}$/.test(inspected.image.url)
            ? inspected.image
            : null,
        // Orden en un lote (la pantalla aprueba en serie, de menor a mayor).
        batchOrder: a?.batchOrder ?? 1,
        // «Seleccionar todas» la incluye (un retiro, archivar_curso, se marca a mano)
        selectAll: a?.selectAll !== false,
        problems: inspected === null ? ['Ya no existe en esta marca.'] : (inspected?.problems ?? []),
        warnings: inspected?.warnings ?? [],
        // Escrita por el asistente: texto plano, para mostrarse aparte y escapado, nunca como instrucción.
        note: row.note,
        source: sourceView(row),
        status: row.status,
        statusLabel: STATUS[row.status] ?? row.status,
        error: row.error,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        decidedAt: row.decided_at,
        decidedByName: repo.userName(row.decided_by),
        canDecide: decide,
        cannotWhy: decide ? null : whyNot(row),
      };
    }

    // ---- ¿sigue vigente el origen? La comprobación es la del conector (server/mcp.mjs, sourceActive), que la entrega
    // al arrancar con useSourceCheck: la misma regla con que deja pasar una llamada. Sin ella no se sabe: no se aprueba
    // nada (503) y el mantenimiento no retira nada.
    let sourceCheck = null;
    const sourceKnown = () => typeof sourceCheck === 'function';
    const sourceActive = row => sourceCheck(row.source_kind, row.source_id, row.brand_id) === true;

    // ---- mantenimiento: vencer, retirar las de un origen que ya no está activo, marcar obsoletas y soltar las que se
    // quedaron a medias
    function refresh(rows) {
      const t = now();
      const touched = new Set();
      transaction(db, () => {
        for (const row of rows) {
          if (row.status !== 'pending') continue;
          if (row.expires_at <= t) {
            if (repo.move(row.brand_id, row.id, 'pending', 'expired', { at: t })) touched.add(row.brand_id);
            continue;
          }
          if (sourceKnown() && !sourceActive(row)) {
            if (repo.move(row.brand_id, row.id, 'pending', 'withdrawn', { at: t, error: SOURCE_GONE }))
              touched.add(row.brand_id);
            continue;
          }
          const a = actionOf(row.action);
          const e = a ? repo.entity(row.brand_id, a.entity, row.entity_id) : null;
          if (!e || e.revision !== row.entity_revision) {
            const why = e ? 'Cambió desde que se propuso; pide una propuesta nueva.' : 'Ya no existe en esta marca.';
            if (repo.move(row.brand_id, row.id, 'pending', 'stale', { at: t, error: why })) touched.add(row.brand_id);
          }
        }
      });
      for (const b of touched) emit(b);
    }
    // Las decididas de más de 90 días se borran por trozos (cada trozo, su propia sentencia), con un tope por vuelta.
    function purge(t = now()) {
      let total = 0;
      for (let i = 0; i < LIMITS.purgeMaxChunks; i++) {
        const n = repo.purgeDecided(t - LIMITS.keepDecidedMs, LIMITS.purgeChunk);
        total += n;
        if (n < LIMITS.purgeChunk) break;
      }
      return total;
    }
    function sweep() {
      const t = now();
      transaction(db, () => {
        repo.unstick(t - LIMITS.stuckMs, t);
        repo.expire(t);
      });
      refresh(repo.allPending(LIMITS.sweepRows));
      return { purged: purge(t) };
    }

    // ---- para el conector (server/lib/mcp-proposals.mjs): la llave ya se comprobó (marca, permisos y firma)
    const sourceOf = key => {
      const oauth = String(key.id).startsWith('oauth:');
      return {
        sourceKind: oauth ? 'oauth' : 'key',
        sourceId: oauth ? String(key.id).slice(6) : String(key.id),
        sourceName: String(key.name || '').slice(0, 120),
      };
    };
    async function propose(key, actor, { action, entityId, note }) {
      const brandId = key.brand_id;
      const a = actionOf(action);
      if (!a) throw fail(400, 'Esa acción no se puede proponer.', { code: 'invalid_action' });
      host.rate('mcp-proposals.propose:' + key.id, LIMITS.proposePerMinute);
      const seen = await inspect(actor, brandId, action, entityId, { strict: true, mode: 'propose' });
      if (!seen) throw fail(404, `Ese ${a.noun} no existe en esta marca.`, { code: 'not_found' });
      // Lo que es de un origen (un curso en borrador) sólo lo propone ese mismo origen: para otro «no existe».
      if (a.sourceBound && !uploads().launch.ownedBy(seen.e, key))
        throw fail(404, `Ese ${a.noun} no existe en esta marca.`, { code: 'not_found' });
      if (seen.problems.length)
        throw fail(409, 'Todavía no se puede proponer: ' + seen.problems[0], {
          code: 'not_ready',
          details: { problemas: seen.problems, avisos: seen.warnings },
        });
      const t = now();
      const source = sourceOf(key);
      const made = transaction(db, () => {
        repo.expire(t);
        const existing = repo.open(brandId, action, seen.e.id);
        if (existing) {
          // La de este mismo origen se devuelve (idempotente). La de otro se rechaza sin decir su nota ni quién.
          if (existing.source_kind === source.sourceKind && existing.source_id === source.sourceId)
            return { row: existing, duplicate: true };
          throw fail(
            409,
            `Ya hay una propuesta pendiente para eso mismo (${a.noun}): espera a que una persona la decida.`,
            {
              code: 'already_proposed',
            },
          );
        }
        // Lo revisado debe seguir igual al guardar (la revisión es lo que se aprobará).
        const again = snapshot(brandId, action, seen.e.id, 'propose');
        if (!again || again.revision !== seen.revision)
          throw fail(409, 'Cambió mientras se revisaba: vuelve a intentarlo.', { code: 'stale_record' });
        if (repo.pendingBySource(brandId, source.sourceKind, source.sourceId) >= LIMITS.pendingPerSource)
          throw fail(
            409,
            `Esta llave o conexión ya tiene ${LIMITS.pendingPerSource} propuestas pendientes: espera a que una persona las revise o retira alguna.`,
            { code: 'source_limit' },
          );
        if (repo.pendingCount(brandId) >= LIMITS.pendingPerBrand)
          throw fail(
            409,
            `La marca ya tiene ${LIMITS.pendingPerBrand} propuestas pendientes: espera a que una persona las revise o retira alguna.`,
            { code: 'proposal_limit' },
          );
        const id = randomUUID();
        repo.insert({
          id,
          brandId,
          action,
          entityType: a.entity,
          entityId: seen.e.id,
          revision: seen.revision,
          entityName: String(seen.name).slice(0, 200),
          note: cleanNote(note),
          ...source,
          proposedBy: actor.id,
          at: t,
          expiresAt: t + LIMITS.expiresMs,
        });
        return { row: repo.get(brandId, id), duplicate: false };
      });
      // La auditoría la escribe la herramienta del conector (una sola fila, con la propuesta en la actividad).
      if (!made.duplicate) emit(brandId);
      return { ...made, warnings: seen.warnings };
    }
    // El conector sólo ve y retira las propuestas de su propio origen (misma llave o mismo permiso OAuth).
    const ownRows = key => {
      const s = sourceOf(key);
      return repo.forSource(key.brand_id, s.sourceKind, s.sourceId, LIMITS.history);
    };
    function listFor(key) {
      refresh(ownRows(key));
      return ownRows(key);
    }
    function withdraw(key, id) {
      host.rate('mcp-proposals.withdraw:' + key.id, LIMITS.withdrawPerMinute);
      const s = sourceOf(key);
      const found = typeof id === 'string' ? repo.get(key.brand_id, id) : null;
      // La de otro origen no existe para esta llave (no se revela que exista).
      const row = found && found.source_kind === s.sourceKind && found.source_id === s.sourceId ? found : null;
      if (!row) throw fail(404, 'Esa propuesta no existe en esta marca.', { code: 'not_found' });
      if (!repo.move(row.brand_id, row.id, 'pending', 'withdrawn', { at: now() }))
        throw fail(
          409,
          'Sólo se retira una propuesta pendiente; ésta está «' + (STATUS[row.status] ?? row.status) + '».',
          {
            code: 'not_pending',
          },
        );
      emit(row.brand_id);
      return repo.get(row.brand_id, row.id);
    }

    // ---- aprobar y rechazar: sólo personas con sesión del equipo
    function locate(user, id) {
      const row = repo.byId(id);
      if (!row || !access.can(user, 'inbox.view', row.brand_id))
        throw fail(404, 'Propuesta no disponible.', { code: 'not_found' });
      return row;
    }
    const decided = row =>
      fail(409, 'Esta propuesta ya está «' + (STATUS[row.status] ?? row.status) + '».', {
        code: 'already_decided',
        // el estado en que quedó (la pantalla de lote dice «obsoleta» si el mantenimiento ya la marcó así)
        details: { status: row.status, reason: row.error || null },
      });

    async function approve(user, id, seenWarnings = null) {
      const first = locate(user, id);
      if (!canDecide(user, first)) throw fail(403, whyNot(first), { code: 'forbidden' });
      const a = actionOf(first.action);
      if (!sourceKnown()) throw fail(503, 'Las propuestas no están disponibles ahora. Inténtalo más tarde.');
      // Paso atómico: pendiente → aprobándose, sólo si no venció, su origen sigue vigente y la entidad sigue en la
      // revisión propuesta.
      const t = now();
      const outcome = transaction(db, () => {
        const row = repo.get(first.brand_id, first.id);
        if (row.status !== 'pending') return { refused: decided(row) };
        if (row.expires_at <= t) {
          repo.move(row.brand_id, row.id, 'pending', 'expired', { at: t });
          return { refused: fail(409, 'La propuesta venció: pide una nueva.', { code: 'expired' }) };
        }
        if (!sourceActive(row)) {
          repo.move(row.brand_id, row.id, 'pending', 'withdrawn', { at: t, error: SOURCE_GONE });
          return { refused: fail(409, SOURCE_GONE, { code: 'source_inactive' }) };
        }
        const e = a ? repo.entity(row.brand_id, a.entity, row.entity_id) : null;
        if (!e || e.revision !== row.entity_revision) {
          const why = e ? 'Cambió desde que se propuso; pide una propuesta nueva.' : 'Ya no existe en esta marca.';
          repo.move(row.brand_id, row.id, 'pending', 'stale', { at: t, error: why });
          return { refused: fail(409, why, { code: 'stale_proposal' }) };
        }
        // Lo que hoy impide la acción (con los datos de la base) no se intenta: sigue pendiente y se dice por qué.
        const checked = snapshot(row.brand_id, row.action, row.entity_id, 'approve');
        if (checked?.problems.length)
          return {
            refused: fail(409, 'Todavía no se puede aprobar: ' + checked.problems[0], {
              code: 'not_ready',
              details: { problems: checked.problems },
            }),
          };
        // Lo que la revisión de la entidad no cubre (los avisos de uso de un retiro, que salen de otras tablas) se vuelve
        // a calcular aquí: si la persona dijo qué avisos vio y hoy hay uno que no vio, no se ejecuta y se le pide revisarla.
        if (a?.confirmWarnings && Array.isArray(seenWarnings)) {
          const fresh = (checked?.warnings ?? []).filter(w => !seenWarnings.includes(w));
          if (fresh.length)
            return {
              refused: fail(409, 'Cambiaron los avisos desde que la viste: revísala otra vez. ' + fresh[0], {
                code: 'warnings_changed',
                details: { warnings: checked.warnings },
              }),
            };
        }
        repo.move(row.brand_id, row.id, 'pending', 'approving', { at: t, userId: user.id, decided: true });
        return { row, entity: e };
      });
      if (outcome.refused) {
        emit(first.brand_id);
        throw outcome.refused;
      }
      const { row, entity } = outcome;
      try {
        // Una acción de varios pasos (aprobar una imagen cuya apertura cambió: guardarla y aprobarla) los hace en serie.
        // Si un paso posterior falla, lo anterior ya quedó (sigue en borrador) y la entidad cambió: queda obsoleta.
        const call = (name, method, path, input) => moduleCall(user, name, method, path, input);
        if (a.run)
          // Una acción de varios pasos que depende de lo que crea (dar de alta un curso): la acción misma los encadena.
          await a.run({
            call,
            entity,
            revision: row.entity_revision,
            read: repo.read,
            launch: uploads().launch,
            fail,
            failFlyerOnce,
          });
        else {
          const steps = a.steps ? a.steps(entity, row.entity_revision) : [a.request(entity, row.entity_revision)];
          for (const [name, method, path, input] of steps) await call(name, method, path, input);
        }
      } catch (error) {
        // Nada se aplicó (las rutas de los módulos hacen su cambio en una sola transacción). Si la entidad cambió entre
        // tanto, la propuesta queda obsoleta; si fue un permiso, la disponibilidad o un fallo interno, vuelve a quedar
        // pendiente (otra persona, o la misma más tarde, la puede aprobar); si el módulo rechazó la acción por su
        // contenido (un recorrido que dejó de ser válido, una promoción que choca), queda «no se pudo aplicar» con el
        // motivo: repetir el mismo clic daría lo mismo, y el asistente puede proponer otra vez cuando se corrija.
        const later = now();
        const e = repo.entity(row.brand_id, a.entity, row.entity_id);
        const status = error?.status;
        let to;
        if (!e || e.revision !== row.entity_revision) to = 'stale';
        else if (!status || status >= 500 || status === 403 || status === 404 || status === 429) to = 'pending';
        else to = 'failed';
        const why =
          to === 'stale'
            ? 'Cambió desde que se propuso; pide una propuesta nueva.'
            : status && status < 500
              ? String(error.message || '').slice(0, 300)
              : 'Ocurrió un error interno en el CRM.';
        transaction(db, () => {
          repo.move(row.brand_id, row.id, 'approving', to, {
            at: later,
            error: to === 'pending' ? null : why,
            // de vuelta a pendiente no queda nadie como quien decidió
            userId: to === 'pending' ? null : user.id,
            decided: true,
          });
        });
        if (to !== 'pending') audit(user, 'mcp.proposal.failed', row.id);
        emit(row.brand_id);
        if (!status) console.error('mcp-proposals', row.action, error);
        throw fail(status && status < 500 ? (to === 'pending' ? status : 409) : 500, why, {
          code: to === 'stale' ? 'stale_proposal' : to === 'failed' ? 'proposal_failed' : 'not_applied',
        });
      }
      transaction(db, () => {
        repo.move(row.brand_id, row.id, 'approving', 'approved', { at: now(), userId: user.id, decided: true });
      });
      audit(user, 'mcp.proposal.approve', row.id);
      emit(row.brand_id);
      return repo.get(row.brand_id, row.id);
    }

    function reject(user, id) {
      const row = locate(user, id);
      if (!canDecide(user, row)) throw fail(403, whyNot(row), { code: 'forbidden' });
      const moved = transaction(db, () =>
        repo.move(row.brand_id, row.id, 'pending', 'rejected', { at: now(), userId: user.id, decided: true }),
      );
      if (!moved) throw decided(repo.get(row.brand_id, row.id));
      audit(user, 'mcp.proposal.reject', row.id);
      emit(row.brand_id);
      return repo.get(row.brand_id, row.id);
    }

    async function overview(user, brand) {
      const mine = access.brandIds(user, 'inbox.view');
      if (brand && !mine.includes(brand)) throw fail(404, 'Marca no disponible.', { code: 'not_found' });
      const brandIds = brand ? [brand] : mine;
      refresh(repo.pending(brandIds));
      const pending = [];
      for (const row of repo.pending(brandIds))
        pending.push(cardView(row, user, await inspect(user, row.brand_id, row.action, row.entity_id)));
      return {
        brands: mine.map(id => ({ id, name: repo.brandName(id) })),
        limits: { pendingPerBrand: LIMITS.pendingPerBrand, expiresDays: LIMITS.expiresMs / DAY },
        pending,
        history: repo.history(brandIds, LIMITS.history).map(row => cardView(row, user, undefined)),
      };
    }

    async function handle(req, res, path, user, url) {
      // Sólo personas: una petición con llave o ficha (Authorization) o una del conector en el mismo proceso no entra,
      // aunque además trajera una cookie válida.
      if (req.headers?.authorization || fromConnector(req))
        throw fail(403, 'Las propuestas sólo las decide una persona desde el CRM.', { code: 'session_required' });
      host.requireStaff(user);
      if (req.method === 'GET' && path === '/api/mcp-proposals') {
        const brand = url?.searchParams.get('brand') || '';
        json(res, 200, await overview(user, brand && brand !== 'all' ? brand : null));
        return true;
      }
      const m = path.match(new RegExp(`^/api/mcp-proposals/${UUID}/(approve|reject)$`));
      if (m && req.method === 'POST') {
        // Lo que se aprueba es lo guardado, no lo que mande la página. Lo único que se lee son los avisos que vio la
        // persona (`warningsSeen`), para no aprobar un retiro con un aviso nuevo que no vio.
        const input = await body(req);
        const seen = Array.isArray(input?.warningsSeen)
          ? input.warningsSeen
              .filter(w => typeof w === 'string')
              .slice(0, 50)
              .map(w => w.slice(0, 1000))
          : null;
        host.rate('mcp-proposals.decide:' + user.id, LIMITS.decidePerMinute);
        const row = m[2] === 'approve' ? await approve(user, m[1], seen) : reject(user, m[1]);
        json(res, 200, { proposal: cardView(row, user, undefined) });
        return true;
      }
      return false;
    }

    // El conector entrega aquí su comprobación de origen (server/mcp.mjs, useModules).
    const useSourceCheck = fn => {
      if (typeof fn === 'function') sourceCheck = fn;
    };
    return { handle, propose, listFor, withdraw, sweep, purge, useSourceCheck, actions: ACTIONS };
  },
  timers: [{ name: 'vencer', everyMs: 60_000, testEveryMs: 1000, run: api => api.sweep() }],
};
