# TEC Capital · Laboratorio CRM

Aplicación de pruebas multicanal: los participantes crean perfiles y envían mensajes reales a una bandeja de atención compartida. Los canales **WhatsApp, Instagram y Facebook son simulados dentro del laboratorio**. No se conecta ninguna cuenta de Meta.

**[Abrir laboratorio](https://crm-laboratorio-production.up.railway.app)** · [Repositorio público](https://github.com/teccapitalweb/tec-capital-crm-laboratorio)

## Qué puedes probar

- Registro con nombre, usuario y contraseña; identificador de prueba único, sin pedir teléfono real.
- Conversaciones cliente-equipo con WebSocket, escritura, lectura y reconexión.
- Perfiles independientes; un cliente ve sólo sus conversaciones. Asesores autorizados atienden todas las marcas de la empresa.
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

Configura códigos aleatorios largos en `ADMIN_INVITE_CODE` y `STAFF_INVITE_CODE` dentro de `.env`. **No subas ese archivo ni compartas el código administrador con los participantes.** Si los códigos están vacíos no es posible registrarse con esos roles.

1. Cliente: crear un perfil sin código, elegir un curso y enviar “Hola”.
2. Asesor: al registrarse, desplegar “Soy parte del equipo de atención” e ingresar el código de asesor.
3. Administrador: usar el código administrador para editar el catálogo y crear marcas.

El equipo puede cambiar entre la experiencia de cliente y la bandeja de atención. Cada participante conserva su usuario y contraseña; la recuperación de contraseña todavía no está implementada.

## Despliegue

El repositorio contiene `Dockerfile` y `railway.json`. Ejecutar **una sola instancia** con un volumen persistente montado en `/data` y estas variables:

| Variable | Valor/uso |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `PORT` | Puerto asignado o `3100` |
| `DATA_DIR` | `/data` |
| `APP_ORIGIN` | URL pública HTTPS exacta, sin barra final |
| `ADMIN_INVITE_CODE` | Secreto del administrador |
| `STAFF_INVITE_CODE` | Secreto del equipo |

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

Todos los asesores pertenecen a la misma empresa y pueden ver las marcas del laboratorio. Aún no hay permisos por marca, MFA, recuperación de cuenta, búsqueda completa de históricos, borrado/retención desde interfaz, carga de flyers propios en el catálogo ni notificaciones push. La bandeja lista las 300 conversaciones más recientes y el historial carga páginas de 150 mensajes. Los adjuntos propios sí pueden enviarse manualmente por chat. Los avisos en vivo requieren tener abierta la aplicación.

Usar datos ficticios. Antes de operar con clientes reales se requieren permisos por marca, recuperación y administración de cuentas, controles de invitación por persona, retención, respaldos, observabilidad y pruebas de carga. PostgreSQL y una cola compartida reemplazarán SQLite/procesamiento local si se necesitan varias instancias.

Consulta [ROADMAP.md](ROADMAP.md) para las siguientes fases.
