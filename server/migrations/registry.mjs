// Registro de migraciones con nombre. Una línea por ÁREA: cada frente de trabajo añade aquí la suya una sola vez
// y lleva sus migraciones, numeradas, en server/migrations/named/<área>/index.mjs.
//
// El orden total es «áreas en el orden de esta lista, migraciones en el orden de su área». Mantén las áreas en
// orden alfabético salvo que una dependa de otra (lo declara en `after` y debe ir después).
//
//   import contacts from './named/contacts/index.mjs';
//   export const NAMED = defineRegistry([...contacts, ...perf]);
import { defineRegistry } from './named.mjs';
import attributes from './named/attributes/index.mjs';
import contactImport from './named/contact-import/index.mjs';
import contacts from './named/contacts/index.mjs';
import identity from './named/identity/index.mjs';
import inbox from './named/inbox/index.mjs';
import jobs from './named/jobs/index.mjs';
import queues from './named/queues/index.mjs';

// «contacts» va después de «identity» aunque el alfabeto diga otra cosa: su búsqueda usa la clave de teléfono.
// «contact-import» va al final: usa la clave de teléfono (identity) y la cola de trabajos (jobs).
export const NAMED = defineRegistry([
  ...attributes,
  ...identity,
  ...contacts,
  ...inbox,
  ...jobs,
  ...queues,
  ...contactImport,
]);
