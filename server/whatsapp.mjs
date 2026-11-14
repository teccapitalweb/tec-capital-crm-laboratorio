import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { transaction } from './database.mjs';
import { artworkAsset } from './demo-catalog.mjs';
import * as copy from './reply-copy.mjs';
import { brandCourses, matchCourse } from './course-match.mjs';
import { canonicalPhone } from './lib/identity-keys.mjs';

// WhatsApp real (Meta · Cloud API). docs/PLAN_WHATSAPP_REAL.md
// Convierte un mensaje que llega a un número real en cliente, conversación y mensaje del CRM —el mismo camino que sigue un
// perfil de prueba— y arma lo que sale hacia ese número. Convive con el laboratorio: una conversación es REAL cuando tiene
// wa_number/wa_peer; las demás siguen simuladas. Apagado mientras CHANNEL_CONNECTOR no sea «meta» o falten sus variables.
// La red (descargar un archivo, crear la contraseña inutilizable del cliente) ocurre SIEMPRE fuera de la transacción.
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim()
        .slice(0, max)
    : '';
const digits = v => String(v || '').replace(/\D/g, '');
const INBOUND_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
const OUTBOUND_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const MEDIA_LABEL = {
  audio: 'audios',
  video: 'videos',
  sticker: 'stickers',
  image: 'esa imagen',
  document: 'ese archivo',
};
const MEDIA_NOTE = { audio: 'Audio', video: 'Video', sticker: 'Sticker', image: 'Imagen', document: 'Archivo' };
const SKIPPED = new Set(['reaction', 'system', 'ephemeral', 'request_welcome', 'order', 'unsupported', 'unknown']);
// Tipo de Meta → messages.content_kind (columna canónica). Un botón de plantilla y un botón o lista interactivos son
// la misma cosa para el CRM: una pulsación, cuyo detalle va en messages.reply.
const CONTENT_KIND = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
  document: 'document',
  sticker: 'sticker',
  location: 'location',
  contacts: 'contacts',
  interactive: 'interactive',
  button: 'interactive',
};

export function createWhatsApp({
  db,
  env = process.env,
  crm,
  catalogue,
  payments,
  replies,
  events,
  channel,
  connectors,
  broadcast,
  audit,
  body,
  json,
  rate,
  insertMessage,
  passwordHash,
  attachmentData,
  defaultEditionId,
  dataDir,
  root,
  takeOver,
  accessConversation,
  now = Date.now,
}) {
  const requireAdmin = user => {
    const u = db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
    if (!u || u.disabled || u.role !== 'admin') throw fail(403, 'WhatsApp real lo configura un administrador.');
  };
  const numberRow = id => db.prepare('SELECT * FROM wa_numbers WHERE phone_number_id=?').get(String(id || ''));

  // ---- Contrato de canal 1.1 (docs/PLAN_CONTRATO_CANAL.md): lo que el entrante trae además del texto queda en las
  // columnas canónicas del mensaje ya guardado. Paso con nombre del camino del entrante (conciliación, fila 33): corre
  // dentro de la transacción del entrante, sin abrir otra ni hacer red, y no cambia el texto ni lo demás que ya se guardaba.
  function recordChannelFacts(messageId, conversationId, d) {
    const kind = CONTENT_KIND[String(d.kind || 'text')] || 'unsupported';
    const quoted = d.replyTo?.providerRef ? String(d.replyTo.providerRef).slice(0, 200) : null;
    const replyTo = quoted
      ? db
          .prepare('SELECT id FROM messages WHERE provider_ref=? AND conversation_id=? AND id!=?')
          .get(quoted, conversationId, messageId)?.id || null
      : null;
    const meta = {};
    if (quoted && !replyTo) meta.replyTo = { providerRef: quoted }; // citó algo que el CRM no tiene (p. ej. una difusión)
    if (d.media) meta.media = d.media;
    if (d.location) meta.location = d.location;
    if (Array.isArray(d.contacts)) meta.contacts = d.contacts;
    if (d.system) meta.system = d.system;
    db.prepare('UPDATE messages SET content_kind=?,reply=?,reply_to_id=?,forwarded=?,channel_meta=? WHERE id=?').run(
      kind,
      d.interaction ? JSON.stringify(d.interaction).slice(0, 2000) : null,
      replyTo,
      d.forwarded ? 1 : 0,
      Object.keys(meta).length ? JSON.stringify(meta).slice(0, 4000) : null,
      messageId,
    );
  }

  // ---- Qué curso y edición recibe a quien escribe por primera vez: el curso por omisión del número si tiene una edición disponible;
  // si no, la primera edición disponible de la marca; en último caso un curso activo (el asistente dirá que no hay fechas y pasará a una persona).
  function pick(number) {
    const editions = db
      .prepare(
        "SELECT e.* FROM editions e JOIN courses k ON k.id=e.course_id WHERE e.brand_id=? AND e.status='published' AND k.active=1 ORDER BY e.starts_at IS NULL,e.starts_at",
      )
      .all(number.brand_id)
      .filter(e => {
        try {
          return !catalogue.editionState(e);
        } catch {
          return false;
        }
      });
    const e = editions.find(x => x.course_id === number.course_id) || editions[0];
    if (e) return { courseId: e.course_id, editionId: e.id };
    const courses = db
        .prepare('SELECT id FROM courses WHERE brand_id=? AND active=1 ORDER BY title')
        .all(number.brand_id),
      k = courses.find(x => x.id === number.course_id) || courses[0];
    if (!k) return null;
    const any =
      db.prepare('SELECT id FROM editions WHERE id=?').get(defaultEditionId(k.id)) ||
      db.prepare('SELECT id FROM editions WHERE course_id=? ORDER BY created_at LIMIT 1').get(k.id);
    return any ? { courseId: k.id, editionId: any.id } : null;
  }
  // ---- Anuncios (número que atiende toda la marca): cada anuncio por el que llega alguien queda anotado por marca; el curso lo asigna administración
  // en Conectores. Mientras no lo asigne, se intenta reconocer el curso en el título y el texto del anuncio. Dentro de la transacción del llamador.
  const adOf = d => {
    const r = d?.referral;
    if (!r || typeof r !== 'object') return null;
    const id = text(String(r.adId || ''), 80).replace(/[^\w.:-]/g, '');
    return id ? { id, headline: text(String(r.ad || ''), 120), body: text(String(r.headline || ''), 200) } : null;
  };
  function adCourse(number, ad, t) {
    if (!ad) return null;
    const row = db.prepare('SELECT * FROM wa_ads WHERE brand_id=? AND ad_id=?').get(number.brand_id, ad.id);
    if (row)
      db.prepare(
        "UPDATE wa_ads SET hits=hits+1,last_seen=?,headline=CASE WHEN ?!='' THEN ? ELSE headline END,body=CASE WHEN ?!='' THEN ? ELSE body END WHERE brand_id=? AND ad_id=?",
      ).run(t, ad.headline, ad.headline, ad.body, ad.body, number.brand_id, ad.id);
    else if (db.prepare('SELECT count(*) n FROM wa_ads WHERE brand_id=?').get(number.brand_id).n < 500)
      db.prepare(
        'INSERT INTO wa_ads(brand_id,ad_id,headline,body,hits,first_seen,last_seen) VALUES(?,?,?,?,1,?,?)',
      ).run(number.brand_id, ad.id, ad.headline, ad.body, t, t); // tope por marca: un anuncio de más se reconoce por su texto, sin anotarse
    if (!number.multi) return null;
    const list = brandCourses(db, catalogue, number.brand_id);
    return (
      (row?.course_id && list.find(k => k.id === row.course_id)) ||
      matchCourse(list, ad.headline + ' ' + ad.body) ||
      null
    );
  }
  const displayName = (name, waId) => {
    const n = text(name, 60).replace(/[<>]/g, '');
    return n.length >= 2 ? n : 'WhatsApp ··' + waId.slice(-4);
  };

  // ---- Entrante: devuelve un texto legible para la bitácora de conectores. Lanza sólo ante un fallo inesperado (Meta lo reintentará).
  async function inbound(d, adapter) {
    const waId = digits(d?.from),
      numberId = String(d?.to || ''),
      ref = 'meta:' + String(d?.providerRef || '');
    if (!/^\d{7,20}$/.test(waId) || !d?.providerRef) return 'ignorado: entrante sin remitente o sin referencia';
    const number = numberRow(numberId);
    if (!number)
      return (
        'ignorado: el número ' +
        (numberId || '(sin identificador)') +
        ' no tiene una marca asignada (Operación → Conectores → WhatsApp real)'
      );
    if (!number.enabled) return 'ignorado: el número está en pausa en el CRM';
    const kind = String(d.kind || 'text');
    if (SKIPPED.has(kind)) return 'ignorado: tipo de mensaje «' + kind + '» sin contenido que mostrar';
    if (db.prepare('SELECT 1 FROM messages WHERE client_ref=?').get(ref))
      return 'duplicado: el mensaje ya estaba en la conversación';
    // 1) fuera de transacción: contraseña inutilizable para una persona nueva (nadie la conoce: ese cliente no inicia sesión) y descarga del archivo
    const known = db.prepare('SELECT user_id FROM wa_identities WHERE wa_id=?').get(waId),
      hash = known ? null : await passwordHash(randomBytes(32).toString('hex'));
    let file = null,
      note = '',
      unsupported = false;
    if (d.media) {
      if (INBOUND_MIME.has(d.media.mime)) {
        try {
          const got = await adapter.fetchMedia(d.media.id, { maxBytes: 4 * 1024 * 1024 });
          file = attachmentData({
            name: text(d.media.filename, 120) || '',
            type: got.mime && INBOUND_MIME.has(got.mime) ? got.mime : d.media.mime,
            base64: got.buffer.toString('base64'),
          });
        } catch {
          note =
            '[' +
            (MEDIA_NOTE[kind] || 'Archivo') +
            ' de WhatsApp que no se pudo descargar · pídele que lo envíe de nuevo]';
        }
      } else {
        unsupported = true;
        note = '[' + (MEDIA_NOTE[kind] || 'Archivo') + ' de WhatsApp · todavía no se puede abrir en el CRM]';
      }
    }
    const said = text(d.text, 4000),
      content = [said, note].filter(Boolean).join('\n');
    if (!content && !file) return 'ignorado: mensaje vacío';
    if (file) await writeFile(resolve(dataDir, 'uploads', file.storageName), file.buffer, { flag: 'wx' });
    let out;
    try {
      out = transaction(db, () => {
        if (db.prepare('SELECT 1 FROM messages WHERE client_ref=?').get(ref)) return { duplicate: true };
        const t = now();
        // 2) persona → cliente
        let identity = db.prepare('SELECT * FROM wa_identities WHERE wa_id=?').get(waId),
          userId = identity?.user_id;
        if (!identity) {
          if (!hash) throw fail(503, 'Identidad en creación; reintentar.');
          userId = randomUUID();
          const n = db.prepare('SELECT COALESCE(MAX(test_number),100000)+1 n FROM users').get().n;
          db.prepare(
            'INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)',
          ).run(userId, 'wa-' + randomBytes(8).toString('hex'), displayName(d.name, waId), hash, 'customer', n, t, t);
          db.prepare(
            'INSERT INTO wa_identities(wa_id,user_id,profile_name,created_at,last_seen) VALUES(?,?,?,?,?)',
          ).run(waId, userId, text(d.name, 60), t, t);
        } else
          db.prepare(
            "UPDATE wa_identities SET last_seen=?,profile_name=CASE WHEN ?!='' THEN ? ELSE profile_name END WHERE wa_id=?",
          ).run(t, text(d.name, 60), text(d.name, 60), waId);
        db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(t, userId);
        // 3) conversación abierta con ese número; si no hay, una nueva en el curso que toca
        let c = db
            .prepare(
              "SELECT * FROM conversations WHERE customer_id=? AND wa_number=? AND brand_id=? AND status!='resolved' ORDER BY updated_at DESC LIMIT 1",
            )
            .get(userId, number.phone_number_id, number.brand_id),
          created = false;
        const ad = adOf(d),
          fromAd = adCourse(number, ad, t),
          refJson =
            d.referral && typeof d.referral === 'object' && text(String(d.referral.ad || ''), 120)
              ? JSON.stringify({
                  source: 'ad',
                  ad: text(String(d.referral.ad), 120),
                  adId: ad?.id || null,
                  campaign: text(String(d.referral.campaign || ''), 120) || null,
                  flyerId: null,
                  headline: text(String(d.referral.headline || ''), 200) || null,
                  at: t,
                })
              : null;
        // Ya tenía una conversación abierta y ahora llega por el anuncio de OTRO curso: la conversación pasa a ese curso (salvo que tenga un pedido vigente).
        if (
          c &&
          fromAd &&
          (fromAd.id !== c.course_id || c.course_pending) &&
          !payments.openOrder(c.id) &&
          crm.moveConversation(c, fromAd.id, fromAd.editionId, { placeholder: Boolean(c.course_pending) })
        ) {
          db.prepare('UPDATE conversations SET referral=? WHERE id=?').run(refJson, c.id);
          c.referral = refJson;
          audit(null, 'conversation.course.ad', c.id);
        }
        if (!c) {
          // Número que atiende toda la marca: el curso es el del anuncio; sin anuncio (o sin curso reconocible) queda «por elegir» y el asistente lo pregunta.
          const several = number.multi ? brandCourses(db, catalogue, number.brand_id) : [],
            p = fromAd ? { courseId: fromAd.id, editionId: fromAd.editionId } : pick(number);
          if (!p)
            return { skip: 'ignorado: la marca no tiene un curso activo con edición para recibir conversaciones' };
          const pending = !fromAd && several.length > 1 ? 1 : 0;
          let id =
            db
              .prepare(
                "SELECT id FROM conversations WHERE customer_id=? AND course_id=? AND channel='whatsapp' AND status!='resolved'",
              )
              .get(userId, p.courseId)?.id || null;
          if (id)
            db.prepare('UPDATE conversations SET wa_number=?,wa_peer=? WHERE id=?').run(
              number.phone_number_id,
              waId,
              id,
            ); // ya tenía una abierta de ese curso (escribió a otro número): continúa ahí
          else {
            id = randomUUID();
            db.prepare(
              'INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at,edition_id,referral,wa_number,wa_peer,course_pending) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            ).run(
              id,
              userId,
              number.brand_id,
              p.courseId,
              'whatsapp',
              t,
              t,
              p.editionId,
              refJson,
              number.phone_number_id,
              waId,
              pending,
            );
            created = true;
          }
          c = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
          crm.syncConversation(c);
          const contact = db
            .prepare("SELECT id FROM contacts WHERE source_user_id=? AND brand_id=? AND phone=''")
            .get(userId, c.brand_id);
          if (contact) {
            // El contacto guarda el teléfono canónico («+52» más diez dígitos, sin el 1 que Meta pone en «521…») y su
            // clave: así es el mismo número que el capturado a mano o importado. `wa_peer` conserva el identificador
            // tal como llegó, que es al que se le contesta. Si no se reconoce como teléfono, se guarda tal cual.
            const phone = canonicalPhone(waId, { international: true });
            db.prepare("UPDATE contacts SET phone=?,phone_key=?,source='whatsapp',updated_at=? WHERE id=?").run(
              phone.e164 ?? '+' + waId,
              phone.key ?? '',
              t,
              contact.id,
            );
            crm.contactChanged(contact.id);
          } // identidad única de persona por teléfono
        }
        // 4) mensaje, igual que el de un perfil de prueba: comprobante si hay pedido vigente, y si no, el asistente responde
        let attachmentId = null;
        if (file) {
          attachmentId = randomUUID();
          db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?)').run(
            attachmentId,
            c.id,
            userId,
            file.filename,
            file.storageName,
            file.mime,
            file.buffer.length,
            t,
          );
        }
        if (!attachmentId) replies.resumeIfPausedByMode(c);
        const messageId = insertMessage(c, { id: userId, role: 'customer' }, content, 'customer', ref, attachmentId);
        db.prepare('UPDATE messages SET provider_ref=? WHERE id=?').run(String(d.providerRef).slice(0, 200), messageId);
        recordChannelFacts(messageId, c.id, d);
        const fresh = db.prepare('SELECT * FROM conversations WHERE id=?').get(c.id),
          receiptId = attachmentId ? payments.attachReceipt(fresh, messageId, attachmentId) : null,
          botOn = Boolean(fresh.bot_enabled && !fresh.assigned_to && fresh.status === 'open');
        if (!receiptId && botOn) {
          if (unsupported && !said)
            insertMessage(
              fresh,
              null,
              copy.unsupportedMedia(MEDIA_LABEL[kind] || 'ese tipo de archivo'),
              'automation',
              'wa-unsupported:' + messageId,
            ); // audio, video o sticker sin texto: se pide por escrito, sin gastar una consulta
          else
            db.prepare('INSERT INTO jobs(id,conversation_id,message_id,due_at) VALUES(?,?,?,?)').run(
              randomUUID(),
              c.id,
              messageId,
              t + 700,
            );
        }
        return { c: fresh, created, userId, messageId, receipt: Boolean(receiptId) };
      });
    } catch (e) {
      if (file) await unlink(resolve(dataDir, 'uploads', file.storageName)).catch(() => {});
      throw e;
    }
    if (out.duplicate || out.skip) {
      if (file) await unlink(resolve(dataDir, 'uploads', file.storageName)).catch(() => {});
      return out.skip || 'duplicado: el mensaje ya estaba en la conversación';
    }
    if (out.created) {
      audit(null, 'conversation.created.whatsapp', out.c.id);
      events.publish({
        type: 'conversacion.abierta',
        brandId: out.c.brand_id,
        entityKind: 'conversation',
        entityId: out.c.id,
        payload: {
          channel: 'whatsapp',
          courseId: out.c.course_id,
          editionId: out.c.edition_id,
          referral: out.c.referral ? true : false,
          customerId: out.userId,
          real: true,
        },
        actorId: out.userId,
        source: 'inbox',
      });
    }
    broadcast('conversation', out.c.id);
    broadcast('crm', null, { brandId: out.c.brand_id });
    return (
      'recibido: ' +
      (out.created ? 'conversación nueva' : 'conversación existente') +
      (file ? ' · con archivo' : '') +
      (out.receipt ? ' · comprobante en revisión' : '')
    );
  }

  // ---- Saliente: lo que viaja a Meta para un mensaje ya guardado (texto, botones y, si WhatsApp lo admite, el archivo o el flyer).
  async function outbound(row, { closed = false } = {}) {
    const m = db
      .prepare(
        'SELECT m.id,m.text,m.buttons,m.attachment_id,m.flyer_snapshot,m.conversation_id,m.category,m.wa_template,c.brand_id,c.wa_number,c.wa_peer FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?',
      )
      .get(row.id);
    if (!m || !m.wa_peer || !m.wa_number) throw fail(409, 'La conversación no tiene un número de WhatsApp de destino.');
    if (m.wa_template) {
      let tpl = null;
      try {
        tpl = JSON.parse(m.wa_template);
      } catch {}
      if (!tpl?.name) throw fail(422, 'La plantilla del mensaje no es válida.');
      return {
        id: m.id,
        conversationId: m.conversation_id,
        brandId: m.brand_id,
        to: m.wa_peer,
        from: m.wa_number,
        text: m.text || '',
        template: { name: tpl.name, language: tpl.language, params: Array.isArray(tpl.params) ? tpl.params : [] },
      };
    }
    if (closed) {
      // un aviso del negocio con la ventana cerrada: plantilla de aviso de la marca y el mensaje queda en espera; sin plantilla, no sale
      const notice = noticeFor(m.brand_id, m.category === 'marketing' ? 'marketing' : 'utility');
      if (!notice) throw fail(409, WA_UNSENT);
      ensureNotice(db.prepare('SELECT * FROM conversations WHERE id=?').get(m.conversation_id), notice);
      return { hold: true };
    }
    let body = m.text || '',
      source = null;
    if (m.attachment_id) {
      const a = db.prepare('SELECT filename,storage_name,mime FROM attachments WHERE id=?').get(m.attachment_id);
      if (a) source = { path: resolve(dataDir, 'uploads', a.storage_name), mime: a.mime, filename: a.filename };
    } else if (m.flyer_snapshot) {
      let snap = null;
      try {
        snap = JSON.parse(m.flyer_snapshot);
      } catch {}
      if (snap) {
        if (snap.libraryFileId) {
          const f = db
              .prepare('SELECT filename,mime,storage_name,builtin_id FROM library_files WHERE id=?')
              .get(snap.libraryFileId),
            asset = f?.builtin_id ? artworkAsset(f.builtin_id) : null;
          if (f?.storage_name)
            source = { path: resolve(dataDir, 'library', f.storage_name), mime: f.mime, filename: f.filename };
          else if (asset)
            source = {
              path: resolve(root, 'public', 'flyers', asset.filename),
              mime: asset.mime,
              filename: asset.filename,
            };
        } else if (snap.artworkId) {
          const asset = artworkAsset(snap.artworkId);
          if (asset)
            source = {
              path: resolve(root, 'public', 'flyers', asset.filename),
              mime: asset.mime,
              filename: asset.filename,
            };
        }
        if (!body && snap.course?.title) body = 'Información de ' + snap.course.title;
      }
    }
    let media = null;
    if (source && OUTBOUND_MIME.has(source.mime)) {
      try {
        media = { buffer: await readFile(source.path), mime: source.mime, filename: source.filename };
      } catch {
        media = null;
      }
    }
    if (source && !media && m.attachment_id)
      throw fail(
        422,
        'El archivo adjunto no se puede enviar por WhatsApp (formato no admitido o archivo no disponible).',
      );
    let buttons = null;
    try {
      buttons = m.buttons ? JSON.parse(m.buttons) : null;
    } catch {}
    return {
      id: m.id,
      conversationId: m.conversation_id,
      brandId: m.brand_id,
      to: m.wa_peer,
      from: m.wa_number,
      text: body,
      buttons,
      media,
    };
  }
  channel.useOutbound(outbound);
  connectors.useInbound(inbound);

  // ---- Plantillas aprobadas por Meta (docs/PLAN_PLANTILLAS_WHATSAPP.md). Con la ventana de 24 h cerrada, Meta sólo deja salir una plantilla.
  //  · «manual»: la envía una persona del equipo desde el chat para retomar la conversación.
  //  · «aviso» (notice): la manda el CRM cuando un aviso del negocio no puede salir; el aviso queda en espera y sale cuando la persona responde.
  // El texto se escribe con {{nombre}}, {{curso}}, {{edicion}} y {{marca}}; a Meta viaja con {{1}}…{{n}} y aquí se guarda qué dato llena cada posición.
  const KEYS = { nombre: 'Nombre de la persona', curso: 'Curso', edicion: 'Edición', marca: 'Marca' },
    SAMPLE = { nombre: 'María', curso: 'Plan sanitario para aves', edicion: 'Edición general', marca: 'GlobalVet' };
  const LANGS = ['es_MX', 'es', 'en_US', 'en'],
    WA_UNSENT =
      'No se entregó: pasaron más de 24 horas desde el último mensaje de la persona y la marca no tiene una plantilla de aviso aprobada por Meta. Crea una en Operación → Sistema → Conectores → Plantillas de WhatsApp.';
  const tplRow = id => db.prepare('SELECT * FROM wa_templates WHERE id=?').get(String(id || ''));
  const varsOf = t => {
    try {
      const v = JSON.parse(t.variables);
      return Array.isArray(v) ? v.filter(k => KEYS[k]) : [];
    } catch {
      return [];
    }
  };
  const slots = body =>
    [...new Set([...String(body).matchAll(/\{\{(\d+)\}\}/g)].map(x => Number(x[1])))].sort((a, b) => a - b);
  const tplView = t => ({
    id: t.id,
    brandId: t.brand_id,
    brandName: db.prepare('SELECT name FROM brands WHERE id=?').get(t.brand_id)?.name || t.brand_id,
    name: t.name,
    language: t.language,
    category: t.category,
    purpose: t.purpose,
    body: t.body,
    variables: varsOf(t),
    status: t.status,
    rejectReason: t.reject_reason,
    revision: t.revision,
    syncedAt: t.synced_at,
    updatedAt: t.updated_at,
    preview: String(t.body).replace(/\{\{(\d+)\}\}/g, (_, n) => SAMPLE[varsOf(t)[Number(n) - 1]] || '…'),
  });
  // Valores de una conversación para llenar la plantilla. Sin datos de contacto: sólo nombre, curso, edición y marca.
  function render(t, c) {
    const person = db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name || '',
      course = db.prepare('SELECT title FROM courses WHERE id=?').get(c.course_id)?.title || '',
      edition = c.edition_id ? db.prepare('SELECT name FROM editions WHERE id=?').get(c.edition_id)?.name || '' : '',
      brand = db.prepare('SELECT name FROM brands WHERE id=?').get(c.brand_id)?.name || '';
    const values = {
        nombre: copy.firstName(person) || text(person, 40) || 'hola',
        curso: course,
        edicion: edition || course,
        marca: brand,
      },
      clean = v =>
        String(v ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200) || '—';
    const params = varsOf(t).map(k => clean(values[k]));
    return { params, text: String(t.body).replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '') };
  }
  const noticeFor = (brandId, category) =>
    db
      .prepare(
        "SELECT * FROM wa_templates WHERE brand_id=? AND purpose='notice' AND status='approved' AND category=? ORDER BY created_at DESC,id LIMIT 1",
      )
      .get(brandId, category);
  // Un solo aviso por periodo cerrado (desde el último mensaje de la persona), aunque haya varios mensajes en espera.
  function ensureNotice(c, t) {
    const last =
        db
          .prepare("SELECT MAX(created_at) t FROM messages WHERE conversation_id=? AND sender_kind='customer'")
          .get(c.id).t || 0,
      ref = 'wa-notice:' + c.id + ':' + last;
    const prev = db.prepare('SELECT id,delivery_state FROM messages WHERE client_ref=?').get(ref);
    if (prev) {
      if (
        prev.delivery_state === 'failed' &&
        db
          .prepare(
            "UPDATE messages SET delivery_state='sent',failed_reason=NULL,provider_ref=NULL WHERE id=? AND delivery_state='failed'",
          )
          .run(prev.id).changes
      )
        broadcast('conversation', c.id);
      return false;
    } // el aviso anterior falló: vuelve a salir
    const made = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM messages WHERE client_ref=?').get(ref)) return false;
      const r = render(t, c);
      insertMessage(c, null, r.text, 'automation', ref, null, null, null, {
        category: t.category,
        template: { name: t.name, language: t.language, params: r.params, templateId: t.id, notice: true },
      });
      return true;
    });
    if (made) broadcast('conversation', c.id);
    return made;
  }
  function saveTemplate(input, user) {
    const brandId = String(input.brandId || ''),
      name = String(input.name || '')
        .trim()
        .toLowerCase(),
      language = LANGS.includes(input.language) ? input.language : 'es_MX',
      category = input.category === 'marketing' ? 'marketing' : 'utility',
      purpose = input.purpose === 'notice' ? 'notice' : 'manual',
      raw = text(input.body, 1024);
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(400, 'Elige la marca de la plantilla.');
    if (!/^[a-z0-9_]{3,60}$/.test(name))
      throw fail(
        400,
        'El nombre de la plantilla va en minúsculas, sin espacios ni acentos: letras, números y guion bajo (por ejemplo aviso_novedad).',
      );
    if (raw.length < 10) throw fail(400, 'Escribe el texto de la plantilla (al menos 10 caracteres).');
    if (/\{\{\s*\d+\s*\}\}/.test(raw))
      throw fail(400, 'Usa los datos por su nombre: {{nombre}}, {{curso}}, {{edicion}} o {{marca}}.');
    const order = [],
      body = raw.replace(/\{\{\s*([a-zñ]+)\s*\}\}/gi, (m, k) => {
        const key = k.toLowerCase().replace('edición', 'edicion');
        if (!KEYS[key])
          throw fail(400, '«' + m + '» no es un dato disponible. Usa {{nombre}}, {{curso}}, {{edicion}} o {{marca}}.');
        if (!order.includes(key)) order.push(key);
        return '{{' + (order.indexOf(key) + 1) + '}}';
      });
    if (/\{\{|\}\}/.test(body.replace(/\{\{\d+\}\}/g, ''))) throw fail(400, 'Hay llaves sin cerrar en el texto.');
    if (/^\{\{\d+\}\}/.test(body) || /\{\{\d+\}\}$/.test(body))
      throw fail(
        400,
        'Meta no acepta que el texto empiece o termine con un dato: agrega una palabra antes y un punto después.',
      );
    if (order.length > 4 || body.replace(/\{\{\d+\}\}/g, '').trim().length < order.length * 8)
      throw fail(400, 'La plantilla tiene demasiados datos para tan poco texto: Meta la rechazaría.');
    if (db.prepare('SELECT 1 FROM wa_templates WHERE name=? AND language=?').get(name, language))
      throw fail(409, 'Ya existe una plantilla con ese nombre e idioma.');
    if (db.prepare('SELECT count(*) n FROM wa_templates').get().n >= 200)
      throw fail(409, 'Se alcanzó el máximo de 200 plantillas.');
    const id = randomUUID(),
      t = now();
    db.prepare(
      "INSERT INTO wa_templates(id,brand_id,name,language,category,purpose,body,variables,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'draft',?,?,?)",
    ).run(id, brandId, name, language, category, purpose, body, JSON.stringify(order), user.id, t, t);
    audit(user, 'whatsapp.template.created', id);
    return tplView(tplRow(id));
  }
  // Las plantillas que Meta devolvió en la última sincronización y que el CRM todavía no tiene (para «usar una que ya existe»). Sólo en memoria.
  let remote = [],
    syncedAt = null;
  async function syncTemplates(user) {
    const list = await connectors.adapters.channel.meta.listTemplates(),
      t = now(),
      known = db.prepare('SELECT * FROM wa_templates').all();
    let updated = 0;
    for (const k of known) {
      if (k.status === 'draft') continue;
      const r = list.find(x => x.name === k.name && x.language === k.language); // un borrador aún no existe en Meta: aunque coincida el nombre, no es la misma plantilla
      if (r) {
        db.prepare(
          "UPDATE wa_templates SET status=?,meta_id=?,reject_reason=?,category=CASE WHEN ? IN ('utility','marketing') THEN ? ELSE category END,synced_at=?,updated_at=? WHERE id=?",
        ).run(r.status, r.metaId || k.meta_id, r.reason, r.category, r.category, t, t, k.id);
        updated++;
      } else if (k.status !== 'draft')
        db.prepare("UPDATE wa_templates SET status='missing',synced_at=?,updated_at=? WHERE id=?").run(t, t, k.id);
    }
    remote = list.filter(r => !known.some(k => k.status !== 'draft' && k.name === r.name && k.language === r.language));
    syncedAt = t;
    audit(user, 'whatsapp.template.sync', String(list.length));
    return { found: list.length, updated };
  }
  async function submitTemplate(id, user) {
    const k = tplRow(id);
    if (!k) throw fail(404, 'Plantilla no encontrada.');
    if (!['draft', 'rejected'].includes(k.status)) throw fail(409, 'Esta plantilla ya se envió a Meta.');
    const r = await connectors.adapters.channel.meta.createTemplate({
        name: k.name,
        language: k.language,
        category: k.category,
        body: k.body,
        examples: varsOf(k).map(v => SAMPLE[v]),
      }),
      t = now();
    db.prepare(
      "UPDATE wa_templates SET status=?,meta_id=?,reject_reason='',category=CASE WHEN ? IN ('utility','marketing') THEN ? ELSE category END,revision=revision+1,synced_at=?,updated_at=? WHERE id=?",
    ).run(r.status || 'pending', r.metaId || null, r.category, r.category, t, t, id);
    audit(user, 'whatsapp.template.submitted', id);
    return tplView(tplRow(id));
  }
  // Usar una plantilla que ya existe en Meta (por ejemplo la de ejemplo del número de prueba): se indica la marca y qué dato llena cada variable.
  function adoptTemplate(input, user) {
    const r = remote.find(x => x.name === String(input.name || '') && x.language === String(input.language || ''));
    if (!r)
      throw fail(
        404,
        'Esa plantilla no está en la última sincronización. Pulsa «Sincronizar con Meta» y vuelve a intentar.',
      );
    if (r.complex)
      throw fail(
        400,
        'Esa plantilla lleva un archivo o datos fuera del texto principal; este CRM sólo llena el texto.',
      );
    if (!['utility', 'marketing'].includes(r.category))
      throw fail(400, 'Sólo se usan plantillas de utilidad o de marketing.');
    const brandId = String(input.brandId || '');
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId)) throw fail(400, 'Elige la marca de la plantilla.');
    const need = slots(r.body),
      vars = (Array.isArray(input.variables) ? input.variables : []).map(String);
    if (need.some((n, i) => n !== i + 1))
      throw fail(400, 'Las variables de esa plantilla no están numeradas de corrido.');
    if (vars.length !== need.length || vars.some(k => !KEYS[k]))
      throw fail(400, 'Indica qué dato llena cada una de las ' + need.length + ' variables de la plantilla.');
    if (db.prepare('SELECT 1 FROM wa_templates WHERE name=? AND language=?').get(r.name, r.language))
      throw fail(409, 'Esa plantilla ya está en el CRM.');
    const id = randomUUID(),
      t = now();
    db.prepare(
      'INSERT INTO wa_templates(id,brand_id,name,language,category,purpose,body,variables,status,meta_id,reject_reason,created_by,created_at,updated_at,synced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      brandId,
      r.name,
      r.language,
      r.category,
      input.purpose === 'notice' ? 'notice' : 'manual',
      text(r.body, 1024),
      JSON.stringify(vars),
      r.status,
      r.metaId || null,
      r.reason || '',
      user.id,
      t,
      t,
      t,
    );
    remote = remote.filter(x => x !== r);
    audit(user, 'whatsapp.template.adopted', id);
    return tplView(tplRow(id));
  }
  function patchTemplate(id, input, user) {
    const k = tplRow(id);
    if (!k) throw fail(404, 'Plantilla no encontrada.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== k.revision)
      throw fail(409, 'La plantilla cambió. Recarga la pantalla.');
    const purpose = input.purpose === undefined ? k.purpose : input.purpose === 'notice' ? 'notice' : 'manual';
    db.prepare('UPDATE wa_templates SET purpose=?,revision=revision+1,updated_at=? WHERE id=?').run(purpose, now(), id);
    audit(user, 'whatsapp.template.updated', id);
    return tplView(tplRow(id));
  }
  function removeTemplate(id, user) {
    if (!tplRow(id)) throw fail(404, 'Plantilla no encontrada.');
    db.prepare('DELETE FROM wa_templates WHERE id=?').run(id);
    audit(user, 'whatsapp.template.removed', id);
    return { ok: true };
  } // sólo la quita del CRM; en Meta sigue existiendo
  const templatesStatus = () => ({
    wabaSet: /^\d{5,25}$/.test(String(env.META_WABA_ID || '').trim()),
    live: connectors.metaLive(),
    syncedAt,
    keys: KEYS,
    languages: LANGS,
    templates: db.prepare('SELECT * FROM wa_templates ORDER BY brand_id,name').all().map(tplView),
    remote: remote.map(r => ({
      name: r.name,
      language: r.language,
      status: r.status,
      category: r.category,
      body: r.body,
      complex: r.complex,
      variables: slots(r.body).length,
    })),
  });
  // El equipo, desde el chat: plantillas aprobadas de la marca de esa conversación, ya con los datos de esa persona.
  function chatTemplates(c, user) {
    crm.requireBrand(user, c.brand_id);
    if (!c.wa_number) return { templates: [] };
    return {
      templates: db
        .prepare("SELECT * FROM wa_templates WHERE brand_id=? AND status='approved' ORDER BY purpose,name")
        .all(c.brand_id)
        .map(t => ({ id: t.id, name: t.name, category: t.category, purpose: t.purpose, text: render(t, c).text })),
    };
  }
  function sendTemplate(c, input, user) {
    crm.requireBrand(user, c.brand_id);
    if (!c.wa_number) throw fail(409, 'Las plantillas de WhatsApp son para conversaciones de un número real.');
    const clientRef = String(input.clientRef || '');
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(clientRef)) throw fail(400, 'Referencia no válida.');
    const t = tplRow(input.templateId);
    if (!t || t.brand_id !== c.brand_id || t.status !== 'approved')
      throw fail(404, 'Esa plantilla no está aprobada para esta marca.');
    const ref = user.id + ':' + clientRef,
      existing = db.prepare('SELECT id,conversation_id FROM messages WHERE client_ref=?').get(ref);
    if (existing) {
      if (existing.conversation_id !== c.id) throw fail(409, 'Referencia ya utilizada.');
      return { id: existing.id, duplicate: true };
    }
    const out = transaction(db, () => {
      const saved = db.prepare('SELECT id FROM messages WHERE client_ref=?').get(ref);
      if (saved) return { id: saved.id, duplicate: true };
      const current = accessConversation(c.id, user);
      if (current.status === 'resolved') throw fail(409, 'La conversación está cerrada.');
      if (current.assigned_to && current.assigned_to !== user.id && user.role !== 'admin')
        throw fail(409, 'Otro asesor está atendiendo esta conversación.');
      const r = render(t, current);
      takeOver(current, user.id);
      return {
        id: insertMessage(current, user, r.text, 'agent', ref, null, null, null, {
          category: t.category,
          template: { name: t.name, language: t.language, params: r.params, templateId: t.id },
        }),
        duplicate: false,
      };
    });
    if (!out.duplicate) audit(user, 'whatsapp.template.sent', out.id);
    broadcast('conversation', c.id);
    return out;
  }

  // ---- Administración: números ↔ marcas, estado y prueba de conexión. Nunca devuelve el token ni el secreto.
  const numberView = n => ({
    phoneNumberId: n.phone_number_id,
    brandId: n.brand_id,
    brandName: db.prepare('SELECT name FROM brands WHERE id=?').get(n.brand_id)?.name || n.brand_id,
    courseId: n.course_id,
    courseTitle: n.course_id
      ? db.prepare('SELECT title FROM courses WHERE id=?').get(n.course_id)?.title || null
      : null,
    label: n.label,
    enabled: Boolean(n.enabled),
    multi: Boolean(n.multi),
    revision: n.revision,
    updatedAt: n.updated_at,
    conversations: db.prepare('SELECT count(*) n FROM conversations WHERE wa_number=?').get(n.phone_number_id).n,
    people: db
      .prepare('SELECT count(DISTINCT customer_id) n FROM conversations WHERE wa_number=?')
      .get(n.phone_number_id).n,
  });
  function status() {
    const meta = connectors.adapters.channel.meta,
      envNumber = /^\d{5,25}$/.test(String(env.META_PHONE_NUMBER_ID || '').trim())
        ? String(env.META_PHONE_NUMBER_ID).trim()
        : null,
      numbers = db.prepare('SELECT * FROM wa_numbers ORDER BY created_at').all();
    return {
      live: connectors.metaLive(),
      selected: connectors.selected.channel.provider === 'meta',
      configured: meta.configured,
      missing: meta.missing,
      envNumber,
      envNumberAssigned: envNumber ? numbers.some(n => n.phone_number_id === envNumber) : false,
      wabaSet: wabaSet(),
      webhookPath: '/api/webhooks/channel/meta',
      webhookReady: Boolean(env.META_APP_SECRET && env.META_VERIFY_TOKEN),
      numbers: numbers.map(numberView),
      brands: db.prepare('SELECT id,name FROM brands ORDER BY name').all(),
      courses: db.prepare('SELECT id,brand_id,title FROM courses WHERE active=1 ORDER BY title').all(),
      people: db.prepare('SELECT count(*) n FROM wa_identities').get().n,
      ads: db
        .prepare(
          'SELECT a.*,b.name brand_name,k.title course_title FROM wa_ads a JOIN brands b ON b.id=a.brand_id LEFT JOIN courses k ON k.id=a.course_id ORDER BY a.last_seen DESC LIMIT 100',
        )
        .all()
        .map(a => ({
          brandId: a.brand_id,
          brandName: a.brand_name,
          adId: a.ad_id,
          headline: a.headline,
          body: a.body,
          courseId: a.course_id,
          courseTitle: a.course_title || null,
          hits: a.hits,
          lastSeen: a.last_seen,
          revision: a.revision,
        })),
    };
  }
  // El curso de un anuncio. Sólo cursos activos de la marca del anuncio; «sin curso» lo deja a lo que se reconozca en su texto.
  function saveAd(input, user) {
    const brandId = String(input.brandId || ''),
      adId = String(input.adId || ''),
      courseId = input.courseId ? String(input.courseId) : null,
      row = db.prepare('SELECT * FROM wa_ads WHERE brand_id=? AND ad_id=?').get(brandId, adId);
    if (!row) throw fail(404, 'Anuncio no encontrado.');
    if (courseId && !db.prepare('SELECT 1 FROM courses WHERE id=? AND brand_id=? AND active=1').get(courseId, brandId))
      throw fail(400, 'Elige un curso activo de la marca del anuncio.');
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== row.revision)
      throw fail(409, 'El anuncio cambió. Recarga la pantalla.');
    db.prepare(
      'UPDATE wa_ads SET course_id=?,revision=revision+1,updated_by=? WHERE brand_id=? AND ad_id=? AND revision=?',
    ).run(courseId, user.id, brandId, adId, row.revision);
    audit(user, 'whatsapp.ad', adId);
    return { ok: true };
  }
  function saveNumber(id, input, user) {
    if (!/^\d{5,25}$/.test(id))
      throw fail(
        400,
        'El identificador del número son sólo dígitos: es el «Identificador del número de teléfono» que muestra Meta, no el teléfono.',
      );
    const brandId = String(input.brandId || ''),
      courseId = input.courseId ? String(input.courseId) : null;
    if (!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))
      throw fail(400, 'Elige la marca que atiende este número.');
    if (courseId && !db.prepare('SELECT 1 FROM courses WHERE id=? AND brand_id=? AND active=1').get(courseId, brandId))
      throw fail(400, 'El curso por omisión debe ser un curso activo de esa marca.');
    const current = numberRow(id),
      t = now(),
      label = text(input.label, 60),
      enabled = input.enabled === undefined ? (current ? current.enabled : 1) : input.enabled ? 1 : 0,
      multi = input.multi === undefined ? (current ? current.multi : 0) : input.multi ? 1 : 0;
    if (
      current &&
      current.brand_id !== brandId &&
      db.prepare("SELECT 1 FROM conversations WHERE wa_number=? AND status!='resolved' LIMIT 1").get(id)
    )
      throw fail(
        409,
        'Este número tiene conversaciones abiertas en ' +
          (db.prepare('SELECT name FROM brands WHERE id=?').get(current.brand_id)?.name || current.brand_id) +
          ': ciérralas antes de pasarlo a otra marca.',
      );
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== (current ? current.revision : 0))
      throw fail(409, 'El número cambió. Recarga la pantalla.');
    if (current)
      db.prepare(
        'UPDATE wa_numbers SET brand_id=?,course_id=?,label=?,enabled=?,multi=?,revision=revision+1,updated_by=?,updated_at=? WHERE phone_number_id=? AND revision=?',
      ).run(brandId, courseId, label, enabled, multi, user.id, t, id, current.revision);
    else
      db.prepare(
        'INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,enabled,multi,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(id, brandId, courseId, label, enabled, multi, user.id, t, t);
    audit(user, 'whatsapp.number', id);
    return numberView(numberRow(id));
  }
  function removeNumber(id, user) {
    const n = numberRow(id);
    if (!n) throw fail(404, 'Número no encontrado.');
    if (db.prepare('SELECT 1 FROM conversations WHERE wa_number=? LIMIT 1').get(id))
      throw fail(409, 'Este número ya tiene conversaciones: ponlo en pausa en lugar de quitarlo.');
    db.prepare('DELETE FROM wa_numbers WHERE phone_number_id=?').run(id);
    audit(user, 'whatsapp.number.removed', id);
    return { ok: true };
  }
  let pinging = false,
    lastPing = 0;
  const COOLDOWN = Math.max(0, Number(env.WA_PING_COOLDOWN_MS ?? 5000) || 0);
  async function ping(input, user) {
    if (pinging) throw fail(429, 'Ya hay una prueba en curso.');
    if (now() - lastPing < COOLDOWN) throw fail(429, 'Espera unos segundos antes de probar otra vez.');
    if (!connectors.selected.channel.provider || connectors.selected.channel.provider !== 'meta')
      return { ok: false, error: 'WhatsApp real está apagado: pon CHANNEL_CONNECTOR=meta en el entorno del servidor.' };
    pinging = true;
    try {
      const meta = connectors.adapters.channel.meta,
        r = await meta.ping(
          input?.phoneNumberId && /^\d{5,25}$/.test(String(input.phoneNumberId)) ? String(input.phoneNumberId) : null,
        );
      audit(user, 'whatsapp.ping', r.phoneNumberId);
      // además: ¿la app está suscrita a los avisos de la cuenta? Sin eso Meta no entrega los mensajes reales (sólo si hay META_WABA_ID)
      let delivery = { known: false };
      if (wabaSet()) {
        try {
          delivery = { known: true, ...(await meta.subscription()) };
        } catch (e) {
          delivery = { known: false, error: String(e?.message || '').slice(0, 200) };
        }
      }
      return { ok: true, ...r, delivery };
    } catch (e) {
      return { ok: false, error: String(e?.message || 'Meta no respondió.').slice(0, 300) };
    } finally {
      pinging = false;
      lastPing = now();
    }
  }
  const wabaSet = () => /^\d{5,25}$/.test(String(env.META_WABA_ID || '').trim());
  async function subscribe(user) {
    if (!connectors.metaLive()) throw fail(409, 'WhatsApp real no está activo.');
    await connectors.adapters.channel.meta.subscribe();
    audit(user, 'whatsapp.subscribed', 'waba');
    return { ok: true, ...(await connectors.adapters.channel.meta.subscription()) };
  }
  async function handle(req, res, path, user) {
    let x;
    if ((x = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/wa-templates$/))) {
      // equipo de la marca, desde el chat
      if (user.role === 'customer') throw fail(403, 'Esta acción es para el equipo de atención.');
      const c = accessConversation(x[1], user);
      if (req.method === 'GET') {
        json(res, 200, chatTemplates(c, user));
        return true;
      }
      if (req.method === 'POST') {
        rate('send:' + user.id, 45);
        const out = sendTemplate(c, await body(req), user);
        json(res, out.duplicate ? 200 : 201, out);
        return true;
      }
      throw fail(405, 'Método no permitido.');
    }
    if (!path.startsWith('/api/whatsapp')) return false;
    requireAdmin(user);
    if (path === '/api/whatsapp/templates' && req.method === 'GET') {
      json(res, 200, templatesStatus());
      return true;
    }
    if (path === '/api/whatsapp/templates' && req.method === 'POST') {
      json(res, 201, { template: saveTemplate(await body(req), user) });
      return true;
    }
    if (path === '/api/whatsapp/templates/sync' && req.method === 'POST') {
      rate('wa-sync:' + user.id, 12);
      json(res, 200, await syncTemplates(user));
      return true;
    }
    if (path === '/api/whatsapp/templates/adopt' && req.method === 'POST') {
      json(res, 201, { template: adoptTemplate(await body(req), user) });
      return true;
    }
    if ((x = path.match(/^\/api\/whatsapp\/templates\/([a-f0-9-]{36})(\/submit)?$/))) {
      if (x[2] && req.method === 'POST') {
        rate('wa-submit:' + user.id, 12);
        json(res, 200, { template: await submitTemplate(x[1], user) });
        return true;
      }
      if (!x[2] && req.method === 'PATCH') {
        json(res, 200, { template: patchTemplate(x[1], await body(req), user) });
        return true;
      }
      if (!x[2] && req.method === 'DELETE') {
        json(res, 200, removeTemplate(x[1], user));
        return true;
      }
    }
    if (path === '/api/whatsapp' && req.method === 'GET') {
      json(res, 200, status());
      return true;
    }
    if (path === '/api/whatsapp/ads' && req.method === 'PUT') {
      json(res, 200, saveAd(await body(req), user));
      return true;
    }
    if (path === '/api/whatsapp/subscribe' && req.method === 'POST') {
      rate('wa-sub:' + user.id, 6);
      json(res, 200, await subscribe(user));
      return true;
    }
    if (path === '/api/whatsapp/ping' && req.method === 'POST') {
      rate('wa-ping:' + user.id, 12);
      json(res, 200, await ping(await body(req), user));
      return true;
    }
    if ((x = path.match(/^\/api\/whatsapp\/numbers\/(\d{1,30})$/))) {
      if (req.method === 'PUT') {
        json(res, 200, { number: saveNumber(x[1], await body(req), user) });
        return true;
      }
      if (req.method === 'DELETE') {
        json(res, 200, removeNumber(x[1], user));
        return true;
      }
    }
    throw fail(404, 'Ruta de WhatsApp no encontrada.');
  }
  return { handle, inbound, outbound, status, pick };
}
