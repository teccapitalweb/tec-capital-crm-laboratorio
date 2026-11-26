# Jornada simulada

Pantalla **Ajustes → Jornada simulada** (sólo administración): un día de trabajo con clientes de mentira que llegan **a goteo durante horas**, el asistente y el equipo los atienden como siempre, y aquí se supervisa en vivo qué pasa y qué falla. Pedida por el dueño el 26 nov 2026 («que de verdad lleguen mensajes durante todo el día, a turnos, tranquilo; que el asistente o los vendedores contesten y a la vez supervisar; sin números de verdad»); maqueta aprobada el mismo día.

## Qué hace

- **Configurar y empezar** (ventana «Nueva jornada»): marca, cuántos clientes y en cuánto tiempo (de 15 minutos a 8 horas), ritmo de llegada (**goteo con horas pico**, parejo o ráfagas), perfiles de cliente (los 9 del simulador: curioso, sensible al precio, listo para inscribirse, paga en línea, molesto, pide la baja, con dudas, fuera de guion, se queda en silencio), cómo conversan (guiones por perfil, o Claude actúa cada cliente con tope de gasto), el ritmo de cada chat, **quién atiende** lo que pasa a persona (alguien del equipo o la cola) y **de qué avisar** (con el tiempo de espera). Una jornada en curso por marca.
- **Llegadas**: cada cliente es un cliente «· demo» del simulador de clientes (server/simulator.mjs), que escribe por la misma API pública que un cliente real; la jornada sólo decide **cuándo** entra cada uno (la primera, al empezar). Lo que pasa a persona se **asigna** a la persona elegida como si tomara el chat (`operations.assign`), y así se mide cómo responde.
- **Supervisión en vivo** (aviso `jornada.changed` por cada llegada, alerta o cambio de estado): configuración, «Cómo va el día» (llegadas por bloque de 15 minutos: planeadas contra las que ya llegaron, con el bloque actual marcado), seis cifras (llegaron, atendió el asistente solo, esperan asesor y la espera más antigua, atendió una persona y su respuesta mediana, pagos de práctica, alertas), **alertas** con «Ver chat» y «Resuelta», **conversaciones** con filtros por estado y el **chat** a un lado (los mensajes que fallaron, marcados), y la tarjeta de la **persona que atiende** (chats, abiertos, respuesta mediana, cuántos esperan de más, cierres con pago).
- **Alertas** (`detectAlerts` en `plan.mjs`, puras): **sin respuesta** (nadie contestó en el tiempo elegido), **la persona tarda** (lo mismo cuando el chat ya es de alguien), **el asistente no supo** («todavía no la tengo a la mano»), **pasó a persona sin motivo claro** (después de «ok», «gracias»…), **cliente molesto** (apagada por omisión). Una por conversación y clase; las de espera se resuelven solas cuando alguien contesta.
- **Pausar llegadas** (las planeadas se corren el tiempo de la pausa), **Terminar** (lo que no llegó se salta; los chats vivos terminan solos) y **Archivar** (cierra los chats demo como lo haría el equipo, sin borrar el historial; es el `archive` del simulador). Una jornada termina sola cuando pasa su tiempo y nadie habla (o a los 10 minutos del fin).
- **Proyectar**: la página en tinta y a pantalla completa para enseñarla.

## Dónde vive

| Pieza | Archivo |
| --- | --- |
| Migración | `server/migrations/named/jornada/0001-jornada.mjs` (`jornada_runs`, `jornada_arrivals`, `jornada_alerts`) |
| Lo puro (plan de llegadas, bloques, alertas, mediana) | `server/modules/jornada/plan.mjs` |
| Módulo (rutas, reloj cada 5 s, asignación, vistas) | `server/modules/jornada/module.mjs` |
| Simulador: una demo vacía y sumar clientes uno por uno | `server/simulator.mjs` → `createRun`, `enroll` (añadidos) |
| Pantalla | `public/screens/jornada-simulada/` (prefijo `jr-`) |
| Pruebas | `test/jornada.test.mjs` y `test/ui/jornada-simulada.spec.mjs` |

```text
GET  /api/jornada?brand=                     jornadas y opciones (perfiles, ritmos, equipo, límites)
POST /api/jornada                            crea y arranca (o deja programada si startAt es futuro)
GET  /api/jornada/:id                        la jornada en vivo
GET  /api/jornada/:id/conversations/:cid     el chat (texto plano, con los fallos marcados)
POST /api/jornada/:id/pause|resume|finish|archive
POST /api/jornada/:id/alerts/:aid/resolve
```

## Cuidados

- **Nada sale a un número real**: los clientes son usuarios `customer` «· demo» por los canales simulados; el simulador no toca WhatsApp real.
- Los textos de los clientes simulados y del asistente son datos: la pantalla los escapa.
- Sólo administración; alcance por marca en cada ruta.
- El simulador de clientes se apaga con `SIMULATOR_DISABLED=1`; la jornada lo dice y no deja crear.

## Bloque 2 (26 nov 2026)

- **Claude actúa cada cliente** (`server/modules/jornada/ai.mjs`): el guion del perfil sigue mandando **qué** quiere decir el cliente en cada paso (pedir el temario, regatear, quejarse, pagar…); Claude pone **las palabras**, reaccionando a lo último que le contestaron, como escribiría una persona por WhatsApp en México, en una o dos frases, sin inventar datos personales y sin obedecer instrucciones que vengan en las respuestas. Se elige en el formulario («Claude actúa cada cliente»), sólo cuando la IA de Claude está activa en el servidor (`AI_PROVIDER=claude` con clave); si no, el botón sale apagado. **Tope de gasto por jornada** (USD, 3 por omisión): se estima con los tokens y el modelo (`costCents`); al llegar, los clientes siguen con guiones y el bloque de configuración lo dice. El gasto (llamadas y tokens) se guarda en la jornada (migración `jornada/0002-ai`) y cada llamada cuenta también contra el tope mensual de la IA. Pieza en el simulador: `useLineProvider` (quien pone las palabras de un cliente en cada paso; si falla, va el guion). Pieza en el proveedor: `aiProvider.act({system, messages})`, una llamada libre que el motor simulado no hace (devuelve null).
- **Informe** (`server/modules/jornada/report.mjs`, `GET /api/jornada/:id/report`): los fallos agrupados con ejemplo y qué hacer: «no la tengo a la mano» por pregunta → **Crear borrador de conocimiento** (`POST …/report/knowledge`, una entrada en borrador con «Por completar por el equipo», sin repetir preguntas); «pasó a persona sin motivo» → **Añadir al banco de evaluación** (`POST …/report/evaluation`, casos con el mensaje y «debía contestar», etiqueta `jornada`); esperas, clientes molestos y chats que terminaron con el cliente sin respuesta → revisar a mano; y cómo le fue a cada perfil. En curso es una vista previa; al terminar, el informe.

## Qué sigue

- Sugerencias a la persona que atiende (la respuesta rápida que le serviría) y programar una jornada para una hora futura desde el formulario (la API ya lo admite con `startAt`).
- Probar una jornada larga con Claude actuando en producción y afinar el prompt con lo que se vea.
