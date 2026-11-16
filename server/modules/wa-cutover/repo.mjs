// SQL del cambio de número (server/modules/wa-cutover). Lo de una marca recibe la marca primero.
export function createRepo(db) {
  const q = sql => db.prepare(sql);
  return {
    number: id => q('SELECT * FROM wa_numbers WHERE phone_number_id=?').get(String(id ?? '')),
    numbersOf: brandIds =>
      brandIds.length
        ? q(
            `SELECT * FROM wa_numbers WHERE brand_id IN (${brandIds.map(() => '?').join(',')}) ORDER BY created_at,phone_number_id`,
          ).all(...brandIds)
        : [],
    brandName: id => q('SELECT name FROM brands WHERE id=?').get(id)?.name ?? id,
    setMode: (brandId, id, mode, allow, t, userId, revision) =>
      q(
        'UPDATE wa_numbers SET mode=?,listen_allow=?,mode_changed_at=CASE WHEN mode!=? THEN ? ELSE mode_changed_at END,revision=revision+1,updated_by=?,updated_at=? WHERE brand_id=? AND phone_number_id=? AND revision=?',
      ).run(mode, JSON.stringify(allow), mode, t, userId, t, brandId, id, revision),
    registered: (brandId, id, t) =>
      q('UPDATE wa_numbers SET registered_at=? WHERE brand_id=? AND phone_number_id=?').run(t, brandId, id),
    log: (brandId, id, action, detail, actorId, t) =>
      q(
        'INSERT INTO wa_number_log(phone_number_id,brand_id,action,detail,actor_id,created_at) VALUES(?,?,?,?,?,?)',
      ).run(id, brandId, action, detail, actorId, t),
    history: (brandId, id, limit = 12) =>
      q(
        'SELECT l.*,u.name actor_name FROM wa_number_log l LEFT JOIN users u ON u.id=l.actor_id WHERE l.brand_id=? AND l.phone_number_id=? ORDER BY l.seq DESC LIMIT ?',
      ).all(brandId, id, limit),
    // La vuelta atrás ensayada: el último paso a activo que llegó después de un paso a escucha.
    rollbackAt: (brandId, id) =>
      q(
        "SELECT max(b.created_at) at FROM wa_number_log b WHERE b.brand_id=? AND b.phone_number_id=? AND b.action='live' AND EXISTS(SELECT 1 FROM wa_number_log a WHERE a.phone_number_id=b.phone_number_id AND a.action='listen' AND a.seq<b.seq)",
      ).get(brandId, id)?.at ?? null,
    openConversations: (brandId, id) =>
      q("SELECT count(*) n FROM conversations WHERE brand_id=? AND wa_number=? AND status!='resolved'").get(brandId, id)
        .n,
    // Quién escribió a este número desde `since` (wa_peer_state la llena el entrante, también en escucha).
    recent: (brandId, id, since, limit) =>
      q(
        'SELECT s.user_id,s.last_inbound_at FROM wa_peer_state s JOIN wa_numbers n ON n.phone_number_id=s.phone_number_id JOIN users u ON u.id=s.user_id WHERE n.brand_id=? AND s.phone_number_id=? AND s.last_inbound_at>=? ORDER BY s.last_inbound_at DESC,s.user_id LIMIT ?',
      ).all(brandId, id, since, limit),
    openWith: (brandId, id, userId) =>
      q(
        "SELECT id FROM conversations WHERE brand_id=? AND customer_id=? AND wa_number=? AND status!='resolved' LIMIT 1",
      ).get(brandId, userId, id),
    openInCourse: (brandId, userId, courseId) =>
      q(
        "SELECT id FROM conversations WHERE brand_id=? AND customer_id=? AND course_id=? AND channel='whatsapp' AND status!='resolved' LIMIT 1",
      ).get(brandId, userId, courseId),
    marked: ref => Boolean(q('SELECT 1 FROM messages WHERE client_ref=?').get(ref)),
    // El teléfono tal como llegó (al que se contesta); sin él, la conversación sale por el identificador de usuario.
    peerPhone: userId =>
      q(
        "SELECT wa_id FROM identity_keys WHERE user_id=? AND kind='wa_phone' AND wa_id IS NOT NULL ORDER BY last_seen DESC",
      ).get(userId)?.wa_id ??
      q('SELECT wa_id FROM wa_identities WHERE user_id=? ORDER BY last_seen DESC').get(userId)?.wa_id ??
      null,
    insertConversation: (brandId, c) =>
      q(
        "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,status,bot_enabled,created_at,updated_at,edition_id,wa_number,wa_peer,course_pending) VALUES(?,?,?,?,'whatsapp','waiting',0,?,?,?,?,?,?)",
      ).run(c.id, c.userId, brandId, c.courseId, c.t, c.t, c.editionId, c.numberId, c.peer, c.pending),
    conversation: id => q('SELECT * FROM conversations WHERE id=?').get(id),
  };
}
