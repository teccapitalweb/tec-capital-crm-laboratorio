import {createECDH,createCipheriv,createDecipheriv,createPrivateKey,generateKeyPairSync,hkdfSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {transaction} from './database.mjs';

// Notificaciones push para el equipo (Fase 5, bloque 4; docs/PLAN_PUSH.md). Web Push estándar: claves VAPID (RFC 8292) y
// cifrado de contenido aes128gcm (RFC 8291) con node:crypto, sin dependencias. Es la única salida real a internet del
// laboratorio y es opt-in por dispositivo: cada persona activa las notificaciones en su navegador. El servicio de push
// (Google, Mozilla, Apple, Microsoft) sólo ve contenido cifrado que únicamente el navegador de esa persona puede leer.
// El envío sale de la tabla `notifications` (avisos que el equipo ya recibe en «Mis avisos»): un barrido periódico manda los
// no leídos tras una espera corta y marca `pushed_at`, así que no hay que tocar cada lugar que crea avisos.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const b64u=b=>Buffer.from(b).toString('base64url');
const unb64u=s=>Buffer.from(String(s||''),'base64url');
export const GROUPS={chats:'Chats: asignación, menciones y transferencias',sla:'Objetivos de respuesta',sales:'Pagos y comprobantes',ops:'Aperturas, certificados y seguimientos'};
const GROUP_OF={assignment:'chats',mention:'chats',transfer:'chats',sla:'sla',payment:'sales',receipt:'sales'};
export const groupOf=kind=>GROUP_OF[kind]||'ops';
// El servidor sólo contacta servicios de push conocidos (evita que una suscripción falsa use al servidor para llegar a otras direcciones).
const HOSTS=[/^fcm\.googleapis\.com$/,/^updates\.push\.services\.mozilla\.com$/,/\.push\.services\.mozilla\.com$/,/\.push\.apple\.com$/,/^web\.push\.apple\.com$/,/\.notify\.windows\.com$/,/^android\.googleapis\.com$/];
export function endpointAllowed(raw,env=process.env){
  let u;try{u=new URL(raw);}catch{return false;}
  if(env.NODE_ENV==='test'&&u.protocol==='http:'&&u.hostname==='127.0.0.1')return true;
  return u.protocol==='https:'&&!u.port&&HOSTS.some(r=>r.test(u.hostname));
}

// ---- cifrado aes128gcm (RFC 8291). `ephemeral` y `salt` sólo se inyectan en pruebas.
export function encryptPayload(payload,{p256dh,auth},{ephemeral=null,salt=null}={}){
  const ua=unb64u(p256dh),authSecret=unb64u(auth);
  if(ua.length!==65||ua[0]!==4)throw fail(400,'Clave pública de la suscripción no válida.');if(authSecret.length!==16)throw fail(400,'Secreto de autenticación no válido.');
  const body=Buffer.isBuffer(payload)?payload:Buffer.from(String(payload),'utf8');if(body.length>3900)throw fail(400,'El aviso es demasiado largo.');
  const ecdh=ephemeral||(()=>{const e=createECDH('prime256v1');e.generateKeys();return e;})(),asPublic=ecdh.getPublicKey(),secret=ecdh.computeSecret(ua);
  const ikm=Buffer.from(hkdfSync('sha256',secret,authSecret,Buffer.concat([Buffer.from('WebPush: info\0'),ua,asPublic]),32));
  const s=salt||randomBytes(16),cek=Buffer.from(hkdfSync('sha256',ikm,s,Buffer.from('Content-Encoding: aes128gcm\0'),16)),nonce=Buffer.from(hkdfSync('sha256',ikm,s,Buffer.from('Content-Encoding: nonce\0'),12));
  const cipher=createCipheriv('aes-128-gcm',cek,nonce),encrypted=Buffer.concat([cipher.update(Buffer.concat([body,Buffer.from([2])])),cipher.final(),cipher.getAuthTag()]);
  const header=Buffer.alloc(21+asPublic.length);s.copy(header,0);header.writeUInt32BE(4096,16);header[20]=asPublic.length;asPublic.copy(header,21);
  return Buffer.concat([header,encrypted]);
}
// Lado receptor, sólo para pruebas y diagnóstico: descifra lo que `encryptPayload` produjo con la clave privada del navegador.
export function decryptPayload(message,{ecdh,auth}){
  const salt=message.subarray(0,16),idlen=message[20],asPublic=message.subarray(21,21+idlen),data=message.subarray(21+idlen),ua=ecdh.getPublicKey();
  const ikm=Buffer.from(hkdfSync('sha256',ecdh.computeSecret(asPublic),unb64u(auth),Buffer.concat([Buffer.from('WebPush: info\0'),ua,asPublic]),32));
  const cek=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16)),nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
  const d=createDecipheriv('aes-128-gcm',cek,nonce);d.setAuthTag(data.subarray(data.length-16));
  const plain=Buffer.concat([d.update(data.subarray(0,data.length-16)),d.final()]);let end=plain.length;while(end>0&&plain[end-1]===0)end--;
  if(plain[end-1]!==2)throw new Error('Registro sin delimitador final.');return plain.subarray(0,end-1);
}

export function createPush({db,crm,body,json,audit,now=Date.now,env=process.env,fetchFn=fetch}){
  const disabled=env.PUSH_DISABLED==='1';
  const DELAY=Number(env.PUSH_DELAY_MS)>=0&&env.PUSH_DELAY_MS!==undefined?Number(env.PUSH_DELAY_MS):15000;   // si el aviso sigue sin leerse tras esta espera, se manda
  const subject=env.PUSH_SUBJECT||env.APP_ORIGIN||'https://crm-laboratorio-production.up.railway.app';
  const staffRow=id=>db.prepare('SELECT id,role,disabled FROM users WHERE id=?').get(id);
  const requireStaff=user=>{const u=staffRow(user.id);if(!u||u.disabled||!['agent','admin'].includes(u.role))throw fail(403,'Las notificaciones son para el equipo de atención.');return u;};
  const requireEnabled=()=>{if(disabled)throw fail(503,'Las notificaciones push están desactivadas en este entorno.');};

  // Claves VAPID: se generan una sola vez y se guardan en la base (nunca en el repositorio ni en la respuesta de la API).
  function keys(){
    let row=db.prepare('SELECT * FROM push_keys WHERE id=1').get();
    if(!row){
      const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=privateKey.export({format:'jwk'}),pub=Buffer.concat([Buffer.from([4]),unb64u(jwk.x),unb64u(jwk.y)]);
      db.prepare('INSERT OR IGNORE INTO push_keys(id,public_key,private_jwk,created_at) VALUES(1,?,?,?)').run(b64u(pub),JSON.stringify(jwk),now());
      row=db.prepare('SELECT * FROM push_keys WHERE id=1').get();
    }
    return {publicKey:row.public_key,privateKey:createPrivateKey({key:JSON.parse(row.private_jwk),format:'jwk'})};
  }
  function vapid(endpoint){
    const k=keys(),aud=new URL(endpoint).origin,enc=o=>b64u(JSON.stringify(o)),input=enc({typ:'JWT',alg:'ES256'})+'.'+enc({aud,exp:Math.floor(now()/1000)+12*3600,sub:subject});
    const sig=sign('sha256',Buffer.from(input),{key:k.privateKey,dsaEncoding:'ieee-p1363'});
    return `vapid t=${input}.${b64u(sig)}, k=${k.publicKey}`;
  }
  const groupsOf=userId=>{const r=db.prepare('SELECT groups FROM push_prefs WHERE user_id=?').get(userId);try{return r?JSON.parse(r.groups):Object.keys(GROUPS);}catch{return Object.keys(GROUPS);}};

  // Un envío a una suscripción. 404/410 = el navegador ya no existe: se elimina. Cualquier otro error suma un fallo (5 seguidos la eliminan).
  async function sendTo(sub,payload,{ttl=3600,urgency='normal'}={}){
    let status=0,error=null;
    try{
      const res=await fetchFn(sub.endpoint,{method:'POST',headers:{'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:String(ttl),Urgency:urgency,Authorization:vapid(sub.endpoint)},body:encryptPayload(JSON.stringify(payload),sub),signal:AbortSignal.timeout(10000)});
      status=res.status;if(!(status>=200&&status<300))error='HTTP '+status;
    }catch(e){error=String(e?.message||e).slice(0,160);}
    const t=now();
    if(!error)db.prepare('UPDATE push_subscriptions SET last_ok_at=?,last_error=NULL,failures=0 WHERE id=?').run(t,sub.id);
    else if(status===404||status===410)db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(sub.id);
    else{db.prepare('UPDATE push_subscriptions SET last_error=?,failures=failures+1 WHERE id=?').run(error,sub.id);db.prepare('DELETE FROM push_subscriptions WHERE id=? AND failures>=5').run(sub.id);}
    return {ok:!error,status,error};
  }

  let running=false;
  async function tick(){
    if(disabled||running)return 0;running=true;let sent=0;
    try{
      const t=now();
      db.prepare('UPDATE notifications SET pushed_at=? WHERE pushed_at IS NULL AND read_at IS NOT NULL').run(t);   // lo que ya se leyó no se manda
      const rows=db.prepare('SELECT n.* FROM notifications n WHERE n.pushed_at IS NULL AND n.created_at<=? AND EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.user_id=n.user_id) ORDER BY n.created_at LIMIT 20').all(t-DELAY);
      for(const n of rows){
        const mark=db.prepare('UPDATE notifications SET pushed_at=? WHERE id=? AND pushed_at IS NULL').run(now(),n.id);if(!mark.changes)continue;   // un solo envío por aviso
        if(!groupsOf(n.user_id).includes(groupOf(n.kind)))continue;
        const brand=db.prepare('SELECT name FROM brands WHERE id=?').get(n.brand_id)?.name||'';
        const payload={title:'TEC Capital'+(brand?' · '+brand:''),body:String(n.title).slice(0,200),tag:n.id,url:'/crm',kind:n.kind};
        for(const sub of db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(n.user_id)){await sendTo(sub,payload);sent++;}
      }
    }finally{running=false;}
    return sent;
  }

  function subscribe(user,input){
    requireEnabled();requireStaff(user);const s=input?.subscription||{},endpoint=typeof s.endpoint==='string'?s.endpoint.slice(0,1000):'',k=s.keys||{};
    if(!endpointAllowed(endpoint,env))throw fail(400,'Este navegador usa un servicio de push que el laboratorio no admite.');
    const ua=unb64u(k.p256dh),auth=unb64u(k.auth);if(ua.length!==65||ua[0]!==4||auth.length!==16)throw fail(400,'La suscripción del navegador no es válida.');
    return transaction(db,()=>{
      const own=db.prepare('SELECT count(*) n FROM push_subscriptions WHERE user_id=? AND endpoint!=?').get(user.id,endpoint).n;if(own>=10)throw fail(409,'Ya tienes 10 dispositivos con notificaciones. Desactiva alguno.');
      const t=now(),agent=String(input?.userAgent||'').slice(0,200),existing=db.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?').get(endpoint);
      if(existing)db.prepare('UPDATE push_subscriptions SET user_id=?,p256dh=?,auth=?,user_agent=?,failures=0,last_error=NULL WHERE id=?').run(user.id,b64u(ua),b64u(auth),agent,existing.id);
      else db.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,user_agent,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),user.id,endpoint,b64u(ua),b64u(auth),agent,t);
      db.prepare('UPDATE notifications SET pushed_at=? WHERE user_id=? AND pushed_at IS NULL').run(t,user.id);   // al activar no se reenvía lo anterior
      return {ok:true};
    });
  }
  const unsubscribe=(user,input)=>{requireStaff(user);const r=db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(user.id,String(input?.endpoint||''));return {removed:r.changes};};
  function setPrefs(user,input){
    requireStaff(user);if(!Array.isArray(input?.groups)||input.groups.some(g=>!GROUPS[g]))throw fail(400,'Grupos de avisos no válidos.');
    const groups=[...new Set(input.groups)];db.prepare('INSERT INTO push_prefs(user_id,groups,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET groups=excluded.groups,updated_at=excluded.updated_at').run(user.id,JSON.stringify(groups),now());
    return {groups};
  }
  const lastTest=new Map();
  async function test(user){
    requireEnabled();requireStaff(user);const t=now();if(t-(lastTest.get(user.id)||0)<5000)throw fail(429,'Espera unos segundos antes de otra prueba.');lastTest.set(user.id,t);
    const subs=db.prepare('SELECT * FROM push_subscriptions WHERE user_id=?').all(user.id);if(!subs.length)throw fail(409,'Este dispositivo todavía no tiene las notificaciones activadas.');
    const results=[];for(const s of subs)results.push(await sendTo(s,{title:'TEC Capital',body:'Notificación de prueba: todo funciona.',tag:'prueba',url:'/crm',kind:'test'},{ttl:60}));
    return {results};
  }
  function config(user){
    requireStaff(user);
    if(disabled)return {enabled:false,publicKey:null,devices:[],groups:[],available:GROUPS};
    return {enabled:true,publicKey:keys().publicKey,groups:groupsOf(user.id),available:GROUPS,
      devices:db.prepare('SELECT id,endpoint,user_agent,created_at,last_ok_at,last_error,failures FROM push_subscriptions WHERE user_id=? ORDER BY created_at').all(user.id).map(d=>({id:d.id,endpoint:d.endpoint,host:new URL(d.endpoint).hostname,userAgent:d.user_agent,createdAt:d.created_at,lastOkAt:d.last_ok_at,lastError:d.last_error,failures:d.failures}))};
  }

  async function handle(req,res,path,user){
    if(!path.startsWith('/api/push'))return false;
    if(path==='/api/push/config'&&req.method==='GET'){json(res,200,config(user));return true;}
    if(path==='/api/push/subscribe'&&req.method==='POST'){const out=subscribe(user,await body(req));audit(user,'push.subscribe',user.id);json(res,200,out);return true;}
    if(path==='/api/push/unsubscribe'&&req.method==='POST'){const out=unsubscribe(user,await body(req));audit(user,'push.unsubscribe',user.id);json(res,200,out);return true;}
    if(path==='/api/push/prefs'&&req.method==='PUT'){json(res,200,setPrefs(user,await body(req)));return true;}
    if(path==='/api/push/test'&&req.method==='POST'){await body(req);json(res,200,await test(user));return true;}
    throw fail(404,'Ruta de notificaciones no encontrada.');
  }
  return {handle,tick,sendTo,subscribe,config,keys,disabled};
}
