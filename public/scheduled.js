// Mensajes programados (docs/PLAN_MENSAJES_PROGRAMADOS.md): botón «Programar» junto a Enviar y, arriba del compositor, la lista de lo que está
// por salir en este chat. Sólo para el equipo. El mensaje sale solo a la hora elegida, con las mismas reglas que un envío manual; aquí se
// elige la hora, se edita, se cancela o se envía ya. Los formularios no usan <form> (se leen al pulsar) y las acciones llevan el prefijo «sch-».
window.createScheduledUI=function({state,api,esc,icon,toast}){
  const $=s=>document.querySelector(s);
  const cache=new Map();            // conversationId -> {items, at}
  let panel=null;                   // {id, editing: item|null, clientRef, text, when, cancelOnReply, busy}
  const when=t=>new Date(t).toLocaleString('es-MX',{weekday:'short',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'});
  const local=t=>new Date(t-new Date(t).getTimezoneOffset()*60000).toISOString().slice(0,16);   // valor para <input type=datetime-local>
  const nextAt=(days,h)=>{const d=new Date();d.setDate(d.getDate()+days);d.setHours(h,0,0,0);return d.getTime();};
  const monday=()=>{const d=new Date();const add=((8-d.getDay())%7)||7;return nextAt(add,9);};
  const quick=()=>[['En 1 hora',Date.now()+3600e3],['Mañana 9:00',nextAt(1,9)],['Lunes 9:00',monday()],['En 3 días',nextAt(3,9)]];
  const label={sent:'Enviado',cancelled:'No se envió',failed:'No se envió',pending:'Pendiente'};

  // «Qué enviar»: un texto escrito, o un material del catálogo (temario, precio, fechas, flyer, plantilla aprobada). Un material se ARMA al enviarse con los datos
  // vigentes del catálogo; aquí sólo se muestra cómo se vería hoy.
  const KIND_LABEL={syllabus:'Temario',price:'Precio y promoción',schedule:'Fechas y docente',flyer:'Flyer de la edición'};
  function whatOptions(){
    const m=panel.mats,opt=(v,l)=>`<option value="${esc(v)}" ${panel.what===v?'selected':''}>${esc(l)}</option>`;
    return opt('text','Un mensaje escrito por mí')+`<optgroup label="Del catálogo (se arma al enviar)">${Object.entries(KIND_LABEL).map(([k,l])=>opt('kind:'+k,l)).join('')}</optgroup>`
      +(m?.templates?.length?`<optgroup label="Plantillas aprobadas">${m.templates.map(t=>opt('template:'+t.id,t.title)).join('')}</optgroup>`:'')
      +(m?.flyers?.filter(f=>f.availability==='Listo para enviar').length?`<optgroup label="Flyers listos">${m.flyers.filter(f=>f.availability==='Listo para enviar').map(f=>opt('flyer:'+f.id,f.title||'Flyer')).join('')}</optgroup>`:'');
  }
  function materialFields(){
    const p=panel;
    if(p.editing?.material)return `<div class="sch-field"><span>Material</span><div class="sch-material"><strong>${icon('paperclip')} ${esc(p.editing.material.label)}</strong><p class="sch-preview">${esc(p.editing.text)}</p><small>Se arma al enviarse con los datos vigentes del catálogo. Para cambiarlo, cancela este envío y programa otro.</small></div></div>`;
    const picker=`<label class="sch-field">¿Qué enviar?<select id="sch-what">${whatOptions()}</select></label>`;
    if(p.what==='text')return picker+`<label class="sch-field">Mensaje<textarea id="sch-text" rows="3" maxlength="5000" aria-label="Mensaje a programar">${esc(p.text)}</textarea></label>`;
    return picker+`<div class="sch-material"><strong>${icon('paperclip')} ${esc(p.materialLabel||'Material')}</strong>${p.preview?`<p class="sch-preview">${esc(p.preview)}</p>`:`<p class="sch-preview">${p.previewError?esc(p.previewError):'Cargando vista previa…'}</p>`}<small>Así se vería hoy. Se arma <b>al momento de enviarse</b>: si el precio, la fecha o el temario cambian antes, sale lo vigente. Si la plantilla o el flyer dejan de estar aprobados, no sale y se te avisa.</small></div>`;
  }
  async function loadMats(id){try{const r=await api('/api/conversations/'+id+'/materials');if(panel&&panel.id===id){panel.mats={templates:r.templates||[],flyers:r.flyers||[]};paint(id);}}catch{}}
  async function preview(id){
    const p=panel;if(!p||p.what==='text')return;const [kind,ref]=p.what.split(':'),pick=kind==='kind'?{kind:ref}:kind==='template'?{templateId:ref}:{flyerId:ref};
    p.preview='';p.previewError='';p.materialLabel=kind==='kind'?KIND_LABEL[ref]:(kind==='template'?p.mats?.templates.find(t=>t.id===ref)?.title:p.mats?.flyers.find(f=>f.id===ref)?.title)||'Material';paint(id);
    try{const r=await api('/api/conversations/'+id+'/materials/preview',{method:'POST',body:pick});if(panel===p){p.preview=r.text||'';p.pick=pick;paint(id);}}
    catch(e){if(panel===p){p.previewError=e.message;p.pick=null;paint(id);}}
  }
  function paint(id){
    const box=$('#conv-scheduled');if(!box||box.dataset.id!==id)return;
    const items=cache.get(id)?.items||[],pending=items.filter(i=>i.state==='pending'),past=items.filter(i=>i.state!=='pending').sort((a,b)=>(b.sentAt||b.sendAt)-(a.sentAt||a.sendAt)).slice(0,2);
    const row=i=>`<div class="sch-row${i.state==='pending'?'':' sch-past sch-'+i.state}">
      <span class="sch-when">${icon(i.state==='pending'?'clock':i.state==='sent'?'check':'ban')}<b>${i.state==='pending'?'Sale '+esc(when(i.sendAt)):esc(label[i.state])}</b>${i.mine?'':`<small> · ${esc(i.authorName||'el equipo')}</small>`}</span>
      <span class="sch-text" title="${esc(i.text)}">${i.material?`<b class="sch-mat">${icon('paperclip')} ${esc(i.material.label)}</b> `:''}${esc(i.text)}</span>
      ${i.state==='pending'?`<span class="sch-actions">${i.cancelOnReply?'<small class="sch-note">se cancela si responde</small>':''}<button type="button" class="btn" data-action="sch-edit" data-id="${esc(i.id)}">Editar</button><button type="button" class="btn" data-action="sch-now" data-id="${esc(i.id)}">Enviar ahora</button><button type="button" class="btn" data-action="sch-cancel" data-id="${esc(i.id)}">Cancelar</button></span>`:(i.reason?`<small class="sch-reason">${esc(i.reason)}</small>`:'')}
    </div>`;
    const form=panel&&panel.id===id?`<div class="sch-panel" role="group" aria-label="${panel.editing?'Editar mensaje programado':'Programar mensaje'}">
      ${materialFields()}
      <div class="sch-field"><span>¿Cuándo?</span><div class="sch-quick">${quick().map(([t,v])=>`<button type="button" class="btn" data-action="sch-pick" data-at="${v}">${esc(t)}</button>`).join('')}</div>
        <input type="datetime-local" id="sch-when" aria-label="Fecha y hora de envío" value="${esc(panel.when)}" min="${local(Date.now()+60e3)}"></div>
      <label class="sch-check"><input type="checkbox" id="sch-cor" ${panel.cancelOnReply?'checked':''}> No enviar si el cliente responde antes</label>
      <div class="sch-foot"><small>Sale a tu nombre. Se respetan las reglas del canal; si no puede salir, aquí queda el motivo.</small><span><button type="button" class="btn" data-action="sch-close">Cerrar</button><button type="button" class="btn primary" data-action="sch-save" ${panel.busy?'disabled':''}>${panel.busy?'Guardando…':panel.editing?'Guardar cambios':'Programar'}</button></span></div>
    </div>`:'';
    box.innerHTML=(pending.length||past.length?`<div class="sch-list" aria-label="Mensajes programados en esta conversación">${pending.map(row).join('')}${past.map(row).join('')}</div>`:'')+form;
    window.lucide?.createIcons({attrs:{'stroke-width':1.7}});
  }
  async function load(id){
    try{const r=await api('/api/conversations/'+id+'/scheduled');cache.set(id,{items:r.items,at:Date.now()});}catch{if(!cache.has(id))cache.set(id,{items:[],at:Date.now()});}
    paint(id);
  }
  function mount(c){const box=$('#conv-scheduled');if(!box)return;box.dataset.id=c.id;if(cache.has(c.id))paint(c.id);load(c.id);}
  function open(id,editing=null){
    const draft=state.drafts?.[id]||'';
    panel={id,editing,clientRef:crypto.randomUUID(),text:editing?editing.text:draft,when:editing?local(editing.sendAt):'',cancelOnReply:editing?editing.cancelOnReply:true,busy:false,what:'text',mats:null,preview:'',previewError:'',pick:null,materialLabel:''};
    paint(id);$('#sch-text')?.focus();if(!editing?.material)loadMats(id);
  }
  const read=()=>{if(!panel)return;const t=$('#sch-text'),w=$('#sch-when'),c=$('#sch-cor');if(t)panel.text=t.value;if(w)panel.when=w.value;if(c)panel.cancelOnReply=c.checked;};
  async function save(){
    read();const id=panel.id,at=panel.when?new Date(panel.when).getTime():NaN;
    const isMat=panel.what!=='text'&&!panel.editing?.material;
    if(isMat&&!panel.pick)return toast(panel.previewError||'Espera la vista previa del material o elige otro.');
    if(!isMat&&!panel.editing?.material&&!panel.text.trim())return toast('Escribe el mensaje que quieres programar.');
    if(!Number.isFinite(at))return toast('Elige la fecha y la hora.');
    panel.busy=true;paint(id);
    try{
      if(panel.editing)await api('/api/scheduled/'+panel.editing.id,{method:'PATCH',body:{...(panel.editing.material?{}:{text:panel.text}),sendAt:at,cancelOnReply:panel.cancelOnReply,expectedRevision:panel.editing.revision}});
      else{await api(sched(id),{method:'POST',body:{...(isMat?{material:panel.pick}:{text:panel.text}),sendAt:at,cancelOnReply:panel.cancelOnReply,clientRef:panel.clientRef}});if(!isMat&&state.drafts&&state.drafts[id]!==undefined){state.drafts[id]='';try{localStorage.removeItem('tc-draft-'+state.user.id+'-'+id);}catch{}const ta=$('#message-input');if(ta)ta.value='';}}
      toast(panel.editing?'Cambios guardados.':'Mensaje programado para '+when(at)+'.');panel=null;await load(id);
    }catch(e){toast(e.message);if(panel){panel.busy=false;paint(id);}}
  }
  const sched=id=>'/api/conversations/'+id+'/scheduled';
  async function action(name,el){
    const id=state.selected;
    if(name==='sch-open'){if(panel&&panel.id===id){panel=null;paint(id);}else open(id);return true;}
    if(name==='sch-close'){panel=null;paint(id);return true;}
    if(name==='sch-pick'){read();panel.when=local(Number(el.dataset.at));paint(id);return true;}
    if(name==='sch-what'){read();panel.what=el.value;if(panel.what==='text'){paint(id);}else await preview(id);return true;}
    if(name==='sch-save'){await save();return true;}
    const item=(cache.get(id)?.items||[]).find(i=>i.id===el.dataset.id);
    if(name==='sch-edit'){if(item)open(id,item);return true;}
    try{
      if(name==='sch-cancel'){await api('/api/scheduled/'+el.dataset.id+'/cancel',{method:'POST',body:{}});toast('Envío cancelado.');}
      else if(name==='sch-now'){const r=await api('/api/scheduled/'+el.dataset.id+'/send-now',{method:'POST',body:{}});toast(r.outcome==='sent'?'Mensaje enviado.':(r.item.reason||'No se pudo enviar.'));}
      else return false;
    }catch(e){toast(e.message);}
    await load(id);return true;
  }
  // Mi día: lo que tengo por salir, de todas mis marcas (sólo si hay algo). Cada fila abre el chat.
  const dayRow=i=>`<button type="button" class="attention-row sch-day-row" data-action="crm-chat" data-id="${esc(i.conversationId)}"><span class="avatar">${esc((i.customerName||'?').slice(0,2).toUpperCase())}</span><span><strong>${esc(i.customerName||'Cliente')}</strong><small>${esc(i.brandName||'')} · sale ${esc(when(i.sendAt))}</small><small class="sch-day-text">${esc(i.text)}</small></span></button>`;
  async function mountDay(){
    const box=$('#day-scheduled');if(!box)return;
    try{
      const r=await api('/api/scheduled');if(!document.body.contains(box))return;
      if(!r.items.length){box.hidden=true;box.innerHTML='';return;}
      box.hidden=false;
      box.innerHTML=`<div class="panel-title"><h2>Mensajes programados</h2><small class="sch-day-count">${r.items.length} por salir</small></div>${r.items.slice(0,6).map(dayRow).join('')}${r.items.length>6?`<p class="sch-day-more">y ${r.items.length-6} más en sus chats</p>`:''}`;
    }catch{box.hidden=true;}
  }
  // El selector «¿Qué enviar?» no es un clic: se atiende su cambio.
  document.addEventListener('change',e=>{if(e.target.id==='sch-what'&&panel)action('sch-what',e.target);});
  return {mount,mountDay,action};
};
