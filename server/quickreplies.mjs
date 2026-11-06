import {randomUUID} from 'node:crypto';

// Respuestas rápidas del chat (Fase 5, bloque 5; docs/PLAN_CHAT_RAPIDO.md). Textos que el equipo inserta en el compositor
// escribiendo «/atajo»: personales (de una persona) o compartidas por marca (las administra administración). Sólo llevan
// variables de conversación (nombre, curso, edición, marca, asesor): los precios, fechas y cupos siguen saliendo de las
// plantillas aprobadas y del catálogo vigente, nunca de un texto escrito a mano. Insertar no envía nada: la persona revisa
// y envía por la ruta normal, que ya respeta la ventana de servicio y el canal.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export const VARIABLES={nombre:'Nombre de pila del cliente',nombre_completo:'Nombre completo del cliente',curso:'Curso de la conversación',edicion:'Edición de la conversación',marca:'Marca',asesor:'Tu nombre'};
// Biblioteca de ejemplos: puntos de partida para que nadie empiece con la hoja en blanco. Sólo variables de conversación y
// ningún precio, fecha ni cupo (eso sale de las plantillas aprobadas). La persona las agrega con un clic y las edita a su gusto.
export const STARTER=[
  {group:'Saludar',shortcut:'hola',title:'Saludo inicial',body:'Hola {{nombre}}, soy {{asesor}} de {{marca}}. ¡Gracias por escribirnos! ¿En qué te puedo ayudar con {{curso}}?'},
  {group:'Saludar',shortcut:'gracias',title:'Agradecer el interés',body:'Hola {{nombre}}, gracias por tu interés en {{curso}}. Soy {{asesor}} de {{marca}} y con gusto te acompaño.'},
  {group:'Saludar',shortcut:'disculpa',title:'Disculpa por la espera',body:'Disculpa la espera, {{nombre}}. Ya estoy contigo; soy {{asesor}} de {{marca}}.'},
  {group:'Informar',shortcut:'info',title:'Ofrecer información',body:'Con gusto te cuento todo sobre {{curso}}, {{nombre}}. ¿Prefieres que te comparta el temario, las fechas o cómo inscribirte?'},
  {group:'Informar',shortcut:'espera',title:'Pedir un momento',body:'Dame un momento, {{nombre}}, lo reviso y te respondo enseguida.'},
  {group:'Informar',shortcut:'datos',title:'Pedir datos para inscribirlo',body:'Para continuar con tu inscripción a {{curso}}, {{nombre}}, ¿me compartes tu nombre completo y tu correo electrónico?'},
  {group:'Seguimiento',shortcut:'seguimiento',title:'Retomar la conversación',body:'Hola {{nombre}}, ¿pudiste revisar la información de {{curso}}? Si tienes alguna duda, aquí estoy para ayudarte.'},
  {group:'Seguimiento',shortcut:'sigues',title:'¿Todavía te interesa?',body:'Hola {{nombre}}, te escribo para saber si aún te interesa {{curso}}. Si prefieres que no te escribamos más, dímelo y lo respetamos.'},
  {group:'Pagos',shortcut:'pagar',title:'Ofrecer el enlace de pago',body:'Para inscribirte a {{curso}} puedo enviarte tu enlace de pago aquí mismo, {{nombre}}. ¿Te lo mando?'},
  {group:'Pagos',shortcut:'comprobante',title:'Recibí tu comprobante',body:'Recibí tu comprobante, {{nombre}}. Lo reviso y te confirmo tu inscripción a {{curso}} en cuanto esté validado.'},
  {group:'Pagos',shortcut:'pagado',title:'Pago confirmado (úsala sólo si ya lo validaste)',body:'¡Listo, {{nombre}}! Tu pago quedó confirmado y ya estás inscrito en {{curso}} ({{edicion}}). Bienvenido a {{marca}}.'},
  {group:'Cerrar',shortcut:'dudas',title:'¿Te quedó alguna duda?',body:'¿Te quedó alguna duda, {{nombre}}? Con gusto te ayudo.'},
  {group:'Cerrar',shortcut:'despedida',title:'Despedida',body:'Gracias por escribir a {{marca}}, {{nombre}}. Que tengas un excelente día. Soy {{asesor}}; aquí sigo para lo que necesites.'},
];
const SHORTCUT=/^[a-z0-9áéíóúüñ_-]{2,20}$/;
const MAX_PER_OWNER=100,MAX_BODY=1500;

export function validateBody(body){
  const matches=[...body.matchAll(/\{\{([^{}]+)\}\}/g)];
  if(matches.some(m=>!VARIABLES[m[1].trim()])||body.replace(/\{\{[^{}]+\}\}/g,'').includes('{{')||body.replace(/\{\{[^{}]+\}\}/g,'').includes('}}'))throw fail(400,'Usa sólo las variables disponibles ('+Object.keys(VARIABLES).map(k=>'{{'+k+'}}').join(', ')+') y cierra sus llaves.');
}
export const fill=(body,values)=>body.replace(/\{\{([^{}]+)\}\}/g,(_,k)=>values[k.trim()]??'');

export function createQuickReplies({db,crm,accessConversation,body,json,audit,now=Date.now}){
  const staffRow=id=>db.prepare('SELECT id,name,role,disabled FROM users WHERE id=?').get(id);
  const requireStaff=user=>{const u=staffRow(user.id);if(!u||u.disabled||!['agent','admin'].includes(u.role))throw fail(403,'Las respuestas rápidas son para el equipo de atención.');return u;};
  const get=id=>typeof id==='string'?db.prepare('SELECT * FROM quick_replies WHERE id=? AND archived_at IS NULL').get(id):null;
  const brandName=id=>db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name||'';
  const view=(r,me)=>({id:r.id,scope:r.scope,brandId:r.brand_id,brandName:r.brand_id?brandName(r.brand_id):null,shortcut:r.shortcut,title:r.title,body:r.body,revision:r.revision,uses:r.uses,lastUsedAt:r.last_used_at,
    editable:r.scope==='personal'?r.user_id===me.id:me.role==='admin'});

  function list(user){
    const me=requireStaff(user),mine=db.prepare("SELECT * FROM quick_replies WHERE scope='personal' AND user_id=? AND archived_at IS NULL ORDER BY shortcut").all(me.id);
    const brands=crm.brandsFor(user).map(b=>b.id),shared=brands.length?db.prepare(`SELECT * FROM quick_replies WHERE scope='brand' AND brand_id IN (${brands.map(()=>'?').join(',')}) AND archived_at IS NULL ORDER BY brand_id,shortcut`).all(...brands):[];
    return {quickReplies:[...mine,...shared].map(r=>view(r,me)),variables:VARIABLES,starter:STARTER,brands:crm.brandsFor(user).map(b=>({id:b.id,name:b.name})),canShare:me.role==='admin'};
  }
  function normalize(input,current=null){
    const shortcut=input.shortcut===undefined?current.shortcut:text(input.shortcut,60).replace(/^\//,'').toLowerCase();
    if(!SHORTCUT.test(shortcut))throw fail(400,'El atajo usa de 2 a 20 letras, números, guion o guion bajo, sin espacios (por ejemplo «gracias»).');
    const title=input.title===undefined?current.title:text(input.title,60);if(!title)throw fail(400,'Ponle un nombre corto a la respuesta.');
    const bodyText=input.body===undefined?current.body:text(input.body,MAX_BODY+1);if(!bodyText)throw fail(400,'Escribe el texto de la respuesta.');if(bodyText.length>MAX_BODY)throw fail(400,'La respuesta rápida admite hasta '+MAX_BODY+' caracteres.');
    validateBody(bodyText);return {shortcut,title,body:bodyText};
  }
  function create(user,input){
    const me=requireStaff(user),scope=input.scope==='brand'?'brand':'personal',data=normalize(input);let brandId=null;
    if(scope==='brand'){
      if(me.role!=='admin')throw fail(403,'Las respuestas compartidas de una marca las administra administración.');
      brandId=input.brandId;if(typeof brandId!=='string'||!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');crm.requireBrand(user,brandId);
    }
    const ref=input.clientRef===undefined?null:text(input.clientRef,80);if(input.clientRef!==undefined&&ref.length<8)throw fail(400,'Referencia de idempotencia no válida.');
    if(ref){const same=db.prepare('SELECT * FROM quick_replies WHERE client_ref=?').get(ref);if(same){if(same.created_by!==me.id)throw fail(409,'La referencia ya pertenece a otra respuesta.');return view(same,me);}}
    const owner=scope==='brand'?['brand_id',brandId]:['user_id',me.id];
    if(db.prepare(`SELECT count(*) n FROM quick_replies WHERE scope=? AND ${owner[0]}=? AND archived_at IS NULL`).get(scope,owner[1]).n>=MAX_PER_OWNER)throw fail(409,'Ya tienes el máximo de '+MAX_PER_OWNER+' respuestas rápidas. Archiva alguna.');
    if(db.prepare(`SELECT 1 FROM quick_replies WHERE scope=? AND ${owner[0]}=? AND shortcut=? AND archived_at IS NULL`).get(scope,owner[1],data.shortcut))throw fail(409,'Ya existe una respuesta con el atajo «/'+data.shortcut+'».');
    const id=randomUUID(),t=now();
    db.prepare('INSERT INTO quick_replies(id,scope,user_id,brand_id,shortcut,title,body,client_ref,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,scope,scope==='personal'?me.id:null,brandId,data.shortcut,data.title,data.body,ref,me.id,t,t);
    return view(get(id),me);
  }
  function editable(user,id){
    const me=requireStaff(user),r=get(id);if(!r)throw fail(404,'Respuesta rápida no encontrada.');
    if(r.scope==='personal'){if(r.user_id!==me.id)throw fail(404,'Respuesta rápida no encontrada.');}
    else{crm.requireBrand(user,r.brand_id);if(me.role!=='admin')throw fail(403,'Las respuestas compartidas de una marca las administra administración.');}
    return {me,r};
  }
  function update(user,id,input){
    const {me,r}=editable(user,id);if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==r.revision)throw fail(409,'La respuesta cambió. Recárgala.');
    const data=normalize(input,r),owner=r.scope==='brand'?['brand_id',r.brand_id]:['user_id',r.user_id];
    if(db.prepare(`SELECT 1 FROM quick_replies WHERE scope=? AND ${owner[0]}=? AND shortcut=? AND archived_at IS NULL AND id!=?`).get(r.scope,owner[1],data.shortcut,r.id))throw fail(409,'Ya existe una respuesta con el atajo «/'+data.shortcut+'».');
    db.prepare('UPDATE quick_replies SET shortcut=?,title=?,body=?,revision=revision+1,updated_at=? WHERE id=?').run(data.shortcut,data.title,data.body,now(),r.id);
    return view(get(r.id),me);
  }
  function archive(user,id){
    const {r}=editable(user,id);db.prepare('UPDATE quick_replies SET archived_at=?,updated_at=? WHERE id=?').run(now(),now(),r.id);return {archived:true};
  }
  // Arma el texto para una conversación concreta. No envía nada.
  function render(user,id,input){
    const me=requireStaff(user),r=get(id);if(!r)throw fail(404,'Respuesta rápida no encontrada.');
    if(r.scope==='personal'&&r.user_id!==me.id)throw fail(404,'Respuesta rápida no encontrada.');
    if(typeof input?.conversationId!=='string')throw fail(400,'Indica la conversación.');
    const c=accessConversation(input.conversationId,user);crm.requireBrand(user,c.brand_id);
    if(r.scope==='brand'&&r.brand_id!==c.brand_id)throw fail(409,'Esta respuesta es de otra marca.');
    const customer=db.prepare('SELECT name FROM users WHERE id=?').get(c.customer_id)?.name||'',course=db.prepare('SELECT title FROM courses WHERE id=?').get(c.course_id)?.title||'',edition=c.edition_id?db.prepare('SELECT name FROM editions WHERE id=?').get(c.edition_id)?.name||'':'';
    const out=fill(r.body,{nombre:customer.split(' ')[0]||'',nombre_completo:customer,curso:course,edicion:edition,marca:brandName(c.brand_id),asesor:me.name||''});
    if(out.length>5000)throw fail(400,'El texto resultante es demasiado largo para un mensaje.');
    db.prepare('UPDATE quick_replies SET uses=uses+1,last_used_at=? WHERE id=?').run(now(),r.id);
    return {text:out,quickReplyId:r.id};
  }

  async function handle(req,res,path,user){
    if(!(path==='/api/quick-replies'||path.startsWith('/api/quick-replies/')))return false;
    let x;
    if(path==='/api/quick-replies'){
      if(req.method==='GET'){json(res,200,list(user));return true;}
      if(req.method==='POST'){const out=create(user,await body(req));audit(user,'quickreply.create',out.id);json(res,201,{quickReply:out});return true;}
      throw fail(405,'Método no permitido.');
    }
    if(!(x=path.match(/^\/api\/quick-replies\/([a-f0-9-]{36})(?:\/(render))?$/)))throw fail(404,'Ruta de respuestas rápidas no encontrada.');
    if(x[2]==='render'&&req.method==='POST'){json(res,200,render(user,x[1],await body(req)));return true;}
    if(!x[2]&&req.method==='PATCH'){const out=update(user,x[1],await body(req));audit(user,'quickreply.update',x[1]);json(res,200,{quickReply:out});return true;}
    if(!x[2]&&req.method==='DELETE'){const out=archive(user,x[1]);audit(user,'quickreply.archive',x[1]);json(res,200,out);return true;}
    throw fail(405,'Método no permitido.');
  }
  return {handle,list,create,update,archive,render};
}
