import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Jornada simulada» (public/screens/jornada-simulada): la lista vacía y el formulario de nueva jornada; se crea una
// corta por la API (2 clientes en 1 minuto, ritmo rápido) y la pantalla la abre sola: configuración, bloques, cifras,
// la primera conversación llega en vivo, su chat se lee a un lado, pausar y reanudar, terminar. Cumple Niebla en
// computadora y celular y se desmonta al salir.

test('jornada simulada: formulario, jornada en vivo, chat, pausa y terminar', async ({ page, baseURL }, testInfo) => {
  const watcher = watch(page);
  // una jornada viva de otra corrida (o de otro proyecto) se termina y archiva antes, para ver la lista vacía
  const previas = await page.request.get('/api/jornada');
  for (const r of (await previas.json()).runs) {
    if (['planned', 'running', 'paused'].includes(r.state))
      await page.request.post(`/api/jornada/${r.id}/finish`, { headers: { Origin: baseURL }, data: {} });
    await page.request.post(`/api/jornada/${r.id}/archive`, { headers: { Origin: baseURL }, data: {} });
  }
  await page.goto('/crm');
  const entry = page.locator('.nav [data-view="jornada-simulada"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Jornada simulada');
  await settled(page);
  const pagina = page.locator('#page .jr-page');
  // sin jornada en curso: lista y botón; el formulario abre con sus campos
  await expect(pagina.getByRole('button', { name: 'Nueva jornada' })).toBeVisible();
  await expectNiebla(page, 'jornada-simulada', testInfo);
  await pagina.getByRole('button', { name: 'Nueva jornada' }).click();
  const dlg = page.locator('.k-dialog');
  await expect(dlg.locator('[name="brandId"]')).toBeVisible();
  await expect(dlg.locator('[data-do="perfil"]')).toHaveCount(9);
  await expect(dlg.locator('[data-do="aviso"]')).toHaveCount(5);
  await expect(dlg.locator('[data-do="ia"][data-id="claude"]')).toBeDisabled();
  await expect(dlg.locator('[name="aiCapUsd"]')).toHaveValue('3');
  await dlg.locator('[data-do="ritmo"][data-id="rafagas"]').click();
  await expect(dlg.locator('[data-do="ritmo"][data-id="rafagas"]')).toHaveAttribute('aria-pressed', 'true');
  await expectNiebla(page, 'jornada-simulada', testInfo);
  await dlg.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.locator('.k-dialog')).toHaveCount(0);

  // una jornada corta por la API (la pantalla la abre sola al avisar en vivo)
  const made = await page.request.post('/api/jornada', {
    headers: { Origin: baseURL },
    data: {
      brandId: 'globalvet',
      title: `Jornada UI ${testInfo.project.name}`,
      count: 2,
      minutes: 1,
      rhythm: 'parejo',
      pace: 'rapida',
      personas: ['curioso'],
      alerts: { waitMinutes: 1 },
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const run = (await made.json()).run;
  await expect(pagina.locator('.jr-estado')).toContainText('En curso', { timeout: 10_000 });
  await expect(pagina.locator('.jr-config')).toContainText('2 en 1 min');
  await expect(pagina.locator('.k-figure')).toHaveCount(6);
  await expect(pagina.locator('.jr-b')).toHaveCount(1);
  // el primer cliente llega y escribe; se lee su chat a un lado
  const conv = pagina.locator('.jr-conv:not([disabled])').first();
  await expect(conv).toBeVisible({ timeout: 20_000 });
  await expect(conv).toContainText('· demo');
  await conv.click();
  await expect(pagina.locator('.jr-msg--customer').first()).toBeVisible({ timeout: 15_000 });
  await expect(pagina.locator('[data-slot="chatTitulo"]')).toContainText('· demo');
  await settled(page);
  await expectNiebla(page, 'jornada-simulada', testInfo);
  // pausar y reanudar
  await pagina.getByRole('button', { name: 'Pausar llegadas' }).click();
  await expect(pagina.locator('.jr-estado')).toContainText('En pausa');
  await pagina.getByRole('button', { name: 'Reanudar llegadas' }).click();
  await expect(pagina.locator('.jr-estado')).toContainText('En curso');
  // terminar con confirmación
  await pagina.getByRole('button', { name: 'Terminar jornada' }).click();
  await page.locator('.k-dialog').getByRole('button', { name: 'Terminar' }).click();
  await expect(pagina.locator('.jr-estado')).toContainText('Terminada');
  await expect(pagina.getByRole('button', { name: /Archivar/ })).toBeVisible();
  // el informe: se arma al pedirlo y trae el resumen y cómo le fue a cada perfil
  await pagina.locator('.jr-informe').getByRole('button', { name: 'Ver el informe' }).click();
  await expect(pagina.locator('.jr-informe')).toContainText('Llegaron', { timeout: 10_000 });
  await expect(pagina.locator('.jr-informe')).toContainText('Cómo le fue a cada perfil');
  await expectNiebla(page, 'jornada-simulada', testInfo);
  // dejarla archivada para no estorbar a la siguiente prueba
  const arch = await page.request.post(`/api/jornada/${run.id}/archive`, { headers: { Origin: baseURL }, data: {} });
  expect(arch.status(), await arch.text()).toBe(200);
  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
