import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// Modo real por marca (docs/PLAN_MODO_REAL.md) en Operación → Pagos: el panel muestra el estado y lo que falta, se enciende
// con confirmación, la vista previa de la página de pago queda sin métodos simulados y con «Cómo pagar», y se apaga al final
// para no cambiar el laboratorio de las demás pruebas. Cumple Niebla en computadora y celular.
test('modo real: interruptor con confirmación y página de pago sin métodos simulados', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  // la marca se elige en la barra lateral, que en celular queda oculta tras el menú: se cambia como lo haría la persona
  await page.locator('#brand-picker').evaluate(el => {
    el.value = 'globalvet';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('.nav [data-view="operations"]').click();
  await page.locator('[data-action="ops-tab"][data-id="payments"]').first().click();
  const panel = page.locator('.real-mode-panel');
  await expect(panel).toBeVisible();
  const form = panel.locator('#pay-realmode-globalvet');
  await expect(form).toContainText('Laboratorio');
  await expect(form).toContainText('Antes de encenderlo falta');

  // encender: pide confirmación y deja la marca en modo real con sus instrucciones
  await form.locator('[name="enabled"]').check();
  await form
    .locator('[name="paymentInstructions"]')
    .fill('Transferencia a la cuenta de la marca. Concepto: tu referencia.');
  page.once('dialog', dialog => dialog.accept());
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#pay-realmode-globalvet')).toContainText('Modo real');
  // los textos del equipo para la marca real no dicen «práctica»
  await expect(page.locator('.ops-stat[data-id="all"]')).toContainText('Cobrado');
  await expect(page.locator('.ops-stat[data-id="all"]')).not.toContainText('práctica');
  await settled(page);
  await expectNiebla(page, 'modo-real-pagos', testInfo);

  // la vista previa de la página de pago: sin tarjeta ni OXXO, con las instrucciones de la marca y sin «Simulación»
  await page.locator('[data-action="pay-preview"]').click();
  const modal = page.locator('#modal');
  await expect(modal.locator('.pg-real')).toBeVisible();
  await expect(modal.locator('.pg-howto')).toContainText('Transferencia a la cuenta de la marca');
  await expect(modal.locator('[data-pg-tab]')).toHaveCount(0);
  await expect(modal).not.toContainText(/Simulación|de prueba|OXXO/);
  await expectNiebla(page, 'modo-real-pago', testInfo);
  await modal.locator('[data-action="close-modal"]').first().click();

  // apagar: también con confirmación
  const again = page.locator('#pay-realmode-globalvet');
  await again.locator('[name="enabled"]').uncheck();
  page.once('dialog', dialog => dialog.accept());
  await again.locator('button[type="submit"]').click();
  await expect(page.locator('#pay-realmode-globalvet')).toContainText('Laboratorio');
  watcher.done();
});
