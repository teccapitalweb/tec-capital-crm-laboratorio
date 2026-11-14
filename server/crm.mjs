import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { createFollowup } from './followup.mjs';
import { defaultEditionId } from './catalogue-schema.mjs';
import { phoneKey } from './lib/identity-keys.mjs';

const tokenHash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max = 500) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
// La clave de teléfono es interna: el servidor compara con ella y no viaja en las respuestas.
const publicContact = ({ phone_key, ...contact }) => contact;
// Las partes de GET /api/crm, en el orden de siempre.
const SNAPSHOT_PARTS = Object.freeze(['contacts', 'opportunities', 'tasks', 'members', 'preferences']);
export const stages = ['nuevo', 'interesado', 'inscripcion', 'ganada', 'perdida'];

export function migrateCRM(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 3) return;
  transaction(db, () => {
    db.exec(`
      ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE brand_members (user_id TEXT NOT NULL REFERENCES users(id),brand_id TEXT NOT NULL REFERENCES brands(id),PRIMARY KEY(user_id,brand_id));
      INSERT INTO brand_members SELECT u.id,b.id FROM users u CROSS JOIN brands b WHERE u.role='agent';
      CREATE TABLE team_invites (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,username TEXT NOT NULL,brand_ids TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,used_by TEXT REFERENCES users(id),revoked_at INTEGER);
      CREATE TABLE recovery_tokens (id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id),created_by TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL,used_at INTEGER);
      CREATE TABLE preferences (user_id TEXT PRIMARY KEY REFERENCES users(id),signature TEXT NOT NULL DEFAULT '',availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','away')));
      CREATE TABLE contacts (id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),source_user_id TEXT REFERENCES users(id),name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'manual',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(brand_id,source_user_id));
      CREATE TABLE opportunities (id TEXT PRIMARY KEY,contact_id TEXT NOT NULL REFERENCES contacts(id),brand_id TEXT NOT NULL REFERENCES brands(id),course_id TEXT NOT NULL REFERENCES courses(id),stage TEXT NOT NULL CHECK(stage IN ('nuevo','interesado','inscripcion','ganada','perdida')),owner_id TEXT REFERENCES users(id),lost_reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX active_interest ON opportunities(contact_id,course_id) WHERE stage NOT IN ('ganada','perdida');
      CREATE INDEX opportunities_brand ON opportunities(brand_id,updated_at);
      CREATE TABLE conversation_opportunities (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),opportunity_id TEXT NOT NULL REFERENCES opportunities(id));
      CREATE TABLE tasks (id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL REFERENCES opportunities(id),brand_id TEXT NOT NULL REFERENCES brands(id),title TEXT NOT NULL,owner_id TEXT REFERENCES users(id),due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX tasks_due ON tasks(brand_id,status,due_at);
      CREATE TABLE internal_notes (id TEXT PRIMARY KEY,contact_id TEXT NOT NULL REFERENCES contacts(id),brand_id TEXT NOT NULL REFERENCES brands(id),author_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE opportunity_events (id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL REFERENCES opportunities(id),actor_id TEXT REFERENCES users(id),from_stage TEXT,to_stage TEXT NOT NULL,created_at INTEGER NOT NULL);
      PRAGMA user_version=3;
    `);
  });
}

export function createCRM({ db, body, json, audit, passwordHash, checkPassword, rate, disconnect, broadcast }) {
  const isStaff = u => u && !u.disabled && ['admin', 'agent'].includes(u.role);
  const canBrand = (u, id) => {
    const current = u && db.prepare('SELECT id,role,disabled FROM users WHERE id=?').get(u.id);
    return (
      isStaff(current) &&
      (current.role === 'admin' ||
        Boolean(db.prepare('SELECT 1 FROM brand_members WHERE user_id=? AND brand_id=?').get(current.id, id)))
    );
  };
  const requireBrand = (u, id) => {
    if (!canBrand(u, id)) throw fail(404, 'Marca o registro no disponible.');
  };
  const brandsFor = u =>
    db
      .prepare('SELECT * FROM brands ORDER BY created_at')
      .all()
      .filter(b => u.role === 'customer' || canBrand(u, b.id));
  const validOwner = (id, brand) => {
    if (!id) return null;
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!canBrand(u, brand)) throw fail(400, 'El responsable no tiene acceso a esta marca.');
    return id;
  };
  const scoped = (table, id, user) => {
    const r = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!r) throw fail(404, 'Registro no disponible.');
    requireBrand(user, r.brand_id);
    return r;
  };
  const sendChange = brand => broadcast('crm', null, { brandId: brand });
  let assignmentGuard = () => {};
  let stageHook = () => {},
    contactHook = () => {}; // contactHook: identidad única de persona (persons.attach)
  const followup = createFollowup({
    db,
    scoped,
    validOwner,
    body,
    json,
    sendChange,
    audit,
    broadcast,
    beforeAssign: (id, owner) => assignmentGuard(id, owner),
    onStage: e => stageHook(e),
  });
  const inviteFor = (token, username) => {
    const row = db
      .prepare(
        'SELECT * FROM team_invites WHERE token_hash=? AND username=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>?',
      )
      .get(tokenHash(text(token, 200)), username, Date.now());
    if (!row) throw fail(400, 'La invitación no es válida para este usuario, venció o ya fue utilizada.');
    return row;
  };
  const acceptInvite = (token, user) => {
    const invite = inviteFor(token, user.username);
    if (user.disabled) throw fail(403, 'La cuenta está suspendida.');
    const ids = JSON.parse(invite.brand_ids);
    for (const id of ids) {
      if (!db.prepare('SELECT id FROM brands WHERE id=?').get(id))
        throw fail(400, 'La marca de la invitación ya no está disponible.');
    }
    db.prepare("UPDATE users SET role=CASE WHEN role='admin' THEN role ELSE 'agent' END WHERE id=?").run(user.id);
    for (const id of ids) db.prepare('INSERT OR IGNORE INTO brand_members VALUES(?,?)').run(user.id, id);
    db.prepare('UPDATE team_invites SET used_by=? WHERE id=?').run(user.id, invite.id);
    audit(user, 'team.invite.accepted', invite.id);
  };
  function syncConversation(c) {
    if (!c.edition_id) {
      c.edition_id = defaultEditionId(c.course_id);
      db.prepare('UPDATE conversations SET edition_id=? WHERE id=?').run(c.edition_id, c.id);
    }
    const existing = db
      .prepare('SELECT opportunity_id FROM conversation_opportunities WHERE conversation_id=?')
      .get(c.id);
    if (existing) return existing.opportunity_id;
    const now = Date.now(),
      person = db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id);
    let contact = db
      .prepare('SELECT * FROM contacts WHERE source_user_id=? AND brand_id=?')
      .get(c.customer_id, c.brand_id);
    if (!contact) {
      const id = randomUUID();
      db.prepare(
        'INSERT INTO contacts(id,brand_id,source_user_id,name,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      ).run(id, c.brand_id, c.customer_id, person.name, 'laboratorio', now, now);
      contact = { id };
      contactHook(db.prepare('SELECT * FROM contacts WHERE id=?').get(id));
    }
    let opportunity = db
      .prepare(
        "SELECT * FROM opportunities WHERE contact_id=? AND course_id=? AND edition_id=? AND stage NOT IN ('ganada','perdida')",
      )
      .get(contact.id, c.course_id, c.edition_id);
    if (!opportunity) {
      const id = randomUUID(),
        stage = c.stage === 'inscrito' ? 'ganada' : c.stage,
        owner =
          c.assigned_to && canBrand(db.prepare('SELECT * FROM users WHERE id=?').get(c.assigned_to), c.brand_id)
            ? c.assigned_to
            : null;
      db.prepare(
        'INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,owner_id,lost_reason,created_at,updated_at,edition_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(id, contact.id, c.brand_id, c.course_id, stage, owner, '', c.created_at, now, c.edition_id);
      opportunity = { id, stage };
      followup.stageEvent(id, null, null, stage, '', 'initial');
      if (stage !== 'ganada') {
        const taskId = randomUUID();
        db.prepare(
          'INSERT INTO tasks(id,opportunity_id,brand_id,title,owner_id,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(taskId, id, c.brand_id, 'Dar seguimiento al interés', owner, now + 86400000, now, now);
        followup.taskCreated(taskId, null);
      }
    }
    db.prepare('INSERT INTO conversation_opportunities VALUES(?,?)').run(c.id, opportunity.id);
    return opportunity.id;
  }
  // Idempotent backfill. Never rewrites accounts, messages, flyers or existing CRM edits.
  transaction(db, () => {
    for (const c of db.prepare('SELECT * FROM conversations ORDER BY created_at').all()) syncConversation(c);
  });

  function assignConversation(c, userId, actor = userId ? { id: userId } : null) {
    followup.assign(syncConversation(c), userId, actor);
  }
  function setStage(c, stage, actor = null, input = {}) {
    const id = syncConversation(c),
      o = db.prepare('SELECT * FROM opportunities WHERE id=?').get(id);
    if (actor) followup.checkRevision(o, input);
    const to = stage === 'inscrito' ? 'ganada' : stage;
    if (to === 'perdida' && !text(input.lostReason, 300)) throw fail(400, 'Indica el motivo desde la oportunidad.');
    return followup.changeStage(id, to, actor, text(input.lostReason, 300));
  }
  function staffList(user) {
    return db
      .prepare(
        "SELECT u.id,u.name,u.username,u.role,u.disabled,p.availability FROM users u LEFT JOIN preferences p ON p.user_id=u.id WHERE u.role IN ('agent','admin') ORDER BY u.name",
      )
      .all()
      .map(u => ({
        ...u,
        brandIds:
          u.role === 'admin'
            ? brandsFor(user).map(b => b.id)
            : db
                .prepare('SELECT brand_id FROM brand_members WHERE user_id=?')
                .all(u.id)
                .map(b => b.brand_id)
                .filter(id => canBrand(user, id)),
      }))
      .filter(u => user.role === 'admin' || (!u.disabled && u.brandIds.length));
  }
  // `parts` (GET /api/crm?parts=opportunities,tasks): sólo esas partes. Sin él, todas, como siempre. La pantalla nueva
  // de contactos pagina por su cuenta (módulo `directory`); así quien sólo necesita intereses y tareas no recibe
  // todos los contactos.
  function snapshot(user, parts = SNAPSHOT_PARTS) {
    const ids = brandsFor(user).map(b => b.id),
      placeholders = ids.map(() => '?').join(',') || 'NULL';
    const build = {
      contacts: () =>
        db
          .prepare(
            `SELECT c.*,u.test_number,(SELECT count(*) FROM opportunities o WHERE o.contact_id=c.id AND o.stage NOT IN ('ganada','perdida')) active_interests FROM contacts c LEFT JOIN users u ON u.id=c.source_user_id WHERE c.brand_id IN (${placeholders}) ORDER BY c.updated_at DESC`,
          )
          .all(...ids)
          .map(publicContact),
      opportunities: () =>
        db
          .prepare(
            `SELECT o.*,c.name contact_name,k.title course_title,e.name edition_name,e.price_cents,e.currency,u.name owner_name,(SELECT MIN(due_at) FROM tasks t WHERE t.opportunity_id=o.id AND t.status='open') next_due,(SELECT group_concat(conversation_id) FROM conversation_opportunities co WHERE co.opportunity_id=o.id) conversation_ids,(SELECT co.conversation_id FROM conversation_opportunities co JOIN conversations v ON v.id=co.conversation_id WHERE co.opportunity_id=o.id ORDER BY v.updated_at DESC LIMIT 1) conversation_id FROM opportunities o JOIN contacts c ON c.id=o.contact_id JOIN courses k ON k.id=o.course_id LEFT JOIN editions e ON e.id=o.edition_id LEFT JOIN users u ON u.id=o.owner_id WHERE o.brand_id IN (${placeholders}) ORDER BY o.updated_at DESC`,
          )
          .all(...ids),
      tasks: () =>
        db
          .prepare(
            `SELECT t.*,c.name contact_name,k.title course_title,u.name owner_name FROM tasks t JOIN opportunities o ON o.id=t.opportunity_id JOIN contacts c ON c.id=o.contact_id JOIN courses k ON k.id=o.course_id LEFT JOIN users u ON u.id=t.owner_id WHERE t.brand_id IN (${placeholders}) ORDER BY t.status,t.due_at`,
          )
          .all(...ids),
      members: () => staffList(user),
      preferences: () =>
        db.prepare('SELECT signature,availability FROM preferences WHERE user_id=?').get(user.id) || {
          signature: '',
          availability: 'available',
        },
    };
    return Object.fromEntries(parts.map(part => [part, build[part]()]));
  }
  // Lee `parts` de la dirección: null si no viene; una lista sin repetir si todas las partes existen; 400 si no.
  function snapshotParts(req) {
    const raw = new URL(req.url, 'http://localhost').searchParams.get('parts');
    if (raw === null) return null;
    const list = [...new Set(raw.split(',').map(part => part.trim()))];
    const unknown = list.find(part => !SNAPSHOT_PARTS.includes(part));
    if (unknown !== undefined)
      throw Object.assign(
        fail(400, `Parte desconocida: «${unknown.slice(0, 30)}». Usa ${SNAPSHOT_PARTS.join(', ')}.`),
        { code: 'invalid_input', field: 'parts' },
      );
    return list;
  }
  async function handle(req, res, path, user) {
    if (path === '/api/team/accept' && req.method === 'POST') {
      rate('invite:' + user.id, 10);
      const input = await body(req);
      transaction(db, () => acceptInvite(input.token, user));
      disconnect(user.id);
      json(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/profile' && req.method === 'POST') {
      const input = await body(req),
        name = text(input.name, 60);
      if (name.length < 2) throw fail(400, 'Escribe un nombre de al menos dos caracteres.');
      if (!['available', 'away'].includes(input.availability)) throw fail(400, 'Disponibilidad no válida.');
      db.prepare('UPDATE users SET name=? WHERE id=?').run(name, user.id);
      db.prepare(
        'INSERT INTO preferences VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET signature=excluded.signature,availability=excluded.availability',
      ).run(user.id, text(input.signature, 180), input.availability);
      audit(user, 'profile.updated', user.id);
      if (isStaff(user)) broadcast('crm');
      json(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/password' && req.method === 'POST') {
      rate('password:' + user.id, 8, 900000);
      const input = await body(req);
      if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128)
        throw fail(400, 'La contraseña nueva debe tener de 10 a 128 caracteres.');
      if (!(await checkPassword(text(input.currentPassword, 128), user.password_hash)))
        throw fail(400, 'La contraseña actual no coincide.');
      const value = await passwordHash(input.password);
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(value, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      disconnect(user.id);
      audit(user, 'password.changed', user.id);
      json(res, 200, { ok: true });
      return true;
    }
    if (!path.startsWith('/api/crm') && !path.startsWith('/api/team')) return false;
    if (!isStaff(user)) throw fail(403, 'Este espacio es para el equipo autorizado.');
    if (await followup.handle(req, res, path, user)) return true;
    if (path === '/api/crm' && req.method === 'GET') {
      const parts = snapshotParts(req);
      json(res, 200, parts ? snapshot(user, parts) : snapshot(user));
      return true;
    }
    if (path === '/api/team' && req.method === 'GET') {
      if (user.role !== 'admin') throw fail(403, 'Sólo administración puede gestionar accesos.');
      json(res, 200, {
        members: staffList(user),
        invites: db
          .prepare(
            'SELECT id,username,brand_ids,created_at,expires_at,used_by,revoked_at FROM team_invites ORDER BY created_at DESC LIMIT 100',
          )
          .all(),
      });
      return true;
    }
    if (path === '/api/team/invites' && req.method === 'POST') {
      if (user.role !== 'admin') throw fail(403, 'Sólo administración puede invitar.');
      rate('new-invite:' + user.id, 20);
      const input = await body(req),
        username = text(input.username, 40).toLowerCase(),
        ids = [...new Set(Array.isArray(input.brandIds) ? input.brandIds : [])];
      if (
        !/^[a-z0-9_.-]{3,40}$/.test(username) ||
        !ids.length ||
        ids.some(id => typeof id !== 'string' || !db.prepare('SELECT id FROM brands WHERE id=?').get(id))
      )
        throw fail(400, 'Indica el usuario y al menos una marca válida.');
      const token = randomBytes(24).toString('hex'),
        id = randomUUID(),
        now = Date.now();
      db.prepare(
        'INSERT INTO team_invites(id,token_hash,username,brand_ids,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
      ).run(id, tokenHash(token), username, JSON.stringify(ids), user.id, now, now + 86400000);
      audit(user, 'team.invite.created', id);
      json(res, 201, { id, token, expiresAt: now + 86400000 });
      return true;
    }
    const invite = path.match(/^\/api\/team\/invites\/([a-f0-9-]+)$/);
    if (invite && req.method === 'DELETE') {
      if (user.role !== 'admin') throw fail(403, 'Sólo administración puede revocar.');
      db.prepare('UPDATE team_invites SET revoked_at=? WHERE id=? AND used_by IS NULL').run(Date.now(), invite[1]);
      audit(user, 'team.invite.revoked', invite[1]);
      json(res, 200, { ok: true });
      return true;
    }
    const member = path.match(/^\/api\/team\/members\/([a-f0-9-]+)$/);
    if (member && req.method === 'PATCH') {
      if (user.role !== 'admin') throw fail(403, 'Sólo administración puede gestionar accesos.');
      const target = db.prepare('SELECT * FROM users WHERE id=?').get(member[1]);
      if (!target || target.role !== 'agent') throw fail(400, 'Esta acción sólo modifica asesores.');
      const input = await body(req),
        ids = [...new Set(Array.isArray(input.brandIds) ? input.brandIds : [])];
      if (ids.some(id => typeof id !== 'string' || !db.prepare('SELECT id FROM brands WHERE id=?').get(id)))
        throw fail(400, 'Marca no válida.');
      transaction(db, () => {
        db.prepare('DELETE FROM brand_members WHERE user_id=?').run(target.id);
        for (const id of ids) db.prepare('INSERT INTO brand_members VALUES(?,?)').run(target.id, id);
        db.prepare('UPDATE users SET disabled=? WHERE id=?').run(input.disabled === true ? 1 : 0, target.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
        db.prepare(
          'UPDATE conversations SET assigned_to=NULL WHERE assigned_to=? AND (brand_id NOT IN (SELECT brand_id FROM brand_members WHERE user_id=?) OR ?=1)',
        ).run(target.id, target.id, input.disabled === true ? 1 : 0);
        db.prepare(
          'UPDATE opportunities SET owner_id=NULL WHERE owner_id=? AND (brand_id NOT IN (SELECT brand_id FROM brand_members WHERE user_id=?) OR ?=1)',
        ).run(target.id, target.id, input.disabled === true ? 1 : 0);
        db.prepare(
          "UPDATE tasks SET owner_id=NULL WHERE owner_id=? AND status='open' AND (brand_id NOT IN (SELECT brand_id FROM brand_members WHERE user_id=?) OR ?=1)",
        ).run(target.id, target.id, input.disabled === true ? 1 : 0);
      });
      disconnect(target.id);
      audit(user, 'team.access.updated', target.id);
      broadcast('crm');
      json(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/team/recovery' && req.method === 'POST') {
      if (user.role !== 'admin') throw fail(403, 'Sólo administración puede recuperar cuentas.');
      rate('recover:' + user.id, 10);
      const input = await body(req),
        target = db
          .prepare('SELECT * FROM users WHERE username=? AND disabled=0')
          .get(text(input.username, 40).toLowerCase());
      if (!target || target.role === 'admin') throw fail(400, 'Selecciona una cuenta activa de asesor o participante.');
      const token = randomBytes(24).toString('hex');
      db.prepare('UPDATE recovery_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL').run(Date.now(), target.id);
      db.prepare('INSERT INTO recovery_tokens(id,token_hash,user_id,created_by,expires_at) VALUES(?,?,?,?,?)').run(
        randomUUID(),
        tokenHash(token),
        target.id,
        user.id,
        Date.now() + 1800000,
      );
      audit(user, 'recovery.created', target.id);
      json(res, 201, { token, username: target.username });
      return true;
    }
    if (path === '/api/crm/contacts' && req.method === 'POST') {
      const input = await body(req);
      requireBrand(user, input.brandId);
      const name = text(input.name, 100);
      if (name.length < 2) throw fail(400, 'Escribe el nombre del contacto.');
      const id = randomUUID(),
        now = Date.now(),
        phone = text(input.phone, 40); // se guarda como se escribió; `phone_key` es la clave con la que se compara
      transaction(db, () => {
        db.prepare(
          'INSERT INTO contacts(id,brand_id,name,phone,phone_key,email,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        ).run(id, input.brandId, name, phone, phoneKey(phone) ?? '', text(input.email, 150), now, now);
        contactHook(db.prepare('SELECT * FROM contacts WHERE id=?').get(id));
      });
      audit(user, 'contact.created', id);
      sendChange(input.brandId);
      json(res, 201, { id });
      return true;
    }
    const contact = path.match(/^\/api\/crm\/contacts\/([a-f0-9-]+)$/);
    if (contact) {
      const c = scoped('contacts', contact[1], user);
      if (req.method === 'GET') {
        json(res, 200, {
          contact: publicContact(c),
          notes: db
            .prepare(
              'SELECT n.*,u.name author_name FROM internal_notes n JOIN users u ON u.id=n.author_id WHERE n.contact_id=? ORDER BY n.created_at DESC LIMIT 100',
            )
            .all(c.id),
        });
        return true;
      }
      if (req.method === 'PATCH') {
        const input = await body(req),
          name = text(input.name, 100),
          phone = text(input.phone, 40);
        requireBrand(user, c.brand_id);
        if (name.length < 2) throw fail(400, 'Escribe el nombre del contacto.');
        transaction(db, () => {
          db.prepare('UPDATE contacts SET name=?,phone=?,phone_key=?,email=?,updated_at=? WHERE id=?').run(
            name,
            phone,
            phoneKey(phone) ?? '',
            text(input.email, 150),
            Date.now(),
            c.id,
          );
          contactHook(db.prepare('SELECT * FROM contacts WHERE id=?').get(c.id));
        });
        audit(user, 'contact.updated', c.id);
        sendChange(c.brand_id);
        json(res, 200, { ok: true });
        return true;
      }
    }
    const notes = path.match(/^\/api\/crm\/contacts\/([a-f0-9-]+)\/notes$/);
    if (notes && req.method === 'POST') {
      const c = scoped('contacts', notes[1], user),
        input = await body(req),
        value = text(input.text, 4000);
      requireBrand(user, c.brand_id);
      if (!value) throw fail(400, 'Escribe una nota.');
      db.prepare('INSERT INTO internal_notes VALUES(?,?,?,?,?,?)').run(
        randomUUID(),
        c.id,
        c.brand_id,
        user.id,
        value,
        Date.now(),
      );
      audit(user, 'note.created', c.id);
      sendChange(c.brand_id);
      json(res, 201, { ok: true });
      return true;
    }
    if (path === '/api/crm/opportunities' && req.method === 'POST') {
      const input = await body(req),
        c = scoped('contacts', input.contactId, user),
        course = db
          .prepare('SELECT * FROM courses WHERE id=? AND brand_id=? AND active=1')
          .get(input.courseId, c.brand_id);
      if (!course) throw fail(400, 'Elige un curso de la marca del contacto.');
      const editionId = input.editionId || defaultEditionId(course.id),
        edition = db
          .prepare("SELECT * FROM editions WHERE id=? AND course_id=? AND status='published'")
          .get(editionId, course.id);
      if (!edition || (edition.starts_at !== null && edition.starts_at <= Date.now()) || edition.available_seats === 0)
        throw fail(400, 'Elige una edición publicada, futura y con cupo.');
      if (
        db
          .prepare(
            "SELECT id FROM opportunities WHERE contact_id=? AND course_id=? AND edition_id=? AND stage NOT IN ('ganada','perdida')",
          )
          .get(c.id, course.id, editionId)
      )
        throw fail(409, 'Ya existe un interés activo en este curso.');
      const id = randomUUID(),
        owner = validOwner(input.ownerId || user.id, c.brand_id),
        now = Date.now(),
        due = Number(input.dueAt);
      if (!Number.isSafeInteger(due) || due < now - 60000 || due > now + 366 * 86400000 || !text(input.nextAction, 180))
        throw fail(400, 'Indica la siguiente acción y una fecha futura válida.');
      transaction(db, () => {
        db.prepare(
          'INSERT INTO opportunities(id,contact_id,brand_id,course_id,stage,owner_id,lost_reason,created_at,updated_at,edition_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(id, c.id, c.brand_id, course.id, 'nuevo', owner, '', now, now, editionId);
        db.prepare(
          'INSERT INTO tasks(id,opportunity_id,brand_id,title,owner_id,due_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(randomUUID(), id, c.brand_id, text(input.nextAction, 180), owner, due, user.id, now, now);
        followup.stageEvent(id, user, null, 'nuevo');
        for (const task of db.prepare('SELECT id FROM tasks WHERE opportunity_id=?').all(id))
          followup.taskCreated(task.id, user);
      });
      audit(user, 'opportunity.created', id);
      sendChange(c.brand_id);
      json(res, 201, { id });
      return true;
    }
    if (path === '/api/crm/tasks' && req.method === 'POST') {
      const input = await body(req),
        o = scoped('opportunities', input.opportunityId, user),
        title = text(input.title, 180),
        due = Number(input.dueAt),
        owner = validOwner(input.ownerId || o.owner_id || user.id, o.brand_id);
      if (['ganada', 'perdida'].includes(o.stage))
        throw fail(400, 'Reabre la oportunidad antes de añadir seguimiento.');
      if (!title || !Number.isSafeInteger(due) || due < Date.now() - 60000 || due > Date.now() + 366 * 86400000)
        throw fail(400, 'Escribe la tarea y una fecha futura válida.');
      const id = randomUUID(),
        now = Date.now();
      transaction(db, () => {
        db.prepare(
          'INSERT INTO tasks(id,opportunity_id,brand_id,title,owner_id,due_at,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(id, o.id, o.brand_id, title, owner, due, user.id, now, now);
        followup.taskCreated(id, user);
        audit(user, 'task.created', id);
      });
      sendChange(o.brand_id);
      json(res, 201, { id });
      return true;
    }
    throw fail(404, 'Acción no disponible.');
  }
  async function recover(input) {
    const username = text(input.username, 40).toLowerCase(),
      token = text(input.token, 200);
    if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128)
      throw fail(400, 'La contraseña debe tener de 10 a 128 caracteres.');
    const value = await passwordHash(input.password);
    let id;
    transaction(db, () => {
      const row = db
        .prepare(
          'SELECT r.*,u.disabled FROM recovery_tokens r JOIN users u ON u.id=r.user_id WHERE r.token_hash=? AND r.used_at IS NULL AND r.expires_at>? AND u.username=?',
        )
        .get(tokenHash(token), Date.now(), username);
      if (!row || row.disabled) throw fail(400, 'El código no es válido, venció o ya fue utilizado.');
      id = row.user_id;
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(value, id);
      db.prepare('UPDATE recovery_tokens SET used_at=? WHERE id=?').run(Date.now(), row.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      audit(null, 'recovery.completed', id);
    });
    disconnect(id);
  }
  // Cambia el curso de una conversación (un número de WhatsApp que atiende toda la marca). Dentro de la transacción del llamador; actualiza también «c».
  // El interés anterior NO se borra: la persona sí preguntó por ese curso. Excepción: si el curso anterior era sólo el de relleno (todavía no había
  // elegido) y su interés sigue en «nuevo», ese mismo interés pasa a ser el del curso elegido, para no dejar un seguimiento de un curso que nunca pidió.
  // Devuelve false si no se puede (la persona ya tiene otra conversación abierta de ese curso en el mismo canal).
  function moveConversation(c, courseId, editionId, { placeholder = false } = {}) {
    if (c.course_id === courseId && c.edition_id === editionId) {
      if (c.course_pending) {
        db.prepare('UPDATE conversations SET course_pending=0 WHERE id=?').run(c.id);
        c.course_pending = 0;
      }
      return true;
    }
    if (
      !db.prepare('SELECT 1 FROM courses WHERE id=? AND brand_id=? AND active=1').get(courseId, c.brand_id) ||
      !db.prepare('SELECT 1 FROM editions WHERE id=? AND course_id=?').get(editionId, courseId)
    )
      return false; // nunca a un curso de otra marca
    if (
      db
        .prepare(
          "SELECT 1 FROM conversations WHERE customer_id=? AND course_id=? AND edition_id=? AND channel=? AND status!='resolved' AND id!=?",
        )
        .get(c.customer_id, courseId, editionId, c.channel, c.id)
    )
      return false;
    const link = db.prepare('SELECT opportunity_id FROM conversation_opportunities WHERE conversation_id=?').get(c.id),
      old = link ? db.prepare('SELECT * FROM opportunities WHERE id=?').get(link.opportunity_id) : null,
      t = Date.now();
    db.prepare('UPDATE conversations SET course_id=?,edition_id=?,course_pending=0,updated_at=? WHERE id=?').run(
      courseId,
      editionId,
      t,
      c.id,
    );
    c.course_id = courseId;
    c.edition_id = editionId;
    c.course_pending = 0;
    if (old) {
      const target = db
        .prepare(
          "SELECT id FROM opportunities WHERE contact_id=? AND course_id=? AND edition_id=? AND stage NOT IN ('ganada','perdida')",
        )
        .get(old.contact_id, courseId, editionId);
      // «De relleno» sólo si ese interés nació con ESTA conversación y ninguna otra lo usa: un interés anterior de la persona en ese curso es real y no se toca.
      const filler =
        placeholder &&
        old.stage === 'nuevo' &&
        old.created_at >= c.created_at &&
        db.prepare('SELECT count(*) n FROM conversation_opportunities WHERE opportunity_id=?').get(old.id).n === 1;
      if (filler && !target) {
        db.prepare('UPDATE opportunities SET course_id=?,edition_id=?,updated_at=? WHERE id=?').run(
          courseId,
          editionId,
          t,
          old.id,
        );
        return true;
      }
      db.prepare('DELETE FROM conversation_opportunities WHERE conversation_id=?').run(c.id);
      if (filler) followup.changeStage(old.id, 'perdida', null, 'Curso de relleno: la persona eligió otro curso.'); // ya tenía un interés vivo en el curso elegido: el de relleno se cierra con su motivo
    }
    syncConversation(c);
    return true;
  }
  return {
    handle,
    canBrand,
    requireBrand,
    brandsFor,
    syncConversation,
    moveConversation,
    assignConversation,
    setStage,
    inviteFor,
    acceptInvite,
    recover,
    setAssignmentGuard: guard => {
      assignmentGuard = guard;
    },
    setStageHook: fn => {
      stageHook = fn;
    },
    setContactHook: fn => {
      contactHook = fn;
    },
    contactChanged: id => {
      const c = db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
      if (c) contactHook(c);
    },
  };
}
