import { ICO } from './icons.js';
import { LS_CANVAS, LS_HIST, MAX_HIST, DB_NAME, DB_STORE, THUMB_W, THUMB_Q, OV_STATE, CARD_W } from './state.js';
import { lsGet, lsSet, cleanB64, b64ToBlob, dataUrlToBlob, fileFromBlob, getRequestUrl, toast } from './util.js';
import { getCapabilitiesForPreset, getCapabilities, getImageModelCapabilities } from './settings.js';
import { renderRefStrip } from './refs.js';
import { getTaskResult } from './paint.js';
import { submitServerTask, fetchTaskResults, getTaskResultUrl, watchServerTask, stopTaskWatch, ensureClientTaskId, extractTaskServerMeta, getTaskStatus, resumeServerTask, fetchTaskByClient, forgetServerTask } from './serverTasks.js';
import { getVideoTaskStatus, fetchVideoResults, getVideoTaskResultUrl, watchVideoTask } from './videoTasks.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; if(state){ state.hooks = state.hooks || {}; state.hooks.resumeVideoTask = resumeVideoTask; } }
const callHook = (name, ...args) => state && state.hooks && state.hooks[name] ? state.hooks[name](...args) : undefined;
function notifyOvershootSettled(task){
  try{ callHook('overshootSettled', task); }catch(e){}
}
function addLink(fromId, toId, rel){ return callHook('addLink', fromId, toId, rel); }
function createCard(task, slot){ return callHook('createCard', task, slot); }
function renderCardState(task){ return callHook('renderCardState', task); }
function rebuildColumns(){ return callHook('rebuildColumns'); }
function updateEmpty(){ return callHook('updateEmpty'); }
function applyView(){ return callHook('applyView'); }
function removeLinksOf(id){ return callHook('removeLinksOf', id); }
function ensureVisible(x, y, force){ return callHook('ensureVisible', x, y, force); }
function openLibDetail(h){ return callHook('openLibDetail', h); }
function openDrawer(name){ return callHook('openDrawer', name); }
function closeDrawers(){ return callHook('closeDrawers'); }
function removeCard(task){ return callHook('removeCard', task); }
function abortAllTasks(){ return callHook('abortAllTasks'); }
function retryAllFailed(){ return callHook('retryAllFailed'); }
function pngInsertText(bytes, keyword, text){ return callHook('pngInsertText', bytes, keyword, text); }
function b64encodeUtf8(text){ return callHook('b64encodeUtf8', text); }


function proxyToken(){
  return el && el.proxyToken ? String(el.proxyToken.value || '').trim() : '';
}

function serverOptions(extra){
  const options = { ...(extra || {}) };
  const token = proxyToken();
  if(token && !Object.prototype.hasOwnProperty.call(options, 'proxyToken')) options.proxyToken = token;
  return options;
}

function applyServerStatus(task, status){
   if(!task || !status) return;
   task.jobId = status.jobId || status.job_id || task.jobId || '';
   task.providerId = status.providerId || task.providerId || '';
   if(task.mediaType === 'video'){
     task.videoProgress = Math.max(0, Math.min(100, Number(status.progress) || 0));
     task.videoUrl = status.videoUrl || task.videoUrl || '';
   }else{
     const meta = extractTaskServerMeta(status);
     const rawError = status.error;
     const errorText = rawError && typeof rawError === 'object' ? (rawError.message || rawError.detail || '') : rawError;
     task.serverTaskId = meta.providerTaskId || task.serverTaskId || '';
     task.serverErrorCode = meta.errorCode || status.errorCode || status.error_code || task.serverErrorCode || '';
     task.serverMeta = meta;
     task.serverResultUrls = meta.resultUrls;
     task.serverSize = meta.size || task.serverSize || '';
     task.serverResolution = meta.resolution || task.serverResolution || '';
     task.serverQuality = meta.quality || task.serverQuality || '';
     task.serverImageCount = meta.imageCount || task.serverImageCount || 0;
     task.serverImageSizeTier = meta.imageSizeTier || task.serverImageSizeTier || '';
     if(meta.costUsd !== '' && meta.costUsd != null) task.serverCostUsd = meta.costUsd;
     task.serverError = String(errorText || '');
   }
   task.serverState = status.state || status.status || task.serverState || '';
   if(task.mediaType === 'video' && status.error) task.serverError = String(status.error || '');
   task.serverUpdatedAt = Date.now();
   if(status.createdAt) task.submittedAt = Math.round(Number(status.createdAt) * 1000);
   if(status.startedAt) task.startTs = Math.round(Number(status.startedAt) * 1000);
   if(status.endedAt) task.endTs = Math.round(Number(status.endedAt) * 1000);
   if(task.serverState === 'queued' || task.serverState === 'submitting') task.state = 'pending';
   else if(task.serverState === 'running') task.state = 'running';
   else if(task.serverState === 'done'){
     task.state = 'running';
     task.restoreNote = '正在加载结果…';
   }else if(task.serverState === 'cancelled'){
     task.state = 'cancelled';
     task.errorMsg = task.serverError || '任务已取消';
   }else if(task.serverState === 'interrupted' || task.serverState === 'expired'){
     task.state = 'error';
     task.errorMsg = task.serverError || (task.serverState === 'expired' ? '任务结果已过期' : '服务器重启后任务未续跑');
   }else if(task.serverState === 'error'){
     task.state = 'error';
     task.errorMsg = task.serverError || '后台任务失败';
   }
}

function clearEntryResults(entry){
  if(!entry) return;
  entry.urls.forEach(u=>{ try{ URL.revokeObjectURL(u); }catch(e){} });
  entry.urls = [];
  entry.resultItems = [];
  entry.resultIndex = 0;
}

async function fillRemoteResults(task, entry, status){
  if(!task || !entry || !status || !status.jobId) throw new Error('后台任务结果参数无效');
   applyServerStatus(task, status);
   const results = await fetchTaskResults(status, serverOptions());
  if(!results.length) throw new Error('后台任务完成但没有可用图片结果');
  if(state.taskEls[task.id] !== entry) return;
  clearEntryResults(entry);
  results.forEach(item=>{
    const url = URL.createObjectURL(item.blob);
    entry.urls.push(url);
    entry.resultItems.push({ blob:item.blob, url, remoteUrl:getTaskResultUrl(status.jobId, item.index), index:item.index, mime:item.mime || item.blob.type || '', size:item.size || item.blob.size || 0 });
  });
  entry.savedToIdb = false;
task.jobId = status.jobId;
   task.serverTaskId = extractTaskServerMeta(status).providerTaskId || task.serverTaskId || '';
   task.serverState = 'done';
   task.serverError = '';
   task.serverErrorCode = '';
   const doneMeta = extractTaskServerMeta(status);
   task.serverMeta = doneMeta;
   task.serverResultUrls = doneMeta.resultUrls;
   task.serverSize = doneMeta.size || task.serverSize || '';
   task.serverResolution = doneMeta.resolution || task.serverResolution || '';
   task.serverQuality = doneMeta.quality || task.serverQuality || '';
   task.serverImageCount = doneMeta.imageCount || results.length || task.serverImageCount || 0;
   task.serverImageSizeTier = doneMeta.imageSizeTier || task.serverImageSizeTier || '';
   if(doneMeta.costUsd !== '' && doneMeta.costUsd != null) task.serverCostUsd = doneMeta.costUsd;
  task.state = 'done';
  task.endTs = status.endedAt ? Math.round(Number(status.endedAt) * 1000) : (task.endTs || Date.now());
  task.restoreNote = '';
  if(!task.historySaved){
    saveHistory(results.map(item=>({ blob:item.blob, url:getTaskResultUrl(status.jobId, item.index) })), task);
    task.historySaved = true;
  }
  renderCardState(task);
  scheduleAutosave();
}

function watchRemoteTask(task, entry){
  if(!task || !entry || !task.jobId) return null;
  stopTaskWatch(task.jobId);
  const callbacks = {
    onStatus(status){
      if(state.taskEls[task.id] !== entry) return;
      applyServerStatus(task, status);
      renderCardState(task);
      scheduleAutosave();
    },
    async onDone(status){
      try{
        await fillRemoteResults(task, entry, status);
      }catch(err){
        if(state.taskEls[task.id] !== entry) return;
        task.state = 'error';
        task.serverState = 'error';
        task.serverError = err && err.message ? err.message : String(err);
        task.errorMsg = task.serverError;
        renderCardState(task);
        scheduleAutosave();
      }finally{
        notifyOvershootSettled(task);
      }
    },
    onTerminal(status){
      if(state.taskEls[task.id] !== entry) return;
      applyServerStatus(task, status);
      renderCardState(task);
      scheduleAutosave();
      notifyOvershootSettled(task);
    },
    async onError(err){
      if(state.taskEls[task.id] !== entry) return;
      if(Number(err && err.status) === 404 && task.clientTaskId){
        try{
          const found = await fetchTaskByClient(task.clientTaskId, serverOptions());
          if(found.jobId !== task.jobId){ stopTaskWatch(task.jobId); task.jobId = found.jobId; watchRemoteTask(task, entry); return; }
        }catch(checkErr){ if(Number(checkErr.status) !== 404) return; }
      }
      task.serverError = err && err.message ? err.message : String(err);
      if(err && [401, 403, 404, 410].includes(Number(err.status))){
        task.state = 'error';
        task.serverState = err.status === 410 ? 'expired' : 'error';
        task.errorMsg = task.serverError;
        renderCardState(task);
      }
      scheduleAutosave();
      notifyOvershootSettled(task);
    }
  };
  try{
    const handle = watchServerTask(task.jobId, callbacks, serverOptions());
    if(state.taskWatches) state.taskWatches.set(task.jobId, handle);
    return handle;
  }catch(err){
    task.state = 'error';
    task.serverState = 'error';
    task.serverError = err && err.message ? err.message : String(err);
    task.errorMsg = task.serverError;
    renderCardState(task);
    return null;
  }
}

async function resumeUnboundTask(task, entry){
  if(!task || !entry || task.jobId || !task.clientTaskId) return;
  try{
    const result = await fetchTaskByClient(task.clientTaskId, serverOptions());
    if(state.taskEls[task.id] !== entry) return;
    task.jobId = result.jobId || '';
    applyServerStatus(task, result);
    scheduleAutosave();
    if(task.jobId) watchRemoteTask(task, entry);
  }catch(err){
    if(state.taskEls[task.id] !== entry) return;
    if(Number(err.status) === 404 && task.wasLocalQueued){
      const panelBase = el.apiBase.value.trim().replace(/\/+$/, '');
      const panelKey = el.apiKey.value.trim();
      let sameProvider = false;
      try{ sameProvider = new URL(task.base).origin === new URL(panelBase).origin; }catch(e){}
      if(sameProvider && panelKey && (task.files || []).length === task.expectedReferenceCount){
        task.key = panelKey;
        task.wasLocalQueued = false;
        state.taskQueue.push(task);
        callHook('dispatchTasks');
        return;
      }
      task.restoreNote = '未发送的排队任务需要原供应商 Key 与完整参考图，配置后可重新生成';
    }
    task.state = 'error';
    task.serverState = 'error';
    task.serverError = task.restoreNote || (Number(err.status) === 404 ? '未找到原提交记录，请核对供应商后台；不会自动重发生图' : (err.message || String(err)));
    task.errorMsg = task.serverError;
    renderCardState(task);
    scheduleAutosave();
    notifyOvershootSettled(task);
  }
}

async function resumeVideoTask(task, entry){
  if(!task || !entry || !task.jobId) return;
  try{
    const options = serverOptions();
    const status = await getVideoTaskStatus(task.jobId, options);
    task.providerId = status.providerId || task.providerId || '';
    task.videoProgress = Number(status.progress) || task.videoProgress || 0;
    task.videoUrl = status.videoUrl || task.videoUrl || '';
    const finish = async finalStatus=>{
      const results = await fetchVideoResults(finalStatus, options);
      if(!results.length) throw new Error('视频完成但结果为空');
      if(state.taskEls[task.id] !== entry) return;
      clearEntryResults(entry);
      results.forEach(item=>{
        const url = URL.createObjectURL(item.blob);
        entry.urls.push(url);
        entry.resultItems.push({ blob:item.blob, url, remoteUrl:getVideoTaskResultUrl(task.jobId, item.index) });
      });
      task.state='done'; task.serverState='done'; task.localResultExpected=false; task.videoProgress=100;
      task.providerId=finalStatus.providerId || task.providerId || ''; task.videoUrl=finalStatus.videoUrl || task.videoUrl || '';
      task.videoMime=entry.resultItems[0].blob.type || 'video/mp4'; task.restoreNote='';
      if(!task.historySaved){
        saveHistory(entry.resultItems.map(item=>({ blob:item.blob, url:item.remoteUrl })), task);
        task.historySaved = true;
      }
      renderCardState(task); scheduleAutosave();
    };
    if(status.state === 'done'){ await finish(status); return; }
    if(status.state === 'queued' || status.state === 'running'){
      task.state = status.state === 'queued' ? 'pending' : 'running';
      task.serverState = status.state;
      renderCardState(task);
      const handle = watchVideoTask(task.jobId, {
        onStatus(next){ if(state.taskEls[task.id] !== entry) return; task.providerId=next.providerId || task.providerId || ''; task.videoProgress=Number(next.progress) || task.videoProgress || 0; task.videoUrl=next.videoUrl || task.videoUrl || ''; applyServerStatus(task,next); renderCardState(task); scheduleAutosave(); },
        async onDone(next){ try{ await finish(next); }catch(err){ task.state='error'; task.serverState='error'; task.errorMsg=err.message||String(err); renderCardState(task); scheduleAutosave(); } },
        onTerminal(next){ if(state.taskEls[task.id] !== entry) return; applyServerStatus(task,next); renderCardState(task); scheduleAutosave(); },
        onError(err){ if(state.taskEls[task.id] !== entry) return; task.serverError=err.message||String(err); renderCardState(task); scheduleAutosave(); }
      }, options);
      state.videoWatches = state.videoWatches || new Map();
      state.videoWatches.set(task.jobId, handle);
      return;
    }
    applyServerStatus(task, status);
    renderCardState(task);
  }catch(err){
    task.state='error'; task.serverState='error'; task.errorMsg=err && err.message ? err.message : String(err); renderCardState(task); scheduleAutosave();
  }
}

export function scheduleAutosave(){
  if(state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(()=> autosave(), 500);
}

export function autosave(){
  if(!state.taskApi || !state.taskApi.restored) return;
  try{
    const tasks = [];
    const idbJobs = [];
    const currentRefKeys = new Set();
    Object.keys(state.taskEls).forEach(id=>{
      const t = state.taskEls[id];
      if(!t || !t.card) return;
      const task = t.task;
const ri = getTaskResult(t);
       tasks.push({
        id: task.id, state: task.state, localQueued:state.taskQueue.includes(task), mediaType: task.mediaType || 'image', mode: task.mode,
        parentId: task.parentId || null, relation: task.relation || null,
clientTaskId: task.clientTaskId || null, jobId: task.jobId || '', serverTaskId: task.serverTaskId || '',
         serverState: task.serverState || '', serverError: task.serverError || '', serverErrorCode: task.serverErrorCode || '', serverMeta: task.serverMeta || null, serverResultUrls: Array.isArray(task.serverResultUrls) ? task.serverResultUrls.slice(0, 16) : [],
         serverSize: task.serverSize || '', serverResolution: task.serverResolution || '', serverQuality: task.serverQuality || '', serverImageCount: task.serverImageCount || 0, serverImageSizeTier: task.serverImageSizeTier || '', serverCostUsd: task.serverCostUsd != null ? task.serverCostUsd : '',
         submittedAt: task.submittedAt || 0, serverUpdatedAt: task.serverUpdatedAt || 0,
        historySaved: !!task.historySaved, base: task.base || '',
        requestPrompt: task.requestPrompt || '', requestNegative: task.requestNegative || '',
        prompt: task.prompt || '', negative: task.negative || '',
        preset: task.preset || '', capabilities:task.capabilities || null, responseFormat:task.responseFormat || '', stream:!!task.stream, resultWarning:task.resultWarning || '', model: task.model || '', videoModel: task.videoModel || '', size: task.size || '', imageSizeMode:task.imageSizeMode || 'preset',
        videoSeconds: task.videoSeconds || '', videoAspectRatio: task.videoAspectRatio || '', videoResolution: task.videoResolution || '',
        videoProgress: task.videoProgress || 0, videoUrl: task.videoUrl || '', videoMime: task.videoMime || '', providerId: task.providerId || '',
        n: task.n || 1, batchOf: task.batchOf || null, batchIdx: task.batchIdx || null, overshootId: task.overshootId || '', overshootTarget: task.overshootTarget || 0,
        quality: task.quality || '', complexity:task.complexity || '', background: task.background || '', outputFormat: task.outputFormat || '', resolution: task.resolution || '', seed: task.seed != null ? task.seed : '', colorCorrection: !!task.colorCorrection, resizeMethod: task.resizeMethod || '',
        x: Math.round(parseFloat(t.card.style.left) || 0),
        y: Math.round(parseFloat(t.card.style.top) || 0),
        hasBlob: !!((t.resultItems || []).some(item=> item && item.blob)),
        resultIndex: Number(t.resultIndex) || 0,
        resultRefs: (t.resultItems || []).map((item, i)=>({ index: Number.isInteger(Number(item && item.index)) ? Number(item.index) : i, key: item && item.blob ? 'canvas_' + task.id + '_' + i : '', url: item && item.remoteUrl ? String(item.remoteUrl).slice(0, 2048) : '' })).filter(item=> item.key || item.url),
        origUrl: (ri && (ri.remoteUrl || (ri.url && /^https?:/i.test(ri.url)))) ? (ri.remoteUrl || ri.url) : null,
        files: (task.files || []).map((f, i)=>({
          role: f.role || 'none',
          name: (f.file && f.file.name) || ('ref_' + i + '.png'),
          type: (f.file && f.file.type) || 'image/png',
          key: 'ref_' + task.id + '_' + i
        }))
      });
      // 结果图本体写入 IndexedDB（每任务只写一次，恢复时直接取本地原图）
      if(task.state === 'done' && t.resultItems && t.resultItems.length && !t.savedToIdb){
        const resultJobs = [];
        t.resultItems.forEach((item, i)=>{ if(item && item.blob) resultJobs.push(idbPut('canvas_' + task.id + '_' + i, item.blob)); });
        if(ri && ri.blob) resultJobs.push(idbPut('canvas_' + task.id, ri.blob));
        if(resultJobs.length) idbJobs.push(Promise.all(resultJobs).then(values=>{ if(values.every(Boolean)) t.savedToIdb = true; }));
      }
      (task.files || []).forEach((f, i)=>{
        const key = 'ref_' + task.id + '_' + i;
        currentRefKeys.add(key);
        const prev = state.savedRefFiles.get(key);
        if(f && f.file && prev !== f.file){
          state.savedRefFiles.set(key, f.file);
          idbJobs.push(idbPut(key, f.file).then(ok=>{ if(!ok && state.savedRefFiles.get(key) === f.file) state.savedRefFiles.delete(key); }));
        }
      });
    });
    const currentSessionKeys = new Set();
    state.currentFiles.forEach((f, i)=>{
      const key = 'session_ref_' + i;
      currentSessionKeys.add(key);
      const prev = state.savedSessionRefFiles.get(key);
      if(f && f.file && prev !== f.file){
        state.savedSessionRefFiles.set(key, f.file);
        idbJobs.push(idbPut(key, f.file).then(ok=>{ if(!ok && state.savedSessionRefFiles.get(key) === f.file) state.savedSessionRefFiles.delete(key); }));
      }
    });
    for(const key of Array.from(state.savedSessionRefFiles.keys())){
      if(!currentSessionKeys.has(key) || !state.savedSessionRefFiles.get(key)){
        state.savedSessionRefFiles.delete(key);
        idbJobs.push(idbDel(key));
      }
    }
    for(const key of Array.from(state.savedRefFiles.keys())){
      if(!currentRefKeys.has(key)) state.savedRefFiles.delete(key);
    }
    idbJobs.push(idbPrunePrefix('ref_', currentRefKeys));
    idbJobs.push(idbPrunePrefix('session_ref_', currentSessionKeys));
    const payload = {
      version:3, view:{ x:state.view.x, y:state.view.y, z:state.view.z }, taskSeq: state.taskSeq, tasks,
      overshoot: state.overshoot ? { id:state.overshoot.id, target:state.overshoot.target, attempts:state.overshoot.attempts, enqueued:state.overshoot.enqueued, phase:state.overshoot.phase, startedAt:state.overshoot.startedAt,
          safetyHandled: Number(state.overshoot.safetyHandled) || 0, safetyRefunded: Number(state.overshoot.safetyRefunded) || 0, safetyRefundMax: Number(state.overshoot.safetyRefundMax) || 0 } : null,
      refs: state.currentFiles.map((f, i)=>({
        role: f.role || 'none',
        name: (f.file && f.file.name) || ('ref_' + i + '.png'),
        type: (f.file && f.file.type) || 'image/png',
        key: 'session_ref_' + i
      }))
    };
    localStorage.setItem(LS_CANVAS, JSON.stringify(payload));
    if(idbJobs.length) Promise.all(idbJobs).catch(()=>{});
  }catch(e){ /* 空间不足等失败静默：画布仍可用，仅失去恢复能力 */ }
}

export async function restoreCanvas(){
  const saved = lsGet(LS_CANVAS, null);
  if(!saved || !Array.isArray(saved.tasks)) return;
  if(saved.overshoot && typeof saved.overshoot === 'object' && saved.overshoot.id){
    const phases = ['running','done','stopped','exhausted'];
    state.overshoot = {
      id: String(saved.overshoot.id),
      target: Math.max(1, Number(saved.overshoot.target) || 1),
      attempts: Math.max(0, Number(saved.overshoot.attempts) || 0),
      enqueued: Math.max(0, Number(saved.overshoot.enqueued) || 0),
      phase: phases.includes(String(saved.overshoot.phase)) ? String(saved.overshoot.phase) : 'done',
      startedAt: Number(saved.overshoot.startedAt) || 0,
            safetyHandled: Math.max(0, Number(saved.overshoot.safetyHandled) || 0),
            safetyRefunded: Math.max(0, Number(saved.overshoot.safetyRefunded) || 0),
            safetyRefundMax: Math.max(0, Number(saved.overshoot.safetyRefundMax) || Number(saved.overshoot.attempts) || 0),
      busy: false
    };
  }
  state.savedRefFiles.clear();
  state.savedSessionRefFiles.clear();
  saved.tasks.sort((a,b)=> a.id - b.id);
  let anyResult = false;
  for(const s of saved.tasks){
    if(!s || typeof s.x !== 'number' || typeof s.y !== 'number') continue;
    const hasJob = !!String(s.jobId || '').trim();
    const serverState = String(s.serverState || '');
    const serverRestoredState = serverState === 'queued' ? 'pending'
      : serverState === 'running' ? 'running'
      : serverState === 'done' && !s.hasBlob ? 'running'
      : serverState === 'cancelled' ? 'cancelled'
      : (serverState === 'error' || serverState === 'interrupted' || serverState === 'expired') ? 'error'
      : null;
    const legacyState = (s.state === 'error' || s.state === 'timeout' || s.state === 'cancelled') ? s.state : 'archived';
    const task = {
      id: s.id,
      // 有 job_id 的任务按后端状态恢复；旧版没有 job_id 的 pending/running 不猜测是否已提交。
      state: s.localQueued && !hasJob ? 'pending' : hasJob ? (serverRestoredState || (s.state === 'done' && s.hasBlob ? 'done' : 'running')) : legacyState,
      errorMsg: hasJob ? (s.serverError || '') : ((s.state === 'error' || s.state === 'timeout') ? ('（刷新前）' + (s.state === 'timeout' ? '请求超时' : '生成失败')) : ''),
      restoreNote: hasJob ? (serverState === 'done' && !s.hasBlob ? '正在恢复后台结果…' : '') : ((s.state === 'pending' || s.state === 'running') ? '刷新前未完成' : ''),
      mediaType: s.mediaType === 'video' ? 'video' : 'image', mode: s.mode || (s.mediaType === 'video' ? 'txt2video' : 'txt2img'), files: [],
      parentId: s.parentId || null, relation: s.relation || null,
      prompt: s.prompt || '', negative: s.negative || '',
      requestPrompt: s.requestPrompt || '', requestNegative: s.requestNegative || '',
      preset: s.preset || '',
      capabilities: s.capabilities || getImageModelCapabilities(s.model, getCapabilitiesForPreset(s.preset)),
      responseFormat:s.responseFormat || '', stream:!!s.stream, resultWarning:s.resultWarning || '',
      model: s.model || s.videoModel || '?', videoModel: s.videoModel || '', size: s.size || '?', imageSizeMode:s.imageSizeMode || 'preset',
      videoSeconds: s.videoSeconds || '', videoAspectRatio: s.videoAspectRatio || '', videoResolution: s.videoResolution || '',
      videoProgress: Number(s.videoProgress) || 0, videoUrl: s.videoUrl || '', videoMime: s.videoMime || '', providerId: s.providerId || '',
      n: s.n || 1, batchOf: s.batchOf || null, batchIdx: s.batchIdx || null, overshootId: s.overshootId || '', overshootTarget: Number(s.overshootTarget) || 0,
      serverTaskId: s.serverTaskId || '', serverErrorCode: s.serverErrorCode || '', serverMeta: s.serverMeta || null, serverResultUrls: Array.isArray(s.serverResultUrls) ? s.serverResultUrls.slice(0, 16) : [], serverSize: s.serverSize || '', serverResolution: s.serverResolution || '', serverQuality: s.serverQuality || '', serverImageCount: s.serverImageCount || 0, serverImageSizeTier: s.serverImageSizeTier || '', serverCostUsd: s.serverCostUsd != null ? s.serverCostUsd : '',
      quality: s.quality || '', complexity:s.complexity || '', background: s.background || '', outputFormat: s.outputFormat || '', resolution: s.resolution || '', seed: s.seed != null ? s.seed : '', colorCorrection: !!s.colorCorrection, resizeMethod: s.resizeMethod || '',
      base: s.base || '', key: '',
      clientTaskId: s.clientTaskId || null, jobId: s.jobId || '', serverTaskId: s.serverTaskId || '',
      serverState, serverError: s.serverError || '', serverErrorCode: s.serverErrorCode || '', serverMeta: s.serverMeta || null, submittedAt: s.submittedAt || 0,
      serverUpdatedAt: s.serverUpdatedAt || 0, historySaved: !!s.historySaved,
      localResultExpected: !!s.hasBlob,
      wasLocalQueued:!!s.localQueued, expectedReferenceCount:Array.isArray(s.files) ? s.files.length : 0,
      submitAbortController: null, serverWaitReject: null, cancelRequested: false
    };
    if(Array.isArray(s.files) && s.files.length){
      const restoredFiles = await Promise.all(s.files.map(async (fm, i)=>{
        const key = fm && fm.key ? fm.key : ('ref_' + task.id + '_' + i);
        const blob = await idbGet(key);
        if(!blob || !blob.size) return null;
        const file = fileFromBlob(blob, fm && fm.name, fm && fm.type);
        state.savedRefFiles.set(key, file);
        return { file, role:(fm && fm.role) || 'none' };
      }));
      task.files = restoredFiles.filter(Boolean);
      task.restoreNote = task.files.length === s.files.length ? task.restoreNote : '部分参考图未恢复';
    }
    state.taskSeq = Math.max(state.taskSeq, s.id);
    const card = createCard(task, { x:s.x, y:s.y, col:0 });
    const entry = { task, card, urls:[], resultItems:[], resultIndex:0 };
    state.taskEls[task.id] = entry;
    renderCardState(task);
    if(s.state === 'done'){
      anyResult = true;
      const resultRefs = Array.isArray(s.resultRefs) && s.resultRefs.length ? s.resultRefs : [{ index:0, key:s.hasBlob ? ('canvas_' + task.id) : '', url:s.origUrl || '' }];
      task.localResultExpected = resultRefs.length > 0;
      const fillRestoredResults = async()=>{
        const loaded = [];
        for(const ref of resultRefs){
          if(!ref || typeof ref !== 'object') continue;
          let blob = ref.key ? await idbGet(String(ref.key)) : null;
          if(!blob && ref.url){
            try{
              const response = await fetch(getRequestUrl(String(ref.url)));
              if(response.ok){ const candidate = await response.blob(); if(candidate && candidate.size) blob = candidate; }
            }catch(e){}
          }
          if(blob && blob.size) loaded.push({ index:Number(ref.index) || 0, blob, remoteUrl:String(ref.url || '') });
        }
        loaded.sort((a,b)=> a.index - b.index);
        if(loaded.length){
          loaded.forEach(item=>{
            const url = URL.createObjectURL(item.blob);
            entry.urls.push(url);
            entry.resultItems.push({ blob:item.blob, url, remoteUrl:item.remoteUrl, index:item.index, mime:item.blob.type || '', size:item.blob.size || 0 });
          });
          entry.resultIndex = Math.max(0, Math.min(entry.resultItems.length - 1, Number(s.resultIndex) || 0));
          task.localResultExpected = false;
          task.state = 'done';
          task.serverState = task.serverState || 'done';
          task.restoreNote = '';
          entry.savedToIdb = true;
          renderCardState(task);
        }else{
          task.localResultExpected = false;
          if(task.jobId) watchRemoteTask(task, entry);
          else { task.state = 'archived'; task.restoreNote = '本地结果未恢复'; renderCardState(task); }
        }
      };
      fillRestoredResults().catch(()=>{ task.localResultExpected = false; if(task.jobId) watchRemoteTask(task, entry); });
    }
  }
  // 血缘连线重建
  saved.tasks.forEach(s=>{
    if(s && s.parentId != null && s.relation && state.taskEls[s.id] && state.taskEls[s.parentId]){
      addLink(s.parentId, s.id, s.relation);
    }
  });
  if(saved.view && typeof saved.view.z === 'number'){ state.view.x = saved.view.x || 0; state.view.y = saved.view.y || 0; state.view.z = saved.view.z || 1; }
  if(Array.isArray(saved.refs) && saved.refs.length){
    const restoredRefs = await Promise.all(saved.refs.map(async (rm, i)=>{
      const key = rm && rm.key ? rm.key : ('session_ref_' + i);
      const blob = await idbGet(key);
      if(!blob || !blob.size) return null;
      const file = fileFromBlob(blob, rm && rm.name, rm && rm.type);
      state.savedSessionRefFiles.set(key, file);
      return { file, role:(rm && rm.role) || 'none', url:URL.createObjectURL(file) };
    }));
    state.currentFiles.forEach(f=>{ try{ URL.revokeObjectURL(f.url); }catch(e){} });
    state.currentFiles = restoredRefs.filter(Boolean);
    renderRefStrip();
  }
  rebuildColumns();
  updateEmpty();
  applyView();
  // 画布卡片已建立后再接管后端任务，避免轮询回调找不到对应 entry。
  const serverEntries = Object.keys(state.taskEls)
    .map(id=> state.taskEls[id])
    .filter(entry=> entry && entry.task && (entry.task.jobId || entry.task.clientTaskId));
  for(const entry of serverEntries){
    const task = entry.task;
    if(task.mediaType === 'video'){
      if(task.jobId && !entry.resultItems.length && !task.localResultExpected && !['cancelled','error','expired','interrupted'].includes(task.serverState)){
        await resumeVideoTask(task, entry);
      }
    }else if(task.jobId){
      const hasLocalResult = entry.resultItems.length > 0;
      if(!hasLocalResult && !task.localResultExpected) watchRemoteTask(task, entry);
    }else if(task.clientTaskId && (task.serverState === 'submitting' || task.state === 'pending')){
      await resumeUnboundTask(task, entry);
    }
  }
  if(anyResult) toast('🖼 画布已恢复，原图正在本地回填', 'ok');
}

export async function downloadBlob(blob, name, meta){
  let target = blob;
  if(meta && blob.type === 'image/png'){
    try{
      const buf = new Uint8Array(await blob.arrayBuffer());
      const out = pngInsertText(buf, 'ai:params', b64encodeUtf8(JSON.stringify(meta)));
      if(out) target = new Blob([out], { type:'image/png' });
    }catch(e){}
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(target); a.download = name; a.click();
  setTimeout(()=> URL.revokeObjectURL(a.href), 3000);
}

export function idbOpen(){
  if(state.idbDb) return Promise.resolve(state.idbDb);
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = ()=>{
      state.idbDb = req.result;
      state.idbDb.onclose = ()=>{ state.idbDb = null; };
      resolve(state.idbDb);
    };
    req.onerror = ()=> reject(req.error);
  });
}

export async function idbPut(key, blob){
  try{
    const db = await idbOpen();
    return new Promise((resolve, reject)=>{
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(blob, key);
      tx.oncomplete = ()=> resolve(true);
      tx.onerror = ()=> reject(tx.error);
    });
  }catch(e){ return false; }
}

export async function idbGet(key){
  try{
    const db = await idbOpen();
    return new Promise((resolve, reject)=>{
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      req.onsuccess = ()=> resolve(req.result || null);
      req.onerror = ()=> reject(req.error);
    });
  }catch(e){ return null; }
}

export async function idbDel(key){
  try{
    const db = await idbOpen();
    return new Promise(resolve=>{
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = ()=> resolve();
      tx.onerror = ()=> resolve();
    });
  }catch(e){}
}

export async function idbClearPrefix(prefix){
  // 按 key 前缀批量删除（用于清空画布时一并清除历史遗留孤儿原图）
  try{
    const db = await idbOpen();
    return new Promise(resolve=>{
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.openCursor();
      req.onsuccess = ()=>{
        const cur = req.result;
        if(!cur){ resolve(); return; }
        if(String(cur.key).startsWith(prefix)) cur.delete();
        cur.continue();
      };
      req.onerror = ()=> resolve();
    });
  }catch(e){}
}

export async function idbPrunePrefix(prefix, keepKeys){
  try{
    const keep = keepKeys instanceof Set ? keepKeys : new Set(keepKeys || []);
    const db = await idbOpen();
    return new Promise(resolve=>{
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.openCursor();
      req.onsuccess = ()=>{
        const cur = req.result;
        if(!cur){ resolve(); return; }
        const key = String(cur.key);
        if(key.startsWith(prefix) && !keep.has(key)) cur.delete();
        cur.continue();
      };
      req.onerror = ()=> resolve();
      tx.onerror = ()=> resolve();
    });
  }catch(e){}
}

export function releaseCanvasBlob(taskId){
  const key = 'canvas_' + taskId;
  idbGet(key).then(blob=>{
    idbDel(key);
    if(!blob) return;
    const hist = lsGet(LS_HIST, []);
    hist.forEach(h=>{
      if(h && h.origType === 'canvas' && h.origKey === key){
        h.origType = 'idb';
        h.origKey = '';
        idbPut(h.id, blob);
      }
    });
    lsSet(LS_HIST, hist);
  }).catch(()=>{});
}

export async function processHistQueue(){
  if(state.writingHist) return;
  state.writingHist = true;
  while(state.histQueue.length){
    const job = state.histQueue.shift();
    try{ await job(); }catch(e){ console.error('历史写入失败', e); }
  }
  state.writingHist = false;
}

export function thumbFromImage(imgPromise){
  return imgPromise.then(img=>{
    if(!img || !img.width) return null;
    try{
      const scale = THUMB_W / Math.max(img.width, img.height);
      const w = Math.max(1, Math.round(img.width*scale));
      const h = Math.max(1, Math.round(img.height*scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c.toDataURL('image/jpeg', THUMB_Q);
    }catch(e){ return null; }
  });
}

export function thumbViaServer(b64, maxSide){
  return fetch('/api/thumb', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ b64: cleanB64(b64), maxSide: maxSide || 320 })
  }).then(r=> r.ok ? r.json() : null)
    .then(d=> (d && d.b64) ? d.b64 : null)
    .catch(()=> null);
}

export function makeThumb(b64){
  // 服务器模式下优先用后端 Pillow 压缩（大图 4K 也能稳定出缩略图），失败回退浏览器 canvas
  return thumbViaServer(b64).then(serverThumb=>{
    if(serverThumb) return serverThumb;
    let blob;
    try{ blob = b64ToBlob(b64); }catch(e){ return null; }
    const u = URL.createObjectURL(blob);
    return thumbFromImage(new Promise(resolve=>{
      const img = new Image();
      img.onload = ()=>{ resolve(img); setTimeout(()=> URL.revokeObjectURL(u), 2000); };
      img.onerror = ()=>{ resolve(null); URL.revokeObjectURL(u); };
      img.src = u;
    }));
  });
}

export function makeThumbFromUrl(url){
  return thumbFromImage(new Promise(resolve=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    // 远程图床常无 CORS 头，走本地代理加载可稳定生成缩略图
    img.src = getRequestUrl(url);
    img.onload = ()=> resolve(img);
    img.onerror = ()=> resolve(null);
  }));
}

export function makeThumbFromVideo(blobOrUrl){
  return new Promise(resolve=>{
    const video = document.createElement('video');
    let objectUrl = '';
    const source = blobOrUrl instanceof Blob ? (objectUrl = URL.createObjectURL(blobOrUrl)) : getRequestUrl(String(blobOrUrl || ''));
    let settled = false;
    const finish = value=>{
      if(settled) return;
      settled = true;
      if(objectUrl) URL.revokeObjectURL(objectUrl);
      video.removeAttribute('src');
      video.load();
      resolve(value || null);
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.onloadeddata = ()=>{
      try{
        const w = video.videoWidth || 320, h = video.videoHeight || 180;
        const scale = THUMB_W / Math.max(w, h);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        finish(c.toDataURL('image/jpeg', THUMB_Q));
      }catch(e){ finish(null); }
    };
    video.onerror = ()=> finish(null);
    video.src = source;
    video.load();
    setTimeout(()=> finish(null), 12000);
  });
}

export function saveHistory(items, task){
  state.histQueue.push(async ()=>{
    const hist = lsGet(LS_HIST, []);
    const jobs = items.map(async it=>{
      if(!it.b64_json && !it.url && !it.blob) return null;
      const id = 'h' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const rec = { id, thumb:null, mediaType:task.mediaType || 'image', prompt:String(task.prompt||''), negative:String(task.negative||''), model:task.model || task.videoModel || '', videoModel:task.videoModel || '', size:task.size || '', resolution:task.resolution || '', quality:task.quality || '', background:task.background || '', outputFormat:task.outputFormat || '', serverSize:task.serverSize || '', serverResolution:task.serverResolution || '', serverQuality:task.serverQuality || '', serverImageCount:task.serverImageCount || 0, serverImageSizeTier:task.serverImageSizeTier || '', serverCostUsd:task.serverCostUsd != null ? task.serverCostUsd : '', videoSeconds:task.videoSeconds || '', videoAspectRatio:task.videoAspectRatio || '', videoResolution:task.videoResolution || '', mode:task.mode, ts:new Date().toLocaleString() };
      if(it.blob){
        if(rec.mediaType === 'video' || String(it.blob.type || '').startsWith('video/')) rec.thumb = await makeThumbFromVideo(it.blob);
        else {
          const u = URL.createObjectURL(it.blob);
          rec.thumb = await makeThumbFromUrl(u);
          URL.revokeObjectURL(u);
        }
        if(await idbPut(id, it.blob)) rec.origType = 'idb'; else rec.origType = 'thumb';
      }else if(it.b64_json){
        const b64 = cleanB64(it.b64_json);
        rec.thumb = await makeThumb(b64);
        let blob = null;
        try{ blob = b64ToBlob(b64); }catch(e){}
        if(blob && await idbPut(id, blob)){
          rec.origType = 'idb';
        }else{
          rec.origType = 'thumb';
        }
      }else if(it.url){
        rec.origType = 'url';
        rec.origUrl = it.url;
        rec.thumb = rec.mediaType === 'video' ? await makeThumbFromVideo(it.url) : await makeThumbFromUrl(it.url);
        try{
          const blob = await fetch(getRequestUrl(it.url)).then(r=> r.blob());
          if(blob && blob.size > 0 && await idbPut(id, blob)){
            rec.origType = 'idb';
          }
        }catch(e){ /* 下载失败时保留 url 引用 */ }
      }
      return rec;
    });
    const recs = (await Promise.all(jobs)).filter(Boolean);
    recs.forEach(r=> hist.unshift(r));
    const trimmed = hist.slice(0, MAX_HIST);
    const dropped = hist.slice(MAX_HIST);
    dropped.forEach(r=>{ if(r && r.origType==='idb') idbDel(r.id); });
    if(!lsSet(LS_HIST, trimmed)) toast('⚠️ 本地空间不足，历史未保存（图片仍可下载）', 'err');
    else if(dropped.length) toast('历史已满，移除最早 ' + dropped.length + ' 条', 'ok');
  });
  processHistQueue();
}

export function delHistItem(h){
  const list = lsGet(LS_HIST, []).filter(x=> x.id !== h.id);
  lsSet(LS_HIST, list);
  if(h && h.origType === 'idb') idbDel(h.id);
  renderLib();
  toast('已删除该素材', 'ok');
}

export function renderLib(){
  const hist = lsGet(LS_HIST, []);
  el.libGrid.innerHTML = '';
  const q = state.histQuery.trim().toLowerCase();
  let list = hist;
  if(state.histFavOnly) list = list.filter(h=> h.fav);
  if(q) list = list.filter(h=> ((h.prompt||'') + ' ' + (h.negative||'') + ' ' + (h.model||'') + ' ' + (h.size||'') + ' ' + (h.ts||'')).toLowerCase().indexOf(q) > -1);
  if(!list.length){
    el.libGrid.innerHTML = '<div class="lib-none">' + (hist.length ? '没有匹配的素材' : '暂无素材<br>生成的图片会自动归档到这里') + '</div>';
    return;
  }
  list.forEach(h=>{
    const d = document.createElement('div');
    d.className = 'lib-item';
    if(h.thumb){
      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'lib-thumb' + (h.mediaType === 'video' ? ' video' : '');
      const img = document.createElement('img'); img.src = h.thumb;
      thumbWrap.appendChild(img);
      if(h.mediaType === 'video'){
        const play = document.createElement('span'); play.className = 'lib-play'; play.innerHTML = ICO.play; thumbWrap.appendChild(play);
      }
      d.appendChild(thumbWrap);
    }else{
      const ph = document.createElement('div'); ph.className = 'empty' + (h.mediaType === 'video' ? ' video' : ''); ph.innerHTML = h.mediaType === 'video' ? ICO.film : ICO.image;
      d.appendChild(ph);
    }
    const tag = document.createElement('div');
    tag.className = 'tag';
    const hdetail = h.mediaType === 'video' ? ((h.videoSeconds || '6') + '秒 · ' + (h.videoAspectRatio || '16:9')) : ((h.serverSize || h.serverResolution || h.size || '') + (h.serverImageSizeTier ? ' · ' + h.serverImageSizeTier : ''));
    tag.textContent = (h.fav ? '★ ' : '') + (h.model || '') + ' · ' + hdetail;
    d.appendChild(tag);
    const fav = document.createElement('button');
    fav.className = 'lib-fav' + (h.fav ? ' on' : '');
    fav.innerHTML = ICO.star;
    fav.title = '收藏/取消收藏';
    fav.onclick = e=>{ e.stopPropagation(); h.fav = !h.fav; const hist2 = lsGet(LS_HIST, []); const i2 = hist2.findIndex(x=> x.id===h.id); if(i2 > -1){ hist2[i2] = h; lsSet(LS_HIST, hist2); } renderLib(); };
    d.appendChild(fav);
    const del = document.createElement('button');
    del.className = 'lib-del';
    del.textContent = '✕';
    del.title = '删除该素材';
    del.onclick = e=>{ e.stopPropagation(); delHistItem(h); };
    d.appendChild(del);
    d.onclick = ()=> openLibDetail(h);
    // 长按素材 → 直接局部修改（不弹大图）
    let lpTimer = null;
    const lpCancel = ()=>{ if(lpTimer){ clearTimeout(lpTimer); lpTimer = null; } };
    d.addEventListener('pointerdown', ()=>{
      lpCancel();
      lpTimer = setTimeout(()=>{
        lpTimer = null;
        if(state.hooks && state.hooks.paintHist) state.hooks.paintHist(h);
      }, 520);
    });
    d.addEventListener('pointerup', lpCancel);
    d.addEventListener('pointercancel', lpCancel);
    d.addEventListener('pointermove', lpCancel);
    el.libGrid.appendChild(d);
  });
}

export function thumbFromUrl(url){
  return thumbFromImage(new Promise(resolve=>{
    const img = new Image();
    img.onload = ()=> resolve(img);
    img.onerror = ()=> resolve(null);
    img.src = url;
  }));
}

export async function clearCanvas(){
  if(!confirm('确定清空整个画布吗？\n将删除全部卡片、血缘连线与本地原图（IndexedDB），此操作无法撤销。')) return;
  // 取消后端任务并停止轮询；后端请求与页面生命周期已解耦，不能只 abort 浏览器请求。
  abortAllTasks();
  Object.keys(state.taskEls).forEach(id=>{
    const t = state.taskEls[id];
    if(!t) return;
    if(t.task.mediaType === 'video'){
      const stopVideo = state.hooks && state.hooks.stopVideoTaskWatch;
      if(stopVideo && t.task.jobId) stopVideo(t.task.jobId);
      if(state.videoWatches && t.task.jobId) state.videoWatches.delete(t.task.jobId);
    }else if(t.task.jobId) stopTaskWatch(t.task.jobId);
    if(t.task.submitAbortController) t.task.submitAbortController.abort();
  });
  // 撤销图片引用、删除连线与卡片
  Object.keys(state.taskEls).forEach(id=>{
    const t = state.taskEls[id];
    if(!t) return;
    t.urls.forEach(u=> URL.revokeObjectURL(u));
    removeLinksOf(t.task.id);
    t.card.remove();
  });
  state.taskEls = {};
  state.taskQueue.length = 0;
  if(state.taskWatches) state.taskWatches.clear();
  state.colH.length = 0;
  if(state.saveTimer){ clearTimeout(state.saveTimer); state.saveTimer = null; }
  const hist = lsGet(LS_HIST, []);
  await Promise.all(hist.map(async h=>{
    if(h && h.origType === 'canvas' && h.origKey){
      const blob = await idbGet(h.origKey);
      if(blob){ h.origType = 'idb'; h.origKey = ''; await idbPut(h.id, blob); }
    }
  })).catch(()=>{});
  lsSet(LS_HIST, hist);
  localStorage.removeItem(LS_CANVAS);
  await Promise.all([idbClearPrefix('canvas_'), idbClearPrefix('ref_'), idbClearPrefix('session_ref_')]);
  state.savedRefFiles.clear();
  state.savedSessionRefFiles.clear();
  state.skipAutosave = true;
  state.view.x = 24; state.view.y = 24; state.view.z = 1;
  applyView();
  state.skipAutosave = false;
  updateEmpty();
  toast('🗑 画布已清空（含本地原图）', 'ok');
}

export async function clearByState(){
  const targets = ['error', 'timeout', 'cancelled', 'archived'];
  const STALE_SUBMIT_MS = 90000;
  const now = Date.now();
  const all = Object.keys(state.taskEls).filter(id=>{
    const t = state.taskEls[id];
    if(!t) return false;
    const task = t.task;
    if(targets.includes(task.state)) return true;
    if(task.state === 'pending'){
      if(task.jobId) return true;
      const started = Number(task.startTs) || 0;
      return started > 0 && (now - started) > STALE_SUBMIT_MS;
    }
    return false;
  });
  if(!all.length){ toast('没有失败 / 超时 / 已取消 / 中断的卡片', 'ok'); return; }
  if(!confirm('将先核对每张卡的服务器/上游真实状态：\n· 已成功生成的自动找回结果\n· 仍在处理的保留并继续跟踪\n· 确认无结果的才清理\n\n共 ' + all.length + ' 张候选卡（失败 / 超时 / 已取消 / 中断 / 提交僵死），继续吗？')) return;
  const purgeServer = confirm('是否同时清理本机服务器上的任务记录与结果文件？\n· 只作用于本机生图服务器，不触碰上游中转站\n· 点「确定」= 一并清理；点「取消」= 只清理画布卡片');
  const btn = el && el.btnClearByState;
  const oldText = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; (btn.querySelector('.lbl')||btn).textContent = '核对中…'; }
  let recovered = 0, kept = 0, cleared = 0, failed = 0, purged = 0;
  try{
    for(const id of all){
      const t = state.taskEls[id];
      if(!t) continue;
      if(t.task.mediaType === 'video'){
        if(purgeServer && t.task.jobId){
          try{ const res = await forgetServerTask(t.task.jobId, serverOptions()); if(res && res.forgotten) purged++; }catch(err){}
        }
        removeCard(t.task);
        cleared++;
        continue;
      }
      try{
        const outcome = await reconcileBeforeClear(t.task, t);
        if(outcome === 'recovered') recovered++;
        else if(outcome === 'kept') kept++;
        else {
          if(purgeServer && t.task.jobId){
            try{ const res = await forgetServerTask(t.task.jobId, serverOptions()); if(res && res.forgotten) purged++; }catch(err){}
          }
          removeCard(t.task);
          cleared++;
        }
      }catch(err){
        failed++;
      }
    }
  }finally{
    if(btn){ btn.disabled = false; (btn.querySelector('.lbl')||btn).textContent = oldText || '核对并清理'; }
  }
  const parts = [];
  if(recovered) parts.push('找回 ' + recovered + ' 张');
  if(kept) parts.push('保留跟踪 ' + kept + ' 张');
  if(cleared) parts.push('清理 ' + cleared + ' 张');
  if(purged) parts.push('服务端清理 ' + purged + ' 条');
  if(failed) parts.push('核对失败保留 ' + failed + ' 张');
  toast('🧹 核对完成：' + (parts.length ? parts.join('、') : '没有可清理的卡片'), parts.length ? 'ok' : 'err');
}

function siteHostOf(url){
  try{ return new URL(String(url || '')).hostname.toLowerCase(); }catch(err){ return ''; }
}

function effectiveServerCreds(task){
  const panelBase = el && el.apiBase ? el.apiBase.value.trim().replace(/\/+$/,'') : '';
  const panelKey = el && el.apiKey ? el.apiKey.value.trim() : '';
  const cardBase = String(task.base || '').trim().replace(/\/+$/,'');
  const cardKey = String(task.key || '').trim();
  const cardHost = siteHostOf(cardBase);
  const panelHost = siteHostOf(panelBase);
  const sameSite = !!cardHost && !!panelHost && cardHost === panelHost;
  return {
    base: sameSite ? (cardBase || panelBase) : (panelBase || cardBase),
    key: sameSite ? (cardKey || panelKey) : (panelKey || cardKey),
    panelKey: panelKey
  };
}

async function reconcileBeforeClear(task, entry){
  const creds = effectiveServerCreds(task);
  if(task.jobId){
    let status = null;
    try{
      status = await getTaskStatus(task.jobId, serverOptions());
    }catch(err){
      if(!(err && Number(err.status) === 404)) throw err;
      status = null;
    }
    if(!status) return 'clear';
    if(status.state === 'done'){
      await fillRemoteResults(task, entry, status);
      return 'recovered';
    }
    if(status.state === 'queued' || status.state === 'running'){
      watchRemoteTask(task, entry);
      return 'kept';
    }
    const providerId = extractTaskServerMeta(status).providerTaskId || task.serverTaskId || '';
    if(providerId && (status.state === 'cancelled' || status.state === 'error' || status.state === 'interrupted' || status.state === 'expired')){
      const attempts = [];
      if(creds.key) attempts.push(creds.key);
      if(creds.panelKey && creds.panelKey !== creds.key) attempts.push(creds.panelKey);
      for(const key of attempts){
        try{
          const resumed = await resumeServerTask(task.jobId, serverOptions({ apiKey: key, baseUrl: creds.base }));
          if(resumed && resumed.state === 'done'){
            await fillRemoteResults(task, entry, resumed);
            return 'recovered';
          }
          if(resumed && (resumed.state === 'queued' || resumed.state === 'running')){
            watchRemoteTask(task, entry);
            return 'kept';
          }
          break;
        }catch(err){}
      }
    }
    return 'clear';
  }
  if(task.clientTaskId){
    let rec = null;
    try{
      rec = await fetchTaskByClient(task.clientTaskId, serverOptions());
    }catch(err){
      if(!(err && Number(err.status) === 404)) throw err;
      rec = null;
    }
    if(!rec) return 'clear';
    task.jobId = rec.jobId || '';
    scheduleAutosave();
    if(rec.state === 'done'){
      await fillRemoteResults(task, entry, rec);
      return 'recovered';
    }
    if(rec.state === 'queued' || rec.state === 'running'){
      watchRemoteTask(task, entry);
      return 'kept';
    }
    return 'kept';
  }
  return 'clear';
}
