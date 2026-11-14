// Registro de migraciones con nombre. Una línea por ÁREA: cada frente de trabajo añade aquí la suya una sola vez
// y lleva sus migraciones, numeradas, en server/migrations/named/<área>/index.mjs.
//
// El orden total es «áreas en el orden de esta lista, migraciones en el orden de su área». Mantén las áreas en
// orden alfabético salvo que una dependa de otra (lo declara en `after` y debe ir después).
//
//   import contacts from './named/contacts/index.mjs';
//   export const NAMED = defineRegistry([...contacts, ...perf]);
import { defineRegistry } from './named.mjs';
import inbox from './named/inbox/index.mjs';
import queues from './named/queues/index.mjs';

export const NAMED = defineRegistry([...inbox, ...queues]);
