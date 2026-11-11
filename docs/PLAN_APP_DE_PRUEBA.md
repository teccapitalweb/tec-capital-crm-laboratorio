# App de prueba para celular (11 nov 2026)

Publicado en `main` (11 nov 2026). Sin esquema nuevo.

## Para qué

El usuario quiere probar el recorrido completo (atención automática, pedido y pago de prueba) **con distintas personas desde su teléfono**, como si fuera una app de mensajería. Ya se podía entrar desde un celular, pero el chat se veía como el CRM, la app instalable abría el CRM del equipo y no había forma rápida de invitar a alguien.

## Qué hay ahora

1. **Chat del cliente con aspecto de app de mensajería** (sólo vista de cliente, clase `.customer-skin`; el CRM del equipo conserva Niebla).
   - En celular, con un chat abierto, la conversación ocupa toda la pantalla: cabecera de contacto de color, fondo de conversación, burbujas, respuestas rápidas en una fila que se desliza y barra de escribir de una línea con botón redondo de enviar.
   - El cuadro de escribir empieza en una línea y crece al escribir (hasta ~5 líneas).
   - Estilos al final de `public/polish.css`.
2. **App instalable que abre el chat**. La portada (`/`) anuncia `manifest-cliente.webmanifest` («TEC Capital · Chat de prueba», `start_url: /`); `/crm` sigue anunciando la app del equipo. Son dos apps distintas para el navegador. El servidor cambia el manifiesto al servir la portada fuera de `/crm`.
3. **Invitar a probar** (equipo): botón en Actividad (y «Copiar enlace del laboratorio» en la bandeja vacía). Muestra un **enlace y un código QR** por curso y canal: `/?curso=<id>&canal=<whatsapp|instagram|facebook>`. Quien lo abre crea su perfil de prueba y cae directo en «Empieza una conversación» con ese curso y canal.
   - `GET /api/presentation/invite?course=&channel=` (sólo equipo, curso activo y marca a su alcance) devuelve `{url, svg}`; el QR se dibuja en el servidor (`server/qr.mjs`).
   - El enlace usa `APP_ORIGIN` si está configurado; no lleva secretos ni crea nada por sí solo.

## Límites deliberados

- **No imita a ningún servicio real.** No usa el nombre, el logotipo ni el diseño de WhatsApp ni de ninguna otra app: es «Chat de prueba», con la identidad del laboratorio, y los canales siguen rotulados «Canal de prueba».
- No hay mensajería real: los mensajes viven dentro del laboratorio.
- La instalación depende del navegador del teléfono: en Android, menú de Chrome → «Instalar app»; en iPhone, Safari → Compartir → «Agregar a inicio».

## Cómo probar con varias personas

1. Equipo → **Actividad → Invitar a probar** → elige curso y canal.
2. Comparte el enlace o muestra el QR.
3. La persona crea su perfil (nombre, usuario y contraseña ficticios) y escribe.
4. Con la marca en «Autónomo» y la venta de prueba activa, recibe respuestas, pedido y pago simulado sin intervención.

## Verificación

- `test/app-de-prueba.test.mjs`: manifiestos distintos en `/` y `/crm`, permisos y alcance por marca de la invitación, canal por omisión, `APP_ORIGIN`.
- Revisado en navegador a 375 px (chat a pantalla completa, sin desbordes) y en escritorio; enlace de invitación abre el curso y canal elegidos; modal con QR.
- **Pendiente:** instalarla en un teléfono real y probar el aviso push desde la app del cliente.

## Siguiente (bloque 2)

Pasarela de pago de prueba a pantalla completa: hecha en [PLAN_PASARELA_DE_PRUEBA.md](PLAN_PASARELA_DE_PRUEBA.md).
