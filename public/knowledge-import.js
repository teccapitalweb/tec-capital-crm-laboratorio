// Importar conocimiento por lote (docs/PLAN_CONOCIMIENTO_POR_LOTE.md): una hoja con preguntas y respuestas de una consultora entra como
// BORRADORES, previa revisión fila por fila. Nada se usa para responder hasta que administración apruebe cada entrada.
window.createKnowledgeImportUI=function({api,esc,icon,showModal,toast,reload}){
  const $=s=>document.querySelector(s);
  let csv='',preview=null;
  const plural=(n,one,many)=>n+' '+(n===1?one:many);
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;
  const TOPIC={certificate:'Certificado',payment:'Pagos',requirements:'Requisitos',modality:'Modalidad',recording:'Grabaciones',duration:'Duración',general:'General'};

  function open(){
    csv='';preview=null;
    showModal('Importar conocimiento desde CSV',`<div class="imp-form">
      <p class="crm-hint">Una fila por pregunta. Descarga la plantilla, pídele a la consultora que la llene (sus respuestas reales, sin precios ni fechas) y súbela aquí. <strong>Todo entra como borrador</strong>: sólo lo que apruebes se usa para responder. Si una pregunta ya existe, se respeta y no se duplica.</p>
      <div class="actions"><button type="button" class="btn" data-action="kimp-template">${icon('download')} Descargar plantilla</button></div>
      <label class="field">Archivo CSV<input id="kimp-file" type="file" accept=".csv,text/csv"></label>
      <label class="field">…o pega el contenido<textarea id="kimp-text" rows="5" spellcheck="false" placeholder="marca,pregunta,respuesta,tema,curso,variantes"></textarea></label>
      <div class="actions"><button type="button" class="btn primary" data-action="kimp-preview">Vista previa</button></div>
      <div id="kimp-result" role="status"></div></div>`);
  }
  function rowCard(r){
    const bad=r.errors.length;
    return `<article class="imp-row ${bad?'bad':''}"><div class="imp-row-top"><strong>${esc(r.question||'(sin pregunta)')}</strong>${bad?chip('Con errores','warn'):r.action==='existente'?chip('Ya existe'):chip('Se creará','ok')}</div><small>Línea ${r.line} · ${esc(r.brand)} · ${esc(TOPIC[r.topic]||r.topic)}${r.course?' · '+esc(r.course):''}</small>${bad?`<ul class="imp-errors">${r.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:`<p class="qr-text">${esc(r.answer)}</p>`}</article>`;
  }
  function showPreview(p){
    const s=p.summary;
    $('#kimp-result').innerHTML=`<div class="imp-summary">${chip(plural(s.rows,'fila','filas'))}${chip(plural(s.toCreate,'nueva','nuevas'),'ok')}${s.existing?chip(plural(s.existing,'ya existe','ya existen')):''}${s.withErrors?chip(plural(s.withErrors,'con errores','con errores'),'warn'):''}</div>
      <div class="imp-rows">${p.rows.map(rowCard).join('')}</div>
      ${s.toCreate?`<div class="actions"><button type="button" class="btn primary" data-action="kimp-apply">Importar ${s.toCreate} como borrador${s.toCreate===1?'':'es'}</button></div><p class="crm-hint">Las filas con errores se omiten. Después revisa cada entrada en Conocimiento y apruébala.</p>`:'<p class="crm-hint">No hay filas nuevas y válidas. Corrige el archivo y vuelve a previsualizar.</p>'}`;
  }
  function showApplied(r){
    $('#kimp-result').innerHTML=`<div class="imp-summary">${chip(r.created+(r.created===1?' borrador creado':' borradores creados'),'ok')}${r.existing?chip(r.existing+' ya existían'):''}${r.failed?chip(r.failed+' sin importar','warn'):''}</div><div class="imp-rows">${r.results.filter(x=>x.error).map(x=>`<article class="imp-row bad"><strong>Línea ${x.line}</strong><ul class="imp-errors"><li>${esc(x.error)}</li></ul></article>`).join('')}</div><p class="crm-hint">Quedaron como <strong>borrador</strong>. Ábrelas en la pestaña Conocimiento, revisa la redacción y apruébalas una por una.</p>`;
  }
  async function readInput(){
    const file=$('#kimp-file')?.files?.[0],typed=$('#kimp-text')?.value||'';
    csv=file?await file.text():typed;
    if(!csv.trim())throw new Error('Elige un archivo o pega el contenido.');
  }
  async function action(name){
    if(name==='kimp-open'){open();return true;}
    if(name==='kimp-template'){
      const t=await api('/api/knowledge-import/template'),blob=new Blob(['\uFEFF'+t.csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');
      a.href=URL.createObjectURL(blob);a.download='plantilla-conocimiento.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);return true;
    }
    if(name==='kimp-preview'){try{await readInput();preview=await api('/api/knowledge-import/preview',{method:'POST',body:{csv}});showPreview(preview);}catch(e){$('#kimp-result').textContent=e.message;toast(e.message);}return true;}
    if(name==='kimp-apply'){try{const r=await api('/api/knowledge-import/apply',{method:'POST',body:{csv,fileHash:preview.fileHash}});showApplied(r);toast('Conocimiento importado como borrador');await reload();}catch(e){$('#kimp-result').textContent=e.message;toast(e.message);}return true;}
    return false;
  }
  return {action};
};
