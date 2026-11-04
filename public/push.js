// Notificaciones push y app instalable (docs/PLAN_PUSH.md). Registra el service worker y arma el panel «Notificaciones en este
// dispositivo» de Mi configuración. Todo es opt-in: nada se pide al navegador hasta que la persona pulsa «Activar».
(function registerWorker(){
  if(!('serviceWorker' in navigator))return;
  window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js').catch(()=>{});});
})();
let installEvent=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installEvent=e;const slot=document.querySelector('#push-install');if(slot)slot.hidden=false;});
window.addEventListener('appinstalled',()=>{installEvent=null;const slot=document.querySelector('#push-install');if(slot)slot.hidden=true;});

window.createPushUI=function({state,api,esc,icon,toast}){
  const $=s=>document.querySelector(s);
  const supported=()=>'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const key=b64=>{const pad='='.repeat((4-b64.length%4)%4),raw=atob((b64+pad).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,c=>c.charCodeAt(0));};
  const btn=(action,label,id='',klass='')=>`<button type="button" class="btn ${klass}" data-action="push-${action}" data-id="${esc(id)}">${label}</button>`;
  let config=null;

  async function current(){
    if(!supported())return null;
    try{const reg=await navigator.serviceWorker.ready;return await reg.pushManager.getSubscription();}catch{return null;}
  }
  async function mount(){
    const box=$('#push-panel');if(!box)return;
    try{config=await api('/api/push/config');}catch(e){box.innerHTML='';return;}
    if(!$('#push-panel'))return;
    if(!config.enabled){box.innerHTML='<h3 class="modal-section-title">Notificaciones en este dispositivo</h3><p class="crm-hint">Las notificaciones push están desactivadas en este entorno.</p>';return;}
    const sub=await current(),mine=sub?config.devices.find(d=>d.endpoint===sub.endpoint):null,perm=supported()?Notification.permission:'unsupported';
    let body;
    if(!supported())body=`<p class="crm-hint">Este navegador no admite notificaciones push. En iPhone o iPad instálala primero: <strong>Compartir → Añadir a pantalla de inicio</strong> (iOS 16.4 o superior) y ábrela desde el icono.</p>`;
    else if(perm==='denied')body=`<p class="crm-hint">Bloqueaste las notificaciones de este sitio en el navegador. Actívalas en la configuración del sitio (candado junto a la dirección) y vuelve a esta pantalla.</p>`;
    else if(!mine)body=`<p class="crm-hint">Recibe en este dispositivo los avisos del equipo —chat asignado, menciones, objetivos de respuesta, pagos— aunque tengas el CRM cerrado. Sólo se manda lo que sigue sin leer unos segundos después.</p><div class="actions">${btn('enable',icon('bell')+' Activar en este dispositivo','','primary')}</div>`;
    else body=`<p class="crm-hint">Activadas en este dispositivo desde ${stamp(mine.createdAt)}${mine.lastOkAt?' · último envío correcto '+stamp(mine.lastOkAt):''}.</p>
      <div class="rcp-checks">${Object.entries(config.available).map(([g,label])=>`<label><input type="checkbox" data-action="push-group" data-id="${esc(g)}" ${config.groups.includes(g)?'checked':''}> ${esc(label)}</label>`).join('')}</div>
      <div class="actions">${btn('test',icon('send')+' Enviar prueba')}${btn('disable','Desactivar en este dispositivo')}</div>`;
    const others=config.devices.filter(d=>!mine||d.id!==mine.id);
    box.innerHTML=`<h3 class="modal-section-title">Notificaciones en este dispositivo</h3>${body}
      <div id="push-install" ${installEvent?'':'hidden'}><p class="crm-hint">Instala TEC Capital como app para abrirla desde el escritorio o la pantalla de inicio.</p><div class="actions">${btn('install',icon('download')+' Instalar app')}</div></div>
      ${others.length?`<p class="crm-hint">Otros dispositivos con avisos: ${others.map(d=>esc(d.host)).join(', ')}.</p><div class="actions">${others.map(d=>btn('remove','Quitar '+esc(d.host),d.id)).join('')}</div>`:''}`;
  }
  async function action(name,el){
    try{
      if(name==='push-enable'){
        if(!supported()){toast('Este navegador no admite notificaciones push.');return true;}
        const perm=await Notification.requestPermission();if(perm!=='granted'){toast('No se activaron: el navegador no dio permiso.');await mount();return true;}
        const reg=await navigator.serviceWorker.ready,old=await reg.pushManager.getSubscription();if(old)await old.unsubscribe();
        const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key(config.publicKey)});
        await api('/api/push/subscribe',{method:'POST',body:{subscription:sub.toJSON(),userAgent:navigator.userAgent}});
        toast('Notificaciones activadas en este dispositivo.');await mount();return true;
      }
      if(name==='push-disable'){const sub=await current();if(sub){await api('/api/push/unsubscribe',{method:'POST',body:{endpoint:sub.endpoint}});await sub.unsubscribe();}toast('Notificaciones desactivadas en este dispositivo.');await mount();return true;}
      if(name==='push-remove'){const d=config.devices.find(x=>x.id===el.dataset.id);if(d)await api('/api/push/unsubscribe',{method:'POST',body:{endpoint:d.endpoint}});await mount();return true;}
      if(name==='push-test'){const r=await api('/api/push/test',{method:'POST',body:{}});const ok=r.results.filter(x=>x.ok).length;toast(ok?'Prueba enviada: debería llegarte en unos segundos.':'No se pudo enviar la prueba: '+(r.results[0]?.error||'sin detalle'));await mount();return true;}
      if(name==='push-install'){if(installEvent){installEvent.prompt();await installEvent.userChoice;installEvent=null;await mount();}return true;}
      if(name==='push-group'){
        const groups=[...document.querySelectorAll('#push-panel [data-action=push-group]')].filter(i=>i.checked).map(i=>i.dataset.id);
        const r=await api('/api/push/prefs',{method:'PUT',body:{groups}});config.groups=r.groups;toast('Preferencias guardadas.');return true;
      }
    }catch(e){toast(e.message);await mount();return true;}
    return false;
  }
  return {mount,action};
};
