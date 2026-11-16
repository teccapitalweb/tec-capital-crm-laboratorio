import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { AUTH, ensureUser, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// Cifras de ejemplo para la pestaña Rendimiento: dos conversaciones de este recorrido escritas en la bitácora (una
// terminó y otra dejó de contestar en el mensaje). Las horas son fijas respecto a ahora: nada depende de que el reloj
// avance.
async function seedSessions(page, playwright, baseURL, flowId) {
  const { flow } = await (await page.request.get(`/api/chatflows/${flowId}`)).json();
  const message = flow.graph.nodes.find(n => n.type === 'message').id;
  const db = new DatabaseSync(join(process.env.CRM_UI_DATA_DIR, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    let conv = db.prepare('SELECT id FROM conversations WHERE brand_id=? LIMIT 1').get(flow.brandId)?.id;
    if (!conv) {
      const request = await playwright.request.newContext({ baseURL });
      await ensureUser(request, baseURL, {
        username: 'persona.ui',
        name: 'Persona de prueba',
        password: 'Password-ui-2026!',
      });
      const courseId = db.prepare('SELECT id FROM courses WHERE brand_id=? LIMIT 1').get(flow.brandId).id;
      const created = await request.post('/api/conversations', {
        headers: { Origin: baseURL },
        data: { courseId, channel: 'whatsapp' },
      });
      conv = (await created.json()).conversation.id;
      await request.dispose();
    }
    const at = Date.now() - 3_600_000;
    for (const [i, outcome] of ['completed', 'timeout'].entries()) {
      const id = `ui-${flowId.slice(0, 8)}-${i}`;
      db.prepare(
        "INSERT INTO chatflow_sessions(id,brand_id,flow_id,flow_version,conversation_id,state,node_id,outcome,end_node_id,started_at,updated_at,ended_at) VALUES(?,?,?,1,?,'ended',?,?,?,?,?,?)",
      ).run(id, flow.brandId, flowId, conv, message, outcome, message, at + i, at + i, at + i + 1);
      const event = db.prepare(
        'INSERT INTO chatflow_events(brand_id,session_id,flow_id,flow_version,node_id,event,port,created_at) VALUES(?,?,?,1,?,?,?,?)',
      );
      event.run(flow.brandId, id, flowId, flow.graph.start, 'enter', null, at);
      event.run(flow.brandId, id, flowId, flow.graph.start, 'exit', 'next', at);
      event.run(flow.brandId, id, flowId, message, 'enter', null, at);
    }
  } finally {
    db.close();
  }
}

// La pantalla «Automatización» (en vista previa) conectada al servidor de recorridos: lista, crear, armar en el
// esquema, revisar con un problema y arreglarlo, guardar y recargar, publicar, activar, probar con el servidor, ver el
// rendimiento con cifras, pedir sugerencias y archivar. En computadora y en celular (donde se edita en el esquema).
test('automatización: un recorrido de punta a punta, del borrador al rendimiento', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const watcher = watch(page);
  const phone = testInfo.project.name === 'celular';
  const name = `Recorrido de prueba UI ${testInfo.project.name}`;
  const pageEl = page.locator('#page');
  const dialog = page.locator('dialog.k-dialog[open]');

  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await page.locator('.nav [data-view="automatizacion"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Automatización');
  await expect(pageEl.locator('h1')).toHaveText('Recorridos');
  await settled(page);
  await expectNiebla(page, 'automatizacion-lista', testInfo);

  // Crear en blanco
  await pageEl.locator('[data-do="nuevo"]').click();
  await dialog.getByLabel('Nombre').fill(name);
  await dialog.getByLabel('En blanco (sólo el Inicio)').check();
  await dialog.getByRole('button', { name: 'Crear' }).click();
  const editor = pageEl.locator('.lz');
  await expect(editor).toBeVisible();
  await expect(pageEl.locator('h1')).toContainText(name);
  await expect(pageEl.locator('h1')).toContainText('Borrador');
  await expect(editor.locator('.lz-node')).toHaveCount(1);

  // Los tipos que el servidor todavía no ejecuta se ven, pero no se agregan
  if (phone) await editor.locator('.lz-bar [data-do="paleta"]').click();
  const list = editor.locator('[data-do="paleta-tipo"][data-type="list"]');
  await expect(list).toHaveAttribute('aria-disabled', 'true');
  await expect(list).toContainText('Todavía no disponible');
  // aria-disabled (y no disabled) para que siga en el orden del teclado y diga por qué al pulsarlo
  await list.click({ force: true });
  await expect(editor.locator('.lz-node')).toHaveCount(1);
  await expect(editor.locator('[data-slot="aviso"]')).toContainText('todavía no está disponible');
  if (phone) await editor.locator('.lz-palette [data-do="paleta"]').click();

  // Agregar un Mensaje conectado al Inicio, desde el esquema
  if (!phone) await editor.locator('.lz-bar [data-do="ver"][data-pane="outline"]').click();
  const exit = editor.locator('.lz-outline [data-do="fila-salida"]').first();
  await exit.focus();
  await exit.selectOption('new:message');
  await expect(editor.locator('.lz-node')).toHaveCount(2);
  await expect(editor.locator('.lz-outline .lz-row')).toHaveCount(2);
  if (phone) await page.keyboard.press('Escape');

  // Revisar: el mensaje vacío impide publicar; «Ir al paso» lleva a él y se arregla
  await pageEl.locator('[data-do="revisar"]').click();
  await expect(dialog).toContainText('hay que corregir');
  await expect(dialog.locator('.au-problema[data-level="error"]').first()).toContainText('Impide publicar');
  await dialog.locator('[data-do="ir-paso"]').first().click();
  await expect(dialog).toHaveCount(0);
  await expect(editor.locator('.lz-panel-title')).toHaveText('Mensaje');
  await editor
    .locator('[data-slot="panel"] textarea')
    .first()
    .fill('Hola, {{nombre}}. Te comparto la información de {{curso}}.');
  // ya sin errores: queda una recomendación (la salida del mensaje sin conectar), que no impide publicar
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).toHaveAttribute('data-level', 'warn');
  if (phone) await page.keyboard.press('Escape');
  await pageEl.locator('[data-do="revisar"]').click();
  await expect(dialog).toContainText('se puede publicar');
  await dialog.locator('[data-do="cerrar"]').click();

  // Guardar, recargar y sigue ahí
  await expect(editor.locator('[data-slot="estado"]')).toHaveText('Sin guardar');
  await editor.locator('.lz-bar [data-do="guardar"]').click();
  await expect(editor.locator('[data-slot="estado"]')).toHaveText('Guardado');
  await page.reload();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await page.locator('.nav [data-view="automatizacion"]').click();
  await expect(pageEl.locator('h1')).toHaveText('Recorridos');
  await pageEl.locator('[data-do="abrir"]', { hasText: name }).first().click();
  await expect(editor.locator('.lz-node')).toHaveCount(2);
  await settled(page);
  await expectNiebla(page, 'automatizacion', testInfo);

  // Publicar y activar
  await pageEl.locator('[data-do="publicar"]').click();
  await expect(dialog).toContainText('Publicar la versión 1');
  await expect(dialog).toContainText('siguen con la versión con la que empezaron');
  await dialog.getByRole('button', { name: 'Publicar' }).click();
  await expect(pageEl.locator('h1')).toContainText('Publicado, sin activar');
  await pageEl.locator('[data-do="activar"]').click();
  await dialog.getByRole('button', { name: 'Activar' }).click();
  await expect(pageEl.locator('h1')).toContainText('Publicado y activo');

  // Probar con el servidor: el mensaje sale con el curso real y no se envía nada
  await editor.locator('.lz-bar [data-do="probar"]').click();
  await expect(editor.locator('[data-slot="prueba"]')).toContainText('No se envía nada a nadie');
  await expect(editor.locator('.lz-chat')).toContainText('Te comparto la información de');
  await expect(editor.locator('.lz-sim-end')).toContainText('Fin de la prueba');
  await editor.locator('[data-do="prueba-cerrar"]').click();

  // Rendimiento con cifras
  const flowId = (await (await page.request.get('/api/chatflows')).json()).flows.find(f => f.name === name).id;
  await seedSessions(page, playwright, baseURL, flowId);
  await pageEl.locator('[data-do="pestana"][data-id="rendimiento"]').click();
  await pageEl.locator('[data-do="periodo"]').selectOption('7');
  const rend = pageEl.locator('[data-slot="p-rendimiento"]');
  await expect(rend.locator('.k-tile').first()).toContainText('2');
  await expect(rend.locator('.au-debiles')).toContainText('50 %');
  await expect(rend.locator('.au-tabla tbody tr')).toHaveCount(2);
  await settled(page);
  await expectNiebla(page, 'automatizacion-rendimiento', testInfo);
  // Sugerencias: sin IA configurada lo dice y no falla; la revisión por reglas sí sale
  await rend.locator('[data-do="sugerencias"]').click();
  await expect(rend.locator('.au-sug')).toContainText('no está configurada');
  await expect(rend.locator('.au-sugerencias')).toContainText('Pasar con una persona');
  // Las cifras sobre el recorrido
  await rend.locator('[data-do="ver-paso"]').first().click();
  await expect(editor).toBeVisible();
  await expect(editor.locator(phone ? '.lz-row-stats' : '.lz-node-stats').first()).toContainText('Entraron 2');

  // De vuelta a la lista: el estado a la vista; archivar para dejar limpio
  await pageEl.locator('[data-do="volver"]').click();
  const row = pageEl.locator(`[data-key="fila-${flowId}"]`);
  await expect(row).toContainText('Publicado y activo');
  await row.locator('[data-do="archivar"]').click();
  await dialog.getByRole('button', { name: 'Archivar' }).click();
  await expect(pageEl.locator('[data-do="abrir"]', { hasText: name })).toHaveCount(0);

  // al salir no queda nada de la pantalla y la aplicación de siempre sigue funcionando
  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .lz')).toHaveCount(0);
  await settled(page);
  await expect(page.locator('#page')).toContainText('Hola,');
  watcher.done();
});
