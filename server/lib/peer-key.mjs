// Huella con llave de una persona (teléfono o identificador de usuario) para lo que se guarda en claro y sólo sirve
// para comparar: el carril de la bandeja de webhooks y los ids de eventos que dependen de una persona. Un SHA-256 sin
// llave de un teléfono se revierte probando todos los números posibles; un HMAC-SHA256 con una llave de la instalación,
// no, mientras la llave no salga del servidor.
//
// La llave sale, por este orden, de:
//   PEER_HASH_KEY        variable de entorno (cualquier texto; se deriva una llave de 32 bytes con SHA-256)
//   DATA_DIR/peer.key    archivo creado la primera vez, sólo lectura para su dueño (como mfa.key). Persiste entre
//                        reinicios; NUNCA va al repositorio. Al restaurar un respaldo no hace falta restaurarlo: las
//                        huellas sólo deben ser estables mientras haya eventos pendientes (ver PLAN_CONTRATO_CANAL.md).
// Sin ninguno de los dos (pruebas que crean un adaptador suelto), una llave al azar sólo para ese proceso.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PEER_KEY_FILE = 'peer.key';
const LENGTH = 16; // caracteres hexadecimales de la huella (64 bits): sobra para no confundir a dos personas

export function loadPeerKey({ env = process.env, dataDir = null } = {}) {
  const fromEnv = String(env.PEER_HASH_KEY ?? '').trim();
  if (fromEnv) return createHash('sha256').update(fromEnv).digest();
  if (!dataDir) return randomBytes(32);
  const file = resolve(dataDir, PEER_KEY_FILE);
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error; // otro proceso la creó a la vez: se usa la suya
    }
  }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new Error(PEER_KEY_FILE + ' no válido.');
  return key;
}

// Devuelve hash(valor) → 16 caracteres hexadecimales, estables para la misma llave.
export function createPeerHash(key) {
  if (!Buffer.isBuffer(key) || key.length < 16)
    throw new TypeError('createPeerHash necesita una llave de 16 bytes o más.');
  return value =>
    createHmac('sha256', key)
      .update(String(value ?? ''))
      .digest('hex')
      .slice(0, LENGTH);
}
