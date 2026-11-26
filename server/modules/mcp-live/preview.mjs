// «Lo que dejó el asistente», para la tarjeta de «Asistente en vivo» (docs/PLAN_ASISTENTE_EN_VIVO.md).
// Se lee la entidad REAL de la base, por su tipo y su id, siempre dentro de la marca; nunca lo que el asistente escribió
// en su conversación (la actividad no lo guarda). Todo sale como texto plano y la pantalla lo escapa: los textos de un
// recorrido, una respuesta o un mensaje pudo escribirlos el asistente.
//
// Reutiliza las lecturas y las vistas previas de las propuestas (server/modules/mcp-proposals): los pasos de un
// recorrido, de una secuencia y lo que hace una regla se describen igual que en «Propuestas del asistente».
import { createRepo as proposalsRepo } from '../mcp-proposals/repo.mjs';
import { flowSends, plain, ruleSends, sequenceSends } from '../mcp-proposals/preview.mjs';
import { ENTITY_LABELS } from '../../lib/mcp-activity-labels.mjs';
import { NODE_TYPES, portsOf } from '../../../public/kit/shared/flow-model.js';

// El recorrido como diagrama para la pantalla: pasos con su tipo, título y un texto corto, y las conexiones con el
// nombre de su salida; en el orden en que se alcanzan desde el Inicio. Sólo texto plano (la pantalla lo escapa).
const DIAGRAM_MAX = 60;
export function flowDiagram(graphRaw) {
  const graph = parse(graphRaw, {});
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter(n => n && typeof n.id === 'string') : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.filter(e => e && typeof e.from === 'string') : [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const start = typeof graph.start === 'string' ? graph.start : nodes.find(n => n.type === 'start')?.id;
  // profundidad desde el Inicio (columna del diagrama), sin repetir
  const depth = new Map();
  const queue = start && byId.has(start) ? [[start, 0]] : [];
  while (queue.length && depth.size < DIAGRAM_MAX) {
    const [id, d] = queue.shift();
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const e of edges) if (e.from === id && byId.has(e.to) && !depth.has(e.to)) queue.push([e.to, d + 1]);
  }
  const short = n => {
    const d = n.data && typeof n.data === 'object' ? n.data : {};
    const part = Array.isArray(d.parts) ? d.parts.find(x => x && typeof x.text === 'string')?.text : '';
    return plain(d.text || part || d.question || '', 90);
  };
  const out = [...depth.entries()].map(([id, d]) => {
    const n = byId.get(id);
    return {
      id,
      depth: d,
      type: String(n.type || ''),
      label: NODE_TYPES[n.type]?.label || String(n.type || 'Paso'),
      title: plain(n.title, 60),
      text: n.type === 'start' ? '' : short(n),
    };
  });
  const ports = id => {
    try {
      return portsOf(byId.get(id));
    } catch {
      return [];
    }
  };
  const links = edges
    .filter(e => depth.has(e.from) && depth.has(e.to))
    .map(e => ({
      from: e.from,
      to: e.to,
      label: plain(ports(e.from).find(x => x.id === e.port)?.label || '', 30),
    }));
  return { start: start ?? null, nodes: out, edges: links, truncated: depth.size >= DIAGRAM_MAX };
}

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const FILE = /^[a-f0-9-]{36}$/;
const LONG = 1200;

const money = (cents, currency) => {
  if (cents === null || cents === undefined) return 'Sin precio';
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(cents / 100);
  } catch {
    return String(cents / 100);
  }
};
const when = (t, zone) => {
  if (t === null || t === undefined) return 'Sin fecha';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: zone || undefined,
    }).format(t);
  } catch {
    return new Date(t).toISOString();
  }
};
const MODALITY = { online: 'En línea', in_person: 'Presencial', hybrid: 'Híbrido' };
const parse = (raw, fallback) => {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};
// Pantalla donde se abre cada tipo (ids de vista que entiende ctx.go). «Catálogo» es la vista de siempre.
const SCREENS = Object.freeze({
  knowledge: { view: 'courses', label: 'Catálogo' },
  edition: { view: 'courses', label: 'Catálogo' },
  course: { view: 'courses', label: 'Catálogo' },
  promotion: { view: 'courses', label: 'Catálogo' },
  content: { view: 'courses', label: 'Catálogo' },
  flyer: { view: 'courses', label: 'Catálogo' },
  flow: { view: 'automatizacion', label: 'Automatización' },
  sequence: { view: 'secuencias', label: 'Secuencias' },
  rule: { view: 'reglas', label: 'Reglas' },
  access: { view: 'accesos', label: 'Accesos' },
  wa_template: { view: 'plantillas', label: 'Plantillas' },
  broadcast: { view: 'difusiones', label: 'Difusiones' },
  segment: { view: 'audiencias', label: 'Audiencias' },
  course_draft: { view: 'propuestas', label: 'Propuestas del asistente' },
  proposal: { view: 'propuestas', label: 'Propuestas del asistente' },
});
const STATUS = Object.freeze({
  draft: 'Borrador',
  published: 'Publicada',
  active: 'Activo',
  paused: 'En pausa',
  archived: 'Archivado',
  approved: 'Aprobada',
  pending: 'Pendiente',
  rejected: 'Rechazada',
  created: 'Ya dado de alta',
  discarded: 'Descartado',
  scheduled: 'Programada',
  sending: 'Enviándose',
  finished: 'Terminada',
  cancelled: 'Cancelada',
});
const status = v => STATUS[v] || (v ? String(v) : 'Sin estado');
const line = (label, value) => ({ label, value: plain(value, LONG) });

export function createPreview(db) {
  const repo = proposalsRepo(db);
  const one = (sql, ...a) => db.prepare(sql).get(...a) ?? null;
  const image = fileId => (typeof fileId === 'string' && FILE.test(fileId) ? '/api/library/files/' + fileId : null);

  // Cada lector devuelve { title, status, lines, sends?, image? } o null si no existe en la marca.
  const READERS = {
    knowledge(b, id) {
      const k = one(
        'SELECT e.*,c.title course FROM knowledge_entries e LEFT JOIN courses c ON c.id=e.course_id WHERE e.id=? AND e.brand_id=?',
        id,
        b,
      );
      if (!k) return null;
      const variants = parse(k.variants, []);
      return {
        title: k.question,
        status: status(k.status),
        lines: [
          line('Pregunta', k.question),
          line('Variantes', Array.isArray(variants) ? variants.join(' · ') : ''),
          line('Respuesta', k.answer),
          line('Tema', k.topic),
          line('Curso', k.course || 'Toda la marca'),
        ],
      };
    },
    flow(b, id) {
      const f = repo.entity(b, 'chatflow', id);
      return (
        f && {
          title: f.name,
          status: status(f.status),
          lines: [],
          sends: flowSends(f.draft, repo.names(b)),
          diagram: flowDiagram(f.draft),
        }
      );
    },
    sequence(b, id) {
      const s = repo.entity(b, 'sequence', id);
      return (
        s && {
          title: s.name,
          status: s.archived_at ? 'Archivada' : s.enabled ? 'Encendida' : 'Apagada',
          lines: [],
          sends: sequenceSends(s.steps, repo.names(b)),
        }
      );
    },
    rule(b, id) {
      const r = repo.entity(b, 'rule', id);
      return r && { title: r.name, status: status(r.status), lines: [], sends: ruleSends(r.definition, repo.names(b)) };
    },
    access(b, id) {
      const a = repo.entity(b, 'course_access', id);
      return (
        a && {
          title: `${a.course_title} · ${a.edition_name}`,
          status: a.enabled ? 'Entrega encendida' : 'Entrega apagada',
          lines: [
            line('Mensaje de accesos', a.body || 'Sin mensaje todavía'),
            line('Enlace del grupo', a.group_url || 'Sin enlace'),
          ],
        }
      );
    },
    edition(b, id) {
      const e = repo.entity(b, 'edition', id);
      return (
        e && {
          title: `${e.course_title} · ${e.name}`,
          status: status(e.status),
          lines: [
            line('Inicio', when(e.starts_at, e.timezone)),
            line('Precio', money(e.price_cents, e.currency)),
            line('Docente', e.instructor || 'Sin docente'),
            line('Modalidad', MODALITY[e.modality] || e.modality),
            line('Lugar', e.location || 'Sin lugar'),
            line('Cupo', e.capacity ?? 'Sin tope'),
          ],
        }
      );
    },
    course(b, id) {
      const c = one('SELECT * FROM courses WHERE id=? AND brand_id=?', id, b);
      return (
        c && {
          title: c.title,
          status: c.active ? 'Activo' : 'Archivado',
          lines: [line('Temario', c.syllabus || 'Sin temario'), line('Bienvenida', c.welcome || 'Sin bienvenida')],
        }
      );
    },
    promotion(b, id) {
      const p = repo.entity(b, 'promotion', id);
      return (
        p && {
          title: p.name,
          status: status(p.status),
          lines: [
            line('Apertura', `${p.course_title} · ${p.edition_name}`),
            line('Precio con promoción', money(p.price_cents, p.currency)),
            line('Desde', when(p.starts_at, p.timezone)),
            line('Hasta', when(p.ends_at, p.timezone)),
          ],
        }
      );
    },
    content(b, id) {
      const t = repo.entity(b, 'content_template', id);
      return (
        t && { title: t.name, status: status(t.status), lines: [line('Escenario', t.scenario), line('Texto', t.body)] }
      );
    },
    wa_template(b, id) {
      const t = one('SELECT name,category,language,status,body FROM wa_templates WHERE id=? AND brand_id=?', id, b);
      return (
        t && {
          title: t.name,
          status: status(t.status),
          lines: [line('Categoría', t.category), line('Idioma', t.language), line('Cuerpo', t.body)],
        }
      );
    },
    broadcast(b, id) {
      const c = one(
        'SELECT title,kind,status,audience_size,scheduled_at,timezone FROM campaigns WHERE id=? AND brand_id=?',
        id,
        b,
      );
      return (
        c && {
          title: c.title,
          status: status(c.status),
          lines: [
            line('Tipo', c.kind),
            line('Personas', c.audience_size ?? 'Sin contar'),
            line('Programada para', c.scheduled_at ? when(c.scheduled_at, c.timezone) : 'Sin programar'),
          ],
        }
      );
    },
    segment(b, id) {
      const a = one('SELECT name,kind,description,member_count,status FROM audiences WHERE id=? AND brand_id=?', id, b);
      return (
        a && {
          title: a.name,
          status: status(a.status),
          lines: [
            line('Tipo', a.kind),
            line('Descripción', a.description || 'Sin descripción'),
            line('Personas', a.member_count ?? 'Sin contar'),
          ],
        }
      );
    },
    course_draft(b, id) {
      const d = repo.entity(b, 'course_draft', id);
      return (
        d && {
          title: d.title,
          status: status(d.status),
          image: image(d.file_id),
          lines: [
            line('Apertura', d.edition_name || 'Sin nombre'),
            line('Inicio', when(d.starts_at, d.timezone)),
            line('Precio', money(d.price_cents, d.currency)),
            line('Docente', d.instructor || 'Sin docente'),
            line('Modalidad', MODALITY[d.modality] || d.modality),
            line('Temario', d.syllabus || 'Sin temario'),
          ],
        }
      );
    },
    flyer(b, id) {
      const f = repo.entity(b, 'flyer', id);
      return (
        f && {
          title: f.title,
          status: status(f.status),
          image: image(f.file_id),
          lines: [line('Apertura', `${f.course_title} · ${f.edition_name}`), line('Canal', f.channel || 'Todos')],
        }
      );
    },
    upload: () => ({
      title: 'Dirección de subida de una imagen',
      status: 'De un solo uso',
      lines: [
        line(
          'Qué es',
          'Una dirección temporal para subir la imagen de un curso. No es un archivo: vence a los 10 minutos.',
        ),
      ],
    }),
  };

  // { type, label, title, status, lines, sends, image, screen } o null si no existe (o el tipo no se previsualiza).
  function preview(brandId, type, id) {
    if (!Object.hasOwn(READERS, type) || typeof id !== 'string' || !ID.test(id)) return null;
    const read = READERS[type](brandId, id);
    if (!read) return null;
    return {
      type,
      label: ENTITY_LABELS[type] || type,
      title: plain(read.title, 160) || 'Sin nombre',
      status: read.status,
      lines: read.lines.filter(l => l.value),
      sends: read.sends ?? null,
      image: read.image ?? null,
      diagram: read.diagram ?? null,
      screen: SCREENS[type] ?? null,
    };
  }
  return { preview, screens: SCREENS };
}
