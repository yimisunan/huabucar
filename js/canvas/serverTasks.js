import { LS_KEY } from './state.js';
import { resolveImageSize } from './imageSizes.js';
import { lsGet, fetchWithTimeout, getRequestUrl } from './util.js';

export const TASK_STATES = Object.freeze({
  queued: 'queued',
  running: 'running',
  done: 'done',
  error: 'error',
  cancelled: 'cancelled',
  expired: 'expired',
  interrupted: 'interrupted'
});

export const TASK_REQUEST_TIMEOUTS = Object.freeze({
  capabilities: 15000,
  submit: 120000,
  status: 20000,
  cancel: 15000,
  result: 120000,
  pollInterval: 3000
});

const TERMINAL_STATES = new Set([
  TASK_STATES.done,
  TASK_STATES.error,
  TASK_STATES.cancelled,
  TASK_STATES.expired,
  TASK_STATES.interrupted
]);

const CLIENT_TASK_ID_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

let runtimeEl = null;
const watches = new Map();

export class ServerTaskError extends Error {
  constructor(message, status, code, payload) {
    super(message);
    this.name = 'ServerTaskError';
    this.status = Number(status) || 0;
    this.code = code || 'server_task_error';
    this.payload = payload || null;
  }
}

export function bindRuntime(_state, el) {
  runtimeEl = el || null;
  // 开机回传：用于在 server.log 里确证「页面加载的是哪一版 JS」
  try {
    if(navigator && navigator.sendBeacon){
      navigator.sendBeacon(getRequestUrl('/api/client-log'), new Blob([JSON.stringify({
        kind: 'boot', build: 'connfix2', href: String(location.href || ''),
        ua: String(navigator.userAgent || '').slice(0, 120), t: Date.now()
      })], { type: 'application/json' }));
    }
  } catch(e) {}
}

function getProxyToken(options) {
  const opts = options || {};

  if(Object.prototype.hasOwnProperty.call(opts, 'proxyToken')) {
    return String(opts.proxyToken || '').trim();
  }

  const live = runtimeEl && runtimeEl.proxyToken
    ? String(runtimeEl.proxyToken.value || '').trim()
    : '';

  if(live) return live;

  try {
    const saved = lsGet(LS_KEY, {});
    return String(saved && saved.proxyToken || '').trim();
  }catch(e) {
    return '';
  }
}

function buildHeaders(options, apiKey) {
  const opts = options || {};
  const headers = { ...(opts.headers || {}) };
  const token = getProxyToken(opts);

  if(token) headers['X-Proxy-Token'] = token;
  if(apiKey) headers['X-Provider-API-Key'] = String(apiKey);

  return headers;
}

function apiTaskPath(jobId, suffix) {
  const id = encodeURIComponent(String(jobId || ''));
  return '/api/tasks/' + id + (suffix || '');
}

function parseResponseText(text) {
  if(!text) return null;
  try {
    return JSON.parse(text);
  }catch(e) {
    return null;
  }
}

function responseErrorMessage(status, text, payload) {
  const error = payload && payload.error;
  const detail = error && (error.message || error.detail)
    ? (error.message || error.detail)
    : String(text || '').slice(0, 500);
  const code = error && (error.code || error.type)
    ? (error.code || error.type)
    : (payload && payload.error_code ? payload.error_code : '');
  const suffix = code && code !== 'task_api' ? ' [' + code + ']' : '';

  return '后台任务请求失败（HTTP ' + status + ')' + suffix + (detail ? '：' + detail : '');
}

function safeTaskString(value, limit){
  if(value == null) return '';
  if(typeof value === 'object') value = value.message || value.detail || value.name || '';
  return String(value || '').trim().slice(0, limit || 1000);
}

export function extractTaskServerMeta(status){
  const root = status && typeof status === 'object' ? status : {};
  const sources = [root, root.meta, root.metadata, root.native, root.upstream, root.provider].filter(v=> v && typeof v === 'object');
  const pick = keys=>{
    for(const source of sources) for(const key of keys){
      if(source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
    }
    return '';
  };
  const error = root.error && typeof root.error === 'object' ? root.error : null;
  const urls = pick(['resultUrls','result_urls']);
  const resultUrls = (Array.isArray(urls) ? urls : urls ? [urls] : [])
    .map(v=> safeTaskString(v, 2048)).filter(v=> v && (v.startsWith('/') || /^https?:\/\//i.test(v))).slice(0, 16);
  const countValue = Number(pick(['imageCount','image_count','resultCount','result_count','result_count_saved']) || (Array.isArray(root.results) ? root.results.length : 0));
  return {
    providerTaskId: safeTaskString(pick(['providerTaskId','provider_task_id','upstreamTaskId','upstream_task_id','nativeTaskId','native_task_id','taskId','task_id']), 200),
    size: safeTaskString(pick(['finalSize','final_size','size']), 100),
    resolution: safeTaskString(pick(['finalResolution','final_resolution','resolution']), 100),
    quality: safeTaskString(pick(['finalQuality','final_quality','quality']), 100),
    imageSizeTier: safeTaskString(pick(['imageSizeTier','image_size_tier','sizeTier','size_tier']), 100),
    imageCount: Number.isFinite(countValue) && countValue >= 0 ? countValue : resultUrls.length,
    resultUrls,
    costUsd: pick(['costUsd','cost_usd','cost']),
    errorCode: safeTaskString((error && (error.code || error.type)) || pick(['errorCode','error_code']), 120)
  };
}

async function requestJson(path, options, timeoutMs) {
  const opts = options || {};
  const { apiKey, signal, headers, proxyToken, ...fetchOptions } = opts;
  return fetchWithTimeout(path, {
    ...fetchOptions,
    cache: 'no-store',
    headers: buildHeaders({ ...opts, headers }, apiKey)
  }, timeoutMs, signal || null, async res=>{
    const text = await res.text();
    const payload = parseResponseText(text);
    if(!res.ok) throw new ServerTaskError(responseErrorMessage(res.status, text, payload), res.status,
      payload && payload.error && (payload.error.code || payload.error.type) || 'task_http_error', payload);
    if(!payload || typeof payload !== 'object') throw new ServerTaskError('后台任务服务器返回了无效 JSON', res.status, 'task_invalid_json');
    return payload;
  });
}

async function requestBlob(path, options, timeoutMs) {
  const opts = options || {};
  const { signal, headers, proxyToken, ...fetchOptions } = opts;
  return fetchWithTimeout(path, { ...fetchOptions, cache:'no-store', headers:buildHeaders({ ...opts, headers }, '') }, timeoutMs, signal || null, async res=>{
    if(!res.ok){
      const text = await res.text(), payload = parseResponseText(text);
      throw new ServerTaskError(responseErrorMessage(res.status, text, payload), res.status, 'task_result_error', payload);
    }
    const blob = await res.blob();
    if(!blob || !blob.size || !/^image\/(png|jpeg|webp|gif)(;|$)/i.test(blob.type))
      throw new ServerTaskError('后台返图为空或格式无效，可恢复原任务补取', 502, 'task_invalid_result');
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const head = Array.from(bytes, n=>String.fromCharCode(n)).join('');
    const valid = head.startsWith('\x89PNG\r\n\x1a\n') || head.startsWith('\xff\xd8\xff') || /^GIF8[79]a/.test(head) || (head.startsWith('RIFF') && head.slice(8,12)==='WEBP');
    if(!valid) throw new ServerTaskError('后台返图内容不是图片，可补取原结果', 502, 'task_invalid_result');
    return blob;
  });
}

function randomPart() {
  try {
    if(globalThis.crypto && crypto.getRandomValues) {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      return Array.from(bytes)
        .map(v=> v.toString(16).padStart(2, '0'))
        .join('');
    }
  }catch(e) {}

  return Math.random().toString(36).slice(2);
}

export function ensureClientTaskId(task) {
  if(!task || typeof task !== 'object') {
    throw new ServerTaskError(
      '无法为无效任务创建客户端任务 ID',
      0,
      'task_invalid'
    );
  }

  if(CLIENT_TASK_ID_RE.test(String(task.clientTaskId || ''))) {
    return task.clientTaskId;
  }

  task.clientTaskId = 'ct_' + Date.now().toString(36) + '_' + randomPart();
  return task.clientTaskId;
}

export function isTerminalTaskState(state) {
  return TERMINAL_STATES.has(String(state || ''));
}

export async function checkTaskApi(options) {
  const data = await requestJson(
    '/api/task-capabilities',
    options || {},
    TASK_REQUEST_TIMEOUTS.capabilities
  );

  if(data.ok !== true || data.taskApi !== true) {
    throw new ServerTaskError(
      '当前生图服务器不支持后台任务 API，请重启新版生图服务器',
      0,
      'task_api_unavailable',
      data
    );
  }

  return data;
}

export function buildTaskSpec(task, options) {
  if(!task || typeof task !== 'object') {
    throw new ServerTaskError('无法为无效任务构造后台任务参数', 0, 'task_invalid');
  }

  const opts = options || {};
  const capabilities = task.capabilities || {};
  const imageEndpoints = capabilities.imageEndpoints || {};

  const requestPrompt = opts.requestPrompt != null
    ? opts.requestPrompt
    : (task.requestPrompt != null ? task.requestPrompt : task.prompt);

  const requestNegative = opts.requestNegative != null
    ? opts.requestNegative
    : (task.requestNegative != null ? task.requestNegative : task.negative);

  const referenceRoles = (task.files || []).map((item, index)=>{
    return item && item.role
      ? item.role
      : 'none';
  });

  return {
    clientTaskId: ensureClientTaskId(task),
    overshootBatchId: String(task.overshootId || ''),
    overshootTarget: Number(task.overshootTarget) || 0,
    mode: task.mode || 'txt2img',
    model: task.model || '',
    size: task.inpaint ? (task.size || '') : resolveImageSize(task.size || '', capabilities, task.imageSizeMode),
    imageSizeMode: task.inpaint ? 'custom' : (task.imageSizeMode || 'preset'),
    n: Number(task.n) || 1,
    prompt: String(task.prompt || ''),
    requestPrompt: String(requestPrompt || ''),
    negative: String(task.negative || ''),
    requestNegative: String(requestNegative || ''),
    quality: task.quality || '',
    complexity: task.complexity || '',
    background: task.background || '',
    outputFormat: task.outputFormat || '',
    responseFormat: task.responseFormat || '',
    stream: !!task.stream,
    resolution: capabilities.imageSizePolicy === 'futureai-ratio' ? String(task.resolution || task.imageResolution || capabilities.defaultResolution || '1K').toUpperCase() : (task.resolution || task.imageResolution || ''),
    seed: task.seed != null ? task.seed : '',
    colorCorrection: task.colorCorrection != null ? task.colorCorrection : '',
    resizeMethod: task.resizeMethod || '',
    baseUrl: String(task.base || '').replace(/\/+$/, ''),
    protocol: capabilities.protocol || '',
    taskEndpoint: capabilities.taskEndpoint || '',
    taskStatusEndpoint: capabilities.taskStatusEndpoint || '',
    imageEndpoint: imageEndpoints.generate || '/images/generations',
    editEndpoint: imageEndpoints.edit || '/images/edits',
    referenceFieldStrategy: capabilities.referenceFieldStrategy || 'repeat-image',
    referenceRoles,
    inpaint: !!task.inpaint,
    capabilities: {
      protocol: capabilities.protocol || '',
      taskEndpoint: capabilities.taskEndpoint || '',
      taskStatusEndpoint: capabilities.taskStatusEndpoint || '',
      imageEndpoints: {
        generate: imageEndpoints.generate || '/images/generations',
        edit: imageEndpoints.edit || '/images/edits'
      },
      referenceFieldStrategy: capabilities.referenceFieldStrategy || 'repeat-image',
      negativePrompt: capabilities.negativePrompt,
      streamCapable: capabilities.streamCapable === true,
      streamFallbackToSync: capabilities.streamFallbackToSync !== false,
      imageParams: { ...(capabilities.imageParams || {}) },
      asyncEndpoints: capabilities.asyncEndpoints ? { ...capabilities.asyncEndpoints } : undefined,
      maxBodyMiB: capabilities.maxBodyMiB,
      maxReferences: capabilities.maxReferences,
      imageSizePolicy:capabilities.imageSizePolicy,
      uploadEndpoint:capabilities.uploadEndpoint,
      aspectRatios:capabilities.aspectRatios,
      imageSizePresets:capabilities.imageSizePresets,
      sizeModes:capabilities.sizeModes,
      resolutionOptions:capabilities.resolutionOptions,
      defaultResolution:capabilities.defaultResolution,
      maxRefFileBytes:capabilities.maxRefFileBytes,
      maxRefTotalBytes:capabilities.maxRefTotalBytes,
      referenceMimeTypes:capabilities.referenceMimeTypes,
      promptMaxChars:capabilities.promptMaxChars,
      supportsIdempotency: capabilities.supportsIdempotency === true,
      modelOverrides: capabilities.modelOverrides,
      resolvedForModel: capabilities.modelId || '',
      outputFormatOptions: capabilities.outputFormatOptions,
      complexityOptions: capabilities.complexityOptions,
      complexityModelPattern: capabilities.complexityModelPattern,
      preferredResponseFormat: capabilities.preferredResponseFormat,
      pollIntervalMs: capabilities.pollIntervalMs,
      terminalRetentionHours: capabilities.terminalRetentionHours
    }
  };
}

async function probeRefReadable(file) {
  // 只用于诊断：任何"探测不了"的情况都放行（fail-open），绝不因此拦截提交。
  try {
    if(!file) return { ok: false, how: 'missing' };
    if(typeof file.slice !== 'function' || typeof file.size !== 'number') {
      return { ok: true, how: 'non-blob-assumed' };
    }
    const head = file.slice(0, 32);
    if(head && typeof head.arrayBuffer === 'function') {
      const buf = await head.arrayBuffer();
      return { ok: !!(buf && buf.byteLength > 0), how: 'arrayBuffer' };
    }
    if(typeof FileReader === 'function') {
      return await new Promise(function(res){
        try {
          const fr = new FileReader();
          fr.onload = function(){ res({ ok: !!(fr.result && fr.result.byteLength), how: 'FileReader' }); };
          fr.onerror = function(){ res({ ok: true, how: 'FileReader-error-assumed' }); };
          fr.readAsArrayBuffer(head);
        } catch(e) { res({ ok: true, how: 'FileReader-throw-assumed' }); }
      });
    }
    return { ok: true, how: 'assumed' };
  } catch(err) {
    return { ok: true, how: 'probe-error-assumed' };
  }
}

async function buildSubmitDiagnostics(task, err, attempts) {
  // 全部包裹，绝不抛错；结果拼成一行，直接显示在卡片上（POST 回传通道失效时仍可见）。
  const out = [];
  try { out.push('UA=' + String((navigator && navigator.userAgent) || '?').slice(0, 46)); } catch(e) {}
  try {
    const r = await fetch(getRequestUrl('/api/prompt-list'), { method: 'GET' });
    out.push('GET=' + r.status);
  } catch(e) { out.push('GET=' + ((e && e.name) || 'fail')); }
  try {
    const r = await fetch(getRequestUrl('/api/ping'), { method: 'POST', body: 'x' });
    out.push('POST=' + r.status);
  } catch(e) { out.push('POST=' + ((e && e.name) || 'fail')); }
  try {
    const fd = new FormData();
    fd.append('probe', new Blob(['x'], { type: 'text/plain' }), 'probe.txt');
    const r = await fetch(getRequestUrl('/api/ping'), { method: 'POST', body: fd });
    out.push('POST-FD=' + r.status);
  } catch(e) { out.push('POST-FD=' + ((e && e.name) || 'fail')); }
  try {
    const probe = (task && task.refProbe) || [];
    out.push('refs=' + (probe.length
      ? probe.map(function(p){ return p.how + '/' + Math.round((p.size || 0) / 1024) + 'KB'; }).join(',')
      : 'none'));
  } catch(e) {}
  out.push('try=' + attempts + ' err=' + ((err && err.name) || '?') + ':' + String((err && err.message) || '').slice(0, 40));
  return '［诊断］' + out.join(' | ');
}

async function reportSubmitFailure(task, err, attempts) {
  try {
    const files = Array.isArray(task && task.files) ? task.files : [];
    const refs = [];
    for(let i = 0; i < files.length; i++){
      const f = files[i] && files[i].file;
      refs.push({
        i: i,
        name: (f && f.name) || '',
        size: (f && f.size) || 0,
        type: (f && f.type) || '',
        readable: f ? (await probeRefReadable(f)) : { ok: false, how: 'missing' }
      });
    }
    let pingPost = 'n/a';
    try {
      const r = await fetch(getRequestUrl('/api/ping'), { method: 'POST', body: 'x' });
      pingPost = String(r.status);
    } catch(e) { pingPost = 'fail:' + ((e && e.name) || '') + '/' + ((e && e.message) || ''); }
    let pingGet = 'n/a';
    try {
      const r2 = await fetch(getRequestUrl('/api/task-capabilities'), { method: 'GET' });
      pingGet = String(r2.status);
    } catch(e) { pingGet = 'fail:' + ((e && e.name) || '') + '/' + ((e && e.message) || ''); }

    const payload = {
      at: new Date().toISOString(),
      kind: 'submit-failure',
      taskId: task && task.id,
      clientTaskId: task && task.clientTaskId,
      mediaType: task && task.mediaType,
      mode: task && task.mode,
      attempts: attempts,
      errorName: (err && err.name) || '',
      errorMessage: (err && err.message) || String(err),
      errorStatus: (err && err.status) != null ? err.status : null,
      errorCode: (err && err.code) || '',
      refCount: files.length,
      refs: refs,
      refProbe: task && task.refProbe ? task.refProbe : null,
      pingPost: pingPost,
      pingGet: pingGet,
      href: String(location.href || ''),
      ua: String((navigator && navigator.userAgent) || '').slice(0, 160)
    };
    const body = JSON.stringify(payload);
    // 双通道回传：sendBeacon 与 fetch 各发一次，旧内核上任一成功即可落盘
    try {
      if(navigator && navigator.sendBeacon){
        navigator.sendBeacon(getRequestUrl('/api/client-log'), new Blob([body], { type: 'application/json' }));
      }
    } catch(e) {}
    try {
      fetch(getRequestUrl('/api/client-log'), { method: 'POST', body: body, keepalive: true }).catch(()=>{});
    } catch(e) {}
  } catch(e) {}
}

function appendUpload(form, field, value, fallbackName) {
  if(!value) {
    throw new ServerTaskError(
      '任务参考图数据为空：' + field,
      0,
      'task_missing_upload'
    );
  }

  const name = value.name || fallbackName || (field + '.png');

  try {
    form.append(field, value, name);
  }catch(err) {
    throw new ServerTaskError(
      '无法上传任务参考图：' + field,
      0,
      'task_upload_error'
    );
  }
}

export async function submitServerTask(task, options) {
  const opts = options || {};
  const apiKey = opts.apiKey != null
    ? String(opts.apiKey || '').trim()
    : String(task && task.key || '').trim();

  if(!apiKey) {
    throw new ServerTaskError(
      '缺少生图 API Key，无法提交后台任务',
      401,
      'task_missing_api_key'
    );
  }

  const spec = buildTaskSpec(task, opts);

  // 参考图可读性探针：只记录诊断，绝不拦截提交（探测手段在不同内核上可用性不一，
  // 曾因 Blob.arrayBuffer 缺失导致全部误判为不可读）。
  if(spec.mode === 'img2img' && !spec.inpaint) {
    const probeFiles = Array.isArray(task.files) ? task.files : [];
    const probe = [];
    const broken = [];
    for(let i = 0; i < probeFiles.length; i++){
      const f = probeFiles[i] && probeFiles[i].file;
      // 严格但可靠的判定：真 File/Blob 一定满足 slice 函数 + 非零 size + 是 Blob 实例。
      // 恢复自持久化存储的"占位对象"（只有 name/size/url）在这里会被抓出来 → 提交必然 0.1s 失败且服务端零日志。
      const isReal = !!(f
        && typeof f === 'object'
        && typeof f.size === 'number' && f.size > 0
        && typeof f.slice === 'function'
        && (typeof Blob === 'undefined' || f instanceof Blob));
      const r = isReal ? { ok: true, how: 'real-blob' } : { ok: false, how: 'placeholder' };
      probe.push({
        i: i,
        name: (f && f.name) || '',
        size: (f && f.size) || 0,
        obj: f ? ((f.constructor && f.constructor.name) || typeof f) : 'null',
        ok: r.ok, how: r.how
      });
      if(!isReal) {
        broken.push((i + 1) + ' 号' + ((f && f.name) ? '「' + f.name + '」' : '') +
          '（对象类型=' + (f ? ((f.constructor && f.constructor.name) || typeof f) : '空') + '）');
      }
    }
    task.refProbe = probe;
    if(broken.length) {
      throw new ServerTaskError(
        '参考图对象已失效：' + broken.join('，') +
        '。请在画布上重新添加参考图后重试。（这是画布恢复旧任务时参考图持久化的已知缺陷，与图片文件本身无关）',
        0,
        'task_invalid_reference_object'
      );
    }
  }

  const buildForm = ()=>{
    const form = new FormData();
    form.append('spec', JSON.stringify(spec));

    if(spec.mode === 'img2img') {
      if(spec.inpaint) {
        appendUpload(
          form,
          'image',
          task.inpaint && task.inpaint.image,
          'inpaint.png'
        );
        appendUpload(
          form,
          'mask',
          task.inpaint && task.inpaint.mask,
          'mask.png'
        );
      }else{
        const files = Array.isArray(task.files) ? task.files : [];
        if(!files.length) {
          throw new ServerTaskError(
            '图生图任务缺少参考图（客户端无可上传的参考图数据）',
            400,
            'task_missing_reference'
          );
        }

        files.forEach((item, index)=>{
          appendUpload(
            form,
            'ref_' + index,
            item && item.file,
            'reference_' + index + '.png'
          );
        });
      }
    }

    return form;
  };

  // 连接竞态保护：服务器为短连接（HTTP/1.0），浏览器连接池偶发复用已关闭套接字，
  // 会让 POST 在 ~0.1s 内以 Failed to fetch 失败（且服务端无任何日志）。
  // 服务端按 clientTaskId 去重，因此重试不会产生重复任务，安全。
  const AUTO_RETRY_ON_NETWORK = 2;
  let lastError = null;
  for(let attempt = 0; attempt < AUTO_RETRY_ON_NETWORK; attempt++){
    try {
      const result = await requestJson(
        '/api/tasks',
        {
          method: 'POST',
          body: buildForm(),
          apiKey,
          proxyToken: opts.proxyToken,
          signal: opts.signal
        },
        Number(opts.timeoutMs) || TASK_REQUEST_TIMEOUTS.submit
      );

      if(!result.jobId) {
        throw new ServerTaskError(
          '后台任务服务器未返回 job_id',
          0,
          'task_missing_job_id',
          result
        );
      }

      return result;
    } catch(err) {
      lastError = err;
      const networkLevel = !(err && err.status);
      if(opts.signal && opts.signal.aborted || err && err.code === 'cancelled') throw err;
      if(!networkLevel) throw err;
      try{
        const found = await fetchTaskByClient(spec.clientTaskId, { proxyToken:opts.proxyToken, signal:opts.signal });
        if(found && found.jobId) return found;
      }catch(checkErr){ if(opts.signal && opts.signal.aborted) throw checkErr; }
      if(attempt >= AUTO_RETRY_ON_NETWORK - 1) break;
      try {
        if(task) task.restoreNote = '提交连接被中断，正在自动重试（' + (attempt + 2) + '/' + AUTO_RETRY_ON_NETWORK + '）…';
      } catch(e) {}
      await new Promise(resolve=> setTimeout(resolve, 600 + attempt * 1200));
    }
  }
  await reportSubmitFailure(task, lastError, AUTO_RETRY_ON_NETWORK);
  try {
    const diag = await buildSubmitDiagnostics(task, lastError, AUTO_RETRY_ON_NETWORK);
    const base = (lastError && lastError.message) || '提交未成功';
    lastError = new ServerTaskError(
      base + '\n' + diag,
      (lastError && lastError.status) || 0,
      (lastError && lastError.code) || 'task_submit_failed'
    );
  } catch(e) {}
  throw lastError;
}

export async function getTaskStatus(jobId, options) {
  if(!jobId) {
    throw new ServerTaskError('缺少 job_id', 400, 'task_missing_job_id');
  }

  const opts = options || {};
  return requestJson(
    apiTaskPath(jobId),
    {
      method: 'GET',
      proxyToken: opts.proxyToken,
      signal: opts.signal
    },
    Number(opts.timeoutMs) || TASK_REQUEST_TIMEOUTS.status
  );
}

export function getTaskResultUrl(jobId, index) {
  return apiTaskPath(jobId, '/result/' + encodeURIComponent(String(index)));
}

export async function fetchTaskResult(jobId, index, options) {
  const opts = options || {};
  return requestBlob(
    getTaskResultUrl(jobId, index),
    {
      method: 'GET',
      proxyToken: opts.proxyToken,
      signal: opts.signal
    },
    Number(opts.timeoutMs) || TASK_REQUEST_TIMEOUTS.result
  );
}

export async function fetchTaskResults(status, options) {
  const jobId = String(status && (status.jobId || status.job_id) || '');
  if(!jobId) return [];
  const metas = Array.isArray(status.results) ? status.results : [];
  const settled = await Promise.allSettled(metas.map(async (meta, offset)=>{
    const index = meta && meta.index != null ? Number(meta.index) : offset;
    let last;
    for(let attempt=0; attempt<2; attempt++){
      try{
        const blob = await fetchTaskResult(jobId, index, options);
        return { index, blob, mime:blob.type, size:blob.size, url:getTaskResultUrl(jobId,index) };
      }catch(err){
        last = err;
        if(err && [401,403,410].includes(Number(err.status)) || options && options.signal && options.signal.aborted) throw err;
      }
    }
    throw last;
  }));
  const items = settled.filter(r=>r.status==='fulfilled').map(r=>r.value).sort((a,b)=>a.index-b.index);
  const errors = settled.filter(r=>r.status==='rejected');
  if(!items.length && errors.length) throw errors[0].reason;
  if(errors.length) status.resultWarning = '部分图片未加载，点「补取返图」重取原结果';
  return items;
}

export async function cancelServerTask(jobId, options) {
  if(!jobId) {
    throw new ServerTaskError('缺少 job_id', 400, 'task_missing_job_id');
  }

  const opts = options || {};
  return requestJson(
    apiTaskPath(jobId, '/cancel'),
    {
      method: 'POST',
      proxyToken: opts.proxyToken,
      signal: opts.signal
    },
    Number(opts.timeoutMs) || TASK_REQUEST_TIMEOUTS.cancel
  );
}

export async function resumeServerTask(jobId, options) {
  if(!jobId) {
    throw new ServerTaskError('缺少 job_id', 400, 'task_missing_job_id');
  }

  const opts = options || {};
  const override = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
  const query = override ? ('?baseUrl=' + encodeURIComponent(override)) : '';
  return requestJson(
    apiTaskPath(jobId, '/resume') + query,
    {
      method: 'POST',
      apiKey: opts.apiKey,
      proxyToken: opts.proxyToken,
      signal: opts.signal
    },
    Number(opts.timeoutMs) || TASK_REQUEST_TIMEOUTS.submit
  );
}

export async function forgetServerTask(jobId, options) {
  if(!jobId) {
    throw new ServerTaskError('缺少 job_id', 400, 'task_missing_job_id');
  }

  const opts = options || {};
  return requestJson(
    apiTaskPath(jobId, '/forget'),
    {
      method: 'POST',
      proxyToken: opts.proxyToken,
      signal: opts.signal
    },
    Number(opts.timeoutMs) || TASK_REQUEST_TIMEOUTS.status
  );
}

export async function fetchTaskByClient(clientTaskId, options) {
  const id = String(clientTaskId || '').trim();
  if(!CLIENT_TASK_ID_RE.test(id)) {
    throw new ServerTaskError('缺少有效的 clientTaskId', 400, 'task_missing_client_id');
  }

  const opts = options || {};
  return requestJson(
    '/api/tasks/by-client/' + encodeURIComponent(id),
    {
      method: 'GET',
      proxyToken: opts.proxyToken,
      signal: opts.signal
    },
    Number(opts.timeoutMs) || TASK_REQUEST_TIMEOUTS.status
  );
}

export function stopTaskWatch(jobId) {
  const key = String(jobId || '');
  const watcher = watches.get(key);
  if(watcher) watcher.stop();
}

export function watchServerTask(jobId, callbacks, options) {
  if(!jobId) {
    throw new ServerTaskError('缺少 job_id', 400, 'task_missing_job_id');
  }

  const key = String(jobId);
  const cb = callbacks || {};
  const opts = options || {};
  const interval = Math.max(
    1000,
    Number(opts.intervalMs) || TASK_REQUEST_TIMEOUTS.pollInterval
  );

  stopTaskWatch(key);

  let stopped = false;
  let inFlight = false;
  let timer = null;
  let requestController = null;
  let consecutiveErrors = 0;
  let externalAbortHandler = null;

  const handle = {
    jobId: key,
    stop(){
      if(stopped) return;
      stopped = true;
      if(timer) clearTimeout(timer);
      timer = null;
      if(requestController) requestController.abort();
      requestController = null;
      if(opts.signal && externalAbortHandler) {
        opts.signal.removeEventListener('abort', externalAbortHandler);
      }
      if(watches.get(key) === handle) watches.delete(key);
    }
  };

  const schedule = ()=>{
    if(!stopped) timer = setTimeout(tick, interval);
  };

  const tick = async ()=>{
    if(stopped || inFlight) return;

    inFlight = true;
    requestController = new AbortController();

    try{
      const status = await getTaskStatus(key, {
        proxyToken: opts.proxyToken,
        signal: requestController.signal,
        timeoutMs: opts.timeoutMs
      });

      consecutiveErrors = 0;
      if(stopped) return;

      if(typeof cb.onStatus === 'function') await cb.onStatus(status);

      if(isTerminalTaskState(status.state)) {
        if(status.state === TASK_STATES.done) {
          if(typeof cb.onDone === 'function') await cb.onDone(status);
        }else if(typeof cb.onTerminal === 'function') {
          await cb.onTerminal(status);
        }
        handle.stop();
        return;
      }
    }catch(err) {
      if(!stopped && !(err && err.code === 'cancelled')) {
        consecutiveErrors++;
        if(typeof cb.onError === 'function') {
          await cb.onError(err, consecutiveErrors);
        }
      }
    }finally{
      inFlight = false;
      requestController = null;
      if(!stopped) {
        const backoff = consecutiveErrors
          ? Math.min(interval * Math.pow(2, Math.min(consecutiveErrors, 4)), 30000)
          : interval;
        timer = setTimeout(tick, backoff);
      }
    }
  };

  if(opts.signal) {
    externalAbortHandler = ()=> handle.stop();
    if(opts.signal.aborted) {
      handle.stop();
      return handle;
    }
    opts.signal.addEventListener('abort', externalAbortHandler, { once:true });
  }

  watches.set(key, handle);
  tick();
  return handle;
}