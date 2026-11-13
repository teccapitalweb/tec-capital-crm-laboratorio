import {normalize,stem} from './ai-provider.mjs';

// Reconocer de qué curso habla una persona (docs/PLAN_NUMERO_POR_CONSULTORA.md). Un número de WhatsApp puede atender todos los cursos de una
// marca: el curso sale del anuncio por el que llegó, de lo que escribe o de la lista que el asistente le ofrece.
// Todo aquí trabaja con los cursos de UNA marca: nunca se compara contra cursos de otra.

// Palabras que aparecen en casi cualquier título y no distinguen un curso de otro.
const GENERIC=new Set(['curso','cursos','diplomado','diplomados','taller','talleres','seminario','certificacion','programa','basico','basica','avanzado','avanzada','intensivo','practico','practica','online','linea','introduccion','para','sobre','desde','como','plan','manejo','nivel','modulo']);
const words=v=>[...new Set(normalize(v).split(/\s+/).filter(w=>w.length>=4&&!GENERIC.has(w)).map(stem))];
// Señal de que la persona habla de un curso («el de aves», «también me interesa…»), y no sólo usa una palabra que coincide con un título.
const CUE=/\b(curso|cursos|diplomado|taller|el de|la de|los de|las de|el otro|otro|tambien|cambiar|cambio|cambiame|mejor|informacion|info|informes|interesa)\b/;

// Cursos activos de la marca que tienen una edición disponible, por título. Es la lista que se ofrece y contra la que se reconoce.
export function brandCourses(db,catalogue,brandId){
  const editions=db.prepare("SELECT e.* FROM editions e JOIN courses k ON k.id=e.course_id WHERE e.brand_id=? AND e.status='published' AND k.active=1 ORDER BY e.starts_at IS NULL,e.starts_at").all(brandId).filter(e=>{try{return !catalogue.editionState(e);}catch{return false;}});
  const out=[];
  for(const k of db.prepare('SELECT id,title FROM courses WHERE brand_id=? AND active=1 ORDER BY title').all(brandId)){const e=editions.find(x=>x.course_id===k.id);if(e)out.push({id:k.id,title:k.title,editionId:e.id});}
  return out;
}

// El curso que nombra el texto, o null si no nombra ninguno o nombra varios por igual. Cuenta las palabras del título que SÓLO tiene ese curso
// dentro de la marca («aves», «perros»); una palabra compartida («nutrición» en dos cursos) no decide. `strict` es para cambiar de curso a media
// conversación: además de la palabra hace falta una señal («el de…», «curso», «también») o dos palabras propias, para que «tengo 200 aves» no cambie nada.
export function matchCourse(list,text,{strict=false}={}){
  const plain=normalize(text).replace(/\s+/g,' ').trim(),said=new Set(words(text));if(!said.size||!list.length)return null;
  const bags=list.map(k=>words(k.title)),freq=new Map();for(const b of bags)for(const w of b)freq.set(w,(freq.get(w)||0)+1);
  let best=null,tie=false;
  list.forEach((k,i)=>{
    const own=bags[i].filter(w=>freq.get(w)===1&&said.has(w)).length;if(!own)return;
    if(strict&&own<2&&!CUE.test(plain))return;
    const score=own*10+bags[i].filter(w=>said.has(w)).length;
    if(!best||score>best.score){best={course:k,score};tie=false;}else if(score===best.score)tie=true;
  });
  return best&&!tie?best.course:null;
}

// «2» después de una lista numerada: el segundo curso de la lista.
export const byNumber=(list,text)=>{const m=/^\s*(\d{1,2})\s*[.)]?\s*$/.exec(String(text||''));if(!m)return null;return list[Number(m[1])-1]||null;};
