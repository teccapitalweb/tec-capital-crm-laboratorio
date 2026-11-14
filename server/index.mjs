import http from 'node:http';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { openDatabase, transaction } from './database.mjs';
import { migrate } from './migrations/index.mjs';
import { createStatic } from './app/static.mjs';
import { loadScreens } from './app/screens.mjs';
import { loadModules } from './app/modules.mjs';
import { clientAddress, limitKey, proxyConfig } from './app/client-address.mjs';
import { createRateLimiter } from './app/rate-limit.mjs';
import { fail, errorBody } from './app/http.mjs';
import { createRealtime } from './app/realtime.mjs';
import { createAccess } from './lib/access.mjs';
import { courseArtwork, artworkAsset } from './demo-catalog.mjs';
import { createCRM } from './crm.mjs';
import { conversationPage } from './conversations.mjs';
import { defaultEditionId, seedBrandTemplates } from './catalogue-schema.mjs';
import { createCatalogue } from './catalogue.mjs';
import { createOperations } from './operations.mjs';
import { createContacts } from './contacts.mjs';
import { createAnalytics } from './analytics.mjs';
import { createMfa } from './mfa.mjs';
import { seedBrandKnowledge } from './replies-schema.mjs';
import { createReplies } from './replies.mjs';
import { createAiProvider } from './ai-provider.mjs';
import { createRecipes } from './recipes.mjs';
import { createBackups, backupRoutes } from './backup.mjs';
import { createCatalogueImport } from './catalogue-import.mjs';
import { createKnowledgeImport } from './knowledge-import.mjs';
import { createAiBudget } from './ai-budget.mjs';
import { createAutomation, cancelConversationSteps } from './automation.mjs';
import { createSimulator } from './simulator.mjs';
import { createChannel } from './channel.mjs';
import { createPayments } from './payments.mjs';
import { createReadiness } from './readiness.mjs';
import { createPresentation } from './presentation.mjs';
import { seedBrandEvaluation } from './evaluation-schema.mjs';
import { createEvaluation } from './evaluation.mjs';
import { createConnectors } from './connectors.mjs';
import { createWhatsApp } from './whatsapp.mjs';
import { createFlows } from './flows.mjs';
import { createPrivacy } from './privacy.mjs';
import { createMcp } from './mcp.mjs';
import { createEvents } from './events.mjs';
import { createCoordination } from './coordination.mjs';
import { createFinance } from './finance.mjs';
import { createPersons } from './persons.mjs';
import { createCertificates } from './certificates.mjs';
import { createContent } from './content.mjs';
import { createSurveys } from './surveys.mjs';
import { createCore } from './core.mjs';
import { createLegacy } from './legacy.mjs';
import { createCampaigns } from './campaigns.mjs';
import { createPortal } from './portal.mjs';
import { createPush } from './push.mjs';
import { createAds } from './ads.mjs';
import { createAllies } from './allies.mjs';
import { createSummaries } from './summaries.mjs';
import { createScheduled } from './scheduled.mjs';
import { createAppointments } from './appointments.mjs';
import { createCoupons } from './coupons.mjs';
import { createIntegrations } from './integrations.mjs';
import { createAiStatus } from './ai-status.mjs';
import { createQuickReplies } from './quickreplies.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.DATA_DIR || resolve(root, 'data'));
mkdirSync(resolve(dataDir, 'uploads'), { recursive: true });
const db = openDatabase(dataDir);
// Esquema: respaldo previo si hay algo pendiente, escalera cerrada en la 41 y migraciones con nombre (server/migrations/).
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const schema = migrate(db, { dataDir, log: name => console.log('Migración aplicada: ' + name) });
if (schema.unknown.length)
  console.warn('La base tiene migraciones que este código no conoce: ' + schema.unknown.join(', '));
const hash = value => createHash('sha256').update(value).digest('hex');
const derive = promisify(scrypt);
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3100);
const host = process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1');
const sessions = new Map();
// Proxies propios delante del servidor (TRUSTED_PROXY_HOPS; 0 = no fiarse de ninguna cabecera).
const proxy = proxyConfig();
const ttl = 7 * 24 * 60 * 60 * 1000;
const staff = person => person && !person.disabled && (person.role === 'agent' || person.role === 'admin');
const safeUser = user => ({
  id: user.id,
  username: user.username,
  name: user.name,
  role: user.role,
  testNumber: user.test_number,
});
const clean = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const normalized = v =>
  v
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
const secureEqual = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length > 0 &&
  b.length > 0 &&
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
db.function('search_text', { deterministic: true }, value => normalized(String(value ?? '')));
const publicCourse = c => ({ ...c, price: c.price_cents / 100, hasArtwork: Boolean(courseArtwork(c)) });

// Límites de intentos (server/app/rate-limit.mjs): ventana fija por clave; un contador vivo no se borra nunca.
const limiter = createRateLimiter({ fail });
function rate(key, max, window = 60000) {
  limiter.rate(key, max, window);
}
function security(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (process.env.APP_ORIGIN) return origin === process.env.APP_ORIGIN.replace(/\/$/, '');
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && url.host === req.headers.host;
  } catch {
    return false;
  }
}
function readSession(req) {
  const token = (req.headers.cookie || '')
    .split(';')
    .map(x => x.trim())
    .find(x => x.startsWith('tc_session='))
    ?.slice(11);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const user = db
    .prepare(
      'SELECT u.*,s.token_hash,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?',
    )
    .get(hash(token), Date.now());
  return user && !user.disabled ? user : null;
}
function requireUser(req) {
  const user = readSession(req);
  if (!user) throw fail(401, 'Inicia sesión para continuar.');
  return user;
}
function requireStaff(user) {
  if (!staff(user)) throw fail(403, 'Esta acción es para el equipo de atención.');
}
function requireAdmin(user) {
  if (user.role !== 'admin') throw fail(403, 'Esta acción requiere un administrador.');
}
function accessConversation(id, user) {
  const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  if (!c || !canSee(c, user)) throw fail(404, 'Conversación no disponible.');
  return c;
}
function canSee(c, user) {
  return !user.disabled && (c.customer_id === user.id || crm.canBrand(user, c.brand_id));
}
function disconnect(userId) {
  for (const [socket, user] of sessions) if (user.id === userId) socket.close(1008, 'Actualiza tu acceso');
}
const crm = createCRM({ db, body, json, audit, passwordHash, checkPassword, rate, disconnect, broadcast });
// Eventos de dominio (server/events.mjs): índice común de hechos, publicado dentro de cada transacción; suscriptores con reintento.
const events = createEvents({ db, crm, body, json, audit });
// Identidad única de persona (server/persons.mjs): cada contacto por marca cuelga de una persona; consentimiento a nivel persona.
const persons = createPersons({ db, crm, events, body, json, audit, broadcast });
crm.setContactHook(c => persons.attach(c));
crm.setStageHook(({ id, eventId, actor, from, to, reason, source }) => {
  const o = db.prepare('SELECT brand_id,contact_id,course_id,edition_id FROM opportunities WHERE id=?').get(id);
  if (o)
    events.publish({
      type: 'oportunidad.etapa',
      brandId: o.brand_id,
      entityKind: 'opportunity',
      entityId: id,
      payload: {
        from,
        to,
        reason: reason || undefined,
        source,
        contactId: o.contact_id,
        courseId: o.course_id,
        editionId: o.edition_id,
      },
      actorId: actor?.id || null,
      source: 'crm',
      dedupeKey: 'oportunidad.etapa:' + eventId,
    });
});
const catalogue = createCatalogue({
  db,
  crm,
  body,
  json,
  audit,
  broadcast,
  dataDir,
  root,
  attachmentData,
  accessConversation,
  insertMessage,
  serveFlyer,
  events,
});
// Contenido (server/content.mjs): plantillas por evento, funciones de diseño/aprobación, variantes por IA y fichas SVG. El proveedor de IA se resuelve al usarse.
const content = createContent({
  db,
  crm,
  catalogue,
  events,
  insertMessage,
  provider: () => aiProvider,
  body,
  json,
  audit,
  broadcast,
  dataDir,
});
// Encuestas (server/surveys.mjs): invitación por chat con token propio, respuesta pública en /encuesta/<token>, resultados por apertura; envío automático por marca apagado.
const surveys = createSurveys({ db, crm, events, insertMessage, content, body, json, audit, broadcast, rate });
// Núcleo compartido (server/core.mjs): outbox firmado de todos los eventos de dominio hacia Postgres/Supabase; simulado sin CORE_SINK_URL. Contrato en docs/NUCLEO.md.
const core = createCore({ db, crm, events, body, json, audit });
catalogue.setContentGate(content.gate);
// Canal simulado (server/channel.mjs): estados de entrega, ventana de 24 h, categorías, botones y anuncio; apagado por marca por omisión.
const channel = createChannel({ db, crm, body, json, audit, broadcast, accessConversation, domainEvents: events });
const mfa = createMfa({ db, dataDir, json, body, audit, rate, checkPassword });
if (process.env.MFA_RESET_USER) {
  const had = mfa.resetByUsername(process.env.MFA_RESET_USER);
  console.log(
    had
      ? 'MFA restablecido para @' +
          String(process.env.MFA_RESET_USER).trim().toLowerCase() +
          '. Retira MFA_RESET_USER del entorno.'
      : 'MFA_RESET_USER: ese usuario no tenía verificación en dos pasos o no existe.',
  );
}
const analytics = createAnalytics({ db, crm, json });
const contacts = createContacts({ db, crm, body, json, audit, broadcast, events, persons });
const catalogueImport = createCatalogueImport({ db, catalogue, crm, body, json, audit });
const operations = createOperations({ db, crm, catalogue, body, json, audit, broadcast, online, insertMessage });
// Venta con pago simulado (server/payments.mjs): pedidos, enlace de prueba, comprobantes en cola, inscripción; apagada por marca por omisión.
// Cupones de descuento (server/coupons.mjs): administración los crea por marca; el equipo los aplica al cobrar desde el chat.
const coupons = createCoupons({ db, crm, body, json, audit });
// API pública de lectura y webhooks salientes (server/integrations.mjs): llaves por marca, envíos firmados con reintento, destinos privados rechazados.
const integrations = createIntegrations({
  db,
  crm,
  events,
  body,
  json,
  audit,
  rate,
  baseDelayMs: process.env.NODE_ENV === 'test' ? 100 : 5000,
  capDelayMs: process.env.NODE_ENV === 'test' ? 400 : 15 * 60000,
});
const payments = createPayments({
  db,
  crm,
  catalogue,
  insertMessage,
  body,
  json,
  audit,
  broadcast,
  accessConversation,
  events,
  content,
  coupons,
  rate,
});
// Coordinación académica (server/coordination.mjs): aperturas sobre la edición, sesiones, asistencia y recursos; la venta confirmada entra por evento.
// Lista «Preparar marca» (server/readiness.mjs): sólo lectura, administración.
const readiness = createReadiness({ db, crm, json });
const coordination = createCoordination({
  db,
  crm,
  events,
  insertMessage,
  body,
  json,
  audit,
  broadcast,
  content,
  payments,
  surveys,
});
// Finanzas (server/finance.mjs): libro de ventas por eventos, comisiones con regla configurable, liquidaciones, función contadora.
const finance = createFinance({ db, crm, events, body, json, audit, broadcast });
// Certificación (server/certificates.mjs): folio secuencial, SVG con QR, verificación pública /verificar/<folio>, emisión automática al cerrar (apagada por marca).
const certificates = createCertificates({
  db,
  crm,
  events,
  insertMessage,
  body,
  json,
  audit,
  broadcast,
  rate,
  dataDir,
  root,
  content,
});
// Puente con IPCIL (server/legacy.mjs): históricos importados por archivo, ligados a la persona única; sólo lectura en la ficha de persona y en Finanzas.
const legacy = createLegacy({ db, crm, persons, events, body, json, audit, broadcast });
persons.setLegacy(legacy.forPerson);
finance.setLegacy(legacy.financeSummary);
const presentation = createPresentation({ db, crm, json });
// Contrato de conectores (server/connectors.mjs): proveedor de canal y de pago por entorno, simulados por omisión; webhooks firmados.
const connectors = createConnectors({
  db,
  channel,
  payments,
  body,
  json,
  audit,
  rate,
  selfOrigin: () => 'http://127.0.0.1:' + server.address().port,
});
const aiProvider = createAiProvider();
aiProvider.useBudget(createAiBudget({ db })); // tope mensual de llamadas y tokens (server/ai-budget.mjs)
// Flujo de bienvenida por marca (server/flows.mjs): saludo y menu con botones; apagado por omision.
const flows = createFlows({ db, crm, body, json, audit, broadcast });
const privacy = createPrivacy(); // aviso de privacidad publico (/privacidad): pagina estatica, sin sesion
const replies = createReplies({
  db,
  catalogue,
  crm,
  contacts,
  operations,
  insertMessage,
  provider: aiProvider,
  payments,
  content,
  flows,
});
// Estado de la IA para administración (server/ai-status.mjs): proveedor, clave (sí/no), gasto del mes y qué falta por marca; sin secretos.
const aiStatus = createAiStatus({ db, crm, provider: aiProvider, json });
// WhatsApp real (server/whatsapp.mjs): entrantes de Meta -> cliente, conversacion y mensaje; salientes de conversaciones reales. Apagado sin CHANNEL_CONNECTOR=meta.
const mcp = createMcp({ db, crm, catalogue, replies, integrations, body, json, audit, rate, version });
const whatsapp = createWhatsApp({
  db,
  crm,
  catalogue,
  payments,
  replies,
  events,
  channel,
  connectors,
  broadcast,
  audit,
  body,
  json,
  rate,
  insertMessage,
  passwordHash,
  attachmentData,
  defaultEditionId,
  dataDir,
  root,
  takeOver,
  accessConversation,
});
const knowledgeImport = createKnowledgeImport({ db, replies, crm, body, json, audit });
// Pauta (server/ads.mjs): el panel de tráfico de IPCIL dentro del CRM; administración y la función de trafiquer.
const ads = createAds({ db, crm, body, json, audit });
// Aliados (server/allies.mjs): el panel RH de IPCIL dentro del CRM; la página pública de postulación está apagada (ALLY_FORM_ENABLED=1).
const allies = createAllies({ db, crm, body, json, audit, rate });
// Resumen de conversación (server/summaries.mjs): por reglas siempre, con IA si hay proveedor; lo usa también la IA que responde en chats largos.
const summaries = createSummaries({ db, crm, provider: aiProvider, accessConversation, body, json, audit, rate });
// Mensajes programados (server/scheduled.mjs): salen solos a la hora elegida, con las mismas reglas que un envio manual.
const scheduled = createScheduled({
  db,
  crm,
  catalogue,
  insertMessage,
  takeOver,
  accessConversation,
  broadcast,
  body,
  json,
  audit,
  rate,
});
// Agenda de citas (server/appointments.mjs): se agendan desde el chat, con recordatorio opcional al cliente (un mensaje programado) y aviso a quien la lleva.
const appointments = createAppointments({ db, crm, accessConversation, scheduled, broadcast, body, json, audit, rate }); // conocimiento por lote (borradores), sólo administración
// Banco de evaluación (server/evaluation.mjs): casos esperados del motor, ejecutados con la simulación sin efectos.
const evaluation = createEvaluation({ db, crm, replies, provider: aiProvider, body, json, audit });
const automation = createAutomation({
  db,
  onChange: step => {
    if (step.conversation_id) broadcast('conversation', step.conversation_id);
    broadcast('crm', null, { brandId: step.brand_id });
  },
});
const backupHours =
  process.env.BACKUP_INTERVAL_HOURS === undefined
    ? process.env.NODE_ENV === 'test'
      ? 0
      : 24
    : Number(process.env.BACKUP_INTERVAL_HOURS);
const backups = createBackups({
  db,
  dataDir,
  version,
  intervalMs: Number.isFinite(backupHours) && backupHours > 0 ? backupHours * 3600000 : 0,
  keep: Math.max(1, Number(process.env.BACKUP_KEEP) || 7),
});
const backupHandle = backupRoutes(backups);
const recipes = createRecipes({ db, catalogue, automation, insertMessage, broadcast, body, json, audit });
const campaigns = createCampaigns({ db, crm, catalogue, automation, insertMessage, broadcast, body, json, audit });
const portal = createPortal({ db, crm, json });
const push = createPush({ db, crm, body, json, audit });
const quickReplies = createQuickReplies({ db, crm, accessConversation, body, json, audit });
// Simulador de clientes: habla con la propia API por loopback (nunca dentro de una transacción). SIMULATOR_DISABLED=1 lo oculta.
const simulator = createSimulator({
  db,
  catalogue,
  crm,
  operations,
  catalogueImport,
  body,
  json,
  audit,
  broadcast,
  issueSession,
  selfOrigin: () => 'http://127.0.0.1:' + server.address().port,
  enabled: process.env.SIMULATOR_DISABLED !== '1',
});
// Pantallas nuevas (public/screens/<id>/screen.json) y archivos estáticos por carpeta (server/app/).
const screens = loadScreens({ root, preview: process.env.SCREENS_PREVIEW === '1' });
for (const message of screens.errors) console.error('Pantalla omitida:', message);
const statics = createStatic({
  root,
  fail,
  generated: { '/screens/index.json': { bytes: screens.bytes, type: 'application/json; charset=utf-8' } },
});
// Primitivas de los módulos nuevos (docs/PLAN_ACCESO_TIEMPO_REAL.md): permisos con alcance por marca y tiempo real v2.
const access = createAccess({ db, crm });
const realtime = createRealtime({ db, crm, sessions, canSee });
// Módulos nuevos (server/modules/<nombre>/module.mjs): se descubren y se montan solos después de los actuales.
const modules = await loadModules({
  dir: resolve(root, 'server', 'modules'),
  test: process.env.NODE_ENV === 'test',
  host: {
    db,
    transaction,
    root,
    dataDir,
    version,
    production,
    fail,
    clean,
    json,
    body,
    audit,
    rate,
    broadcast,
    realtime,
    access,
    online,
    staff,
    requireStaff,
    requireAdmin,
    accessConversation,
    canSee,
    insertMessage,
    takeOver,
    selfOrigin: () => 'http://127.0.0.1:' + server.address().port,
    services: {
      crm,
      events,
      persons,
      catalogue,
      content,
      surveys,
      core,
      channel,
      mfa,
      analytics,
      contacts,
      catalogueImport,
      operations,
      coupons,
      integrations,
      payments,
      readiness,
      coordination,
      finance,
      certificates,
      legacy,
      presentation,
      connectors,
      aiProvider,
      flows,
      replies,
      aiStatus,
      whatsapp,
      knowledgeImport,
      ads,
      allies,
      summaries,
      scheduled,
      appointments,
      evaluation,
      automation,
      backups,
      recipes,
      campaigns,
      portal,
      push,
      quickReplies,
      simulator,
    },
  },
});
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_800_000) throw fail(413, 'El archivo es demasiado grande. Máximo 4 MB.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
    return data;
  } catch {
    throw fail(400, 'Solicitud no válida.');
  }
}
async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const value = await derive(password, salt, 64);
  return salt + ':' + value.toString('hex');
}
async function checkPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const value = await derive(password, salt, 64);
  return expected.length === 128 && timingSafeEqual(value, Buffer.from(expected, 'hex'));
}
function issueSession(userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), userId, Date.now() + ttl);
  return token;
}
function setSession(res, user) {
  const token = issueSession(user.id);
  res.setHeader(
    'Set-Cookie',
    `tc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl / 1000}${production ? '; Secure' : ''}`,
  );
}
function broadcast(type, conversationId = null, extra = {}) {
  const c = conversationId ? db.prepare('SELECT * FROM conversations WHERE id=?').get(conversationId) : null;
  for (const [socket, saved] of sessions) {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(saved.id);
    if (
      user &&
      !user.disabled &&
      socket.readyState === WebSocket.OPEN &&
      (!c || canSee(c, user)) &&
      (type !== 'crm' || (staff(user) && (!extra.brandId || crm.canBrand(user, extra.brandId))))
    )
      socket.send(JSON.stringify({ type, conversationId, ...extra }));
  }
}
function online(userId) {
  return [...sessions].some(
    ([ws, u]) =>
      u.id === userId &&
      ws.readyState === WebSocket.OPEN &&
      u.expires_at > Date.now() &&
      Boolean(db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(u.token_hash)),
  );
}
function conversationList(user) {
  return channel.decorate(conversationPage(db, user, { size: 300 }, online).conversations);
}
function messageList(id, before = Number.MAX_SAFE_INTEGER) {
  return db
    .prepare(
      `SELECT m.*,u.name sender_name,COALESCE(a.filename,lf.filename) filename,COALESCE(a.mime,lf.mime) mime,a.size,(SELECT r.status FROM receipts r WHERE r.message_id=m.id) receipt_status,EXISTS(SELECT 1 FROM reply_log rl WHERE rl.conversation_id=m.conversation_id AND rl.reply_message_id=m.id AND rl.reason LIKE 'Proveedor de IA:%') ai_drafted FROM messages m LEFT JOIN users u ON u.id=m.sender_id
    LEFT JOIN attachments a ON a.id=m.attachment_id LEFT JOIN library_files lf ON lf.id=json_extract(m.flyer_snapshot,'$.libraryFileId') WHERE m.conversation_id=? AND m.seq<? ORDER BY m.seq DESC LIMIT 150`,
    )
    .all(id, before)
    .reverse()
    .map(m => ({
      ...m,
      flyer_snapshot: undefined,
      buttons: m.buttons ? JSON.parse(m.buttons) : null,
      commercial_snapshot: m.commercial_snapshot ? JSON.parse(m.commercial_snapshot) : null,
      attachmentUrl: m.attachment_id
        ? '/api/files/' + m.attachment_id
        : m.flyer_course_id
          ? '/api/messages/' + m.id + '/flyer'
          : null,
    }));
}
// Una persona del equipo escribe en el chat: queda a cargo y se apagan el bot y sus pasos pendientes (lo mismo que hace el envio manual).
function takeOver(c, userId) {
  replies.consumeSuggestions(c.id);
  crm.assignConversation(c, userId);
  db.prepare("UPDATE conversations SET bot_enabled=0,assigned_to=?,status='open' WHERE id=?").run(userId, c.id);
  db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(c.id);
  cancelConversationSteps(db, c.id, 'human_takeover');
}
function audit(user, action, id) {
  db.prepare('INSERT INTO audit(user_id,action,entity_id,created_at) VALUES(?,?,?,?)').run(
    user?.id || null,
    action,
    id,
    Date.now(),
  );
}
function insertMessage(c, user, text, kind, ref, attachmentId = null, flyer = null, prepared = null, options = {}) {
  const id = randomUUID(),
    now = Date.now(),
    gate = channel.before(c, kind, {
      category: options.category || channel.categoryOf(kind, prepared, flyer),
      buttons: options.buttons,
      template: options.template,
      keep: options.keepButtons,
    });
  const snapshot = prepared
    ? prepared.flyerSnapshot
    : flyer
      ? {
          course: db.prepare('SELECT * FROM courses WHERE id=?').get(flyer),
          brand: db.prepare('SELECT * FROM brands WHERE id=?').get(c.brand_id),
        }
      : null;
  if (snapshot && !prepared) snapshot.artworkId = courseArtwork(snapshot.course);
  db.prepare(
    'INSERT INTO messages(category,buttons,id,conversation_id,sender_id,sender_kind,text,attachment_id,flyer_course_id,flyer_snapshot,client_ref,created_at,commercial_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    gate.category,
    gate.buttons,
    id,
    c.id,
    user?.id || null,
    kind,
    text,
    attachmentId,
    flyer,
    JSON.stringify(snapshot),
    ref,
    now,
    prepared ? JSON.stringify({ ...prepared.commercial, sentAt: now }) : null,
  );
  if (prepared) {
    const link = db.prepare('SELECT opportunity_id FROM conversation_opportunities WHERE conversation_id=?').get(c.id);
    if (link) {
      const value = { ...prepared.commercial, sentAt: now, messageId: id };
      db.prepare('UPDATE opportunities SET offer_snapshot=? WHERE id=?').run(
        JSON.stringify(value),
        link.opportunity_id,
      );
      db.prepare("INSERT INTO crm_events(opportunity_id,actor_id,kind,details,created_at) VALUES(?,?,'offer',?,?)").run(
        link.opportunity_id,
        user?.id || null,
        JSON.stringify(value),
        now,
      );
    }
  }
  if (options.template)
    db.prepare('UPDATE messages SET wa_template=? WHERE id=?').run(JSON.stringify(options.template), id); // sale como plantilla aprobada de WhatsApp
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, c.id);
  operations.message(c, kind, user);
  if (kind === 'customer') contacts.recordInbound(c, text);
  return id;
}
// Respuestas automáticas v2 (server/replies.mjs): plan síncrono, proveedor de IA fuera de la transacción y confirmación
// con revalidación. Un trabajo en vuelo no se vuelve a tomar; el resultado se descarta si el trabajo o el chat cambiaron.
const jobsInFlight = new Set();
async function processJob(job) {
  jobsInFlight.add(job.id);
  try {
    const planned = transaction(db, () => {
      const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(job.conversation_id);
      if (!c || !c.bot_enabled || c.assigned_to || c.status !== 'open') {
        db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(job.id);
        return null;
      }
      const trigger = db.prepare('SELECT * FROM messages WHERE id=?').get(job.message_id);
      return { c, trigger, plan: replies.plan(c, trigger) };
    });
    if (!planned) return;
    let draft = null;
    if (planned.plan.needsProvider) {
      const ctx = catalogue.info(
          planned.plan.course?.courseId || planned.c.course_id,
          planned.plan.course?.editionId || planned.c.edition_id,
        ),
        history = db
          .prepare('SELECT sender_kind,text FROM messages WHERE conversation_id=? ORDER BY seq DESC LIMIT 6')
          .all(planned.c.id)
          .reverse()
          .map(m => ({ role: m.sender_kind === 'customer' ? 'customer' : 'agent', text: m.text }));
      const summary = await summaries.ensureFor(planned.c); // chats largos: la IA ve un resumen de lo anterior además de los últimos mensajes
      draft = await aiProvider.draft({
        brand: ctx.brand,
        course: ctx.course,
        edition: {
          name: ctx.edition.name,
          dateLabel: ctx.dateLabel,
          priceLabel: (ctx.priceCents / 100).toFixed(2) + ' ' + ctx.currency,
        },
        question: planned.trigger.text,
        knowledge: planned.plan.knowledge,
        history,
        memory: planned.plan.memory || null,
        summary,
      });
    }
    transaction(db, () => {
      const state = db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)?.state;
      if (state !== 'pending') return;
      const c = db.prepare('SELECT * FROM conversations WHERE id=?').get(job.conversation_id);
      if (!c.bot_enabled || c.assigned_to || c.status !== 'open') {
        db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(job.id);
        return;
      }
      replies.commit(c, planned.trigger, planned.plan, draft);
      db.prepare("UPDATE jobs SET state='done' WHERE id=?").run(job.id);
    });
    broadcast('conversation', job.conversation_id);
    if (!db.prepare('SELECT bot_enabled FROM conversations WHERE id=?').get(job.conversation_id)?.bot_enabled)
      summaries.auto(job.conversation_id); // pasó a una persona: se deja listo el resumen
  } catch (error) {
    console.error('Automation job failed', error.name);
    jobFailed(job, error);
  } finally {
    jobsInFlight.delete(job.id);
  }
}
const JOB_MAX_ATTEMPTS = 5,
  JOB_BASE_DELAY = 2000,
  JOB_CAP_DELAY = 5 * 60_000;
function jobFailed(job, error) {
  const attempts = job.attempts + 1,
    message = String(error?.message || error)
      .replace(/[\x00-\x1f]+/g, ' ')
      .slice(0, 200),
    t = Date.now();
  try {
    transaction(db, () => {
      if (attempts >= JOB_MAX_ATTEMPTS) {
        db.prepare("UPDATE jobs SET state='cancelled',attempts=?,last_error=? WHERE id=? AND state='pending'").run(
          attempts,
          message,
          job.id,
        );
        const brand = db.prepare('SELECT brand_id FROM conversations WHERE id=?').get(job.conversation_id);
        if (brand)
          db.prepare(
            'INSERT INTO automation_events(step_id,brand_id,kind,details,created_at) VALUES(NULL,?,?,?,?)',
          ).run(brand.brand_id, 'legacy_job_abandoned', JSON.stringify({ jobId: job.id, attempts, error: message }), t);
      } else
        db.prepare("UPDATE jobs SET attempts=?,last_error=?,next_attempt_at=? WHERE id=? AND state='pending'").run(
          attempts,
          message,
          t + Math.min(JOB_CAP_DELAY, JOB_BASE_DELAY * 2 ** (attempts - 1)),
          job.id,
        );
    });
  } catch (e) {
    console.error('Automation job bookkeeping failed', e.name);
  }
}
function processJobs() {
  const jobs = db
    .prepare(
      "SELECT * FROM jobs WHERE state='pending' AND due_at<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?) LIMIT 15",
    )
    .all(Date.now(), Date.now());
  for (const job of jobs) {
    if (jobsInFlight.has(job.id)) continue;
    processJob(job);
  }
}
function attachmentData(input) {
  if (!input) return null;
  const filename = clean(input.name, 120).replace(/[\r\n\x00-\x1f]/g, '');
  const mime = input.type;
  const allowed = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
  };
  if (!allowed[mime] || typeof input.base64 !== 'string' || input.base64.length > 5_600_000)
    throw fail(400, 'Admite PNG, JPG, WEBP, GIF o PDF de hasta 4 MB.');
  const buffer = Buffer.from(input.base64, 'base64');
  if (!buffer.length || buffer.length > 4 * 1024 * 1024) throw fail(413, 'Máximo 4 MB por archivo.');
  const valid =
    mime === 'image/png'
      ? buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === 'image/jpeg'
        ? buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
        : mime === 'application/pdf'
          ? buffer.subarray(0, 5).toString() === '%PDF-'
          : mime === 'image/webp'
            ? buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
            : buffer.subarray(0, 4).toString() === 'GIF8';
  if (!valid) throw fail(400, 'El contenido del archivo no coincide con su formato.');
  return {
    filename: filename || 'archivo.' + allowed[mime],
    mime,
    buffer,
    storageName: randomUUID() + '.' + allowed[mime],
  };
}
const xml = value =>
  String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
async function serveFlyer(res, course, brand, artworkId) {
  const asset = artworkAsset(artworkId);
  if (asset) {
    const bytes = await readFile(resolve(root, 'public', 'flyers', asset.filename));
    res.writeHead(200, { 'Content-Type': asset.mime, 'Content-Length': bytes.length });
    return res.end(bytes);
  }
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
  return res.end(flyer(course, brand));
}
function flyer(course, brand) {
  const words = course.title.split(' '),
    lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).length > 24) {
      lines.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="720" viewBox="0 0 760 720"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#23232d"/><stop offset="1" stop-color="#4c4c61"/></linearGradient></defs><rect width="760" height="720" rx="28" fill="#f8f8fa"/><rect width="760" height="470" rx="28" fill="url(#g)"/><circle cx="700" cy="70" r="210" fill="none" stroke="#ffffff15" stroke-width="55"/><text x="48" y="67" font-family="Arial,sans-serif" font-size="22" fill="#ffffffc0" letter-spacing="3">${xml(brand.name.toUpperCase())}</text><text x="48" y="139" font-family="Arial,sans-serif" font-size="17" fill="#ffffffa0" letter-spacing="2">CURSO · EDICIÓN DE PRUEBA</text>${lines
    .slice(0, 5)
    .map(
      (l, i) =>
        `<text x="48" y="${211 + i * 55}" font-family="Arial,sans-serif" font-size="43" font-weight="700" fill="#fff">${xml(l)}</text>`,
    )
    .join(
      '',
    )}<text x="48" y="532" font-family="Arial,sans-serif" font-size="19" fill="#666">PRECIO DE EJEMPLO</text><text x="48" y="590" font-family="Arial,sans-serif" font-size="45" font-weight="700" fill="#24242b">$${(course.price_cents / 100).toFixed(course.price_cents % 100 ? 2 : 0)} ${xml(course.currency || 'MXN')}</text><text x="48" y="622" font-family="Arial,sans-serif" font-size="14" fill="#666">${xml(((course.edition_name || '') + ' · ' + course.date_label).slice(0, 110))}</text><text x="48" y="657" font-family="Arial,sans-serif" font-size="18" fill="#666">Material simulado. No constituye una oferta real.</text><text x="48" y="684" font-family="Arial,sans-serif" font-size="16" fill="#888">TEC CAPITAL · LABORATORIO CRM · v${course.version}</text></svg>`;
}

const server = http.createServer(async (req, res) => {
  security(res);
  try {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw fail(400, 'Solicitud no v\u00e1lida.');
    } // un destino ilegible responde 400 en lugar de detener el proceso
    const path = url.pathname;
    const ip = limitKey(clientAddress(req, proxy.hops, proxy.trusted));
    if (req.method === 'GET' && path === '/api/health') {
      db.prepare('SELECT 1').get();
      // Comprobación temporal antes de fijar TRUSTED_PROXY_HOPS en producción: qué llega y qué se resuelve.
      if (process.env.LOG_CLIENT_ADDRESS === '1')
        console.log(
          'client-address',
          JSON.stringify({
            remote: req.socket.remoteAddress,
            forwarded: req.headers['x-forwarded-for'] ?? null,
            resolved: ip,
          }),
        );
      return json(res, 200, {
        ok: true,
        version,
        transport: 'websocket',
        mode: 'laboratorio',
        schema: schema.id,
        ...(modules.failed.length ? { modulesFailed: modules.failed.map(m => m.name) } : {}),
      });
    }
    if (await connectors.handlePublic(req, res, path, url, ip)) return; // webhooks de proveedores: firma propia, sin sesión ni Origin
    if (await privacy.handlePublic(req, res, path)) return;
    if (await payments.handlePublic(req, res, path, ip)) return; // pago sin sesion de un pedido de WhatsApp real (/api/pay/<pedido>)
    if (await certificates.handlePublic(req, res, path, ip)) return; // verificación pública de certificados por folio, con límite por IP
    if (await mcp.handle(req, res, path, ip)) return; // conector de Claude (MCP): llave propia, sin sesion
    if (await integrations.handlePublic(req, res, path, url, ip)) return; // API v1 de lectura: llave propia, sin sesión ni Origin
    if (await allies.handlePublic(req, res, path, ip)) return; // postulación pública de aliados (/aliados), apagada por omisión, con límite por IP
    if (await surveys.handlePublic(req, res, path, ip)) return; // encuestas por token (/encuesta/<token>, /api/survey/<token>), sin sesión, con límite por IP
    if (await modules.handlePublic(req, res, path, url, ip)) return; // rutas sin sesión de los módulos nuevos (llave o firma propia)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !originAllowed(req))
      throw fail(403, 'Origen no permitido.');
    if (req.method === 'POST' && path === '/api/auth/recover') {
      rate('recovery:' + ip, 12, 900000);
      await crm.recover(await body(req));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/auth/mfa') {
      rate('auth:' + ip, 240, 3600000);
      const done = mfa.complete(await body(req));
      setSession(res, done.user);
      audit(done.user, done.used === 'recovery' ? 'mfa.login.recovery' : 'mfa.login', done.user.id);
      return json(res, 200, {
        user: safeUser(done.user),
        usedRecovery: done.used === 'recovery',
        recoveryLeft: done.recoveryLeft,
      });
    }
    if (req.method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(path)) {
      rate('auth:' + ip, 240, 3600000);
      const input = await body(req),
        username = clean(input.username, 40).toLowerCase(),
        password = typeof input.password === 'string' ? input.password : '';
      rate('auth-user:' + username, 20, 900000);
      if (!/^[a-z0-9_.-]{3,40}$/.test(username) || password.length < 8 || password.length > 128)
        throw fail(400, 'Usa un usuario de 3 a 40 caracteres y una contraseña de 8 a 128 caracteres.');
      let user;
      if (path.endsWith('register')) {
        const name = clean(input.name, 60);
        if (name.length < 2) throw fail(400, 'Escribe tu nombre.');
        if (db.prepare('SELECT id FROM users WHERE username=?').get(username))
          throw fail(409, 'Ese usuario ya existe. Elige otro o inicia sesión.');
        const code = clean(input.inviteCode, 200);
        let role = 'customer';
        if (code) {
          if (
            !db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get() &&
            secureEqual(code, process.env.ADMIN_INVITE_CODE)
          )
            role = 'admin';
          else crm.inviteFor(code, username);
        }
        const password_hash = await passwordHash(password);
        const id = randomUUID(),
          now = Date.now();
        transaction(db, () => {
          if (role === 'admin' && db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get())
            throw fail(409, 'El administrador ya fue configurado. Solicita una invitación individual.');
          const number = db.prepare('SELECT COALESCE(MAX(test_number),100000)+1 n FROM users').get().n;
          db.prepare(
            'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
          ).run(id, username, name, password_hash, role, number, now, now);
          if (code && role !== 'admin') crm.acceptInvite(code, { id, username, role });
        });
        user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
        audit(user, 'profile.created', id);
      } else {
        user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
        if (!user || user.disabled || !(await checkPassword(password, user.password_hash)))
          throw fail(401, 'Usuario o contraseña incorrectos.');
      }
      if (!path.endsWith('register') && mfa.isEnabled(user.id))
        return json(res, 200, { mfaRequired: true, challenge: mfa.challenge(user.id) });
      setSession(res, user);
      return json(res, 200, { user: safeUser(user) });
    }
    if (path.startsWith('/api/')) {
      const user = requireUser(req);
      if (await connectors.handle(req, res, path, user)) return;
      if (await whatsapp.handle(req, res, path, user)) return;
      if (await flows.handle(req, res, path, user)) return;
      if (await coordination.handle(req, res, path, user)) return;
      if (await finance.handle(req, res, path, user)) return;
      if (await persons.handle(req, res, path, user)) return;
      if (await certificates.handle(req, res, path, user)) return;
      if (await content.handle(req, res, path, user)) return;
      if (await surveys.handle(req, res, path, user)) return;
      if (await core.handle(req, res, path, user)) return;
      if (await legacy.handle(req, res, path, user)) return;
      if (await events.handle(req, res, path, user)) return;
      if (await payments.handle(req, res, path, user)) return;
      if (readiness.handle(req, res, path, user)) return;
      if (await channel.handle(req, res, path, user)) return;
      if (await simulator.handle(req, res, path, user)) return;
      if (await operations.handle(req, res, path, user)) return;
      if (await backupHandle(req, res, path, user, { json, audit })) return;
      if (await recipes.handle(req, res, path, user)) return;
      if (await campaigns.handle(req, res, path, user)) return;
      if (await portal.handle(req, res, path, user)) return;
      if (await push.handle(req, res, path, user)) return;
      if (await quickReplies.handle(req, res, path, user)) return;
      if (await automation.handle(req, res, path, user, { body, json, audit })) return;
      if (await catalogueImport.handle(req, res, path, user)) return;
      if (await knowledgeImport.handle(req, res, path, user)) return;
      if (await ads.handle(req, res, path, user)) return;
      if (await allies.handle(req, res, path, user)) return;
      if (await summaries.handle(req, res, path, user)) return;
      if (await scheduled.handle(req, res, path, user)) return;
      if (await appointments.handle(req, res, path, user)) return;
      if (await coupons.handle(req, res, path, user)) return;
      if (await integrations.handle(req, res, path, user)) return;
      if (await aiStatus.handle(req, res, path, user)) return;
      if (await catalogue.handle(req, res, path, user)) return;
      if (await mfa.handle(req, res, path, user)) return;
      if (await replies.handle(req, res, path, user, { body, json, audit, accessConversation })) return;
      if (await analytics.handle(req, res, path, user)) return;
      if (await presentation.handle(req, res, path, user)) return;
      if (await evaluation.handle(req, res, path, user)) return;
      if (await contacts.handle(req, res, path, user)) return;
      if (await crm.handle(req, res, path, user)) return;
      if (await modules.handle(req, res, path, user, url)) return; // módulos nuevos: /api/<nombre>/…
      if (req.method === 'POST' && path === '/api/auth/logout') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.token_hash);
        for (const [ws, u] of sessions) if (u.token_hash === user.token_hash) ws.close(1000, 'Sesión cerrada');
        res.setHeader(
          'Set-Cookie',
          'tc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' + (production ? '; Secure' : ''),
        );
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/bootstrap')
        return json(res, 200, {
          user: safeUser(user),
          brands: crm.brandsFor(user),
          courses: db
            .prepare('SELECT * FROM courses WHERE active=1 ORDER BY title')
            .all()
            .filter(c => user.role === 'customer' || crm.canBrand(user, c.brand_id))
            .map(publicCourse),
          editions: db
            .prepare("SELECT * FROM editions WHERE status='published' ORDER BY starts_at")
            .all()
            .filter(e => (user.role === 'customer' || crm.canBrand(user, e.brand_id)) && !catalogue.editionState(e))
            .map(e => ({
              ...e,
              priceCents: catalogue.info(e.course_id, e.id).priceCents,
              dateLabel: catalogue.info(e.course_id, e.id).dateLabel,
            })),
          conversations: conversationList(user),
          onlineAgents: [...new Set([...sessions.values()].filter(staff).map(x => x.id))].length,
        });
      if (req.method === 'GET' && path === '/api/conversations') {
        const offset = Math.max(0, Math.min(100000, Number(url.searchParams.get('offset')) || 0));
        const page = conversationPage(
          db,
          user,
          {
            q: clean(url.searchParams.get('q'), 100),
            offset: Math.floor(offset),
            cursor: url.searchParams.get('cursor'),
            brand: url.searchParams.get('brand'),
            channel: url.searchParams.get('channel'),
            filter: url.searchParams.get('filter'),
            tag: url.searchParams.get('tag'),
            mode: url.searchParams.get('mode'),
          },
          online,
        );
        return json(res, 200, { ...page, conversations: channel.decorate(page.conversations) });
      }
      const detail = path.match(/^\/api\/conversations\/([a-f0-9-]+)$/);
      if (detail && req.method === 'GET') {
        const c = channel.decorate(conversationPage(db, user, { id: detail[1] }, online).conversations)[0];
        if (!c) throw fail(404, 'Conversación no disponible.');
        return json(res, 200, { conversation: c });
      }
      if (req.method === 'POST' && path === '/api/conversations') {
        rate('new:' + user.id, 20);
        const input = await body(req);
        const course = db.prepare('SELECT * FROM courses WHERE id=? AND active=1').get(clean(input.courseId, 60));
        if (!course || !['whatsapp', 'instagram', 'facebook'].includes(input.channel))
          throw fail(400, 'Elige un curso y un canal válidos.');
        if (staff(user)) crm.requireBrand(user, course.brand_id);
        const editionId = clean(input.editionId, 100) || defaultEditionId(course.id),
          context = catalogue.info(course.id, editionId);
        if (context.reason) throw fail(409, context.reason + '. Elige otra edición.');
        let c = db
          .prepare(
            "SELECT * FROM conversations WHERE customer_id=? AND course_id=? AND edition_id=? AND channel=? AND status!='resolved'",
          )
          .get(user.id, course.id, editionId, input.channel);
        if (!c) {
          const id = randomUUID(),
            now = Date.now();
          db.prepare(
            'INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at,edition_id,referral) VALUES(?,?,?,?,?,?,?,?,?)',
          ).run(
            id,
            user.id,
            course.brand_id,
            course.id,
            input.channel,
            now,
            now,
            editionId,
            staff(user) ? null : channel.referralInput(input),
          );
          c = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
          audit(user, 'conversation.created', id);
          events.publish({
            type: 'conversacion.abierta',
            brandId: course.brand_id,
            entityKind: 'conversation',
            entityId: id,
            payload: {
              channel: input.channel,
              courseId: course.id,
              editionId,
              referral: c.referral ? true : false,
              customerId: user.id,
            },
            actorId: user.id,
            source: 'inbox',
          });
          broadcast('conversation', id);
        }
        transaction(db, () => crm.syncConversation(c));
        broadcast('crm', null, { brandId: c.brand_id });
        return json(res, 200, {
          conversation: channel.decorate(conversationPage(db, user, { id: c.id }, online).conversations)[0],
        });
      }
      const messages = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/messages$/);
      if (messages) {
        const c = accessConversation(messages[1], user);
        if (req.method === 'GET') {
          const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER,
            q = clean(url.searchParams.get('q'), 100);
          if (q) {
            const matches = db
              .prepare(
                'SELECT m.id,m.seq,m.text,m.sender_kind,m.created_at,u.name sender_name FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.conversation_id=? AND m.seq<? AND instr(search_text(m.text),search_text(?))>0 ORDER BY m.seq DESC LIMIT 51',
              )
              .all(c.id, before, q);
            return json(res, 200, {
              messages: matches.slice(0, 50),
              nextBefore: matches.length > 50 ? matches[49].seq : null,
            });
          }
          return json(res, 200, { messages: messageList(c.id, before) });
        }
        if (req.method === 'POST') {
          rate('send:' + user.id, 45);
          const input = await body(req),
            text = clean(input.text),
            clientRef = clean(input.clientRef, 100);
          if (!/^[a-zA-Z0-9-]{16,100}$/.test(clientRef) || (!text && !input.attachment))
            throw fail(400, 'Escribe un mensaje o adjunta un archivo.');
          const ref = user.id + ':' + clientRef;
          const existing = db.prepare('SELECT id,conversation_id FROM messages WHERE client_ref=?').get(ref);
          if (existing) {
            if (existing.conversation_id !== c.id) throw fail(409, 'Referencia ya utilizada.');
            return json(res, 200, { id: existing.id, duplicate: true });
          }
          if (c.status === 'resolved')
            throw fail(409, 'La conversación está cerrada. Abre una nueva para continuar la prueba.');
          const isCustomer = c.customer_id === user.id && !input.asAgent;
          if (!isCustomer) {
            requireStaff(user);
            crm.requireBrand(user, c.brand_id);
            if (c.assigned_to && c.assigned_to !== user.id && user.role !== 'admin')
              throw fail(409, 'Otro asesor está atendiendo esta conversación.');
          }
          const attachment = attachmentData(input.attachment);
          let attachmentId = null;
          if (attachment) {
            attachmentId = randomUUID();
            await writeFile(resolve(dataDir, 'uploads', attachment.storageName), attachment.buffer, { flag: 'wx' });
          }
          let messageId,
            duplicate = false;
          try {
            transaction(db, () => {
              const saved = db.prepare('SELECT id,conversation_id FROM messages WHERE client_ref=?').get(ref);
              if (saved) {
                if (saved.conversation_id !== c.id) throw fail(409, 'Referencia ya utilizada.');
                messageId = saved.id;
                duplicate = true;
                return;
              }
              const current = accessConversation(c.id, user);
              if (current.status === 'resolved') throw fail(409, 'La conversación se cerró mientras enviabas.');
              if (!isCustomer && current.assigned_to && current.assigned_to !== user.id && user.role !== 'admin')
                throw fail(409, 'Otro asesor tomó la conversación.');
              if (attachment)
                db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)').run(
                  attachmentId,
                  c.id,
                  user.id,
                  attachment.filename,
                  attachment.storageName,
                  attachment.mime,
                  attachment.buffer.length,
                  Date.now(),
                );
              if (!isCustomer) {
                replies.consumeSuggestions(c.id);
                crm.assignConversation(c, user.id);
                db.prepare("UPDATE conversations SET bot_enabled=0,assigned_to=?,status='open' WHERE id=?").run(
                  user.id,
                  c.id,
                );
                db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(c.id);
                cancelConversationSteps(db, c.id, 'human_takeover');
              }
              if (isCustomer && !attachmentId) replies.resumeIfPausedByMode(current); // la marca ya responde sola y el chat solo esperaba por el nivel anterior
              messageId = insertMessage(c, user, text, isCustomer ? 'customer' : 'agent', ref, attachmentId);
              const receiptId =
                isCustomer && attachmentId ? payments.attachReceipt(current, messageId, attachmentId) : null; // un adjunto con pedido vigente es un comprobante: cola humana, sin bot
              if (isCustomer && !receiptId && current.bot_enabled && !current.assigned_to)
                db.prepare('INSERT INTO jobs(id,conversation_id,message_id,due_at) VALUES(?,?,?,?)').run(
                  randomUUID(),
                  c.id,
                  messageId,
                  Date.now() + 700,
                );
            });
          } catch (error) {
            if (attachment) await unlink(resolve(dataDir, 'uploads', attachment.storageName)).catch(() => {});
            throw error;
          }
          if (duplicate && attachment)
            await unlink(resolve(dataDir, 'uploads', attachment.storageName)).catch(() => {});
          broadcast('conversation', c.id);
          return json(res, duplicate ? 200 : 201, { id: messageId, duplicate });
        }
      }
      const read = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/read$/);
      if (read && req.method === 'POST') {
        const c = accessConversation(read[1], user);
        const input = await body(req);
        if (input.asAgent) {
          requireStaff(user);
          crm.requireBrand(user, c.brand_id);
        }
        const max = Number(input.upTo) || 0;
        if (!Number.isSafeInteger(max) || max < 0) throw fail(400, 'Lectura no válida.');
        const kind =
          c.customer_id === user.id && !input.asAgent
            ? "sender_kind IN ('agent','automation')"
            : "sender_kind='customer'";
        const changed = db
          .prepare(`UPDATE messages SET read_at=? WHERE conversation_id=? AND seq<=? AND read_at IS NULL AND ${kind}`)
          .run(Date.now(), c.id, max);
        if (c.customer_id === user.id && !input.asAgent) channel.markRead(c.id, max);
        if (changed.changes) broadcast('read', c.id);
        return json(res, 200, { ok: true });
      }
      const action = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/action$/);
      if (action && req.method === 'POST') {
        requireStaff(user);
        const input = await body(req);
        transaction(db, () => {
          const c = accessConversation(action[1], user);
          crm.requireBrand(user, c.brand_id);
          if (c.assigned_to && c.assigned_to !== user.id && user.role !== 'admin')
            throw fail(409, 'Otro asesor está atendiendo esta conversación.');
          if (c.status === 'resolved' && input.action !== 'stage')
            throw fail(409, 'La conversación está cerrada. El cliente puede iniciar otra prueba.');
          if (input.action === 'take') {
            operations.assign(c, user.id, user, 'Toma manual');
          } else if (input.action === 'automate')
            db.prepare(
              "UPDATE conversations SET assigned_to=NULL,bot_enabled=1,status='open',updated_at=? WHERE id=?",
            ).run(Date.now(), c.id);
          else if (input.action === 'resolve')
            db.prepare("UPDATE conversations SET bot_enabled=0,status='resolved',updated_at=? WHERE id=?").run(
              Date.now(),
              c.id,
            );
          else if (
            input.action === 'stage' &&
            ['nuevo', 'interesado', 'inscripcion', 'inscrito', 'ganada', 'perdida'].includes(input.stage)
          ) {
            crm.setStage(c, input.stage, user, input);
          } else throw fail(400, 'Acción no válida.');
          if (['resolve', 'automate'].includes(input.action))
            operations.reset(c, input.action === 'resolve' ? 'resolved' : 'automation.resumed', user);
          if (input.action !== 'stage') {
            db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(c.id);
            cancelConversationSteps(db, c.id, 'conversation_action');
          }
          audit(user, 'conversation.' + input.action, c.id);
        });
        broadcast('conversation', action[1]);
        return json(res, 200, { ok: true });
      }
      const template = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/template$/);
      if (template && req.method === 'POST') {
        requireStaff(user);
        const c = accessConversation(template[1], user),
          input = await body(req);
        crm.requireBrand(user, c.brand_id);
        if (c.status === 'resolved') throw fail(409, 'La conversación está cerrada.');
        if (c.assigned_to && c.assigned_to !== user.id && user.role !== 'admin')
          throw fail(409, 'Otro asesor está atendiendo.');
        const prepared = catalogue.prepare(c, input),
          text = prepared.text;
        const clientRef = clean(input.clientRef, 100);
        if (!/^[a-zA-Z0-9-]{16,100}$/.test(clientRef) || !['syllabus', 'price', 'flyer'].includes(input.kind))
          throw fail(400, 'Plantilla o referencia no válida.');
        const ref = user.id + ':' + clientRef;
        const existing = db.prepare('SELECT conversation_id FROM messages WHERE client_ref=?').get(ref);
        if (existing && existing.conversation_id !== c.id) throw fail(409, 'Referencia ya utilizada.');
        if (!db.prepare('SELECT id FROM messages WHERE client_ref=?').get(ref)) {
          transaction(db, () => {
            crm.assignConversation(c, user.id);
            insertMessage(c, user, text, 'agent', ref, null, prepared.flyerSnapshot ? c.course_id : null, prepared);
            db.prepare("UPDATE conversations SET bot_enabled=0,assigned_to=?,status='open' WHERE id=?").run(
              user.id,
              c.id,
            );
            db.prepare("UPDATE jobs SET state='cancelled' WHERE conversation_id=? AND state='pending'").run(c.id);
            cancelConversationSteps(db, c.id, 'human_takeover');
          });
          broadcast('conversation', c.id);
        }
        return json(res, 200, { ok: true });
      }
      const file = path.match(/^\/api\/files\/([a-f0-9-]+)$/);
      if (file && req.method === 'GET') {
        const f = db.prepare('SELECT * FROM attachments WHERE id=?').get(file[1]);
        if (!f) throw fail(404, 'Archivo no disponible.');
        accessConversation(f.conversation_id, user);
        const bytes = await readFile(resolve(dataDir, 'uploads', f.storage_name));
        res.writeHead(200, {
          'Content-Type': f.mime,
          'Content-Disposition': `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        });
        return res.end(bytes);
      }
      const snapshotImage = path.match(/^\/api\/messages\/([a-f0-9-]+)\/flyer$/);
      if (snapshotImage && req.method === 'GET') {
        const message = db.prepare('SELECT * FROM messages WHERE id=?').get(snapshotImage[1]);
        if (!message?.flyer_snapshot) throw fail(404, 'Flyer no disponible.');
        accessConversation(message.conversation_id, user);
        const snapshot = JSON.parse(message.flyer_snapshot);
        if (!snapshot) throw fail(404, 'Flyer no disponible.');
        if (snapshot.libraryFileId) return await catalogue.serveFile(res, snapshot.libraryFileId);
        return await serveFlyer(res, snapshot.course, snapshot.brand, snapshot.artworkId);
      }
      const image = path.match(/^\/api\/courses\/([a-zA-Z0-9-]+)\/flyer$/);
      if (image && req.method === 'GET') {
        const course = db.prepare('SELECT * FROM courses WHERE id=?').get(image[1]);
        if (!course) throw fail(404, 'Curso no disponible.');
        if (staff(user)) crm.requireBrand(user, course.brand_id);
        const ctx = catalogue.info(course.id, clean(url.searchParams.get('editionId'), 100) || null);
        if (ctx.reason) throw fail(409, ctx.reason);
        const prepared = catalogue.prepare(
          { course_id: course.id, edition_id: ctx.edition.id, brand_id: course.brand_id, channel: 'whatsapp' },
          { kind: 'flyer' },
        );
        if (prepared.flyerSnapshot.libraryFileId)
          return await catalogue.serveFile(res, prepared.flyerSnapshot.libraryFileId);
        return await serveFlyer(res, prepared.flyerSnapshot.course, ctx.brand, null);
      }
      if (path === '/api/catalog' && req.method === 'POST') {
        requireAdmin(user);
        const input = await body(req),
          title = clean(input.title, 100),
          brand = clean(input.brandId, 60),
          price = Number(input.price);
        if (
          !title ||
          !Number.isFinite(price) ||
          price < 0 ||
          price > 1000000 ||
          !clean(input.dateLabel) ||
          !clean(input.syllabus) ||
          !clean(input.welcome) ||
          !db.prepare('SELECT id FROM brands WHERE id=?').get(brand)
        )
          throw fail(400, 'Completa el título, la marca, el precio, la fecha, el temario y la presentación.');
        const id = input.id ? clean(input.id, 60) : randomUUID();
        if (input.id) {
          if (!db.prepare('SELECT id FROM courses WHERE id=? AND brand_id=?').get(id, brand))
            throw fail(404, 'Curso no disponible.');
          db.prepare(
            'UPDATE courses SET title=?,price_cents=?,date_label=?,syllabus=?,welcome=?,version=version+1,updated_at=? WHERE id=?',
          ).run(
            title,
            Math.round(price * 100),
            clean(input.dateLabel, 180),
            clean(input.syllabus, 5000),
            clean(input.welcome, 2000),
            Date.now(),
            id,
          );
        } else
          db.prepare(
            'INSERT INTO courses(id,brand_id,title,price_cents,date_label,syllabus,welcome,updated_at) VALUES(?,?,?,?,?,?,?,?)',
          ).run(
            id,
            brand,
            title,
            Math.round(price * 100),
            clean(input.dateLabel, 180),
            clean(input.syllabus, 5000),
            clean(input.welcome, 2000),
            Date.now(),
          );
        catalogue.legacyUpdated(db.prepare('SELECT * FROM courses WHERE id=?').get(id), user);
        audit(user, 'course.saved', id);
        broadcast('catalog');
        return json(res, 200, { ok: true, id });
      }
      if (path === '/api/brands' && req.method === 'POST') {
        requireAdmin(user);
        const input = await body(req),
          name = clean(input.name, 60);
        if (name.length < 2) throw fail(400, 'Escribe el nombre de la marca.');
        requireAdmin(db.prepare('SELECT * FROM users WHERE id=?').get(user.id));
        const id = randomUUID();
        transaction(db, () => {
          db.prepare('INSERT INTO brands VALUES(?,?,?,?)').run(
            id,
            name,
            clean(input.description, 200) || 'Marca de prueba',
            Date.now(),
          );
          seedBrandTemplates(db, id);
          seedBrandKnowledge(db, id);
          seedBrandEvaluation(db, id);
        });
        audit(user, 'brand.created', id);
        broadcast('catalog');
        return json(res, 201, { id });
      }
      if (path === '/api/metrics' && req.method === 'GET') {
        requireStaff(user);
        const list = db
            .prepare('SELECT * FROM conversations')
            .all()
            .filter(c => crm.canBrand(user, c.brand_id)),
          ids = new Set(list.map(c => c.id));
        const byChannel = ['whatsapp', 'instagram', 'facebook'].map(channel => ({
          channel,
          count: list.filter(c => c.channel === channel).length,
        }));
        const messages = db
          .prepare('SELECT conversation_id,COUNT(*) n FROM messages GROUP BY conversation_id')
          .all()
          .filter(m => ids.has(m.conversation_id))
          .reduce((n, m) => n + m.n, 0);
        const recent = db
          .prepare('SELECT a.*,u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300')
          .all()
          .filter(a => user.role === 'admin' || ids.has(a.entity_id))
          .slice(0, 15);
        return json(res, 200, {
          profiles:
            user.role === 'admin'
              ? db.prepare('SELECT COUNT(*) n FROM users').get().n
              : new Set(list.map(c => c.customer_id)).size,
          conversations: list.length,
          messages,
          waiting: list.filter(c => c.status === 'waiting').length,
          online: new Set(
            [...sessions.values()]
              .filter(u => user.role === 'admin' || u.id === user.id || list.some(c => c.customer_id === u.id))
              .map(u => u.id),
          ).size,
          byChannel,
          recent,
        });
      }
      throw fail(404, 'Ruta no disponible.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Método no permitido.');
    await statics.serve(req, res, path);
  } catch (error) {
    if (res.headersSent) return res.end();
    if (!error.status) console.error('Request failed:', error.name, error.message);
    json(res, error.status || 500, errorBody(error)); // { error, code?, field?, details? }: server/app/http.mjs
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const user = readSession(req);
  if (req.url !== '/realtime' || !user || !originAllowed(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  if ([...sessions.values()].filter(u => u.id === user.id).length >= 8) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    sessions.set(ws, user);
    ws.isAlive = true;
    db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), user.id);
    ws.send(JSON.stringify({ type: 'connected', user: safeUser(user) }));
    broadcast('presence');
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', raw => {
      try {
        rate('ws:' + user.id, 90);
        if (user.expires_at < Date.now()) return ws.close(1008, 'Sesión vencida');
        const event = JSON.parse(raw.toString());
        if (event.type === 'typing') {
          const currentUser = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
          const c = accessConversation(clean(event.conversationId, 60), currentUser);
          broadcast('typing', c.id, { name: user.name, userId: user.id, expiresAt: Date.now() + 3500 });
        }
      } catch {
        /* Ignore invalid client events. */
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      sessions.delete(ws);
      db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Date.now(), user.id);
      broadcast('presence');
    });
  });
});
const jobsTimer = setInterval(processJobs, 350);
const operationsTimer = setInterval(() => {
  try {
    operations.reconcile();
  } catch (e) {
    console.error('Operations tick failed:', e.name, e.message);
  }
}, 1000);
const automationTimer = setInterval(() => {
  try {
    recipes.scan();
  } catch (e) {
    console.error('Recipe scan failed:', e.name);
  }
  try {
    campaigns.scan();
  } catch (e) {
    console.error('Campaign scan failed:', e.name);
  }
  automation.tick().catch(e => console.error('Automation tick failed:', e.name));
}, 1000);
const paymentsTimer = setInterval(() => {
  payments.tick().catch(e => console.error('Payments tick failed:', e.name));
}, 30000);
setTimeout(() => payments.tick().catch(() => {}), 3000).unref();
const pushTimer = setInterval(() => {
  push.tick().catch(e => console.error('Push tick failed:', e.name));
}, 5000);
const channelTimer = setInterval(() => {
  channel.tick().catch(e => console.error('Channel tick failed:', e.name));
}, 500);
const eventsTimer = setInterval(() => {
  events.tick().catch(e => console.error('Events tick failed:', e.name));
}, 1000);
const coordinationTimer = setInterval(
  () => {
    coordination.tick().catch(e => console.error('Coordination tick failed:', e.name));
  },
  process.env.NODE_ENV === 'test' ? 5000 : 60000,
);
setTimeout(() => coordination.tick().catch(() => {}), 4000).unref();
const simulatorTimer = setInterval(
  () => simulator.tick().catch(e => console.error('Simulator tick failed:', e.name)),
  1000,
);
const backupTimer = setInterval(() => backups.tick(), 10 * 60 * 1000);
setTimeout(() => backups.tick(), 5000).unref();
const scheduledTimer = setInterval(
  () => {
    try {
      scheduled.tick();
      appointments.tick();
    } catch (e) {
      console.error('Scheduled tick failed:', e.name);
    }
  },
  process.env.NODE_ENV === 'test' ? 1000 : 5000,
);
const webhooksTimer = setInterval(
  () => {
    integrations.tick().catch(e => console.error('Webhooks tick failed:', e.name));
  },
  process.env.NODE_ENV === 'test' ? 300 : 2000,
);
const heartbeat = setInterval(() => {
  for (const [ws, user] of sessions) {
    if (
      !ws.isAlive ||
      user.expires_at < Date.now() ||
      !db.prepare('SELECT token_hash FROM sessions WHERE token_hash=?').get(user.token_hash)
    ) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  limiter.sweep(now);
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
}, 30000);
modules.startTimers();
server.listen(port, host, () => console.log(`TEC Capital Laboratorio: http://${host}:${server.address().port}`));
function stop() {
  modules.stopTimers();
  clearInterval(webhooksTimer);
  clearInterval(scheduledTimer);
  clearInterval(jobsTimer);
  clearInterval(operationsTimer);
  clearInterval(automationTimer);
  clearInterval(simulatorTimer);
  clearInterval(channelTimer);
  clearInterval(paymentsTimer);
  clearInterval(backupTimer);
  clearInterval(heartbeat);
  for (const ws of sessions.keys()) ws.close(1001, 'Servidor reiniciando');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
