import { ICO } from './icons.js';
import { CARD_W, CARD_GAP, PAD, CARD_H_EST, REL_COLORS, REL_LABELS, LS_HIST, OV_STATE } from './state.js';
import { toast, escapeHtml, clamp, getRequestUrl, fetchWithTimeout, mimeToExt, lsGet, lsSet } from './util.js';
import { getTaskResult, getTaskResultIndex, setTaskResultIndex } from './paint.js';
import { addRefFromBlob } from './refs.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }
const callHook = (name, ...args) => state && state.hooks && state.hooks[name] ? state.hooks[name](...args) : undefined;
function scheduleAutosave(){ return callHook('scheduleAutosave'); }
function downloadBlob(blob, name, meta){ return callHook('downloadBlob', blob, name, meta); }
function taskMeta(task){ return callHook('taskMeta', task); }
function idbGet(key){ return callHook('idbGet', key); }
function thumbViaServer(b64, maxSide){ return callHook('thumbViaServer', b64, maxSide); }
function renderLib(){ return callHook('renderLib'); }
function openDetail(task){ return callHook('openDetail', task); }
function copyPrompt(task){ return callHook('copyPrompt', task); }
function openPaint(task){ return callHook('openPaint', task); }
function openOptimizeWithImage(task){ return callHook('openOptimizeWithImage', task); }
function reuseTask(task){ return callHook('reuseTask', task); }
function removeBatchGroup(task){ return callHook('removeBatchGroup', task); }
function removeCard(task){ return callHook('removeCard', task); }
function retryTask(task){ return callHook('retryTask', task); }
function closeTask(task){ return callHook('closeTask', task); }
function cloneTask(task, n){ return callHook('cloneTask', task, n); }
function downloadArchivedVideo(task){ return callHook('downloadArchivedVideo', task); }

export function addLink(fromId, toId, rel){
  const color = REL_COLORS[rel] || '#8a93a6';
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'link-path');
  path.setAttribute('stroke', color);
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('class', 'link-arrow');
  arrow.setAttribute('fill', color);
  const tag = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  tag.setAttribute('class', 'link-tag');
  tag.textContent = REL_LABELS[rel] || rel;
  g.append(path, arrow, tag);
  state.linkLayer.appendChild(g);
  state.links.push({ from: fromId, to: toId, rel, path, arrow, tag, g });
  updateLinks();
}

export function cardAnchor(t){
  return {
    x: parseFloat(t.card.style.left) + CARD_W / 2,
    y: parseFloat(t.card.style.top) + (t.card.offsetHeight || 150) / 2
  };
}

export function updateLinks(){
  // 倒序遍历：避免 forEach+splice 索引错位导致相邻失效连线被跳过、SVG 幽灵箭头残留
  for(let i = state.links.length - 1; i >= 0; i--){
    const l = state.links[i];
    const a = state.taskEls[l.from], b = state.taskEls[l.to];
    if(!a || !b || !a.card || !b.card){ l.g.remove(); state.links.splice(i, 1); continue; }
    const p1 = cardAnchor(a), p2 = cardAnchor(b);
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const off = CARD_W / 2 + 2;
    const sx = p1.x + ux * off, sy = p1.y + uy * off;
    const ex = p2.x - ux * off, ey = p2.y - uy * off;
    const mx = (sx + ex) / 2, my = (sy + ey) / 2 - 24;
    l.path.setAttribute('d', 'M' + sx.toFixed(1) + ',' + sy.toFixed(1) + ' Q' + mx.toFixed(1) + ',' + my.toFixed(1) + ' ' + ex.toFixed(1) + ',' + ey.toFixed(1));
    const ang = Math.atan2(ey - my, ex - mx);
    const bx = ex - Math.cos(ang) * 11, by = ey - Math.sin(ang) * 11;
    const ax = bx - Math.cos(ang - 0.5) * 6, ay = by - Math.sin(ang - 0.5) * 6;
    const cx2 = bx - Math.cos(ang + 0.5) * 6, cy2 = by - Math.sin(ang + 0.5) * 6;
    l.arrow.setAttribute('d', 'M' + ex.toFixed(1) + ',' + ey.toFixed(1) + ' L' + ax.toFixed(1) + ',' + ay.toFixed(1) + ' L' + cx2.toFixed(1) + ',' + cy2.toFixed(1) + ' Z');
    l.tag.setAttribute('x', mx.toFixed(1));
    l.tag.setAttribute('y', (my - 6).toFixed(1));
    l.tag.setAttribute('text-anchor', 'middle');
  }
}

export function removeLinksOf(id){
  state.links = state.links.filter(l=>{
    if(l.from === id || l.to === id){ l.g.remove(); return false; }
    return true;
  });
}

export function applyView(){
  el.world.style.transform = 'translate(' + state.view.x + 'px,' + state.view.y + 'px) scale(' + state.view.z + ')';
  el.zoomVal.textContent = Math.round(state.view.z * 100) + '%';
  if(!state.skipAutosave) scheduleAutosave();
}

export function zoomAnimate(to, cx, cy){
  const from = state.view.z, fromX = state.view.x, fromY = state.view.y;
  const dur = 240, t0 = performance.now();
  if(state.zoomAnim) cancelAnimationFrame(state.zoomAnim);
  const step = now=>{
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    const nz = from + (to - from) * e;
    state.view.x = cx - (cx - fromX) * (nz / from);
    state.view.y = cy - (cy - fromY) * (nz / from);
    state.view.z = nz;
    applyView();
    if(k < 1) state.zoomAnim = requestAnimationFrame(step);
    else state.zoomAnim = null;
  };
  state.zoomAnim = requestAnimationFrame(step);
}

export function zoomBy(factor){
  const cx = el.canvas.clientWidth / 2, cy = el.canvas.clientHeight / 2;
  zoomAnimate(clamp(state.view.z * factor, 0.3, 2.5), cx, cy);
}

export function goLatest(){
  const entries = Object.keys(state.taskEls).map(id=> state.taskEls[id]).filter(t=> t && t.card);
  if(!entries.length){ state.view.x = 24; state.view.y = 24; state.view.z = 1; applyView(); return; }
  const latest = entries.reduce((a,b)=> a.task.id > b.task.id ? a : b);
  ensureVisible(parseFloat(latest.card.style.left) || 0, parseFloat(latest.card.style.top) || 0, true);
}

/* 定位「进行中」：优先最早开始的生成中卡片，其次队列最前的排队卡片；没有则返回 false */
export function goActive(){
  const entries = Object.keys(state.taskEls).map(id=> state.taskEls[id]).filter(t=> t && t.card && t.task);
  const running = entries.filter(t=> t.task.state === 'running').sort((a,b)=> (a.task.startTs || 0) - (b.task.startTs || 0));
  const pending = entries.filter(t=> t.task.state === 'pending').sort((a,b)=> a.task.id - b.task.id);
  const target = running[0] || pending[0];
  if(!target) return false;
  ensureVisible(parseFloat(target.card.style.left) || 0, parseFloat(target.card.style.top) || 0, true);
  return true;
}

export function activeStats(){
  const all = Object.keys(state.taskEls).map(id=> state.taskEls[id]).filter(t=> t && t.task);
  const running = all.filter(t=> t.task.state === 'running').length;
  const pending = all.filter(t=> t.task.state === 'pending').length;
  return { running, pending, total: running + pending };
}

/* 排队位置：按卡片 id 升序（先入队者在前） */
export function queueInfo(task){
  const pend = Object.keys(state.taskEls).map(id=> state.taskEls[id])
    .filter(t=> t && t.task && t.task.state === 'pending')
    .sort((a,b)=> a.task.id - b.task.id);
  const i = pend.findIndex(t=> t.task.id === task.id);
  return { pos: i >= 0 ? i + 1 : 0, total: pend.length };
}

/* 卡片阶段文案：上传 / 排队 / 生成 三段互斥，避免「正在生成」掩盖上传耗时 */
export function stageText(task){
  if(!task) return '';
  const st = task.serverState || '';
  if(task.state === 'pending'){
    if(st === 'submitting'){
      const files = task.files || [];
      const bytes = files.reduce((a,f)=> a + (f && f.file && f.file.size ? f.file.size : 0), 0);
      const mb = bytes / 1048576;
      const parts = [];
      if(files.length) parts.push('参考图 ' + files.length + '张');
      if(mb >= 0.1) parts.push(mb >= 10 ? Math.round(mb) + 'MB' : mb.toFixed(1) + 'MB');
      return '正在上传' + (parts.length ? '（' + parts.join(' · ') + '）' : '提示词') + '…';
    }
    const q = queueInfo(task);
    if(st === 'queued') return q.total > 1 ? ('已上传 · 后端排队 第 ' + q.pos + ' / ' + q.total + ' 位') : '已上传 · 后端排队中…';
    if(q.total > 1) return '排队中 第 ' + q.pos + ' / ' + q.total + ' 位';
    return '排队中…';
  }
  if(task.state === 'running'){
    if(st === 'done') return '已上传 · 正在取回结果…';
    return '已上传 · 生成中…';
  }
  return '';
}

export function rebuildColumns(){
  // 根据现有卡片位置重建列高索引（导入画布后调用，避免新卡片与旧卡片重叠）
  const cols = colCount();
  const colH2 = new Array(cols).fill(0);
  Object.keys(state.taskEls).forEach(id=>{
    const t = state.taskEls[id];
    if(!t || !t.card) return;
    const c = slotOf(t.card);
    const media = t.card.querySelector('.c-img, .c-video');
    const h = media && media.clientHeight ? media.clientHeight + 66 : CARD_H_EST;
    const y = parseFloat(t.card.style.top) || 0;
    if(colH2[c.col] < y + h) colH2[c.col] = y + h;
  });
  state.colH.length = 0; state.colH.push(...colH2);
}

export function colCount(){
  const w = el.canvas.clientWidth;
  return Math.max(1, Math.floor((w - PAD*2 + CARD_GAP) / (CARD_W + CARD_GAP)));
}

export function nextSlot(){
  const cols = colCount();
  while(state.colH.length < cols) state.colH.push(0);
  let ci = 0;
  for(let i=1;i<cols;i++) if(state.colH[i] < state.colH[ci]) ci = i;
  return { x: PAD + ci*(CARD_W+CARD_GAP), y: PAD + state.colH[ci], col: ci };
}

export function updateCol(col, y, h){
  const hh = h || CARD_H_EST;
  if(state.colH[col] < y + hh) state.colH[col] = y + hh;
}

export function reflowAfterResize(card){
  // 图片异步加载后高度变化：更新列高、下移同列后续卡片、刷新血缘连线
  const c = slotOf(card);
  const media = card.querySelector('.c-img, .c-video');
  const newH = media && media.clientHeight ? media.clientHeight + 66 : CARD_H_EST;
  const top = parseFloat(card.style.top) || 0;
  const delta = Math.max(0, newH - CARD_H_EST);
  if(delta > 0){
    Object.keys(state.taskEls).forEach(id=>{
      const t = state.taskEls[id];
      if(!t || !t.card || t.card === card) return;
      if(slotOf(t.card).col === c.col && (parseFloat(t.card.style.top) || 0) > top){
        t.card.style.top = ((parseFloat(t.card.style.top) || 0) + delta) + 'px';
      }
    });
  }
  updateCol(c.col, top, newH);
  updateLinks();
}

export function ensureVisible(x, y, force){
  const cw = el.canvas.clientWidth, ch = el.canvas.clientHeight;
  const sx = x*state.view.z + state.view.x, sy = y*state.view.z + state.view.y;
  const cx = sx + CARD_W*state.view.z/2, cy = sy + 60*state.view.z;
  if(force || cx < 0 || cx > cw || cy < 0 || cy > ch){
    state.view.x = cw/2 - (x + CARD_W/2)*state.view.z;
    state.view.y = ch/2 - (y + 30)*state.view.z;
    applyView();
  }
}

export function createCard(task, slot){
  const card = document.createElement('div');
  card.className = 'c-card pop';
  card.dataset.tid = task.id;
  card.style.left = slot.x + 'px';
  card.style.top = slot.y + 'px';
  card.style.width = CARD_W + 'px';
  if(task.batchOf){
    // 同批次卡片顶部同色条，便于识别「生成几张」的一组
    const batchId = task.id - task.batchIdx + 1;
    const batchColors = ['#7c5cff','#ff7c5c','#5cc8ff','#5cff8a','#ff5cc8','#ffd25c'];
    card.style.borderTop = '3px solid ' + batchColors[batchId % batchColors.length];
  }
  const badge = document.createElement('div');
  badge.className = 'c-badge';
  badge.textContent = '#' + task.id;
  card.appendChild(badge);
  const body = document.createElement('div');
  body.className = 'c-body';
  card.appendChild(body);
  el.world.appendChild(card);
  bindCardGestures(card);
  return card;
}

export function renderCardState(task){
  const t = state.taskEls[task.id];
  if(!t) return;
  const body = t.card.querySelector('.c-body');
  const isVideo = task.mediaType === 'video';
  if(task.state === 'done' && t.resultItems.length){
    const ri = getTaskResult(t);
    if(!ri) return;
    body.innerHTML = '';
    const media = isVideo ? document.createElement('video') : document.createElement('img');
    media.className = isVideo ? 'c-video' : 'c-img';
    media.src = ri.url || '';
    media.draggable = false;
    if(isVideo){ media.controls = true; media.playsInline = true; media.preload = 'metadata'; }
    body.appendChild(media);
    const meta = document.createElement('div');
    meta.className = 'c-meta';
    const extraCount = t.resultItems.length > 1 ? ' · ' + (getTaskResultIndex(t) + 1) + '/' + t.resultItems.length + (isVideo ? ' 个视频' : '张') : '';
    const elapsed = (task.startTs && task.endTs) ? ' · ' + ((task.endTs - task.startTs) / 1000).toFixed(1) + 's' : '';
    const model = task.model || task.videoModel || '';
    const finalSize = task.serverSize || task.serverResolution || task.size || '';
     const finalTier = task.serverImageSizeTier ? ' · ' + task.serverImageSizeTier : '';
     const finalQuality = task.serverQuality ? ' · ' + task.serverQuality : '';
     const cost = task.serverCostUsd !== '' && task.serverCostUsd != null ? ' · $' + task.serverCostUsd : '';
     const detail = isVideo ? ((task.videoSeconds || '6') + '秒 · ' + (task.videoAspectRatio || '16:9') + ' · ' + (task.videoResolution || '720P')) : (finalSize + finalTier + finalQuality + cost + extraCount);
    meta.innerHTML = '<b>#' + task.id + ' ' + escapeHtml(model) + '</b><span>' + escapeHtml(detail) + extraCount + elapsed + '</span>';
    body.appendChild(meta);
    if(t.resultItems.length > 1){
      const nav = document.createElement('div');
      nav.className = 'c-result-nav';
      const prev = document.createElement('button');
      prev.className = 'c-result-btn'; prev.textContent = '‹'; prev.title = '上一项'; prev.disabled = getTaskResultIndex(t) === 0;
      prev.onclick = e=>{ e.stopPropagation(); setTaskResultIndex(t, getTaskResultIndex(t) - 1); };
      const next = document.createElement('button');
      next.className = 'c-result-btn'; next.textContent = '›'; next.title = '下一项'; next.disabled = getTaskResultIndex(t) === t.resultItems.length - 1;
      next.onclick = e=>{ e.stopPropagation(); setTaskResultIndex(t, getTaskResultIndex(t) + 1); };
      const label = document.createElement('span');
      label.textContent = (getTaskResultIndex(t) + 1) + ' / ' + t.resultItems.length;
      nav.append(prev, label, next);
      body.appendChild(nav);
    }
    const acts = document.createElement('div');
    acts.className = 'c-acts';
    const mkAct = (icon, title, fn)=>{ const b = document.createElement('button'); b.className = 'c-act'; b.innerHTML = icon; b.title = title; b.onclick = fn; acts.appendChild(b); };
    if(task.resultWarning){
      const warning = document.createElement('div'); warning.className='q'; warning.textContent=task.resultWarning; body.appendChild(warning);
      mkAct(ICO.retry + '补取返图', '补取原任务缺失图片', ()=>retryTask(task));
    }
    mkAct(ICO.copy + '复制', '复制提示词', ()=> copyPrompt(task));
    if(!isVideo){
      mkAct(ICO.brush + '涂抹', '涂抹重绘', ()=> openPaint(task));
      mkAct(ICO.wand + '优化', '看图优化', ()=> openOptimizeWithImage(task));
    }
    mkAct(ICO.dl + '下载', isVideo ? '下载视频' : '下载原图', ()=>{ state.previewTask = t; el.pvDl.click(); state.previewTask = null; });
    body.appendChild(acts);
    media.onloadedmetadata = ()=> reflowAfterResize(t.card);
    media.onload = ()=> reflowAfterResize(t.card);
    scheduleAutosave();
    return;
  }
  if(task.state === 'archived'){
    body.innerHTML = '';
    if(isVideo && task.videoUrl){
      const media = document.createElement('video');
      media.className = 'c-video';
      media.controls = true; media.playsInline = true; media.preload = 'metadata';
      media.src = getRequestUrl(task.videoUrl);
      media.onerror = ()=>{ task.restoreNote = '视频结果已过期'; renderCardState(task); };
      body.appendChild(media);
    }else if(task.thumb){
      const img = document.createElement('img');
      img.className = 'c-img'; img.src = task.thumb; body.appendChild(img);
    }
    const meta = document.createElement('div');
    meta.className = 'c-meta';
    const archivedDetail = isVideo ? ((task.videoSeconds || '6') + '秒 · ' + (task.videoAspectRatio || '16:9') + ' · ' + (task.videoResolution || '720P')) : (task.restoreNote || task.size || '');
    meta.innerHTML = '<b>' + ICO.cube + ' ' + escapeHtml(task.model || task.videoModel || '') + '</b><span>' + escapeHtml(task.restoreNote || archivedDetail) + '</span>';
    body.appendChild(meta);
    scheduleAutosave();
    return;
  }
  body.innerHTML = '';
  const st = document.createElement('div');
  const isError = task.state==='error' || task.state==='timeout' || task.state==='cancelled';
  st.className = 'c-state' + (isError ? ' err' : '');
  const serverState = task.serverState || '';
  const stateLabel = OV_STATE[serverState] || OV_STATE[task.state] || task.state;
  const model = task.model || task.videoModel || '';
  const requestedSize = task.size || '';
   const requestedResolution = task.resolution ? ' · ' + task.resolution : '';
   const detail = isVideo ? ((task.videoSeconds || '6') + '秒 · ' + (task.videoAspectRatio || '16:9') + ' · ' + (task.videoResolution || '720P')) : (requestedSize + requestedResolution + (task.n > 1 ? ' · ' + task.n + '张' : ''));
  if(task.state === 'pending'){
    st.innerHTML = '<div class="spin"></div><div class="q stage">' + escapeHtml(stageText(task)) + '</div><div class="q">' + escapeHtml(model) + ' · ' + escapeHtml(detail) + '</div><div class="q elapsed">已等待 0s</div>';
    if(!isVideo){
      const stopQueued = document.createElement('button');
      stopQueued.className = 'retry'; stopQueued.innerHTML = ICO.stop + '终止';
      stopQueued.onclick = ()=> closeTask(task); st.appendChild(stopQueued);
    }
  }else if(task.state === 'running'){
    st.innerHTML = '<div class="spin"></div><div class="q stage">' + escapeHtml(stageText(task)) + '</div><div class="q">' + escapeHtml(model) + ' · ' + escapeHtml(detail) + '</div><div class="q elapsed">已用时 0s</div>';
    if(!isVideo){
      const stopRunning = document.createElement('button');
      stopRunning.className = 'retry'; stopRunning.innerHTML = ICO.stop + '终止';
      stopRunning.onclick = ()=> closeTask(task); st.appendChild(stopRunning);
    }
  }else if(task.state === 'error' || task.state === 'timeout'){
    const title = serverState === 'interrupted' ? '服务器重启后任务中断' : (serverState === 'expired' ? '任务结果已过期' : (task.state==='timeout' ? '超时' : '生成失败'));
    const code = task.serverErrorCode ? ' [' + task.serverErrorCode + ']' : '';
     st.innerHTML = '<div>❌ ' + title + '</div><div class="q" style="max-width:200px;word-break:break-all;">' + escapeHtml(code + ' ' + (task.errorMsg || task.serverError || '')) + '</div>';
    if(!isVideo && task.serverTaskId){
      const upRow = document.createElement('div');
      upRow.className = 'q';
      upRow.style.maxWidth = '200px'; upRow.style.wordBreak = 'break-all';
      upRow.textContent = '上游任务ID: ' + task.serverTaskId;
      st.appendChild(upRow);
    }
    const retry = document.createElement('button');
    retry.className = 'retry';
    retry.innerHTML = isVideo ? (ICO.retry + '重试') : (task.recoverPending ? '恢复中…' : (ICO.retry + '恢复'));
    retry.disabled = !isVideo && !!task.recoverPending;
    retry.onclick = ()=> retryTask(task); st.appendChild(retry);
  }else if(task.state === 'cancelled'){
    st.innerHTML = '<div>已取消</div><div class="q">' + escapeHtml(task.serverError || task.errorMsg || '') + '</div>';
    const retry2 = document.createElement('button');
    retry2.className = 'retry';
    retry2.innerHTML = isVideo ? (ICO.retry + '重试') : (task.recoverPending ? '恢复中…' : (ICO.retry + '恢复'));
    retry2.disabled = !isVideo && !!task.recoverPending;
    retry2.onclick = ()=> retryTask(task); st.appendChild(retry2);
  }
  body.appendChild(st);
  const meta = document.createElement('div');
  meta.className = 'c-meta';
  const el2 = (task.startTs && task.endTs) ? ' · ' + ((task.endTs - task.startTs) / 1000).toFixed(1) + 's' : '';
  const serverTag = serverState ? ' · ' + escapeHtml(stateLabel) : '';
  meta.innerHTML = '<b>任务 #' + task.id + '</b><span>' + escapeHtml(detail) + serverTag + el2 + '</span>';
  body.appendChild(meta);
  scheduleAutosave();
}

export function slotOf(card){
  const cols = colCount();
  const x = parseFloat(card.style.left);
  return { col: Math.min(cols-1, Math.max(0, Math.round((x - PAD) / (CARD_W + CARD_GAP)))), x, y: parseFloat(card.style.top) };
}

export function bindCardGestures(card){
  card.addEventListener('pointerdown', e=>{
    if(e.target.closest('select') || e.target.closest('button')) return;
    state.pointers.set(e.pointerId, { x:e.clientX, y:e.clientY, card:true });
    try{ card.setPointerCapture(e.pointerId); }catch(err){}
    if(state.pointers.size === 1){
      state.dragCard = card; state.moved = false;
      const rect = card.getBoundingClientRect();
      state.dragOffX = e.clientX - rect.left; state.dragOffY = e.clientY - rect.top;
      state.pressCard = card; state.pressX = e.clientX; state.pressY = e.clientY;
      clearTimeout(state.pressTimer);
      state.pressTimer = setTimeout(()=>{
        if(!state.moved && state.pressCard) openCtx(state.pressCard, state.pressX, state.pressY);
      }, 520);
    }else if(state.pointers.size === 2){
      clearTimeout(state.pressTimer);
      state.moved = true;
      const pts = Array.from(state.pointers.values());
      state.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      state.pinchStart = { x:(pts[0].x+pts[1].x)/2, y:(pts[0].y+pts[1].y)/2, z:state.view.z };
      state.dragCard = null;
    }
    e.preventDefault();
  });
  card.addEventListener('pointermove', e=>{
    if(!state.pointers.has(e.pointerId)) return;
    state.pointers.set(e.pointerId, { x:e.clientX, y:e.clientY, card:true });
    if(state.pointers.size === 2){
      const pts = Array.from(state.pointers.values());
      const d = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
      if(state.pinchDist > 0 && state.pinchStart){
        // 平方根衰减：手指张开2倍距离只缩放约1.4倍，缩放更平缓可控
        const k = Math.pow(d / state.pinchDist, 0.5);
        state.view.z = clamp(state.pinchStart.z * k, 0.3, 2.5);
        const cx = (pts[0].x+pts[1].x)/2, cy = (pts[0].y+pts[1].y)/2;
        state.view.x = cx - (cx - state.view.x) * (state.view.z / state.pinchStart.z);
        state.view.y = cy - (cy - state.view.y) * (state.view.z / state.pinchStart.z);
        applyView();
      }
      return;
    }
    if(state.dragCard && state.pointers.size === 1){
      // 位移必须与按下时坐标比较（旧代码与刚写入的当前坐标比较，恒为 0 导致拖不动）
      const dx = e.clientX - state.pressX, dy = e.clientY - state.pressY;
      if(Math.abs(dx) + Math.abs(dy) > 4){
        state.moved = true;
        clearTimeout(state.pressTimer);
        state.dragCard.style.left = (e.clientX - state.dragOffX - state.view.x) / state.view.z + 'px';
        state.dragCard.style.top = (e.clientY - state.dragOffY - state.view.y) / state.view.z + 'px';
        state.dragCard.classList.add('dragging');
        updateLinks();
      }
    }
  });
  const endPointer = e=>{
    state.pointers.delete(e.pointerId);
    if(state.pointers.size === 0){
      if(state.dragCard){
        state.dragCard.classList.remove('dragging');
        const c = slotOf(state.dragCard);
        updateCol(c.col, c.y);
        state.dragCard = null;
        scheduleAutosave(); // 拖拽落点持久化
      }
      if(!state.moved && state.pressCard){
        clearTimeout(state.pressTimer);
        openCard(state.pressCard);
      }
      state.pressCard = null;
      state.pinchDist = 0; state.pinchStart = null;
    }
    if(state.pointers.size === 1){
      const p = Array.from(state.pointers.values())[0];
      state.pinchDist = 0; state.pinchStart = null;
      if(p.card){
        const card = document.elementFromPoint(p.x, p.y)?.closest('.c-card');
        if(card){ state.dragCard = card; const r = card.getBoundingClientRect(); state.dragOffX = p.x - r.left; state.dragOffY = p.y - r.top; state.moved = false; state.pressCard = card; state.pressX = p.x; state.pressY = p.y; }
      }
    }
  };
  card.addEventListener('pointerup', endPointer);
  card.addEventListener('pointercancel', endPointer);
}

export function endCanvasPointer(e){
  state.pointers.delete(e.pointerId);
  if(state.pointers.size === 0){ state.panStart = null; state.pinchDist = 0; state.pinchStart = null; }
}

export function openCard(card){
  const tid = card.dataset.tid;
  const t = state.taskEls[tid];
  if(!t || t.task.state !== 'done' || !t.resultItems.length) return;
  showPreview(t);
}

export function showPreview(t){
  state.previewTask = t;
  state.libDetail = null; state.libDetailBlob = null;
  if(state.libDetailBlobUrl){ URL.revokeObjectURL(state.libDetailBlobUrl); state.libDetailBlobUrl = ''; }
  const ri = getTaskResult(t);
  if(!ri) return;
  const isVideo = t.task.mediaType === 'video';
  if(el.previewImg){
    el.previewImg.style.display = isVideo ? 'none' : '';
    if(!isVideo) el.previewImg.src = ri.url || '';
  }
  if(el.previewVideo){
    el.previewVideo.style.display = isVideo ? '' : 'none';
    if(isVideo){ el.previewVideo.src = ri.url || ''; el.previewVideo.load(); }
    else { el.previewVideo.pause(); el.previewVideo.removeAttribute('src'); el.previewVideo.load(); }
  }
  const model = t.task.model || t.task.videoModel || '';
  const previewSize = t.task.serverSize || t.task.serverResolution || t.task.size || '';
   const previewTier = t.task.serverImageSizeTier ? ' · ' + t.task.serverImageSizeTier : '';
   const previewCost = t.task.serverCostUsd !== '' && t.task.serverCostUsd != null ? ' · $' + t.task.serverCostUsd : '';
   const detail = isVideo ? ((t.task.videoSeconds || '6') + '秒 · ' + (t.task.videoAspectRatio || '16:9') + ' · ' + (t.task.videoResolution || '720P')) : (previewSize + previewTier + previewCost);
  el.previewMeta.textContent = '#' + t.task.id + ' · ' + model + ' · ' + detail + (t.resultItems.length > 1 ? ' · ' + (getTaskResultIndex(t) + 1) + '/' + t.resultItems.length : '');
  if(el.pvRef) el.pvRef.style.display = isVideo ? 'none' : '';
  if(el.pvPaint) el.pvPaint.style.display = isVideo ? 'none' : '';
  (el.pvReuse.querySelector('.lbl')||el.pvReuse).textContent = '复用参数';
  el.preview.classList.add('open');
}

export function closePreview(){
  el.preview.classList.remove('open');
  if(el.previewImg){ el.previewImg.src = ''; el.previewImg.style.display = ''; }
  if(el.previewVideo){ el.previewVideo.pause(); el.previewVideo.removeAttribute('src'); el.previewVideo.load(); el.previewVideo.style.display = 'none'; }
  if(el.pvRef) el.pvRef.style.display = '';
  state.previewTask = null; state.libDetail = null; state.libDetailBlob = null;
  state.libToken++;
  if(state.libDetailBlobUrl){ URL.revokeObjectURL(state.libDetailBlobUrl); state.libDetailBlobUrl = ''; }
  (el.pvReuse.querySelector('.lbl')||el.pvReuse).textContent = '复用参数';
}

export function openLibDetail(h){
  state.libDetail = h;
  state.previewTask = null; state.libDetailBlob = null;
  const token = ++state.libToken;
  const isVideo = h.mediaType === 'video';
  if(state.libDetailBlobUrl){ URL.revokeObjectURL(state.libDetailBlobUrl); state.libDetailBlobUrl = ''; }
  if(el.previewImg){ el.previewImg.style.display = isVideo ? 'none' : ''; if(!isVideo) el.previewImg.src = h.thumb || ''; }
  if(el.previewVideo){ el.previewVideo.pause(); el.previewVideo.removeAttribute('src'); el.previewVideo.load(); el.previewVideo.style.display = 'none'; }
  if(el.pvRef) el.pvRef.style.display = isVideo ? 'none' : '';
  if(el.pvPaint) el.pvPaint.style.display = isVideo ? 'none' : '';
  const detail = isVideo ? ((h.videoSeconds || '6') + '秒 · ' + (h.videoAspectRatio || '16:9') + ' · ' + (h.videoResolution || '720P')) : ((h.serverSize || h.serverResolution || h.size || '') + (h.serverImageSizeTier ? ' · ' + h.serverImageSizeTier : '') + (h.serverCostUsd !== '' && h.serverCostUsd != null ? ' · $' + h.serverCostUsd : ''));
  el.previewMeta.textContent = (h.ts||'') + ' · ' + (h.model||'') + ' · ' + detail;
  (el.pvReuse.querySelector('.lbl')||el.pvReuse).textContent = '回填提示词';
  el.preview.classList.add('open');
  const blobKey = h.origType === 'canvas' ? (h.origKey || '') : h.id;
  if(h.origType === 'idb' || h.origType === 'canvas'){
    idbGet(blobKey).then(blob=>{
      if(!blob || token !== state.libToken) return;
      state.libDetailBlob = blob;
      state.libDetailBlobUrl = URL.createObjectURL(blob);
      if(isVideo){
        el.previewVideo.style.display = '';
        el.previewVideo.src = state.libDetailBlobUrl;
        el.previewVideo.load();
      }else{
        el.previewImg.src = state.libDetailBlobUrl;
      }
      if(!h.thumb && !isVideo){
        const fr = new FileReader();
        fr.onload = async ()=>{
          const thumb = await thumbViaServer(String(fr.result));
          if(thumb && !h.thumb){
            h.thumb = thumb;
            const hist = lsGet(LS_HIST, []);
            const i = hist.findIndex(x=> x.id === h.id);
            if(i > -1){ hist[i] = h; lsSet(LS_HIST, hist); renderLib(); }
          }
        };
        fr.readAsDataURL(blob);
      }
    });
  }else if(h.origUrl){
    if(isVideo){ el.previewVideo.style.display = ''; el.previewVideo.src = getRequestUrl(h.origUrl); el.previewVideo.load(); }
    else el.previewImg.src = h.origUrl;
  }else if(isVideo && h.mediaUrl){
    el.previewVideo.style.display = '';
    el.previewVideo.src = getRequestUrl(h.mediaUrl);
    el.previewVideo.load();
  }
}

export function openCtx(card, x, y){
  const t = state.taskEls[card.dataset.tid];
  if(!t) return;
  clearTimeout(state.pressTimer);
  state.pressCard = null;
  state.ctxCard = card;
  const menu = el.ctx;
  menu.innerHTML = '';
  const mk = (label, danger, fn)=>{
    const b = document.createElement('button');
    b.innerHTML = label;
    if(danger) b.className = 'danger';
    b.onclick = ()=>{ closeCtx(); fn(); };
    menu.appendChild(b);
  };
  const st = t.task.state;
  mk(ICO.info + '参数详情', false, ()=> openDetail(t.task));
  if(st === 'done'){
    const isVideo = t.task.mediaType === 'video';
    mk(isVideo ? (ICO.dl + '下载视频') : (ICO.dl + '下载原图'), false, ()=>{ state.previewTask = t; el.pvDl.click(); state.previewTask = null; });
    if(!isVideo){
      mk(ICO.wand + '看图优化', false, ()=> openOptimizeWithImage(t.task));
      mk(ICO.brush + '涂抹重绘', false, ()=> openPaint(t.task));
    }
    mk(ICO.copy + '复制提示词', false, ()=> copyPrompt(t.task));
    if(t.task.batchOf) mk(ICO.trash + '删除同批', true, ()=> removeBatchGroup(t.task));
    if(!isVideo) mk(ICO.image + '设为参考图', false, ()=>{ showPreview(t); el.pvRef.click(); });
    mk(ICO.sparkle + '一键变体', false, ()=>{ const nt = cloneTask(t.task, 1); if(nt) toast('已创建变体任务 #' + nt.id, 'ok'); });
    mk(ICO.reuse + '复用参数', false, ()=> reuseTask(t.task));
    mk(ICO.trash + '删除卡片', true, ()=> removeCard(t.task));
  }else if(st === 'error' || st === 'timeout'){
    mk(ICO.retry + '重试', false, ()=> retryTask(t.task));
    mk(ICO.reuse + '复用参数', false, ()=> reuseTask(t.task));
    mk(ICO.trash + '删除卡片', true, ()=> removeCard(t.task));
  }else if(st === 'pending' || st === 'running'){
    mk(ICO.stop + '终止', false, ()=> closeTask(t.task));
  }else if(st === 'cancelled'){
    mk(ICO.retry + '重试', false, ()=> retryTask(t.task));
    mk(ICO.trash + '删除卡片', true, ()=> removeCard(t.task));
  }else if(st === 'archived'){
    const isVideo = t.task.mediaType === 'video';
    if(isVideo && (t.task.videoUrl || t.task.jobId)) mk(ICO.dl + '下载视频', false, ()=> downloadArchivedVideo(t.task));
    if(!isVideo) mk(ICO.wand + '看图优化', false, ()=> openOptimizeWithImage(t.task));
    mk(ICO.copy + '复制提示词', false, ()=> copyPrompt(t.task));
    mk(ICO.reuse + '复用参数', false, ()=> reuseTask(t.task));
    if(t.task.batchOf) mk(ICO.trash + '删除同批', true, ()=> removeBatchGroup(t.task));
    mk(ICO.trash + '删除卡片', true, ()=> removeCard(t.task));
  }
  if(!menu.children.length) return;
  const mw = 176, mh = menu.children.length * 42 + 12;
  menu.style.left = clamp(x - 20, 8, window.innerWidth - mw - 8) + 'px';
  menu.style.top = clamp(y - 20, 8, window.innerHeight - mh - 8) + 'px';
  menu.classList.add('open');
}

export function closeCtx(){ el.ctx.classList.remove('open'); state.ctxCard = null; }

/* 远程结果下载：任务卡「下载」/ 素材库「下载原图」在只有 URL、没有本地 blob 时走这里。
   name 由调用方传入且已去掉扩展名，扩展名由响应头的 mime 决定。
   先走本地代理取 blob（可绕开 CORS 并把 PNG 参数写进文件），失败再回落 <a download> 直链。*/
export async function downloadRemote(url, name, meta, btn){
  const src = getRequestUrl(url);
  const baseName = String(name || ('ai_result_' + Date.now())).replace(/\.[^.]+$/, '');
  const oldHtml = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled = true; btn.dataset.busy = '1'; }
  try{
    const res = await fetchWithTimeout(src, { credentials:'omit' }, 120000);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if(!blob || !blob.size) throw new Error('空文件');
    const ext = mimeToExt(blob.type) || 'png';
    downloadBlob(blob, baseName + '.' + ext, meta);
    toast('已保存', 'ok');
    return true;
  }catch(err){
    try{
      const a = document.createElement('a');
      a.href = src;
      a.download = baseName;
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('直链下载已发起；若未保存请长按图片另存', '');
      return true;
    }catch(e2){
      console.error('[downloadRemote]', err);
      toast('下载失败：' + ((err && err.message) || '网络错误'), 'err');
      return false;
    }
  }finally{
    if(btn){ btn.disabled = false; delete btn.dataset.busy; if(oldHtml) btn.innerHTML = oldHtml; }
  }
}