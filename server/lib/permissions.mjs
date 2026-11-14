// Catálogo de permisos del CRM. Vive en código: cuando existan los roles, la base sólo guardará claves.
//
// Las claves van en inglés, en minúsculas y con puntos (`<espacio>.<acción>`); la etiqueta, en español, es lo que
// ve la persona. Cada frente añade aquí sus claves en su propio espacio de nombres: una clave publicada no cambia
// de nombre ni de significado.
//
// Todavía no hay tablas de roles. Mientras llegan, cada persona del equipo tiene uno de los dos conjuntos fijos de
// abajo, que reproducen lo que el CRM permite hoy: administración lo tiene todo y un asesor conserva lo que hoy le
// deja hacer `requireStaff` dentro de sus marcas. Así las rutas nuevas se escriben desde ya contra el catálogo y el
// día que lleguen los roles nadie gana ni pierde nada. Quién pregunta y cómo: server/lib/access.mjs.

const define = (group, labels) => Object.entries(labels).map(([key, label]) => [key, Object.freeze({ group, label })]);

export const PERMISSIONS = Object.freeze(
  Object.fromEntries([
    ...define('Bandeja', {
      'inbox.view': 'Ver conversaciones',
      'inbox.reply': 'Responder, enviar materiales y plantillas, reaccionar y transferir',
      'inbox.note': 'Escribir notas internas y mencionar',
      'inbox.take': 'Tomar conversaciones sin responsable',
      'inbox.assign': 'Asignar o reasignar a otras personas y equipos, y liberar chats ajenos',
      'inbox.manage_others': 'Actuar en conversaciones de otro responsable y recibir escalamientos',
      'inbox.resolve': 'Resolver, poner pendiente, reabrir y archivar conversaciones',
      'inbox.assistant': 'Devolver una conversación al asistente',
      'inbox.priority': 'Cambiar la prioridad de una conversación',
      'inbox.bulk': 'Hacer acciones masivas en la bandeja',
      'inbox.start': 'Iniciar conversaciones con plantilla',
      'inbox.block': 'Bloquear contactos',
      'inbox.unblock': 'Desbloquear contactos',
      'inbox.export': 'Descargar transcripciones',
      'inbox.views.share': 'Compartir vistas guardadas',
    }),
    ...define('Contactos', {
      'contacts.view': 'Ver la lista y las fichas de contactos',
      'contacts.phone': 'Ver teléfono y correo completos',
      'contacts.create': 'Crear contactos',
      'contacts.edit': 'Editar contactos y sus atributos',
      'contacts.tags.apply': 'Aplicar y crear etiquetas',
      'contacts.tags.manage': 'Renombrar, fusionar y archivar etiquetas',
      'contacts.consent': 'Registrar consentimiento y baja',
      'contacts.consent.reactivate': 'Reactivar a quien pidió la baja',
      'contacts.merge': 'Fusionar contactos',
      'contacts.archive': 'Archivar y restaurar contactos',
      'contacts.erase': 'Solicitar la eliminación de un contacto',
      'contacts.import': 'Importar contactos',
      'contacts.export': 'Exportar contactos',
      'contacts.bulk': 'Editar contactos en lote',
      'contacts.attributes.manage': 'Definir atributos personalizados',
    }),
    ...define('Ventas', {
      'sales.opportunities': 'Gestionar oportunidades y tareas',
      'sales.charge': 'Crear pedidos con el botón Cobrar',
    }),
    ...define('Equipo', {
      'team.view': 'Ver integrantes, equipos y disponibilidad',
      'team.manage': 'Invitar, suspender y asignar marcas, roles y equipos',
      'team.roles': 'Crear y editar roles',
      'team.availability': 'Cambiar la disponibilidad de otras personas',
      'team.sessions': 'Cerrar las sesiones de otras personas',
    }),
    ...define('Ajustes', {
      'settings.hours': 'Configurar horarios de atención y festivos',
      'settings.routing': 'Configurar el reparto de conversaciones y los objetivos de tiempo',
      'settings.inbox': 'Configurar el ciclo de vida y la reapertura de conversaciones',
      'settings.quickreplies': 'Administrar las respuestas rápidas compartidas',
      'settings.library': 'Administrar la biblioteca de archivos',
      'settings.costs': 'Ver los importes de mensajería',
    }),
    ...define('Seguridad', {
      'security.manage': 'Definir la política de acceso y la verificación en dos pasos',
      'audit.view': 'Ver la bitácora',
      'audit.export': 'Exportar la bitácora',
    }),
    ...define('Difusiones', {
      'campaigns.view': 'Ver difusiones y sus resultados',
      'campaigns.edit': 'Crear y editar borradores de difusiones',
      'campaigns.send': 'Programar, pausar, reanudar y cancelar difusiones',
      'campaigns.export': 'Exportar los resultados de una difusión',
      'audiences.edit': 'Crear y editar audiencias',
    }),
    ...define('Automatización', {
      'automation.manage': 'Editar reglas, flujos y secuencias',
    }),
    ...define('Estadísticas', {
      'analytics.view': 'Ver los tableros de estadísticas',
      'analytics.export': 'Exportar estadísticas',
      'cx.review': 'Revisar la puntuación de experiencia de las conversaciones',
    }),
    ...define('Canales', {
      'channels.whatsapp.connect': 'Conectar y desconectar números de WhatsApp',
      'templates.manage': 'Administrar las plantillas de WhatsApp',
      'connections.manage': 'Administrar las conexiones con otros servicios',
    }),
    ...define('Desarrolladores', {
      'developer.keys.manage': 'Administrar las llaves de la API',
    }),
    ...define('Privacidad', {
      'privacy.person.export': 'Exportar los datos de una persona',
      'privacy.person.erase': 'Eliminar los datos de una persona',
    }),
    ...define('Empresa', {
      'company.profile.edit': 'Editar el perfil de la empresa',
      'company.users.manage': 'Administrar las cuentas de la empresa',
      'company.sso.configure': 'Configurar el inicio de sesión único',
      'company.security.policies': 'Definir las políticas de seguridad de la empresa',
      'company.data.export': 'Exportar los datos de la empresa',
      'company.data.delete': 'Eliminar los datos de la empresa',
      'company.usage.view': 'Ver el uso de la empresa',
      'company.support.authorize': 'Autorizar el acceso de soporte',
      'backups.view': 'Ver los respaldos',
    }),
  ]),
);

// Lo que un asesor puede hacer hoy en las marcas a las que tiene acceso. Lo que hoy pide administración (asignar a
// otra persona, actuar en chats ajenos, fusionar, exportar, renombrar etiquetas, reactivar una baja, respuestas
// compartidas, horarios, campañas, automatización, llaves) no está en la lista. `inbox.block` todavía no tiene
// acción en el CRM: se incluye porque el rol Asesor del diseño de equipo lo trae (bloquear sí, desbloquear no).
const AGENT = [
  'inbox.view',
  'inbox.reply',
  'inbox.note',
  'inbox.take',
  'inbox.resolve',
  'inbox.assistant',
  'inbox.priority',
  'inbox.block',
  'contacts.view',
  'contacts.phone',
  'contacts.create',
  'contacts.edit',
  'contacts.tags.apply',
  'contacts.consent',
  'sales.opportunities',
  'sales.charge',
  'team.view',
];

// Los dos conjuntos fijos, por `users.role`. Un cliente (`customer`) no tiene ninguno.
export const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(Object.keys(PERMISSIONS)),
  agent: Object.freeze(AGENT),
});

const granted = Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([role, keys]) => [role, new Set(keys)]));

export const isPermission = key => typeof key === 'string' && Object.hasOwn(PERMISSIONS, key);
export const isRole = role => typeof role === 'string' && Object.hasOwn(ROLE_PERMISSIONS, role);
// ¿El conjunto fijo de ese rol incluye el permiso? No mira marcas: eso lo decide access.can().
export const roleHas = (role, key) => isRole(role) && granted[role].has(key);
