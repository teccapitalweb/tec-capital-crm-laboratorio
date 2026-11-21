// Recuperar la cuenta de administración cuando se olvidó la contraseña (docs/OPERACION_Y_PRUEBAS.md, «Recuperación»).
//
// Administración recupera las cuentas del equipo con un código personal (Equipo → «Recuperar una cuenta»), pero nadie
// puede recuperar la de administración desde el CRM: sería regalar la cuenta a quien encuentre una sesión abierta. La
// salida es la misma que ya existe para la verificación en dos pasos (MFA_RESET_USER): quien controla el entorno del
// servidor pone una variable y el CRM, AL ARRANCAR, deja armado un código de recuperación para la única cuenta de
// administración. Ese código se usa en la pantalla de siempre (/crm → «Recuperar mi cuenta») y por la ruta de siempre
// (POST /api/auth/recover): este módulo no tiene rutas ni pantalla, y no cambia cómo se comprueba un código.
//
//   ADMIN_RECOVERY_CODE   de 24 a 200 letras, números, guiones o guiones bajos, generado al azar (con letras y números
//                         y al menos 12 caracteres distintos). Vale 30 minutos desde el arranque y
//                         UNA sola vez: usado o vencido, el mismo texto no se vuelve a armar aunque la variable siga
//                         puesta (recovery_tokens.token_hash es único). Hay que retirarla al terminar.
//
// No toca la verificación en dos pasos: si la cuenta la tiene, sigue haciendo falta su código (o MFA_RESET_USER).
import { createHash, randomUUID } from 'node:crypto';

export const RECOVERY_VALID_MS = 30 * 60_000;
const CODE = /^[A-Za-z0-9_-]{24,200}$/;
const MIN_DISTINCT = 12;
const tokenHash = value => createHash('sha256').update(value).digest('hex'); // igual que server/crm.mjs

// Arma (o no) el código. Devuelve { state, message } para el registro de arranque; `null` si la variable no está.
// El mensaje nunca incluye el código.
export function armAdminRecovery({ db, transaction, audit, now = Date.now }, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const code = String(raw).trim();
  // Además del largo, tiene que ser variado: un código repetitivo o de diccionario se podría adivinar por la red en
  // los 30 minutos que vale (el límite de intentos es por dirección). Lo normal es generarlo, no inventarlo.
  if (!CODE.test(code) || new Set(code).size < MIN_DISTINCT || !/[A-Za-z]/.test(code) || !/[0-9]/.test(code))
    return {
      state: 'invalid',
      message:
        'ADMIN_RECOVERY_CODE: debe tener de 24 a 200 letras, números, guiones o guiones bajos (sin espacios), con letras y números y al menos ' +
        MIN_DISTINCT +
        ' caracteres distintos. Genera uno al azar. No se armó nada.',
    };
  const admins = db.prepare("SELECT id,username FROM users WHERE role='admin' AND disabled=0").all();
  if (admins.length !== 1)
    return {
      state: 'no_admin',
      message: 'ADMIN_RECOVERY_CODE: no hay una única cuenta de administración activa. No se armó nada.',
    };
  const [admin] = admins;
  const hash = tokenHash(code);
  const armed = transaction(db, () => {
    // Un código que ya pasó por aquí (usado, vencido o todavía vigente) no se vuelve a armar ni se alarga.
    if (db.prepare('SELECT 1 FROM recovery_tokens WHERE token_hash=?').get(hash)) return false;
    const t = now();
    db.prepare('UPDATE recovery_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL').run(t, admin.id);
    db.prepare('INSERT INTO recovery_tokens(id,token_hash,user_id,created_by,expires_at) VALUES(?,?,?,?,?)').run(
      randomUUID(),
      hash,
      admin.id,
      admin.id,
      t + RECOVERY_VALID_MS,
    );
    audit(null, 'recovery.armed', admin.id); // sin persona: lo armó el entorno del servidor
    return true;
  });
  return armed
    ? {
        state: 'armed',
        message:
          'Recuperación de administración armada para @' +
          admin.username +
          ' durante 30 minutos: entra a /crm → «Recuperar mi cuenta». Retira ADMIN_RECOVERY_CODE del entorno al terminar.',
      }
    : {
        state: 'spent',
        message:
          'ADMIN_RECOVERY_CODE: ese código ya se había armado o usado y no se vuelve a armar. Retira la variable (o pon un código nuevo si todavía lo necesitas).',
      };
}

export default {
  name: 'admin-recovery',
  create(host) {
    const result = armAdminRecovery(host, process.env.ADMIN_RECOVERY_CODE);
    if (result) console.log(result.message);
    return Object.freeze({ state: result?.state ?? 'off' });
  },
};
