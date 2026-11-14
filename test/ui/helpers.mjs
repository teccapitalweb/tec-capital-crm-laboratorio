// Ayudantes de las pruebas de interfaz. Toda pantalla nueva trae su *.spec.mjs, que la monta en los dos tamaños
// (proyectos «escritorio» y «celular») y llama a expectNiebla.
import { expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nieblaAudit } from './niebla-audit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = resolve(here, 'niebla-baseline.json');

export const INVITE = 'codigo-de-prueba-ui-0001';
export const ADMIN = { username: 'direccion.ui', name: 'Dirección de prueba', password: 'Password-ui-2026!' };
export const AUTH = { admin: resolve(here, '.auth', 'admin.json') };

// Registra a la persona por la API (o inicia sesión si ya existe) y deja la cookie en ese contexto de peticiones.
export async function ensureUser(request, baseURL, user, { inviteCode } = {}) {
  const headers = { Origin: baseURL };
  const registered = await request.post('/api/auth/register', { headers, data: { ...user, inviteCode } });
  if (registered.ok()) return (await registered.json()).user;
  expect(registered.status(), await registered.text()).toBe(409);
  const logged = await request.post('/api/auth/login', {
    headers,
    data: { username: user.username, password: user.password },
  });
  expect(logged.ok(), await logged.text()).toBe(true);
  return (await logged.json()).user;
}

export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state));
}

// Un contexto de navegador con la sesión de administración ya iniciada.
export const adminContext = (browser, options = {}) => browser.newContext({ ...options, storageState: AUTH.admin });

// Vigila la página: errores de consola, errores sin capturar y respuestas 5xx. Llama a done() al final de la prueba.
// Un 4xx esperado (por ejemplo una contraseña errónea) deja en la consola «Failed to load resource»: no cuenta.
export function watch(page) {
  const problems = [];
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      problems.push('consola: ' + message.text());
  });
  page.on('pageerror', error => problems.push('error de página: ' + error.message));
  page.on('response', response => {
    if (response.status() >= 500) problems.push(`respuesta ${response.status()}: ${response.url()}`);
  });
  return { problems, done: () => expect(problems, 'la página no debe dejar errores').toEqual([]) };
}

// Espera a que la vista termine de pintarse: sin peticiones en curso, con texto y sin cambiar entre dos lecturas.
// Las vistas piden sus datos después de cambiar el título, así que el título solo no basta.
export async function settled(page, selector = '#page') {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(target => (document.querySelector(target)?.innerText ?? '').trim().length > 0, selector);
  let last = -1;
  for (let attempt = 0; attempt < 40; attempt++) {
    const size = await page.evaluate(target => document.querySelector(target)?.innerHTML.length ?? 0, selector);
    if (size === last) return;
    last = size;
    await page.waitForTimeout(150);
  }
}

export async function login(page, user, path = '/crm') {
  await page.goto(path);
  await page.locator('#auth-form [name="username"]').fill(user.username);
  await page.locator('#auth-form [name="password"]').fill(user.password);
  await page.locator('#auth-form button[type="submit"]').click();
}

// Cierra la sesión desde el menú. En celular ese botón se oculta y, para el equipo, «Mi perfil» abre la
// configuración: hoy el único camino es pasar a la vista de cliente y salir desde el perfil.
export async function logout(page) {
  const direct = page.locator('.sidebar [data-action="logout"]');
  if (await direct.isVisible()) return direct.click();
  const asCustomer = page.locator('[data-mode="customer"]:visible');
  if (await asCustomer.count()) await asCustomer.first().click();
  await page.locator('[data-action="profile"]:visible').first().click();
  await page.locator('#modal [data-action="logout"]').click();
}

// Reglas medibles de Niebla (docs/DISENO_Y_AUDITORIA.md) sobre la vista que esté en pantalla:
//   - ningún texto de menos de 11 px y ninguna barra de desplazamiento horizontal de la página;
//   - los fallos de contraste y, en celular, los controles de menos de 40 px no pueden superar la línea base.
// La línea base (niebla-baseline.json) se graba con UPDATE_NIEBLA=1 y sólo puede bajar. Una pantalla nueva no
// tiene línea base: su límite es cero.
export async function expectNiebla(page, name, testInfo) {
  await settled(page);
  const result = await page.evaluate(nieblaAudit);
  const key = `${testInfo.project.name}:${name}`;
  const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  if (process.env.UPDATE_NIEBLA === '1') {
    baseline[key] = { contrastFailures: result.contrastFailures, smallTargets: result.smallTargets };
    const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  }
  const limit = baseline[key] ?? { contrastFailures: 0, smallTargets: 0 };
  expect(result.total, `${key}: la vista tiene texto que medir`).toBeGreaterThan(0);
  expect(result.under11px, `${key}: textos de menos de 11 px → ${result.smallSample.join(' | ')}`).toBe(0);
  expect(result.overflowX, `${key}: la página se desborda a lo ancho`).toBe(0);
  expect(
    result.contrastFailures,
    `${key}: textos con poco contraste → ${result.contrastSample.join(' | ')}`,
  ).toBeLessThanOrEqual(limit.contrastFailures);
  if (testInfo.project.name === 'celular')
    expect(
      result.smallTargets,
      `${key}: controles de menos de 40 px → ${result.targetSample.join(' | ')}`,
    ).toBeLessThanOrEqual(limit.smallTargets);
  return result;
}
