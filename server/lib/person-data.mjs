// Registro de las tablas que guardan datos ligados a una persona atendida (docs/PLAN_FUSION_Y_DATOS_DE_PERSONA.md).
//
// Por qué existe: al fusionar dos contactos hay que mover TODO lo que cuelga del que desaparece (intereses, notas,
// pedidos, inscripciones, certificados, históricos, destinatarios de campaña, valores de atributos…). Si esa lista se
// escribe a mano en la fusión, cada tabla nueva la deja atrás sin avisar. Aquí cada servicio o módulo declara sus
// tablas y cómo se mueven, y una prueba candado (test/person-data.test.mjs) falla si el esquema tiene una tabla con
// `contact_id` o `person_id` que nadie declaró.
//
//   personData.register({
//     name: 'payments',                         // quién declara (un servicio o un módulo); no se repite
//     tables: ['orders', 'enrollments'],        // las tablas que son suyas; una tabla tiene un solo dueño
//     merge(keepId, mergedId, ctx) → {tabla: filas movidas}     // fusión de contactos; síncrona, sin transacción propia
//     mergePerson(keepId, mergedId, ctx) → {tabla: filas}       // opcional: fusión de personas (columna person_id)
//     export(scope), erase(scope)               // opcionales: los usarán el expediente y la supresión (aún no existen)
//   });
//
// Las funciones corren dentro de la transacción de quien fusiona: no abren otra, no hacen red y no llaman a funciones
// que abran la suya (`setContactTags`, `setConsent`…).
const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const TABLE = /^[a-z][a-z0-9_]{1,62}$/;

// Columnas que señalan a una persona atendida. El candado busca tablas con alguna de ellas.
export const SUBJECT_COLUMNS = Object.freeze(['contact_id', 'person_id']);

// Tablas con esas columnas que, con motivo, no se registran. Cada entrada lleva su porqué; la lista se mantiene corta.
export const EXEMPT = Object.freeze({
  contact_search:
    'Índice de búsqueda derivado de contacts (migración contacts/0001-search): lo mantienen disparadores, se borra con el contacto absorbido y el que queda se recalcula solo; no guarda nada que no esté en otra tabla.',
});

const isFunction = value => typeof value === 'function';

// Mueve las filas de un contacto (o persona) a otro en una columna. Devuelve cuántas cambió.
export function moveRows(db, table, column, keepId, mergedId) {
  if (!TABLE.test(table) || !SUBJECT_COLUMNS.includes(column))
    throw new TypeError('moveRows: tabla o columna no válida.');
  return Number(db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(keepId, mergedId).changes);
}

export function createPersonData({ db }) {
  if (!db) throw new TypeError('createPersonData necesita { db }.');
  const entries = [];
  const owners = new Map(); // tabla → nombre de quien la declaró
  const columnCache = new Map();

  // Columnas de una tabla que existe en la base, o null si no existe (pruebas con esquema parcial).
  function columnsOf(table) {
    if (!columnCache.has(table)) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      columnCache.set(
        table,
        exists
          ? db
              .prepare(`PRAGMA table_info(${table})`)
              .all()
              .map(column => column.name)
          : null,
      );
    }
    return columnCache.get(table);
  }

  function register(definition) {
    const { name, tables, merge, mergePerson, export: exporter, erase } = definition ?? {};
    const bad = message => new TypeError(`personData.register(${name ?? '?'}): ${message}`);
    if (typeof name !== 'string' || !NAME.test(name)) throw bad('«name» admite minúsculas, números y guiones.');
    if (entries.some(entry => entry.name === name)) throw bad(`«${name}» ya registró sus tablas.`);
    if (!Array.isArray(tables) || !tables.length) throw bad('«tables» debe listar al menos una tabla.');
    if (new Set(tables).size !== tables.length) throw bad('una tabla aparece dos veces.');
    for (const table of tables) {
      if (typeof table !== 'string' || !TABLE.test(table)) throw bad(`nombre de tabla no válido: ${table}.`);
      if (owners.has(table)) throw bad(`la tabla ${table} ya es de «${owners.get(table)}».`);
    }
    if (!isFunction(merge)) throw bad('falta merge(keepId, mergedId, ctx).');
    for (const [key, fn] of Object.entries({ mergePerson, export: exporter, erase }))
      if (fn !== undefined && !isFunction(fn)) throw bad(`«${key}» debe ser una función.`);
    const entry = Object.freeze({ name, tables: Object.freeze([...tables]), merge, mergePerson, exporter, erase });
    entries.push(entry);
    for (const table of tables) owners.set(table, name);
    return entry.tables;
  }

  // Filas que todavía señalan a `id` en las tablas registradas que tienen esa columna: {tabla: n}, sólo las que no
  // son cero.
  function count(id, column = 'contact_id') {
    const out = {};
    for (const [table] of owners) {
      if (!columnsOf(table)?.includes(column)) continue;
      const n = db.prepare(`SELECT count(*) n FROM ${table} WHERE ${column}=?`).get(id).n;
      if (n) out[table] = Number(n);
    }
    return out;
  }

  function leftovers(id, column) {
    const rest = count(id, column);
    const tables = Object.keys(rest);
    if (tables.length)
      throw Object.assign(new Error(`La fusión dejaría filas sin mover en: ${tables.join(', ')}.`), {
        status: 500,
        code: 'merge_incomplete',
      });
  }

  // Mueve todo lo registrado del contacto `mergedId` al `keepId`. Devuelve {módulo: {tabla: filas}}. Al terminar
  // comprueba que ninguna tabla registrada siga señalando al contacto absorbido: si alguna lo hace, lanza (y la
  // transacción de quien llama se deshace) en lugar de dejar huérfanos.
  function mergeContacts(keepId, mergedId, ctx = {}) {
    const moved = {};
    for (const entry of entries) {
      const result = entry.merge(keepId, mergedId, ctx);
      if (result && typeof result === 'object' && Object.values(result).some(Boolean)) moved[entry.name] = result;
    }
    leftovers(mergedId, 'contact_id');
    return moved;
  }

  // Lo mismo para la fusión de personas (columna person_id), justo antes de borrar la persona absorbida.
  function mergePersons(keepId, mergedId, ctx = {}) {
    const moved = {};
    for (const entry of entries) {
      if (!entry.mergePerson) continue;
      const result = entry.mergePerson(keepId, mergedId, ctx);
      if (result && typeof result === 'object' && Object.values(result).some(Boolean)) moved[entry.name] = result;
    }
    leftovers(mergedId, 'person_id');
    return moved;
  }

  // Tablas del esquema con alguna columna de persona que nadie registró y que no están en EXEMPT: lo que mira el
  // candado. [{table, columns}].
  function unregistered() {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map(({ name }) => ({
        table: name,
        columns: (columnsOf(name) ?? []).filter(column => SUBJECT_COLUMNS.includes(column)),
      }))
      .filter(({ table, columns }) => columns.length && !owners.has(table) && !Object.hasOwn(EXEMPT, table));
  }

  return Object.freeze({
    register,
    list: () => entries.map(entry => ({ name: entry.name, tables: [...entry.tables] })),
    owner: table => owners.get(table) ?? null,
    count,
    mergeContacts,
    mergePersons,
    unregistered,
  });
}

// Tablas de los servicios que ya existían antes del registro, una declaración por servicio. Las del propio módulo de
// contactos (intereses, notas, etiquetas y consentimiento) las declara server/contacts.mjs, porque su fusión aplica
// reglas que viven ahí (etiquetas sin repetir, consentimiento más restrictivo).
export function registerExistingTables(personData, db) {
  const move =
    (table, column = 'contact_id') =>
    (keepId, mergedId) => ({
      [table]: moveRows(db, table, column, keepId, mergedId),
    });
  const both = tables => (keepId, mergedId) => Object.assign({}, ...tables.map(table => move(table)(keepId, mergedId)));

  // Personas: identidades y consentimiento por persona. No cuelgan del contacto; las une persons.afterContactMerge
  // cuando la persona del contacto absorbido se queda sin contactos, y persons.applyMerge en la fusión de personas.
  personData.register({ name: 'persons', tables: ['person_identities', 'person_consent_events'], merge: () => ({}) });
  // Cobros: pedidos e inscripciones pasan al contacto que queda con su conversación y su interés intactos.
  personData.register({ name: 'payments', tables: ['orders', 'enrollments'], merge: both(['orders', 'enrollments']) });
  // Libro de ventas: el hecho contable no cambia; sólo a quién se atribuye.
  personData.register({ name: 'finance', tables: ['ledger_entries'], merge: move('ledger_entries') });
  // Certificados e históricos también guardan la persona: en una fusión de personas pasan a la que queda.
  for (const [name, table] of [
    ['certificates', 'certificates'],
    ['legacy', 'legacy_records'],
  ])
    personData.register({ name, tables: [table], merge: move(table), mergePerson: move(table, 'person_id') });
  personData.register({ name: 'surveys', tables: ['survey_invites'], merge: move('survey_invites') });
  // Destinatarios de campaña: una fila por campaña y contacto. Si los dos recibieron la misma campaña se conserva la
  // fila del que queda (la campaña le llegó una vez a esa persona) y la del absorbido se retira; el paso de envío y
  // su mensaje siguen en automation_steps y en la conversación.
  personData.register({
    name: 'campaigns',
    tables: ['campaign_recipients'],
    merge(keepId, mergedId) {
      const moved = Number(
        db
          .prepare(
            'UPDATE campaign_recipients SET contact_id=? WHERE contact_id=? AND campaign_id NOT IN (SELECT campaign_id FROM campaign_recipients WHERE contact_id=?)',
          )
          .run(keepId, mergedId, keepId).changes,
      );
      const repeated = Number(db.prepare('DELETE FROM campaign_recipients WHERE contact_id=?').run(mergedId).changes);
      return { campaign_recipients: moved, campaign_recipients_repeated: repeated };
    },
  });
}
