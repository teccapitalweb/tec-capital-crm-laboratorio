import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { AUTH, settled, watch } from './helpers.mjs';

// El menú lateral agrupa las pantallas y pliega los grupos (public/app.js, sideNav). Esta prueba entra SIN grupos
// recordados, como una persona que llega por primera vez: las demás entran con todos abiertos (auth.setup.mjs).
test('menú: grupos plegados por omisión, se abren, se recuerdan y no salta al cambiar de pantalla', async ({
  browser,
}, testInfo) => {
  const { cookies } = JSON.parse(readFileSync(AUTH.admin, 'utf8'));
  const context = await browser.newContext({ storageState: { cookies, origins: [] } });
  const page = await context.newPage();
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await settled(page);
  const entry = view => page.locator(`.nav [data-view="${view}"]`);
  const head = title => page.locator(`.nav-group-title[data-nav-group="${title}"]`);

  if (testInfo.project.name === 'celular') {
    // en celular el menú es una fila: no hay títulos y nada queda plegado
    await expect(head('Contactos')).toBeHidden();
    const hidden = await page
      .locator('.nav button[data-view]')
      .evaluateAll(buttons => buttons.filter(b => getComputedStyle(b).display === 'none').length);
    expect(hidden).toBe(0);
    watcher.done();
    await context.close();
    return;
  }

  // por omisión: Atención abierto y lo demás plegado
  await expect(head('Atención')).toHaveAttribute('aria-expanded', 'true');
  await expect(entry('inbox')).toBeVisible();
  await expect(entry('operations')).toBeVisible();
  await expect(head('Contactos')).toHaveAttribute('aria-expanded', 'false');
  await expect(entry('contactos')).toBeHidden();
  await expect(entry('difusiones')).toBeHidden();
  await expect(entry('settings')).toBeHidden();

  // abrir un grupo muestra sus pantallas; cada una está en su grupo
  await head('Contactos').click();
  await expect(head('Contactos')).toHaveAttribute('aria-expanded', 'true');
  for (const view of ['contacts', 'contactos', 'importar-contactos', 'audiencias', 'atributos'])
    await expect(entry(view)).toBeVisible();
  await head('WhatsApp').click();
  for (const view of ['difusiones', 'plantillas', 'salud']) await expect(entry(view)).toBeVisible();
  await head('Contactos').click();
  await expect(entry('contactos')).toBeHidden();

  // con todo abierto el menú se desplaza; al cambiar de pantalla se queda donde estaba
  for (const title of ['Contactos', 'Ventas', 'Resultados', 'Ajustes']) await head(title).click();
  const box = page.locator('.sidebar .nav').locator('xpath=..');
  await box.evaluate(el => (el.scrollTop = el.scrollHeight));
  const before = await box.evaluate(el => el.scrollTop);
  expect(before, 'con todos los grupos abiertos el menú no cabe y se desplaza').toBeGreaterThan(40);
  await entry('settings').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi configuración');
  const after = await page
    .locator('.sidebar .nav')
    .locator('xpath=..')
    .evaluate(el => el.scrollTop);
  expect(after, 'el menú no vuelve arriba al cambiar de pantalla').toBeGreaterThan(before - 60);

  // lo abierto y lo cerrado se recuerda al recargar; el grupo de la pantalla actual siempre queda abierto
  await head('WhatsApp').click();
  await expect(entry('difusiones')).toBeHidden();
  await page.reload();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(head('WhatsApp')).toHaveAttribute('aria-expanded', 'false');
  await expect(head('Ventas')).toHaveAttribute('aria-expanded', 'true');
  await expect(entry('opportunities')).toBeVisible();
  await head('WhatsApp').click();
  await entry('salud').click();
  await expect(head('WhatsApp')).toHaveAttribute('aria-expanded', 'true');
  await settled(page);
  watcher.done();
  await context.close();
});
