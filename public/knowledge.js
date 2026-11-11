// Conocimiento aprobado (pestaña del catálogo) y asistente de respuestas en el chat (sugerencia + «por qué respondió»).
window.createKnowledgeUI=function({state,api,esc,icon,showModal,toast,reload}){
  const $=s=>document.querySelector(s),admin=()=>state.user?.role==='admin';
  const STATES={draft:'Borrador',approved:'Aprobada',archived:'Archivada'};
  const TOPICS={certificate:'Certificado',payment:'Pagos',requirements:'Requisitos',modality:'Modalidad',recording:'Grabaciones',duration:'Duración',general:'General'};
  const brandName=id=>state.brands.find(b=>b.id===id)?.name||'';
  const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  function filter(entries,query,status){const q=norm(query);return (entries||[]).filter(e=>(state.brand==='all'||e.brand_id===state.brand)&&(!status||e.status===status)&&(!q||norm(e.question+' '+e.answer+' '+e.variants.join(' ')+' '+e.topic).includes(q)));}
  function render(rows){
    if(!rows.length)return '';
    return `<div class="cat-template-grid">${rows.map(e=>`<article class="cat-template kn-card"><div class="cat-card-heading"><span>${icon('message-circle-question')} ${esc(TOPICS[e.topic]||e.topic)}</span>${e.status==='approved'?'<span class="cat-badge ok">Aprobada</span>':e.status==='draft'?(e.created_by===null?'<span class="cat-badge kn-ai">Borrador de la IA</span>':'<span class="cat-badge">Borrador</span>'):'<span class="cat-badge">Archivada</span>'}</div><h2>${esc(e.question)}</h2><small>${esc(brandName(e.brand_id))} · ${e.course_id?esc(state.courses.find(c=>c.id===e.course_id)?.title||'Curso'):'Todos los cursos de la marca'} · v${e.revision}</small><p class="kn-answer">${esc(e.answer)}</p>${e.status==='draft'&&e.created_by===null?'<p class="crm-hint kn-ai-hint">La IA redactó esta respuesta para un cliente. Revísala, corrígela si hace falta y apruébala: desde entonces esta pregunta se contesta sola, sin gastar llamadas. Si no sirve, archívala.</p>':''}${e.variants.length?`<p class="kn-variants">${e.variants.slice(0,6).map(v=>`<span class="ctc-tag">${esc(v)}</span>`).join('')}${e.variants.length>6?`<span class="ctc-tag">+${e.variants.length-6}</span>`:''}</p>`:''}<div class="actions">${e.status!=='archived'?`<button class="btn" data-action="kn-edit" data-id="${e.id}">Editar</button>`:''}${admin()&&e.status==='draft'?`<button class="btn primary" data-action="kn-approve" data-id="${e.id}" data-revision="${e.revision}">Aprobar</button>`:''}${admin()&&e.status!=='archived'?`<button class="btn" data-action="kn-archive" data-id="${e.id}" data-revision="${e.revision}">Archivar</button>`:''}<button class="btn" data-action="kn-history" data-id="${e.id}">Versiones</button></div></article>`).join('')}</div>`;
  }
  function editor(e,preset=null){
    const b=e?.brand_id||preset?.brand_id||(state.brand!=='all'?state.brand:state.brands[0]?.id),courses=state.courses.filter(c=>c.brand_id===b);
    showModal(e?'Editar pregunta y respuesta':'Nueva pregunta y respuesta',`<form id="kn-form" class="form-grid"><input type="hidden" name="id" value="${esc(e?.id||'')}"><input type="hidden" name="expectedRevision" value="${e?.revision||''}">
      ${e?`<p class="crm-hint">${esc(brandName(b))}. Guardar la deja en borrador hasta que administración la apruebe otra vez.</p>`:`<label class="field">Marca<select name="brandId" id="kn-brand">${state.brands.map(x=>`<option value="${x.id}" ${x.id===b?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>`}
      <label class="field">Tema<select name="topic">${Object.entries(TOPICS).map(([k,v])=>`<option value="${k}" ${(e?.topic||'general')===k?'selected':''}>${v}</option>`).join('')}</select></label>
      <label class="field">Curso (opcional)<select name="courseId" id="kn-course"><option value="">Todos los cursos de la marca</option>${courses.map(c=>`<option value="${c.id}" ${e?.course_id===c.id?'selected':''}>${esc(c.title)}</option>`).join('')}</select></label>
      <label class="field">Pregunta, como la haría un cliente<input name="question" required minlength="8" maxlength="200" value="${esc(e?.question||preset?.question||'')}" placeholder="¿Entregan certificado al terminar?"></label>
      <label class="field">Otras formas de preguntarlo (una por línea)<textarea name="variants" rows="3" placeholder="constancia&#10;diploma&#10;tiene validez">${esc((e?.variants||[]).join('\n'))}</textarea></label>
      <label class="field">Respuesta aprobada<textarea name="answer" required minlength="10" maxlength="1500" rows="5" placeholder="Respuesta clara y completa. No escribas precios ni fechas: salen del catálogo.">${esc(e?.answer||'')}</textarea></label>
      ${e?'':'<p class="crm-hint">Se guarda como borrador. Sólo las entradas aprobadas por administración se usan para responder.</p>'}
      <div class="actions"><button class="btn primary" type="submit">Guardar borrador</button></div><div class="ops-feedback" role="status"></div></form>`);
  }
  // Preguntas que los clientes hicieron y el motor no supo responder con conocimiento aprobado (GET /api/replies/gaps).
  async function mountGaps(){
    const box=$('#kn-gaps');if(!box)return;
    try{
      const brand=state.brand==='all'?'':state.brand,r=await api('/api/replies/gaps'+(brand?'?brand='+encodeURIComponent(brand):''));
      if(!$('#kn-gaps'))return;
      if(!r.gaps.length){box.innerHTML='';return;}
      const when=t=>new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'short'}).format(t);
      box.innerHTML=`<section class="crm-panel kn-gaps"><div class="ops-card-top"><h2>Preguntas que no supimos responder</h2><span class="ops-chip high">${r.gaps.length} por cubrir</span></div><p class="crm-hint">Lo que los clientes preguntaron en los últimos 30 días y el motor no pudo contestar con conocimiento aprobado, de lo más repetido a lo menos. Conviértelas en una respuesta y la próxima vez se contestan solas.</p><div class="kn-gap-list">${r.gaps.slice(0,8).map(g=>`<article class="kn-gap"><div><strong>${esc(g.example)}</strong><small>${esc(brandName(g.brandId))} · ${g.count} ${g.count===1?'vez':'veces'} · última ${esc(when(g.lastAt))}</small></div><button type="button" class="btn" data-action="kn-gap-new" data-brand="${esc(g.brandId)}" data-text="${esc(g.example)}">Crear respuesta</button></article>`).join('')}</div></section>`;
    }catch{box.innerHTML='';}
  }
  async function action(name,el,entries){
    try{
      if(name==='kn-gap-new'){editor(null,{brand_id:el.dataset.brand,question:el.dataset.text});return true;}
      if(name==='kn-new'){editor(null);return true;}
      if(name==='kn-edit'){editor(entries.find(x=>x.id===el.dataset.id));return true;}
      if(name==='kn-approve'||name==='kn-archive'){await api('/api/replies/knowledge/'+el.dataset.id+'/'+name.slice(3),{method:'POST',body:{expectedRevision:Number(el.dataset.revision)}});toast(name==='kn-approve'?'Entrada aprobada: ya se usa para responder.':'Entrada archivada.');await reload();return true;}
      if(name==='kn-history'){const r=await api('/api/replies/knowledge/'+el.dataset.id+'/history');showModal('Versiones',r.versions.map(v=>`<article class="ops-version"><strong>v${v.revision} · ${STATES[v.snapshot.status]||v.snapshot.status}</strong><small>${esc(v.actor_name||'Sistema')} · ${new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(v.created_at)}</small><p>${esc(v.snapshot.question)}</p><p class="crm-hint">${esc(v.snapshot.answer)}</p></article>`).join(''));return true;}
    }catch(e){toast(e.message);return true;}
    return false;
  }
  async function submit(form,input){
    try{const body={topic:input.topic,courseId:input.courseId||null,question:input.question,variants:input.variants,answer:input.answer};
      if(input.id)await api('/api/replies/knowledge/'+input.id,{method:'PATCH',body:{...body,expectedRevision:Number(input.expectedRevision)}});else await api('/api/replies/knowledge',{method:'POST',body:{...body,brandId:input.brandId}});
      $('#modal').close();toast('Borrador guardado.');await reload();}
    catch(e){const f=form.querySelector('.ops-feedback');if(f)f.textContent=e.message;toast(e.message);}
    return true;
  }
  function change(el){if(el.id!=='kn-brand')return false;const courses=state.courses.filter(c=>c.brand_id===el.value);$('#kn-course').innerHTML='<option value="">Todos los cursos de la marca</option>'+courses.map(c=>`<option value="${c.id}">${esc(c.title)}</option>`).join('');return true;}
  return {filter,render,action,submit,change,mountGaps};
};

window.createReplyAssistUI=function({state,api,esc,icon,toast}){
  const $=s=>document.querySelector(s);
  const INTENT={opt_out:'Baja',human:'Pide una persona',refund:'Queja o reembolso',enroll:'Quiere inscribirse',payment:'Pago',price:'Precio',schedule:'Fechas',syllabus:'Temario',certificate:'Certificado',requirements:'Requisitos',modality:'Modalidad',recording:'Grabación',duration:'Duración',greeting:'Saludo / información',thanks:'Agradecimiento',unknown:'No reconocida'};
  const ACTION={replied:'Respondió',suggested:'Sugirió',escalated:'Respondió y pasó a una persona',skipped:'No respondió (nivel apagado)'};
  const MODE={off:'Apagado',suggest:'Sugerir al asesor',templates:'Responder con plantillas',autonomous:'Autónomo con IA'};
  const source=s=>s.type==='catalogue'?'Catálogo (precio y fechas vigentes)':s.type==='knowledge'?'Conocimiento: '+esc(s.question||'entrada aprobada'):'Plantilla de bienvenida';
  let currentConversation=null,cache={id:null,at:0,data:null};
  // Se llama al abrir un chat y en cada redibujo del hilo (las actualizaciones en vivo lo vuelven a pintar); la consulta se
  // reutiliza unos segundos para no repetirla en cada redibujo.
  async function mountSuggestion(conversationId,{force=false}={}){
    currentConversation=conversationId;document.querySelector('.reply-suggestion')?.remove();
    if(!state.user||state.user.role==='customer'||!conversationId)return;
    try{
      const fresh=!force&&cache.id===conversationId&&Date.now()-cache.at<5000;
      const r=fresh?cache.data:await api('/api/conversations/'+conversationId+'/replies');if(!fresh)cache={id:conversationId,at:Date.now(),data:r};
      if(currentConversation!==conversationId)return;
      const compose=$('.compose');if(!compose||!r.suggestion||document.querySelector('.reply-suggestion'))return;
      compose.insertAdjacentHTML('beforebegin',`<div class="reply-suggestion"><div class="reply-suggestion-top">${icon('sparkles')}<strong>Respuesta sugerida</strong><span class="ctc-tag">${esc(INTENT[r.suggestion.intent]||r.suggestion.intent)}</span></div><p>${esc(r.suggestion.reply_text)}</p><small>${esc(r.suggestion.reason)}${r.suggestion.sources.length?' · Fuentes: '+r.suggestion.sources.map(source).join('; '):''}</small><div class="actions"><button type="button" class="btn primary" data-action="reply-use">Usar en el borrador</button><button type="button" class="btn" data-action="reply-dismiss" data-id="${esc(conversationId)}">Descartar</button></div></div>`);
      const icons=window.lucide?.createIcons;if(icons)icons({nameAttr:'data-lucide'});
    }catch{}
  }
  async function action(name,el){
    if(name==='reply-use'){const ta=$('.compose textarea');const text=el.closest('.reply-suggestion')?.querySelector('p')?.textContent||'';if(ta){ta.value=text;ta.focus();ta.dispatchEvent(new Event('input',{bubbles:true}));}el.closest('.reply-suggestion')?.remove();cache={id:null,at:0,data:null};return true;}
    if(name==='reply-dismiss'){try{await api('/api/conversations/'+el.dataset.id+'/replies/dismiss',{method:'POST',body:{}});cache={id:null,at:0,data:null};el.closest('.reply-suggestion')?.remove();toast('Sugerencia descartada');}catch(e){toast(e.message);}return true;}
    return false;
  }
  async function renderLog(conversationId,target){
    try{const r=await api('/api/conversations/'+conversationId+'/replies');if(!target.isConnected)return;
      target.innerHTML=`<h3 class="modal-section-title">Respuestas automáticas</h3><p class="crm-hint">Nivel de la marca: <strong>${esc(MODE[r.settings.mode]||r.settings.mode)}</strong>${r.settings.provider_enabled?' · proveedor de IA activo':''}. Cada respuesta indica su intención, sus fuentes y por qué se dio.</p>${r.log.length?`<div class="reply-log">${r.log.slice(0,8).map(l=>`<article class="reply-log-item ${l.action}"><div><strong>${esc(INTENT[l.intent]||l.intent)}</strong><span class="ctc-tag ${l.action==='escalated'?'amber':l.action==='replied'?'green':''}">${esc(ACTION[l.action]||l.action)}</span></div><p>${esc(l.reply_text.slice(0,220))}${l.reply_text.length>220?'…':''}</p><small>${esc(l.reason)}${l.sources.length?' · Fuentes: '+l.sources.map(source).join('; '):''}${l.model?' · Modelo: '+esc(l.model):''}</small></article>`).join('')}</div>`:'<p class="crm-hint">Esta conversación no tiene respuestas automáticas registradas.</p>'}`;
    }catch(e){target.innerHTML=`<p class="crm-hint">${esc(e.message)}</p>`;}
  }
  return {mountSuggestion,action,renderLog};
};
