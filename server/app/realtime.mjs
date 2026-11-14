// Tiempo real v2: eventos con carga para las pantallas nuevas, por el mismo WebSocket (/realtime).
//
// Los avisos de siempre (`conversation`, `crm`, `catalog`, `presence`, `read`, `typing`) no cambian: los envía
// `broadcast` de server/index.mjs y la interfaz actual responde a cada uno recargando sus datos. Lo nuevo viaja
// en un sobre con versión, que la interfaz actual ignora y las pantallas nuevas aplican sin recargar:
//
//   { "v": 2, "type": "campaign.progress", "at": 1767225600000, "brandId": "globalvet",
//     "conversationId": null, "data": { "campaignId": "…", "sent": 120, "total": 400 } }
//
//   host.realtime.emit('campaign.progress', { brandId, data: { campaignId, sent, total } });
//   host.realtime.emit('thread.note', { conversationId, data: { noteId } });
//
// A quién llega (el mismo alcance por marca y conversación que `broadcast`):
//   - sólo con `brandId`: al equipo con acceso a esa marca; nunca a un cliente;
//   - con `conversationId`: al equipo que puede ver esa conversación. Un aviso de siempre no lleva datos, así que
//     también le llega a la persona que escribe; un sobre v2 sí los lleva y ella puede leerlos en su navegador,
//     de modo que sólo se le envía si el módulo lo pide con `includeCustomer: true` (y entonces la carga no puede
//     traer nada interno: ni notas, ni responsable, ni etiquetas);
//   - sin marca ni conversación, o si la marca o la conversación no existen o no se corresponden: a nadie.
//
// `emit` no espera a la red y se puede llamar desde cualquier módulo, pero siempre DESPUÉS de confirmar la
// transacción: lo que se anuncia ya tiene que ser cierto. La carga es breve y sin secretos. Quien la recibe puede
// ver esa marca o esa conversación, pero no por eso cada dato suyo: el teléfono pasa antes por access.phone().

const TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const OPEN = 1; // WebSocket.OPEN

// `sessions` es el mapa socket → usuario de la sesión que mantiene el servidor; `canSee(conversación, usuario)` es
// su regla de visibilidad de conversaciones; `crm.canBrand` decide el acceso del equipo a la marca.
export function createRealtime({ db, crm, sessions, canSee, now = Date.now }) {
  if (!db || !sessions || typeof canSee !== 'function' || typeof crm?.canBrand !== 'function')
    throw new TypeError('createRealtime necesita { db, crm, sessions, canSee }.');
  const userRow = db.prepare('SELECT * FROM users WHERE id=?');
  const brandRow = db.prepare('SELECT 1 FROM brands WHERE id=?');
  const conversationRow = db.prepare('SELECT * FROM conversations WHERE id=?');

  // Devuelve a cuántos sockets se envió. Un tipo o una carga mal formados son un fallo de quien programa (TypeError).
  function emit(type, target) {
    const { brandId = null, conversationId = null, data = {}, includeCustomer = false } = target ?? {};
    if (typeof type !== 'string' || type.length > 60 || !TYPE.test(type))
      throw new TypeError('realtime.emit: el tipo va en minúsculas con puntos, por ejemplo campaign.progress.');
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new TypeError('realtime.emit: «data» debe ser un objeto.');
    let brand = typeof brandId === 'string' && brandId ? brandId : null;
    let conversation = null;
    if (conversationId !== null && conversationId !== undefined) {
      conversation = typeof conversationId === 'string' ? conversationRow.get(conversationId) : null;
      if (!conversation || (brand && brand !== conversation.brand_id)) return 0;
      brand = conversation.brand_id;
    }
    if (!brand || !brandRow.get(brand)) return 0;
    const at = now();
    let text;
    try {
      text = JSON.stringify({ v: 2, type, at, brandId: brand, conversationId: conversation?.id ?? null, data });
    } catch {
      throw new TypeError('realtime.emit: «data» debe poder escribirse como JSON.');
    }
    const sees = user => {
      if (!conversation) return crm.canBrand(user, brand);
      if (!canSee(conversation, user)) return false;
      return includeCustomer === true || crm.canBrand(user, brand);
    };
    const verdicts = new Map(); // una persona puede tener varias pestañas: se decide una vez por emisión
    let sent = 0;
    for (const [socket, session] of sessions) {
      if (socket.readyState !== OPEN || session.expires_at < at) continue;
      let allowed = verdicts.get(session.id);
      if (allowed === undefined) {
        const user = userRow.get(session.id); // el rol o la suspensión pudieron cambiar después de conectarse
        allowed = Boolean(user && !user.disabled && sees(user));
        verdicts.set(session.id, allowed);
      }
      if (!allowed) continue;
      try {
        socket.send(text);
        sent++;
      } catch {
        // El socket se cerró entre la comprobación y el envío: los demás reciben igual.
      }
    }
    return sent;
  }

  return { emit };
}
