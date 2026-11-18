import { $, CARD_W, OV_STATE } from './state.js';
import { ICO } from './icons.js';
import { EMPTY_STATE_SVG } from './ui-studio.js';
import { toast, dataUrlToBlob, getRequestUrl } from './util.js';
import { getCapabilities, getCapabilitiesForPreset, getImageModelCapabilities } from './settings.js';
import { getTaskResult } from './paint.js';
import { getVideoTaskResultUrl } from './videoTasks.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }

function callHook(name, ...args){
  return state && state.hooks && typeof state.hooks[name] === 'function' ? state.hooks[name](...args) : undefined;
}

export async function exportCanvasProject(){
  if(el.btnExportCanvas.disabled) return;
  const ids = Object.keys(state.taskEls);
  if(!ids.length){ toast('画布为空，没有可导出的内容', 'err'); return; }
  el.btnExportCanvas.disabled = true;
  const oldText = (el.btnExportCanvas.querySelector('.lbl')||el.btnExportCanvas).textContent;
  (el.btnExportCanvas.querySelector('.lbl')||el.btnExportCanvas).textContent = '打包中…';
  toast('⏳ 正在打包画布（视频只保存缩略图与恢复地址）…', 'loading');
  try{
    const cards = [];
    for(const id of ids){
      const entry = state.taskEls[id];
      if(!entry) continue;
      const task = entry.task;
      const isVideo = task.mediaType === 'video';
      const ri = getTaskResult(entry);
      let thumb = task.thumb || null;
      let orig = null;
      if(ri && ri.url && !isVideo) thumb = await callHook('thumbFromUrl', ri.url);
      if(!isVideo && ri){
        let blob = ri.blob || null;
        if(!blob && ri.url){
          try{ blob = await fetch(getRequestUrl(ri.url)).then(r=> r.blob()); }catch(e){ blob = null; }
        }
        if(blob){
          try{
            orig = await new Promise((res, rej)=>{
              const fr = new FileReader();
              fr.onload = ()=> res(fr.result);
              fr.onerror = ()=> rej(fr.error);
              fr.readAsDataURL(blob);
            });
          }catch(e){ orig = null; }
        }
      }
      const resultItems = [];
      if(!isVideo){
        for(const item of (entry.resultItems || [])){
          let blob = item.blob || null;
          if(!blob && item.url){
            try{ const response = await fetch(getRequestUrl(item.url)); if(response.ok) blob = await response.blob(); }catch(e){}
          }
          if(!blob || !blob.size) throw new Error('卡片 #' + task.id + ' 有图片无法导出，请先补取返图');
          const dataUrl = await new Promise((resolve,reject)=>{
            const reader = new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=()=>reject(reader.error); reader.readAsDataURL(blob);
          });
          resultItems.push({index:item.index ?? resultItems.length, mime:blob.type, orig:dataUrl});
        }
      }
      cards.push({
        id: task.id, x: Math.round(parseFloat(entry.card.style.left) || 0), y: Math.round(parseFloat(entry.card.style.top) || 0), w: CARD_W,
        state: task.state,
        mediaType: isVideo ? 'video' : 'image', mime: task.videoMime || (ri && ri.blob && ri.blob.type) || '',
        resultItems, resultIndex:entry.resultIndex || 0,
        thumb, orig: isVideo ? null : orig, mediaUrl: isVideo ? (task.videoUrl || (task.jobId ? getVideoTaskResultUrl(task.jobId, 0) : (ri && ri.remoteUrl) || '')) : '',
        clientTaskId: isVideo ? (task.clientTaskId || '') : '', jobId: isVideo ? (task.jobId || '') : '', serverState: isVideo ? (task.serverState || '') : '', providerId: task.providerId || '',
        parentId: task.parentId || null, relation: task.relation || null,
        params: { mode: task.mode, model: task.model || '', videoModel: task.videoModel || '', size: task.size || '', imageSizeMode:task.imageSizeMode || 'preset', n: isVideo ? 1 : task.n, prompt: task.prompt || '', negative: task.negative || '', preset: task.preset || '', quality: task.quality || '', complexity:task.complexity || '', background: task.background || '', format: task.outputFormat || '', resolution:task.resolution || '', responseFormat:task.responseFormat || '', stream:!!task.stream, videoSeconds: task.videoSeconds || '', videoAspectRatio: task.videoAspectRatio || '', videoResolution: task.videoResolution || '' }
      });
    }
    const payload = { app:'AI画布', version:4, ts:new Date().toLocaleString(), cards };
    const blob = new Blob([JSON.stringify(payload)], { type:'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = '画布_' + new Date().toISOString().slice(0,16).replace(/[-:T]/g,'') + '.json'; a.click();
    setTimeout(()=> URL.revokeObjectURL(a.href), 3000);
    toast('✅ 画布已导出：' + cards.length + ' 张卡片（视频未嵌入原始 MP4）', 'ok');
  }catch(err){ toast('❌ 画布导出失败：' + (err && err.message ? err.message : err), 'err'); }
  finally{ el.btnExportCanvas.disabled = false; (el.btnExportCanvas.querySelector('.lbl')||el.btnExportCanvas).textContent = oldText; }
}

export function importCanvasProject(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = async ev=>{
    try{
      const data = JSON.parse(ev.target.result);
      const cards = Array.isArray(data.cards) ? data.cards : (Array.isArray(data.tasks) ? data.tasks.map(s=>({
        id:s.id, x:s.x, y:s.y, parentId:s.parentId, relation:s.relation, state:s.state, mediaType:s.mediaType || 'image', mediaUrl:s.videoUrl || '', mime:s.videoMime || '', thumb:null, orig:null,
        params:{ mode:s.mode, mediaType:s.mediaType || 'image', model:s.model, videoModel:s.videoModel || '', size:s.size, imageSizeMode:s.imageSizeMode || 'preset', n:s.n, prompt:s.prompt, negative:s.negative, preset:s.preset, quality:s.quality, complexity:s.complexity || '', background:s.background, format:s.outputFormat, videoSeconds:s.videoSeconds || '', videoAspectRatio:s.videoAspectRatio || '', videoResolution:s.videoResolution || '' }
      })) : null);
      if(!cards) throw new Error('格式错误');
      let restored = 0; const idMap = {};
      for(const c of cards){
        if(!c || typeof c.x !== 'number' || typeof c.y !== 'number') continue;
        const p = c.params || {};
        const mediaType = c.mediaType === 'video' || p.mediaType === 'video' ? 'video' : 'image';
        const task = {
          id: ++state.taskSeq, state:'archived', mediaType, mode: p.mode || (mediaType === 'video' ? 'txt2video' : 'txt2img'), files:[],
          prompt: p.prompt || '', negative: p.negative || '', preset: p.preset || '', capabilities: getImageModelCapabilities(p.model, getCapabilitiesForPreset(p.preset)),
          model: p.model || p.videoModel || '?', videoModel: p.videoModel || '', size: p.size || '?', imageSizeMode:p.imageSizeMode || 'preset', n: mediaType === 'video' ? 1 : (p.n || 1),
          videoSeconds: p.videoSeconds || '', videoAspectRatio: p.videoAspectRatio || '', videoResolution: p.videoResolution || '', videoMime: c.mime || '', videoUrl: c.mediaUrl || '', providerId: c.providerId || '', videoProgress: 0,
          resolution:p.resolution || '', responseFormat:p.responseFormat || '', stream:!!p.stream,
          quality: p.quality || '', complexity:p.complexity || '', background: p.background || '', outputFormat: p.format || '', base:'', key:'', thumb:c.thumb || '', clientTaskId: c.clientTaskId || null, jobId: c.jobId || '', serverState: c.serverState || '', serverError:'', historySaved:false
        };
        idMap[c.id] = task.id; el.canvasEmpty.classList.add('hide');
        const card = callHook('createCard', task, { x:c.x, y:c.y, col:0 });
        const entry = { task, card, urls:[], resultItems:[], resultIndex:0 }; state.taskEls[task.id] = entry;
        if(mediaType !== 'video' && Array.isArray(c.resultItems) && c.resultItems.length){
          for(const result of c.resultItems){
            if(!result || typeof result.orig !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(result.orig)) continue;
            const blob = dataUrlToBlob(result.orig);
            if(blob.size){ const url = URL.createObjectURL(blob); entry.urls.push(url); entry.resultItems.push({blob,url,index:result.index ?? entry.resultItems.length,mime:blob.type,size:blob.size}); }
          }
          if(entry.resultItems.length){ entry.resultIndex=Math.max(0,Math.min(entry.resultItems.length-1,Number(c.resultIndex)||0)); task.state='done'; }
        }else if(mediaType !== 'video' && c.orig && typeof c.orig === 'string' && /^data:image\//.test(c.orig)){
          try{ const blob = dataUrlToBlob(c.orig); if(blob && blob.size > 0){ const url = URL.createObjectURL(blob); entry.urls.push(url); entry.resultItems.push({ blob, url }); task.state='done'; } }catch(e){}
        }else if(mediaType === 'image' && c.thumb){ entry.resultItems.push({ url:c.thumb }); }
        else if(mediaType === 'video' && c.mediaUrl && /^https?:/i.test(c.mediaUrl)){
          task.restoreNote = '视频地址已保留，需重新查询或下载';
        }
        callHook('renderCardState', task); restored++;
      }
      cards.forEach(c=>{ if(c.parentId && idMap[c.parentId]!=null && c.relation && idMap[c.id]!=null) callHook('addLink', idMap[c.parentId], idMap[c.id], c.relation); });
      callHook('rebuildColumns'); callHook('scheduleAutosave');
      toast('✅ 画布已恢复：' + restored + ' 张卡片（视频以存档卡保留参数）', 'ok');
    }catch(err){ toast('❌ 画布文件解析失败', 'err'); }
  };
  reader.onerror = ()=> toast('❌ 画布文件读取失败', 'err'); reader.readAsText(file); e.target.value = '';
}

export function renderOverview(){
  const entries = Object.keys(state.taskEls).map(id=> state.taskEls[id]).sort((a,b)=> a.task.id - b.task.id);
  const sum = $('taskSummary');
  let run = 0, pend = 0, fail = 0;
  entries.forEach(t=>{ const st = t.task.state; if(st==='running') run++; else if(st==='pending') pend++; else if(st==='error'||st==='timeout') fail++; });
  if(run || pend || fail){
    sum.classList.add('show');
    sum.innerHTML = '<div class="d-hint">运行中 ' + run + ' · 排队 ' + pend + ' · 失败 ' + fail + '</div>'
      + '<div class="d-row"><button class="d-btn" id="btnAbortAll" type="button">' + ICO.stop + '<span class="lbl">全部终止</span></button><button class="d-btn" id="btnRetryFailed" type="button">' + ICO.retry + '<span class="lbl">恢复全部失败</span></button></div>';
  }else sum.classList.remove('show');
  const filterEl = $('ovFilter');
  filterEl.innerHTML = '';
  [['all','全部'],['done','完成'],['running','生成中'],['pending','排队'],['error','失败'],['cancelled','取消'],['archived','存档']].forEach(pair=>{
    const b = document.createElement('button');
    b.className = 'lib-tab' + (state.ovFilter===pair[0] ? ' active' : '');
    b.textContent = pair[1];
    b.onclick = ()=>{ state.ovFilter = pair[0]; renderOverview(); };
    filterEl.appendChild(b);
  });
  const filtered = entries.filter(t=>{
    if(state.ovFilter==='all') return true;
    if(state.ovFilter==='error') return t.task.state==='error' || t.task.state==='timeout';
    return t.task.state === state.ovFilter;
  });
  el.overviewList.innerHTML = '';
  if(!filtered.length){
    el.overviewList.innerHTML = '<div class="empty-ov">' + EMPTY_STATE_SVG + '<div>' + (entries.length ? '该筛选下暂无卡片' : '画布为空，先生成图片或视频吧。') + '</div></div>';
  }else{
    filtered.forEach(t=>{
      const row = document.createElement('div');
      row.className = 'ov-row';
      const ri = getTaskResult(t);
      const img = document.createElement(t.task.mediaType === 'video' ? 'video' : 'img');
      img.src = ri ? ri.url : '';
      if(t.task.mediaType === 'video'){ img.muted = true; img.playsInline = true; img.preload = 'metadata'; }
      const info = document.createElement('div');
      info.className = 'ov-info';
      const tt = document.createElement('div');
      tt.className = 'ov-t';
      tt.textContent = '#' + t.task.id + ' ' + (OV_STATE[t.task.state] || t.task.state) + (t.task.batchOf ? ' · ' + t.task.batchIdx + '/' + t.task.batchOf + '张' : '');
      const ss = document.createElement('div');
      ss.className = 'ov-s';
      ss.textContent = t.task.mediaType === 'video' ? ((t.task.model || t.task.videoModel || '?') + ' · ' + (t.task.videoSeconds || '6') + '秒 · ' + (t.task.videoAspectRatio || '16:9')) : ((t.task.model || '?') + ' · ' + (t.task.size || '?'));
      info.append(tt, ss);
      row.append(img, info);
      row.onclick = ()=>{
        callHook('closeDrawers');
        callHook('ensureVisible', parseFloat(t.card.style.left), parseFloat(t.card.style.top), true);
        t.card.classList.remove('flash');
        void t.card.offsetWidth;
        t.card.classList.add('flash');
        setTimeout(()=> t.card.classList.remove('flash'), 1400);
      };
      el.overviewList.appendChild(row);
    });
  }
  const ba = $('btnAbortAll'), br = $('btnRetryFailed');
  if(ba) ba.onclick = ()=> callHook('abortAllTasks');
  if(br) br.onclick = ()=> callHook('retryAllFailed');
}

