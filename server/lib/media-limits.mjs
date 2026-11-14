// Límites de tamaño de los archivos, en un solo lugar (conciliación técnica, fila 45).
//
// El límite efectivo es el menor entre el del canal y el de la instalación. Las cifras son de la conciliación:
// imagen 5 MB; audio 16 MB al enviar y 8 al recibir; video 16; documento 16; sticker 0,1 (0,5 animado); encabezado de
// plantilla de WhatsApp 4 MB. Este incremento (D-3) sólo sube imagen y documento; lo demás queda escrito para quien
// amplíe la subida (N-2, B-I6, C-A3).

const MB = 1024 * 1024;

export const MEDIA_LIMITS = Object.freeze({
  image: 5 * MB,
  document: 16 * MB,
  video: 16 * MB,
  audio: 16 * MB,
  audioInbound: 8 * MB,
  sticker: Math.round(0.1 * MB),
  stickerAnimated: Math.round(0.5 * MB),
});

// Límites por uso: el archivo de muestra del encabezado de una plantilla (imagen o documento) no pasa de 4 MB.
export const PURPOSE_LIMITS = Object.freeze({
  templateHeader: 4 * MB,
});

// Bytes máximos para un archivo de clase `kind` usado para `purpose` (opcional). `channel` es el tope del canal, si
// lo hay; manda el menor.
export function limitFor(kind, { purpose, channel } = {}) {
  const candidates = [MEDIA_LIMITS[kind], purpose ? PURPOSE_LIMITS[purpose] : undefined, channel].filter(
    value => Number.isFinite(value) && value > 0,
  );
  return candidates.length ? Math.min(...candidates) : 0;
}

// «4 MB», «100 KB»: para los mensajes de error.
export const sizeLabel = n =>
  n >= MB ? `${Math.round((n / MB) * 10) / 10} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
