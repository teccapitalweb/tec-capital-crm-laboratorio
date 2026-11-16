import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminContext, expectNiebla, settled, watch } from './helpers.mjs';

// Ciclo de vida (docs/PLAN_CICLO_DE_VIDA.md): en la cabecera del chat, el chip con el estado de la conversación y sus
// acciones (Dejar pendiente, Quitar pendiente, Resolver, Reabrir). Cumple Niebla en computadora y celular con la línea
// base del chat («inbox-chat»): la barra nueva no añade fallos.
test('ciclo de vida: chip de estado y acciones en el chat', async ({ browser }, testInfo) => {
  const base = testInfo.project.use.baseURL;
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Cliente ciclo ${tag}`;

  // la persona escribe desde la experiencia de cliente (por la API, para no depender de su pantalla)
  const customerContext = await browser.newContext();
  const customer = customerContext.request;
  const headers = { Origin: base };
  await customer.post('/api/auth/register', {
    headers,
    data: { username: `cliente.ciclo.${tag}`, name, password: 'Password-cliente-2026!' },
  });
  const created = await customer.post('/api/conversations', {
    headers,
    data: { courseId: 'aves', channel: 'whatsapp' },
  });
  const { conversation } = await created.json();
  await customer.post(`/api/conversations/${conversation.id}/messages`, {
    headers,
    data: { text: 'Hola, quiero informes', clientRef: randomUUID() },
  });

  const teamContext = await adminContext(browser);
  const page = await teamContext.newPage();
  const watcher = watch(page);
  await page.goto('/crm');
  await page.locator('.nav [data-view="inbox"]').click();
  await page.locator('.thread', { hasText: name }).click();
  // espera a que el asistente conteste, para que nada cambie la revisión a mitad de la prueba
  await expect(page.locator('#history .message')).not.toHaveCount(1);
  const bar = page.locator('.lc-bar');
  await expect(bar.locator('.lc-chip')).toHaveText('Abierta');
  await expectNiebla(page, 'inbox-chat', testInfo);

  await bar.locator('[data-lc-to="pending"]').click();
  await expect(bar.locator('.lc-chip')).toHaveText('Pendiente');
  await expect(bar.locator('[data-lc-to="open"]')).toHaveText('Quitar pendiente');
  await settled(page);
  await expectNiebla(page, 'inbox-chat', testInfo);
  await bar.locator('[data-lc-to="open"]').click();
  await expect(bar.locator('.lc-chip')).toHaveText('Abierta');

  await bar.locator('[data-lc-to="solved"]').click();
  await expect(bar.locator('.lc-chip')).toHaveText('Resuelta');
  await expect(page.locator('.closed-notice')).toBeVisible();
  await bar.locator('[data-lc-to="open"]').click();
  await expect(bar.locator('.lc-chip')).toHaveText('Abierta');
  await expect(page.locator('#message-input')).toBeVisible();

  watcher.done();
  await teamContext.close();
  await customerContext.close();
});
