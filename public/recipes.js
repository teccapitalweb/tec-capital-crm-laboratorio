window.createRecipesUI=function({state,api,esc,icon,showModal,toast}){
  const $=s=>document.querySelector(s);
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const brandName=id=>state.brands.find(b=>b.id===id)?.name||'';
  const STATUS={draft:['Borrador',''],published:['Publicada','ok'],paused:['Pausada','warn']};
  const STEP={pending:'Programada',reserved:'En curso',completed:'Completada',cancelled:'Cancelada',failed:'Fallida'};
  const REASON={customer_replied:'El cliente respondió',conversation_changed:'Hubo un mensaje nuevo',conversation_closed:'La conversación se cerró',opportunity_closed:'La oportunidad se cerró',stage_changed:'Cambió la etapa',scope_changed:'Cambió el curso o la edición',recipe_paused:'Receta pausada',recipe_edited:'Receta editada',human_takeover:'Una persona tomó el control',material_unavailable:'La plantilla ya no está disponible',conversation_missing:'La conversación ya no existe',task_closed:'La tarea se cerró',task_rescheduled:'La tarea se reprogramó',attended:'Ya lo atendió una persona',contact_opted_out:'El contacto pidió no recibir mensajes',no_consent:'Falta consentimiento registrado',frequency_limit:'Se alcanzó el máximo de mensajes automáticos',manual:'Cancelada manualmente',conversation_action:'Acción en la conversación',owner_changed:'Cambió el responsable'};
  const STAGES={nuevo:'Nuevo interés',interesado:'Interesado',inscripcion:'Inscripción solicitada'};
  const CHECKS={conversation_open:'Conversación abierta',opportunity_open:'Oportunidad abierta',stage:'Etapa',scope:'Curso y edición',silence:'Cliente sin responder',recipe_published:'Receta publicada',no_human_control:'Sin control humano',task_open:'Tarea abierta',task_due:'Plazo de la tarea',waiting_human:'Esperando atención humana',consent:'Consentimiento del contacto',frequency:'Frecuencia de mensajes',material_available:'Plantilla disponible'};
  let overview=null,recipes=[],templates=[],draft=null,replySettings=[],replyProvider=null,channelSettings=[];
  const REPLY_MODES={off:'Apagado',suggest:'Sugerir al asesor',templates:'Responder con plantillas',autonomous:'Autónomo con IA'};
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const btn=(action,label,id='',extra='')=>`<button type="button" class="btn" data-action="rcp-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const note=copy=>`<p class="crm-hint">${copy}</p>`;
  const brandId=()=>state.brand==='all'?'':state.brand;
  const minutesText=m=>m>=1440&&m%1440===0?m/1440+(m===1440?' día':' días'):m>=60&&m%60===0?m/60+(m===60?' hora':' horas'):m+' min';
  const TRIGGERS={silence:['El cliente no responde','Minutos sin respuesta del cliente'],task_overdue:['Una tarea lleva vencida','Minutos de retraso de la tarea'],waiting_human:['Un chat espera a una persona','Minutos esperando atención humana']};
  const when=d=>d.trigger.type==='task_overdue'?`una tarea lleva ${minutesText(d.trigger.minutes)} vencida`:d.trigger.type==='waiting_human'?`un chat lleva ${minutesText(d.trigger.minutes)} esperando a una persona`:`el cliente no responde en ${minutesText(d.trigger.minutes)}`;
  const summary=d=>`Si ${when(d)}: ${d.actions.map(a=>({template:'enviar plantilla',task:'crear tarea',notify:'avisar al equipo'}[a.type])).join(', ')}`;

  async function load(){
    const [o,r,c,rs,ch]=await Promise.all([api('/api/automation'),api('/api/automation/recipes'+(brandId()?'?brand='+encodeURIComponent(brandId()):'')),api('/api/catalogue'),api('/api/replies/settings'),api('/api/channel/settings')]);
    overview=o;recipes=r.recipes;templates=c.templates.filter(t=>t.status==='approved');replySettings=rs.settings;replyProvider=rs.provider;channelSettings=ch.settings;
  }
  function status(){
    const rows=(brandId()?overview.brands.filter(b=>b.id===brandId()):overview.brands);
    return `<section class="crm-panel rcp-status"><div class="ops-card-top"><h2>Automatización</h2>${overview.global.paused?chip('Pausa global activa','warn'):chip('Sin pausa global','ok')}</div>${note('Todo empieza desactivado. Una receta sólo se programa si su marca tiene la automatización activa y no hay pausa global.')}<div class="rcp-brands">${rows.map(b=>`<div class="rcp-brand"><div><strong>${esc(b.name)}</strong><small>${b.enabled?'Activa':'Desactivada'}${Object.entries(b.counts).map(([k,n])=>` · ${n} ${esc((STEP[k]||k).toLowerCase())}${n===1?'':'s'}`).join('')}</small></div>${btn('brand-toggle',b.enabled?'Desactivar':'Activar',b.id,`data-revision="${b.revision}" data-enabled="${b.enabled?0:1}"`)}</div>`).join('')}</div>
      <h3 class="rcp-subtitle">Respuestas automáticas a clientes</h3>${note('Nivel por marca. «Responder con plantillas» es el comportamiento de siempre; «Sugerir» no envía nada y deja un borrador al asesor; «Autónomo» además usa el proveedor de IA ('+esc(replyProvider?.name==='claude'?'Claude · '+replyProvider.model:'simulado, sin costo')+') cuando la pregunta no se reconoce, siempre con conocimiento aprobado.')}${replyProvider?.usage?note('Uso de la IA este mes ('+esc(replyProvider.usage.month)+'): <strong>'+replyProvider.usage.calls+'</strong> llamada'+(replyProvider.usage.calls===1?'':'s')+(replyProvider.usage.callLimit?' de '+replyProvider.usage.callLimit:'')+' · '+replyProvider.usage.tokens.toLocaleString('es-MX')+' tokens'+(replyProvider.usage.blocked?' · <strong>tope alcanzado: responde una persona</strong>':'')+'. Los topes se fijan con AI_MONTHLY_CALL_LIMIT y AI_MONTHLY_TOKEN_LIMIT.'):''}<div class="rcp-brands">${replySettings.filter(s=>!brandId()||s.brand_id===brandId()).map(s=>`<div class="rcp-brand"><div><strong>${esc(s.brand_name)}</strong><small>Máximo sin reconocer antes de escalar: ${s.max_unknown}</small></div><select class="rcp-reply-mode" data-brand="${esc(s.brand_id)}" data-revision="${s.revision}" aria-label="Nivel de respuestas de ${esc(s.brand_name)}">${Object.entries(REPLY_MODES).map(([k,v])=>`<option value="${k}" ${s.mode===k?'selected':''}>${v}</option>`).join('')}</select></div>`).join('')}</div>
      <h3 class="rcp-subtitle">Canal simulado</h3>${note('Por marca y apagado por omisión. Al activarlo, los mensajes salientes pasan por enviado → entregado → leído (o fallido, con reintento), la ventana de servicio de 24 h exige plantillas aprobadas fuera de ella (72 h si el cliente llegó por anuncio) y la bienvenida automática lleva botones de respuesta rápida. Nada se conecta a Meta; sirve para ensayar el flujo real.')}<div class="rcp-brands">${channelSettings.filter(s=>!brandId()||s.brand_id===brandId()).map(s=>`<form class="rcp-brand rcp-channel" id="rcp-channel-${esc(s.brand_id)}" data-brand="${esc(s.brand_id)}"><input type="hidden" name="expectedRevision" value="${s.revision}"><div><strong>${esc(s.brand_name)}</strong><small>${s.enabled?'Activo':'Apagado'} · entrega ${s.delivery_delay_ms} ms · fallo ${s.failure_rate} %</small></div><div class="rcp-channel-fields"><label class="checkbox-field"><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> Activo</label><label class="checkbox-field"><input type="checkbox" name="enforceWindow" ${s.enforce_window?'checked':''}> Exigir ventana de 24 h</label><label class="field">Entrega · ms<input name="deliveryDelayMs" type="number" min="0" max="60000" step="100" value="${s.delivery_delay_ms}"></label><label class="field">Fallo · %<input name="failureRate" type="number" min="0" max="100" value="${s.failure_rate}"></label><button type="submit" class="btn">Guardar</button></div></form>`).join('')}</div><div class="actions">${btn('global-toggle',overview.global.paused?'Reanudar todo':'Pausar todo',String(overview.global.revision),`data-paused="${overview.global.paused?0:1}"`)}</div></section>`;
  }
  function card(r){
    const [label,kind]=STATUS[r.status];
    return `<article class="crm-panel rcp-card"><div class="ops-card-top"><strong>${esc(r.title)}</strong>${chip(label,kind)}</div><small>${esc(brandName(r.brand_id))} · versión ${r.revision}</small><p>${esc(summary(r.definition))}.</p><div class="actions">${btn('edit','Editar',r.id)}${btn('simulate','Simular',r.id)}${r.status==='published'?btn('pause','Pausar',r.id,`data-revision="${r.revision}"`):btn('publish','Publicar',r.id,`data-revision="${r.revision}"`)}${btn('runs','Ejecuciones',r.id)}${btn('history','Versiones',r.id)}</div></article>`;
  }
  function html(){
    if(!overview)return '<div class="loading-message">Cargando…</div>';
    return `${status()}<div class="crm-toolbar"><p>Seguimientos que se programan cuando un cliente deja de responder. Simula antes de publicar.</p>${btn('new',icon('plus')+' Nueva receta')}</div><div class="rcp-grid">${recipes.length?recipes.map(card).join(''):`<div class="crm-empty">${icon('workflow')}<h3>Sin recetas</h3><p>Crea la primera receta de seguimiento para esta marca.</p></div>`}</div>`;
  }

  function editor(r){
    const d=r?.definition,b=r?.brand_id||brandId()||state.brands[0]?.id,courses=state.courses.filter(c=>c.brand_id===b);
    draft={id:r?.id||'',brand:b};
    const a=type=>d?.actions.find(x=>x.type===type),stages=d?.conditions.stages||Object.keys(STAGES);
    const tpls=templates.filter(t=>t.brand_id===b);
    showModal(r?'Editar receta':'Nueva receta',`<form id="rcp-form" class="form-grid rcp-form"><input type="hidden" name="id" value="${esc(r?.id||'')}"><input type="hidden" name="expectedRevision" value="${r?.revision||''}">
      ${r?`<p class="crm-hint">${esc(brandName(b))}. Guardar la deja en borrador: vuelve a publicarla para aplicar los cambios.</p>`:`<label class="field">Marca<select name="brandId" id="rcp-brand">${state.brands.map(x=>`<option value="${x.id}" ${x.id===b?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>`}
      <label class="field">Nombre<input name="title" required maxlength="120" value="${esc(r?.title||'')}" placeholder="Seguimiento tras 1 día sin respuesta"></label>
      <label class="field">Cuándo se activa<select name="trigger" id="rcp-trigger">${Object.entries(TRIGGERS).map(([k,[label]])=>`<option value="${k}" ${(d?.trigger.type||'silence')===k?'selected':''}>${label}</option>`).join('')}</select></label>
      <label class="field"><span id="rcp-minutes-label">${TRIGGERS[d?.trigger.type||'silence'][1]}</span><input name="minutes" type="number" min="5" max="43200" required value="${d?.trigger.minutes||60}"></label>
      <fieldset class="rcp-fieldset"><legend>Condiciones</legend><label class="field">Curso<select name="courseId"><option value="">Cualquier curso</option>${courses.map(c=>`<option value="${c.id}" ${d?.conditions.courseId===c.id?'selected':''}>${esc(c.title)}</option>`).join('')}</select></label><label class="rcp-consent rcp-silence-only"><input type="checkbox" name="requireConsent" ${d?.conditions.requireConsent?'checked':''}> Enviar sólo a contactos con consentimiento registrado</label><div class="rcp-checks">${Object.entries(STAGES).map(([k,v])=>`<label><input type="checkbox" name="stage" value="${k}" ${stages.includes(k)?'checked':''}> ${v}</label>`).join('')}</div></fieldset>
      <fieldset class="rcp-fieldset"><legend>Acciones</legend>
        <label class="rcp-action rcp-silence-only"><input type="checkbox" name="useTemplate" ${a('template')?'checked':''}> Enviar plantilla aprobada<select name="templateId" id="rcp-template">${tpls.map(t=>`<option value="${t.id}" ${a('template')?.templateId===t.id?'selected':''}>${esc(t.title)}</option>`).join('')||'<option value="">Sin plantillas aprobadas</option>'}</select></label>
        <label class="rcp-action"><input type="checkbox" name="useTask" ${a('task')?'checked':''}> Crear tarea<input name="taskTitle" maxlength="180" value="${esc(a('task')?.title||'')}" placeholder="Llamar al interesado"><input name="taskDelay" type="number" min="1" max="525600" value="${a('task')?.delayMinutes||60}" aria-label="Plazo en minutos"></label>
        <label class="rcp-action"><input type="checkbox" name="useNotify" ${a('notify')?'checked':''}> Avisar al equipo<input name="notifyTitle" maxlength="120" value="${esc(a('notify')?.title||'')}" placeholder="Cliente sin respuesta"></label>
      </fieldset>
      ${note('La plantilla sólo se envía si nadie del equipo controla la conversación. La tarea y el aviso no cambian etapas ni confirman ventas.')}
      <div class="actions"><button class="btn primary" type="submit">Guardar borrador</button></div><div class="ops-feedback" role="status"></div></form>`);
    applyTrigger();
  }
  function definition(input,form){
    const f=new FormData(form),actions=[];
    const type=input.trigger||'silence';
    if(type==='silence'&&f.has('useTemplate'))actions.push({type:'template',templateId:input.templateId});
    if(f.has('useTask'))actions.push({type:'task',title:input.taskTitle,delayMinutes:Number(input.taskDelay)});
    if(f.has('useNotify'))actions.push({type:'notify',title:input.notifyTitle});
    const conditions={};if(type==='silence'&&f.has('requireConsent'))conditions.requireConsent=true;if(input.courseId)conditions.courseId=input.courseId;const stages=f.getAll('stage');if(stages.length&&stages.length<3)conditions.stages=stages;
    return {trigger:{type,minutes:Number(input.minutes)},conditions,actions};
  }

  async function simulateForm(id){
    const r=recipes.find(x=>x.id===id),list=state.conversations.filter(c=>c.brand_id===r.brand_id&&c.status!=='resolved').slice(0,60);
    showModal('Simular receta',`<form id="rcp-simulate-form" class="form-grid"><input type="hidden" name="id" value="${esc(id)}"><p><strong>${esc(r.title)}</strong></p>${note('La simulación no envía mensajes ni crea tareas, avisos o ejecuciones.')}<label class="field">Conversación<select name="conversationId" required>${list.map(c=>`<option value="${c.id}">${esc(c.customer_name)} · ${esc(c.course_title||'')}</option>`).join('')||'<option value="">Sin conversaciones abiertas en esta marca</option>'}</select></label><div class="actions"><button class="btn primary" type="submit" ${list.length?'':'disabled'}>Simular</button></div><div class="rcp-result"></div></form>`);
  }
  function simulationView(s){
    return `<div class="rcp-sim"><div class="ops-card-top">${s.matches?chip('Se ejecutaría','ok'):chip('No se ejecutaría','warn')}${s.runAt?`<small>${s.runAt<Date.now()?'Ya habría vencido: ':'Programada para '}${stamp(s.runAt)}</small>`:''}</div>
      ${s.reason?note('Motivo: '+esc(REASON[s.reason]||s.reason)):''}
      <ul class="rcp-checklist">${s.checks.map(c=>`<li class="${c.ok?'ok':'no'}"><span>${c.ok?'✓':'✕'}</span><div><strong>${esc(CHECKS[c.check]||c.check)}</strong><small>${esc(c.detail)}</small></div></li>`).join('')}</ul>
      <h3>Acciones</h3>${s.actions.map(a=>a.type==='template'?`<div class="rcp-action-preview"><strong>Mensaje al cliente</strong>${a.unavailable?`<p>${esc(a.unavailable)}</p>`:`<pre class="cat-preview-copy">${esc(a.text)}</pre>`}</div>`:a.type==='task'?`<div class="rcp-action-preview"><strong>Tarea</strong><p>${esc(a.title)} · vence ${minutesText(a.dueInMinutes)} después</p></div>`:`<div class="rcp-action-preview"><strong>Aviso interno</strong><p>${esc(a.title)}</p></div>`).join('')}</div>`;
  }
  async function runs(id){
    const r=recipes.find(x=>x.id===id),data=(await api('/api/automation/recipes/'+id+'/runs')).runs;
    showModal('Ejecuciones · '+r.title,data.length?data.map(x=>`<article class="ops-version"><strong>${esc(STEP[x.state]||x.state)}${x.cancel_reason?' · '+esc(REASON[x.cancel_reason]||x.cancel_reason):''}</strong><small>Versión ${x.recipe_revision} · programada ${stamp(x.scheduled_at)} · ${x.attempts} intento${x.attempts===1?'':'s'}</small>${x.error?`<small>${esc(x.error)}</small>`:''}</article>`).join(''):note('Todavía no hay ejecuciones. Aparecerán cuando un cliente deje de responder.'));
  }
  async function history(id){
    const v=(await api('/api/automation/recipes/'+id+'/history')).versions;
    showModal('Versiones',v.slice().reverse().map(x=>`<article class="ops-version"><strong>v${x.revision} · ${esc(x.snapshot.title)} · ${STATUS[x.snapshot.status][0]}</strong><small>${stamp(x.created_at)} · ${esc(summary(x.snapshot.definition))}</small></article>`).join(''));
  }

  async function action(name,el){
    const id=el.dataset.id;
    if(name==='rcp-new')return editor(null);
    if(name==='rcp-edit')return editor(recipes.find(r=>r.id===id));
    if(name==='rcp-simulate')return simulateForm(id);
    if(name==='rcp-runs')return runs(id);
    if(name==='rcp-history')return history(id);
    if(name==='rcp-publish'||name==='rcp-pause'){await api('/api/automation/recipes/'+id+'/'+name.slice(4),{method:'POST',body:{expectedRevision:Number(el.dataset.revision)}});toast(name==='rcp-publish'?'Receta publicada':'Receta pausada');return 'reload';}
    if(name==='rcp-brand-toggle'){await api('/api/automation/brands/'+id,{method:'PATCH',body:{enabled:el.dataset.enabled==='1',expectedRevision:Number(el.dataset.revision)}});toast(el.dataset.enabled==='1'?'Automatización activada para la marca':'Automatización desactivada');return 'reload';}
    if(name==='rcp-global-toggle'){await api('/api/automation/global',{method:'PATCH',body:{paused:el.dataset.paused==='1',expectedRevision:Number(id)}});toast(el.dataset.paused==='1'?'Automatización pausada en toda la empresa':'Automatización reanudada');return 'reload';}
    return false;
  }
  function applyTrigger(){
    const sel=$('#rcp-trigger');if(!sel)return;
    document.querySelectorAll('#rcp-form .rcp-silence-only').forEach(e=>{e.hidden=sel.value!=='silence';});
    const label=$('#rcp-minutes-label');if(label)label.textContent=TRIGGERS[sel.value][1];
  }
  async function change(el){
    if(el.classList?.contains('rcp-reply-mode')){try{const mode=el.value;await api('/api/replies/brands/'+el.dataset.brand,{method:'PATCH',body:{mode,providerEnabled:mode==='autonomous',expectedRevision:Number(el.dataset.revision)}});toast('Nivel de respuestas actualizado');}catch(e){toast(e.message);}await load();return true;}
    if(el.id==='rcp-trigger'){applyTrigger();return true;}
    if(el.id!=='rcp-brand')return false;
    const b=el.value,courses=state.courses.filter(c=>c.brand_id===b);
    $('#rcp-template').innerHTML=templates.filter(t=>t.brand_id===b).map(t=>`<option value="${t.id}">${esc(t.title)}</option>`).join('')||'<option value="">Sin plantillas aprobadas</option>';
    const course=$('#rcp-form [name=courseId]');course.innerHTML='<option value="">Cualquier curso</option>'+courses.map(c=>`<option value="${c.id}">${esc(c.title)}</option>`).join('');
    return true;
  }
  async function submit(form,input){
    const id=form.getAttribute('id');
    try{
      if(id?.startsWith('rcp-channel-')){
        const fd=new FormData(form);await api('/api/channel/brands/'+form.dataset.brand,{method:'PATCH',body:{enabled:fd.has('enabled'),enforceWindow:fd.has('enforceWindow'),deliveryDelayMs:Number(input.deliveryDelayMs),failureRate:Number(input.failureRate),expectedRevision:Number(input.expectedRevision)}});
        toast('Canal simulado actualizado');return 'reload';
      }
      if(id==='rcp-form'){
        const body={title:input.title,definition:definition(input,form)};
        if(input.id)await api('/api/automation/recipes/'+input.id,{method:'PATCH',body:{...body,expectedRevision:Number(input.expectedRevision)}});
        else await api('/api/automation/recipes',{method:'POST',body:{...body,brandId:input.brandId}});
        $('#modal').close();toast('Borrador guardado. Simula y publica cuando esté listo.');return 'reload';
      }
      if(id==='rcp-simulate-form'){
        const r=await api('/api/automation/recipes/'+input.id+'/simulate',{method:'POST',body:{conversationId:input.conversationId}});
        form.querySelector('.rcp-result').innerHTML=simulationView(r.simulation);return true;
      }
    }catch(e){const t=form.querySelector('.ops-feedback')||form.querySelector('.rcp-result');if(t)t.textContent=e.message;toast(e.message);return true;}
    return false;
  }
  return {load,html,action,change,submit};
};
