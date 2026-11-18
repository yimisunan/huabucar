import { REFERENCE_ROLES, MAX_REFS } from './state.js';
import { toast, mimeToExt } from './util.js';
import { getMaxReferences, getCapNum, getImageModelCapabilities } from './settings.js';
import { setMode, syncQuickRow } from './params.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }
function scheduleAutosave(){ return state && state.hooks && state.hooks.scheduleAutosave ? state.hooks.scheduleAutosave() : undefined; }

function getReferenceLimit(){
  const caps = getImageModelCapabilities();
  const configured = Number(caps.maxReferences) || 1;
  return Math.min(MAX_REFS, Math.max(1, configured));
}

export async function normalizeRefFile(file){

  // 超过像素软上限的参考图等比缩放，避免手机内存/请求体过大；解码失败按原文件放行

  const capPx = getCapNum('maxRefPixels', 16777216);

  let url = null;

  try{

    url = URL.createObjectURL(file);

    const img = await new Promise((res, rej)=>{ const i = new Image(); i.onload = ()=> res(i); i.onerror = ()=> rej(new Error('load')); i.src = url; });

    const px = img.width * img.height;

    if(px <= capPx) return file;

    const k = Math.sqrt(capPx / px);

    const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));

    const c = document.createElement('canvas'); c.width = w; c.height = h;

    c.getContext('2d').drawImage(img, 0, 0, w, h);

    const keepPng = (file.type === 'image/png');

    const blob = await new Promise(res=> c.toBlob(res, keepPng ? 'image/png' : 'image/jpeg', 0.92));

    if(!blob) return file;

    const base = file.name.replace(/\.[^.]+$/, '');

    return new File([blob], base + '_scaled' + (keepPng ? '.png' : '.jpg'), { type: blob.type });

  }catch(e){ return file; }

  finally{ if(url){ try{ URL.revokeObjectURL(url); }catch(e){} } }

}

export async function addRefFiles(fileList){

  const arr = Array.from(fileList || []);

  const imgs = arr.filter(f=>/^image\//.test(f.type));

  if(imgs.length !== arr.length) toast('已跳过非图片文件', 'err');

  if(!imgs.length) return;

  const maxRefs = getReferenceLimit();

  const capMB = getCapNum('maxRefFileMB', 30);

  const okList = [], skipped = [];

  for(const f of imgs){

    if(state.currentFiles.length + okList.length >= maxRefs){ skipped.push(f.name + '（超数量）'); continue; }

    if(f.size > capMB * 1048576){ skipped.push(f.name + '（超' + capMB + 'MB）'); continue; }

    const nf = await normalizeRefFile(f);

    if(nf === null){ skipped.push(f.name + '（处理失败）'); continue; }

    okList.push(nf);

  }

  okList.forEach(f=>{

    state.currentFiles.push({ file:f, url:URL.createObjectURL(f), role: 'none' });

  });

  scheduleAutosave();

  renderRefStrip();

  if(skipped.length) toast('已跳过 ' + skipped.length + ' 个文件：' + skipped.join('、'), 'err');

  else if(okList.some(f=> f.name.indexOf('_scaled') > -1)) toast('部分参考图过大，已自动缩放适配', 'ok');

}

export function removeRef(i){

  const item = state.currentFiles[i];

  if(!item) return;

  URL.revokeObjectURL(item.url);

  state.currentFiles.splice(i, 1);

  scheduleAutosave();

  renderRefStrip();

}

export async function addRefFromBlob(blob, name, role){

  const maxRefs = getReferenceLimit();

  if(state.currentFiles.length >= maxRefs){ toast('参考图已达上限 ' + maxRefs + ' 张', 'err'); return false; }

  const capMB = getCapNum('maxRefFileMB', 30);

  if(blob.size > capMB * 1048576){ toast('参考图超过 ' + capMB + 'MB 上限，已跳过', 'err'); return false; }

  const src = new File([blob], name || ('参考_' + Date.now() + '.' + mimeToExt(blob.type)), { type: blob.type || 'image/png' });

  const nf = await normalizeRefFile(src);

  if(nf === null){ toast('参考图处理失败，已跳过', 'err'); return false; }

  state.currentFiles.push({ file: nf, url:URL.createObjectURL(nf), role: REFERENCE_ROLES[role] ? role : 'none' });

  scheduleAutosave();

  renderRefStrip();

  setMode('img2img');

  return true;

}

export function renderRefStrip(){

  el.refStrip.innerHTML = '';

  state.currentFiles.forEach((item, i)=>{

    const chip = document.createElement('div');

    chip.className = 'ref-chip' + (item.invalid ? ' invalid' : '');

    if(item.invalid) chip.title = '这张参考图已失效（切后台后被系统回收），请删除后重新添加';

    const img = document.createElement('img'); img.src = item.url; img.title = (item.file.size / 1048576).toFixed(1) + ' MB';

    const role = document.createElement('select');

    role.className = 'role';

    Object.entries(REFERENCE_ROLES).forEach(([v,l])=> role.add(new Option(l, v)));

    role.value = item.role || 'none';

    role.onchange = ()=>{ item.role = role.value; if(item.invalid){ item.invalid = false; chip.classList.remove('invalid'); chip.removeAttribute('title'); } };

    role.addEventListener('click', e=> e.stopPropagation());

    const del = document.createElement('button');

    del.className = 'del'; del.textContent = '✕';

    del.onclick = ()=> removeRef(i);

    // 长按参考图 → 用它做局部修改
    let refTimer = null;
    const refCancel = ()=>{ if(refTimer){ clearTimeout(refTimer); refTimer = null; } };
    chip.addEventListener('pointerdown', ()=>{
      refCancel();
      refTimer = setTimeout(()=>{
        refTimer = null;
        if(state.hooks && state.hooks.openPaintSource){
          state.hooks.openPaintSource({ blob: item.file, label: '参考图 ' + (i + 1), parentId: null });
        }
      }, 520);
    });
    chip.addEventListener('pointerup', refCancel);
    chip.addEventListener('pointercancel', refCancel);
    chip.addEventListener('pointermove', refCancel);
    chip.title = '长按可用这张图做局部修改';

    chip.append(img, role, del);

    el.refStrip.appendChild(chip);

  });

  const add = document.createElement('button');

  add.className = 'ref-add'; add.innerHTML = '<svg class="ic duo-col" viewBox="0 0 256 256" aria-hidden="true" fill="currentColor"><path d="M216,56V200a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V56A16,16,0,0,1,56,40H200A16,16,0,0,1,216,56Z" class="pb"/><path class="pf" d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>'; add.title = '添加参考图'; add.setAttribute('aria-label', '添加参考图');

  add.onclick = ()=> el.fileInput.click();

  // fileInput 必须留在 DOM 内，否则重绘参考图条后「+」点击会失效

  el.refStrip.append(add, el.fileInput);

  syncQuickRow(); // 参考图数量变化同步状态摘要

}