import { tokens, stem } from './ai-provider.mjs';

// Selección del conocimiento que recibe la IA (docs/PLAN_MEMORIA_CONTEXTO.md). Antes se mandaba TODO el conocimiento aprobado en
// cada llamada: con 6 entradas es barato, con 300 por marca sería caro, lento y confuso. Aquí se ordenan las entradas por
// relevancia con BM25 (ponderando pregunta y variantes más que la respuesta), se amplían los términos con familias de sinónimos del
// negocio de cursos (certificado ~ constancia ~ diploma, grabación ~ repetición…) y se entregan sólo las más relevantes, dentro de
// un presupuesto de caracteres. Sin servicios externos, sin costo y determinista: se puede probar y explicar por qué salió cada entrada.
const FAMILIES = [
  [
    'certificado',
    'certificados',
    'certificacion',
    'constancia',
    'constancias',
    'diploma',
    'diplomas',
    'acreditar',
    'acredite',
    'acreditacion',
    'aval',
    'validez',
    'reconocimiento',
    'papel',
    'titulo',
  ],
  [
    'grabacion',
    'grabaciones',
    'grabado',
    'grabada',
    'grabar',
    'grabadas',
    'repeticion',
    'repasar',
    'repaso',
    'conectarme',
    'conectar',
    'asistir',
    'asistencia',
    'faltar',
    'falto',
    'faltas',
    'perder',
    'perdi',
    'ausentar',
  ],
  [
    'pago',
    'pagos',
    'pagar',
    'pague',
    'transferencia',
    'tarjeta',
    'oxxo',
    'deposito',
    'spei',
    'comprobante',
    'factura',
    'facturas',
    'fiscal',
    'parcialidades',
    'mensualidades',
    'cobro',
  ],
  [
    'requisito',
    'requisitos',
    'necesito',
    'necesita',
    'equipo',
    'computadora',
    'laptop',
    'celular',
    'telefono',
    'conocimientos',
    'previos',
    'material',
    'materiales',
  ],
  ['modalidad', 'linea', 'online', 'presencial', 'virtual', 'zoom', 'meet', 'plataforma', 'vivo', 'remoto'],
  ['dura', 'duracion', 'horas', 'sesiones', 'sesion', 'semanas', 'semana', 'tiempo', 'meses'],
  ['cancelar', 'cancelacion', 'reembolso', 'reembolsos', 'devolucion', 'devolver', 'baja', 'arrepiento'],
  ['docente', 'docentes', 'maestro', 'profesor', 'instructor', 'imparte', 'experto', 'expertos'],
  ['acceso', 'accesos', 'usuario', 'contrasena', 'enlace', 'link', 'entrar', 'ingresar', 'cuenta'],
  ['beca', 'becas', 'descuento', 'descuentos', 'promocion', 'oferta', 'convenio', 'estudiante', 'estudiantes'],
  ['grupo', 'grupos', 'alumnos', 'alumno', 'cupo', 'lugares', 'companeros'],
  ['horario', 'horarios', 'hora', 'dia', 'dias', 'fecha', 'fechas', 'calendario', 'empieza', 'inicia', 'inicio'],
];
const FAMILY_OF = new Map(); // raíz -> índices de familia
FAMILIES.forEach((fam, i) =>
  fam.forEach(w => {
    const s = stem(w);
    if (!FAMILY_OF.has(s)) FAMILY_OF.set(s, new Set());
    FAMILY_OF.get(s).add(i);
  }),
);
const FAMILY_STEMS = FAMILIES.map(f => f.map(stem));

const K1 = 1.2,
  B = 0.75,
  W = { question: 3, topic: 2, answer: 1 };

// Términos de un documento con peso (la pregunta y sus variantes pesan más que la respuesta).
function docTerms(e) {
  const tf = new Map();
  let len = 0;
  const add = (text, w) => {
    for (const t of tokens(text).map(stem)) {
      tf.set(t, (tf.get(t) || 0) + w);
      len += w;
    }
  };
  add([e.question, ...(e.variants || [])].join(' '), W.question);
  add(e.topic || '', W.topic);
  add(e.answer || '', W.answer);
  return { tf, len };
}

// Rankea las entradas para una consulta (el mensaje actual y, si hace falta, los últimos del cliente).
// Devuelve las más relevantes con su puntuación; entradas.length ≤ k y dentro de maxChars.
export function rankKnowledge(query, entries, { k = 6, maxChars = 6000, hintTopic = null, extraQuery = '' } = {}) {
  const all = entries || [];
  if (all.length <= k) {
    const sel = trim(
      all.map((e, i) => ({ entry: e, score: all.length - i })),
      maxChars,
    );
    return {
      selected: sel.items,
      considered: all.length,
      sent: sel.items.length,
      truncated: sel.truncated,
      mode: 'todo',
    };
  }
  const docs = all.map(docTerms),
    N = docs.length,
    avg = docs.reduce((a, d) => a + d.len, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  // términos de la consulta: los del mensaje (peso 1) y los del contexto reciente (peso .5), más su familia de sinónimos (peso .6)
  const q = new Map();
  const addQ = (text, w) => {
    for (const t of tokens(text).map(stem)) {
      q.set(t, Math.max(q.get(t) || 0, w));
      for (const fi of FAMILY_OF.get(t) || [])
        for (const f of FAMILY_STEMS[fi]) if (f !== t) q.set(f, Math.max(q.get(f) || 0, w * 0.6));
    }
  };
  addQ(extraQuery, 0.5);
  addQ(query, 1);
  const vocab = [...df.keys()];
  const scores = docs.map(d => {
    let s = 0;
    for (const [term, w] of q) {
      // coincidencia exacta de raíz o por prefijo (plurales y conjugaciones), con menos peso si no es exacta
      const matches = d.tf.has(term)
        ? [[term, 1]]
        : term.length >= 5
          ? vocab
              .filter(v => v.length >= 5 && (v.startsWith(term) || term.startsWith(v)) && d.tf.has(v))
              .map(v => [v, 0.8])
          : [];
      for (const [t, m] of matches) {
        const n = df.get(t) || 0,
          idf = Math.log(1 + (N - n + 0.5) / (n + 0.5)),
          f = d.tf.get(t);
        s += (w * m * idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * d.len) / avg));
      }
    }
    return s;
  });
  let ranked = all
    .map((entry, i) => ({ entry, score: Math.round(scores[i] * 1000) / 1000 }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score || 0;
  ranked = ranked.filter(x => x.score >= top * 0.25).slice(0, k);
  // la entrada del tema que ya detectó el motor de reglas siempre entra (aunque las palabras no coincidan)
  if (hintTopic && !ranked.some(x => x.entry.topic === hintTopic)) {
    const h = all.find(e => e.topic === hintTopic);
    if (h && ranked.length < k + 1) ranked.push({ entry: h, score: 0 });
  }
  const sel = trim(ranked, maxChars);
  return { selected: sel.items, considered: N, sent: sel.items.length, truncated: sel.truncated, mode: 'relevantes' };
}

function trim(items, maxChars) {
  let used = 0,
    truncated = false;
  const out = [];
  for (const x of items) {
    const size = (x.entry.question || '').length + (x.entry.answer || '').length + 40;
    if (out.length && used + size > maxChars) {
      truncated = true;
      continue;
    }
    used += size;
    out.push(x);
  }
  return { items: out, truncated };
}
