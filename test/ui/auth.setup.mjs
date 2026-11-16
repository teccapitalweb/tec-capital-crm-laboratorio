import { test as setup } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ADMIN, AUTH, INVITE, NAV_GROUPS_OPEN, ensureUser } from './helpers.mjs';

// La primera persona que se registra con el código del entorno queda como administración; su sesión se guarda
// para que las demás pruebas entren sin pasar por el formulario.
setup('prepara la sesión de administración', async ({ request, baseURL }) => {
  await ensureUser(request, baseURL, ADMIN, { inviteCode: INVITE });
  mkdirSync(dirname(AUTH.admin), { recursive: true });
  await request.storageState({ path: AUTH.admin });
  // El menú pliega sus grupos y recuerda en el navegador cuáles quedaron abiertos. Las pruebas entran con todos
  // abiertos para ir directo a cada pantalla; el plegado tiene su propia prueba (menu.spec.mjs).
  const saved = JSON.parse(readFileSync(AUTH.admin, 'utf8'));
  saved.origins = [{ origin: new URL(baseURL).origin, localStorage: [NAV_GROUPS_OPEN] }];
  writeFileSync(AUTH.admin, JSON.stringify(saved, null, 2));
});
