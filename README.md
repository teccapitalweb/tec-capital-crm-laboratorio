# TEC Capital · Laboratorio CRM

Aplicación de pruebas multicanal: los participantes crean perfiles y envían mensajes reales a una bandeja de atención compartida. Los canales **WhatsApp, Instagram y Facebook son simulados dentro del laboratorio**. No se conecta ninguna cuenta de Meta.

**[Abrir laboratorio](https://crm-laboratorio-production.up.railway.app)** · [Repositorio público](https://github.com/teccapitalweb/tec-capital-crm-laboratorio)

## Primera entrega del espacio comercial · v0.2

**[Entrar al CRM del equipo](https://crm-laboratorio-production.up.railway.app/crm)** con la cuenta existente. Una persona que todavía tenga rol de cliente puede aceptar una invitación individual sin perder su perfil ni sus chats.

- **Mi día:** seguimientos propios, solicitudes de atención, intereses sin responsable y oportunidades sin próxima tarea.
- **Contactos:** fichas por marca, teléfono/correo opcionales, contactos manuales independientes de las cuentas y notas internas que nunca se envían al cliente.
- **Oportunidades:** varios cursos por contacto, tablero, responsable, motivo de pérdida y próxima acción. «Ganada · prueba» no confirma dinero ni matrícula.
- **Tareas:** programar seguimientos, completar/reabrir y consultar pendientes del equipo. Cerrar una oportunidad cancela sus tareas abiertas.
- **Mi configuración:** nombre, disponibilidad visible y firma que se puede insertar manualmente en un borrador; cambio de contraseña con cierre de sesiones.
- **Equipo:** administración invita asesores por usuario exacto y marcas. Los códigos duran 24 horas, son de un uso y sólo se almacenan como hash. Se pueden revocar; no conceden administración.
- **Recuperación asistida:** administración verifica a la persona por un medio conocido y genera un código de 30 minutos para un asesor o participante. No existe recuperación automática por correo ni recuperación de administradores desde esta interfaz.
- **Permisos:** marcas comprobadas en servidor, eventos, contactos, oportunidades, archivos, cursos y métricas. Cambiar accesos cierra sesiones y libera el trabajo de las marcas retiradas.

La migración v3 conserva perfiles, mensajes y flyers. Los asesores existentes conservan acceso a las marcas que existían al migrar; administración puede reducirlo desde Equipo. Los asesores nuevos sólo reciben las marcas de su invitación. Antes de migrar una base con usuarios se guarda una copia consistente de SQLite en `/data/backups/before-crm-v3-*.sqlite`. Esa copia previa **no sustituye** backups periódicos de base y adjuntos ni un ensayo completo de restauración.

El código administrador de entorno sólo permite crear el primer administrador cuando todavía no existe ninguno. Los antiguos códigos compartidos de asesor dejan de conceder acceso. Para incorporar personas nuevas, un administrador debe iniciar sesión y crear invitaciones. No se cambian contraseñas ni se elevan cuentas existentes automáticamente.

Esta entrega implementa el primer bloque de F0/F1. Siguen pendientes, entre otros: MFA, notificaciones fuera de la aplicación, horarios/turnos, búsqueda y navegación completas de grandes históricos, supervisores con roles específicos, automatizaciones editables, integración real de Meta, IA, pagos y gestión de ediciones/flyers. Los procesos comerciales continúan simulados.

## Qué puedes probar

- Registro con nombre, usuario y contraseña; identificador de prueba único, sin pedir teléfono real.
- Conversaciones cliente-equipo con WebSocket, escritura, lectura y reconexión.
- Perfiles independientes; un cliente ve sólo sus conversaciones. Asesores atienden las marcas autorizadas y administración conserva la vista general.
- Bandeja por canal y marca, búsqueda por nombre/número/curso y estados comerciales.
- Imágenes y PDF de hasta 4 MB, descargables sólo por participantes autorizados.
- Respuestas por curso: información, precio, temario, fecha y solicitud de asesor.
- Seis flyers fotográficos de demostración: dos por marca. Vista completa y ampliable en catálogo, envío automático y manual por chat, e imágenes históricas que conservan su versión.
- Control humano que cancela las respuestas automáticas pendientes; exclusión entre asesores.
- Catálogo editable por administradores: crear marcas, crear cursos y actualizar datos.
- Historial persistente en SQLite, trabajos automáticos persistidos y métricas de actividad real.
- Interfaz adaptable a teléfono y computadora, blanca y gris, con distintivos de canal.

**La automatización de esta versión utiliza reglas y plantillas, no un modelo de IA.** Los flyers sí se crearon con generación de imágenes. No hay cobros, inscripciones comerciales ni envíos a WhatsApp reales. Los seis cursos son ejemplos, no ofertas vigentes. No existe límite fijo de siete cuentas; la capacidad debe medirse antes de ampliar el piloto.

### Flyers incluidos

| Marca | Curso ficticio | Precio de ejemplo |
| --- | --- | --- |
| GlobalVet | Plan sanitario para aves | $379 MXN |
| GlobalVet | Nutrición en perros y gatos | $449 MXN |
| OdonTeck | Actualización en odontología | $499 MXN |
| OdonTeck | Estética dental y fotografía clínica | $599 MXN |
| Dermalysse | Fundamentos de la piel | $399 MXN |
| Dermalysse | Diseño de rutinas de cuidado facial | $459 MXN |

Los archivos originales están en `public/flyers/`. En la aplicación se entregan a través de rutas autenticadas; los mensajes conservan el identificador de su imagen al enviarse. Si se edita un curso, su diseño fijo se sustituye automáticamente por una ficha con los datos vigentes para evitar precios contradictorios. Las imágenes de mensajes anteriores no cambian. La ampliación del catálogo añade tres cursos y conserva las cuentas, chats y ediciones existentes.

## Iniciar localmente

Requiere Node.js 24 o superior.

```sh
npm ci
cp .env.example .env
npm start
```

En PowerShell, copia con `Copy-Item .env.example .env`. Abre `http://127.0.0.1:3100`.

Configura un código aleatorio largo en `ADMIN_INVITE_CODE` dentro de `.env` para crear el primer administrador. **No subas ese archivo ni compartas ese código con participantes.** `STAFF_INVITE_CODE` es una variable heredada que ya no se utiliza.

1. Cliente: crear un perfil sin código, elegir un curso y enviar “Hola”.
2. Asesor: aceptar una invitación individual desde `/crm` con su cuenta actual, o usarla al crear su perfil con el usuario exacto invitado.
3. Primer administrador: en una instalación vacía, usar el código inicial al registrarse. Administradores existentes inician sesión normalmente.

El equipo puede cambiar entre la experiencia de cliente y el CRM. Cada participante conserva su usuario y contraseña; la recuperación asistida se gestiona desde Equipo después de verificar identidad.

## Despliegue

El repositorio contiene `Dockerfile` y `railway.json`. Ejecutar **una sola instancia** con un volumen persistente montado en `/data` y estas variables:

| Variable | Valor/uso |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | Puerto asignado o `3100` |
| `DATA_DIR` | `/data` |
| `APP_ORIGIN` | URL pública HTTPS exacta, sin barra final |
| `ADMIN_INVITE_CODE` | Secreto de creación del primer administrador; no reutilizable una vez configurado |
| `STAFF_INVITE_CODE` | Heredado, sin efecto desde v0.2 |

Las cookies de producción requieren HTTPS. El volumen guarda la base de datos y los adjuntos. **GitHub Pages no ejecuta este servidor ni reemplaza la base de datos.** Publicar el código no hace públicas las conversaciones.

Para respaldo consistente, usar la API de backup de SQLite o detener la aplicación antes de copiar la base y los archivos WAL/SHM junto con `uploads/`. Los respaldos automáticos y su restauración deben configurarse y ensayarse antes de usar datos comerciales. Nunca subir copias de la base a este repositorio.

## Verificación

```sh
npm run check
npm test
```

Las pruebas levantan un servidor y una base temporal, conectan siete clientes y comprueban entrega, permisos, archivos, versiones de flyer, idempotencia, lectura, atención humana y persistencia tras reinicio. No usan Meta ni servicios de IA.

## Arquitectura y límites del piloto

Node HTTP + `ws` para comunicación; SQLite en WAL para persistencia; frontend HTML/CSS/JavaScript sin compilación. Contraseñas derivadas con scrypt, sesiones HttpOnly con tokens almacenados como hash, comprobación de origen y autorización de mensajes/archivos en el servidor. Los códigos de equipo sólo se verifican en el servidor.

Todos los asesores pertenecen a la misma empresa; su acceso se limita a las marcas asignadas. Aún no hay MFA, recuperación autónoma por correo, búsqueda completa de históricos desde interfaz, borrado/retención desde interfaz, carga de flyers propios en el catálogo ni notificaciones push. La bandeja lista las 300 conversaciones más recientes y el historial carga páginas de 150 mensajes. El resumen de CRM se carga completo para el volumen del laboratorio; debe paginarse antes de grandes históricos. Los avisos en vivo requieren tener abierta la aplicación.

Usar datos ficticios. Antes de operar con clientes reales se requieren completar retención, respaldos periódicos y restauración, observabilidad, controles de abuso y pruebas de carga, además de evaluar la seguridad de los nuevos flujos. PostgreSQL y una cola compartida reemplazarán SQLite/procesamiento local si se necesitan varias instancias. No desplegar un binario antiguo sobre una base migrada sin verificar compatibilidad: la reversión de esquema requiere restaurar la copia previa de forma controlada y evaluar los datos posteriores.

Consulta [ROADMAP.md](ROADMAP.md) para las siguientes fases.
