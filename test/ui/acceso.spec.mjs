import { test, expect } from '@playwright/test';
import { ADMIN, login, logout, watch } from './helpers.mjs';

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

  await logout(page);
  await expect(page.locator('#auth-form')).toBeVisible();
  watcher.done();
});
