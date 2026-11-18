import { REQUEST_TIMEOUTS } from './state.js';
import { fetchWithTimeout, getRequestUrl } from './util.js';

export const VIDEO_TASK_STATES = Object.freeze({
  queued:'queued', running:'running', done:'done', error:'error',
  cancelled:'cancelled', expired:'expired', interrupted:'interrupted'
});

const TERMINAL = new Set(['done','error','cancelled','expired','interrupted']);
const CLIENT_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const watches = new Map();

export class VideoTaskError extends Error{
  constructor(message,status,code,payload){
    super(message); this.name='VideoTaskError'; this.status=Number(status)||0;
    this.code=code||'video_task_error'; this.payload=payload||null;
  }
}

function randomPart(){
  try{
    if(globalThis.crypto && crypto.getRandomValues){
      const a=new Uint8Array(8); crypto.getRandomValues(a);
      return Array.from(a).map(v=>v.toString(16).padStart(2,'0')).join('');
    }
  }catch(e){}
  return Math.random().toString(36).slice(2);
}

export function ensureVideoClientTaskId(task){
  if(!task || typeof task!=='object') throw new VideoTaskError('视频任务对象无效',0,'video_task_invalid');
  if(CLIENT_ID_RE.test(String(task.clientTaskId||''))) return task.clientTaskId;
  task.clientTaskId='vct_'+Date.now().toString(36)+'_'+randomPart();
  return task.clientTaskId;
}

function proxyToken(options){ return String(options && options.proxyToken || '').trim(); }
function headers(options, apiKey){
  const h={...(options && options.headers || {})};
  const token=proxyToken(options);
  if(token) h['X-Proxy-Token']=token;
  if(apiKey) h['X-Provider-API-Key']=String(apiKey);
  return h;
}
function path(jobId,suffix){ return '/api/video-tasks/'+encodeURIComponent(String(jobId||''))+(suffix||''); }
function parse(text){ try{return text?JSON.parse(text):null;}catch(e){return null;} }
function errorText(status,text,payload){
  const detail=payload && payload.error && payload.error.message ? payload.error.message : String(text||'').slice(0,500);
  return '视频后台任务请求失败（HTTP '+status+'）'+(detail?'：'+detail:'');
}

async function jsonRequest(url, options, timeout){
  const opts=options||{};
  const {apiKey,signal,headers:extraHeaders,...fetchOptions}=opts;
  const res=await fetchWithTimeout(url,{...fetchOptions,headers:headers({ ...opts, headers:extraHeaders },apiKey)},timeout||REQUEST_TIMEOUTS.videoStatus,signal||null);
  const text=await res.text(); const payload=parse(text);
  if(!res.ok) throw new VideoTaskError(errorText(res.status,text,payload),res.status,payload&&payload.error&&payload.error.type||'video_http_error',payload);
  if(!payload || typeof payload!=='object') throw new VideoTaskError('视频后台任务返回了无效 JSON',res.status,'video_invalid_json');
  return payload;
}

async function blobRequest(url, options, timeout){
  const opts=options||{}; const {signal,headers:extraHeaders,...fetchOptions}=opts;
  const res=await fetchWithTimeout(url,{...fetchOptions,headers:headers({ ...opts, headers:extraHeaders },'')},timeout||REQUEST_TIMEOUTS.videoStatus,signal||null);
  if(!res.ok){ const text=await res.text(); const payload=parse(text); throw new VideoTaskError(errorText(res.status,text,payload),res.status,'video_result_error',payload); }
  const blob=await res.blob();
  if(!blob || !blob.size) throw new VideoTaskError('视频结果为空',res.status,'video_empty_result');
  return blob;
}

export function normalizeVideoState(value){
  const s=String(value||'').toLowerCase();
  if(['queued','pending','submitting','created'].includes(s)) return 'queued';
  if(['running','processing','generating','in_progress'].includes(s)) return 'running';
  if(['done','completed','complete','succeeded','success'].includes(s)) return 'done';
  if(['failed','failure','error'].includes(s)) return 'error';
  if(['cancelled','canceled','aborted'].includes(s)) return 'cancelled';
  if(['expired','timeout','timed_out'].includes(s)) return s==='timeout'||s==='timed_out'?'expired':'expired';
  if(['interrupted','interrupted_by_restart'].includes(s)) return 'interrupted';
  return s||'queued';
}

export function normalizeVideoStatus(raw){
  const source=raw&&typeof raw==='object'?raw:{};
  const status={...source};
  status.jobId=source.jobId||source.job_id||source.localJobId||source.local_job_id||'';
  status.providerId=source.providerId||source.provider_id||source.videoId||source.video_id||source.id||'';
  status.state=normalizeVideoState(source.state||source.status);
  const p=source.progress!=null?source.progress:(source.percent!=null?source.percent:source.completion!=null?source.completion:0);
  status.progress=Math.max(0,Math.min(100,Number(p)||0));
  if(!status.results){
    if(Array.isArray(source.data)) status.results=source.data;
    else if(Array.isArray(source.results)) status.results=source.results;
    else if(Array.isArray(source.output)) status.results=source.output;
  }
  status.videoUrl=source.videoUrl||source.video_url||source.contentUrl||source.content_url||source.outputUrl||source.output_url||'';
  return status;
}

function videoCaps(task){
  const direct=task && task.videoCapabilities;
  if(direct && typeof direct==='object') return direct;
  const capabilities=task && task.capabilities;
  if(capabilities && capabilities.video && typeof capabilities.video==='object') return capabilities.video;
  return capabilities && typeof capabilities==='object' ? capabilities : {};
}

export function buildVideoTaskSpec(task, options){
  if(!task || typeof task!=='object') throw new VideoTaskError('视频任务对象无效',0,'video_task_invalid');
  const caps=videoCaps(task); const ep=caps.endpoints||{};
  const mode=task.mode==='img2video'?'img2video':'txt2video';
  ensureVideoClientTaskId(task);
  return {
    clientTaskId:task.clientTaskId, mediaType:'video', mode,
    model:String(task.videoModel||task.model||''),
    prompt:String(task.requestPrompt||task.prompt||''),
    requestPrompt:String(task.requestPrompt||task.prompt||''),
    negative:String(task.negative||''), requestNegative:String(task.requestNegative||task.negative||''),
    seconds:String(task.videoSeconds||task.seconds||caps.defaultSeconds||'6'),
    aspect_ratio:String(task.videoAspectRatio||task.aspectRatio||caps.defaultAspectRatio||'16:9'),
    resolution:String(task.videoResolution||task.resolution||caps.defaultResolution||'720P'),
    baseUrl:String(task.base||task.baseUrl||'').replace(/\/+$/,''),
    videoEndpoints:{create:ep.create||'/videos',status:ep.status||'/videos/{id}',content:ep.content||'/videos/{id}/content'},
    referenceField:caps.referenceField||'image', multiReferenceField:caps.multiReferenceField||'images',
    maxReferences:Number(caps.maxReferences)||4
  };
}

export async function submitVideoTask(task, options){
  const opts=options||{}; const apiKey=String(opts.apiKey||task&&task.key||'').trim();
  if(!apiKey) throw new VideoTaskError('缺少视频 API Key',401,'video_missing_api_key');
  const spec=buildVideoTaskSpec(task,opts); const form=new FormData(); form.append('spec',JSON.stringify(spec));
  if(spec.mode==='img2video'){
    const files=Array.isArray(task.files)?task.files:[];
    if(!files.length) throw new VideoTaskError('图片生视频任务缺少参考图',400,'video_missing_reference');
    files.forEach((item,i)=>{ const f=item&&item.file; if(!f) throw new VideoTaskError('视频参考图数据为空：'+i,400,'video_missing_upload'); form.append('ref_'+i,f,f.name||('video_reference_'+i+'.png')); });
  }
  const result=normalizeVideoStatus(await jsonRequest('/api/video-tasks',{method:'POST',body:form,apiKey,proxyToken:opts.proxyToken,signal:opts.signal},Number(opts.timeoutMs)||REQUEST_TIMEOUTS.videoGenerate));
  if(!result.jobId) throw new VideoTaskError('视频后台任务服务器未返回 job_id',0,'video_missing_job_id',result);
  return result;
}

export async function getVideoTaskStatus(jobId,options){
  if(!jobId) throw new VideoTaskError('缺少视频 job_id',400,'video_missing_job_id');
  return normalizeVideoStatus(await jsonRequest(path(jobId),{method:'GET',proxyToken:options&&options.proxyToken,signal:options&&options.signal},Number(options&&options.timeoutMs)||REQUEST_TIMEOUTS.videoStatus));
}

export function getVideoTaskResultUrl(jobId,index){ return path(jobId,'/result/'+encodeURIComponent(String(index==null?0:index))); }

export async function fetchVideoTaskResult(jobId,index,options){
  return blobRequest(getVideoTaskResultUrl(jobId,index==null?0:index),{method:'GET',proxyToken:options&&options.proxyToken,signal:options&&options.signal},Number(options&&options.timeoutMs)||REQUEST_TIMEOUTS.videoGenerate);
}

function resultUrlFrom(item){
  if(typeof item==='string') return item;
  if(!item||typeof item!=='object') return '';
  return item.url||item.video_url||item.videoUrl||item.content_url||item.contentUrl||item.output_url||item.outputUrl||'';
}

function resultListFromStatus(status){
  const s=status&&typeof status==='object'?status:{};
  if(Array.isArray(s.results) && s.results.length) return s.results;
  const direct=s.videoUrl||s.video_url||s.contentUrl||s.content_url||s.outputUrl||s.output_url||'';
  return direct ? [{index:0,url:direct}] : [];
}

export async function fetchVideoResults(status,options){
  const s=normalizeVideoStatus(status); const list=resultListFromStatus(s);
  if(list.length){
    return Promise.all(list.map(async(item,i)=>{
      const index=Number(item&&item.index!=null?item.index:i);
      const remote=resultUrlFrom(item);
      const blob=remote ? await blobRequest(getRequestUrl(remote),{method:'GET',proxyToken:options&&options.proxyToken},Number(options&&options.timeoutMs)||REQUEST_TIMEOUTS.videoGenerate) : await fetchVideoTaskResult(s.jobId,index,options);
      return {index,blob,mime:item&&item.mime||blob.type||'video/mp4',size:item&&item.size||blob.size};
    }));
  }
  if(s.jobId){
    const blob=await fetchVideoTaskResult(s.jobId,0,options);
    return [{index:0,blob,mime:blob.type||'video/mp4',size:blob.size}];
  }
  return [];
}

export async function cancelVideoTask(jobId,options){
  if(!jobId) throw new VideoTaskError('缺少视频 job_id',400,'video_missing_job_id');
  return normalizeVideoStatus(await jsonRequest(path(jobId,'/cancel'),{method:'POST',proxyToken:options&&options.proxyToken,signal:options&&options.signal},REQUEST_TIMEOUTS.videoStatus));
}

export function isVideoTerminalState(value){ return TERMINAL.has(normalizeVideoState(value)); }
export function stopVideoTaskWatch(jobId){ const h=watches.get(String(jobId||'')); if(h) h.stop(); }
export function stopAllVideoTaskWatches(){ Array.from(watches.values()).forEach(h=>h.stop()); }

export function watchVideoTask(jobId,callbacks,options){
  if(!jobId) throw new VideoTaskError('缺少视频 job_id',400,'video_missing_job_id');
const key=String(jobId); const cb=callbacks||{}; const opts=options||{};
  stopVideoTaskWatch(key);
  const interval=Math.max(1000,Number(opts.intervalMs)||4000);
  const maxDuration=Math.max(1000,Number(opts.maxDurationMs)||REQUEST_TIMEOUTS.videoGenerate);
  let stopped=false,inFlight=false,timer=null,controller=null,errors=0; const started=Date.now();
  const handle={jobId:key,stop(){ if(stopped)return; stopped=true; if(timer)clearTimeout(timer); timer=null; if(controller)controller.abort(); controller=null; if(watches.get(key)===handle)watches.delete(key); }};
  const schedule=delay=>{if(!stopped)timer=setTimeout(tick,delay==null?interval:delay);};
  const tick=async()=>{
    if(stopped||inFlight)return;
    if(Date.now()-started>maxDuration){ if(typeof cb.onError==='function')cb.onError(new VideoTaskError('视频任务轮询超时',0,'video_timeout')); handle.stop(); return; }
    inFlight=true; controller=new AbortController();
    try{
      const status=await getVideoTaskStatus(key,{proxyToken:opts.proxyToken,signal:controller.signal,timeoutMs:opts.timeoutMs});
      errors=0; if(stopped)return; if(typeof cb.onStatus==='function')cb.onStatus(status);
      if(isVideoTerminalState(status.state)){
        if(status.state==='done' && typeof cb.onDone==='function') await cb.onDone(status);
        else if(status.state!=='done' && typeof cb.onTerminal==='function') cb.onTerminal(status);
        handle.stop(); return;
      }
    }catch(err){
      if(!stopped && !(err&&err.code==='cancelled')){
        errors++; if(typeof cb.onError==='function')cb.onError(err,errors);
        if(err&&[401,403,404,410].includes(Number(err.status))){handle.stop();return;}
      }
    }finally{
      inFlight=false; controller=null;
      if(!stopped){ const backoff=errors?Math.min(interval*Math.pow(2,Math.min(errors,4)),30000):interval; schedule(backoff); }
    }
  };
  watches.set(key,handle); tick(); return handle;
}