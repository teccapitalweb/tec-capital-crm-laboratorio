# Plan: «Preparar marca» (lista de verificación por marca)

Estado: **implementado en la rama `feat/preparar-marca`** (5 nov 2026), **sin esquema nuevo y sin cambio de versión**. Sin publicar.

## Para qué sirve

Cada función del CRM se enciende en un lugar distinto (Seguimientos, Pagos, Coordinación, Certificados, Campañas, Catálogo, Equipo) y todo nace apagado. Quien prepara una marca no tenía un solo sitio donde ver **qué ya está y qué falta**. «Preparar marca» lo junta en una lista y manda a cada pantalla.

Dónde está: **Operación → Preparar marca** (sólo administración).

## Qué muestra

Una tarjeta por marca autorizada, con una barra de avance de los pasos **esenciales** y la cuenta de **extras** encendidos. Cada paso dice si está listo, por qué importa y trae un botón que lleva a la pantalla donde se arregla. El primer esencial pendiente se resalta como «Siguiente».

| Grupo | Paso | Esencial | Se considera listo cuando… |
| --- | --- | --- | --- |
| Catálogo | Curso activo | Sí | hay al menos un curso activo |
| Catálogo | Edición publicada con fecha futura | Sí | hay una edición `published` de un curso activo sin fecha o con inicio futuro |
| Catálogo | Imagen aprobada | No | hay un flyer `approved` |
| Atención | Conocimiento aprobado | Sí | hay al menos una entrada `approved` |
| Atención | Asesores asignados | Sí | hay un asesor activo con acceso a la marca |
| Atención | Reparto y horarios | No | el reparto está encendido y tiene personas |
| Automatización | Automatización de la marca | Sí | `automation_settings.enabled` |
| Automatización | Respuestas automáticas | No | modo «sugerir» o «autónomo» (el modo «plantillas» es el de siempre) |
| Extras | Canal simulado, Pagos, Coordinación, Certificados, Campañas | No | su interruptor por marca está encendido (certificados: firma o emisión automática configurada) |

«Lista para atender y vender» significa que están los cinco esenciales; no significa que haya proveedores reales (todo sigue siendo simulado).

## Diseño

- **Sólo lectura.** `GET /api/readiness` (administración; 401 sin sesión, 403 para otros roles, 405 para otros métodos) no cambia nada: no enciende interruptores ni toca conversaciones. Arreglar un paso se hace en su pantalla, con sus propias revisiones y vistas previas.
- **Alcance por marca** con `crm.brandsFor(user)`; una marca no autorizada no aparece.
- Los botones usan acciones con prefijo `rdy-`; llevan a la pestaña de Operación o a las vistas Catálogo y Equipo.
- Archivos: `server/readiness.mjs`, `public/readiness.js`, estilos `.rdy-*` en `public/operations.css`, prueba `test/readiness.test.mjs`.

## Límites

- Es un diagnóstico, no un guardián: no impide encender algo si falta un paso.
- «Edición vigente» e «imagen aprobada» cuentan existencia, no calidad del contenido.
- No sabe de cosas externas (cuentas de Meta, pasarela real): eso sigue en [CONECTORES.md](CONECTORES.md).
