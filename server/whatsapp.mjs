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
        // con encabezado y botones si la plantilla los lleva: el módulo de plantillas lee el archivo del encabezado
        template: templates
          ? await templates.forSend(tpl)
          : { name: tpl.name, language: tpl.language, params: Array.isArray(tpl.params) ? tpl.params : [] },
      };
    }
    if (closed) {
      // un aviso del negocio con la ventana cerrada: plantilla de aviso de la marca y el mensaje queda en espera; sin plantilla, no sale
      const notice = templates?.noticeFor(m.brand_id, m.category === 'marketing' ? 'marketing' : 'utility');
      if (!notice) throw fail(409, WA_UNSENT);
      templates.ensureNotice(db.prepare('SELECT * FROM conversations WHERE id=?').get(m.conversation_id), notice);
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

  // ---- Plantillas aprobadas por Meta: las lleva el módulo server/modules/wa-templates (D-3,
  // docs/PLAN_PLANTILLAS_COMPLETAS.md). Este archivo sólo le delega las rutas publicadas (/api/whatsapp/templates*,
  // /api/conversations/:id/wa-templates), el armado de lo que sale a Meta y el aviso del negocio con la ventana cerrada.
  // El módulo se crea después de este servicio y se registra con useTemplates().
  const WA_UNSENT =
    'No se entregó: pasaron más de 24 horas desde el último mensaje de la persona y la marca no tiene una plantilla de aviso aprobada por Meta. Crea una en Operación → Sistema → Conectores → Plantillas de WhatsApp.';
  let templates = null;
  const useTemplates = api => {
    templates = api;
  };
  const needTemplates = () => {
    if (!templates) throw fail(503, 'Las plantillas de WhatsApp no están disponibles en este momento.');
    return templates;
  };
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
    // plantillas (las de administración y «Enviar plantilla» del chat): el módulo de plantillas decide el permiso
    if (
      /^\/api\/conversations\/[a-f0-9-]+\/wa-templates$/.test(path) ||
      path === '/api/whatsapp/templates' ||
      path.startsWith('/api/whatsapp/templates/')
    )
      return needTemplates().handle(req, res, path, user);
    if (!path.startsWith('/api/whatsapp')) return false;
    requireAdmin(user);
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
  return { handle, inbound, outbound, status, pick, useTemplates };
}
