import { test, expect } from '@playwright/test';
import { adminContext, watch } from './helpers.mjs';

test('un mensaje del cliente llega en vivo al equipo y la respuesta vuelve al cliente', async ({
  browser,
}, testInfo) => {
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  const question = `Hola, quiero informes ${tag}`;
  const answer = `Con gusto te ayudo ${tag}`;

  // El equipo ya está en Conversaciones antes de que el cliente escriba: el hilo debe aparecer sin recargar.
  const teamContext = await adminContext(browser);
  const team = await teamContext.newPage();
  const teamWatch = watch(team);
  await team.goto('/crm');
  await team.locator('.nav [data-view="inbox"]').click();
  await expect(team.locator('#breadcrumb-title')).toHaveText('Conversaciones');

  // El cliente se registra en la portada, abre una conversación y escribe.
  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const customerWatch = watch(customer);
  await customer.goto('/');
  await customer.locator('#auth-form [name="name"]').fill(`Cliente ${tag}`);
  await customer.locator('#auth-form [name="username"]').fill(`cliente.${tag}`);
  await customer.locator('#auth-form [name="password"]').fill('Password-cliente-2026!');
  await customer.locator('#auth-form button[type="submit"]').click();
  await customer.locator('[data-action="new-chat"]:visible').first().click();
  await expect(customer.locator('#new-chat-edition option')).not.toHaveCount(0);
  await customer.locator('#new-chat-form button[type="submit"]').click();
  await customer.locator('#message-input').fill(question);
  await customer.locator('#send-button').click();
  await expect(customer.locator('#history')).toContainText(question);

  // El hilo aparece en la bandeja del equipo, se abre y se contesta.
  const thread = team.locator('.thread', { hasText: `Cliente ${tag}` });
  await expect(thread).toBeVisible();
  await thread.click();
  await expect(team.locator('#history')).toContainText(question);
  await team.locator('#message-input').fill(answer);
  await team.locator('#send-button').click();
  await expect(team.locator('#history')).toContainText(answer);

  // La respuesta llega al cliente sin recargar.
  await expect(customer.locator('#history')).toContainText(answer);

  teamWatch.done();
  customerWatch.done();
  await teamContext.close();
  await customerContext.close();
});
