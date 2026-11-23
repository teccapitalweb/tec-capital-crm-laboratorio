# Auditoría de las propuestas

Se tomó el marcado que genera el CRM local en el estado cargado de «Ciclo de las conversaciones». La sesión se creó en una base temporal de prueba, con un perfil ficticio «Equipo de muestra». La referencia es la revisión `8bfff56`. La galería y las tres muestras funcionan desde archivos locales. La franja superior pertenece al visor de propuestas.

## Inventario antes de diseñar

| Pieza                     | Contenido y opciones en la referencia                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marca del equipo          | Gota con remate y brillo, Tinta y «CRM de TEC Capital», en el menú y en la entrada del equipo.                                                                                                                                                                                                              |
| Marca instalada           | Favicon «tc» azul petróleo y PNG de 192 y 512 px. El manifiesto declara los PNG de uso general. El inicio de cliente y el de equipo comparten los recursos del documento.                                                                                                                                   |
| Paleta                    | Tinta, lima, blanco y gris, más lila, menta, cielo, mantequilla y durazno. Las variables se definen en `public/tokens.css` y se consumen en `public/tinta-vistas.css`.                                                                                                                                      |
| Estructura de la pantalla | Rótulo «Conversaciones», título «Ciclo de las conversaciones» y explicación de Abierta, Pendiente, Resuelta y Expirada. Permiso de administración.                                                                                                                                                          |
| Por cada marca            | Nombre, casilla «Expirar a las 24 horas» y su explicación, casilla «Avisar cuando se pierde una» y su explicación, «Días de atribución a una campaña» (1–30), y «Guardar».                                                                                                                                  |
| Datos de la muestra       | Dermalysse, GlobalVet y OdonTeck. Las tres tienen expiración apagada, aviso encendido y 7 días. Resultado por versión: tres tarjetas y doce controles dentro de la vista.                                                                                                                                   |
| Marco de la aplicación    | Marca del equipo, selector con «Todas las marcas» y las tres consultoras, seis grupos del menú, contador, Cliente/Equipo, sol y luna, nota del laboratorio, perfil ficticio y cierre de sesión. La barra muestra la ubicación, conexión y aviso de datos de prueba con la visibilidad propia de cada ancho. |
| Comportamiento del CRM    | En la aplicación, Guardar envía la revisión actual de esa marca, vuelve a cargar los datos y muestra un aviso. La pantalla también contempla carga y fallo con reintento. Las láminas reproducen el estado cargado y permiten probar las casillas y los límites del campo de días en el navegador.          |

**Opciones presentes en el marcado del menú**, incluidas las que quedan dentro de grupos plegados:

- Atención agrupa Mi día, Conversaciones, Operación, Tareas y Agenda.
- Contactos agrupa Contactos, Lista de contactos, Importar contactos, Audiencias y Datos de contacto.
- Ventas agrupa Oportunidades, Catálogo y Accesos.
- WhatsApp agrupa Difusiones, Automatización, Plantillas, Secuencias y Salud.
- Resultados agrupa Mis resultados, Analítica, Actividad y Presentación.
- Ajustes agrupa Equipo, Ciclo de conversaciones, Asistentes conectados, Propuestas del asistente y Mi configuración.

Fuentes de la pantalla y del marco: `public/screens/ciclo-de-vida/index.js`, `screen.css`, `screen.json`, `public/app.js` y el orden de hojas en `public/index.html`. La marca instalada se cotejó con `public/favicon.svg`, ambos PNG y `public/manifest.webmanifest`. Los lienzos de noviembre sirvieron de referencia para el menú y la jerarquía por bloques.

## Mediciones en navegador

Chrome en Windows, con archivos locales y Manrope incluida. Se aplicó `nieblaAudit` de `test/ui/niebla-audit.mjs` a la vista, al menú, a la barra y al visor. Se complementó con el mínimo de contraste de todo texto visible del módulo usando 4,5 a 1 también en titulares. Para el tamaño táctil de una casilla se midió la etiqueta asociada completa.

| Vista                             | Texto más pequeño | Contraste de texto mínimo | Menor lado de control | Desborde horizontal |
| --------------------------------- | ----------------: | ------------------------: | --------------------: | ------------------: |
| Sobrio                            |             12 px |                  9,68 a 1 |                 44 px |                0 px |
| Equilibrado                       |             12 px |                  7,71 a 1 |                 44 px |                0 px |
| Vivo                              |             12 px |                 10,55 a 1 |                 44 px |                0 px |
| Lámina de firmas, ícono y enlaces |             11 px |                 12,28 a 1 |                 40 px |                0 px |

Las tres propuestas dieron los mismos resultados a 375 × 812, 1366 × 800 y 1920 × 1080 con menú claro y oscuro. La lámina se midió en esos tres tamaños. La franja externa con la explicación abierta pasó las comprobaciones de texto, controles y ancho. En celular se pudo recorrer el módulo hasta el tercer botón Guardar.

**Límite heredado del menú.** A 375 px el menú pasa la regla táctil de 40 px. En una ventana táctil de 820 px, Cliente, Equipo y Mi perfil miden 36 px de alto. A 1366 px, diez controles del menú quedan por debajo de 40 px, incluidos los seis encabezados de grupo de 34 px. Es una incidencia del menú vigente que se conserva por encargo. Las medidas del cuadro corresponden al área diseñada. El selector de tema del visor reprodujo el menú claro original píxel por píxel a 375, 820 y 1366 px.

## Texto, bordes y estados

Los fondos, incluidos los seis acentos por área, se calcularon con luminancia relativa sRGB. La [tabla de paleta](PALETA.md) incluye cada combinación y los dos temas del menú. Las casillas vacías y el campo numérico usan un borde de 2 px en `--control-line`. La marca de verificación blanca sobre tinta logra 17,76 a 1. El foco de teclado tiene un contorno de 2 px. La lista de estados conserva las fichas y los textos de la guía del CRM. La propuesta de módulo agrega fondos estáticos y sus casillas cambian de fondo sin transición.

## Logotipos e íconos

Las cuatro propuestas tienen cuatro originales vectoriales cada una. Los signos se revisaron sobre ambos fondos a 32 y 16 px. Sus superficies claras y oscuras aparecen en la misma lámina. Los PNG son opacos, con fondo hasta el borde. El signo completo cabe en el círculo seguro central de radio 40 % del lado. La lámina muestra el recorte redondeado y el circular. Es una simulación de la instalación. El manifiesto vigente conserva su configuración actual.

| Firma           | Tinta sobre la muestra clara | Signo lima sobre tinta | Nombre marfil sobre tinta |
| --------------- | ---------------------------: | ---------------------: | ------------------------: |
| Gota de corte   |                        14,56 |                  14,18 |                     16,28 |
| Trazo continuo  |                        13,70 |                  14,18 |                     16,28 |
| Turno de voz    |                        13,44 |                  14,18 |                     16,28 |
| Inicial plegada |                        14,11 |                  14,18 |                     16,28 |

Los PNG miden 2 255 y 6 726 bytes. Al medir todos los píxeles que difieren del fondo, el radio máximo es 39,92 % del lado en el archivo de 192 px y 39,87 % en el de 512 px.

## Cómo repetir la revisión

1. Abrir cada muestra en Chrome y elegir en el visor Sobrio, Equilibrado o Vivo. Cambiar entre menú oscuro y claro con la casilla de la franja superior.
2. Emular los tamaños del cuadro, activar entrada táctil para el celular y recorrer hasta OdonTeck. Revisar las etiquetas completas, los límites del campo y el foco con la tecla Tab.
3. Para repetir la medición del proyecto, pegar en la consola la función `nieblaAudit` de `test/ui/niebla-audit.mjs` sin la palabra `export`. Ejecutarla con `'#page'`, `'.sidebar'`, `'.topbar'` y `'.lector'`. En la lámina usar `'main'`.
4. En la lámina, comparar cada signo en ambos tamaños y los dos recortes de la app. El resultado funcional de guardar en producción, las notificaciones y la instalación en un teléfono físico quedan fuera de esta revisión visual.
