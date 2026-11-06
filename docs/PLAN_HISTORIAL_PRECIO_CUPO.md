# Plan: historial de precio y cupo, y base para automatizaciones

Estado: **implementado en la rama `feat/historial-precio-cupo`** (6 nov 2026), **sin esquema nuevo y sin cambio de versión**. Sin publicar.

## Para qué

El usuario planea automatizaciones futuras (llamadas automáticas, alertas) que necesitan saber **si una edición se llenó, cuál es el precio vigente, si subió o bajó y qué cambió**. Una revisión del código mostró que el catálogo ya guardaba cada versión (quién, cuándo y cómo quedó), pero:

- el cupo disponible sólo guardaba el número actual (se descuenta al inscribir y se devuelve al dar de baja, sin dejar rastro);
- los cambios de precio vivían en su propia bitácora, separada del índice común de eventos que leerán las automatizaciones.

## Qué se agregó

Cinco tipos de **evento de dominio** (el mismo índice de pedidos, inscripciones y aperturas, que además llega al núcleo compartido por el outbox):

| Evento | Cuándo | Carga |
| --- | --- | --- |
| `catalogo.precio_cambiado` | Cambia el precio regular o el de sesión de una edición | desde, hasta, diferencia en centavos y en %, `direction` (`subio` / `bajo`) |
| `edicion.cupo_cambiado` | Cambia el cupo disponible | desde, hasta, cupo total y motivo (`inscripcion`, `baja`, `manual`) |
| `edicion.cupo_agotado` | El cupo llega a cero | |
| `edicion.cupo_liberado` | Estaba en cero y se liberó un lugar | disponibles |
| `edicion.cupo_bajo` | El cupo cruza hacia abajo el **20 % del total** (mínimo 1), una sola vez por cruce | disponibles y umbral |

Se publican **dentro de la transacción** que hizo el cambio (si se revierte, el evento no existe) y son idempotentes: repetir el mismo cambio no los duplica. Orígenes: edición manual en el Catálogo, pago confirmado (inscripción) y baja de una inscripción en Coordinación. Guardar una edición sin tocar precio ni cupo no publica nada; un cupo sin informar (`null`) tampoco.

**Línea de tiempo** (Catálogo → Ediciones → **Precio y cupo**): precio y estado salen de las versiones guardadas, así que también muestran el **pasado anterior a estos eventos**; el cupo sale de los eventos nuevos. `GET /api/catalogue/edition/:id/timeline`.

**Avisos al equipo** en «Mis avisos» (y, si tienen push, al teléfono): se agotó el cupo, se liberó un lugar, quedan pocos lugares y el precio subió o bajó. Los entrega un suscriptor del índice de eventos fuera de la transacción, con reintento.

## Cómo se usará después

Una llamada automática, un tablero o una alerta se suscribe al tipo de evento que le interesa; no compara tablas ni consulta cada tanto. Ejemplos: llamar a la lista de espera con `edicion.cupo_liberado`; avisar a ventas con `edicion.cupo_bajo`; ajustar una campaña con `catalogo.precio_cambiado`.

## Límites

- El cupo anterior a esta versión no tiene historial (empieza a registrarse desde que se publique). El precio sí tiene todo su pasado.
- Un cambio de **promoción** (precio promocional) todavía no es evento; se ve en la pestaña Promociones. El precio que cambia el evento es el regular y el de sesión.
- No hay llamadas ni lista de espera: este bloque sólo deja el terreno listo.

Archivos: `server/catalogue-events.mjs`, `server/events.mjs` (tipos), `server/catalogue.mjs`, `server/payments.mjs`, `server/coordination.mjs`, `public/catalogue.js` y `public/catalogue.css`; pruebas en `test/pricehistory.test.mjs`.
