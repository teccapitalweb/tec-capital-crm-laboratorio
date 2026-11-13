window.createCatalogueImportUI=function({api,esc,icon,showModal,toast,reload}){
  const $=s=>document.querySelector(s);
  let csv='',preview=null;
  const plural=(n,one,many)=>n+' '+(n===1?one:many);
  const ACTION={crear:'Se creará',existente:'Ya existe'};
  const chip=(label,kind='')=>`<span class="ops-chip ${kind}">${esc(label)}</span>`;

  function open(){
    csv='';preview=null;
    showModal('Importar catálogo desde CSV',`<div class="imp-form">
      <p class="crm-hint">Una fila por edición. Si el curso o la edición ya existen, se respetan y no se modifican. Las fechas se escriben como <code>2026-11-20 18:00</code> en la hora de la zona indicada. Puedes crear cursos nuevos y sus ediciones, y una promoción opcional por fila. Las marcas deben existir antes.</p>
      <div class="actions"><button type="button" class="btn" data-action="imp-template">${icon('download')} Descargar plantilla</button></div>
      <label class="field">Archivo CSV<input id="imp-file" type="file" accept=".csv,text/csv"></label>
      <label class="field">…o pega el contenido<textarea id="imp-text" rows="5" spellcheck="false" placeholder="marca,curso,temario,edicion,…"></textarea></label>
      <div class="actions"><button type="button" class="btn primary" data-action="imp-preview">Vista previa</button></div>
      <div id="imp-result" role="status"></div></div>`);
  }

  function rowCard(r){
    const bad=r.errors.length;
    return `<article class="imp-row ${bad?'bad':''}"><div class="imp-row-top"><strong>${esc(r.course||'(sin curso)')}</strong>${bad?chip('Con errores','warn'):chip('Lista','ok')}</div><small>Línea ${r.line} · ${esc(r.brand)} · ${esc(r.edition)} · ${esc(r.price)} ${esc(r.currency)} · ${r.status==='published'?'publicada':'borrador'}</small>${bad?`<ul class="imp-errors">${r.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`:`<small>Curso: ${ACTION[r.actions.course]||'—'} · Edición: ${ACTION[r.actions.edition]||'—'}${r.promotion?` · Promoción «${esc(r.promotion)}»: ${ACTION[r.actions.promotion]||'—'}`:''}</small>`}</article>`;
  }
  function showPreview(p){
    const s=p.summary;
    $('#imp-result').innerHTML=`<div class="imp-summary">${chip(plural(s.rows,'fila','filas'))}${chip(plural(s.valid,'válida','válidas'),'ok')}${s.withErrors?chip(plural(s.withErrors,'con errores','con errores'),'warn'):''}${chip(plural(s.coursesToCreate,'curso nuevo','cursos nuevos'))}${chip(plural(s.editionsToCreate,'edición nueva','ediciones nuevas'))}${s.promotionsToCreate?chip(plural(s.promotionsToCreate,'promoción nueva','promociones nuevas')):''}</div>
      ${p.unknownColumns.length?`<p class="crm-hint">Columnas ignoradas: ${p.unknownColumns.map(esc).join(', ')}.</p>`:''}
      <div class="imp-rows">${p.rows.map(rowCard).join('')}</div>
      ${s.valid?`<div class="actions"><button type="button" class="btn primary" data-action="imp-apply">Importar ${s.valid} fila${s.valid===1?'':'s'} válida${s.valid===1?'':'s'}</button></div><p class="crm-hint">Las filas con errores se omiten. La validación final es la misma del catálogo: si una fila falla ahí, se informa por fila y puedes repetir el archivo sin duplicar.</p>`:'<p class="crm-hint">Corrige el archivo y vuelve a previsualizar.</p>'}`;
  }
  function showApplied(r){
    $('#imp-result').innerHTML=`<div class="imp-summary">${chip(r.applied+' filas importadas','ok')}${r.failed?chip(r.failed+' sin importar','warn'):''}</div><div class="imp-rows">${r.results.filter(x=>x.error).map(x=>`<article class="imp-row bad"><strong>Línea ${x.line}</strong><ul class="imp-errors"><li>${esc(x.error)}</li></ul></article>`).join('')}</div><p class="crm-hint">El catálogo se actualizó. Revisa y publica cada edición cuando esté lista.</p>`;
  }
  async function readInput(){
    const file=$('#imp-file')?.files?.[0],typed=$('#imp-text')?.value||'';
    csv=file?await file.text():typed;
    if(!csv.trim())throw new Error('Elige un archivo o pega el contenido.');
  }
  async function action(name,el){
    if(name==='imp-open'){open();return true;}
    if(name==='imp-template'){
      const t=await api('/api/catalogue/import/template'),blob=new Blob(['\uFEFF'+t.csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');
      a.href=URL.createObjectURL(blob);a.download='plantilla-catalogo.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);return true;
    }
    if(name==='imp-preview'){
      try{await readInput();preview=await api('/api/catalogue/import/preview',{method:'POST',body:{csv}});showPreview(preview);}catch(e){$('#imp-result').textContent=e.message;toast(e.message);}return true;
    }
    if(name==='imp-apply'){
      try{const r=await api('/api/catalogue/import/apply',{method:'POST',body:{csv,fileHash:preview.fileHash}});showApplied(r);toast('Importación terminada');await reload();}catch(e){$('#imp-result').textContent=e.message;toast(e.message);}return true;
    }
    return false;
  }
  return {action};
};
