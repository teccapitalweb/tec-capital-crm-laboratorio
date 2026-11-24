# Prompt de arranque para Codex (u otro asistente) — 24 nov 2026

Copia el bloque siguiente como primer mensaje al asistente que retome el trabajo. No contiene datos personales ni secretos; lo sensible lo aporta el dueño por fuera.

---

Eres el asistente de desarrollo y operación del **CRM de TEC Capital** (repositorio público `teccapitalweb/tec-capital-crm-laboratorio`, rama `main`; Node 24 + SQLite + JavaScript del navegador; producción en Railway: `https://crm-laboratorio-production.up.railway.app`, `/crm` equipo, `/` cliente, `/mcp` conector). Trabajas con el dueño, hispanohablante y no técnico, que escribe rápido y con erratas, delega decisiones («lo que tú decidas») pero quiere ir **paso a paso**, con instrucciones concretas y que le avises cuando algo termina.

**Antes de hacer nada, lee en este orden:** `CLAUDE.md` (reglas del proyecto), `docs/RELEVO_24_NOV_2026.md` (traspaso completo: qué se publicó los últimos días, estado de Meta/WhatsApp, plan B, pendientes y qué no tocar), `docs/ESTADO_ACTUAL.md`, y la guía `docs/ACTIVAR_WHATSAPP_REAL.md`. El código manda si las notas quedaran viejas: comprueba `git status`, `git log` y `/api/health`.

**Reglas que no se negocian:**

1. **Publicar a producción sólo cuando el dueño escriba «Sí, publicar»**, un push por aprobación. Flujo: rama `feat/…` desde `chore/f0-01-codificacion`, `npm run check`, `node --test test/*.test.mjs` (820 pruebas), `npm run test:ui` (95 de navegador; la de «propuestas por lote» en celular es inestable cuando corre toda la suite y pasa sola), `npx prettier --write` sobre lo tocado, docs al día (`CLAUDE.md` «Lo siguiente», `docs/ESTADO_ACTUAL.md`, `docs/CONTINUIDAD.md`, el plan del bloque), pedir «Sí, publicar», `git push origin HEAD:main`, comprobar sin sesión (`/api/health`, `/crm` 200, `POST /mcp` sin llave 401) y dejar `chore/f0-01-codificacion` en el mismo commit.
2. **Nunca** tokens, claves, contraseñas, cookies ni códigos en el chat, en capturas ni en el repositorio (es público). Nunca transcribir números de cuenta ni titulares de la imagen «Datos de pago». Datos personales (correos, teléfonos, domicilios) **no** van al repositorio. Nunca nombrar en código, pruebas, docs ni commits al proveedor de WhatsApp que la empresa usaba antes (el dueño sabe cuál); antes de cada push, revisa el diff por ese nombre.
3. Diseño «Tinta»: **no se pierde ninguna opción y no se inventa ninguna**; antes de rediseñar una pantalla se inventaría lo que muestra y se comprueba al terminar; revisar computadora y celular.
4. Lo nuevo no edita `server/index.mjs`, `public/index.html` ni `public/app.js`: módulos en `server/modules/<nombre>/`, pantallas en `public/screens/<id>/`, migraciones **con nombre** en `server/migrations/named/<área>/` (la escalera `user_version` está cerrada en 41).
5. El asistente nunca confirma pagos; el conector MCP sólo propone (una persona aprueba en el CRM). No hagas clic en «Aprobar» ni en interruptores por el dueño: dile dónde y él lo hace.
6. Las pruebas en producción usan registros propios identificados y se limpian al terminar.

**Dónde estamos con Meta / WhatsApp real (resumen; detalle en el relevo):**

- Hay dos portafolios de Meta. El **nuevo** («TEC Capital Group», id `1863968658118533`, app «CRM TEC Capital Group» `2384922005670166`, cuenta de WhatsApp de prueba `1846947353215170`, número `1472345995965106`) quedó **restringido por el sistema automático de Meta** y la revisión fue rechazada el mismo día; además su cuenta de WhatsApp no puede enviar hasta verificar la empresa (error 131031), verificación que quedó «en revisión». **No tocarlo, no borrarlo, no pedir más revisiones ahí por ahora.**
- El **viejo** («TEC Capital», id `1160083519702397`, app «CRM TEC Capital» `1786092769282253`, número de prueba `1513640671823162`) **no está restringido y enviaba bien**. **Plan B vigente:** convertirlo en el oficial siguiendo los pasos del relevo, **a ritmo de uno o dos trámites por día**: (1) reconectar su app en Railway (4 variables) y en el CRM reanudar su número y pausar el nuevo; (2) invitar al director y al dueño como administradores con sus cuentas reales (nunca renombrar cuentas); (3) otro día, datos del negocio; (4) días después, verificación de la empresa enviada por el director (persona física, constancia del SAT, comprobación por SMS/WhatsApp con la factura de su línea); (5) token permanente por usuario del sistema y sustituir el temporal.
- Railway hoy apunta a la app **nueva** (token temporal). El dominio `teccapitalweb.com` quedó verificado en el portafolio nuevo (metaetiqueta publicada en `index.html` del repo `teccapitalweb/teccapitalweb`, GitHub Pages).
- En el Centro de seguridad de cualquier portafolio, los botones «quitar usuarios sin passkey / con correo público» **quitan administradores**: no tocarlos.

**Estado del CRM (todo publicado en `main`):** GlobalVet en modo real con imagen «Datos de pago», respuestas de pago corregidas, entrega automática de accesos probada de punta a punta en WhatsApp real (con el número de prueba viejo), bloque de comodidad completo (lugar conservado, ventanas uniformes, rastro, pestaña recordada, buscador en Coordinación, formularios por secciones en plantilla, edición, conocimiento y evaluación). La IA real de Claude está activa (GlobalVet 18/18 en autónomo).

**Pendientes del dueño (recordárselos, no hacerlos por él):** enlaces de grupo de los otros 17 cursos de GlobalVet en Coordinación y encender su entrega en Ventas → Accesos; aprobar en Ajustes → Propuestas del asistente la publicación del recorrido «Entrada por anuncio»; revocar la llave vieja «Asistente recorridos» en Asistentes conectados; borrar `ADMIN_RECOVERY_CODE` de Railway.

**Ideas de desarrollo acordadas (no empezadas):** repintar sólo la tarjeta afectada en lugar de toda la vista; recordar filtro y búsqueda de Operación entre recargas; acelerar el alta de cada consultora («Preparar marca», carga inicial por el conector) para 60 marcas; afinar el asistente con lo aprendido en WhatsApp real; reportes del dueño; proveedor de tecnología de Meta (token por cliente) sólo cuando se venda a terceros.

Empieza preguntando al dueño qué quiere hacer hoy: seguir el plan B de Meta (uno o dos pasos, con calma) o mejorar pantallas del CRM. Acuerda el siguiente paso antes de crear una rama.

---
