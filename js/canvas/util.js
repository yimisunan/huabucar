import { $, LS_KEY, refs } from './state.js';

export function lsGet(key, def){ try{ const v = localStorage.getItem(key); return v==null ? def : JSON.parse(v); }catch(e){ return def; } }
export function lsSet(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); return true; }catch(e){ return false; } }
export function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=> c==='&'?'&amp;':c==='<'?'&lt;':c==='>'?'&gt;':c==='"'?'&#34;':'&#39;'); }
export function cleanB64(b64){ return String(b64||'').replace(/^data:[^;]+;base64,/i, ''); }
export function sniffMime(b64){ const c = b64?b64[0]:''; if(c==='/') return 'image/jpeg'; if(c==='R') return 'image/gif'; if(c==='U') return 'image/webp'; return 'image/png'; }
export function mimeToExt(mime){
  const type = String(mime || '').split(';', 1)[0].trim().toLowerCase();
  const ext = ({
    'image/jpeg':'jpg','image/webp':'webp','image/gif':'gif',
    'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','video/x-m4v':'m4v'
  }[type]);
  if(ext) return ext;
  return type.startsWith('video/') ? '' : 'png';
}
export function b64ToBlob(b64){
  const pad = b64.length % 4;
  const fixed = pad ? b64 + '='.repeat(4 - pad) : b64;
  const bin = atob(fixed);
  const arr = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i); return new Blob([arr], {type:sniffMime(b64)});
}
export function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
export function dataUrlToBlob(dataUrl){
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl);
  if(!m) throw new Error('非法 dataURL');
  const b64 = m[2];
  const pad = b64.length % 4;
  const bin = atob(pad ? b64 + '='.repeat(4 - pad) : b64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return new Blob([arr], { type: m[1] });
}
export function toast(msg, type){
  const t = $('toast');
  t.className = type==='err' ? 'err' : type==='ok' ? 'ok' : '';
  t.textContent = msg;
  t.classList.add('show');
  if(refs.state.toastTimer) clearTimeout(refs.state.toastTimer);
  refs.state.toastTimer = setTimeout(()=> t.classList.remove('show'), type==='loading' ? 10000 : 3600);
}
export function fileFromBlob(blob, name, type){
  return new File([blob], name || ('ref_' + Date.now() + '.png'), { type: type || blob.type || 'image/png' });
}
export function isPrivateApiUrl(url){
  try{
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host) || /^10(?:\.\d{1,3}){3}$/.test(host) || /^192\.168(?:\.\d{1,3}){2}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host);
  }catch(e){ return false; }
}
export function localApiProxyHint(url){
  if(!isPrivateApiUrl(url) || !refs.state.proxyStatus.known || refs.state.proxyStatus.allowPrivate) return '';
  try{ if(new URL(url).origin === location.origin) return ''; }catch(e){}
  return '检测到本机/局域网 API，但当前生图服务器未开启私网代理。请以 ALLOW_PRIVATE=1 重启生图服务器后重试。';
}
export function getRequestUrl(url){
  if(!/^https?:\/\//i.test(url)) return url;
  if(!/^https?:$/i.test(location.protocol)) return url;
  try{
    const target = new URL(url);
    if(target.origin === location.origin) return url;
    const el = refs.el;
    const live = (el.proxyToken && el.proxyToken.value) ? el.proxyToken.value.trim() : '';
    const t = live || (lsGet(LS_KEY, {}).proxyToken || '').trim();
    return '/api/proxy?url=' + encodeURIComponent(url) + (t ? '&token=' + encodeURIComponent(t) : '');
  }catch(e){ return url; }
}
export async function fetchWithTimeout(url, options, timeoutMs, externalSignal, consume){
  const controller = new AbortController();
  let timedOut = false;
  const tid = setTimeout(()=>{ timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = ()=> controller.abort();
  if(externalSignal){
    if(externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onAbort, { once:true });
  }
  try{
    const response = await fetch(getRequestUrl(url), { ...options, signal: controller.signal });
    return typeof consume === 'function' ? await consume(response) : response;
  }catch(err){
    if(timedOut){ const e = new Error('请求超时（' + Math.round(timeoutMs/1000) + ' 秒）'); e.code='timeout'; throw e; }
    if(externalSignal && externalSignal.aborted){ const e = new Error('请求已取消'); e.code='cancelled'; throw e; }
    throw err;
  }finally{
    clearTimeout(tid);
    if(externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}
/* API-18：上游两类失败语义完全不同（同为 upstream_error）——
   ① 内容审核拒绝（safety system / 审核拒绝）：重试无意义，必须改提示词；
   ② 上游不可达（upstream provider could not be reached）：可换模型/稍后重试。
   这里按 message 关键词分流，供 parseApiError 追加人话建议。*/
export function classifyApiError(message, status){
  const s = String(message || '').toLowerCase();
  if(/safety system|safety|unsafe|nsfw|sexual|explicit|审核|内容安全|content[_ ]?policy|moderation|violat|不安全|敏感/.test(s)) return 'safety';
  if(/upstream provider|could not be reached|unreachable|timed? ?out|econn|socket|bad gateway|service unavailable/.test(s)) return 'upstream';
  const st = Number(status) || 0;
  if(st === 401 || st === 403) return 'auth';
  if(st === 429) return 'rate';
  if(st === 413) return 'toolarge';
  if(st >= 500) return 'upstream';
  return 'other';
}
export function describeApiError(kind){
  return {
    safety: '内容被审核拒绝：重试原提示词无效，请修改提示词后重试',
    upstream: '上游模型暂不可达：可换模型或稍后再试',
    auth: 'Key 无效或未授权',
    rate: '触发限流：请稍后重试',
    toolarge: '请求体过大：参考图合计请控制在 23MB 以内',
    other: ''
  }[kind] || '';
}
export async function parseApiError(res){
  let msg = 'HTTP ' + res.status;
  try{
    const text = await res.text();
    try{ const j = JSON.parse(text); msg += '\n' + (j.error?.message || JSON.stringify(j)); }
    catch(e){ msg += '\n' + text.slice(0, 500); }
  }catch(e){ msg += '\n(无法读取响应内容)'; }
  const hint = describeApiError(classifyApiError(msg, res.status));
  if(hint) msg += '\n［' + hint + '］';
  return msg;
}

/* 复制文本：navigator.clipboard 在非安全上下文（http + 局域网 IP）不可用，
   安卓 WebView / 老版 Chrome 也会 reject，这里统一兜底到 execCommand。*/
export async function copyText(text){
  const s = String(text == null ? '' : text);
  if(!s) return false;
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      await navigator.clipboard.writeText(s);
      return true;
    }
  }catch(e){ /* 降级到 execCommand */ }
  try{
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    if(ta.setSelectionRange) ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  }catch(e2){ return false; }
}
