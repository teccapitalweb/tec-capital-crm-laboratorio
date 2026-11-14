// Módulos nuevos del servidor. Cada uno vive en server/modules/<nombre>/module.mjs y se monta solo: dar de alta
// un módulo no edita server/index.mjs, así que dos frentes de trabajo no tocan el mismo archivo de cableado.
//
//   export default {
//     name: 'broadcasts',                 // igual que la carpeta
//     prefixes: ['/api/broadcasts'],      // opcional; por omisión, /api/<name>. Rutas CON sesión.
//     create(host) {                      // se llama una vez, después de crear los módulos actuales
//       return { handle, tick };          // handle(req, res, path, user, url) → true si atendió la petición
//     },
//     public: {                           // opcional: rutas SIN sesión ni comprobación de Origin
//       prefixes: ['/api/compat/v1'],     // el módulo responde de su propia llave o firma y de su límite por IP
//       handle: (api, req, res, path, url, ip) => api.handlePublic(req, res, path, url, ip),
//     },
//     timers: [{ name: 'envio', everyMs: 1000, testEveryMs: 200, run: api => api.tick() }],   // opcional
//   };
//
// `host` es lo que el servidor presta: db, transaction, fail, clean, json, body, audit, rate, broadcast, los
// servicios actuales (host.services.crm, .events, .catalogue…) y host.module('otro') para hablar con otro módulo
// nuevo (se resuelve al usarlo, no al crear, así que el orden de carga no importa).
//
// Reglas:
//   - Toda ruta de un módulo vive bajo sus prefijos; ninguno puede pisar una ruta del servidor actual ni de otro módulo.
//   - El SQL del módulo va en su repo.mjs (funciones con brandId como primer parámetro); el alcance por marca lo
//     impone el módulo en cada consulta.
//   - Nada de red dentro de una transacción. Las migraciones van en server/migrations/named/<área>/.
//   - Un reloj no se pisa a sí mismo (si la pasada anterior no terminó, la siguiente se salta), trabaja por trozos
//     y no corre más de una vez por segundo salvo que lo declare con `fast: true`.
//
// Una carpeta que empieza por «_» no es un módulo (código compartido entre módulos).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const API_PREFIX = /^\/api\/[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;
const PUBLIC_PREFIX = /^\/[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;

// Primeros segmentos de /api/ que ya atiende el servidor actual: un módulo nuevo no puede reclamar nada ahí.
// test/modules.test.mjs comprueba que esta lista sigue al día con el código.
export const RESERVED = Object.freeze([
  'ads',
  'ai',
  'allies',
  'analytics',
  'appointments',
  'auth',
  'automation',
  'backups',
  'bootstrap',
  'brands',
  'campaigns',
  'catalog',
  'catalogue',
  'certificates',
  'channel',
  'channel-requests',
  'connectors',
  'content',
  'conversations',
  'coordination',
  'core',
  'coupons',
  'courses',
  'crm',
  'evaluation',
  'events',
  'files',
  'finance',
  'flows',
  'health',
  'integrations',
  'knowledge-import',
  'legacy',
  'library',
  'messages',
  'metrics',
  'mfa',
  'operations',
  'password',
  'pay',
  'payments',
  'persons',
  'portal',
  'presentation',
  'profile',
  'push',
  'quick-replies',
  'readiness',
  'replies',
  'scheduled',
  'simulator',
  'survey',
  'surveys',
  'team',
  'v1',
  'verify',
  'webhooks',
  'whatsapp',
]);

// Rutas sin sesión que ya existen (o que son de la aplicación): una ruta pública de un módulo no puede coincidir
// con ninguna, ni quedar por encima o por debajo de ellas.
export const PUBLIC_RESERVED = Object.freeze([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/mfa',
  '/api/auth/recover',
  '/api/auth/register',
  '/api/health',
  '/api/pay',
  '/api/survey',
  '/api/v1',
  '/api/verify',
  '/api/webhooks',
  '/aliados',
  '/crm',
  '/encuesta',
  '/flyers',
  '/kit',
  '/mcp',
  '/privacidad',
  '/realtime',
  '/screens',
  '/vendor',
  '/verificar',
]);

const covers = (prefix, path) => path === prefix || path.startsWith(prefix + '/');
const overlap = (a, b) => covers(a, b) || covers(b, a);
const kebab = key => key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());

// Comprueba el descriptor y devuelve sus prefijos ya resueltos.
function validate(definition, folder, taken) {
  const where = `server/modules/${folder}/module.mjs`;
  const bad = message => new Error(`${where}: ${message}`);
  if (!definition || typeof definition !== 'object') throw bad('debe exportar por omisión un objeto.');
  if (definition.name !== folder) throw bad(`«name» debe ser igual al nombre de la carpeta (${folder}).`);
  if (!NAME.test(folder)) throw bad('el nombre admite minúsculas, números y guiones.');
  if (taken.services.has(folder)) throw bad(`«${folder}» ya es un servicio del servidor actual; elige otro nombre.`);
  if (typeof definition.create !== 'function') throw bad('falta create(host).');

  const prefixes = definition.prefixes ?? ['/api/' + folder];
  if (!Array.isArray(prefixes) || !prefixes.length) throw bad('«prefixes» debe ser una lista con al menos una ruta.');
  for (const prefix of prefixes) {
    if (!API_PREFIX.test(prefix)) throw bad(`prefijo no válido: ${prefix} (debe empezar por /api/).`);
    if (RESERVED.includes(prefix.split('/')[2])) throw bad(`${prefix} ya lo atiende el servidor actual.`);
  }
  const open = definition.public ? (definition.public.prefixes ?? []) : [];
  if (definition.public) {
    if (typeof definition.public.handle !== 'function')
      throw bad('«public» necesita handle(api, req, res, path, url, ip).');
    if (!Array.isArray(open) || !open.length) throw bad('«public.prefixes» debe listar al menos una ruta.');
    for (const prefix of open) {
      if (!PUBLIC_PREFIX.test(prefix)) throw bad(`ruta pública no válida: ${prefix}.`);
      const clash = PUBLIC_RESERVED.find(reserved => overlap(reserved, prefix));
      if (clash || prefix === '/api') throw bad(`la ruta pública ${prefix} choca con ${clash ?? 'toda la API'}.`);
    }
  }
  for (const prefix of [...prefixes, ...open]) {
    const owner = taken.prefixes.find(claim => overlap(claim.prefix, prefix));
    if (owner) throw bad(`${prefix} choca con ${owner.prefix}, del módulo «${owner.module}».`);
  }
  if (prefixes.some(a => open.some(b => overlap(a, b)))) throw bad('una misma ruta no puede ser pública y con sesión.');

  for (const timer of definition.timers ?? []) {
    if (!timer || typeof timer.run !== 'function') throw bad('cada reloj necesita run(api).');
    if (!(timer.everyMs >= (timer.fast ? 250 : 1000)))
      throw bad('un reloj corre como mucho una vez por segundo (o cada 250 ms si declara fast: true).');
    if (timer.testEveryMs !== undefined && !(timer.testEveryMs >= 20))
      throw bad('testEveryMs debe ser de al menos 20.');
  }
  return { prefixes, open };
}

// Descubre y crea los módulos de `dir`, en orden alfabético. Con `strict` (pruebas) un módulo que no carga es un
// error; sin él (el servidor) se omite y queda en `failed`, para que un módulo roto no impida arrancar lo demás.
export async function loadModules({ dir, host = {}, strict = false, test = false, log = console }) {
  const byName = new Map();
  const failed = [];
  const timers = [];
  const taken = { services: new Set(Object.keys(host.services ?? {}).map(kebab)), prefixes: [] };
  const routes = { session: [], open: [] };
  let running = [];
  const moduleHost = {
    ...host,
    module(name) {
      const found = byName.get(name);
      if (!found) throw new Error(`No hay un módulo «${name}».`);
      return found.api;
    },
  };
  const folders = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
        .map(entry => entry.name)
        .sort()
    : [];
  for (const folder of folders) {
    try {
      const file = join(dir, folder, 'module.mjs');
      if (!existsSync(file)) throw new Error(`server/modules/${folder}: falta module.mjs.`);
      const definition = (await import(pathToFileURL(file).href)).default;
      const { prefixes, open } = validate(definition, folder, taken);
      const api = (await definition.create(moduleHost)) ?? {};
      byName.set(folder, { name: folder, api });
      for (const prefix of prefixes) routes.session.push({ prefix, module: folder, api });
      for (const prefix of open) routes.open.push({ prefix, module: folder, api, handle: definition.public.handle });
      for (const prefix of [...prefixes, ...open]) taken.prefixes.push({ prefix, module: folder });
      for (const timer of definition.timers ?? [])
        timers.push({ module: folder, api, ...timer, stats: { runs: 0, failures: 0, lastMs: 0, lastAt: 0 } });
    } catch (error) {
      if (strict) throw error;
      failed.push({ name: folder, error: String(error?.message ?? error).slice(0, 300) });
      log.error(`Módulo «${folder}» sin cargar:`, String(error?.message ?? error).slice(0, 300));
    }
  }

  // Rutas con sesión: el módulo que reclama el prefijo. Devuelve true si atendió la petición.
  async function handle(req, res, path, user, url) {
    const route = routes.session.find(claim => covers(claim.prefix, path));
    if (!route || typeof route.api.handle !== 'function') return false;
    return (await route.api.handle(req, res, path, user, url)) === true;
  }
  // Rutas sin sesión: se atienden antes de comprobar Origin y sesión, como los webhooks y la API con llave.
  async function handlePublic(req, res, path, url, ip) {
    const route = routes.open.find(claim => covers(claim.prefix, path));
    if (!route) return false;
    return (await route.handle(route.api, req, res, path, url, ip)) === true;
  }

  function startTimers() {
    if (running.length) return;
    running = timers.map(timer => {
      let busy = false;
      const label = `${timer.module}/${timer.name ?? 'tick'}`;
      const fire = async () => {
        if (busy) return; // la pasada anterior no ha terminado
        busy = true;
        const started = Date.now();
        try {
          await timer.run(timer.api);
        } catch (error) {
          timer.stats.failures++;
          log.error(`Reloj ${label} falló:`, error?.name ?? error, String(error?.message ?? '').slice(0, 200));
        } finally {
          timer.stats.runs++;
          timer.stats.lastAt = started;
          timer.stats.lastMs = Date.now() - started;
          busy = false;
        }
      };
      return setInterval(fire, test ? (timer.testEveryMs ?? timer.everyMs) : timer.everyMs);
    });
  }
  function stopTimers() {
    for (const timer of running) clearInterval(timer);
    running = [];
  }

  return {
    names: [...byName.keys()],
    failed,
    get: name => byName.get(name)?.api ?? null,
    handle,
    handlePublic,
    startTimers,
    stopTimers,
    // Para la pantalla de estado: cuántas veces corrió cada reloj, cuánto tardó la última y cuándo fue.
    timerStats: () =>
      timers.map(timer => ({
        module: timer.module,
        name: timer.name ?? 'tick',
        everyMs: timer.everyMs,
        ...timer.stats,
      })),
  };
}
