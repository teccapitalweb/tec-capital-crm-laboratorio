import { test, expect } from '@playwright/test';
import { ADMIN, login, logout, settled, watch } from './helpers.mjs';

test('acceso del equipo: contraseña errónea, entrar, ver Mi día y salir', async ({ page }) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#auth-form')).toBeVisible();
  await expect(page.locator('#auth-form [name="name"]')).toHaveCount(0); // en /crm se entra, no se registra

  await login(page, { ...ADMIN, password: 'no-es-la-clave-123' });
  await expect(page.locator('#auth-error')).toBeVisible();
  await expect(page.locator('#auth-error')).toContainText('incorrectos');

  await login(page, ADMIN);
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('.nav [data-view="inbox"]')).toBeVisible();
  await expect(page.locator('#connection')).toHaveText('En tiempo real');
  await settled(page);
  await expect(page.locator('#page')).toContainText('Hola,');

  await logout(page);
  await expect(page.locator('#auth-form')).toBeVisible();
  watcher.done();
});

// Regresión: si la sesión se cierra mientras «Mi día» todavía está pidiendo sus datos, la respuesta tardía no
// debe intentar pintar en una pantalla que ya no existe.
test('cerrar sesión mientras carga Mi día no deja errores', async ({ page }) => {
  const watcher = watch(page);
  await page.route('**/api/crm', async route => {
    await new Promise(done => setTimeout(done, 600));
    await route.continue().catch(() => {});
  });
  await login(page, ADMIN);
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await logout(page);
  await expect(page.locator('#auth-form')).toBeVisible();
  await page.waitForTimeout(1200); // deja llegar las respuestas retrasadas
  watcher.done();
});
