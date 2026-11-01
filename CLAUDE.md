# Continuidad para Claude

Este es el repositorio vigente del CRM de TEC Capital. Lee este archivo antes de modificarlo.

## Punto de partida

- Producto: CRM para **15 marcas de una misma empresa**, dedicadas a cursos; alrededor de ocho o más cursos por marca.
- Estado funcional documentado: **v0.5.0**, commit `c7218f15d346e08406a96786db68523e78db4877`, esquema SQLite **6**.
- CRM del equipo: <https://crm-laboratorio-production.up.railway.app/crm>.
- Experiencia del cliente: <https://crm-laboratorio-production.up.railway.app/>.
- Repositorio: <https://github.com/teccapitalweb/tec-capital-crm-laboratorio>, rama `main`.
- Los mensajes entre perfiles son reales y persistentes dentro del laboratorio. WhatsApp, Instagram y Facebook son **canales simulados**. Todavía no hay integración con Meta, modelo de IA, RAG, cobros ni matrícula real. **Propósito actual:** es una simulación para diseñar y presentar el flujo completo; las conexiones reales llegarán cuando las consultoras entreguen sus accesos (ver VISION_PLATAFORMA.md).
- Se conservaron tres marcas y seis cursos de demostración. No confundas los objetivos de 15 marcas/120 cursos con datos comerciales ya cargados.
- Usuario hispanohablante. Comunica con claridad qué cambiaste, qué verificaste y qué falta.

## Orden de lectura

1. [Estado y decisiones](docs/CONTINUIDAD.md): entregas, diseño, evidencia y pendientes.
2. [Arquitectura y contratos](docs/ARQUITECTURA.md): módulos, datos, rutas e invariantes.
3. [Operación y pruebas](docs/OPERACION_Y_PRUEBAS.md): desarrollo, despliegue, verificaciones y recuperación.
3b. [Diseño y auditoría visual](docs/DISENO_Y_AUDITORIA.md): reglas de Niebla y cómo medirlas.
4. [Plan de la fase 4](docs/PLAN_FASE_4.md): siguiente trabajo propuesto, todavía sin implementar.
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

La referencia de v0.5 es **57 pruebas aprobadas** (79 con los bloques locales 4A y 4B), revisión visual en computadora/celular y un flujo autenticado publicado con dos asesores y un cliente. Es evidencia de ese commit, no garantía de cambios posteriores.

## Lo siguiente

Último bloque local (31 oct 2026): **simulador de clientes** en la rama `feat/simulador-clientes` (esquema **14**, versión 0.15.0, 122 pruebas), construido sobre el motor de respuestas v2 (`feat/motor-respuestas-v2`, esquema 13). Ambos sin publicar; `main` local sólo tiene documentación por delante de `origin/main` (v0.14.0). Estado y siguiente bloque: [CONTINUIDAD.md](docs/CONTINUIDAD.md) y [VISION_PLATAFORMA.md](docs/VISION_PLATAFORMA.md).

La tercera fase del plan competitivo fue **operación del equipo**, ya entregada. La siguiente es **automatización editable e IA supervisada**. Los bloques 4A (motor durable, esquema v7) y una primera entrega de 4B (recetas por silencio, esquema v8, API sin interfaz) están implementados localmente sin publicar; sigue completar 4B (interfaz, más disparadores) y después añade conocimiento aprobado y copiloto. Los detalles y criterios de salida están en [PLAN_FASE_4.md](docs/PLAN_FASE_4.md).
