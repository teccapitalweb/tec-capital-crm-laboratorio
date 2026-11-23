# Paleta de Tinta

La tinta oscura identifica las acciones del equipo. El lima indica la selección o el avance. El acento de cada área se aplica a superficies amplias, siempre acompañado del nombre del área. Una ficha pequeña conserva su texto y el significado acordado para su estado.

## Colores de lectura y de control

Valores calculados con luminancia relativa sRGB. Cada celda expresa la relación con el fondo de su fila. Para texto normal se exige 4,5 a 1 y para el límite de un control, 3 a 1. La columna Contorno corresponde a `--control-line` (#606875). Las líneas suaves de separación son decorativas.

| Fondo   | Valor   | Tinta | Texto secundario | Texto de apoyo | Contorno |
| ------- | ------- | ----: | ---------------: | -------------: | -------: |
| surface | #fff    | 17,76 |            10,55 |           8,10 |     5,62 |
| page    | #eceef3 | 15,30 |             9,09 |           6,98 |     4,84 |
| soft    | #f4f5f8 | 16,29 |             9,68 |           7,43 |     5,16 |
| lime    | #d9f24f | 14,18 |             8,43 |           6,46 |     4,49 |
| lilac   | #e3dcff | 13,49 |             8,01 |           6,15 |     4,27 |
| mint    | #d3f4e2 | 15,06 |             8,95 |           6,87 |     4,77 |
| sky     | #d6ebff | 14,53 |             8,64 |           6,63 |     4,60 |
| butter  | #fff0b8 | 15,57 |             9,25 |           7,10 |     4,93 |
| peach   | #ffe0cf | 14,22 |             8,45 |           6,48 |     4,50 |
| rose    | #f6d9ec | 13,58 |             8,07 |           6,19 |     4,30 |

## Color de los módulos

| Área       | Variable           | Fondo   | Tinta | Secundario | Apoyo | Contorno |
| ---------- | ------------------ | ------- | ----: | ---------: | ----: | -------: |
| Atención   | `--area-attention` | #ffdbcb | 13,74 |       8,17 |  6,27 |     4,35 |
| Contactos  | `--area-contacts`  | #e6dfff | 13,84 |       8,22 |  6,31 |     4,38 |
| Ventas     | `--area-sales`     | #f8e8bb | 14,59 |       8,67 |  6,65 |     4,62 |
| WhatsApp   | `--area-whatsapp`  | #d0eee1 | 14,38 |       8,54 |  6,56 |     4,55 |
| Resultados | `--area-results`   | #d9e9ff | 14,42 |       8,57 |  6,57 |     4,57 |
| Ajustes    | `--area-settings`  | #d8dcea | 12,98 |       7,71 |  5,92 |     4,11 |

En Ajustes el azul grisáceo reúne las decisiones de una marca. La casilla encendida conserva su relleno lima; la marca, su nombre. En los otros cinco módulos, el acento previsto identifica el encabezado de sección o el contenedor. Los puntos del menú y los distintivos de canal usan sus valores actuales.

## Estados

| Ficha del kit  | Color       | Lectura                                                       | Texto / fondo        | Contraste |
| -------------- | ----------- | ------------------------------------------------------------- | -------------------- | --------: |
| k-chip--ok     | menta       | Bien o terminado. Aprobada, entregada o ganada.               | --ok / --ok-soft     |      5,41 |
| k-chip--accent | lima        | En curso ahora. Enviando, inscripción o conversación abierta. | --ink / --lime       |     14,18 |
| k-chip--sky    | cielo       | Programado, enviado o en espera de otra persona.              | --ink / --sky        |     14,53 |
| k-chip--warn   | mantequilla | Pausa, atención pendiente o falta respuesta del equipo.       | --warn / --warn-soft |      5,68 |
| k-chip--bad    | durazno     | Falló, se rechazó, se perdió o expiró.                        | --bad / --bad-soft   |      4,79 |
| k-chip--draft  | gris        | Borrador, archivada, cancelada o sin decidir.                 | --ink / --soft       |     16,29 |
| k-chip--lilac  | lila        | Tipo o categoría. Segmento, ensayo o etiqueta.                | --ink / --lilac      |     13,49 |

La ficha de canal `k-chip--wa` usa su punto verde y un rótulo en tinta. Ejemplo: «Sin número». Las fichas de advertencia o éxito que usan tinta tienen su relación en la primera tabla.

## Menú claro y oscuro

| Tema y pieza               | Texto / fondo           | Relación |
| -------------------------- | ----------------------- | -------: |
| Oscuro · fila              | --on-ink-text / --ink   |    14,50 |
| Oscuro · título de grupo   | --on-ink-muted / --ink  |     8,16 |
| Oscuro · ayuda sobre pieza | --on-ink-soft / --ink-2 |     9,14 |
| Oscuro · selección y foco  | --ink / --lime          |    14,18 |
| Claro · fila               | --ink / --surface       |    17,76 |
| Claro · grupo              | --text-2 / --surface    |    10,55 |
| Claro · selección          | --on-ink / --ink        |    17,76 |
| Claro · ayuda sobre pieza  | --text-2 / --soft       |     9,68 |

El tema lo elige la persona para el menú. El área de trabajo conserva su fondo de página con ambos temas. [Variables de la propuesta](tokens.css).
