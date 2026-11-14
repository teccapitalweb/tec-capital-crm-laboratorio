// TEMPORAL: exploración del lienzo en navegador. No se entrega.
import { test, expect } from '@playwright/test';
import { AUTH, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });
const SHOTS = process.env.SHOTS_DIR;

test('exploración del lienzo', async ({ page }, testInfo) => {
  const watcher = watch(page);
  const phone = testInfo.project.name === 'celular';
  const shot = name => page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-${name}.png` });
  const log = (...args) => console.log(`[${testInfo.project.name}]`, ...args);
  await page.goto('/crm');
  await page.locator('.nav [data-view="automatizacion"]').click();
  const editor = page.locator('#page .lz');
  await expect(editor).toBeVisible();
  await settled(page);
  await shot('01-inicio');
  log(
    'iconos del menú',
    await page.evaluate(() => ({
      navSvg: document.querySelectorAll('.nav svg').length,
      lucide: typeof window.lucide,
    })),
  );

  if (phone) {
    // esquema → abrir un paso → hoja con sus ajustes
    await editor.locator('.lz-row [data-do="fila"]').nth(1).click();
    await settled(page);
    await shot('02-paso');
    log('pane', await editor.getAttribute('data-pane'), 'sheet', await editor.getAttribute('data-sheet'));
    const field = editor.locator('[data-slot="panel"] textarea[data-do="campo"]').first();
    if (await field.count()) {
      await field.click();
      await page.keyboard.type(' Hola');
      log('campo tras teclear', JSON.stringify(await field.inputValue()), 'foco', await field.evaluate(el => el === document.activeElement));
    }
    await shot('03-tecleado');
    const close = editor.locator('[data-do="panel-cerrar"]:visible').first();
    if (await close.count()) await close.click();
    await editor.locator('.lz-bar [data-do="ver"][data-pane="canvas"]').click();
    await settled(page);
    await shot('04-lienzo');
    await editor.locator('.lz-bar [data-do="probar"]').click();
    await settled(page);
    await shot('05-prueba');
    watcher.done();
    return;
  }

  const nodes = editor.locator('.lz-node');
  const edges = editor.locator('.lz-edge');
  log('pasos', await nodes.count(), 'conexiones', await edges.count());

  // 1. arrastrar un paso
  const second = nodes.nth(1);
  const before = await second.evaluate(el => [el.style.left, el.style.top]);
  const box = await second.locator('.lz-node-head').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 60, { steps: 5 });
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 5 });
  await page.mouse.up();
  const after = await second.evaluate(el => [el.style.left, el.style.top]);
  log('arrastre', before, '→', after, 'seleccionado', await second.getAttribute('data-selected'));
  await shot('02-arrastrado');
  await editor.locator('.lz-bar [data-do="deshacer"]').click();
  log('tras deshacer', await second.evaluate(el => [el.style.left, el.style.top]));

  // 2. agregar un paso y conectar desde su salida
  await editor.locator('[data-do="paleta-tipo"][data-type="message"]').click();
  await expect(nodes).toHaveCount(12);
  const fresh = editor.locator('.lz-node[data-selected="true"]');
  await expect(fresh).toHaveCount(1);
  log('paso nuevo', await fresh.getAttribute('data-node'), await fresh.getAttribute('aria-label'));
  await shot('03-agregado');

  // 3. el panel: escribir con foco, la tarjeta se actualiza, el foco y el cursor no se pierden
  const text = editor.locator('[data-slot="panel"] textarea[data-do="campo"]').first();
  await text.click();
  await page.keyboard.type('Hola, te cuento del curso.');
  await page.keyboard.press('Home');
  await page.keyboard.type('¡');
  log(
    'texto',
    JSON.stringify(await text.inputValue()),
    'foco',
    await text.evaluate(el => el === document.activeElement),
    'cursor',
    await text.evaluate(el => el.selectionStart),
  );
  log('resumen en la tarjeta', await fresh.locator('.lz-node-sum').innerText());
  log('problemas', await editor.locator('.lz-bar [data-slot="problemas"]').innerText());
  await shot('04-panel');
  const title = editor.locator('[data-slot="panel"] input[data-do="titulo"]');
  await title.click();
  await page.keyboard.type('Saludo');
  log('título', await title.inputValue(), '→ tarjeta', await fresh.locator('.lz-node-title').first().innerText());

  // deshacer con el botón: los campos del panel vuelven atrás
  await editor.locator('.lz-bar [data-do="deshacer"]').click();
  log('tras deshacer título', JSON.stringify(await title.inputValue()), 'texto', JSON.stringify(await text.inputValue()));
  await editor.locator('.lz-bar [data-do="deshacer"]').click();
  log('tras deshacer texto', JSON.stringify(await text.inputValue()), 'pasos', await nodes.count());
  await editor.locator('.lz-bar [data-do="rehacer"]').click();
  await editor.locator('.lz-bar [data-do="rehacer"]').click();
  log('tras rehacer', JSON.stringify(await title.inputValue()), JSON.stringify(await text.inputValue()));

  // 4. conectar: de la salida del paso nuevo a otro paso
  const handle = fresh.locator('.lz-port .lz-handle').first();
  const hb = await handle.boundingBox();
  const target = await nodes.nth(2).boundingBox();
  const edgesBefore = await edges.count();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 40, hb.y + 20, { steps: 4 });
  log('conectando', await editor.locator('.lz-canvas').getAttribute('data-connecting'));
  await page.mouse.move(target.x + 40, target.y + 30, { steps: 8 });
  await shot('05-conectando');
  await page.mouse.up();
  log(
    'conexiones',
    edgesBefore,
    '→',
    await edges.count(),
    'salida enlazada',
    await fresh.locator('.lz-port').first().getAttribute('data-linked'),
  );
  log('salidas en el panel', await editor.locator('[data-slot="salidas"] select').first().inputValue().catch(() => 'sin select'));
  await shot('06-conectado');

  // 5. seleccionar la conexión y quitarla
  const last = edges.last();
  await last.locator('.lz-edge-hit').click({ force: true });
  log('conexión seleccionada', await editor.locator('.lz-edge[data-selected="true"]').count(), 'botón', await editor.locator('[data-do="arista-quitar"]').count());
  await shot('07-conexion');
  if (await editor.locator('[data-do="arista-quitar"]').count()) await editor.locator('[data-do="arista-quitar"]').click();
  log('conexiones tras quitar', await edges.count());

  // 6. minimapa
  const vp = () => editor.locator('.lz-world').evaluate(el => el.style.transform);
  const v0 = await vp();
  const mm = await editor.locator('.lz-minimap').boundingBox();
  if (mm) {
    await page.mouse.click(mm.x + mm.width * 0.8, mm.y + mm.height * 0.7);
    log('minimapa', v0, '→', await vp());
  } else log('minimapa no visible');
  await editor.locator('.lz-bar [data-do="ajustar"]').click();
  await editor.locator('.lz-bar [data-do="alejar"]').click();
  await editor.locator('.lz-bar [data-do="alejar"]').click();
  await editor.locator('.lz-bar [data-do="alejar"]').click();
  log('zoom', await editor.locator('.lz-bar [data-slot="zoom"]').innerText(), 'compacto', await editor.locator('.lz-canvas').getAttribute('data-compact'));
  await shot('08-alejado');
  await editor.locator('.lz-bar [data-do="ajustar"]').click();

  // 7. rendimiento y prueba
  await editor.locator('.lz-bar [data-do="rendimiento"]').click();
  await settled(page);
  await shot('09-rendimiento');
  log('cifras', await editor.locator('.lz-node-stats').count());
  await editor.locator('.lz-bar [data-do="rendimiento"]').click();
  await editor.locator('.lz-bar [data-do="probar"]').click();
  await settled(page);
  await shot('10-prueba');
  const option = editor.locator('[data-do="prueba-opcion"]').first();
  log('burbujas', await editor.locator('.lz-bubble').count(), 'opciones', await editor.locator('[data-do="prueba-opcion"]').count());
  if (await option.count()) {
    await option.click();
    await settled(page);
    log('burbujas tras elegir', await editor.locator('.lz-bubble').count());
  }
  const simInput = editor.locator('[data-do="prueba-form"] input, [data-do="prueba-form"] textarea').first();
  if (await simInput.count()) {
    await simInput.fill('Quiero informes');
    await page.keyboard.press('Enter');
    await settled(page);
    log('burbujas tras escribir', await editor.locator('.lz-bubble').count(), 'campo', JSON.stringify(await simInput.inputValue().catch(() => '—')));
  }
  await shot('11-prueba-avanzada');
  await editor.locator('[data-do="prueba-cerrar"]').click();

  // 8. esquema: cambiar el destino de una salida
  await editor.locator('.lz-bar [data-do="ver"][data-pane="outline"]').click();
  await settled(page);
  await shot('12-esquema');
  const pick = editor.locator('[data-do="fila-salida"]').first();
  log('selects de salida', await editor.locator('[data-do="fila-salida"]').count());
  if (await pick.count()) {
    await pick.focus();
    await page.keyboard.press('ArrowDown');
    log('opciones del select', await pick.locator('option').count(), 'valor', await pick.inputValue());
  }
  await editor.locator('.lz-bar [data-do="ver"][data-pane="canvas"]').click();

  // 9. remontaje: salir y volver conserva el grafo sin guardar
  const count = await nodes.count();
  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#page .lz')).toHaveCount(0);
  await page.locator('.nav [data-view="automatizacion"]').click();
  await expect(editor).toBeVisible();
  log('pasos antes y después de remontar', count, await nodes.count(), 'deshacer', await editor.locator('.lz-bar [data-do="deshacer"]').getAttribute('aria-disabled'));
  await shot('13-remontado');
  watcher.done();
});
