// Pruebas de humo de la interfaz en un navegador real (npm run test:ui). Usan el Chrome instalado en el sistema,
// así que no descargan navegadores, y arrancan su propio servidor sobre una carpeta de datos temporal.
import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.UI_PORT || 3391);
// La configuración se evalúa también en cada proceso de trabajo: la carpeta se crea una vez y se hereda.
process.env.CRM_UI_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'crm-ui-'));

export default defineConfig({
  testDir: 'test/ui',
  testMatch: /\.spec\.mjs$/,
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: 'chrome',
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'preparar', testMatch: /auth\.setup\.mjs$/ },
    { name: 'escritorio', dependencies: ['preparar'], use: { viewport: { width: 1366, height: 800 } } },
    {
      name: 'celular',
      dependencies: ['preparar'],
      use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: 'node server/index.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    // Las variables de proveedores van vacías a propósito: una prueba de interfaz nunca llama a la IA ni a Meta
    // aunque la terminal de quien la lanza las tenga. El código de invitación es un valor de prueba, no un secreto.
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: process.env.CRM_UI_DATA_DIR,
      NODE_ENV: 'test',
      APP_ORIGIN: '',
      ADMIN_INVITE_CODE: 'codigo-de-prueba-ui-0001',
      SCREENS_PREVIEW: '1',
      AI_PROVIDER: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      CHANNEL_CONNECTOR: '',
      PAYMENT_CONNECTOR: '',
    },
  },
});
