# Aviso de privacidad público (12 nov 2026)

Sin esquema nuevo. Publicado en `main`.

## Para qué

Meta exige una **URL de política de privacidad** para publicar la app de WhatsApp, y mientras la app no esté publicada **no entrega los mensajes reales** al CRM (sólo los de prueba de su panel). Además, quien escribe a un número de la empresa tiene derecho a saber qué se guarda y cómo pedir que se borre.

## Qué es

Una página pública en **`/privacidad`**: estática, sin sesión, sin cookies y sin datos de nadie. Vive en `server/privacy.mjs`.

Explica, en lenguaje claro: quién es responsable, qué datos se reciben (teléfono, nombre de perfil, mensajes y archivos, interés, pedidos), para qué se usan, el uso del asistente automático y de la inteligencia artificial, con quién se comparten, cuánto se conservan, los derechos de acceso, corrección, cancelación y oposición, **cómo pedir que se borren los datos** (ancla `#eliminar-datos`, por si Meta pide una URL de eliminación) y cómo se avisa de cambios.

## Configuración (entorno)

| Variable | Para qué | Por omisión |
| --- | --- | --- |
| `PRIVACY_COMPANY` | Nombre del responsable que aparece en la página | `TEC Capital` |
| `PRIVACY_CONTACT_EMAIL` | Correo para solicitudes de privacidad | Sin correo: la página indica que se pida por el mismo chat |

El correo va en el entorno y no en el código porque el repositorio es público.

## Importante

- **Es un texto base.** Lo redactó el asistente a partir de cómo funciona el CRM; la empresa debe leerlo, ajustarlo y validarlo. No sustituye la asesoría legal ni un aviso de privacidad formal conforme a la ley mexicana.
- Lo que afirma debe seguir siendo cierto. Si cambia qué recibe el proveedor de IA, con quién se comparten datos o cuánto se conservan, hay que actualizar la página y la fecha `PRIVACY_UPDATED`.
- Hoy el CRM **no tiene una función para borrar los datos de una persona**; una solicitud de eliminación se atiende a mano. Es un pendiente real si se reciben solicitudes.

## Verificación

`test/privacy.test.mjs` (2 pruebas): contenido y secciones, sin correo no inventa uno, el nombre y el correo del entorno se escapan (no se puede inyectar HTML), la ruta responde sin sesión ni cookies, rechaza otros métodos y no afecta a las demás rutas. Revisada en computadora y a 375 px (sin desbordes ni letra menor a 11 px).
