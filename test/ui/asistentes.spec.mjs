import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

// Conectar un asistente con un clic (docs/PLAN_MCP_OAUTH.md): la página de permiso (sin sesión pide entrar; con
// sesión, la marca y los permisos) y la pantalla «Asistentes conectados» con la conexión recién hecha y «Desconectar».
// La aplicación del asistente es de mentira: su regreso (127.0.0.1:5555) lo contesta el propio navegador de la prueba.
const CALLBACK = 'http://127.0.0.1:5555/callback';

async function registerClient(request, name) {
  const response = await request.post('/oauth/register', {
    data: { client_name: name, redirect_uris: [CALLBACK] },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).client_id;
}
let lastVerifier = '';
function authorizeUrl(clientId, baseURL) {
  const verifier = randomBytes(32).toString('base64url');
  lastVerifier = verifier;
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return (
    '/oauth/authorize?' +
    new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'prueba-ui',
      resource: baseURL + '/mcp',
    })
  );
}

test('permiso de un asistente: sin sesión pide entrar', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const watcher = watch(page);
  const clientId = await registerClient(context.request, 'Asistente de la prueba (entrar)');
  await page.goto(authorizeUrl(clientId, baseURL));
  await expect(page.locator('h1')).toHaveText('Entra al CRM para continuar');
  await expect(page.locator('[name="username"]')).toBeVisible();
  await expectNiebla(page, 'oauth-entrar', testInfo);
  watcher.done();
  await context.close();
});

test.describe('con sesión de administración', () => {
  test.use({ storageState: AUTH.admin });

  test('permiso de un asistente y «Asistentes conectados»', async ({ page, baseURL }, testInfo) => {
    const watcher = watch(page);
    const name = `Asistente de la prueba ${testInfo.project.name}`;
    const clientId = await registerClient(page.request, name);
    await page.route(CALLBACK + '**', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Listo</p>' }),
    );

    await page.goto(authorizeUrl(clientId, baseURL));
    await expect(page.locator('h1')).toHaveText('¿Permitir que este asistente use el CRM?');
    await expect(page.locator('.oa-app__name')).toHaveText(name);
    await expect(page.locator('input[name="scope"][value="editions"]')).toBeChecked();
    await expect(page.locator('input[name="scope"][value="contacts"]')).not.toBeChecked();
    await expectNiebla(page, 'oauth-permiso', testInfo);
    await page.locator('input[name="brand"]').first().check();
    await page.getByRole('button', { name: 'Permitir' }).click();
    // la página vuelve a la aplicación con el código y el mismo state (se espera a que termine de llegar)
    await page.waitForURL(url => url.href.startsWith(CALLBACK));
    await expect(page.locator('p')).toHaveText('Listo');
    const landed = new URL(page.url());
    expect(landed.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(landed.searchParams.get('state')).toBe('prueba-ui');

    await page.goto('/crm');
    const entry = page.locator('.nav [data-view="asistentes"]');
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.locator('#breadcrumb-title')).toHaveText('Asistentes conectados');
    await settled(page);
    await expect(page.locator('#page .as-url')).toHaveText(baseURL + '/mcp');
    const card = page.locator('#page .as-conexion', { hasText: name });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Aperturas, precios y cupos');
    await expectNiebla(page, 'asistentes', testInfo);

    // ---- Actividad: el asistente usa el conector (una consulta y una sin permiso) y una llave de la API también
    const tokens = await (
      await page.request.post('/oauth/token', {
        form: {
          grant_type: 'authorization_code',
          code: landed.searchParams.get('code'),
          redirect_uri: CALLBACK,
          client_id: clientId,
          code_verifier: lastVerifier,
        },
      })
    ).json();
    expect(tokens.access_token).toMatch(/^tca_/);
    const mcp = (token, name) =>
      page.request.post('/mcp', {
        headers: { Authorization: 'Bearer ' + token },
        data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } },
      });
    expect((await mcp(tokens.access_token, 'listar_cursos')).status()).toBe(200);
    expect((await mcp(tokens.access_token, 'listar_pedidos')).status()).toBe(200);
    const keyName = `Llave de la prueba ${testInfo.project.name}`;
    const key = await page.request.post('/api/integrations/keys', {
      headers: { Origin: baseURL },
      data: { brandId: 'globalvet', name: keyName, scopes: ['editions'] },
    });
    expect(key.status(), await key.text()).toBe(201);
    expect((await mcp((await key.json()).token, 'resumen')).status()).toBe(200);

    await card.getByRole('button', { name: 'Ver actividad' }).click();
    await expect(page.getByRole('tab', { name: 'Actividad' })).toHaveAttribute('aria-selected', 'true');
    const rows = page.locator('#page .ac-item');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(/Rechazada: no tenía el permiso «.+»/);
    await expect(rows.nth(0)).toContainText('Rechazada');
    await expect(rows.nth(1)).toContainText('Consultó los cursos y aperturas');
    await expect(rows.nth(1)).toContainText(name);
    await expectNiebla(page, 'asistentes-actividad', testInfo); // sin filtro de conexión aparece también la llave, por su nombre; «Sólo rechazadas» deja sólo el rechazo
    await page.locator('#page select[name="source"]').selectOption('');
    await expect(page.locator('#page .ac-item', { hasText: keyName })).toContainText('Consultó el resumen de la marca');
    await page.getByRole('button', { name: 'Sólo rechazadas' }).click();
    await expect(page.getByRole('button', { name: 'Sólo rechazadas' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#page .ac-item[data-outcome="ok"]')).toHaveCount(0);
    await expect(page.locator('#page .ac-item', { hasText: name }).first()).toContainText('Rechazada');
    await page.getByRole('tab', { name: 'Conexiones' }).click();

    await card.getByRole('button', { name: 'Desconectar' }).click();
    await page.locator('.k-dialog').getByRole('button', { name: 'Desconectar' }).click();
    await expect(page.locator('#page .as-conexion', { hasText: name })).toHaveCount(0);

    await page.locator('.nav [data-view="day"]').click();
    await expect(page.locator('#page .k-page')).toHaveCount(0);
    watcher.done();
  });
});
