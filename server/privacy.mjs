// Aviso de privacidad público (/privacidad). docs/PLAN_AVISO_PRIVACIDAD.md
// Meta exige una URL de política de privacidad para publicar la app de WhatsApp; además, quien escribe a un número de la empresa
// tiene derecho a saber qué se guarda y cómo pedir que se borre. Es una página estática, sin sesión, sin datos de nadie y sin
// secretos. El nombre de la empresa y el correo de contacto vienen del entorno: el repositorio es público y no lleva correos.
// ES UN TEXTO BASE: la empresa debe revisarlo y ajustarlo; no sustituye la asesoría legal.
export const PRIVACY_UPDATED = '12 de noviembre de 2026';
const esc = v =>
  String(v ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const clean = (v, max) =>
  String(v || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, max);

export function privacyPage({ company = 'TEC Capital', email = '' } = {}) {
  const name = esc(clean(company, 80) || 'TEC Capital'),
    mail = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i.test(String(email).trim()) ? esc(String(email).trim()) : '';
  const contact = mail
    ? `escribiendo a <a href="mailto:${mail}">${mail}</a> o por el mismo chat en el que hablas con nosotros`
    : 'por el mismo chat en el que hablas con nosotros';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviso de privacidad · ${name}</title>
<style>body{margin:0;background:#f1f4f6;color:#242428;font:15px/1.65 Manrope,Inter,'Segoe UI',Helvetica,Arial,sans-serif}main{max-width:720px;margin:0 auto;padding:40px 16px 56px}.card{background:#fff;border:1px solid #e1e6ea;border-radius:18px;padding:32px;box-shadow:0 1px 2px #1d2e380a,0 10px 28px -18px #1d2e3829}.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#2f6f8f;font-weight:600}h1{font-size:28px;line-height:1.2;margin:6px 0 6px;font-weight:650;letter-spacing:-.6px}h2{font-size:16px;margin:28px 0 8px;font-weight:650}p,li{color:#4b515c}p{margin:0 0 12px}ul{margin:0 0 12px;padding-left:20px}li{margin-bottom:6px}.sub{color:#636977;font-size:13px;margin-bottom:20px}.box{border:1px solid #cddbe3;background:#f1f6f9;border-radius:12px;padding:14px 16px;margin:16px 0}.box p{margin:0;color:#255a75}a{color:#255a75}strong{color:#242428}footer{margin-top:20px;font-size:12px;color:#636977;text-align:center}@media(max-width:600px){main{padding:20px 12px 40px}.card{padding:22px 18px}h1{font-size:24px}}</style></head>
<body><main><article class="card">
<span class="eyebrow">${name}</span>
<h1>Aviso de privacidad</h1>
<p class="sub">Última actualización: ${PRIVACY_UPDATED}</p>
<p>Este aviso explica qué datos personales recibimos cuando nos escribes por WhatsApp o por nuestros canales de atención, para qué los usamos y cómo puedes pedir que los corrijamos o los borremos.</p>

<h2>Quién es responsable de tus datos</h2>
<p><strong>${name}</strong> y las marcas de cursos que opera son responsables del tratamiento de tus datos personales. Puedes contactarnos ${contact}.</p>

<h2>Qué datos recibimos</h2>
<ul>
<li><strong>Datos de contacto:</strong> tu número de teléfono y el nombre de tu perfil de WhatsApp.</li>
<li><strong>Tus mensajes:</strong> lo que nos escribes y los archivos que nos envías (por ejemplo, un comprobante de pago).</li>
<li><strong>Tu interés:</strong> el curso y la edición por los que preguntas y la etapa de tu inscripción.</li>
<li><strong>Pedidos y pagos:</strong> la referencia, el importe y el estado de tu pedido. No guardamos los datos de tu tarjeta.</li>
</ul>
<p>No pedimos datos sensibles. Si no son necesarios para atenderte, no nos los envíes.</p>

<h2>Para qué los usamos</h2>
<ul>
<li>Responder tus preguntas y darte información de nuestros cursos.</li>
<li>Gestionar tu inscripción, tus pagos y la entrega de tus accesos y constancias.</li>
<li>Darte seguimiento y recordatorios relacionados con lo que solicitaste.</li>
<li>Mejorar la calidad de nuestra atención.</li>
</ul>
<p>De forma secundaria, podemos enviarte información de otros cursos o promociones. Puedes negarte en cualquier momento: escribe <strong>«BAJA»</strong> en el chat y dejaremos de enviarte ese tipo de mensajes.</p>

<h2>Respuestas automáticas e inteligencia artificial</h2>
<p>Parte de la atención la da un asistente automático. Para redactar algunas respuestas usamos un proveedor de inteligencia artificial, que recibe el texto de tus mensajes recientes y tu nombre; <strong>no le enviamos tu número de teléfono</strong>. Los precios, las fechas y los cupos salen siempre de nuestro catálogo, no de la inteligencia artificial. Puedes pedir en cualquier momento que te atienda una persona.</p>

<h2>Con quién se comparten</h2>
<p>No vendemos tus datos. Sólo los compartimos con los proveedores que hacen posible el servicio y únicamente para ese fin:</p>
<ul>
<li>El servicio de mensajería por el que nos escribes (WhatsApp, de Meta).</li>
<li>El proveedor que aloja nuestro sistema de atención.</li>
<li>El proveedor de inteligencia artificial descrito arriba.</li>
<li>El procesador de pagos, cuando pagas en línea.</li>
</ul>
<p>También podemos entregarlos a una autoridad cuando la ley lo exija.</p>

<h2>Cuánto tiempo los conservamos</h2>
<p>Conservamos tus datos mientras exista una relación contigo (por ejemplo, mientras tomas un curso o sigues interesado) y durante el tiempo que exijan las obligaciones legales y fiscales. Después los eliminamos o los dejamos sin datos que te identifiquen.</p>

<h2 id="tus-derechos">Tus derechos</h2>
<p>Puedes pedir en cualquier momento <strong>acceder</strong> a tus datos, <strong>corregirlos</strong>, <strong>cancelarlos</strong> (borrarlos) u <strong>oponerte</strong> a que los usemos, y también retirar tu consentimiento. Para hacerlo, contáctanos ${contact} e indícanos tu nombre y el número desde el que nos escribiste. Te responderemos en un plazo máximo de 20 días hábiles.</p>

<div class="box" id="eliminar-datos"><p><strong>Cómo pedir que borremos tus datos:</strong> escríbenos ${contact} con la frase «Quiero eliminar mis datos». Confirmaremos tu identidad con el número desde el que nos contactaste y eliminaremos tus datos de contacto y tus conversaciones, salvo lo que la ley nos obligue a conservar (por ejemplo, registros de pagos).</p></div>

<h2>Seguridad</h2>
<p>El acceso a las conversaciones está limitado al equipo de la marca que te atiende y a la administración. Usamos conexiones cifradas y registros de acceso. Ningún sistema es infalible; si detectamos un incidente que afecte tus datos, te avisaremos.</p>

<h2>Cambios a este aviso</h2>
<p>Si este aviso cambia, publicaremos la versión nueva en esta misma página con su fecha de actualización.</p>
</article><footer>${name} · Aviso de privacidad</footer></main></body></html>`;
}

export function createPrivacy({ env = process.env } = {}) {
  async function handlePublic(req, res, path) {
    if (path !== '/privacidad' && path !== '/privacidad/') return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      res.end('Método no permitido.');
      return true;
    }
    const html = privacyPage({ company: env.PRIVACY_COMPANY, email: env.PRIVACY_CONTACT_EMAIL });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? '' : html);
    return true;
  }
  return { handlePublic };
}
