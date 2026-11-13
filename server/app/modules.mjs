// Módulos nuevos del servidor. Cada uno vive en server/modules/<nombre>/module.mjs y se monta solo: dar de alta
// un módulo no edita server/index.mjs, así que dos frentes de trabajo no tocan el mismo archivo de cableado.
//
//   export default {
//     name: 'broadcasts',                 // igual que la carpeta; es su prefijo: atiende /api/broadcasts y /api/broadcasts/…
//     create(host) {                      // se llama una vez, después de crear los módulos actuales
//       return { handle, tick };          // handle(req, res, path, user, url) → true si atendió la petición
//     },
//     timers: [{ name: 'envio', everyMs: 1000, testEveryMs: 200, run: api => api.tick() }],   // opcional
//   };
//
// `host` es lo que el servidor presta: db, transaction, fail, clean, json, body, audit, rate, broadcast, los
// servicios actuales (host.services.crm, .events, .catalogue…) y host.module('otro') para hablar con otro módulo
// nuevo (se resuelve al usarlo, no al crear, así que el orden de carga no importa).
//
// Reglas: sesión obligatoria (el servidor ya la exigió antes de llamar a handle); el alcance por marca lo impone
// el módulo en cada consulta; nada de red dentro de una transacción; las migraciones van en
// server/migrations/named/<área>/ y se apuntan en el registro.
//
// Una carpeta que empieza por «_» no es un módulo (código compartido entre módulos).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NAME = /^[a-z][a-z0-9-]{1,40}$/;

// Primeros segmentos de /api/ que ya atiende el servidor actual: un módulo nuevo no puede llamarse así.
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

function validate(definition, folder) {
  const where = `server/modules/${folder}/module.mjs`;
  if (!definition || typeof definition !== 'object') throw new Error(`${where}: debe exportar por omisión un objeto.`);
  if (definition.name !== folder)
    throw new Error(`${where}: «name» debe ser igual al nombre de la carpeta (${folder}).`);
  if (!NAME.test(folder)) throw new Error(`${where}: el nombre admite minúsculas, números y guiones.`);
  if (RESERVED.includes(folder)) throw new Error(`${where}: /api/${folder} ya lo atiende el servidor actual.`);
  if (typeof definition.create !== 'function') throw new Error(`${where}: falta create(host).`);
  for (const timer of definition.timers ?? []) {
    if (!timer || typeof timer.run !== 'function' || !(timer.everyMs >= 100))
      throw new Error(`${where}: cada reloj necesita run(api) y everyMs de al menos 100.`);
    if (timer.testEveryMs !== undefined && !(timer.testEveryMs >= 20))
      throw new Error(`${where}: testEveryMs debe ser de al menos 20.`);
  }
}

// Descubre y crea los módulos de `dir`, en orden alfabético. Con `strict` (pruebas) un módulo que no carga es un
// error; sin él (el servidor) se omite y queda en `failed`, para que un módulo roto no impida arrancar lo demás.
export async function loadModules({ dir, host = {}, strict = false, test = false, log = console }) {
  const byName = new Map();
  const failed = [];
  const timers = [];
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
      validate(definition, folder);
      const api = (await definition.create(moduleHost)) ?? {};
      byName.set(folder, { name: folder, api });
      for (const timer of definition.timers ?? []) timers.push({ module: folder, api, ...timer });
    } catch (error) {
      if (strict) throw error;
      failed.push({ name: folder, error: String(error?.message ?? error).slice(0, 300) });
      log.error(`Módulo «${folder}» sin cargar:`, String(error?.message ?? error).slice(0, 300));
    }
  }

  // /api/<nombre> o /api/<nombre>/…  → el módulo con ese nombre. Devuelve true si atendió la petición.
  async function handle(req, res, path, user, url) {
    const match = /^\/api\/([a-z][a-z0-9-]*)(?:\/|$)/.exec(path);
    const found = match && byName.get(match[1]);
    if (!found || typeof found.api.handle !== 'function') return false;
    return (await found.api.handle(req, res, path, user, url)) === true;
  }

  function startTimers() {
    if (running.length) return;
    running = timers.map(timer => {
      const report = error => log.error(`Reloj ${timer.module}/${timer.name ?? 'tick'} falló:`, error?.name ?? error);
      return setInterval(
        () => {
          try {
            const result = timer.run(timer.api);
            if (result && typeof result.catch === 'function') result.catch(report);
          } catch (error) {
            report(error);
          }
        },
        test ? (timer.testEveryMs ?? timer.everyMs) : timer.everyMs,
      );
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
    startTimers,
    stopTimers,
  };
}
