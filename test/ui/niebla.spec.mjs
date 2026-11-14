import { test, expect } from '@playwright/test';
import { AUTH, ensureUser, expectNiebla, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// Deja una conversación con un mensaje para que la bandeja y Contactos tengan algo que medir.
test.beforeAll(async ({ playwright, baseURL }) => {
  const request = await playwright.request.newContext({ baseURL });
  const headers = { Origin: baseURL };
  await ensureUser(request, baseURL, {
    username: 'cliente.niebla',
    name: 'Cliente de la auditoría',
    password: 'Password-niebla-2026!',
  });
  const { courses } = await (await request.get('/api/bootstrap')).json();
  const opened = await request.post('/api/conversations', {
    headers,
    data: { courseId: courses[0].id, channel: 'whatsapp' },
  });
  expect(opened.ok(), await opened.text()).toBe(true);
  const { conversation } = await opened.json();
  const sent = await request.post(`/api/conversations/${conversation.id}/messages`, {
    headers,
    data: { text: 'Hola, ¿me comparten el temario?', clientRef: 'niebla-' + conversation.id },
  });
  expect(sent.ok(), await sent.text()).toBe(true);
  await request.dispose();
});

const VIEWS = [
  ['day', 'Mi día'],
  ['inbox', 'Conversaciones'],
  ['contacts', 'Contactos'],
  ['courses', 'Catálogo y biblioteca'],
];

test('Niebla en las vistas principales: letra, contraste, áreas táctiles y sin desborde', async ({
  page,
}, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  for (const [view, title] of VIEWS) {
    await page.locator(`.nav [data-view="${view}"]`).click();
    await expect(page.locator('#breadcrumb-title')).toHaveText(title);
    if (view === 'inbox') {
      await page.locator('.thread', { hasText: 'Cliente de la auditoría' }).first().click();
      await expect(page.locator('#history')).toContainText('temario');
      await expectNiebla(page, 'inbox-chat', testInfo);
      // en celular el chat ocupa la pantalla: se vuelve a la lista para seguir navegando
      const back = page.locator('[data-action="back"]:visible');
      if (await back.count()) await back.first().click();
      continue;
    }
    await expectNiebla(page, view, testInfo);
  }
  watcher.done();
});
