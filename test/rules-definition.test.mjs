// Reglas por mensaje, la parte pura (docs/PLAN_REGLAS.md): forma de la definición, palabras clave en sus cuatro modos,
// condiciones con la gramática común, orden de la lista, «no seguir», «una vez» y descanso, y los textos con datos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDefinition,
  ordered,
  referenceIssues,
  summary,
  triggerMatch,
} from '../server/modules/rules/definition.mjs';
import { matchRules, renderText } from '../server/modules/rules/runner.mjs';
import { ORDER, createDispatcher } from '../server/app/dispatch.mjs';

const def = (trigger, actions = [{ type: 'send_text', text: 'Hola' }], extra = {}) =>
  normalizeDefinition({ v: 1, trigger, actions, ...extra });
const kw = (words, mode = 'contains', more = {}) => ({ type: 'keyword', words, mode, ...more });

test('palabras clave: contiene, exacto, empieza con y parecido; sin mayúsculas, acentos ni signos', () => {
  assert.deepEqual(triggerMatch(kw(['precio']), '¿Cuál es el PRECIO del curso?'), { word: 'precio', mode: 'contains' });
  assert.equal(triggerMatch(kw(['curso']), 'tengo un recurso'), null, 'palabras completas: «recurso» no es «curso»');
  assert.ok(triggerMatch(kw(['información']), 'quiero informacion'));
  assert.ok(triggerMatch(kw(['hola'], 'exact'), '¡Hola!'));
  assert.equal(triggerMatch(kw(['hola'], 'exact'), 'hola, buenas'), null);
  assert.ok(triggerMatch(kw(['quiero inscribirme'], 'starts_with'), 'Quiero inscribirme al curso de aves'));
  assert.equal(triggerMatch(kw(['quiero'], 'starts_with'), 'yo quiero'), null);
  assert.equal(triggerMatch(kw(['quier'], 'starts_with'), 'quiero'), null, 'empieza con palabras completas');
  assert.ok(triggerMatch(kw(['hidrocarburos'], 'fuzzy', { threshold: 80 }), 'curso de hidrocaburos'));
  assert.equal(triggerMatch(kw(['hidrocarburos'], 'fuzzy', { threshold: 95 }), 'curso de hidrocaburos'), null);
  assert.ok(triggerMatch({ type: 'any_message' }, 'lo que sea'));
  assert.equal(triggerMatch({ type: 'any_message' }, '   '), null, 'un mensaje sin letras ni números nunca coincide');
  // Lo que escribe una persona no se interpreta como expresión regular.
  assert.equal(triggerMatch(kw(['(a+)+$']), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'), null);
});

test('definición: forma canónica y problemas en palabras de quien arma la regla', () => {
  const ok = def(kw([' Precio ', 'precio', 'COSTO']), [{ type: 'send_text', text: 'El precio es {{precio}}' }]);
  assert.deepEqual(ok.trigger, { type: 'keyword', mode: 'contains', words: ['Precio', 'COSTO'] });
  assert.deepEqual(ok.options, { stop: false, limit: 'always' });
  assert.equal(ok.conditions, null);
  const bad = (input, pattern) =>
    assert.throws(
      () => normalizeDefinition(input),
      e => e.status === 400 && e.details.problems.some(p => pattern.test(p)),
    );
  bad({ trigger: kw([]), actions: [{ type: 'send_text', text: 'x' }] }, /al menos una palabra/);
  bad({ trigger: kw(['x']), actions: [] }, /al menos una acción/);
  bad({ trigger: kw(['x']), actions: [{ type: 'send_text', text: 'Cuesta $1,500' }] }, /importe escrito a mano/);
  bad(
    { trigger: kw(['x']), actions: [{ type: 'send_text', text: 'Hola {{var.correo}}' }] },
    /variables de un recorrido/,
  );
  bad({ trigger: kw(['x']), actions: [{ type: 'send_text', text: 'Hola {{inventado}}' }] }, /no existe/);
  bad({ trigger: kw(['x']), actions: [{ type: 'borrar_todo' }] }, /elige qué hace/);
  bad(
    {
      trigger: kw(['x']),
      actions: [
        { type: 'start_flow', flowId: 'f1' },
        { type: 'send_text', text: 'Hola' },
      ],
    },
    /los mensajes los manda el recorrido/,
  );
  bad(
    {
      trigger: kw(['x']),
      actions: [
        { type: 'handoff', to: 'queue' },
        { type: 'set_status', status: 'solved' },
      ],
    },
    /no las dos cosas/,
  );
  bad({ trigger: kw(['x']), actions: [{ type: 'set_status', status: 'confirmar_pago' }] }, /elige el estado/);
  bad({ trigger: kw(['x'], 'fuzzy', { threshold: 40 }), actions: [{ type: 'add_tag', tagId: 't1' }] }, /parecido/);
  bad(
    {
      trigger: kw(['x']),
      actions: [{ type: 'add_tag', tagId: 't1' }],
      options: { limit: 'cooldown', cooldownMinutes: 0 },
    },
    /descanso/,
  );
  bad(
    {
      trigger: kw(['x']),
      actions: [{ type: 'add_tag', tagId: 't1' }],
      conditions: {
        version: 1,
        match: 'all',
        groups: [{ match: 'all', rules: [{ field: 'ciudad', op: 'eq', value: 'x' }] }],
      },
    },
    /no existe/,
  );
  // Las acciones se ejecutan silenciosas, luego voz, luego control, conservando su orden dentro de cada clase.
  const mixed = def(kw(['x']), [
    { type: 'handoff', to: 'queue' },
    { type: 'send_text', text: 'Te paso con alguien' },
    { type: 'add_tag', tagId: 't1' },
  ]);
  assert.deepEqual(
    ordered(mixed.actions).map(a => a.type),
    ['add_tag', 'send_text', 'handoff'],
  );
  assert.match(summary(mixed).when, /Contiene la palabra: «x»/);
  // Referencias: material sin aprobar, recorrido sin activar, etiqueta o curso de otra marca.
  const refs = def(
    kw(['x']),
    [
      { type: 'send_material', materialId: 'm1' },
      { type: 'add_tag', tagId: 'ajena' },
    ],
    {
      conditions: {
        version: 1,
        match: 'all',
        groups: [{ match: 'all', rules: [{ field: 'course', op: 'in', value: ['otro'] }] }],
      },
    },
  );
  const issues = referenceIssues(refs, {
    materials: [{ id: 'm1', status: 'draft' }],
    flows: [],
    tags: [{ id: 't1' }],
    users: [],
    courses: [{ id: 'aves' }],
  });
  assert.equal(issues.length, 3);
});

test('orden de la lista: la primera que coincide va primero; «no seguir», condiciones y «una vez»', () => {
  const rule = (id, trigger, extra = {}) => ({
    id,
    title: id,
    revision: 1,
    definition: def(trigger, undefined, extra),
  });
  const record = { channel: 'whatsapp', course: 'aves', hours: 'open', tags: ['vip'], first_message: true };
  const when = (field, op, value) => ({
    conditions: { version: 1, match: 'all', groups: [{ match: 'all', rules: [{ field, op, value }] }] },
  });
  const rules = [
    rule('a', kw(['precio']), when('channel', 'in', ['instagram'])),
    rule('b', kw(['precio']), when('tags', 'any', ['vip'])),
    rule('c', { type: 'any_message' }, { options: { stop: true } }),
    rule('d', kw(['precio'])),
  ];
  const { matched, verdicts } = matchRules(rules, '¿precio?', record);
  assert.deepEqual(
    matched.map(v => v.rule.id),
    ['b', 'c'],
  );
  assert.match(verdicts[0].reason, /condiciones/);
  assert.match(verdicts[3].reason, /no seguir/);
  // Condiciones de horario, curso y primer mensaje.
  const hours = [rule('h', kw(['hola']), when('hours', 'eq', 'closed'))];
  assert.equal(matchRules(hours, 'hola', record).matched.length, 0);
  assert.equal(matchRules(hours, 'hola', { ...record, hours: 'closed' }).matched.length, 1);
  const first = [rule('f', kw(['hola']), when('first_message', 'is', true))];
  assert.equal(matchRules(first, 'hola', { ...record, first_message: false }).matched.length, 0);
  const course = [rule('k', kw(['hola']), when('course', 'not_in', ['aves']))];
  assert.equal(matchRules(course, 'hola', record).matched.length, 0);
  // «Una vez» y descanso los decide quien llama con limitOk.
  const once = matchRules([rule('o', kw(['hola']))], 'hola', record, { limitOk: () => false });
  assert.equal(once.matched.length, 0);
  assert.match(once.verdicts[0].reason, /descanso|una vez/);
});

test('textos con datos: catálogo, contacto y respaldo', () => {
  const values = { base: { nombre: 'Ana', curso: 'Aves' }, contacto: { ciudad: 'Puebla' } };
  assert.equal(renderText('Hola, {{nombre}}. {{curso}} en {{contacto.ciudad}}', values), 'Hola, Ana. Aves en Puebla');
  assert.equal(
    renderText('Hola, {{nombre}}. Fecha: {{fecha|por confirmar}}', values),
    'Hola, Ana. Fecha: por confirmar',
  );
});

test('despachador: las reglas van antes que los recorridos y un motor con passOnError cede el turno al fallar', () => {
  assert.ok(ORDER.rules < ORDER.chatflows);
  const calls = [];
  const db = { exec: () => {} };
  const d = createDispatcher({ db, log: { error: () => {} } });
  d.register('chatflows', {
    order: ORDER.chatflows,
    inbound: () => (calls.push('chatflows'), { done: true }),
  });
  d.register('rules', {
    order: ORDER.rules,
    passOnError: true,
    inbound: () => {
      calls.push('rules');
      throw new Error('falla');
    },
  });
  assert.deepEqual(d.engines(), ['rules', 'chatflows']);
  assert.deepEqual(d.inbound({}, {}), { done: true });
  assert.deepEqual(calls, ['rules', 'chatflows']);
  // Sin passOnError, el fallo salta al asistente (lo de siempre).
  const plain = createDispatcher({ db, log: { error: () => {} } });
  plain.register('x', {
    order: 1,
    inbound: () => {
      throw new Error('falla');
    },
  });
  plain.register('y', { order: 2, inbound: () => ({ done: true }) });
  assert.deepEqual(plain.inbound({}, {}), { engineFailed: 'x' });
});
