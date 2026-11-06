# Plan: Aliados (el panel RH de IPCIL dentro del CRM)

Estado: **implementado en la rama `feat/aliados-rh`** (6 nov 2026), **esquema 30** (sólo tablas nuevas), sin cambio de versión. Sin publicar.

## De dónde sale

El panel RH de IPCIL (`ricricard21/IPCIL-OFICIAL`, `panel/rh.html`, leído sólo en lectura) **no es de contratación de personal**: es la bandeja de las **academias que postulan al programa «Aliado Certificador»**, con el compromiso de **contactarlas en menos de 24 horas**, aprobarlas y mandarles la invitación de registro, más las **solicitudes de las marcas que piden ayuda para vincular su WhatsApp**. Eso es lo que se llevó al CRM.

## Qué hace (Operación → Aliados)

1. **Postulaciones.** Resumen (recibidas, por contactar, contactadas, aprobadas, rechazadas) que también filtra, búsqueda por academia, contacto, correo o ciudad y la lista con la ficha de cada academia (sector, alumnos al mes, años operando, si emite certificados, web, cómo conoció el programa, mensaje). Las nuevas van de la más antigua a la más reciente y las que pasan de **24 horas sin contactar** se marcan en rojo y se cuentan. Cada paso queda con quién y cuándo: **Ya la contacté** (con nota) → **Aprobar** o **Rechazar** (con motivo obligatorio) → **Preparar invitación**.
2. **Invitación.** Es un **texto para copiar** (con botones para abrir WhatsApp o el correo de la persona); **no se envía nada desde el CRM** (no hay proveedor de correo). Cuando alguien la manda, lo registra con **Ya la envié** y queda la fecha, quién y una nota. Falta agregarle el enlace de registro, que depende del IPCIL nuevo.
3. **Captura manual** de una postulación (por teléfono o por mensaje), sin repetirse si ya hay una de la misma academia y correo en la última semana.
4. **Vincular WhatsApp.** Solicitudes de una marca (nombre, puesto, teléfono, mejor horario, nota) para que alguien del equipo la llame; una pendiente por marca; RH la marca contactada con una nota.
5. **Quién lleva RH** (sólo administración): la función se concede a personas del equipo. Administración siempre tiene acceso; los clientes nunca. Quienes llevan RH reciben **aviso** de cada postulación nueva y solicitud en «Mis avisos».

## Formulario público (apagado por omisión)

`/aliados` es una página pública de postulación (HTML clásico, sin scripts) que **se enciende con `ALLY_FORM_ENABLED=1`**. Mientras esté apagada responde 404. Cuando se enciende:

- valida todos los campos y, si algo falla, explica qué y **conserva lo escrito** (escapado);
- exige aceptar el uso de los datos «sólo para contactar sobre el programa»;
- incluye un campo trampa para robots (si se llena, responde como si funcionara y no guarda nada) y limita a **5 envíos por hora por IP**;
- no se indexa y el texto que escriben se escapa siempre al mostrarlo.

**Por qué apagada:** recoge datos personales de terceros (nombre, correo, teléfono). Antes de encenderla en producción hace falta el **aviso de privacidad definitivo, con revisión legal**; la página lo dice («versión de laboratorio») y ese texto no es un aviso legal.

## Datos y límites

- Esquema 30: `rh_access`, `ally_applications`, `channel_requests`. Aditivo; respaldo automático previo al migrar (`backups/before-crm-v30-*`).
- Las postulaciones guardan datos personales de terceros: sólo las ve administración y quien tenga la función de RH.
- No hay correos ni mensajes salientes; el enlace de registro del aliado depende del IPCIL nuevo; no hay sonido de aviso (sí aviso en «Mis avisos»).
- «Vincular WhatsApp» la registra y la ve RH o administración; que cualquier asesor la pida desde su propia pantalla queda para cuando haya conexión real con Meta.
- Siguen pendientes de IPCIL las **comisiones por persona**.

Archivos: `server/allies-schema.mjs`, `server/allies.mjs`, `public/allies.js`, estilos `.aly-*` en `public/operations.css`; pruebas `test/allies.test.mjs`.
