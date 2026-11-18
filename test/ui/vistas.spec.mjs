import { test, expect } from '@playwright/test';
import { AUTH, ensureUser, expectNiebla, settled, watch } from './helpers.mjs';
import { nieblaAudit } from './niebla-audit.mjs';

// Tinta en las vistas de antes por dentro (docs/DISENO_Y_AUDITORIA.md, «Vistas del equipo en Tinta»): Operación con
// todas sus áreas y pestañas, Tareas, Agenda, Oportunidades, Catálogo, Mis resultados, Analítica, Actividad,
// Presentación, Equipo, Mi configuración, una ventana y la entrada. El rediseño cambia el aspecto, no las opciones:
// en cada vista se comprueba que sus acciones clave siguen a la vista y que la auditoría queda en cero (letra de
// 11 px o más, sin desborde, contraste AA y, en celular, áreas táctiles de 40 px).
const INK = 'rgb(22, 24, 29)';
const LIME = 'rgb(217, 242, 79)';

test.describe('Vistas del equipo', () => {
  test.use({ storageState: AUTH.admin });

  // Una conversación de cliente deja una oportunidad en el tablero para abrir su ventana.
  test.beforeAll(async ({ playwright, baseURL }) => {
    const request = await playwright.request.newContext({ baseURL });
    await ensureUser(request, baseURL, {
      username: 'cliente.vistas',
      name: 'Cliente de las vistas',
      password: 'Password-vistas-2026!',
    });
    const { courses } = await (await request.get('/api/bootstrap')).json();
    const opened = await request.post('/api/conversations', {
      headers: { Origin: baseURL },
      data: { courseId: courses[0].id, channel: 'whatsapp' },
    });
    expect(opened.ok(), await opened.text()).toBe(true);
    await request.dispose();
  });

  const go = async (page, view) => {
    await page.evaluate(v => window.TC.host.setView(v), view);
    await settled(page);
  };

  test('Operación: cada área y cada pestaña se abre, con sus cifras en bloques de color', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const watcher = watch(page);
    await page.goto('/crm');
    await go(page, 'operations');
    await expect(page.locator('#page h1')).toHaveText('Operación');
    await expect(page.locator('#ops-brand')).toBeVisible();
    // Cola: las cuatro cifras filtran; la encendida va en tinta con la cifra en lima
    await expect(page.locator('[data-action="ops-filter"]')).toHaveCount(4);
    const active = page.locator('[data-action="ops-filter"].active');
    await expect(active).toHaveCSS('background-color', INK);
    await expect(active.locator('strong')).toHaveCSS('color', LIME);
    await expect(page.locator('#ops-search-form')).toBeVisible();
    await expect(page.locator('.ops-subtabs button.active')).toHaveCSS('background-color', LIME);
    const areas = await page.locator('.ops-groups button').allTextContents();
    expect(areas).toEqual(expect.arrayContaining(['Atención', 'Ventas y cobro', 'Sistema']));
    expect(areas.length).toBeGreaterThanOrEqual(3);
    for (const area of areas) {
      await page.locator('.ops-groups button', { hasText: area }).click();
      await settled(page);
      const tabs = await page.locator('.ops-subtabs button').allTextContents();
      expect(tabs.length, `${area} tiene pestañas`).toBeGreaterThan(0);
      for (const tab of tabs) {
        await page.locator('.ops-subtabs button', { hasText: tab }).first().click();
        await settled(page);
        await expect(page.locator('.ops-subtabs button.active')).toHaveText(tab);
        await expectNiebla(page, `vistas-operacion-${tab}`, testInfo);
      }
    }
    // Pagos: las cuatro cifras, «Ver cómo paga el cliente» y los ajustes de administración siguen ahí
    await page.locator('.ops-groups button', { hasText: 'Ventas y cobro' }).click();
    await page.locator('.ops-subtabs button', { hasText: 'Pagos' }).click();
    await settled(page);
    await expect(page.locator('[data-action="pay-filter"]')).toHaveCount(4);
    await expect(page.locator('[data-action="pay-preview"]')).toBeVisible();
    await expect(page.locator('.real-mode-panel')).toBeAttached();
    watcher.done();
  });

  test('Tareas, Agenda, Oportunidades y su ventana', async ({ page }, testInfo) => {
    const watcher = watch(page);
    await page.goto('/crm');
    await go(page, 'tasks');
    await expect(page.locator('[data-action="crm-new-task"]')).toBeVisible();
    await expect(page.locator('[data-action="crm-task-filter"]')).toHaveCount(4);
    await expect(page.locator('[data-action="crm-task-filter"].active')).toHaveCSS('background-color', INK);
    await expectNiebla(page, 'vistas-tareas', testInfo);

    await go(page, 'agenda');
    await expect(page.locator('#page h1')).toHaveText('Agenda');
    for (const action of ['agd-prev', 'agd-today', 'agd-next'])
      await expect(page.locator(`[data-action="${action}"]`)).toBeVisible();
    await expect(page.locator('[data-action="agd-scope"]')).toHaveCount(2);
    await expectNiebla(page, 'vistas-agenda', testInfo);

    await go(page, 'opportunities');
    await expect(page.locator('[data-action="crm-new-opportunity"]')).toBeVisible();
    await expect(page.locator('.pipeline-column')).toHaveCount(5);
    await expect(page.locator('.pipeline-column').nth(1)).toHaveCSS('border-top-left-radius', '28px');
    await expectNiebla(page, 'vistas-oportunidades', testInfo);
    await page.locator('.opportunity-card').first().click();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#modal [data-action="close-modal"]')).toBeVisible();
    await expect(page.locator('#modal select').first()).toBeVisible();
    await page.locator('#modal [data-action="close-modal"]').click();
    watcher.done();
  });

  test('Catálogo: las ocho secciones y crear en tinta', async ({ page }, testInfo) => {
    const watcher = watch(page);
    await page.goto('/crm');
    await go(page, 'courses');
    await expect(page.locator('#page h1')).toHaveText('Catálogo');
    await expect(page.locator('[data-action="cat-tab"]')).toHaveCount(8);
    await expect(page.locator('#cat-brand-filter')).toBeVisible();
    await expect(page.locator('.cat-toolbar [data-action="cat-wizard"]')).toHaveCSS('background-color', INK);
    await expectNiebla(page, 'vistas-catalogo', testInfo);
    for (const id of ['editions', 'knowledge']) {
      await page.locator(`[data-action="cat-tab"][data-id="${id}"]`).click();
      await settled(page);
      await expectNiebla(page, `vistas-catalogo-${id}`, testInfo);
    }
    watcher.done();
  });

  test('Resultados y Ajustes', async ({ page }, testInfo) => {
    const watcher = watch(page);
    await page.goto('/crm');
    const checks = [
      ['results', ['#pt-days']],
      ['analytics', ['#an-days', '[data-action="an-reload"]']],
      ['activity', ['[data-action="copy-link"]']],
      ['presentation', ['.pr-script']],
      ['team', ['[data-action="crm-invite"]', '[data-action="crm-recovery"]']],
      ['settings', ['#crm-profile-form', '[data-action="crm-password"]', '#page [data-action="logout"]']],
    ];
    for (const [view, selectors] of checks) {
      await go(page, view);
      for (const selector of selectors)
        await expect(page.locator(selector).first(), `${view}: ${selector}`).toBeVisible();
      await expectNiebla(page, `vistas-${view}`, testInfo);
    }
    watcher.done();
  });
});

test('La entrada del equipo (/crm): la historia en tinta con la marca en lima y el formulario en una tarjeta blanca', async ({
  page,
}, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#auth-form')).toBeVisible();
  await expect(page.locator('.entry')).toHaveClass(/entry--team/);
  await expect(page.locator('.entry-story')).toHaveCSS('background-color', INK);
  await expect(page.locator('.entry-story .brand-mark')).toHaveCSS('background-color', LIME);
  await expect(page.locator('.entry-story .brand-mark .tinta-mark')).toBeVisible();
  await expect(page.locator('.entry-story .brand strong')).toHaveText('Tinta');
  await expect(page.locator('.entry-form')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  for (const selector of ['[data-value="register"]', '[data-value="login"]', '[data-action="crm-recover-entry"]'])
    await expect(page.locator(selector)).toBeVisible();
  // La entrada no tiene #page: se mide la caja .entry entera, con límite cero
  const result = await page.evaluate(nieblaAudit, '.entry');
  expect(result.total).toBeGreaterThan(0);
  expect(result.under11px, result.smallSample.join(' | ')).toBe(0);
  expect(result.overflowX).toBe(0);
  expect(result.contrastFailures, result.contrastSample.join(' | ')).toBe(0);
  if (testInfo.project.name === 'celular') expect(result.smallTargets, result.targetSample.join(' | ')).toBe(0);
  watcher.done();
});

// La entrada de los clientes («/», enlaces de invitación, la app «Chat de prueba», «?pay=» sin sesión) conserva su
// aspecto de antes hasta que el dueño decida otra cosa: tinta-vistas.css no la toca.
test('La entrada de los clientes (/) conserva su aspecto: sin bloque en tinta ni marca en lima', async ({ page }) => {
  const watcher = watch(page);
  await page.goto('/');
  await expect(page.locator('#auth-form')).toBeVisible();
  await expect(page.locator('.entry')).not.toHaveClass(/entry--team/);
  await expect(page.locator('.entry-story')).not.toHaveCSS('background-color', INK);
  await expect(page.locator('.entry-story .brand-mark')).not.toHaveCSS('background-color', LIME);
  // …ni la marca del equipo: sigue con la suya
  await expect(page.locator('.entry-story .brand-mark')).toHaveText('tc');
  await expect(page.locator('.entry-story .tinta-mark')).toHaveCount(0);
  // Pintada igual con y sin la hoja de las vistas del equipo
  const story = () =>
    page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('.entry-story'));
      const f = getComputedStyle(document.querySelector('.entry-form'));
      return [s.backgroundColor, s.backgroundImage, s.color, s.borderRadius, f.backgroundColor, f.padding].join('|');
    });
  const withSheet = await story();
  await page.evaluate(() => (document.querySelector('link[href="/tinta-vistas.css"]').disabled = true));
  expect(await story()).toBe(withSheet);
  watcher.done();
});
