// Carga previa SÓLO para pruebas (node --import): cuando llega una línea por la entrada estándar, entrega SIGTERM
// al propio proceso. Así se ejercita el apagado ordenado del servidor también en Windows, donde child.kill() termina
// el proceso sin avisar. No forma parte del servidor: sólo la usan las pruebas (test/helpers/crm.mjs).
process.stdin.once('data', () => process.emit('SIGTERM', 'SIGTERM'));
process.stdin.unref();
