// Banco de evaluación (pestaña del catálogo): casos esperados del motor de respuestas, ejecución y comparación en el tiempo.
window.createEvaluationUI=function({state,api,esc,icon,showModal,toast,reload}){
  const $=s=>document.querySelector(s),admin=()=>state.user?.role==='admin';
  const INTENT={opt_out:'baja',human:'persona',refund:'queja / reembolso',enroll:'inscripción',payment:'pago',price:'precio',schedule:'fechas',syllabus:'temario',certificate:'certificado',requirements:'requisitos',modality:'modalidad',recording:'grabación',duration:'duración',greeting:'saludo',thanks:'agradecimiento',unknown:'desconocida'};
  const ACTION={replied:'responde',suggested:'sugiere al asesor',escalated:'escala a persona',skipped:'no responde'},SOURCE={catalogue:'catálogo',knowledge:'conocimiento',template:'plantilla',none:'ninguna'};
  const brandName=id=>state.brands.find(b=>b.id===id)?.name||'';
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  let meta={intents:[],actions:[],sources:[]};
  const setMeta=m=>{meta=m;};
  function filter(cases,query,status){const q=norm(query);return (cases||[]).filter(c=>(state.brand==='all'||c.brand_id===state.brand)&&(status==='archived'?c.status==='archived':status?c.status==='active':true)&&(!q||norm(c.title+' '+c.input_text+' '+c.tags+' '+(c.expect_intent||'')).includes(q)));}
  const expectChips=c=>[c.expect_intent?'intención: '+(INTENT[c.expect_intent]||c.expect_intent):null,c.expect_action?'acción: '+(ACTION[c.expect_action]||c.expect_action):null,c.expect_source?'fuente: '+(SOURCE[c.expect_source]||c.expect_source):null,c.must_include?'incluye «'+c.must_include+'»':null,c.must_exclude?'no incluye «'+c.must_exclude+'»':null].filter(Boolean).map(t=>`<span class="ops-chip">${esc(t)}</span>`).join('');
  function render(rows){
    const brands=state.brand==='all'?state.brands:state.brands.filter(b=>b.id===state.brand);
    const head=`<div class="ev-head"><p class="crm-hint">Cada caso dice qué escribe un cliente y qué debería hacer el motor con el nivel vigente de la marca. Ejecutar no envía nada: usa la misma simulación que «Probar respuesta». Guarda la ejecución para comparar tras cambiar conocimiento, nivel o proveedor.</p><div class="actions">${brands.map(b=>`<button type="button" class="btn primary" data-action="ev-run" data-id="${esc(b.id)}">${icon('flask-conical')} Ejecutar · ${esc(b.name)}</button><button type="button" class="btn" data-action="ev-runs" data-id="${esc(b.id)}">Historial</button>`).join('')}</div></div>`;
    if(!rows.length)return head;
    return head+`<div class="cat-template-grid">${rows.map(c=>`<article class="cat-template ev-card ${c.last?c.last.pass?'pass':'fail':''}"><div class="cat-card-heading"><span>${icon(c.last?c.last.pass?'circle-check':'circle-x':'circle-dashed')} ${c.last?(c.last.pass?'Pasó':'Falló')+' · '+stamp(c.last.at):'Sin ejecutar'}</span>${c.status==='archived'?'<span class="cat-badge">Archivado</span>':''}</div><h2>${esc(c.title)}</h2><small>${esc(brandName(c.brand_id))}${c.course_id?' · '+esc(state.courses.find(k=>k.id===c.course_id)?.title||''):''}${c.tags?' · '+esc(c.tags):''}</small><p class="cat-template-copy">«${esc(c.input_text)}»</p><div class="cat-badges">${expectChips(c)}</div>${c.last&&!c.last.pass?`<ul class="ev-failures">${c.last.failures.map(f=>`<li>${esc(f)}</li>`).join('')}</ul>`:''}<div class="actions"><button type="button" class="btn" data-action="ev-edit" data-id="${c.id}">Editar</button>${admin()?`<button type="button" class="btn" data-action="${c.status==='archived'?'ev-restore':'ev-archive'}" data-id="${c.id}">${c.status==='archived'?'Restaurar':'Archivar'}</button>`:''}</div></article>`).join('')}</div>`;
  }
  function editor(c){
    const b=c?.brand_id||(state.brand!=='all'?state.brand:state.brands[0]?.id),courses=state.courses.filter(k=>k.brand_id===b);
    const opts=(list,sel,label)=>`<option value="">Sin exigencia</option>`+list.map(v=>`<option value="${v}" ${sel===v?'selected':''}>${esc(label[v]||v)}</option>`).join('');
    showModal(c?'Editar caso de evaluación':'Nuevo caso de evaluación',`<form id="ev-form" class="form-grid"><input type="hidden" name="id" value="${esc(c?.id||'')}"><input type="hidden" name="expectedRevision" value="${c?.revision||''}">
      ${c?`<p class="crm-hint">${esc(brandName(b))}</p>`:`<label class="field">Marca<select name="brandId" id="ev-brand">${state.brands.map(x=>`<option value="${x.id}" ${x.id===b?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>`}
      <label class="field">Título<input name="title" maxlength="120" value="${esc(c?.title||'')}" placeholder="Pregunta el precio"></label>
      <label class="field">Mensaje del cliente<textarea name="inputText" required minlength="3" maxlength="500" rows="2" placeholder="¿Cuánto cuesta el curso?">${esc(c?.input_text||'')}</textarea></label>
      <label class="field">Curso (opcional)<select name="courseId" id="ev-course"><option value="">Primer curso activo de la marca</option>${courses.map(k=>`<option value="${k.id}" ${c?.course_id===k.id?'selected':''}>${esc(k.title)}</option>`).join('')}</select></label>
      <div class="cat-form-columns"><label class="field">Intención esperada<select name="expectIntent">${opts(meta.intents,c?.expect_intent,INTENT)}</select></label><label class="field">Acción esperada<select name="expectAction">${opts(meta.actions,c?.expect_action,ACTION)}</select></label><label class="field">Fuente esperada<select name="expectSource">${opts(meta.sources,c?.expect_source,SOURCE)}</select></label></div>
      <div class="cat-form-columns"><label class="field">Debe incluir (texto)<input name="mustInclude" maxlength="200" value="${esc(c?.must_include||'')}"></label><label class="field">No debe incluir<input name="mustExclude" maxlength="200" value="${esc(c?.must_exclude||'')}"></label></div>
      <label class="field">Etiquetas (coma)<input name="tags" maxlength="200" value="${esc(c?.tags||'')}"></label>
      <div class="actions"><button class="btn primary" type="submit">Guardar caso</button></div><div class="ops-feedback" role="status"></div></form>`);
  }
  function runModal(r){
    showModal('Evaluación · '+esc(brandName(r.brand_id)),`<div class="ops-card-top"><span class="ops-chip ${r.score===100?'ok':r.score>=70?'':'warn'}">${r.passed} de ${r.total} · ${String(r.score).replace('.',',')} %</span><span class="ops-chip">nivel ${esc(r.mode)}</span><span class="ops-chip">proveedor ${esc(r.provider)}</span><small>${(r.duration_ms/1000).toFixed(1)} s · ${stamp(r.created_at)}</small></div><div class="ev-results">${r.results.map(x=>`<article class="ev-result ${x.pass?'pass':'fail'}"><div class="ops-card-top"><strong>${icon(x.pass?'circle-check':'circle-x')} ${esc(x.title)}</strong><small>${esc(INTENT[x.got.intent]||x.got.intent||'—')} · ${esc(ACTION[x.got.action]||x.got.action||'—')} · fuentes: ${esc(x.got.sources.join(', ')||'ninguna')}</small></div><p class="crm-hint">«${esc(x.input)}»</p>${x.failures.length?`<ul class="ev-failures">${x.failures.map(f=>`<li>${esc(f)}</li>`).join('')}</ul>`:''}<details><summary>Respuesta y motivo</summary><pre class="cat-preview-copy">${esc(x.got.reply||'(sin texto)')}</pre><p class="crm-hint">${esc(x.got.reason||'')}</p></details></article>`).join('')}</div>`);
  }
  async function action(name,el,cases){
    try{
      if(name==='ev-new'){editor(null);return true;}
      if(name==='ev-edit'){editor(cases.find(x=>x.id===el.dataset.id));return true;}
      if(name==='ev-archive'||name==='ev-restore'){await api('/api/evaluation/cases/'+el.dataset.id+'/'+name.slice(3),{method:'POST',body:{}});toast(name==='ev-archive'?'Caso archivado.':'Caso restaurado.');await reload();return true;}
      if(name==='ev-run'){el.disabled=true;const r=(await api('/api/evaluation/brands/'+el.dataset.id+'/run',{method:'POST',body:{}})).run;runModal(r);await reload();return true;}
      if(name==='ev-runs'){const r=await api('/api/evaluation/brands/'+el.dataset.id+'/runs');showModal('Historial de evaluaciones · '+esc(brandName(el.dataset.id)),r.runs.length?`<div class="ev-results">${r.runs.map(x=>`<article class="ev-result ${x.score===100?'pass':'fail'}"><div class="ops-card-top"><strong>${x.passed} de ${x.total} · ${String(x.score).replace('.',',')} %</strong><small>nivel ${esc(x.mode)} · ${esc(x.provider)} · ${esc(x.actor_name||'Equipo')} · ${stamp(x.created_at)}</small></div><div class="actions"><button type="button" class="btn" data-action="ev-run-detail" data-id="${x.id}">Ver detalle</button></div></article>`).join('')}</div>`:'<p class="crm-hint">Todavía no se ha ejecutado la evaluación de esta marca.</p>');return true;}
      if(name==='ev-run-detail'){const r=(await api('/api/evaluation/runs/'+el.dataset.id)).run;runModal(r);return true;}
    }catch(e){toast(e.message);return true;}
    return false;
  }
  async function submit(form,input){
    try{const body={title:input.title,inputText:input.inputText,courseId:input.courseId||null,expectIntent:input.expectIntent||null,expectAction:input.expectAction||null,expectSource:input.expectSource||null,mustInclude:input.mustInclude,mustExclude:input.mustExclude,tags:input.tags};
      if(input.id)await api('/api/evaluation/cases/'+input.id,{method:'PATCH',body:{...body,expectedRevision:Number(input.expectedRevision)}});else await api('/api/evaluation/cases',{method:'POST',body:{...body,brandId:input.brandId}});
      $('#modal').close();toast('Caso guardado.');await reload();}
    catch(e){const f=form.querySelector('.ops-feedback');if(f)f.textContent=e.message;toast(e.message);}
    return true;
  }
  function change(el){if(el.id!=='ev-brand')return false;const courses=state.courses.filter(k=>k.brand_id===el.value);$('#ev-course').innerHTML='<option value="">Primer curso activo de la marca</option>'+courses.map(k=>`<option value="${k.id}">${esc(k.title)}</option>`).join('');return true;}
  return {filter,render,action,submit,change,setMeta};
};
