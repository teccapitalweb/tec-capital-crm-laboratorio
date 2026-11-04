# Plan: notificaciones push y app instalable (Fase 5, bloque 4)

Estado: **implementado localmente** en la rama `feat/push-pwa` (4 nov 2026, v0.32.0, esquema 27, 156 pruebas), **sin publicar**. Pedido por el usuario tras comparar con CRM de WhatsApp: los asesores de la competencia reciben aviso en el celular cuando les asignan un chat o un cliente responde; aquí los avisos sólo se veían con la aplicación abierta.

## Principio

Los avisos que el equipo ya recibe en **Operación → Mis avisos** (asignación, menciones, transferencias, objetivos de respuesta, pagos y comprobantes, aperturas, certificados, seguimientos) pasan también al celular o al escritorio, **sin tocar los lugares que los crean**. Es opt-in por dispositivo, sólo para el equipo, y no cambia ninguna regla de negocio.

## Cómo funciona

1. **App instalable:** `manifest.webmanifest` (nombre, color, iconos 192 y 512), `sw.js` (service worker que sólo muestra notificaciones: no guarda nada en caché ni intercepta peticiones, así que no puede dejar la aplicación en una versión vieja) e iconos PNG. El navegador ofrece «Instalar app» y el panel de configuración trae su botón.
2. **Activación:** Mi configuración → «Notificaciones en este dispositivo» → **Activar**. El navegador pide permiso (sólo tras pulsar), se suscribe con la clave VAPID pública del servidor y el CRM guarda la suscripción de esa persona y ese dispositivo (máximo 10 por persona).
3. **Envío:** un barrido cada 5 s toma los avisos no leídos, aún no enviados y de personas con suscripción, y tras una **espera corta (15 s, `PUSH_DELAY_MS`)** manda el aviso si sigue sin leerse: así no suena mientras la persona lo está viendo. Cada aviso se marca `pushed_at` al enviarse, de modo que no se repite aunque el servidor se reinicie. Lo que se leyó antes de enviarse no se manda, y al activar un dispositivo no se reenvía el historial.
4. **Contenido:** título «TEC Capital · <marca>» y el texto del aviso. Al tocar la notificación se abre o enfoca el CRM.
5. **Preferencias:** por persona, por grupo: **Chats** (asignación, menciones, transferencias), **Objetivos de respuesta**, **Pagos y comprobantes**, **Aperturas, certificados y seguimientos**.
6. **Prueba:** botón «Enviar prueba» (máximo una cada 5 s).
7. **Limpieza:** si el servicio de push responde 404 o 410 la suscripción se elimina; cinco fallos seguidos también.

## Seguridad y privacidad

- **Es la única salida real a internet del laboratorio** y por eso es opt-in por dispositivo y se puede apagar en el entorno con `PUSH_DISABLED=1`.
- El mensaje va **cifrado de extremo a extremo** (RFC 8291, `aes128gcm`) y firmado con VAPID (RFC 8292, ES256): el servicio de push (Google, Mozilla, Apple, Microsoft) sólo ve bytes cifrados que únicamente el navegador de esa persona puede leer.
- El servidor sólo contacta **servicios de push conocidos** (lista cerrada de dominios, https, sin puerto): una suscripción falsa no puede usarse para que el servidor llegue a otras direcciones.
- Las claves VAPID se generan una sola vez y se guardan en la base (`push_keys`); la clave privada **nunca** sale por la API ni va al repositorio. Se incluyen en los respaldos de la base, que son privados.
- `PUSH_SUBJECT` (opcional) es el contacto que el estándar exige en la firma; por omisión se usa la dirección pública del CRM, nunca un correo personal.
- Sin dependencias nuevas: todo con `node:crypto`.

## Verificación

- El cifrado reproduce **byte a byte el vector de prueba oficial del RFC 8291** (apéndice A), que es lo que producen los navegadores y las librerías de referencia; además hay prueba de ida y vuelta, de claves ajenas y de límites.
- Prueba por API con un receptor local: permisos, suscripción validada, firma VAPID comprobada con la clave pública publicada, contenido descifrado como lo haría el navegador, un solo envío por aviso, grupos, avisos leídos, historial no reenviado, prueba manual y su límite, dispositivo caído eliminado, cada persona sólo ve y quita lo suyo.
- Revisión en navegador local: el service worker se registra con alcance `/`, el manifiesto se enlaza, el navegador ofrece **Instalar app**, el panel se ve bien en escritorio y 375 px.

## Lo que no se pudo comprobar

La **entrega real a un teléfono** (necesita un navegador con permiso concedido y los servicios de push de Google o Apple): en el laboratorio sólo se verificó contra un receptor local. Antes de contar con ella hay que probar una vez en un teléfono real con el runbook de [ACTIVACION_Y_VERIFICACION.md](ACTIVACION_Y_VERIFICACION.md) (paso 15). En iPhone o iPad (iOS 16.4 o superior) las notificaciones sólo funcionan con la app instalada en la pantalla de inicio.

## Fuera de alcance (a propósito)

Notificaciones para clientes, push de campañas, sonidos o acciones dentro de la notificación, avisos por correo o SMS, y silenciar por horario (se apoya en los horarios de servicio, que ya existen).

## Criterios de salida

Migración 27 aditiva con respaldo previo, pruebas verdes, auditoría de diseño en escritorio y celular, documentación y versión 0.32.0. **No se publica sin «Sí, publicar».**
