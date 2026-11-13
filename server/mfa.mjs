import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { transaction } from './database.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
  STEP_MS = 30000,
  ISSUER = 'TEC Capital';
const sha = v => createHash('sha256').update(v).digest('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a)),
    y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function base32(buffer) {
  let bits = 0,
    value = 0,
    out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(text) {
  let bits = 0,
    value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/=+$/, '')) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw Error('Base32 no válido.');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
// RFC 4226/6238: HMAC-SHA1 sobre el contador de 30 s, truncamiento dinámico.
export function totp(secretBase32, step, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secretBase32)).update(counter).digest(),
    o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
export const stepAt = t => Math.floor(t / STEP_MS);
// Acepta el paso actual y uno anterior/posterior (desfase de reloj) y nunca uno ya usado.
export function matchStep(secret, code, now, lastStep = 0) {
  for (const s of [stepAt(now), stepAt(now) - 1, stepAt(now) + 1])
    if (s > lastStep && same(totp(secret, s), code)) return s;
  return null;
}

export function createMfa({ db, dataDir, json, body, audit, rate, checkPassword, now = Date.now }) {
  // El secreto TOTP se guarda cifrado (AES-256-GCM). La clave sale de MFA_KEY o de DATA_DIR/mfa.key (se crea una vez, sólo lectura para su dueño):
  // así una copia de la base sin ese archivo no revela los secretos. Al restaurar un respaldo hay que restaurar también mfa.key.
  let key;
  const keyOf = () => {
    if (key) return key;
    if (process.env.MFA_KEY) {
      key = createHash('sha256').update(process.env.MFA_KEY).digest();
      return key;
    }
    const file = resolve(dataDir, 'mfa.key');
    if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw Error('mfa.key no válido.');
    return key;
  };
  const seal = text => {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', keyOf(), iv),
      ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
  };
  const open = text => {
    const [iv, tag, ct] = text.split('.').map(p => Buffer.from(p, 'base64')),
      d = createDecipheriv('aes-256-gcm', keyOf(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  };

  const row = id => db.prepare('SELECT * FROM user_mfa WHERE user_id=?').get(id);
  const isEnabled = id => row(id)?.pending === 0;
  const staff = u => u && !u.disabled && ['agent', 'admin'].includes(u.role);
  const normalize = code =>
    String(code ?? '')
      .toLowerCase()
      .replace(/[\s-]/g, '');

  function newRecoveryCodes(userId) {
    const codes = Array.from({ length: 10 }, () => {
      const raw = base32(randomBytes(7)).slice(0, 10).toLowerCase();
      return raw.slice(0, 5) + '-' + raw.slice(5);
    });
    db.prepare('UPDATE user_mfa SET recovery=? WHERE user_id=?').run(
      JSON.stringify(codes.map(c => sha(userId + ':' + normalize(c)))),
      userId,
    );
    return codes;
  }
  // Valida un TOTP (o un código de recuperación, que se consume) y devuelve el tipo usado.
  function useCode(userId, code) {
    const r = row(userId);
    if (!r) return null;
    const c = normalize(code);
    if (/^\d{6}$/.test(c)) {
      const step = matchStep(open(r.secret), c, now(), r.last_step);
      if (step === null) return null;
      db.prepare('UPDATE user_mfa SET last_step=? WHERE user_id=?').run(step, userId);
      return 'totp';
    }
    if (/^[a-z2-7]{10}$/.test(c)) {
      const hashes = JSON.parse(r.recovery),
        h = sha(userId + ':' + c),
        i = hashes.indexOf(h);
      if (i < 0) return null;
      hashes.splice(i, 1);
      db.prepare('UPDATE user_mfa SET recovery=? WHERE user_id=?').run(JSON.stringify(hashes), userId);
      return 'recovery';
    }
    return null;
  }

  // Desafío posterior a la contraseña correcta: 5 minutos y 5 intentos, sólo en memoria (reiniciar el servidor obliga a repetir la contraseña).
  const challenges = new Map();
  function challenge(userId) {
    const t = now();
    for (const [k, v] of challenges) if (v.expires < t) challenges.delete(k);
    const token = randomBytes(32).toString('hex');
    challenges.set(sha(token), { userId, expires: t + 5 * 60000, attempts: 0 });
    return token;
  }
  function complete(input) {
    const k = sha(String(input?.challenge || '')),
      c = challenges.get(k);
    if (!c || c.expires < now()) {
      challenges.delete(k);
      throw fail(401, 'La verificación venció. Vuelve a iniciar sesión.');
    }
    rate('mfa-user:' + c.userId, 10, 900000);
    if (++c.attempts > 5) {
      challenges.delete(k);
      throw fail(401, 'Demasiados intentos. Vuelve a iniciar sesión.');
    }
    const used = transaction(db, () => useCode(c.userId, input.code));
    if (!used) throw fail(401, 'Código incorrecto. Revisa la hora de tu teléfono o usa un código de recuperación.');
    challenges.delete(k);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(c.userId);
    if (!user || user.disabled) throw fail(401, 'Cuenta no disponible.');
    return { user, used, recoveryLeft: JSON.parse(row(c.userId).recovery).length };
  }

  function status(userId) {
    const r = row(userId);
    return {
      enabled: r?.pending === 0,
      pending: r?.pending === 1,
      recoveryRemaining: r?.pending === 0 ? JSON.parse(r.recovery).length : 0,
    };
  }
  function setup(user) {
    if (!staff(user)) throw fail(403, 'La verificación en dos pasos es para el equipo.');
    if (isEnabled(user.id)) throw fail(409, 'Ya está activada. Desactívala primero para configurarla de nuevo.');
    const secret = base32(randomBytes(20));
    db.prepare(
      "INSERT INTO user_mfa(user_id,secret,pending,created_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,pending=1,recovery='[]',last_step=0,created_at=excluded.created_at,enabled_at=NULL",
    ).run(user.id, seal(secret), now());
    const label = encodeURIComponent(ISSUER + ':' + user.username);
    return {
      secret,
      uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`,
    };
  }
  function enable(user, code) {
    return transaction(db, () => {
      const r = row(user.id);
      if (!r || r.pending !== 1) throw fail(409, 'Primero inicia la configuración.');
      const step = matchStep(open(r.secret), normalize(code), now(), 0);
      if (step === null) throw fail(400, 'El código no coincide. Revisa que la hora de tu teléfono sea automática.');
      db.prepare('UPDATE user_mfa SET pending=0,last_step=?,enabled_at=? WHERE user_id=?').run(step, now(), user.id);
      const codes = newRecoveryCodes(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id, user.token_hash);
      return codes;
    });
  }
  async function confirm(user, input) {
    if (typeof input.password !== 'string' || !(await checkPassword(input.password, user.password_hash)))
      throw fail(401, 'La contraseña no es correcta.');
    if (!transaction(db, () => useCode(user.id, input.code))) throw fail(401, 'El código no es correcto.');
  }

  async function handle(req, res, path, user) {
    if (!path.startsWith('/api/mfa')) return false;
    const isAdmin = user.role === 'admin';
    let m;
    if (path === '/api/mfa' && req.method === 'GET') {
      json(res, 200, { available: staff(user), ...status(user.id) });
      return true;
    }
    if (path === '/api/mfa/members' && req.method === 'GET') {
      if (!isAdmin) throw fail(403, 'Esta acción requiere un administrador.');
      json(res, 200, {
        members: Object.fromEntries(
          db
            .prepare('SELECT user_id FROM user_mfa WHERE pending=0')
            .all()
            .map(r => [r.user_id, true]),
        ),
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/mfa/setup') {
      rate('mfa-self:' + user.id, 10, 900000);
      const r = setup(user);
      audit(user, 'mfa.setup', user.id);
      json(res, 200, r);
      return true;
    }
    if (req.method === 'POST' && path === '/api/mfa/enable') {
      rate('mfa-self:' + user.id, 10, 900000);
      const codes = enable(user, (await body(req)).code);
      audit(user, 'mfa.enabled', user.id);
      json(res, 200, { recoveryCodes: codes });
      return true;
    }
    if (req.method === 'POST' && path === '/api/mfa/disable') {
      rate('mfa-self:' + user.id, 10, 900000);
      if (!isEnabled(user.id)) throw fail(409, 'La verificación en dos pasos no está activada.');
      await confirm(user, await body(req));
      db.prepare('DELETE FROM user_mfa WHERE user_id=?').run(user.id);
      audit(user, 'mfa.disabled', user.id);
      json(res, 200, { ok: true });
      return true;
    }
    if (req.method === 'POST' && path === '/api/mfa/recovery-codes') {
      rate('mfa-self:' + user.id, 10, 900000);
      if (!isEnabled(user.id)) throw fail(409, 'Activa primero la verificación en dos pasos.');
      await confirm(user, await body(req));
      const codes = transaction(db, () => newRecoveryCodes(user.id));
      audit(user, 'mfa.recovery', user.id);
      json(res, 200, { recoveryCodes: codes });
      return true;
    }
    if (req.method === 'POST' && (m = path.match(/^\/api\/mfa\/reset\/([a-f0-9-]{36})$/))) {
      if (!isAdmin) throw fail(403, 'Esta acción requiere un administrador.');
      if (m[1] === user.id) throw fail(400, 'Para tu propia cuenta usa «Desactivar».');
      const target = db.prepare('SELECT id FROM users WHERE id=?').get(m[1]);
      if (!target || !row(m[1])) throw fail(404, 'Esa persona no tiene verificación en dos pasos.');
      transaction(db, () => {
        db.prepare('DELETE FROM user_mfa WHERE user_id=?').run(m[1]);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(m[1]);
      });
      audit(user, 'mfa.reset', m[1]);
      json(res, 200, { ok: true });
      return true;
    }
    throw fail(404, 'Ruta no encontrada.');
  }
  // Emergencia: restablece la verificación de una persona al arrancar con MFA_RESET_USER=<usuario> (requiere acceso al servidor). Retira la variable después.
  function resetByUsername(username) {
    const u = db.prepare('SELECT id FROM users WHERE username=?').get(String(username).trim().toLowerCase());
    if (!u) return false;
    const had = Boolean(row(u.id));
    db.prepare('DELETE FROM user_mfa WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    return had;
  }
  return { handle, isEnabled, challenge, complete, status, resetByUsername, setup, enable, useCode };
}
