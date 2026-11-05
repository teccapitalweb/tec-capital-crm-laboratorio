// Chat más rápido (docs/PLAN_CHAT_RAPIDO.md): respuestas rápidas con «/» en el compositor, su administración en Mi configuración y
// «Recordarme» desde el chat. Insertar una respuesta NO envía nada: la persona la revisa y la envía como siempre.
window.createQuickRepliesUI=function({state,api,esc,icon,showModal,toast}){
  if(window.__qrUI)return window.__qrUI;
  const $=s=>document.querySelector(s);
  const TOKEN=/(^|\s)\/([\p{L}\p{N}_-]*)$/u;
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  let data=null,loading=null,menu={open:false,items:[],index:0},suppress=false;

  async function ensure(force=false){
    if(data&&!force)return data;
    loading??=api('/api/quick-replies').then(r=>{data=r;return r;}).finally(()=>{loading=null;});
    return loading;
  }
  const currentConversation=()=>state.conversations.find(c=>c.id===state.selected)||null;
  function candidates(query){
    const q=query.toLowerCase(),brand=currentConversation()?.brand_id;
    const rows=(data?.quickReplies||[]).filter(r=>r.scope==='personal'||r.brandId===brand).filter(r=>!q||r.shortcut.includes(q)||r.title.toLowerCase().includes(q));
    return rows.sort((a,b)=>(b.shortcut.startsWith(q)-a.shortcut.startsWith(q))||(b.uses-a.uses)||a.shortcut.localeCompare(b.shortcut)).slice(0,8);
  }

  // ---- menú «/» sobre el compositor
  function close(){menu={open:false,items:[],index:0};$('#slash-menu')?.remove();}
  function draw(query){
    const form=$('#message-form');if(!form)return;
    $('#slash-menu')?.remove();
    const body=menu.items.length
      ?menu.items.map((r,i)=>`<button type="button" class="slash-item ${i===menu.index?'active':''}" role="option" aria-selected="${i===menu.index}" data-qr="${esc(r.id)}"><span class="slash-key">/${esc(r.shortcut)}</span><span class="slash-copy"><strong>${esc(r.title)}</strong><small>${esc(r.body.replace(/\s+/g,' ').slice(0,90))}</small></span>${r.scope==='brand'?chip('Marca'):''}</button>`).join('')
      :`<div class="slash-empty">${data?.quickReplies?.length?'Ninguna respuesta coincide con «/'+esc(query)+'».':'Todavía no tienes respuestas rápidas.'} Créalas en <strong>Mi configuración → Respuestas rápidas</strong>. <button type="button" class="btn" data-action="qr-go-settings">${data?.quickReplies?.length?'Crear otra respuesta':'Crear mi primera respuesta'}</button></div>`;
    form.insertAdjacentHTML('afterbegin',`<div id="slash-menu" class="slash-menu" role="listbox" aria-label="Respuestas rápidas">${body}</div>`);
  }
  async function update(textarea){
    if(suppress){suppress=false;return;}
    const before=textarea.value.slice(0,textarea.selectionStart),m=before.match(TOKEN);
    if(!m){if(menu.open)close();return;}
    try{await ensure();}catch{return;}
    if(!document.body.contains(textarea))return;
    const again=textarea.value.slice(0,textarea.selectionStart).match(TOKEN);if(!again){close();return;}
    menu={open:true,items:candidates(again[2]),index:0};draw(again[2]);
  }
  async function pick(id){
    const textarea=$('#message-input'),c=currentConversation();if(!textarea||!c)return;
    try{
      const r=await api('/api/quick-replies/'+id+'/render',{method:'POST',body:{conversationId:c.id}});
      const caret=textarea.selectionStart,before=textarea.value.slice(0,caret),m=before.match(TOKEN),start=m?before.length-m[2].length-1:caret;
      textarea.value=textarea.value.slice(0,start)+r.text+textarea.value.slice(caret);
      const end=start+r.text.length;textarea.setSelectionRange(end,end);textarea.focus();
      close();suppress=true;textarea.dispatchEvent(new Event('input',{bubbles:true}));
      if(data){const q=data.quickReplies.find(x=>x.id===id);if(q)q.uses++;}
    }catch(e){toast(e.message);}
  }
  document.addEventListener('input',e=>{if(e.target.id==='message-input')update(e.target);});
  document.addEventListener('keydown',e=>{
    if(!menu.open||e.target.id!=='message-input')return;
    if(e.key==='Escape'){e.preventDefault();close();return;}
    if(!menu.items.length)return;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();menu.index=(menu.index+(e.key==='ArrowDown'?1:menu.items.length-1))%menu.items.length;document.querySelectorAll('#slash-menu .slash-item').forEach((el,i)=>{el.classList.toggle('active',i===menu.index);el.setAttribute('aria-selected',i===menu.index);});return;}
    if((e.key==='Enter'&&!e.shiftKey&&!e.isComposing)||e.key==='Tab'){e.preventDefault();e.stopImmediatePropagation();pick(menu.items[menu.index].id);}
  },true);
  document.addEventListener('mousedown',e=>{if(e.target.closest('.slash-item'))e.preventDefault();});   // no quita el foco al compositor
  document.addEventListener('click',e=>{const item=e.target.closest('.slash-item');if(item){pick(item.dataset.qr);return;}if(menu.open&&!e.target.closest('#slash-menu,#message-input'))close();});

  // ---- «Recordarme»: un seguimiento en la oportunidad de la conversación, en un clic
  function remind(){
    const c=currentConversation();if(!c)return;
    if(!c.opportunity_id){toast('Esta conversación todavía no tiene oportunidad para dar seguimiento.');return;}
    const at=(days,h,m=0)=>{const d=new Date();d.setDate(d.getDate()+days);d.setHours(h,m,0,0);return d.getTime();},now=Date.now();
    const options=[['En 1 hora',now+3600000],...(at(0,18)>now+900000?[['Hoy a las 6 p. m.',at(0,18)]]:[]),['Mañana a las 9 a. m.',at(1,9)],['En 3 días, 9 a. m.',at(3,9)],['En 1 semana, 9 a. m.',at(7,9)]];
    showModal('Recordarme dar seguimiento',`<p class="crm-hint">Crea una tarea en la oportunidad de <strong>${esc(c.customer_name||'este cliente')}</strong> y te avisa en Mi día cuando llegue la hora.</p>
      <label class="field">Nota (opcional)<input id="qr-remind-note" maxlength="100" placeholder="Por ejemplo: preguntar si ya pagó"></label>
      <div class="qr-remind">${options.map(([label,t])=>`<button type="button" class="btn" data-action="qr-remind-at" data-at="${t}">${esc(label)}</button>`).join('')}</div>`);
  }
  async function remindAt(el){
    const c=currentConversation(),note=($('#qr-remind-note')?.value||'').trim().slice(0,100);if(!c)return;
    const title=('Retomar con '+(c.customer_name||'el cliente')+' · '+(c.course_title||'')+(note?' — '+note:'')).slice(0,180);
    await api('/api/crm/tasks',{method:'POST',body:{opportunityId:c.opportunity_id,title,dueAt:Number(el.dataset.at)}});
    $('#modal')?.close();toast('Listo: te lo recordaré en Mi día.');
  }

  // ---- administración en Mi configuración
  async function mount(){
    const box=$('#qr-panel');if(!box)return;
    try{await ensure(true);}catch{box.innerHTML='';return;}
    if(!$('#qr-panel'))return;
    const row=r=>`<div class="qr-row"><span class="slash-key">/${esc(r.shortcut)}</span><div class="qr-copy"><strong>${esc(r.title)}</strong><small>${esc(r.body.replace(/\s+/g,' ').slice(0,140))}</small><small>${r.scope==='brand'?'Compartida · '+esc(r.brandName):'Personal'} · insertada ${r.uses} ${r.uses===1?'vez':'veces'}</small></div>${r.editable?`<div class="qr-actions"><button type="button" class="btn" data-action="qr-edit" data-id="${esc(r.id)}">Editar</button><button type="button" class="btn" data-action="qr-archive" data-id="${esc(r.id)}">Archivar</button></div>`:''}</div>`;
    box.innerHTML=`<h3 class="modal-section-title">Respuestas rápidas</h3><p class="crm-hint">En el chat escribe <strong>/</strong> y el atajo para insertar el texto, con el nombre del cliente y el curso ya puestos. No se envía hasta que tú lo envíes. Para precios, fechas y cupos usa las plantillas aprobadas (Precio, Temario…): ahí sí salen del catálogo vigente.</p>
      <div class="qr-list">${data.quickReplies.map(row).join('')||'<p class="crm-hint">Todavía no hay respuestas rápidas.</p>'}</div><div class="actions"><button type="button" class="btn primary" data-action="qr-new">${icon('plus')} Nueva respuesta rápida</button></div>`;
  }
  function form(r){
    const vars=Object.entries(data.variables);
    showModal(r?'Editar respuesta rápida':'Nueva respuesta rápida',`<form id="qr-form" class="form-grid"><input type="hidden" name="id" value="${esc(r?.id||'')}"><input type="hidden" name="expectedRevision" value="${r?.revision||''}">
      ${r?'':`<label class="field">Quién la usa<select name="scope" id="qr-scope"><option value="personal">Sólo yo</option>${data.canShare?'<option value="brand">Todo el equipo de una marca</option>':''}</select></label>
        <label class="field" id="qr-brand-field" hidden>Marca<select name="brandId">${data.brands.map(b=>`<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></label>`}
      <label class="field">Atajo (lo que escribes después de «/»)<input name="shortcut" required maxlength="20" autocapitalize="none" spellcheck="false" value="${esc(r?.shortcut||'')}" placeholder="gracias"></label>
      <label class="field">Nombre<input name="title" required maxlength="60" value="${esc(r?.title||'')}" placeholder="Agradecer y ofrecer ayuda"></label>
      <label class="field">Texto<textarea name="body" id="qr-body" required rows="5" maxlength="1500" placeholder="Hola {{nombre}}, gracias por tu interés en {{curso}}. Soy {{asesor}} de {{marca}}.">${esc(r?.body||'')}</textarea></label>
      <div class="qr-vars" aria-label="Variables">${vars.map(([k,label])=>`<button type="button" class="btn" data-action="qr-var" data-id="${esc(k)}" title="${esc(label)}">{{${esc(k)}}}</button>`).join('')}</div>
      <div class="actions"><button class="btn primary" type="submit">${r?'Guardar cambios':'Guardar'}</button></div><div class="ops-feedback" role="status"></div></form>`);
  }
  async function action(name,el){
    try{
      if(name==='qr-open'){
        const t=$('#message-input');if(!t)return true;t.focus();const caret=t.selectionStart,before=t.value.slice(0,caret);
        if(!TOKEN.test(before)){const lead=before&&!/\s$/.test(before)?' /':'/';t.value=before+lead+t.value.slice(caret);const pos=before.length+lead.length;t.setSelectionRange(pos,pos);}
        t.dispatchEvent(new Event('input',{bubbles:true}));return true;
      }
      if(name==='qr-go-settings'){close();document.querySelector('[data-view="settings"]')?.click();for(let i=0;i<30&&!document.querySelector('[data-action="qr-new"]');i++)await new Promise(r=>setTimeout(r,100));document.querySelector('[data-action="qr-new"]')?.click();return true;}
      if(name==='qr-remind'){remind();return true;}
      if(name==='qr-remind-at'){await remindAt(el);return true;}
      if(name==='qr-new'){await ensure();form(null);const s=$('#qr-scope');if(s)s.addEventListener('change',()=>{$('#qr-brand-field').hidden=s.value!=='brand';});return true;}
      if(name==='qr-edit'){await ensure();form(data.quickReplies.find(x=>x.id===el.dataset.id));return true;}
      if(name==='qr-archive'){if(!confirm('¿Archivar esta respuesta rápida? Su atajo queda libre.'))return true;await api('/api/quick-replies/'+el.dataset.id,{method:'DELETE'});toast('Respuesta archivada.');await mount();return true;}
      if(name==='qr-var'){const t=$('#qr-body');if(t){const s=t.selectionStart,v='{{'+el.dataset.id+'}}';t.value=t.value.slice(0,s)+v+t.value.slice(t.selectionEnd);t.setSelectionRange(s+v.length,s+v.length);t.focus();}return true;}
    }catch(e){toast(e.message);return true;}
    return false;
  }
  async function submit(formEl){
    if(formEl.getAttribute('id')!=='qr-form')return false;
    const f=new FormData(formEl),id=f.get('id'),feedback=m=>{const x=formEl.querySelector('.ops-feedback');if(x)x.textContent=m;};
    const payload={shortcut:f.get('shortcut'),title:f.get('title'),body:f.get('body')};
    try{
      if(id)await api('/api/quick-replies/'+id,{method:'PATCH',body:{...payload,expectedRevision:Number(f.get('expectedRevision'))}});
      else await api('/api/quick-replies',{method:'POST',body:{...payload,scope:f.get('scope')||'personal',brandId:f.get('brandId')||undefined,clientRef:crypto.randomUUID()}});
      $('#modal')?.close();toast('Respuesta rápida guardada.');await mount();
    }catch(e){feedback(e.message);toast(e.message);}
    return true;
  }
  const ui={mount,action,submit,reload:()=>ensure(true)};window.__qrUI=ui;return ui;
};
