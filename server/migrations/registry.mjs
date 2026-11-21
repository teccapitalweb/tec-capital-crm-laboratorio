// Registro de migraciones con nombre. Una línea por ÁREA: cada frente de trabajo añade aquí la suya una sola vez
// y lleva sus migraciones, numeradas, en server/migrations/named/<área>/index.mjs.
//
// El orden total es «áreas en el orden de esta lista, migraciones en el orden de su área». Mantén las áreas en
// orden alfabético salvo que una dependa de otra (lo declara en `after` y debe ir después).
//
//   import contacts from './named/contacts/index.mjs';
import conversations from './named/conversations/index.mjs';
//   export const NAMED = defineRegistry([...contacts, ...perf]);
import { defineRegistry } from './named.mjs';
import api from './named/api/index.mjs';
import attributes from './named/attributes/index.mjs';
import audiences from './named/audiences/index.mjs';
import broadcasts from './named/broadcasts/index.mjs';
import channelHealth from './named/channel-health/index.mjs';
import chatflows from './named/chatflows/index.mjs';
import contactImport from './named/contact-import/index.mjs';
import contacts from './named/contacts/index.mjs';
import courseAccess from './named/course-access/index.mjs';
import identity from './named/identity/index.mjs';
import inbox from './named/inbox/index.mjs';
import jobs from './named/jobs/index.mjs';
import lifecycle from './named/lifecycle/index.mjs';
import mcpActivity from './named/mcp-activity/index.mjs';
import mcpOauth from './named/mcp-oauth/index.mjs';
import messages from './named/messages/index.mjs';
import queues from './named/queues/index.mjs';
import realMode from './named/real-mode/index.mjs';
import rules from './named/rules/index.mjs';
import sequences from './named/sequences/index.mjs';
import waCutover from './named/wa-cutover/index.mjs';

// «contacts» va después de «identity» aunque el alfabeto diga otra cosa: su búsqueda usa la clave de teléfono.
// «messages» va después de «queues»: las dos añaden columnas a messages y una base nueva debe quedar con el mismo orden
// de columnas que una ya publicada (queues/0001 se publicó antes).
// «jobs» y «contact-import» van al final: la importación usa la clave de teléfono (identity) y la cola de trabajos.
// «audiences» va después de todas: usa la búsqueda de contactos y la importación la llena.
// «channel-health» va al final: añade columnas a wa_account (broadcasts) y llegó después de todas las publicadas.
// «api» va después de todas: añade columnas a api_keys y webhook_endpoints (escalera) y llegó después de las publicadas.
// «wa-cutover» va al final: añade columnas a wa_numbers (después de identity) y llegó después de las publicadas.
// «real-mode» va al final: tabla propia (brand_real_mode) y llegó después de las publicadas.
// «lifecycle» va al final: añade columnas a conversations y llegó después de todas las publicadas.
// «chatflows» va al final: tablas propias (recorridos) y llegó después de todas las publicadas.
// «conversations» va después de las publicadas: la bandeja nueva (vistas guardadas e índices); usa conversations.state
// de «lifecycle». «rules» y «sequences» van al final: tablas propias (reglas por mensaje y secuencias de seguimiento).
// «course-access» va al final: tablas propias (accesos del curso) y llegó después de todas las publicadas.
// «mcp-oauth» va al final: tablas propias (conectar un asistente con un clic) y llegó después de todas las publicadas.
// «mcp-activity» va al final: tabla propia (actividad del asistente) y llegó después de todas las publicadas.
export const NAMED = defineRegistry([
  ...attributes,
  ...broadcasts,
  ...identity,
  ...contacts,
  ...inbox,
  ...queues,
  ...messages,
  ...jobs,
  ...contactImport,
  ...audiences,
  ...channelHealth,
  ...api,
  ...waCutover,
  ...realMode,
  ...lifecycle,
  ...chatflows,
  ...conversations,
  ...rules,
  ...sequences,
  ...courseAccess,
  ...mcpOauth,
  ...mcpActivity,
]);
