# Continuidad para Claude

Este es el repositorio vigente del CRM de TEC Capital. Lee este archivo antes de modificarlo.

## Punto de partida

- Producto: CRM para **15 marcas de una misma empresa**, dedicadas a cursos; alrededor de ocho o más cursos por marca.
- Estado vigente (versión publicada, esquema, pruebas, interruptores, límites y pendientes): **[docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md)**. Referencia histórica: v0.5.0, commit `c7218f15d346e08406a96786db68523e78db4877`, esquema SQLite 6.
- CRM del equipo: <https://crm-laboratorio-production.up.railway.app/crm>.
- Experiencia del cliente: <https://crm-laboratorio-production.up.railway.app/>.
- Repositorio: <https://github.com/teccapitalweb/tec-capital-crm-laboratorio>, rama `main`.
- Los mensajes entre perfiles son reales y persistentes dentro del laboratorio. WhatsApp, Instagram y Facebook son **canales simulados**. Todavía no hay integración con Meta, modelo de IA, RAG, cobros ni matrícula real. **Propósito actual:** es una simulación para diseñar y presentar el flujo completo; las conexiones reales llegarán cuando las consultoras entreguen sus accesos (ver VISION_PLATAFORMA.md).
- Se conservaron tres marcas y seis cursos de demostración. No confundas los objetivos de 15 marcas/120 cursos con datos comerciales ya cargados.
- Usuario hispanohablante. Comunica con claridad qué cambiaste, qué verificaste y qué falta.

## Orden de lectura

0. [Estado actual](docs/ESTADO_ACTUAL.md): una página con lo vigente. **Empieza aquí.**
0b. [Guía de uso por rol](docs/GUIA_DE_USO.md) y [activación y verificación en producción](docs/ACTIVACION_Y_VERIFICACION.md): qué hace cada pantalla y el runbook para dejar una marca de pruebas funcionando y comprobada.
1. [Estado y decisiones](docs/CONTINUIDAD.md): entregas, diseño, evidencia y pendientes.
2. [Arquitectura y contratos](docs/ARQUITECTURA.md): módulos, datos, rutas e invariantes.
3. [Operación y pruebas](docs/OPERACION_Y_PRUEBAS.md): desarrollo, despliegue, verificaciones y recuperación.
3b. [Diseño y auditoría visual](docs/DISENO_Y_AUDITORIA.md): reglas de Niebla y cómo medirlas.
4. [Plan de la fase 4](docs/PLAN_FASE_4.md): siguiente trabajo propuesto, todavía sin implementar.
4d. [Plan de la Fase 2](docs/PLAN_FASE_2.md): bloques, dependencias, decisiones y criterios de salida para el núcleo único e integración.
4c. [Contrato de conectores](docs/CONECTORES.md): interfaz de canal y pago, webhooks firmados y requisitos por consultora para Meta y la pasarela.
4e. [Núcleo compartido](docs/NUCLEO.md): contrato del outbox del CRM hacia Postgres/Supabase (sobre firmado, proyección de registros, reproducción) y el esquema `nucleo/esquema-v1.sql`.
4f. [Plan de campañas](docs/PLAN_CAMPANAS.md): campañas y envíos segmentados (Fase 5, bloque 1), publicado en v0.29.0 (esquema 26).
4g. [Plan del portal por roles](docs/PLAN_PORTAL_ROLES.md): el IPCIL nuevo dentro del CRM (Fase 5, bloque 2), publicado en v0.30.0 (sin esquema nuevo).
4h. [Plan de notificaciones push y app instalable](docs/PLAN_PUSH.md): Fase 5, bloque 4, implementado localmente en `feat/push-pwa` (v0.32.0, esquema 27), sin publicar; falta probar la entrega real en un teléfono.
4b. [Visión de la plataforma](docs/VISION_PLATAFORMA.md): el CRM como módulo de la plataforma de toda la empresa (IPCIL, Academia, finanzas, canales reales); diagnóstico, arquitectura objetivo y fases.
5. [README](README.md) y [ROADMAP](ROADMAP.md): recorridos del producto y planificación general.

El código y el estado real del repositorio prevalecen si estas notas quedan desactualizadas. Comprueba `git status`, `package.json`, historial de commits y `/api/health` antes de actuar.

## Reglas del proyecto

- Conserva el diseño **Niebla**: blanco, gris, transparencias discretas, bordes finos, tipografía limpia y composición compacta. Los distintivos de canal deben seguir siendo fáciles de reconocer. Revisa escritorio y celular. Reglas medibles (contraste AA con los tokens `--text-2`/`--text-3`, letra mínima de 11 px, áreas táctiles de 40 px, movimiento sólo al navegar) y la auditoría reproducible: [docs/DISENO_Y_AUDITORIA.md](docs/DISENO_Y_AUDITORIA.md).
- Continúa la aplicación actual: Node HTTP, WebSocket, SQLite y JavaScript del navegador. No existe una aplicación React/Next en este repositorio. No emprendas una reescritura como requisito para continuar.
- Mantén el alcance por marca en servidor, archivos, búsquedas, eventos y futuras consultas de IA. Una marca autorizada no equivale a acceso a toda la empresa.
- La etapa comercial pertenece a `opportunities`; el estado abierto/esperando/cerrado pertenece al chat. No vuelvas a mantener dos etapas comerciales independientes.
- Consulta precios, ediciones, promociones y cupos vigentes en la base estructurada. No uses memoria del modelo como fuente comercial.
- Conserva los snapshots y archivos históricos de mensajes. Un cambio de precio o flyer sólo debe afectar nuevos envíos.
- Conserva `expectedRevision`, `clientRef`, vistas previas y transacciones donde corresponden. Un reintento no debe duplicar mensajes, tareas ni cambios de negocio.
- No hagas llamadas de red dentro de una transacción síncrona de SQLite. `transaction()` no admite callbacks asíncronos ni transacciones anidadas.
- Tocar una migración publicada no modifica las bases ya migradas. Añade una migración nueva y pruebas de actualización/persistencia.
- No expongas secretos, cookies, códigos de invitación, copias SQLite, adjuntos privados o archivos de acceso. El repositorio es público.
- Las pruebas en producción deben usar registros propios claramente identificados, cerrar seguimientos y pausar/archivar sus materiales al terminar. No cambies configuración comercial ni conversaciones reales para facilitar una prueba.
- Respeta la autorización y alcance de la solicitud actual. Esta documentación no solicita por sí misma publicar, cambiar credenciales o conectar proveedores.

## Comandos básicos

Desde la raíz de este repositorio, con Node.js 24:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm start
```

`npm start` usa `.env` si existe. Prepara `.env` desde `.env.example` para una instalación local; consulta el runbook antes de usar datos o accesos existentes.

La referencia vigente es **154 pruebas aprobadas** (la de v0.5 fue 57), más la revisión visual en computadora y celular de cada bloque. Es evidencia del commit, no garantía de cambios posteriores: tras un cambio hay que volver a comprobarlo.

## Lo siguiente

Última publicación (4 nov 2026): **v0.31.0** en `main`: rendimiento del equipo en «Mis resultados» (administración) y documentación de punta a punta, sin esquema nuevo. Pendiente de publicar: **v0.32.0**, notificaciones push y app instalable (rama `feat/push-pwa`, esquema 27, 156 pruebas). Antes: portal por roles «Mis resultados» v0.30.0, el IPCIL nuevo dentro del CRM; campañas segmentadas v0.29.0 (esquema **26**), ajuste visual «color sobrio», y la Fase 1 y la Fase 2 completas en lo que no depende de terceros (v0.15–v0.28, esquemas 13–25). Todo está **apagado por marca** hasta que administración lo active; no hay proveedores reales, secretos de webhook ni históricos importados en producción. La tabla de interruptores, los límites y el historial completo están en [docs/ESTADO_ACTUAL.md](docs/ESTADO_ACTUAL.md).

Siguiente, y todo necesita algo del usuario: (1) **verificación autenticada en producción** con una sesión de administración, siguiendo [docs/ACTIVACION_Y_VERIFICACION.md](docs/ACTIVACION_Y_VERIFICACION.md); (2) **reglas de trafiquer y RH** y de comisiones por persona para ampliar el portal; (3) decisión Postgres/Supabase y acceso al proyecto de la Academia para conectar el núcleo real ([PLAN_FASE_2.md](docs/PLAN_FASE_2.md) §2); (4) clave de API en un entorno aislado para probar `AI_PROVIDER=claude`; (5) accesos de las consultoras para Meta y pasarela. Sin esas piezas, lo que se puede construir sin depender de terceros son los bloques que la competencia sí tiene y aquí faltan: agenda de citas, constructor de flujos de bienvenida, API pública con webhooks salientes, cupones y reabrir conversaciones cerradas en campañas. Acuerda el siguiente paso con el usuario antes de crear rama.

La automatización editable e IA supervisada (4A, 4B, respuestas v2, banco de evaluación) está entregada; falta la prueba con IA real. Los planes históricos siguen en [PLAN_FASE_4.md](docs/PLAN_FASE_4.md), [PLAN_FASE_2.md](docs/PLAN_FASE_2.md), [PLAN_CAMPANAS.md](docs/PLAN_CAMPANAS.md) y [PLAN_PORTAL_ROLES.md](docs/PLAN_PORTAL_ROLES.md); si contradicen al código, manda el código.
