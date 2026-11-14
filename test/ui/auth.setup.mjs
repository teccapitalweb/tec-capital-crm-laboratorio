import { test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ADMIN, AUTH, INVITE, ensureUser } from './helpers.mjs';

// La primera persona que se registra con el código del entorno queda como administración; su sesión se guarda
// para que las demás pruebas entren sin pasar por el formulario.
setup('prepara la sesión de administración', async ({ request, baseURL }) => {
  await ensureUser(request, baseURL, ADMIN, { inviteCode: INVITE });
  mkdirSync(dirname(AUTH.admin), { recursive: true });
  await request.storageState({ path: AUTH.admin });
});
