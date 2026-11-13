import { createHash } from 'node:crypto';
import { parseCsv } from './catalogue-import.mjs';

// Importación de conocimiento por lote (docs/PLAN_CONOCIMIENTO_POR_LOTE.md). Una consultora llena una hoja con sus preguntas
// frecuentes y sus respuestas; aquí se revisa fila por fila SIN escribir nada (vista previa) y, al confirmar, cada fila entra como
// BORRADOR por la misma ruta que una entrada escrita a mano (mismas reglas: sin precios, respuesta completa, curso de la marca,
// máximo por marca). Nada se usa para responder hasta que administración apruebe cada entrada. Sólo administración.
const fail = (status, message) => Object.assign(new Error(message), { status });
const MAX_ROWS = 300,
  MAX_BYTES = 1_000_000;
const norm = v =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
export const COLUMNS = ['marca', 'pregunta', 'respuesta', 'tema', 'curso', 'variantes'];
const TOPIC = {
  certificado: 'certificate',
  pagos: 'payment',
  pago: 'payment',
  requisitos: 'requirements',
  modalidad: 'modality',
  grabaciones: 'recording',
  grabacion: 'recording',
  duracion: 'duration',
  general: 'general',
};
const FILL = 'COMPLETAR';

// Plantilla: las respuestas que empiezan con COMPLETAR son una guía de qué escribir y se rechazan hasta que se reemplacen.
const q = (pregunta, tema, guia, variantes = '') => ['GlobalVet', pregunta, FILL + ': ' + guia, tema, '', variantes];
const cell = v => (/[",;\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
export const TEMPLATE_ROWS = [
  q(
    '¿Entregan certificado o constancia al terminar el curso?',
    'certificado',
    'qué documento reciben, quién lo emite, qué requisito de asistencia piden y cuándo lo entregan',
    'constancia;diploma;tiene validez',
  ),
  q(
    '¿Qué necesito para tomar el curso?',
    'requisitos',
    'equipo, conocimientos previos y todo lo que la persona debe tener listo',
    'requisitos;necesito saber algo antes',
  ),
  q('¿Se necesitan conocimientos previos?', 'requisitos', 'si es para principiantes o para quién está pensado'),
  q(
    '¿El curso es en línea o presencial?',
    'modalidad',
    'modalidad y plataforma donde se imparte',
    'modalidad;en linea;presencial',
  ),
  q(
    '¿Cómo y cuándo se imparten las sesiones?',
    'modalidad',
    'forma de las sesiones (en vivo, horario general) sin escribir fechas ni precios',
  ),
  q(
    '¿Quedan grabadas las sesiones?',
    'grabaciones',
    'si hay grabación, dónde se ve y por cuánto tiempo',
    'grabacion;si no puedo asistir',
  ),
  q(
    '¿Cuánto dura el curso?',
    'duracion',
    'duración total y número aproximado de sesiones',
    'cuantas horas;cuantas sesiones',
  ),
  q(
    '¿Qué formas de pago aceptan?',
    'pagos',
    'métodos aceptados, sin escribir importes (el precio sale del catálogo)',
    'formas de pago;tarjeta;transferencia;oxxo',
  ),
  q(
    '¿Puedo pagar en parcialidades o por sesión?',
    'pagos',
    'si existe pago por sesión o en partes y cómo funciona, sin importes',
  ),
  q('¿Cómo solicito factura?', 'pagos', 'qué datos piden, a quién se los mandan y en cuánto tiempo se entrega'),
  q('¿Qué pasa si no puedo asistir a una sesión?', 'general', 'política de inasistencias y reposición'),
  q(
    '¿Cuál es la política de cancelación y reembolso?',
    'general',
    'condiciones reales; si hay dudas, escribe que lo revisa una persona del equipo',
  ),
  q('¿Quién imparte el curso?', 'general', 'perfil general de los docentes, sin nombres que cambien por edición'),
  q('¿Cómo obtengo acceso a la plataforma?', 'general', 'cuándo y cómo reciben sus accesos después de inscribirse'),
];
export const TEMPLATE_CSV = [COLUMNS.join(','), ...TEMPLATE_ROWS.map(r => r.map(cell).join(','))].join('\n') + '\n';

export function createKnowledgeImport({ db, replies, crm, body, json, audit }) {
  const requireAdmin = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'Sólo administración importa conocimiento.');
  };
  const brands = () => db.prepare('SELECT id,name FROM brands').all();

  // Convierte cada fila en una entrada normalizada y detecta errores sin escribir nada.
  function analyse(csv, user) {
    if (typeof csv !== 'string' || !csv.trim()) throw fail(400, 'Pega o carga el contenido del archivo CSV.');
    if (Buffer.byteLength(csv) > MAX_BYTES) throw fail(413, 'El archivo supera 1 MB.');
    const table = parseCsv(csv);
    if (table.length < 2) throw fail(400, 'El archivo necesita encabezados y al menos una fila.');
    const header = table[0].cells.map(norm).map(h => h.replace(/\s/g, '_')),
      missing = ['marca', 'pregunta', 'respuesta'].filter(c => !header.includes(c));
    if (missing.length) throw fail(400, 'Faltan columnas obligatorias: ' + missing.join(', ') + '.');
    if (table.length - 1 > MAX_ROWS) throw fail(400, 'Máximo ' + MAX_ROWS + ' filas por archivo.');
    const all = brands(),
      rows = [],
      seen = new Map(),
      adding = new Map();
    for (const { line, cells } of table.slice(1)) {
      const get = name => {
          const i = header.indexOf(name);
          return i < 0 ? '' : String(cells[i] ?? '').trim();
        },
        errors = [];
      const brand = all.find(b => norm(b.id) === norm(get('marca')) || norm(b.name) === norm(get('marca')));
      if (!brand) errors.push('La marca «' + get('marca') + '» no existe.');
      else
        try {
          crm.requireBrand(user, brand.id);
        } catch {
          errors.push('Sin acceso a la marca ' + brand.name + '.');
        }
      const answer = get('respuesta'),
        question = get('pregunta');
      if (answer.toUpperCase().startsWith(FILL))
        errors.push('Falta completar la respuesta: reemplaza el texto que empieza con COMPLETAR.');
      let course = null;
      if (brand && get('curso')) {
        course = db
          .prepare('SELECT id,title FROM courses WHERE brand_id=? AND active=1')
          .all(brand.id)
          .find(c => norm(c.title) === norm(get('curso')));
        if (!course)
          errors.push(
            'El curso «' + get('curso') + '» no existe en ' + brand.name + '. Déjalo vacío para que aplique a todos.',
          );
      }
      const topic = TOPIC[norm(get('tema'))] || (get('tema') ? null : 'general');
      if (topic === null)
        errors.push(
          'Tema «' +
            get('tema') +
            '» no reconocido: usa certificado, pagos, requisitos, modalidad, grabaciones, duracion o general.',
        );
      const variants = get('variantes')
        .split(/\n|;/)
        .map(v => v.trim())
        .filter(Boolean);
      let entry = null;
      if (brand && !errors.length) {
        try {
          entry = replies.normalizeEntry({ topic, question, answer, variants, courseId: course?.id || '' }, brand.id);
        } catch (e) {
          errors.push(e.message);
        }
      }
      let action = null;
      if (brand && !errors.length) {
        const key = brand.id + '|' + (course?.id || '') + '|' + norm(question);
        if (seen.has(key)) errors.push('Repite la pregunta de la fila ' + seen.get(key) + '.');
        else {
          seen.set(key, line);
          const exists = db
            .prepare(
              "SELECT question FROM knowledge_entries WHERE brand_id=? AND status!='archived' AND COALESCE(course_id,'')=?",
            )
            .all(brand.id, course?.id || '')
            .some(e => norm(e.question) === norm(question));
          action = exists ? 'existente' : 'crear';
          if (action === 'crear') {
            const n = (adding.get(brand.id) || 0) + 1;
            adding.set(brand.id, n);
            const have = db
              .prepare("SELECT count(*) n FROM knowledge_entries WHERE brand_id=? AND status!='archived'")
              .get(brand.id).n;
            if (have + n > 300) {
              errors.push('La marca llegaría al máximo de 300 entradas.');
              action = null;
            }
          }
        }
      }
      rows.push({
        line,
        errors,
        brandId: brand?.id || null,
        brandName: brand?.name || get('marca'),
        courseId: course?.id || null,
        courseTitle: course?.title || null,
        topic: topic || 'general',
        question,
        answer,
        variants,
        action,
        entry,
      });
    }
    return { rows, fileHash: createHash('sha256').update(csv).digest('hex') };
  }
  const valid = a => a.rows.filter(r => !r.errors.length);
  const summary = a => ({
    rows: a.rows.length,
    valid: valid(a).length,
    withErrors: a.rows.filter(r => r.errors.length).length,
    toCreate: valid(a).filter(r => r.action === 'crear').length,
    existing: valid(a).filter(r => r.action === 'existente').length,
  });
  const publicRows = a =>
    a.rows.map(r => ({
      line: r.line,
      brand: r.brandName,
      course: r.courseTitle,
      topic: r.topic,
      question: r.question,
      answer: r.answer.slice(0, 160),
      action: r.action,
      errors: r.errors,
    }));

  function apply(user, analysis) {
    const results = [];
    for (const r of analysis.rows) {
      const out = { line: r.line, id: null, action: r.action, error: null };
      if (r.errors.length) {
        out.error = r.errors[0];
        results.push(out);
        continue;
      }
      if (r.action === 'existente') {
        results.push(out);
        continue;
      }
      try {
        const e = replies.createEntry(user, {
          brandId: r.brandId,
          topic: r.entry.topic,
          question: r.entry.question,
          answer: r.entry.answer,
          variants: r.entry.variants,
          courseId: r.entry.courseId,
        });
        out.id = e.id;
        out.action = 'creada';
      } catch (e) {
        out.error = e.message;
      }
      results.push(out);
    }
    return results;
  }

  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/knowledge-import')) return false;
    requireAdmin(user);
    if (path === '/api/knowledge-import/template' && req.method === 'GET') {
      json(res, 200, { csv: TEMPLATE_CSV, columns: COLUMNS });
      return true;
    }
    if (req.method !== 'POST' || !['/api/knowledge-import/preview', '/api/knowledge-import/apply'].includes(path))
      throw fail(404, 'Ruta de importación no encontrada.');
    const input = await body(req),
      analysis = analyse(input.csv, user);
    if (path.endsWith('/preview')) {
      json(res, 200, { fileHash: analysis.fileHash, summary: summary(analysis), rows: publicRows(analysis) });
      return true;
    }
    if (input.fileHash !== analysis.fileHash)
      throw fail(409, 'El archivo cambió desde la vista previa. Vuelve a previsualizar.');
    if (!valid(analysis).some(r => r.action === 'crear'))
      throw fail(400, 'No hay filas nuevas y válidas para importar.');
    const results = apply(user, analysis);
    audit(user, 'knowledge.import', analysis.fileHash.slice(0, 16));
    json(res, 200, {
      fileHash: analysis.fileHash,
      created: results.filter(r => r.id).length,
      existing: results.filter(r => !r.error && !r.id).length,
      failed: results.filter(r => r.error).length,
      results,
    });
    return true;
  }
  return { handle, analyse, summary };
}
