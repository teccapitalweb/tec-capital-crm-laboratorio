# Conectar un asistente con un clic (OAuth del conector MCP) · 20 nov 2026

**Sin publicar** (rama de trabajo). **Esquema nuevo:** migración con nombre `mcp-oauth/0001-tables`. `MCP_OAUTH_DISABLED=1` lo apaga (las llaves de la API siguen igual). Falta probarlo con una aplicación de asistente real contra el servidor público.

**Activación: en producción hace falta `APP_ORIGIN`** (la dirección pública del CRM, por ejemplo `https://crm-laboratorio-production.up.railway.app`). Sin ella OAuth queda **apagado**: los documentos `/.well-known/…` responden 404, el 401 de `/mcp` no invita a iniciar sesión y `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` y `/oauth/decision` responden 503; el registro del servidor dice «mcp-oauth: APP_ORIGIN es obligatorio en producción…» al arrancar y, como mucho una vez por minuto, al rechazar. Así la dirección que se anuncia nunca sale de la cabecera `Host`, que la escribe quien llama. Fuera de producción (pruebas, uso local) se deduce del pedido.

## Para qué

Hasta ahora el conector del CRM (`/mcp`, [PLAN_MCP_CLAUDE.md](PLAN_MCP_CLAUDE.md)) sólo aceptaba una **llave de la API** pegada en una terminal. Una persona que no programa no puede hacer eso, y las aplicaciones de Claude (web, escritorio y celular) piden iniciar sesión con OAuth. Con esta entrega, la persona pega la dirección `/mcp` en la aplicación, el CRM se abre en el navegador, entra con su usuario de siempre, elige UNA marca y los permisos, pulsa «Permitir» y listo.

El CRM es su **propio servidor de autorización OAuth 2.1** para el recurso `/mcp`. No hay proveedor externo ni dependencias nuevas (`node:crypto`).

## Lo que pide la especificación y lo que hace el CRM

Fuentes leídas el 20 nov 2026:

- Especificación de autorización de MCP, versión 2025-11-25: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>.
- Documentación de conectores de Claude: <https://claude.com/docs/connectors/building/authentication.md> («Authentication for connectors»), <https://claude.com/docs/connectors/building/troubleshooting.md>, <https://claude.com/docs/connectors/building/testing.md> y <https://claude.com/docs/connectors/custom/add-unlisted.md>.

| Requisito | Cómo lo cumple el CRM |
| --- | --- |
| Metadatos del recurso protegido (RFC 9728) con `authorization_servers`; `resource` igual a la dirección del conector | `GET /.well-known/oauth-protected-resource/mcp` (y la raíz `/.well-known/oauth-protected-resource`): `resource = <origen>/mcp`, `authorization_servers = [<origen>]`, `scopes_supported`, `bearer_methods_supported: ["header"]` |
| `401` con `WWW-Authenticate: Bearer resource_metadata="…"` | `/mcp` sin ficha o con una mala responde 401 con esa cabecera (más `error="invalid_token"` si la ficha no vale) |
| Metadatos del servidor de autorización (RFC 8414) con `code_challenge_methods_supported` | `GET /.well-known/oauth-authorization-server`: emisor, extremos, `S256`, `none`, `client_id_metadata_document_supported: true` |
| PKCE S256 | Obligatorio; `plain` o sin reto se rechaza |
| Indicador de recurso (RFC 8707) en la autorización y en el canje | Si viene, debe ser `<origen>/mcp` (forma canónica); el permiso, el código y las fichas quedan ligados a él y `/mcp` lo vuelve a comprobar en cada uso |
| Identificación de la aplicación: documento de metadatos (preferido), registro dinámico (compatibilidad) | Los dos (ver abajo) |
| Regreso por coincidencia exacta; HTTPS o `localhost` | Exacta; `http` sólo hacia `127.0.0.1`, `localhost` o `[::1]`, y ahí el puerto no cuenta (lo exige la documentación de Claude para Claude Code) |
| Fichas sólo en la cabecera `Authorization` | La ficha nunca se lee de la dirección ni de una cookie |
| Rotación de fichas de renovación en clientes públicos; `invalid_grant` cuando ya no vale | Cada renovación da un par nuevo; reutilizar una vieja revoca todo el permiso, salvo la inmediatamente anterior dentro de los 10 s de su rotación (renovaciones en paralelo de la propia aplicación), que sólo recibe `invalid_grant` |
| Mostrar en el permiso el dominio de regreso y avisar si es local | La página muestra «Regresará a», «Identidad publicada en» (documento) y un aviso si el regreso es local |
| Claude recomienda no rechazar por cabecera `Origin` estricta | `/mcp` sigue rechazando cualquier petición con `Origin` (como hasta ahora): las aplicaciones de Claude llaman desde su servidor o desde la terminal, sin `Origin`. Si una prueba real mostrara lo contrario, se revisará aquí |

Diferencias con lo que se suponía al empezar:

- Claude prefiere el **documento de metadatos** (usa su propia identidad publicada) cuando el servidor anuncia `client_id_metadata_document_supported: true` **y** `none` en `token_endpoint_auth_methods_supported`; si no, se registra solo (registro dinámico, uno por conexión nueva). La dirección del documento de las aplicaciones web, escritorio y celular **no está publicada**; la de Claude Code sí (`https://claude.ai/oauth/claude-code-client-metadata`).
- El regreso de las aplicaciones web, escritorio y celular es `https://claude.ai/api/mcp/auth_callback`. Claude Code usa `http://localhost:<puerto>/callback` con un puerto que cambia en cada sesión.
- Claude manda `resource` en la autorización y en el canje, renueva al recibir un 401 y hasta cinco minutos antes de que caduque la ficha, y pide `offline_access` sólo si el servidor lo anuncia (el CRM no lo anuncia: siempre da ficha de renovación).
- Las aplicaciones de Claude se conectan **desde los servidores de Anthropic**: el CRM debe tener un nombre público con dirección IPv4 pública (lo tiene en Railway).

## El flujo

1. La aplicación llama a `/mcp` sin ficha → `401` con `WWW-Authenticate` → lee los dos documentos de metadatos.
2. Se identifica: con su documento (`client_id` = dirección HTTPS que el CRM descarga) o registrándose (`POST /oauth/register`).
3. Abre en el navegador `GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=…`.
4. El CRM comprueba la aplicación, la dirección de regreso, `response_type`, PKCE, `state` y `resource`. **Cualquier error antes del permiso se muestra en la página del CRM, sin redirigir** (RFC 9700 §4.11.2: una aplicación que se registró sola puede haber declarado cualquier regreso, y el CRM no debe mandar ahí a nadie que no haya hecho nada). Sólo se vuelve a la aplicación después de que la persona pulsa «Permitir» o «Cancelar».
5. Sin sesión, la página pide entrar con el usuario del equipo (las rutas de siempre, `/api/auth/login` y la verificación en dos pasos si la cuenta la tiene). Quien no es administración (asesoras, clientes, cuentas suspendidas) ve «Por ahora sólo administración puede conectar asistentes al CRM…», sin marcas ni permisos, y no se abre ninguna solicitud.
6. La página de permiso muestra la aplicación (nombre que **ella declara**, marcado como no comprobado; dominio que publica su documento; dónde regresará), un selector de **una** marca y los permisos agrupados como en la pantalla de llaves («Puede consultar» / «Puede cambiar»). Sólo vienen marcados los que no dejan ver datos personales (hoy, «Aperturas, precios y cupos»); lo que la aplicación pida en `scope` no marca nada.
7. «Permitir» manda `POST /oauth/decision` (misma sesión, mismo origen, código contra falsificación ligado a esa solicitud). El servidor vuelve a comprobar la marca y cada permiso, crea el permiso concedido y un **código de un solo uso de 60 segundos**, y la página vuelve a la aplicación. «Cancelar» vuelve con `error=access_denied`.
8. La aplicación canjea el código en `POST /oauth/token` (formulario) con su `code_verifier`: recibe una ficha de acceso (una hora) y una de renovación (30 días, rota en cada uso).
9. Desde entonces llama a `/mcp` con `Authorization: Bearer tca_…`. Para el conector es **exactamente** una llave creada por esa persona con esos permisos y esa marca.

## Quién puede dar qué

**Por ahora, conectar un asistente es cosa de administración, exactamente como crear una llave de la API**: cualquier permiso del conector (los que usa alguna herramienta), también los de lectura, exige `developer.keys.manage` en esa marca. Una asesora no puede conectar asistentes ni aprobar forjando el formulario (la solicitud es de quien abrió la página y el servidor vuelve a comprobar el permiso al aprobar y en cada uso). Si quien conectó deja de ser administración, sus fichas dejan de servir.

## Garantías

| Garantía | Cómo | Prueba (`test/mcp-oauth.test.mjs`) |
| --- | --- | --- |
| PKCE S256 obligatorio; sin flujo implícito ni de contraseña | `code_challenge_method=S256` y reto de 43 caracteres; `grant_type` sólo `authorization_code` y `refresh_token` | §4 sin reto o `plain` → `invalid_request`; §9 `password` y `client_credentials` → `unsupported_grant_type`; verificador equivocado → `invalid_grant` |
| Código de un solo uso, 60 s, ligado a aplicación, regreso, reto y recurso | Huella del código; se gasta en el primer intento, acierte o no | §9 reutilizado, otra aplicación, otro regreso, otro recurso, sin verificador, vencido |
| Reutilizar un código revoca lo que emitió | `code_reuse` revoca el permiso entero | §9 la ficha del primer canje deja de servir |
| Regreso exacto; nunca una redirección abierta | Comparación exacta (local: sin puerto); TODOS los errores antes del permiso en la página del CRM, sin `Location`; sólo se vuelve a la aplicación tras «Permitir» o «Cancelar» | §4 aplicación desconocida, regreso ajeno o distinto; y la repetición del revisor (aplicación registrada con regreso a un sitio de engaño, `response_type`, PKCE, `resource`, `state` o parámetro repetido mal puestos, con y sin sesión): 400 sin `Location`; unidad de `redirectAllowed` |
| Un documento en caché no se bloquea por el tráfico de otros | El límite (30 por minuto) cuenta sólo descargas reales y va por dirección y documento | «un documento de metadatos en caché…»: 40 visitas anónimas, una sola descarga, y administración llega a la página de permiso |
| La dirección anunciada no sale de `Host` | En producción sólo `APP_ORIGIN`; sin ella, apagado. Metadatos con `Cache-Control: no-store` | «en producción OAuth sólo se anuncia con APP_ORIGIN…»: sin ella 404, 401 sin invitación, 503 y la línea del registro; con ella, `Host: evil.example` no cambia `resource` ni `issuer`; §1 `no-store` |
| Renovaciones en paralelo no desconectan | La inmediatamente anterior, dentro de 10 s de su rotación → `invalid_grant` sin revocar; otra más vieja o fuera del margen → revoca todo | §8 cuatro renovaciones a la vez: una gana y sigue sirviendo; ficha más vieja → revoca; la anterior pasados 11 s → revoca |
| Fichas opacas de 256 bits, sólo su huella, una hora | `tca_`/`tcr_` + 32 bytes aleatorios; SHA-256 en la base | §7 la base y la bitácora no contienen ninguna ficha, código ni el código de la página; §10 ficha vencida → 401 `invalid_token` |
| Renovación con rotación y detección de reutilización | Se gasta de forma atómica al emitir; una vieja revoca el permiso | §8 nueva ficha distinta; la vieja → `invalid_grant` y todo revocado; no se amplía al renovar |
| Los permisos van en cada ficha | Cada ficha guarda con qué permisos se emitió; al usarla vale la intersección con lo que la persona puede dar hoy. Al renovar se conservan o se acotan (`scope`), nunca se amplían | §8b ficha acotada no usa `orders`; renovar pidiendo de más → `invalid_scope`; renovar sin `scope` conserva lo acotado; la persona deja de poder «modificar cursos» → la ficha lo pierde y no lo recupera |
| Revocación | `POST /oauth/revoke` (RFC 7009) revoca el permiso; «Desconectar» igual | §10 y §12 |
| Ligadas a `/mcp` | El permiso guarda el recurso y `/mcp` lo compara | §7 la ficha en `/api/v1/me` y `/api/crm` → 401 |
| La sesión del CRM nunca autentica `/mcp` | `/mcp` sólo lee `Authorization: Bearer tca_…` o `tcw_…` | §2 cookie o valor de la cookie como ficha → 401 |
| Página de permiso contra CSRF y marcos | Decisión por `POST` con la sesión, `Origin` del mismo sitio, código ligado a la solicitud y a la persona, de un solo uso; `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `no-store` | §5 cabeceras; §6 otro origen, sin `Origin`, código falso o ausente, solicitud de otra persona, sin sesión, segunda decisión |
| Marca y permisos se comprueban al aprobar y en cada uso | `grantable()` al decidir; `effective()` en cada canje, renovación y llamada | §6 marca inexistente, permiso inventado; §8b y §14 deja de ser administración → 401 y no se renueva; §11 suspendida → 401 y la renovación falla |
| Sólo administración conecta asistentes | Todo permiso exige `developer.keys.manage` en la marca | §11 la asesora ve el aviso sin marcas ni permisos, no se abre solicitud, la de otra persona o una inventada → 400; ascendida conecta, vuelta a asesora → 401 |
| Cliente o cuenta suspendida no autorizan | `isStaff()` y el mismo permiso | §5 la página de un cliente no abre solicitud; §11 suspendida |
| Mismo trato que una llave | Objeto con la forma de la llave: misma marca, permisos, firma (`created_by`), bitácora y límite (`api:` 120/min, `mcp-call:` 60/min) | §7 `resumen`, permiso que falta, otra marca, `actualizar_curso` firmado por quien autorizó |
| Registro dinámico acotado | 20 por hora por dirección, 1000 en total, 16 KB, campos validados (regresos, tipos de concesión y de respuesta, nombre y sitio), sin secreto, nunca descarga nada; las que no obtienen permiso se borran al día | §3 regresos no válidos, sin nombre, `client_credentials`, tipo de contenido, 413; §16 el límite por dirección |
| Documento de metadatos sin SSRF | Sólo `https` al puerto 443, con ruta, sin usuario, sin fragmento ni IP literal ni nombres internos; la dirección se comprueba **al conectar** (un DNS que cambia no cuela una red privada); sin redirecciones; 5 s y 16 KB como máximo; `client_id` del documento igual a su dirección; caché de 100 entradas entre 1 minuto y 1 hora | Prueba de unidad: direcciones no válidas, dominio que resuelve a red interna, redirección, documento grande, `client_id` distinto; §13 flujo completo con documento |
| Sin secretos en registros, bitácora ni respuestas | La bitácora guarda sólo ids (`mcp.oauth.granted`, `mcp.oauth.revoked`, `mcp.oauth.code_reuse`, `mcp.oauth.refresh_reuse`); errores sin la ficha; la lista no lleva fichas | §7, §12 y §16 (registro del servidor) |
| `/mcp` sigue sin admitir navegadores | La comprobación de `Origin` no cambió | §7 |
| La llave de la API sigue igual | `tcw_…` va por el camino de siempre | §15 y `test/mcp.test.mjs` sin cambios |

## «Asistentes conectados»

Pantalla `asistentes` (Ajustes, visible): la dirección `/mcp` con «Copiar dirección» y tres pasos para conectar; una tarjeta por conexión con la aplicación, la marca, los permisos, quién la autorizó, desde cuándo y su último uso; «Desconectar» la revoca al instante. Sólo administración conecta; administración ve todas las conexiones de sus marcas y los demás sólo las suyas (por ejemplo, las que hicieron cuando eran administración, ya sin efecto). API: `GET /api/mcp-oauth/connections` y `POST /api/mcp-oauth/connections/<id>/revoke`.

## Límites

- Aplicación pública sin secreto: la identidad de una aplicación registrada sola **no se comprueba** (su nombre es lo que dice). Por eso la página lo marca y muestra a dónde regresa.
- Una conexión ve una marca. Para otra marca, otra conexión.
- No hay ampliación de permisos sobre la marcha (`insufficient_scope`): si una herramienta pide un permiso que no se dio, contesta como con una llave («no tiene el permiso») y la persona vuelve a conectar marcando más.
- No es OpenID Connect: no hay `id_token` ni `/.well-known/openid-configuration`.
- La dirección pública sale de `APP_ORIGIN`; en producción es obligatoria (sin ella, apagado). Fuera de producción se deduce del pedido.
- Por ahora sólo administración conecta asistentes; abrirlo a otros roles sería otra decisión.
- Sin probar contra una aplicación de asistente real ni contra el servidor público.

## Dónde está

- `server/modules/mcp-oauth/module.mjs`: rutas `/oauth/*`, `/.well-known/*` (por `wellKnown()`), `authenticate()` y `challenge()` para `/mcp`, la pantalla y la limpieza; `repo.mjs` (SQL) y `page.mjs` (HTML de las páginas).
- `server/lib/mcp-oauth-clients.mjs`: validación de metadatos y direcciones de regreso; descarga segura del documento.
- `server/migrations/named/mcp-oauth/0001-tables.mjs`: `mcp_oauth_clients`, `mcp_oauth_requests`, `mcp_oauth_grants`, `mcp_oauth_codes`, `mcp_oauth_tokens`.
- `public/oauth/consent.js`, `public/oauth/consent.css`: la página de permiso. `public/screens/asistentes/`: la pantalla.
- `server/mcp.mjs`: `authenticateRequest()` elige entre llave y permiso y pone `WWW-Authenticate` en el 401.
- `server/index.mjs`: `readSession` y `originAllowed` prestados a los módulos; una línea que pasa `/.well-known/` al módulo.

## Verificación

- `test/mcp-oauth.test.mjs` (6 pruebas): la migración sobre una base ya publicada; el documento en caché no se bloquea; producción con y sin `APP_ORIGIN`; validación de regresos y metadatos; descarga del documento sin SSRF; y de punta a punta con el servidor real (17 secciones, citadas en la tabla de garantías).
- `test/ui/asistentes.spec.mjs` (escritorio y celular): la página sin sesión, la página de permiso (marcas, permisos, «Permitir» y regreso con código y `state`) y «Asistentes conectados» con la conexión y «Desconectar», con Tinta medido (`expectNiebla`).
