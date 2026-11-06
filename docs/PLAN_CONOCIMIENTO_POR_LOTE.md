# Plan: conocimiento por lote y tope de gasto de la IA

Estado: **implementado en la rama `feat/conocimiento-por-lote`** (6 nov 2026), **sin esquema nuevo y sin cambio de versión**. Sin publicar.

## Por qué

El usuario quiere conectar la API de Claude (con un crédito mensual limitado) y empezar a **meter contexto** de las consultoras. La IA sólo responde con conocimiento aprobado y con el catálogo, pero el conocimiento se cargaba **una pregunta a la vez**: con 15 marcas era inviable. Además, antes de conectar una clave real conviene **acotar el gasto** y elegir un modelo razonable.

## Qué se hizo

1. **Importación de conocimiento por CSV** (`server/knowledge-import.mjs`, `public/knowledge-import.js`): Catálogo → Conocimiento → **Importar preguntas (CSV)**.
   - Vista previa fila por fila **sin escribir nada** (`POST /api/knowledge-import/preview`); aplicar exige el mismo archivo (hash) (`/apply`).
   - Cada fila pasa por **la misma validación** que una entrada escrita a mano (`normalizeEntry`): pregunta de al menos 8 caracteres, respuesta completa, **sin precios**, curso de la marca; y por `createEntry` (máximo 300 por marca, versión inicial, auditoría).
   - **Todo entra como borrador**; sólo administración aprueba, como siempre. Repetir un archivo no duplica (misma pregunta y curso ya existente = «Ya existe»).
   - Sólo administración. Acepta coma o punto y coma (Excel en español) y BOM.
   - **Plantilla** descargable con 14 preguntas típicas de una consultora de cursos; cada respuesta empieza con `COMPLETAR:` y **se rechaza hasta que se reemplace**, para que nada a medias llegue a aprobarse.
2. **Guía para cargar el contexto** ([GUIA_CONTEXTO_CONSULTORA.md](GUIA_CONTEXTO_CONSULTORA.md)): qué reunir de cada consultora, cómo escribirlo y el flujo de carga y aprobación.
3. **Tope de gasto de la IA** (`server/ai-budget.mjs`): cada llamada real al proveedor deja una fila `ai.call` en `audit` (tipo, modelo, tokens). Antes de llamar se compara el mes (UTC) con `AI_MONTHLY_CALL_LIMIT` (1000 por omisión; 0 = sin tope) y `AI_MONTHLY_TOKEN_LIMIT` (0 = sin tope). Al alcanzarlo **no se llama** y la conversación pasa a una persona. El uso del mes se ve en Operación → Seguimientos («Respuestas automáticas a clientes») y en `GET /api/replies/provider`. Las respuestas simuladas no cuentan.
4. **Modelo por omisión más razonable:** `AI_MODEL` pasa de `claude-opus-5-5` a `claude-sonnet-5-5` (los IDs se pueden cambiar por variable de entorno; `claude-haiku-5-5` es el más económico). Sólo afecta cuando `AI_PROVIDER=claude`, que nadie tiene activo.

## Cómo probar la IA real cuando llegue la clave

Ver [OPERACION_Y_PRUEBAS.md](OPERACION_Y_PRUEBAS.md) y [PLAN_FASE_2.md](PLAN_FASE_2.md): clave sólo en `.env` local (o variables de Railway), nunca en el chat ni en el repositorio; primero local con datos de práctica y tope bajo.

## Límites

- El tope cuenta llamadas y tokens, **no dinero**: no se estiman precios (cambian); el costo real se ve en la consola de la API.
- El conocimiento sigue limitado a 300 entradas por marca y 1 MB / 300 filas por archivo.
- No hay importación de Excel `.xlsx` directamente: se guarda como CSV.
- La importación crea entradas, no edita las existentes; para corregir una, se edita en Conocimiento.
- La llamada real a la API sigue **sin probarse** con una clave verdadera.
