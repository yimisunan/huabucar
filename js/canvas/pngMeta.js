import { REFERENCE_ROLES, REL_LABELS } from './state.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }

export function taskDetailText(task){
  const stateMap = { pending:'排队中', running:'生成中', submitting:'提交后台', queued:'后端排队中', done:'完成', error:'失败', timeout:'超时', cancelled:'已取消', interrupted:'服务器重启后需重试', expired:'结果已过期', archived:'存档' };
  const isVideo = task.mediaType === 'video';
  const modeLabel = isVideo ? (task.mode === 'img2video' ? '图片生视频' : '文生视频') : (task.mode==='img2img' ? '图生图' : '文生图');
  const lines = [
    '任务 #' + task.id,
    '状态：' + (stateMap[task.serverState] || stateMap[task.state] || task.state),
    '模式：' + modeLabel,
    '模型：' + (task.model || task.videoModel || ''),
    '本地任务：' + (task.jobId || '未创建'),
    '上游任务：' + (task.serverTaskId || '未回传'),
    isVideo ? ('时长：' + (task.videoSeconds || '6') + ' 秒') : ('请求尺寸：' + (task.size || '未指定') + (task.resolution ? ' · 原生分辨率：' + task.resolution : '')),
    isVideo ? ('比例：' + (task.videoAspectRatio || '16:9') + ' · 分辨率：' + (task.videoResolution || '720P')) : ('数量：' + task.n + (task.serverImageCount ? ' · 服务端结果：' + task.serverImageCount + '张' : '') + (task.batchOf ? '（第 ' + task.batchIdx + '/' + task.batchOf + '张）' : '')),
    '来源：' + (task.parentId && state && state.taskEls[task.parentId] ? '#' + task.parentId + '（' + (REL_LABELS[task.relation] || task.relation) + '）' : '无（独立创作）'),
    '预设：' + task.preset,
    ...(isVideo ? [] : ['规划复杂度：' + (task.complexity || '未指定')]),
    ...(isVideo ? [] : ['服务端最终：' + (task.serverSize || task.serverResolution || '未回传尺寸') + (task.serverImageSizeTier ? ' · ' + task.serverImageSizeTier : '') + (task.serverQuality ? ' · 质量 ' + task.serverQuality : '') + (task.serverCostUsd !== '' && task.serverCostUsd != null ? ' · 费用 $' + task.serverCostUsd : '')]),
    '参考图：' + (task.files && task.files.length ? task.files.map(f=> REFERENCE_ROLES[f.role] || f.role).join('、') : '无'),
    '',
    '提示词：',
    task.prompt || '（无）',
    '',
    '负面提示词：',
    task.negative || '（无）'
  ];
  return lines.join('\n');
}

export function openDetail(task){
  state.detailTask = task;
  el.detailText.textContent = taskDetailText(task);
  el.detailModal.classList.add('open');
}

export function closeDetail(){
  el.detailModal.classList.remove('open');
  state.detailTask = null;
}

const CRC_TABLE = (()=>{
  const t = new Uint32Array(256);
  for(let n=0;n<256;n++){
    let c = n;
    for(let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf){
  let c = 0xFFFFFFFF;
  for(let i=0;i<buf.length;i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function b64encodeUtf8(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for(const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function pngInsertText(pngBytes, keyword, text){
  const sig = [137,80,78,71,13,10,26,10];
  for(let i=0;i<8;i++) if(pngBytes[i]!==sig[i]) return null;
  const keyBuf = new TextEncoder().encode(keyword + '\0' + text);
  const chunk = new Uint8Array(12 + keyBuf.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, keyBuf.length);
  chunk.set([0x74,0x45,0x58,0x74], 4);
  chunk.set(keyBuf, 8);
  dv.setUint32(8 + keyBuf.length, crc32(chunk.subarray(4, 8 + keyBuf.length)));
  const out = new Uint8Array(pngBytes.length + chunk.length);
  out.set(pngBytes.subarray(0, 33), 0);
  out.set(chunk, 33);
  out.set(pngBytes.subarray(33), 33 + chunk.length);
  return out;
}

export function taskMeta(task){
  return { complexity:task.complexity||'', p:task.prompt||'', n:task.negative||'', m:task.model||task.videoModel||'', s:task.size||'', d:task.mode||'', t:new Date().toLocaleString() };
}

