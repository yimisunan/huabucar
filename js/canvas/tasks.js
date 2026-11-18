import { ICO } from './icons.js';
import { findImageSize, resolveImageSize } from './imageSizes.js';
import { MAX_PIXELS } from './state.js';
import { toast, cleanB64, b64ToBlob, fileFromBlob, mimeToExt, copyText } from './util.js';
import { getCapabilities, getMaxReferences, getCapNum, getSelectedImageModel, maybeRefreshLiveModels, getCapabilitiesForPreset, applyPreset, syncImageParamOptions, syncGifHint } from './settings.js';
import { setMode, renderTierTabs, renderSizes, renderVideoParams, syncQuickRow } from './params.js';
import { renderRefStrip, addRefFromBlob } from './refs.js';
import { normalizePromptAndNegative, buildRequestPrompt, autosize } from './prompts.js';
import { getTaskResult } from './paint.js';
import { submitServerTask, fetchTaskResults, getTaskResultUrl, cancelServerTask, ensureClientTaskId, watchServerTask, stopTaskWatch, extractTaskServerMeta, resumeServerTask, fetchTaskByClient } from './serverTasks.js';
import { uiConfirm, syncTopbarHud } from './ui-studio.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }
const callHook = (name, ...args) => state && state.hooks && state.hooks[name] ? state.hooks[name](...args) : undefined;
function renderCardState(task){ return callHook('renderCardState', task); }
function nextSlot(){ return callHook('nextSlot'); }
function createCard(task, slot){ return callHook('createCard', task, slot); }
function updateCol(col, y, h){ return callHook('updateCol', col, y, h); }
function addLink(fromId, toId, rel){ return callHook('addLink', fromId, toId, rel); }
function ensureVisible(x, y, force){ return callHook('ensureVisible', x, y, force); }
function rebuildColumns(){ return callHook('rebuildColumns'); }
function removeLinksOf(id){ return callHook('removeLinksOf', id); }
function scheduleAutosave(){ return callHook('scheduleAutosave'); }
function releaseCanvasBlob(id){ return callHook('releaseCanvasBlob', id); }
function idbClearPrefix(prefix, keep){ return callHook('idbClearPrefix', prefix, keep); }
function saveHistory(items, task){ return callHook('saveHistory', items, task); }
function openDrawer(name){ return callHook('openDrawer', name); }
function runVideoHook(name, ...args){
  return state && state.hooks && typeof state.hooks[name] === 'function' ? state.hooks[name](...args) : undefined;
}

function runVideoTask(task){
  return runVideoHook('runVideoTask', task);
}

function cancelVideoEntry(task){
  return runVideoHook('cancelVideoEntry', task);
}

function proxyToken(){
  return el && el.proxyToken ? String(el.proxyToken.value || '').trim() : '';
}

function serverOptions(extra){
  const options = { ...(extra || {}) };
  const token = proxyToken();
  if(token && !Object.prototype.hasOwnProperty.call(options, 'proxyToken')) options.proxyToken = token;
  return options;
}

function taskIsServerActive(task){
  return !!(task && task.mediaType !== 'video' && task.jobId && (task.serverState === 'queued' || task.serverState === 'running'));
}

function clearTaskResult(entry){
  if(!entry) return;
  entry.urls.forEach(u=>{ try{ URL.revokeObjectURL(u); }catch(e){} });
  entry.urls = [];
  entry.resultItems = [];
  entry.resultIndex = 0;
}

function applyServerStatus(task, status) {
  if(!task || !status) return;
  const meta = extractTaskServerMeta(status);
  const rawError = status.error;
  const errorText = rawError && typeof rawError === 'object' ? (rawError.message || rawError.detail || '') : rawError;
  task.jobId = status.jobId || status.job_id || task.jobId || '';
  task.resultWarning = status.resultWarning || status.meta && status.meta.result_warning || '';
  task.serverTaskId = meta.providerTaskId || task.serverTaskId || '';
  task.serverState = status.state || status.status || task.serverState || '';
  task.serverError = String(errorText || '');
  task.serverErrorCode = meta.errorCode || status.errorCode || status.error_code || task.serverErrorCode || '';
  task.serverMeta = meta;
  task.serverResultUrls = meta.resultUrls;
  task.serverSize = meta.size || task.serverSize || '';
  task.serverResolution = meta.resolution || task.serverResolution || '';
  task.serverQuality = meta.quality || task.serverQuality || '';
  task.serverImageCount = meta.imageCount || task.serverImageCount || 0;
  task.serverImageSizeTier = meta.imageSizeTier || task.serverImageSizeTier || '';
  if(meta.costUsd !== '' && meta.costUsd != null) task.serverCostUsd = meta.costUsd;
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
  renderCardState(task);
  if(state.overshoot && task.overshootId) updateOvershootUI();
}

function cancelRemoteTask(task){
  if(!task || !task.jobId) return Promise.resolve(null);
  return cancelServerTask(task.jobId, serverOptions()).then(status=>{
    if(status.cancelResult === 'cancelled'){
      stopTaskWatch(task.jobId);
      if(state.taskWatches) state.taskWatches.delete(task.jobId);
      if(task.serverWaitReject) task.serverWaitReject(new Error('任务已取消'));
    }
    applyServerStatus(task, status);
    scheduleAutosave();
    return status;
  }).catch(err=>{
    task.cancelRequested = false;
    task.restoreNote = '取消未确认，继续核对原任务';
    task.serverError = err.message || String(err);
    renderCardState(task);
    scheduleAutosave();
    return null;
  });
}

async function verifySubmittedCancel(task){
  // 提交被中断：只读核对服务器是否已受理（不会创建新任务），再决定真取消或接管跟踪
  const t0 = state.taskEls[task.id];
  if(!t0) return;
  if(!task.clientTaskId){
    task.state = 'cancelled';
    task.serverState = 'cancelled';
    task.errorMsg = '任务已取消';
    renderCardState(task);
    scheduleAutosave();
    notifyOvershootSettled(task);
    return;
  }
  try{
    let rec = null;
    for(let attempt = 0; attempt < 3; attempt++){
      await new Promise(r=> setTimeout(r, attempt === 0 ? 1200 : 2200));
      if(!state.taskEls[task.id]) return;
      try{
        rec = await fetchTaskByClient(task.clientTaskId, serverOptions());
        break;
      }catch(err){
        if(err && Number(err.status) === 404){ rec = null; continue; }
        throw err;
      }
    }
    if(!rec){
      task.state = 'cancelled';
      task.serverState = 'cancelled';
      task.errorMsg = '任务已取消';
      renderCardState(task);
      scheduleAutosave();
      notifyOvershootSettled(task);
      return;
    }
    task.cancelRequested = false;
    task.jobId = rec.jobId || task.jobId || '';
    applyServerStatus(task, rec);
    scheduleAutosave();
    if(rec.state === 'queued'){
      try{
        const st = await cancelServerTask(task.jobId, serverOptions());
        if(st && st.cancelResult === 'cancelled'){
          applyServerStatus(task, st);
          scheduleAutosave();
          toast('✅已取消排队任务（未开始生成）', 'ok');
          notifyOvershootSettled(task);
          return;
        }
        applyServerStatus(task, st || rec);
      }catch(e){}
      toast('⚠️任务已开始生成，无法取消；将继续完成并保留结果', 'err');
      void resumeWaiting(task);
      return;
    }
    if(rec.state === 'running'){
      toast('⚠️任务已开始生成，无法取消；将继续完成并保留结果', 'err');
      void resumeWaiting(task);
      return;
    }
    if(rec.state === 'done'){
      toast('✅任务其实已完成，正在找回结果…', 'ok');
      try{
        const results = await fetchTaskResults(rec, serverOptions());
        if(results.length){ await applyLoadedResult(task, rec, results); notifyOvershootSettled(task); return; }
      }catch(e){}
      void resumeWaiting(task);
      return;
    }
    toast('任务状态「' + rec.state + '」，正在核对…', 'err');
    void recoverTask(task);
  }catch(err){
    task.state = 'cancelled';
    task.serverState = task.serverState || 'cancelled';
    task.errorMsg = '取消确认失败，可点「恢复」核对';
    renderCardState(task);
    scheduleAutosave();
    notifyOvershootSettled(task);
  }
}

async function resumeWaiting(task){
  const t = state.taskEls[task.id];
  if(!t || !task.jobId) return;
  if(task.serverWaitReject) return;
  try{
    const packed = await waitForServerTask(task);
    await applyLoadedResult(task, packed.status, packed.results);
  }catch(err){
    if(task.cancelRequested) return;
    task.state = 'error';
    task.serverState = task.serverState || 'error';
    task.serverError = err && err.message ? err.message : String(err);
    task.errorMsg = task.serverError;
    renderCardState(task);
    scheduleAutosave();
    notifyOvershootSettled(task);
  }
}

function waitForServerTask(task){
  return new Promise((resolve, reject)=>{
    let handle = null;
    let settled = false;

    const finish = (fn, value)=>{
      if(settled) return;
      settled = true;
      if(handle) handle.stop();
      if(task.jobId && state.taskWatches) state.taskWatches.delete(task.jobId);
      task.serverWaitReject = null;
      fn(value);
    };

    task.serverWaitReject = value=> finish(reject, value || new Error('任务已取消'));

    //404 不代表任务真的失败：记录可能被清理或 job_id 漂移，先按 clientTaskId 核对再判定。
    const restartWatch = jobId => {
      if(settled) return;
      try{ if(handle) handle.stop(); }catch(e){}
      task.jobId = jobId;
      try{
        handle = watchServerTask(jobId, callbacks, serverOptions());
        if(state.taskWatches) state.taskWatches.set(jobId, handle);
      }catch(e){
        finish(reject, e);
      }
    };

    const verifyMissingRecord = notFoundError => {
      if(settled || task.missingCheck) return;
      task.missingCheck = true;
      task.restoreNote = '任务记录缺失，正在核对…';
      renderCardState(task);
      Promise.resolve().then(async ()=>{
        let rec = null, verifyError = null;
        try{
          if(task.clientTaskId) rec = await fetchTaskByClient(task.clientTaskId, serverOptions());
        }catch(e){
          verifyError = e;
        }
        if(settled) return;
        task.missingCheck = false;
        task.restoreNote = '';
        if(rec){
          const st = String(rec.state || '');
          if(st === 'done'){
            try{
              const results = await fetchTaskResults(rec, serverOptions());
              if(results.length){ finish(resolve, { status:rec, results }); return; }
            }catch(e){}
          }else if(st === 'queued' || st === 'running'){
            applyServerStatus(task, rec);
            renderCardState(task);
            scheduleAutosave();
            restartWatch(rec.jobId || task.jobId);
            return;
          }else{
            applyServerStatus(task, rec);
            finish(reject, new Error(rec.error || ('后台任务结束：' + st)));
            return;
          }
        }
        if(verifyError && Number(verifyError.status) !== 404){
          renderCardState(task);
          scheduleAutosave();
          return;
        }
        finish(reject, notFoundError);
      });
    };

    const callbacks = {
      onStatus(status){
        if(settled) return;
        applyServerStatus(task, status);
        scheduleAutosave();
      },
      async onDone(status){
        if(settled) return;
        try{
          applyServerStatus(task, status);
          const results = await fetchTaskResults(status, serverOptions());
          if(!results.length) throw new Error('后台任务完成但没有可用图片结果');
          finish(resolve, { status, results });
        }catch(err){
          finish(reject, err);
        }
      },
      onTerminal(status){
        if(settled) return;
        applyServerStatus(task, status);
        finish(reject, new Error(status.error || ('后台任务结束：' + status.state)));
      },
      onError(err){
        if(settled || task.cancelRequested) return;
        task.serverError = err && err.message ? err.message : String(err);
        // 认证、任务不存在和结果过期属于不可通过轮询自行恢复的错误；网络错误继续退避重试。
        if(Number(err && err.status) === 404){
          verifyMissingRecord(err);
          return;
        }
        if(err && [401, 403, 410].includes(Number(err.status))){
          finish(reject, err);
        }else{
          renderCardState(task);
          scheduleAutosave();
        }
      }
    };

    try{
      handle = watchServerTask(task.jobId, callbacks, serverOptions());
      if(state.taskWatches) state.taskWatches.set(task.jobId, handle);
    }catch(err){
      finish(reject, err);
    }
  });
}

export function buildTask(opts){
  const capabilities = { ...(opts.capabilities || {}) };
  const sizeCaps = opts.preset ? getCapabilitiesForPreset(opts.preset) : capabilities;
  if(sizeCaps?.imageSizePolicy === 'change2pro-studio'){
    capabilities.imageSizePolicy = sizeCaps.imageSizePolicy;
    capabilities.imageSizePresets = sizeCaps.imageSizePresets;
  }
  return {
    id: ++state.taskSeq, state:'pending',
    mediaType: opts.mediaType || 'image',
    mode: opts.mode,
    files: opts.files || [],
    inpaint: opts.inpaint || null,
    parentId: opts.parentId || null, relation: opts.relation || null,
    prompt: opts.prompt, negative: opts.negative,
    requestPrompt: opts.requestPrompt || '', requestNegative: opts.requestNegative || '',
    preset: opts.preset,
    capabilities,
    videoModel: opts.videoModel || '',
    videoSeconds: opts.videoSeconds || '',
    videoAspectRatio: opts.videoAspectRatio || '',
    videoResolution: opts.videoResolution || '',
    videoCapabilities: opts.videoCapabilities || null,
    model: opts.model, size: opts.inpaint ? opts.size : resolveImageSize(opts.size, capabilities, opts.imageSizeMode), imageSizeMode:opts.inpaint ? 'custom' : (opts.imageSizeMode || 'preset'), n: Math.max(1, Math.min(4, Math.floor(Number(opts.n) || 1))),
    quality: opts.quality || '', complexity:opts.complexity || '', background: opts.background || '', outputFormat: opts.outputFormat || '', resolution: opts.resolution || '', responseFormat: opts.responseFormat || '', stream: !!opts.stream, seed: opts.seed != null ? opts.seed : '', colorCorrection: !!opts.colorCorrection, resizeMethod: opts.resizeMethod || '',
    base: opts.base, key: opts.key,
    clientTaskId: opts.clientTaskId || null,
    jobId: opts.jobId || '', serverTaskId: opts.serverTaskId || '', serverState: opts.serverState || '', serverError: opts.serverError || '', serverErrorCode: opts.serverErrorCode || '', serverMeta: opts.serverMeta || null, serverResultUrls: Array.isArray(opts.serverResultUrls) ? opts.serverResultUrls.slice() : [], serverSize: opts.serverSize || '', serverResolution: opts.serverResolution || '', serverQuality: opts.serverQuality || '', serverImageCount: opts.serverImageCount || 0, serverImageSizeTier: opts.serverImageSizeTier || '', serverCostUsd: opts.serverCostUsd != null ? opts.serverCostUsd : '',
    submittedAt: opts.submittedAt || 0, serverUpdatedAt: opts.serverUpdatedAt || 0,
    historySaved: !!opts.historySaved, submitAbortController: null, serverWaitReject: null, cancelRequested: false,
    videoProgress: Number(opts.videoProgress) || 0, videoUrl: opts.videoUrl || '', videoMime: opts.videoMime || '', providerId: opts.providerId || ''
    }
}

export function enqueueTask(task){
  task.n = Math.max(1, Math.min(4, Math.floor(Number(task.n) || 1)));
  if(task.n > 1){
    // 后端负责并发控制；这里仅为每张拆分任务生成独立幂等键并立即提交。
    for(let i = 0; i < task.n; i++){
      const t = Object.assign({}, task, {
        n: 1,
        id: i === 0 ? task.id : ++state.taskSeq,
        clientTaskId: null,
        jobId: '', serverState: '', serverError: '', historySaved: false,
        batchOf: task.n, batchIdx: i + 1
      });
      ensureClientTaskId(t);
      if(i === 0) task.clientTaskId = t.clientTaskId;
      state.taskQueue.push(t);
      renderTaskCard(t);
    }
    dispatchTasks();
    return task;
  }
  ensureClientTaskId(task);
  state.taskQueue.push(task);
  renderTaskCard(task);
  dispatchTasks();
  return task;
}

export function cloneTask(src, n){
  if(src.mediaType === 'video'){
    const task = buildTask({
      mediaType: 'video', mode: src.mode, files: (src.files || []).map(f=>({ file:f.file, role:'none' })),
      prompt: src.prompt, negative: src.negative, preset: src.preset, capabilities: src.capabilities,
      videoCapabilities: src.videoCapabilities, videoModel: src.videoModel || src.model,
      videoSeconds: src.videoSeconds, videoAspectRatio: src.videoAspectRatio, videoResolution: src.videoResolution,
      model: src.model, size: '', n: 1, parentId: src.id, relation: 'variant', base: src.base, key: src.key
    });
    enqueueTask(task);
    return task;
  }
  let mode = src.mode;
  let files = src.files.map(f=>({ file:f.file, role:'none' }));
  if(src.inpaint){
    // 涂抹重绘结果做变体：原蒙版已不适用，把结果图作为新任务的参考图
    const t = state.taskEls[src.id];
const ri = t && getTaskResult(t);
     if(ri && ri.blob){
      files = [{ file:new File([ri.blob], 'variant_ref_' + src.id + '.' + mimeToExt(ri.blob.type), { type:ri.blob.type || 'image/png' }), role:'none' }];
      mode = 'img2img';
    }else{
      toast('重绘结果的变体需要本地图片，请先下载原图再操作', 'err');
      return null;
    }
  }
  const task = buildTask({
    mode: mode,
    files: files,
    prompt: src.prompt, negative: src.negative,
    preset: src.preset, capabilities: src.capabilities,
    parentId: src.id, relation: 'variant',
    model: src.model, size: src.size, imageSizeMode:src.imageSizeMode, n: n || 1,
    quality: src.quality || '', complexity:src.complexity || '', background: src.background || '', outputFormat: src.outputFormat || '', resolution: src.resolution || '', responseFormat:src.responseFormat || '', stream:!!src.stream, seed: src.seed != null ? src.seed : '', colorCorrection: !!src.colorCorrection, resizeMethod: src.resizeMethod || '',
    base: src.base, key: src.key
  });
  enqueueTask(task);
  return task;
}

export function renderTaskCard(task){
  const slot = nextSlot();
  const card = createCard(task, slot);
  updateCol(slot.col, slot.y);
  state.taskEls[task.id] = { task, card, urls:[], resultItems:[], resultIndex:0 };
  if(task.parentId && state.taskEls[task.parentId]) addLink(task.parentId, task.id, task.relation);
  renderCardState(task);
  ensureVisible(slot.x, slot.y, true);
}

export function releaseTaskRefs(taskId){
  const prefix = 'ref_' + taskId + '_';
  for(const key of Array.from(state.savedRefFiles.keys())) if(key.startsWith(prefix)) state.savedRefFiles.delete(key);
  idbClearPrefix(prefix);
}

export function removeCard(task){
  const t = state.taskEls[task.id];
  if(!t) return;
  if(task.mediaType === 'video'){
    const stopVideoWatch = state.hooks && state.hooks.stopVideoTaskWatch;
    if(stopVideoWatch && task.jobId) stopVideoWatch(task.jobId);
    if(state.videoWatches && task.jobId) state.videoWatches.delete(task.jobId);
  }else if(taskIsServerActive(task) || task.serverWaitReject) void cancelRemoteTask(task);
  if(task.mediaType !== 'video' && task.serverWaitReject) task.serverWaitReject(new Error('卡片已移除，后台仍会保存已生成结果'));
  if(task.mediaType !== 'video' && task.jobId) stopTaskWatch(task.jobId);
  if(state.taskWatches && task.jobId) state.taskWatches.delete(task.jobId);
  if(task.submitAbortController) task.submitAbortController.abort();
  clearTaskResult(t);
  removeLinksOf(task.id);
  t.card.remove();
  delete state.taskEls[task.id];
  const qi = state.taskQueue.indexOf(task);
  if(qi > -1) state.taskQueue.splice(qi, 1);
  releaseCanvasBlob(task.id);
  idbClearPrefix('canvas_' + task.id + '_');
  releaseTaskRefs(task.id);
  updateEmpty();
  syncTopbarHud();
  rebuildColumns(); // 回收列高，后续新卡片插入位置正确
  scheduleAutosave();
}

export function dispatchTasks(){
  state.imageSubmissions = Number(state.imageSubmissions) || 0;
  while(state.taskQueue.length && state.imageSubmissions < 3){
    const task = state.taskQueue.shift();
    if(!state.taskEls[task.id]) continue;
    if(task.mediaType === 'video'){ runVideoTask(task); continue; }
    state.imageSubmissions++;
    task.submissionSlot = true;
    void runGenTask(task);
  }
}

function releaseSubmissionSlot(task){
  if(!task.submissionSlot) return;
  task.submissionSlot = false;
  state.imageSubmissions = Math.max(0, (Number(state.imageSubmissions)||0)-1);
  dispatchTasks();
}

export async function runGenTask(task){
  if(task.mediaType === 'video'){
    runVideoTask(task);
    return;
  }
  const t = state.taskEls[task.id];
  if(!t){ releaseSubmissionSlot(task); return; }
  task.state = 'pending';
  task.serverState = 'submitting';
  task.serverError = '';
  task.errorMsg = '';
  task.startTs = Date.now();
  task.submitAbortController = new AbortController();
  renderCardState(task);
  try{
    const capabilities = task.capabilities || {};
    const negative = normalizePromptAndNegative(task.prompt, task.negative, capabilities.negativePrompt);
    task.requestPrompt = buildRequestPrompt(negative.prompt, task.mode, task.files || []);
    task.requestNegative = negative.negative;
    const submitted = await submitServerTask(task, serverOptions({
      apiKey: task.key,
      signal: task.submitAbortController.signal
    }));
    task.submitAbortController = null;
     task.jobId = submitted.jobId;
     releaseSubmissionSlot(task);
     task.serverTaskId = submitted.providerTaskId || submitted.taskId || submitted.upstreamTaskId || task.serverTaskId || '';
     task.submittedAt = submitted.createdAt ? Math.round(Number(submitted.createdAt) * 1000) : Date.now();
    applyServerStatus(task, submitted);
    scheduleAutosave();

    let packed;
    if(submitted.state === 'done'){
      const results = await fetchTaskResults(submitted, serverOptions());
      if(!results.length) throw new Error('后台任务完成但没有可用图片结果');
      packed = { status:submitted, results };
    }else if(submitted.state === 'error' || submitted.state === 'cancelled' || submitted.state === 'interrupted' || submitted.state === 'expired'){
      throw new Error(submitted.error || ('后台任务未成功创建：' + submitted.state));
    }else{
      packed = await waitForServerTask(task);
    }

      task.resultWarning = packed.status.resultWarning || packed.status.meta && packed.status.meta.result_warning || '';
      task.serverMeta = packed.status.meta || packed.status.metadata || task.serverMeta || null;
     const serverMeta = extractTaskServerMeta(packed.status);
     task.serverTaskId = serverMeta.providerTaskId || task.serverTaskId || '';
     task.serverSize = serverMeta.size || task.serverSize || '';
     task.serverResolution = serverMeta.resolution || task.serverResolution || '';
     task.serverQuality = serverMeta.quality || task.serverQuality || '';
     task.serverImageCount = serverMeta.imageCount || (packed.results && packed.results.length) || task.serverImageCount || 0;
     task.serverImageSizeTier = serverMeta.imageSizeTier || task.serverImageSizeTier || '';
     if(serverMeta.costUsd !== '' && serverMeta.costUsd != null) task.serverCostUsd = serverMeta.costUsd;
     task.serverErrorCode = serverMeta.errorCode || task.serverErrorCode || '';
     task.serverResultUrls = serverMeta.resultUrls;
     const resultItems = packed.results.map(item=>({
       blob: item.blob,
       url: getTaskResultUrl(task.jobId, item.index),
       index: item.index, mime: item.mime || '', size: item.size || 0
     }));
    await renderResults(resultItems, task);
    const historyItems = packed.results.map(item=>({ blob:item.blob, url:getTaskResultUrl(task.jobId, item.index) }));
    if(!task.historySaved){
      saveHistory(historyItems, task);
      task.historySaved = true;
    }
    task.endTs = task.endTs || Date.now();
    task.serverState = 'done';
    task.state = 'done';
    task.restoreNote = '';
    renderCardState(task);
    scheduleAutosave();
    notifyOvershootSettled(task);
  }catch(err){
    task.endTs = task.endTs || Date.now();
    task.submitAbortController = null;
    const cancelled = task.cancelRequested || (err && err.code === 'cancelled') || task.serverState === 'cancelled';
    task.state = cancelled ? 'cancelled' : (err && err.code === 'timeout' ? 'timeout' : 'error');
    if(cancelled){
      task.serverState = 'cancelled';
      task.errorMsg = '任务已取消';
    }else{
      task.errorMsg = err && err.message ? err.message : String(err || '后台任务失败');
    }
    renderCardState(task);
    scheduleAutosave();
    notifyOvershootSettled(task);
  }finally{
    releaseSubmissionSlot(task);
    task.submitAbortController = null;
    if(task.jobId && state.taskWatches) state.taskWatches.delete(task.jobId);
    dispatchTasks();
  }
}

export function retryTask(task){
  const t = state.taskEls[task.id];
  if(!t) return;
  if(task.mediaType === 'video'){
    const stopVideoWatch = state.hooks && state.hooks.stopVideoTaskWatch;
    if(stopVideoWatch && task.jobId) stopVideoWatch(task.jobId);
    if(state.videoWatches && task.jobId) state.videoWatches.delete(task.jobId);
    if(task.submitAbortController) task.submitAbortController.abort();
    task.clientTaskId = null;
    task.jobId = '';
    task.providerId = '';
    task.videoUrl = '';
    task.videoProgress = 0;
    task.state = 'pending';
    task.serverState = '';
    task.serverError = '';
    task.errorMsg = '';
    task.cancelRequested = false;
    task.historySaved = false;
    clearTaskResult(t);
    state.taskQueue.push(task);
    renderCardState(task);
    dispatchTasks();
    return;
  }
  recoverTask(task);
}

async function applyLoadedResult(task, status, results){
  const previousIndexes = new Set((state.taskEls[task.id]?.resultItems || []).map(item=>Number(item.index)));
  if(task.historySaved){
    const added = results.filter(item=>!previousIndexes.has(Number(item.index)));
    if(added.length) saveHistory(added.map(item=>({blob:item.blob, url:getTaskResultUrl(task.jobId,item.index)})),task);
  }
  task.resultWarning = status.resultWarning || status.meta && status.meta.result_warning || '';
  const resultItems = results.map(item=>({
    blob: item.blob,
    url: getTaskResultUrl(task.jobId, item.index),
    index: item.index, mime: item.mime || '', size: item.size || 0
  }));
  await renderResults(resultItems, task);
  if(!task.historySaved){
    saveHistory(results.map(item=>({ blob:item.blob, url:getTaskResultUrl(task.jobId, item.index) })), task);
    task.historySaved = true;
  }
  task.endTs = task.endTs || Date.now();
  task.serverState = 'done';
  task.state = 'done';
  task.restoreNote = '';
  renderCardState(task);
  scheduleAutosave();
  notifyOvershootSettled(task);
}

async function recoverTask(task){
  const t = state.taskEls[task.id];
  if(!t || task.recoverPending) return;
  const panelBase = el.apiBase.value.trim().replace(/\/+$/,'');
  const panelKey = el.apiKey.value.trim();
  const hostOf = value => { try{ return new URL(String(value || '')).hostname.toLowerCase(); }catch(err){ return ''; } };
  const crossSite = !!hostOf(task.base) && !!hostOf(panelBase) && hostOf(task.base) !== hostOf(panelBase);
  if(crossSite && !task.key){ toast('请切回该任务的原供应商配置后恢复', 'err'); return; }
  if(!task.base) task.base = panelBase;
  if(!task.key && !crossSite) task.key = panelKey;
  if(!task.base){
    toast('该任务缺少保存的 API 配置，无法恢复', 'err');
    return;
  }
  task.recoverPending = true;
  renderCardState(task);
  scheduleAutosave();
  try{
    if(task.jobId){
      toast('正在尝试恢复原任务…', 'ok');
      const status = await resumeServerTask(task.jobId, serverOptions({ apiKey: task.key, baseUrl: task.base }));
      const info = status && status.resume ? status.resume : {};
      applyServerStatus(task, status);
      if(status.state === 'done'){
        const results = await fetchTaskResults(status, serverOptions());
        if(!results.length) throw new Error('恢复成功但没有可用图片结果');
        await applyLoadedResult(task, status, results);
        toast('✅ 已找回原任务结果', 'ok');
      }else if(status.state === 'queued' || status.state === 'running'){
        toast('✅ 已找回原任务，继续生成中', 'ok');
        const packed = await waitForServerTask(task);
        await applyLoadedResult(task, packed.status, packed.results);
      }else{
        const reason = (info && info.reason) || status.error || '原因未知';
        toast('无法恢复原任务：' + reason + '（如需重做请点「生成」）', 'err');
      }
    }else if(task.clientTaskId){
      let rec = null;
      try{
        rec = await fetchTaskByClient(task.clientTaskId, serverOptions());
      }catch(fetchErr){
        if(!(fetchErr && Number(fetchErr.status) === 404)) throw fetchErr;
      }
      if(!rec){
        task.state = 'cancelled';
        task.serverState = 'cancelled';
        task.errorMsg = task.errorMsg
          ? ('提交未成功：' + task.errorMsg + '｜后台无此任务记录')
          : '任务未在后台创建，已确认取消';
        renderCardState(task);
        scheduleAutosave();
        toast('该任务未在后台创建（无结果可找回）；原失败原因见卡片', 'err');
        notifyOvershootSettled(task);
      }else{
        task.jobId = rec.jobId || '';
        applyServerStatus(task, rec);
        scheduleAutosave();
        if(rec.state === 'done'){
          const results = await fetchTaskResults(rec, serverOptions());
          if(!results.length) throw new Error('恢复成功但没有可用图片结果');
          await applyLoadedResult(task, rec, results);
          toast('✅ 已找回原任务结果', 'ok');
        }else if(rec.state === 'queued' || rec.state === 'running'){
          toast('✅ 已找回原任务，继续生成中', 'ok');
          const packed = await waitForServerTask(task);
          await applyLoadedResult(task, packed.status, packed.results);
        }else{
          toast('任务当前状态「' + rec.state + '」，无法找回结果', 'err');
        }
      }
    }else{
      toast('该任务没有可恢复的记录（无任务编号），请点「生成」重新创建', 'err');
    }
  }catch(err){
    const msg = err && err.message ? err.message : String(err || '恢复失败');
    toast('恢复失败：' + msg, 'err');
  }finally{
    task.recoverPending = false;
    renderCardState(task);
    scheduleAutosave();
  }
}

export function closeTask(task){
  const t = state.taskEls[task.id];
  if(!t) return;
  if(task.mediaType === 'video'){
    task.cancelRequested = true;
    task.state = 'cancelled';
    task.serverState = 'cancelled';
    task.errorMsg = '任务已取消';
    renderCardState(task);
    const stopVideoWatch = state.hooks && state.hooks.stopVideoTaskWatch;
    if(stopVideoWatch && task.jobId) stopVideoWatch(task.jobId);
    if(state.videoWatches && task.jobId) state.videoWatches.delete(task.jobId);
    if(task.submitAbortController) task.submitAbortController.abort();
    cancelVideoEntry(task);
    scheduleAutosave();
    return;
  }
  if(taskIsServerActive(task) || task.serverWaitReject){
    task.restoreNote = '正在核对取消…';
    renderCardState(task);
    void cancelRemoteTask(task).then(status=>{
      if(!status) return;
      const declined = status.cancelResult === 'declined' || status.state === 'queued' || status.state === 'running';
      if(!declined) return;
      task.cancelRequested = false;
      applyServerStatus(task, status);
      toast('⚠️任务已开始生成，无法取消；将继续完成并保留结果', 'err');
      if(!task.serverWaitReject) void resumeWaiting(task);
    });
    notifyOvershootSettled(task);
    return;
  }
  if(task.submitAbortController){
    task.cancelRequested = true;
    task.state = 'cancelled';
    task.errorMsg = '正在核对取消…';
    renderCardState(task);
    scheduleAutosave();
    task.submitAbortController.abort();
    void verifySubmittedCancel(task);
    notifyOvershootSettled(task);
    return;
  }
  if(task.state === 'pending' && state.taskQueue.includes(task)){
    const i = state.taskQueue.indexOf(task);
    if(i > -1) state.taskQueue.splice(i, 1);
    task.state = 'cancelled';
    task.serverState = 'cancelled';
    renderCardState(task);
    scheduleAutosave();
    notifyOvershootSettled(task);
  }
}

export async function copyPrompt(task){
  try{
    const ok = await copyText(task.prompt || '');
    if(!ok) throw new Error('copy-failed');
    toast('✅ 提示词已复制', 'ok');
  }catch(e){
    toast('复制失败，请从「参数详情」手动复制', 'err');
  }
}

export async function removeBatchGroup(task){
  if(!task.batchOf) return;
  const batchId = task.id - task.batchIdx + 1;
  const ids = Object.keys(state.taskEls).filter(id=>{
    const x = state.taskEls[id].task;
    return x.batchOf && (x.id - x.batchIdx + 1) === batchId;
  });
  if(!ids.length) return;
  if(!(await uiConfirm({ title:'删除同批卡片', message:'确定删除同批 ' + ids.length + ' 张卡片？', confirmText:'删除', danger:true }))) return;
  ids.forEach(id=> state.taskEls[id] && removeCard(state.taskEls[id].task));
  toast('已删除同批 ' + ids.length + ' 张卡片', 'ok');
}

export function abortQueuedTasks(){
  let n = 0;
  Object.keys(state.taskEls).forEach(id=>{
    const t = state.taskEls[id];
    if(!t) return;
    const task = t.task;
    if(task.mediaType === 'video') return;
    const submitting = !!task.submitAbortController || task.serverState === 'submitting';
    const queued = task.serverState === 'queued';
    const localQueued = task.state === 'pending' && state.taskQueue.includes(task);
    if(task.state !== 'cancelled' && (submitting || queued || localQueued)){
      closeTask(task);
      n++;
    }
  });
  scheduleAutosave();
  toast(n ? ('已请求终止 ' + n + ' 个排队任务') : '没有排队中的任务', n ? 'ok' : 'err');
}

export function abortAllTasks(){
  let n = 0;
  Object.keys(state.taskEls).forEach(id=>{
    const t = state.taskEls[id];
    if(!t) return;
    const task = t.task;
    if(taskIsServerActive(task) || task.submitAbortController || (task.state === 'pending' && state.taskQueue.includes(task))){
      closeTask(task);
      n++;
    }
  });
  scheduleAutosave();
  toast(n ? '已请求终止 ' + n + ' 个后台任务' : '没有可终止的任务', n ? 'ok' : 'err');
}

export function retryAllFailed(){
  let n = 0;
  Object.keys(state.taskEls).forEach(id=>{
    const t = state.taskEls[id];
    if(!t) return;
    const task = t.task;
    if(task.mediaType === 'video') return;
    if(task.state === 'error' || task.state === 'timeout'){ retryTask(task); n++; }
  });
  toast(n ? '已请求恢复 ' + n + ' 个失败任务' : '没有可恢复的失败任务', n ? 'ok' : 'err');
}

export function reuseTask(task){
  el.providerPreset.value = task.preset || el.providerPreset.value;
  applyPreset(false);
  if(task.base) el.apiBase.value = task.base;
  if(task.mediaType === 'video'){
    state.videoMode = task.mode === 'img2video' ? 'img2video' : 'txt2video';
    state.videoModel = task.videoModel || task.model || state.videoModel;
    state.videoSeconds = task.videoSeconds || state.videoSeconds || '6';
    state.videoAspectRatio = task.videoAspectRatio || state.videoAspectRatio || '16:9';
    state.videoResolution = task.videoResolution || state.videoResolution || '720P';
    setMode('video');
    renderVideoParams();
    if(el.videoModel){
      if(Array.from(el.videoModel.options).some(o=>o.value===state.videoModel)) el.videoModel.value = state.videoModel;
      else { el.videoModel.value = '__custom__'; el.videoCustomModel.value = state.videoModel; }
      el.videoCustomModel.style.display = el.videoModel.value === '__custom__' ? '' : 'none';
    }
    el.videoSeconds.value = state.videoSeconds;
    el.videoAspectRatio.value = state.videoAspectRatio;
    el.videoResolution.value = state.videoResolution;
    state.currentFiles.forEach(f=>{ try{ URL.revokeObjectURL(f.url); }catch(e){} });
    state.currentFiles = (task.files || []).map(f=>({ file:f.file, role:'none', url:URL.createObjectURL(f.file) }));
    renderRefStrip();
    el.prompt.value = task.prompt || '';
    el.negative.value = task.negative || '';
    syncQuickRow(); autosize();
    toast('✅ 已回填视频参数，可修改后再次生成', 'ok');
    return;
  }
  if(task.model){
    if(Array.from(el.model.options).some(o=> o.value===task.model)) el.model.value = task.model;
    else { el.model.value = '__custom__'; el.customModel.value = task.model; }
    el.customModel.style.display = el.model.value==='__custom__' ? '' : 'none';
  }
  setMode(task.mode || 'txt2img');
  syncImageParamOptions();
  if(task.mode === 'img2img'){
    if(task.files && task.files.length){
      // 复用参数时恢复原任务参考图，避免回填后因缺少参考图无法直接生成
      const maxRefs = getMaxReferences();
      const srcs = task.files.slice(0, maxRefs);
      state.currentFiles.forEach(f=>{ try{ URL.revokeObjectURL(f.url); }catch(e){} });
      state.currentFiles = srcs.map((f, i)=>({ file: f.file, role: f.role || 'none', url: URL.createObjectURL(f.file) }));
      renderRefStrip();
      if(task.files.length > maxRefs) toast('原任务参考图超过当前预设上限，已保留前 ' + maxRefs + ' 张', 'err');
    }else{
      // 重绘/存档任务没有原始参考文件：用结果图补位，仍缺失则明确提示
const t = state.taskEls[task.id];
       const ri = t && getTaskResult(t);
       if(ri && ri.blob) addRefFromBlob(ri.blob, '复用结果_' + task.id + '.' + mimeToExt(ri.blob.type));
      else toast('该任务参考图未随存档保存，请手动添加参考图后再生成', 'err');
    }
  }
  el.prompt.value = task.prompt || '';
  el.negative.value = task.negative || '';
  el.count.value = String(task.n || 1);
state.currentQuality = task.quality || ''; state.currentBg = task.background || ''; state.currentFmt = task.outputFormat || ''; state.currentResolution = task.resolution || state.currentResolution || '';
   el.quality.value = state.currentQuality; el.background.value = state.currentBg; el.format.value = state.currentFmt;
   if(el.imageResolution) el.imageResolution.value = state.currentResolution;
    /* 选项被禁用/不含该值时以界面实际显示为准回读，保证「看到的 = 发送的」 */
    state.currentQuality = el.quality.value; state.currentBg = el.background.value; state.currentFmt = el.format.value;
    syncGifHint();
     if(el.complexity){ el.complexity.value = el.complexity.disabled ? '' : (task.complexity || ''); state.currentComplexity=el.complexity.value; }
     if(el.imageResolution) state.currentResolution = el.imageResolution.value || '';
    if(el.responseFormat) el.responseFormat.value = el.responseFormat.disabled ? '' : (task.responseFormat || '');
  state.currentImageSizeMode = task.imageSizeMode === 'custom' ? 'custom' : 'preset';
  state.selectedSize = resolveImageSize(task.size || state.selectedSize, getCapabilities(), state.currentImageSizeMode);
  const found = findImageSize(state.selectedSize, getCapabilities());
  if(found && state.currentImageSizeMode !== 'custom') state.currentTier = found.tier;
  renderTierTabs(); renderSizes();
  syncQuickRow();
  autosize();
  maybeRefreshLiveModels(true);
  toast('✅ 已回填本次参数，可修改后再次生成', 'ok');
}

export async function renderResults(items, task){
  const t = state.taskEls[task.id];
  if(!t) return;
  clearTaskResult(t);
  t.savedToIdb = false;
  for(const it of items){
    if(it.blob){
      const objUrl = URL.createObjectURL(it.blob);
      t.urls.push(objUrl);
      t.resultItems.push({ blob:it.blob, url:objUrl, remoteUrl:it.url || '', index: it.index != null ? Number(it.index) : t.resultItems.length, mime: it.mime || it.blob.type || '', size: it.size || it.blob.size || 0 });
    }else if(it.b64_json){
      const blob = b64ToBlob(cleanB64(it.b64_json));
      const objUrl = URL.createObjectURL(blob);
      t.urls.push(objUrl);
      t.resultItems.push({ blob, url:objUrl, index: it.index != null ? Number(it.index) : t.resultItems.length, mime: it.mime || blob.type || '', size: it.size || blob.size || 0 });
    }else if(it.url){
      t.resultItems.push({ url:it.url, remoteUrl:it.url, index: it.index != null ? Number(it.index) : t.resultItems.length });
    }
  }
}

export function updateEmpty(){
  const has = Object.keys(state.taskEls).length > 0;
  el.canvasEmpty.classList.toggle('hide', has);
}

/* ================= 超生成（靠量堆成功率；禁止改成“失败熔断 / 一失败即停”）=================
   契约唯一权威见 README.md「超生成设计契约（禁止改动）」：
   审核拒绝=概率事件，不暂停、不消耗尝试量、自动等额补发；达标才停。改动前必读该节并同步修订日志。 */

export function startOvershoot(opts){
  const attempts = Math.max(1, Math.min(100, Math.floor(Number(opts && opts.attempts) || 20)));
  const target = Math.max(1, Math.floor(Number(opts && opts.target) || 5));
  if(target > attempts){ toast('超生成：目标成功数不能大于尝试数量', 'err'); return { ok:false }; }
  if(state.overshoot && state.overshoot.phase === 'running'){ toast('已有进行中的超生成批次，请先终止或等待其结束', 'err'); return { ok:false }; }
  const ogId = 'og' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.overshoot = {
    id:ogId, target, attempts, enqueued:0, phase:'running', startedAt:Date.now(), busy:false,
    baseOpts: (opts && opts.baseOpts) || null, size: (opts && opts.size) || '',
    parentId: (opts && opts.parentId) || null, relation: (opts && opts.relation) || null,
    safetyHandled: 0, safetyRefunded: 0, safetyRefundMax: attempts
  }
  emitOvershootTasks(attempts);
  checkOvershoot();
  scheduleAutosave();
  return { ok:true, attempts, target };
}

/* 补发同参数任务：审核拒绝返还额度时使用（baseOpts 只在内存，刷新后不补发）。*/
function emitOvershootTasks(count){
  const og = state.overshoot;
  if(!og || !og.baseOpts) return 0;
  const total = Math.max(0, Math.min(100, Math.floor(Number(count) || 0)));
  let added = 0;
  for(let i = 0; i < total; i++){
    const task = buildTask({ ...(og.baseOpts || {}), size: og.size, n: 1, parentId: og.parentId || null, relation: og.relation || null });
    task.overshootId = og.id;
    task.overshootTarget = og.target;
    enqueueTask(task);
    added++;
  }
  if(added) og.enqueued = (Number(og.enqueued) || 0) + added;
  return added;
}


/* API-18：与 util.classifyApiError 同一套关键词。内容审核拒绝与上游不可达同为
   upstream_error，但语义相反：前者重试原提示词无效，不该白占超生成名额。*/
const SAFETY_RE = /safety system|safety|unsafe|nsfw|sexual|explicit|审核|内容安全|content[_ ]?policy|moderation|violat|不安全|敏感/i;
function isSafetyError(task){
  const blob = String((task && (task.errorMsg || task.serverError || task.serverErrorCode)) || '');
  return SAFETY_RE.test(blob);
}

function overshootStats(ogId){
  const stats = { success:0, succeededTasks:0, failed:0, safety:0, cancelled:0, active:0, queued:0, completed:0, total:0 };
  Object.keys(state.taskEls).forEach(id=>{
    const entry = state.taskEls[id];
    if(!entry || !entry.task) return;
    const task = entry.task;
    if(!task.overshootId || task.overshootId !== ogId || task.mediaType === 'video') return;
    if(task.state === 'done'){ stats.succeededTasks++; stats.success += Math.max(1, (entry.resultItems || []).length || Number(task.serverImageCount) || 1); }
    else if(task.state === 'error' || task.state === 'timeout' || task.state === 'interrupted' || task.state === 'expired'){
      if(isSafetyError(task)) stats.safety++;   // 审核拒绝：不计入尝试量
      else stats.failed++;
    }
    else if(task.state === 'cancelled') stats.cancelled++;
    else if(task.state === 'running') stats.active++;
    else stats.queued++;
    stats.total++;
  });
  stats.completed = stats.succeededTasks + stats.failed + stats.cancelled;
  return stats;
}

function terminateOvershootQueued(ogId){
  let n = 0;
  Object.keys(state.taskEls).forEach(id=>{
    const t = state.taskEls[id];
    if(!t || !t.task) return;
    const task = t.task;
    if(task.overshootId !== ogId || task.mediaType === 'video') return;
    const submitting = !!task.submitAbortController || task.serverState === 'submitting';
    const queued = task.serverState === 'queued';
    const localQueued = task.state === 'pending' && state.taskQueue.includes(task);
    if(task.state !== 'cancelled' && (submitting || queued || localQueued)){
      closeTask(task);
      n++;
    }
  });
  return n;
}

export function updateOvershootUI(){
  if(!el || !el.ogBar) return;
  const og = state.overshoot;
  const armed = !og && el.ogMode && el.ogMode.checked;
  if(!og && !armed){ el.ogBar.style.display = 'none'; return; }
  el.ogBar.style.display = '';
  if(!og){
    el.ogBar.className = 'og-bar ready';
    el.ogBar.title = '超生成已开启：点「生成」后一次性入队，按出图张数计数，达标自动终止剩余排队';
    if(el.ogFill) el.ogFill.style.width = '0%';
    if(el.ogText) el.ogText.innerHTML = ICO.target + ' 超生成已开启：尝试 ' + ((el.ogAttempts && el.ogAttempts.value) || '?') + ' 张 · 目标 ' + ((el.ogTarget && el.ogTarget.value) || '?') + ' 张（点「生成」开始）';
    if(el.ogAct){ el.ogAct.innerHTML = ''; el.ogAct.style.display = 'none'; }
    return;
  }
  if(el.ogAct) el.ogAct.style.display = '';
  const stats = overshootStats(og.id);
  const limit = og.enqueued || og.attempts;
  const pct = og.phase === 'done' ? 100 : Math.min(100, Math.round((stats.completed / Math.max(1, limit)) * 100));
  const base = '最多 ' + limit + ' 张 · 目标 ' + og.target + ' 张｜进度=已完成/总尝试';
  const donePart = '已完成 ' + stats.completed + '/' + limit;
  const failBits = [];
  if(stats.failed) failBits.push('失败 ' + stats.failed);
  if(stats.safety){
    const refunded = Number(og.safetyRefunded) || 0;
    failBits.push('审核拒绝 ' + stats.safety + (refunded ? '（已返还 ' + refunded + '张）' : ''));
  }
  const failPart = failBits.length ? (' · ' + failBits.join(' / ')) : '';
  const flowPart = (stats.active || stats.queued) ? '（生成中 ' + stats.active + ' · 排队 ' + stats.queued + '）' : '';
  let cls = 'og-bar', text = '', act = '', tip = base;
  if(og.phase === 'running'){
    text = ICO.target + ' 超生成中：成功 ' + stats.success + '/' + og.target + failPart + ' · ' + donePart + flowPart;
    act = ICO.stop + ' 终止';
  }else if(og.phase === 'done'){
    text = ICO.check + ' 达标 ' + stats.success + '/' + og.target + failPart + (stats.active ? '（收尾中 +' + stats.active + '）' : '') + ' · ' + donePart;
    act = ICO.x + ' 关闭';
    cls += ' done';
  }else if(og.phase === 'blocked'){
    text = ICO.warn + ' 已暂停：' + stats.safety + ' 张被审核拒绝（不计入尝试，请修改提示词）' + failPart + ' · ' + donePart;
    act = ICO.x + ' 关闭';
    cls += ' stopped';
  }else if(og.phase === 'stopped'){
    text = ICO.stop + ' 已停止：成功 ' + stats.success + '/' + og.target + failPart + ' · ' + donePart;
    act = ICO.x + ' 关闭';
    cls += ' stopped';
  }else{
    text = ICO.warn + ' 未达标：成功 ' + stats.success + '/' + og.target + failPart + ' · ' + donePart;
    act = ICO.x + ' 关闭';
    cls += ' exhausted';
  }
  el.ogBar.className = cls;
  el.ogBar.title = tip;
  if(el.ogFill) el.ogFill.style.width = pct + '%';
  if(el.ogText) el.ogText.innerHTML = text;
  if(el.ogAct) el.ogAct.innerHTML = act;
}

export function checkOvershoot(){
  const og = state.overshoot;
  if(!og || og.busy) return;
  og.busy = true;
  try{
    let stats = overshootStats(og.id);
    if(og.phase === 'running'){
      if(stats.success >= og.target){
        og.phase = 'done';
        const n = terminateOvershootQueued(og.id);
        updateOvershootUI();
        scheduleAutosave();
        toast('🎯超生成达标：成功 ' + stats.success + '/' + og.target + (n ? '，已请求终止 ' + n + '个排队任务' : ''), 'ok');
        return;
      }
      //审核拒绝（unsafe 等）不暂停、也不计入尝试量：按差额补发同参数任务，直到返还上限
      const freshSafety = Math.max(0, stats.safety - (Number(og.safetyHandled) || 0));
      if(freshSafety > 0){
        og.safetyHandled = stats.safety;
        const refundLeft = Math.max(0, (Number(og.safetyRefundMax) || 0) - (Number(og.safetyRefunded) || 0));
        const refund = Math.min(freshSafety, refundLeft);
        if(refund > 0 && og.baseOpts){
          og.safetyRefunded = (Number(og.safetyRefunded) || 0) + refund;
          emitOvershootTasks(refund);
        }
      }
      stats = overshootStats(og.id);
      if(stats.active + stats.queued === 0){
        const refundLeftNow = Math.max(0, (Number(og.safetyRefundMax) || 0) - (Number(og.safetyRefunded) || 0));
        if(og.baseOpts && stats.safety > 0 && refundLeftNow > 0){ updateOvershootUI(); return; }
        og.phase = 'exhausted';
        updateOvershootUI();
        scheduleAutosave();
        toast('⚠️超生成结束：尝试 ' + stats.total + '次（已完成 ' + stats.completed + '），成功 ' + stats.success + '/' + og.target + '张，未达标', 'err');
        return;
      }
    }
    updateOvershootUI();
  }finally{
    og.busy = false;
  }
}

export function overshootAction(){
  const og = state.overshoot;
  if(!og) return;
  if(og.phase === 'running'){
    og.phase = 'stopped';
    const n = terminateOvershootQueued(og.id);
    updateOvershootUI();
    scheduleAutosave();
    toast(n ? ('已请求终止本批 ' + n + '个排队任务（已开始生成的将继续完成）') : '没有可终止的排队任务（已开始生成的将继续完成）', n ? 'ok' : 'err');
  }else{
    state.overshoot = null;
    updateOvershootUI();
    scheduleAutosave();
  }
}

function notifyOvershootSettled(task){
  if(state.overshoot && task && task.overshootId) checkOvershoot();
}
