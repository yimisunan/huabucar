import { REQUEST_TIMEOUTS } from './state.js';
import { toast, mimeToExt, getRequestUrl, fetchWithTimeout } from './util.js';
import { getPresetByKey, getCapabilities, getSelectedVideoModel } from './settings.js';
import { ensureVideoClientTaskId, getVideoTaskResultUrl } from './videoTasks.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }

function callHook(name, ...args){
  return state && state.hooks && typeof state.hooks[name] === 'function' ? state.hooks[name](...args) : undefined;
}
function getVideoHook(name){
  return state && state.hooks && typeof state.hooks[name] === 'function' ? state.hooks[name] : null;
}

export function getVideoCapabilities(){
  const preset = getPresetByKey(el.providerPreset.value);
  const caps = preset && preset.capabilities ? preset.capabilities : {};
  return caps.video && typeof caps.video === 'object' ? caps.video : {};
}

export function getVideoModelForTask(){
  return getSelectedVideoModel();
}

export function buildVideoTaskFromForm(){
  const videoMode = state.videoMode === 'img2video' ? 'img2video' : 'txt2video';
  const videoCaps = getVideoCapabilities();
  return callHook('buildTask', {
    mediaType: 'video', mode: videoMode,
    files: videoMode === 'img2video' ? state.currentFiles.map(f=>({ file:f.file, role:'none' })) : [],
    prompt: el.prompt.value.trim(), negative: el.negative.value.trim(),
    preset: el.providerPreset.value, capabilities: getCapabilities(), videoCapabilities: videoCaps,
    videoModel: getVideoModelForTask(), model: getVideoModelForTask(), size: '', n: 1,
    videoSeconds: state.videoSeconds || '6',
    videoAspectRatio: state.videoAspectRatio || '16:9',
    videoResolution: state.videoResolution || '720P',
    base: el.apiBase.value.trim().replace(/\/+$/, ''), key: el.apiKey.value.trim()
  });
}

export function videoServerOptions(extra){
  const options = { ...(extra || {}) };
  const token = el.proxyToken ? String(el.proxyToken.value || '').trim() : '';
  if(token && !Object.prototype.hasOwnProperty.call(options, 'proxyToken')) options.proxyToken = token;
  return options;
}

export function videoTaskIsActive(task){
  return !!(task && task.mediaType === 'video' && (task.serverState === 'queued' || task.serverState === 'running' || task.serverState === 'submitting'));
}

export function clearVideoResult(entry){
  if(!entry) return;
  (entry.urls || []).forEach(url=>{ try{ URL.revokeObjectURL(url); }catch(e){} });
  entry.urls = [];
  entry.resultItems = [];
  entry.resultIndex = 0;
}

export function applyVideoStatus(task, status){
  if(!task || !status) return;
  task.jobId = status.jobId || task.jobId || '';
  task.providerId = status.providerId || task.providerId || '';
  task.serverState = status.state || task.serverState || '';
  task.videoProgress = Number(status.progress) || 0;
  task.videoUrl = status.videoUrl || task.videoUrl || '';
  task.serverError = status.error || '';
  task.serverUpdatedAt = Date.now();
  if(status.createdAt) task.submittedAt = Math.round(Number(status.createdAt) * 1000);
  if(status.startedAt) task.startTs = Math.round(Number(status.startedAt) * 1000);
  if(status.endedAt) task.endTs = Math.round(Number(status.endedAt) * 1000);
  if(task.serverState === 'queued') task.state = 'pending';
  else if(task.serverState === 'running') task.state = 'running';
  else if(task.serverState === 'done'){
    task.state = 'running';
    task.restoreNote = '正在加载视频…';
  }else if(task.serverState === 'cancelled'){
    task.state = 'cancelled';
    task.errorMsg = task.serverError || '任务已取消';
  }else if(task.serverState === 'interrupted' || task.serverState === 'expired'){
    task.state = 'error';
    task.errorMsg = task.serverError || (task.serverState === 'expired' ? '视频结果已过期' : '服务器重启后视频任务未续跑');
  }else if(task.serverState === 'error'){
    task.state = 'error';
    task.errorMsg = task.serverError || '视频后台任务失败';
  }
  callHook('renderCardState', task);
}

export async function fillVideoResult(task, entry, status){
  const fetchResults = getVideoHook('fetchVideoResults');
  if(!fetchResults) throw new Error('视频结果模块未接入');
  const results = await fetchResults(status, videoServerOptions());
  if(!results.length) throw new Error('视频任务完成但没有可用结果');
  if(state.taskEls[task.id] !== entry) return;
  clearVideoResult(entry);
  results.forEach(item=>{
    if(!item || !item.blob || !item.blob.size) return;
    const url = URL.createObjectURL(item.blob);
    entry.urls.push(url);
    entry.resultItems.push({ blob:item.blob, url, remoteUrl:getVideoHook('getVideoTaskResultUrl') ? getVideoHook('getVideoTaskResultUrl')(status.jobId, item.index) : '' });
  });
  if(!entry.resultItems.length) throw new Error('视频结果为空');
  task.serverState = 'done';
  task.state = 'done';
  task.videoMime = entry.resultItems[0].blob.type || 'video/mp4';
  task.videoUrl = status.videoUrl || task.videoUrl || '';
  task.restoreNote = '';
  task.endTs = task.endTs || Date.now();
  if(!task.historySaved){
    callHook('saveHistory', entry.resultItems.map(item=>({ blob:item.blob, url:item.remoteUrl })), task);
    task.historySaved = true;
  }
  callHook('renderCardState', task);
  callHook('scheduleAutosave');
}

export function watchVideoTaskEntry(task, entry){
  const watch = getVideoHook('watchVideoTask');
  if(!watch || !task || !task.jobId) return null;
  const old = getVideoHook('stopVideoTaskWatch');
  if(old) old(task.jobId);
  const handle = watch(task.jobId, {
    onStatus(status){ if(state.taskEls[task.id] !== entry) return; applyVideoStatus(task, status); callHook('scheduleAutosave'); },
    async onDone(status){
      try{ await fillVideoResult(task, entry, status); }
      catch(err){ if(state.taskEls[task.id] !== entry) return; task.state='error'; task.serverState='error'; task.errorMsg=err.message || String(err); callHook('renderCardState', task); callHook('scheduleAutosave'); }
    },
    onTerminal(status){ if(state.taskEls[task.id] !== entry) return; applyVideoStatus(task, status); callHook('scheduleAutosave'); },
    onError(err){ if(state.taskEls[task.id] !== entry) return; task.serverError=err.message || String(err); if(err && [401,403,404,410].includes(Number(err.status))){ task.state='error'; task.serverState=Number(err.status)===410?'expired':'error'; task.errorMsg=task.serverError; callHook('renderCardState', task); } callHook('scheduleAutosave'); }
  }, videoServerOptions());
  state.videoWatches.set(task.jobId, handle);
  return handle;
}

export async function runVideoTask(task){
  const entry = state.taskEls[task.id];
  const submit = getVideoHook('submitVideoTask');
  if(!entry || !submit) throw new Error('视频任务模块未接入');
  task.state='pending'; task.serverState='submitting'; task.serverError=''; task.errorMsg=''; task.startTs=Date.now(); task.submitAbortController=new AbortController(); callHook('renderCardState', task);
  try{
    ensureVideoClientTaskId(task);
    const submitted = await submit(task, videoServerOptions({ apiKey:task.key, signal:task.submitAbortController.signal }));
    task.submitAbortController = null;
    applyVideoStatus(task, submitted);
    callHook('scheduleAutosave');
    if(submitted.state === 'done') await fillVideoResult(task, entry, submitted);
    else if(['error','cancelled','interrupted','expired'].includes(task.serverState)) throw new Error(submitted.error || ('视频后台任务未成功创建：' + task.serverState));
    else watchVideoTaskEntry(task, entry);
  }catch(err){
    task.submitAbortController = null;
    const cancelled = task.cancelRequested || (err && err.code === 'cancelled');
    task.state = cancelled ? 'cancelled' : (err && err.code === 'timeout' ? 'timeout' : 'error');
    task.serverState = cancelled ? 'cancelled' : (task.serverState === 'submitting' ? 'error' : task.serverState);
    task.errorMsg = cancelled ? '任务已取消' : (err && err.message ? err.message : String(err));
    callHook('renderCardState', task); callHook('scheduleAutosave');
  }
}

export function cancelVideoEntry(task){
  const cancel = getVideoHook('cancelVideoTask');
  const stop = getVideoHook('stopVideoTaskWatch');
  if(stop && task.jobId) stop(task.jobId);
  if(state.videoWatches && task.jobId) state.videoWatches.delete(task.jobId);
  if(!cancel || !task.jobId) return;
  void cancel(task.jobId, videoServerOptions()).then(status=>{ applyVideoStatus(task,status); callHook('scheduleAutosave'); }).catch(err=>{ task.serverError=err.message || String(err); callHook('scheduleAutosave'); });
}

export async function downloadArchivedVideo(task){
  if(!task) return;
  const rawUrl = String(task.videoUrl || (task.jobId ? getVideoTaskResultUrl(task.jobId, 0) : '') || '').trim();
  if(!rawUrl){ toast('该视频没有可用的结果地址，请重试任务', 'err'); return; }
  try{
    const res = await fetchWithTimeout(getRequestUrl(rawUrl), { cache:'no-store' }, REQUEST_TIMEOUTS.videoGenerate);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if(!blob || !blob.size) throw new Error('视频结果为空');
    const ext = mimeToExt(blob.type || task.videoMime || 'video/mp4') || 'mp4';
    callHook('downloadBlob', blob, 'ai_video_archive_' + Date.now() + '_t' + task.id + '.' + ext, null);
    task.videoMime = blob.type || task.videoMime || 'video/mp4';
    task.restoreNote = '';
    callHook('scheduleAutosave');
    toast('✅ 视频已下载', 'ok');
  }catch(err){
    const msg = err && err.message ? err.message : String(err);
    task.restoreNote = /HTTP 404|HTTP 410/.test(msg) ? '视频结果已过期' : '视频下载失败：' + msg;
    callHook('renderCardState', task);
    callHook('scheduleAutosave');
    toast('❌ ' + task.restoreNote, 'err');
  }
}

