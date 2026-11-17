import { test, expect } from '@playwright/test';
import { AUTH, ensureUser, expectNiebla, settled, watch } from './helpers.mjs';
import { nieblaAudit } from './niebla-audit.mjs';

// Tinta (docs/DISENO_Y_AUDITORIA.md): los colores, formas y letra del rediseño, y el menú lateral en sus dos
// versiones. Lo que aquí se comprueba son las reglas del sistema, no el aspecto de una pantalla concreta.
test.use({ storageState: AUTH.admin });

const INK = 'rgb(22, 24, 29)';
const LIME = 'rgb(217, 242, 79)';
const WHITE = 'rgb(255, 255, 255)';
const PAGE = 'rgb(236, 238, 243)';

const styleOf = (locator, property) => locator.evaluate((el, p) => getComputedStyle(el)[p], property);

// El menú se mide entero: letra, contraste y (en celular) lo que se toca.
async function expectMenu(page, name, testInfo) {
  await page.waitForTimeout(300); // las filas cambian de color con una transición de 160 ms
  const result = await page.evaluate(nieblaAudit, '.sidebar');
  const key = `${testInfo.project.name}:${name}`;
  expect(result.total, `${key}: el menú tiene texto`).toBeGreaterThan(0);
  expect(result.under11px, `${key}: letra de menos de 11 px → ${result.smallSample.join(' | ')}`).toBe(0);
  expect(result.contrastFailures, `${key}: contraste → ${result.contrastSample.join(' | ')}`).toBe(0);
  if (testInfo.project.name === 'celular')
    expect(result.smallTargets, `${key}: controles de menos de 40 px → ${result.targetSample.join(' | ')}`).toBe(0);
}

test('Tinta: página gris, Manrope, botones en píldora y campos redondos', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await settled(page);
  await expect(page.locator('.workspace')).toHaveCSS('background-color', PAGE);
  expect(await styleOf(page.locator('body'), 'fontFamily')).toMatch(/^Manrope/);
  // Título de la vista en la escala nueva: 40 px en computadora, 30 px en celular, siempre en negrita máxima.
  const title = page.locator('#page .page-heading h1').first();
  await expect(title).toHaveCSS('font-size', testInfo.project.name === 'celular' ? '30px' : '40px');
  expect(Number(await styleOf(title, 'fontWeight'))).toBeGreaterThanOrEqual(800);

  await page.locator('.nav [data-view="settings"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi configuración');
  await settled(page);
  const primary = page.locator('#page .btn.primary').first();
  await expect(primary).toHaveCSS('background-color', INK);
  await expect(primary).toHaveCSS('color', WHITE);
  await expect(primary).toHaveCSS('border-radius', '999px');
  expect((await primary.boundingBox()).height).toBeGreaterThanOrEqual(40);
  const secondary = page.locator('#page .btn:not(.primary)').first();
  await expect(secondary).toHaveCSS('border-radius', '999px');
  const input = page.locator('#page .field input:not([type="checkbox"])').first();
  await expect(input).toHaveCSS('border-radius', '16px');
  await expect(input).toHaveCSS('border-top-width', '2px');
  const panel = page.locator('#page .crm-panel').first();
  await expect(panel).toHaveCSS('border-top-left-radius', '28px');
  await expect(panel).toHaveCSS('background-color', WHITE);
  await expectNiebla(page, 'tinta-ajustes', testInfo);
  watcher.done();
});

test('menú lateral: oscuro por omisión, claro a elección, recordado y medido en los dos temas', async ({
  page,
}, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await settled(page);
  const workspace = page.locator('.workspace');
  const sidebar = page.locator('.sidebar');
  const active = page.locator('.sidebar .nav button.active[data-view="day"]');
  const toggle = page.locator('.sidebar [data-menu-theme-toggle]');

  // Oscuro: tinta con la fila activa en lima y la marca en lima
  await expect(workspace).toHaveAttribute('data-menu', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(sidebar).toHaveCSS('background-color', INK);
  await expect(active).toHaveCSS('background-color', LIME);
  await expect(active).toHaveCSS('color', INK);
  await expect(page.locator('.sidebar .brand-mark')).toHaveCSS('background-color', LIME);
  if (testInfo.project.name === 'escritorio') {
    // El menú flota: separado del borde y con esquinas de 28 px
    await expect(sidebar).toHaveCSS('border-top-left-radius', '28px');
    expect((await sidebar.boundingBox()).x).toBeGreaterThanOrEqual(12);
  }
  await expectMenu(page, 'menu-oscuro', testInfo);

  // Claro: blanco con la fila activa en tinta; se recuerda al recargar
  await toggle.click();
  await expect(workspace).toHaveAttribute('data-menu', 'light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar).toHaveCSS('background-color', WHITE);
  await expect(active).toHaveCSS('background-color', INK);
  await expect(active).toHaveCSS('color', WHITE);
  await expectMenu(page, 'menu-claro', testInfo);
  expect(await page.evaluate(() => localStorage.getItem('tc-menu-theme'))).toBe('light');
  await page.reload();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('.workspace')).toHaveAttribute('data-menu', 'light');
  // Cambiar de pantalla no lo pierde (el menú se vuelve a dibujar)
  await page.locator('.nav [data-view="inbox"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Conversaciones');
  await expect(page.locator('.workspace')).toHaveAttribute('data-menu', 'light');

  // De vuelta a oscuro, para no cambiar las demás pruebas
  await page.locator('.sidebar [data-menu-theme-toggle]').click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-menu', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('tc-menu-theme'))).toBe('dark');
  watcher.done();
});

test('la experiencia del cliente conserva sus colores y no tiene el cambio de tema', async ({
  page,
  playwright,
  baseURL,
}) => {
  const request = await playwright.request.newContext({ baseURL });
  await ensureUser(request, baseURL, {
    username: 'cliente.tinta',
    name: 'Cliente de Tinta',
    password: 'Password-tinta-2026!',
  });
  const { cookies } = await request.storageState();
  await request.dispose();
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
  const watcher = watch(page);
  await page.goto('/');
  await expect(page.locator('.workspace.customer-skin')).toBeVisible();
  await settled(page);
  const accent = await page
    .locator('.workspace.customer-skin')
    .evaluate(el => getComputedStyle(el).getPropertyValue('--accent').trim());
  expect(accent).toBe('#2f6f8f');
  await expect(page.locator('[data-menu-theme-toggle]')).toHaveCount(0);
  watcher.done();
});
