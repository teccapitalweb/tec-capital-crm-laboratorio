// Textos del asistente (docs/PLAN_MENSAJES_AMABLES.md). Un solo lugar para lo que el asistente le escribe al cliente cuando no hay una
// plantilla aprobada de Contenido: tono cercano, la información necesaria y, cuando aplica, el siguiente paso hacia la inscripción.
// Reglas que estos textos respetan:
//  · Precio, fecha, docente y promoción salen SIEMPRE del catálogo vigente (el contexto `ctx`), nunca de un texto fijo.
//  · No prometen lo que el sistema no hace: no confirman pagos por su cuenta ni apartan lugares.
//  · Es un laboratorio: donde hay dinero o una oferta se dice, una vez y en corto, que es de prueba.
// Funciones puras: reciben datos y devuelven texto; no leen la base ni la red.

const money=(cents,currency)=>new Intl.NumberFormat('es-MX',{style:'currency',currency,minimumFractionDigits:2}).format(cents/100)+' '+currency;
const ZONES={'America/Mexico_City':'hora del centro de México','America/Monterrey':'hora del centro de México','America/Cancun':'hora de Cancún','America/Tijuana':'hora de Tijuana','America/Bogota':'hora de Colombia','America/Lima':'hora de Perú','Europe/Madrid':'hora de España'};
const MODALITY={online:'En línea',in_person:'Presencial',hybrid:'Híbrida'};

// Nombre de pila para saludar, sólo si parece un nombre (no un alias como «miguel.admin2»).
export const firstName=name=>{const f=String(name||'').trim().split(/\s+/)[0]||'';return /^[\p{L}'’-]{2,20}$/u.test(f)?f:'';};
const hi=name=>{const f=firstName(name);return f?', '+f:'';};

// «martes, 1 de diciembre de 2026, 7:00 p.m. (hora del centro de México)», o null si la edición no tiene fecha.
export function startText(edition){
  if(edition?.starts_at===null||edition?.starts_at===undefined)return null;
  const zone=edition.timezone||'America/Mexico_City';
  return new Intl.DateTimeFormat('es-MX',{weekday:'long',day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit',timeZone:zone}).format(edition.starts_at)+' ('+(ZONES[zone]||zone)+')';
}
const shortDay=(t,zone)=>new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'long',timeZone:zone||'America/Mexico_City'}).format(t);

export function priceText(ctx){
  const p=ctx.promotion,e=ctx.edition;
  return money(ctx.priceCents,ctx.currency||e.currency)+(p?' con la promoción «'+p.name+'»'+(p.ends_at?', vigente hasta el '+shortDay(p.ends_at,e.timezone):''):'');
}
// Datos de la edición en renglones; lo que no se sabe se omite o se dice claro, sin «Por confirmar» sueltos.
export function facts(ctx,{price=true}={}){
  const e=ctx.edition,start=startText(e),legacy=ctx.dateLabel&&!/por confirmar/i.test(ctx.dateLabel)?ctx.dateLabel:null,lines=[];
  lines.push('• Inicio: '+(start||legacy||'fecha por confirmar'));
  if(e.instructor)lines.push('• Docente: '+e.instructor);
  if(MODALITY[e.modality])lines.push('• Modalidad: '+MODALITY[e.modality]+(e.location?' · '+e.location:''));
  if(price)lines.push('• Precio: '+priceText(ctx));
  return lines;
}
const title=ctx=>ctx.course.title+' · '+ctx.edition.name;
export const LAB_NOTE='Chat de prueba: los precios y las fechas son de ejemplo.';

// Ficha del curso que acompaña a la bienvenida.
export const card=ctx=>title(ctx)+'\n'+facts(ctx).join('\n')+'\n\n'+LAB_NOTE;
export const welcome=(ctx,name)=>ctx.course.welcome.replaceAll('{{nombre}}',firstName(name)||'qué tal').replaceAll('{{curso}}',ctx.course.title)+'\n\n'+card(ctx);

// Cada respuesta tiene un CUERPO (el dato) y un CIERRE (el siguiente paso). Por separado sirven para contestar varias preguntas en un mensaje.
const ENROLL_CTA='Si quieres apartar tu lugar, escribe «Quiero inscribirme» y te mando tu enlace de pago.';
const PRICE_NOTE='(Precio de ejemplo: este es un chat de prueba.)';
export const priceBody=ctx=>'El precio de '+title(ctx)+' es de '+priceText(ctx)+'.';
export const price=ctx=>priceBody(ctx)+'\n\n'+ENROLL_CTA+'\n'+PRICE_NOTE;

export function syllabusBody(ctx){
  const items=String(ctx.course.syllabus||'').split('\n').map(l=>l.trim()).filter(Boolean).map(l=>/^([•\-–*]|\d+[.)])\s/.test(l)?l:'• '+l);
  return 'Esto es lo que verás en '+ctx.course.title+':\n\n'+items.join('\n');
}
export const syllabus=ctx=>syllabusBody(ctx)+'\n\n¿Te cuento el precio o las fechas?';
export function scheduleBody(ctx){
  const lines=facts(ctx,{price:false});
  if(!ctx.edition.instructor)lines.splice(1,0,'• Docente: por confirmar');
  return title(ctx)+'\n'+lines.join('\n');
}
export const schedule=ctx=>scheduleBody(ctx)+'\n\n'+(startText(ctx.edition)!==null?'¿Quieres apartar tu lugar? Escribe «Quiero inscribirme».':'En cuanto se confirme la fecha te avisamos por aquí. Mientras tanto, ¿te cuento el precio o el temario?');

// Varias preguntas en un mismo mensaje («¿qué temas incluye y tiene certificado?»): se contestan todas, en el orden en que se reconocen,
// con un solo cierre. `parts` son cuerpos ya armados (del catálogo o respuestas aprobadas del conocimiento).
export function several(parts,{price=false}={}){
  return parts.join('\n\n')+'\n\n'+(price?ENROLL_CTA+'\n'+PRICE_NOTE:'Si quieres apartar tu lugar, escribe «Quiero inscribirme». ¿Te ayudo con algo más?');
}

export const enrollWithOrder=(ctx,name)=>'¡Qué gusto'+hi(name)+'! Ya tengo listo tu pedido:\n\n{{pedido}}';
export const orderReminder=()=>'Tu pedido sigue vigente. Aquí lo tienes de nuevo:\n\n';
export const enrollWithAdvisor=(ctx,name)=>'¡Qué gusto'+hi(name)+'! Anoté tu interés en '+title(ctx)+'. Un asesor te escribe por aquí para completar tu inscripción.\n(Chat de prueba: no se realizan cobros reales.)';

export const paymentMethods='Puedes pagar con tarjeta u OXXO desde el enlace que te mando al inscribirte, o por transferencia enviando tu comprobante por este chat. Si quieres empezar, escribe «Quiero inscribirme».';
export const paymentWithAdvisor='Con gusto te paso las formas de pago: ya le avisé a un asesor para que te escriba por aquí.';

export const thanks=name=>'¡Con gusto'+hi(name)+'! Aquí sigo por si quieres ver el precio, las fechas o inscribirte.';
export const fallback=ctx=>'Esa no la tengo a la mano, pero puedo contarte el precio, el temario o las fechas de '+ctx.course.title+'. Si prefieres hablar con una persona, escribe «asesor».';
export const escalate='No quiero hacerte perder tiempo: le paso tu pregunta a una persona del equipo para que te responda bien. Te escribe por aquí en cuanto pueda.';
export const human=name=>'¡Claro'+hi(name)+'! Ya le avisé al equipo: un asesor te escribe por aquí en cuanto esté disponible.';
export const refund=name=>'Lamento mucho la molestia'+hi(name)+'. Ya pasé tu caso a una persona del equipo para que lo revise y te responda por aquí.';
export const unavailable=reason=>'Por ahora esta edición no está disponible ('+String(reason||'').charAt(0).toLowerCase()+String(reason||'').slice(1)+'). Ya le avisé a un asesor para que te proponga otra opción.';

// Mensaje del pedido con su enlace de pago y confirmación del pago (los usa server/payments.mjs cuando no hay plantilla aprobada).
export function orderLink({reference,course,edition,amount,note='',coupon='',link,until}){
  return 'Pedido '+reference+'\n'+course+' · '+edition+' — '+amount+note+'.'+coupon+'\n\nPaga aquí: '+link+'\nEl enlace vence el '+until+(String(until).endsWith('.')?'':'.')+'\nSi prefieres transferencia, envía tu comprobante por este chat y una persona lo valida.\n\nPago de prueba: no se cobra nada real.';
}
export function paymentConfirmed({name,reference,course,edition,perSession=false}){
  return '✅ ¡Pago confirmado'+hi(name)+'! Tu inscripción a '+course+' · '+edition+' quedó lista'+(perSession?' con plan por sesión: este pago cubre tu primera sesión y el enlace de pago de cada sesión siguiente llegará por aquí antes de la clase':'')+'. Pedido '+reference+'.\nEl equipo coordinador te enviará por aquí los accesos y los recordatorios antes de empezar.\n\nPago de prueba: no se realizó ningún cobro real.';
}
