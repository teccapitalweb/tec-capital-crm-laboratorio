// Acceso: la única pregunta que hace un módulo nuevo para saber si alguien puede hacer algo, y dónde.
//
//   host.access.require(user, 'contacts.import', brandId);          // lanza si no puede
//   if (host.access.can(user, 'contacts.export', brandId)) { … }
//   const scope = host.access.scopeSql(user, 'c');                   // { sql: 'c.brand_id IN (?,?)', args: [...] }
//   contact.phone = host.access.phone(user, contact.phone, contact.brand_id);
//
// Hoy resuelve con los dos conjuntos fijos de server/lib/permissions.mjs (administración y asesor) y con las marcas
// que ya autoriza el CRM (`crm.canBrand`, tabla `brand_members`). Cuando existan los roles cambiará lo que hay aquí
// dentro, no quien lo llama.
//
// `scope` dice dónde se pregunta:
//   - una marca: su id (o { brandId }). Una marca autorizada no da acceso a ninguna otra.
//   - { company: true }: toda la empresa. Hoy sólo administración.
//   - sin `scope`: «en alguna de sus marcas». Sirve para decidir si una pantalla se le muestra a alguien.
//   - cualquier otra cosa (null, texto vacío): no hay dónde conceder y se niega. Así, un parámetro `brand` que
//     falta en la petición no se convierte en «todas las marcas».
//
// El rol y las marcas se leen de la base en cada pregunta: un acceso retirado deja de valer en el acto.
import { fail } from '../app/http.mjs';
import { maskPhone } from './identity-keys.mjs';
import { PERMISSIONS, isPermission, isRole, roleHas } from './permissions.mjs';

const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LAB_NUMBER = /^#\d+$/; // el número de prueba del laboratorio (#100123) no es el teléfono de nadie

function whereOf(scope) {
  if (scope === undefined) return { kind: 'any' };
  if (typeof scope === 'string') return scope ? { kind: 'brand', brandId: scope } : { kind: 'none' };
  if (scope !== null && typeof scope === 'object') {
    if (scope.company === true) return { kind: 'company' };
    if (typeof scope.brandId === 'string' && scope.brandId) return { kind: 'brand', brandId: scope.brandId };
  }
  return { kind: 'none' };
}

export function createAccess({ db, crm }) {
  if (!db || typeof crm?.canBrand !== 'function') throw new TypeError('createAccess necesita { db, crm }.');
  const userRow = db.prepare('SELECT role,disabled FROM users WHERE id=?');
  const brandRow = db.prepare('SELECT 1 FROM brands WHERE id=?');
  const allBrands = db.prepare('SELECT id FROM brands ORDER BY created_at,id');
  const memberBrands = db.prepare(
    'SELECT b.id FROM brands b JOIN brand_members m ON m.brand_id=b.id WHERE m.user_id=? ORDER BY b.created_at,b.id',
  );
  const anyBrand = db.prepare('SELECT 1 FROM brand_members WHERE user_id=? LIMIT 1');

  // 'admin', 'agent' o null (cliente, cuenta suspendida o que ya no existe).
  function roleOf(user) {
    const current = typeof user?.id === 'string' ? userRow.get(user.id) : null;
    return current && !current.disabled && isRole(current.role) ? current.role : null;
  }
  function known(perm) {
    if (!isPermission(perm)) throw new TypeError('Permiso desconocido: ' + String(perm));
  }
  // La marca existe y el CRM se la autoriza a esa persona.
  const inBrand = (user, brandId) => Boolean(brandRow.get(brandId) && crm.canBrand(user, brandId));

  function can(user, perm, scope) {
    known(perm);
    const role = roleOf(user);
    if (!roleHas(role, perm)) return false;
    const where = whereOf(scope);
    if (where.kind === 'company') return role === 'admin';
    if (where.kind === 'brand') return inBrand(user, where.brandId);
    if (where.kind === 'any') return role === 'admin' || Boolean(anyBrand.get(user.id));
    return false;
  }

  // Como hoy: a quien no es del equipo o no tiene el permiso, 403; a quien lo tiene pero no en esa marca, el mismo
  // 404 que si la marca no existiera (no se distingue «no existe» de «no es tuya»).
  function requirePermission(user, perm, scope) {
    if (can(user, perm, scope)) return;
    const role = roleOf(user);
    if (!role) throw fail(403, 'Esta acción es para el equipo de atención.', { code: 'permission_denied' });
    const kind = whereOf(scope).kind;
    if (roleHas(role, perm) && (kind === 'brand' || kind === 'none'))
      throw fail(404, 'Marca o registro no disponible.', { code: 'not_found' });
    throw fail(403, `Tu acceso no incluye «${PERMISSIONS[perm].label}».`, {
      code: 'permission_denied',
      details: { permission: perm },
    });
  }

  // Marcas de la persona, en el orden en que se crearon. Con `perm`, sólo si su conjunto incluye ese permiso.
  function brandIds(user, perm) {
    if (perm !== undefined) known(perm);
    const role = roleOf(user);
    if (!role || (perm !== undefined && !roleHas(role, perm))) return [];
    return (role === 'admin' ? allBrands.all() : memberBrands.all(user.id)).map(row => row.id);
  }

  // Predicado para acotar una consulta a las marcas de la persona. `alias` es el de la tabla que lleva `brand_id`:
  //   const scope = access.scopeSql(user, 'c');
  //   db.prepare(`SELECT c.id FROM contacts c WHERE ${scope.sql} AND c.name LIKE ?`).all(...scope.args, patron);
  function scopeSql(user, alias = '') {
    if (typeof alias !== 'string' || (alias && !ALIAS.test(alias)))
      throw new TypeError('scopeSql: el alias de la tabla no es válido.');
    const ids = brandIds(user);
    if (!ids.length) return { sql: '0=1', args: [] };
    return { sql: `${alias ? alias + '.' : ''}brand_id IN (${ids.map(() => '?').join(',')})`, args: ids };
  }

  // El teléfono completo para quien tiene `contacts.phone`; para los demás, enmascarado en el servidor (el dato
  // completo no sale de aquí). `scope` es la marca del contacto, si se conoce.
  function phone(user, value, scope) {
    if (value === null || value === undefined || value === '') return value;
    if (can(user, 'contacts.phone', scope)) return value;
    const text = String(value);
    return LAB_NUMBER.test(text) ? value : maskPhone(text);
  }

  return { can, require: requirePermission, brandIds, scopeSql, phone };
}
