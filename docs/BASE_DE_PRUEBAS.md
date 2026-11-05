# Base de pruebas local

Estado: **implementada** (5 nov 2026, rama `feat/base-de-pruebas`, **sin cambio de versión ni de esquema**: es una herramienta de desarrollo, no cambia el producto).

Sirve para probar todo el CRM en tu computadora, con un usuario de cada tipo y datos de ejemplo, **sin tocar producción**.

## Cómo se usa

Desde la raíz del repositorio, con Node.js 24 y las dependencias instaladas (`npm ci --ignore-scripts`):

```sh
npm run demo
```

La primera vez crea la base en `data-demo/`, siembra las cuentas y los datos, y deja el servidor corriendo. Las siguientes veces sólo arranca el servidor con la misma base. Para borrar todo y empezar de cero:

```sh
npm run demo:reset
```

Variables opcionales: `DEMO_PORT` (por defecto 3300; si está ocupado, `DEMO_PORT=3310 npm run demo`) y `DEMO_DIR` (por defecto `data-demo`).

Direcciones: CRM del equipo `http://localhost:3300/crm`; clientes `http://localhost:3300/`.

## Cuentas

Las contraseñas se generan al azar en cada creación, se muestran en la terminal y se guardan en `data-demo/CREDENCIALES.txt` (permiso sólo del dueño; Git lo ignora). No se escriben en ningún archivo versionado ni en documentación.

| Usuario | Tipo | Para probar |
|---|---|---|
| `admin.demo` | Administración | Todo: catálogo, Operación, Finanzas, Campañas, Equipo y «Ver a» en Mis resultados |
| `asesor.demo` | Asesor de GlobalVet | Bandeja, Contactos, Oportunidades, respuestas rápidas y Mis resultados de GlobalVet |
| `asesor.odon` | Asesor de OdonTeck | Comprobar que **no** ve nada de GlobalVet (alcance por marca) |
| `contadora.demo` | Asesor con función de contadora | Finanzas de todas las marcas (libro, comisiones, liquidaciones) |
| `coordinador.demo` | Asesor y responsable de apertura | Mis resultados → Mis aperturas y avisos; coordina la apertura del curso de aves |
| `cliente.demo`, `cliente.demo2`, `cliente.demo3` | Clientes | Escriben por WhatsApp (GlobalVet), Instagram (OdonTeck) y Facebook (GlobalVet) |

## Qué datos trae

- Todo se crea **por la API real** del CRM, como lo haría una persona: registro, invitaciones de equipo, configuración por marca y mensajes. Si algo cambia en la API, el guion falla en voz alta en lugar de dejar una base a medias.
- **GlobalVet** queda como marca de práctica con todo encendido: automatización, canal simulado, pagos simulados (enlace de 48 h), coordinación (apertura automática, recordatorio 24 h), certificados con emisión automática y campañas. Reglas de comisión de ejemplo (consultora 20 %, vendedor 5 %).
- La edición «Plan sanitario para aves» tiene responsable (`coordinador.demo`) y mínimo de 3 alumnos.
- Tres conversaciones de clientes por los tres canales, dos etiquetas («VIP», «Pidió beca») ya puestas en contactos, una respuesta rápida personal (`/gracias`) y una de la marca (`/bienvenida`).
- Nueve clientes ficticios («· demo») del simulador (curioso, molesto, pagador, baja, silencio…), ya procesados.

## Qué comprobó la verificación

Contra una base recién creada: las ocho cuentas inician sesión con el rol esperado; el asesor de GlobalVet sólo ve conversaciones de GlobalVet (5, dos con etiquetas) y el de OdonTeck sólo las de OdonTeck (3); el cliente ve su propia conversación; la contadora tiene Finanzas y el asesor no; el coordinador ve su apertura con mínimo 3; Finanzas de administración muestra reglas y conciliación correcta; campañas y automatización de GlobalVet están encendidas. En el guion de presentación quedan «por preparar» los pasos de coordinación, certificado, recetas y campañas, porque dependen de acciones que se hacen al probar (abrir la apertura, emitir, ejecutar).

## Límites y seguridad

- Sólo escucha en `127.0.0.1` (tu equipo), con `NODE_ENV=development` y sin respaldos programados.
- Canales, pagos y IA siguen siendo **simulados**; no hay Meta, pasarela ni modelo real.
- Los datos son ficticios; no los mezcles con una base real ni reutilices estas contraseñas.
- Si el puerto está ocupado el script lo avisa y termina; `Ctrl+C` detiene el servidor.
- La base se puede borrar sin consecuencias (`npm run demo:reset`); `data-demo/` está en `.gitignore`.

## Y en producción

El script **no** sirve contra producción y no se debe apuntar allí. Para tener usuarios de prueba en producción, administración los crea desde **Equipo → invitaciones** (el equipo) o con el registro normal (clientes), siguiendo [ACTIVACION_Y_VERIFICACION.md](ACTIVACION_Y_VERIFICACION.md): registros propios con prefijo «PRUEBA ·», cerrados y archivados al terminar.
