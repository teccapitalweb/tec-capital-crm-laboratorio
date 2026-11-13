import { transaction } from './database.mjs';

// Flujo de bienvenida por marca (docs/PLAN_FLUJO_BIENVENIDA.md). Un recorrido guiado con botones que la marca arma sin código:
// cada paso es un mensaje con hasta tres botones; un botón lleva a otro paso o pide algo que el asistente ya sabe hacer
// (precio, temario, fechas, inscribirse, pasar con una persona). No sustituye al motor de respuestas: sólo decide el saludo y el menú.
// Si la persona escribe otra cosa, contesta el motor de siempre (reglas → conocimiento → IA). Apagado por omisión.
const fail = (status, message) => Object.assign(new Error(message), { status });
export const ACTIONS = {
  price: 'Enviar el precio vigente',
  syllabus: 'Enviar el temario',
  schedule: 'Enviar fechas y horario',
  enroll: 'Inscribirse',
  human: 'Pasar con una persona',
};
export const DEFAULT_STEPS = [
  {
    id: 'inicio',
    text: '¡Hola, {{nombre}}! Soy el asistente de {{marca}}. ¿Qué te gustaría saber de {{curso}}?',
    buttons: [
      { label: 'Precio', go: 'action:price' },
      { label: 'Temario', go: 'action:syllabus' },
      { label: 'Más opciones', go: 'step:mas' },
    ],
  },
  {
    id: 'mas',
    text: 'Claro. ¿Con qué te ayudo?',
    buttons: [
      { label: 'Fechas y horario', go: 'action:schedule' },
      { label: 'Inscribirme', go: 'action:enroll' },
      { label: 'Hablar con asesor', go: 'action:human' },
    ],
  },
];
export const LIMITS = { steps: 10, buttons: 3, label: 20, text: 900 };
const RUN_TTL = 24 * 3600000,
  MAX_MISSES = 2;
// Compara lo que escribió la persona con el texto de un botón sin importar mayúsculas, acentos ni signos.
export const norm = v =>
  String(v || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// Datos por su nombre. Sin nombre, «¡Hola, {{nombre}}!» queda «¡Hola!» en lugar de dejar una coma suelta.
export function render(text, { name = '', course = '', edition = '', brand = '' } = {}) {
  return String(text || '')
    .replace(/(,\s*)?\{\{\s*nombre\s*\}\}/gi, (m, pre) => (name ? (pre || '') + name : ''))
    .replace(/\{\{\s*curso\s*\}\}/gi, course)
    .replace(/\{\{\s*edici[oó]n\s*\}\}/gi, edition || course)
    .replace(/\{\{\s*marca\s*\}\}/gi, brand)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
// Deja los pasos en su forma canónica o explica, en palabras de quien los arma, qué hay que corregir.
export function cleanSteps(input) {
  if (!Array.isArray(input) || !input.length) throw fail(400, 'El flujo necesita al menos un paso.');
  if (input.length > LIMITS.steps) throw fail(400, 'El flujo admite hasta ' + LIMITS.steps + ' pasos.');
  const ids = new Set(),
    steps = input.map((s, i) => {
      const id = String(s?.id || '').trim(),
        text =
          typeof s?.text === 'string' ? s.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim() : '';
      if (!/^[a-z0-9]{1,16}$/.test(id) || ids.has(id))
        throw fail(400, 'El paso ' + (i + 1) + ' no tiene un identificador válido.');
      ids.add(id);
      if (!text) throw fail(400, 'Escribe el mensaje del paso ' + (i + 1) + '.');
      if (text.length > LIMITS.text)
        throw fail(
          400,
          'El mensaje del paso ' + (i + 1) + ' es demasiado largo (máximo ' + LIMITS.text + ' caracteres).',
        );
      if (/\{\{(?!\s*(nombre|curso|edici[oó]n|marca)\s*\}\})/i.test(text))
        throw fail(
          400,
          'El paso ' +
            (i + 1) +
            ' usa un dato que no existe. Disponibles: {{nombre}}, {{curso}}, {{edicion}} y {{marca}}.',
        );
      const list = Array.isArray(s?.buttons) ? s.buttons : [];
      if (list.length > LIMITS.buttons)
        throw fail(400, 'Cada paso admite hasta ' + LIMITS.buttons + ' botones (es el límite de WhatsApp).');
      const seen = new Set(),
        buttons = list.map(b => {
          const label = String(b?.label || '')
              .replace(/\s+/g, ' ')
              .trim(),
            go = String(b?.go || '');
          if (!label) throw fail(400, 'Hay un botón sin texto en el paso ' + (i + 1) + '.');
          if (label.length > LIMITS.label)
            throw fail(
              400,
              'El botón «' +
                label +
                '» es demasiado largo: máximo ' +
                LIMITS.label +
                ' caracteres (límite de WhatsApp).',
            );
          if (!norm(label)) throw fail(400, 'El botón «' + label + '» necesita al menos una letra o un número.');
          if (seen.has(norm(label))) throw fail(400, 'El paso ' + (i + 1) + ' tiene dos botones con el mismo texto.');
          seen.add(norm(label));
          return { label, go };
        });
      return { id, text, buttons };
    });
  for (const [i, s] of steps.entries())
    for (const b of s.buttons) {
      const x = b.go.match(/^(step|action):([a-z0-9]+)$/);
      if (!x || (x[1] === 'action' && !ACTIONS[x[2]]) || (x[1] === 'step' && !ids.has(x[2])))
        throw fail(400, 'Elige a dónde lleva el botón «' + b.label + '» del paso ' + (i + 1) + '.');
    }
  return steps;
}

export function createFlows({ db, crm, body, json, audit, broadcast = () => {}, now = Date.now }) {
  const requireAdmin = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || u.role !== 'admin')
      throw fail(403, 'El flujo de bienvenida lo configura un administrador.');
  };
  const row = brandId => db.prepare('SELECT * FROM welcome_flows WHERE brand_id=?').get(brandId);
  const parse = r => {
    try {
      return cleanSteps(JSON.parse(r.steps));
    } catch {
      return null;
    }
  };
  const view = b => {
    const r = row(b.id),
      steps = r ? parse(r) : null;
    return {
      brandId: b.id,
      brandName: b.name,
      enabled: Boolean(r?.enabled && steps),
      withFlyer: r ? Boolean(r.with_flyer) : true,
      steps: steps || DEFAULT_STEPS,
      revision: r?.revision || 0,
      isDefault: !steps,
      updatedAt: r?.updated_at || null,
    };
  };
  // Lo que usa el motor de respuestas: el flujo encendido de la marca, o null.
  function active(brandId) {
    const r = row(brandId);
    if (!r?.enabled) return null;
    const steps = parse(r);
    return steps ? { steps, withFlyer: Boolean(r.with_flyer) } : null;
  }
  // ¿La persona pulsó (o escribió) un botón del paso en el que está? Sólo dentro de las 24 h siguientes al último paso.
  function pressed(flow, conversationId, text) {
    const run = db
      .prepare('SELECT step_id,updated_at FROM flow_runs WHERE conversation_id=?')
      .get(String(conversationId));
    if (!run || now() - run.updated_at > RUN_TTL) return null;
    const step = flow.steps.find(s => s.id === run.step_id);
    if (!step) return null;
    const key = norm(text);
    if (!key) return null;
    const button = step.buttons.find(b => norm(b.label) === key);
    if (!button) return null;
    const [kind, target] = button.go.split(':');
    if (kind === 'step') {
      const next = flow.steps.find(s => s.id === target);
      return next ? { kind: 'step', label: button.label, from: step, step: next } : null;
    }
    return { kind: 'action', label: button.label, from: step, step, target };
  }
  // Dentro de la transacción del llamador (commit del motor): en qué paso quedó la conversación, o que el flujo terminó.
  function apply(conversationId, state) {
    if (!state) return;
    if (state.end) {
      db.prepare('DELETE FROM flow_runs WHERE conversation_id=?').run(conversationId);
      return;
    }
    // La persona escribió otra cosa: el menú sigue valiendo una vez más; a la segunda, el recorrido termina. Así un «sí» o un «hola»
    // escrito mucho después de haber dejado el menú no se confunde con un botón.
    if (state.miss) {
      db.prepare('UPDATE flow_runs SET misses=misses+1 WHERE conversation_id=?').run(conversationId);
      db.prepare('DELETE FROM flow_runs WHERE conversation_id=? AND misses>=?').run(conversationId, MAX_MISSES);
      return;
    }
    db.prepare(
      'INSERT INTO flow_runs(conversation_id,step_id,misses,updated_at) VALUES(?,?,0,?) ON CONFLICT(conversation_id) DO UPDATE SET step_id=excluded.step_id,misses=0,updated_at=excluded.updated_at',
    ).run(conversationId, state.step, now());
  }
  const running = conversationId =>
    Boolean(db.prepare('SELECT 1 FROM flow_runs WHERE conversation_id=?').get(String(conversationId)));
  function save(brandId, input, user) {
    requireAdmin(user);
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(404, 'Marca no encontrada.');
    if (!input || typeof input !== 'object') throw fail(400, 'Faltan los datos del flujo.');
    const current = row(brandId),
      steps = cleanSteps(input.steps),
      t = now();
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== (current?.revision || 0))
      throw fail(409, 'El flujo cambió en otra ventana. Recarga la pantalla.');
    const enabled = input.enabled ? 1 : 0,
      flyer = input.withFlyer === false ? 0 : 1;
    transaction(db, () => {
      db.prepare(
        'INSERT INTO welcome_flows(brand_id,enabled,with_flyer,steps,revision,updated_by,updated_at) VALUES(?,?,?,?,1,?,?) ON CONFLICT(brand_id) DO UPDATE SET enabled=excluded.enabled,with_flyer=excluded.with_flyer,steps=excluded.steps,revision=welcome_flows.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at',
      ).run(brandId, enabled, flyer, JSON.stringify(steps), user.id, t);
      // quien iba a media conversación en un paso que ya no existe vuelve a empezar: su siguiente mensaje lo atiende el motor de siempre
      db.prepare('DELETE FROM flow_runs WHERE conversation_id IN (SELECT id FROM conversations WHERE brand_id=?)').run(
        brandId,
      );
    });
    audit(user, 'flow.saved', brandId);
    broadcast('crm', null, { brandId });
    return view(db.prepare('SELECT id,name FROM brands WHERE id=?').get(brandId));
  }
  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/flows')) return false;
    let x;
    if (user.role === 'customer') throw fail(403, 'Esta información es para el equipo de atención.');
    if (path === '/api/flows' && req.method === 'GET') {
      json(res, 200, { flows: crm.brandsFor(user).map(view), actions: ACTIONS, limits: LIMITS });
      return true;
    }
    if ((x = path.match(/^\/api\/flows\/([a-zA-Z0-9-]+)$/)) && req.method === 'PUT') {
      json(res, 200, { flow: save(x[1], await body(req), user) });
      return true;
    }
    throw fail(404, 'Ruta de flujos no encontrada.');
  }
  return { handle, active, pressed, apply, running, render, view };
}
