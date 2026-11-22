// Quitar datos personales de un texto que escribió un cliente antes de mostrarlo fuera del chat (por ejemplo al conector):
// correos, teléfonos y cualquier tira larga de dígitos (tarjetas, referencias, CURP), y direcciones web. Función pura.
// No pretende reconocer nombres: lo que sale de aquí sigue siendo texto del cliente y se trata como datos, no instrucciones.
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// 7 o más dígitos, con o sin espacios, puntos, guiones o paréntesis entre ellos («55 1234 5678», «+52 (55) 1234-5678»)
const PHONE = /\+?\d[\d\s().-]{5,}\d/g;
const LONG_DIGITS = /\d{7,}/g;

export function redactPersonal(raw, max = 200) {
  return String(raw ?? '')
    .replace(EMAIL, '[correo]')
    .replace(URL, '[enlace]')
    .replace(PHONE, m => (m.replace(/\D/g, '').length >= 7 ? '[teléfono]' : m))
    .replace(LONG_DIGITS, '[número]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
