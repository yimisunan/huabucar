import { MAX_PIXELS } from './state.js';
import { toast, getRequestUrl, localApiProxyHint } from './util.js';
import { getCapabilities, getSelectedImageModel, getImageModelCapabilities } from './settings.js';

/**
 * 局部修改（蒙版重绘）
 * 设计要点：
 *  1) 源无关：任务结果 / 参考图 / 素材库 / 本机文件 都能进涂抹（openPaintSource）
 *  2) 撤销栈存「笔画数组」而不是整张 ImageData —— 内存从 ~48MB 降到 <1MB，并且能重做
 *  3) 蒙版在「请求尺寸」上按笔画重放生成，天然支持羽化 / 扩张，不再最近邻放大锯齿
 */

// 编辑分辨率上限：按设备内存自适应（8G+ 用 2560，否则 2048），内存与清晰度平衡
const PAINT_MAX_SIDE = ((navigator.deviceMemory || 4) >= 8) ? 2560 : 2048;
const UNDO_MAX = 60;           // 笔画步数上限（每步几十字节）

let state = null, el = null, paintCtx = null;

export function bindRuntime(s, e){
  state = s;
  el = e;
  paintCtx = el.paintCanvas.getContext('2d');
}
function renderCardState(task){ return state && state.hooks && state.hooks.renderCardState ? state.hooks.renderCardState(task) : undefined; }
function showPreview(entry){ return state && state.hooks && state.hooks.showPreview ? state.hooks.showPreview(entry) : undefined; }
function scheduleAutosave(){ return state && state.hooks && state.hooks.scheduleAutosave ? state.hooks.scheduleAutosave() : undefined; }
function openDrawer(name){ return state && state.hooks && state.hooks.openDrawer ? state.hooks.openDrawer(name) : undefined; }
function closeDrawers(){ return state && state.hooks && state.hooks.closeDrawers ? state.hooks.closeDrawers() : undefined; }
function buildTask(opts){ return state && state.hooks && state.hooks.buildTask ? state.hooks.buildTask(opts) : null; }
function enqueueTask(task){ return state && state.hooks && state.hooks.enqueueTask ? state.hooks.enqueueTask(task) : undefined; }
function startOvershoot(o){ return state && state.hooks && state.hooks.startOvershoot ? state.hooks.startOvershoot(o) : null; }

export function getTaskResultIndex(entry){
  if(!entry || !entry.resultItems.length) return 0;
  const i = Number(entry.resultIndex);
  return Number.isInteger(i) ? Math.max(0, Math.min(entry.resultItems.length - 1, i)) : 0;
}

export function getTaskResult(entry){
  if(!entry || !entry.resultItems.length) return null;
  entry.resultIndex = getTaskResultIndex(entry);
  return entry.resultItems[entry.resultIndex];
}

export function setTaskResultIndex(entry, index){
  if(!entry || !entry.resultItems.length) return;
  entry.resultIndex = Math.max(0, Math.min(entry.resultItems.length - 1, Number(index) || 0));
  renderCardState(entry.task);
  if(state.previewTask === entry) showPreview(entry);
}

/* ================= 打开涂抹面板 ================= */

// 兼容旧调用：卡片 / 右键菜单传任务
export function openPaint(task){
  if(!task) return;
  const t = state.taskEls[task.id];
  if(!t || !t.resultItems.length){ toast('没有可重绘的图片', 'err'); return; }
  const ri = getTaskResult(t);
  openPaintSource({
    blob: ri.blob || null,
    url: ri.url || '',
    label: '#' + task.id,
    parentId: task.id,
    task,
    caps: task.capabilities || null
  });
}

// 本机文件 → 涂抹
export function openPaintFile(file){
  if(!file) return;
  if(!/^image\//.test(file.type || '')){ toast('请选择图片文件', 'err'); return; }
  openPaintSource({ blob: file, label: '本机图片', parentId: null });
}

/**
 * 统一入口
 * src = { blob?, url?, label?, parentId?, caps?, task? }
 */
export function openPaintSource(src){
  if(state.paintBusy) return;
  src = src || {};
  if(!src.blob && !src.url){ toast('没有可编辑的图片', 'err'); return; }
  const needLoad = !src.blob;
  if(needLoad){ state.paintBusy = true; toast('⏳ 正在下载原图（较大，请稍候）…', 'loading'); }
  const load = src.blob ? Promise.resolve(src.blob) : fetch(getRequestUrl(src.url)).then(r=> r.blob());
  load.then(blob=> new Promise(resolve=>{
    const img = new Image();
    const objUrl = URL.createObjectURL(blob);
    img.onload = ()=>{
      URL.revokeObjectURL(objUrl);
      const ow = img.naturalWidth, oh = img.naturalHeight;
      const ps = Math.min(1, PAINT_MAX_SIDE / Math.max(ow, oh));
      const pw = Math.max(1, Math.round(ow * ps));
      const ph = Math.max(1, Math.round(oh * ps));
      state.paintOrig = img;
      state.paintSrcBlob = blob;
      state.paintSource = { label: src.label || '图片', parentId: src.parentId || null, caps: src.caps || null, task: src.task || null };
      state.paintOrigW = ow; state.paintOrigH = oh;
      state.paintEditW = pw; state.paintEditH = ph;
      state.paintStrokes = [];
      state.paintRedo = [];
      state.paintScale = 1 / ps;
      state.paintBrushSize = Math.max(4, Math.round(pw / 40));
      state.paintMaskView = false;
      state.paintDirty = false;
      state.paintMask = document.createElement('canvas');
      state.paintMask.width = pw;
      state.paintMask.height = ph;
      el.paintCanvas.width = pw;
      el.paintCanvas.height = ph;
      state.paintView = { z: 1, tx: 0, ty: 0 };
      applyView();
      drawPaint();
      el.paintMeta.textContent = (src.label || '图片') + ' · ' + ow + '×' + oh + (ps < 1 ? '（编辑 ' + pw + '×' + ph + '）' : '');
      el.paintPrompt.value = (src.task && src.task.prompt) ? src.task.prompt : '';
      autosizePaint();
      syncPaintControls();
      el.paintWrap.classList.add('open');
      if(needLoad) toast('🖌 原图加载完成，涂抹要改的区域', 'ok');
      resolve();
    };
    img.onerror = ()=>{ URL.revokeObjectURL(objUrl); toast('图片加载失败', 'err'); resolve(); };
    img.src = objUrl;
  })).catch(()=> toast('无法获取图片数据', 'err'))
    .finally(()=>{ state.paintBusy = false; });
}

export function closePaint(force){
  if(!force && state.paintStrokes && state.paintStrokes.length){
    if(!confirm('还有未提交的涂抹，确定关闭？')) return false;
  }
  el.paintWrap.classList.remove('open');
  state.paintOrig = null; state.paintMask = null;
  state.paintStrokes = []; state.paintRedo = [];
  state.paintSource = null; state.paintScale = 1;
  state.paintMaskView = false; state.paintDirty = false;
  syncPaintControls();
  return true;
}

export function autosizePaint(){
  el.paintPrompt.style.height = 'auto';
  el.paintPrompt.style.height = Math.min(60, el.paintPrompt.scrollHeight) + 'px';
}

/* ================= 控件状态 ================= */

export function syncPaintControls(){
  const strokes = state.paintStrokes || [];
  if(el.paintSizeVal) el.paintSizeVal.textContent = Math.max(1, Math.round(state.paintBrushSize * state.paintScale));
  if(el.paintUndo){ el.paintUndo.disabled = !strokes.length; el.paintUndo.title = '撤销（' + strokes.length + ' 笔）'; }
  if(el.paintRedo){ el.paintRedo.disabled = !(state.paintRedo || []).length; el.paintRedo.title = '重做（' + (state.paintRedo || []).length + ' 笔）'; }
  if(el.paintBrush) el.paintBrush.classList.toggle('on', state.paintTool !== 'eraser');
  if(el.paintEraser) el.paintEraser.classList.toggle('on', state.paintTool === 'eraser');
  if(el.paintMaskView) el.paintMaskView.classList.toggle('on', !!state.paintMaskView);
  if(el.paintFeatherVal) el.paintFeatherVal.textContent = String(state.paintFeather || 0);
  if(el.paintExpandVal) el.paintExpandVal.textContent = (state.paintExpand > 0 ? '+' : '') + (state.paintExpand || 0);
  if(el.paintGo) el.paintGo.disabled = !strokes.length;
  if(el.paintClear) el.paintClear.disabled = !strokes.length;
}

export function setPaintTool(tool){
  state.paintTool = tool === 'eraser' ? 'eraser' : 'brush';
  syncPaintControls();
}

export function bumpBrush(delta){
  state.paintBrushSize = Math.max(2, Math.min(400, (state.paintBrushSize || 24) + delta));
  syncPaintControls();
}

export function setFeather(v){
  state.paintFeather = Math.max(0, Math.min(8, Number(v) || 0));
  syncPaintControls();
}

export function setExpand(v){
  state.paintExpand = Math.max(-3, Math.min(6, Number(v) || 0));
  syncPaintControls();
}

export function toggleMaskView(on){
  state.paintMaskView = (typeof on === 'boolean') ? on : !state.paintMaskView;
  drawPaint();
  syncPaintControls();
}

/* ================= 视图：双指缩放 / 双指平移 ================= */

const pointers = new Map();
let gesture = null;
let drawingPointer = null;

function applyView(){
  const v = state.paintView || { z: 1, tx: 0, ty: 0 };
  if(el.paintCanvas){
    el.paintCanvas.style.transform = 'translate(' + (v.tx || 0) + 'px,' + (v.ty || 0) + 'px) scale(' + (v.z || 1) + ')';
  }
  if(el.paintZoomVal) el.paintZoomVal.textContent = Math.round((v.z || 1) * 100) + '%';
}

export function resetPaintZoom(){
  state.paintView = { z: 1, tx: 0, ty: 0 };
  applyView();
}

export function zoomPaintBy(factor){
  if(!state.paintView) state.paintView = { z: 1, tx: 0, ty: 0 };
  const v = state.paintView;
  v.z = Math.max(0.5, Math.min(8, (v.z || 1) * factor));
  applyView();
}

function gestureStart(){
  const pts = [...pointers.values()];
  if(pts.length < 2) return null;
  const a = pts[0], b = pts[1];
  const v = state.paintView || { z: 1, tx: 0, ty: 0 };
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    z: v.z || 1, tx: v.tx || 0, ty: v.ty || 0
  };
}

// 单指 = 涂抹；双指 = 缩放/平移（互不干扰）
export function onPaintPointerDown(e){
  if(!state.paintMask) return;
  e.preventDefault();
  try{ el.paintCanvas.setPointerCapture(e.pointerId); }catch(err){}
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if(pointers.size >= 2){
    // 第二根手指落下：把“刚落下第一指时误画的小点”撤掉，再进入手势模式
    if(drawingPointer !== null){
      const strokes = state.paintStrokes || [];
      const last = strokes[strokes.length - 1];
      if(last && last.pts.length <= 3){
        strokes.pop();
        rebuildMask();
      }
      drawingPointer = null;
      endStroke();
      syncPaintControls();
    }
    gesture = gestureStart();
    return;
  }
  drawingPointer = e.pointerId;
  startStroke(paintPos(e));
}

export function onPaintPointerMove(e){
  if(pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if(gesture && pointers.size >= 2){
    const pts = [...pointers.values()];
    const a = pts[0], b = pts[1];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const v = state.paintView;
    v.z = Math.max(0.5, Math.min(8, gesture.z * (dist / gesture.dist)));
    v.tx = gesture.tx + (mid.x - gesture.mid.x);
    v.ty = gesture.ty + (mid.y - gesture.mid.y);
    applyView();
    return;
  }
  if(e.pointerId !== drawingPointer) return;
  moveStroke(paintPos(e));
}

export function onPaintPointerUp(e){
  pointers.delete(e.pointerId);
  if(gesture && pointers.size < 2) gesture = null;
  if(e.pointerId === drawingPointer){ drawingPointer = null; endStroke(); }
}

export function onPaintWheel(e){
  if(!state.paintMask) return;
  e.preventDefault();
  zoomPaintBy(e.deltaY < 0 ? 1.12 : 0.89);
}

/* ================= 绘制 ================= */

export function paintPos(e){
  const rect = el.paintCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (el.paintCanvas.width / rect.width),
    y: (e.clientY - rect.top) * (el.paintCanvas.height / rect.height)
  };
}

export function startStroke(pos){
  if(!state.paintMask || !state.paintOrig) return;
  const stroke = { tool: state.paintTool === 'eraser' ? 'eraser' : 'brush', size: state.paintBrushSize, pts: [[pos.x, pos.y]] };
  state.paintStrokes.push(stroke);
  if(state.paintStrokes.length > UNDO_MAX) state.paintStrokes.shift();
  state.paintRedo = [];
  state.paintDirty = true;
  drawStroke(stroke, [pos, pos]);
  syncPaintControls();
}

export function moveStroke(pos){
  const strokes = state.paintStrokes || [];
  const stroke = strokes[strokes.length - 1];
  if(!stroke) return;
  const prev = stroke.pts[stroke.pts.length - 1];
  if(!prev) return;
  if(Math.abs(prev[0] - pos.x) < 0.6 && Math.abs(prev[1] - pos.y) < 0.6) return;
  stroke.pts.push([pos.x, pos.y]);
  drawStroke(stroke, [{ x: prev[0], y: prev[1] }, pos]);
}

export function endStroke(){
  syncPaintControls();
}

function strokePath(ctx, stroke, pts, width){
  if(!pts.length) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width != null ? width : stroke.size;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if(pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
  for(let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function drawStroke(stroke, segment){
  const mc = state.paintMask.getContext('2d');
  mc.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
  mc.strokeStyle = '#fff';
  strokePath(mc, stroke, segment, stroke.size);
  mc.globalCompositeOperation = 'source-over';
  drawPaint();
}

function rebuildMask(){
  if(!state.paintMask) return;
  const mc = state.paintMask.getContext('2d');
  mc.clearRect(0, 0, state.paintMask.width, state.paintMask.height);
  (state.paintStrokes || []).forEach(stroke=>{
    mc.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    mc.strokeStyle = '#fff';
    strokePath(mc, stroke, stroke.pts.map(p=>({ x: p[0], y: p[1] })), stroke.size);
  });
  mc.globalCompositeOperation = 'source-over';
  drawPaint();
}

export function drawPaint(){
  if(!state.paintOrig) return;
  const w = el.paintCanvas.width, h = el.paintCanvas.height;
  paintCtx.clearRect(0, 0, w, h);
  if(state.paintMaskView){
    paintCtx.fillStyle = '#000';
    paintCtx.fillRect(0, 0, w, h);
    paintCtx.drawImage(state.paintMask, 0, 0);
    return;
  }
  paintCtx.drawImage(state.paintOrig, 0, 0, w, h);
  if(state.paintMask){
    paintCtx.globalAlpha = 0.45;
    paintCtx.drawImage(state.paintMask, 0, 0);
    paintCtx.globalAlpha = 1;
  }
}

export function undoPaint(){
  const strokes = state.paintStrokes || [];
  if(!strokes.length) return;
  state.paintRedo = state.paintRedo || [];
  state.paintRedo.push(strokes.pop());
  rebuildMask();
  syncPaintControls();
}

export function redoPaint(){
  const redo = state.paintRedo || [];
  if(!redo.length) return;
  state.paintStrokes.push(redo.pop());
  rebuildMask();
  syncPaintControls();
}

export function clearPaintStrokes(){
  if(!(state.paintStrokes || []).length) return;
  state.paintRedo = [];
  state.paintStrokes = [];
  rebuildMask();
  syncPaintControls();
}

export function hasPaint(){
  return !!(state.paintStrokes && state.paintStrokes.length);
}

/* ================= 请求构建 ================= */

function currentCaps(){
  return (state.paintSource && state.paintSource.caps) || getCapabilities();
}

function targetSize(policy){
  const caps = currentCaps();
  const multiple = Math.max(1, Number(caps.multipleOf) || 1);
  const minSide = Math.max(1, Number(caps.minSide) || 1);
  const maxPixels = Math.max(1, Number(caps.maxPixels) || MAX_PIXELS);
  const ow = state.paintOrigW, oh = state.paintOrigH;
  const snap = v=> Math.max(minSide, Math.max(multiple, Math.round(v / multiple) * multiple));
  let fw, fh;
  if(policy === 'original'){
    fw = snap(ow); fh = snap(oh);
  }else{
    const up = v=> Math.max(multiple, Math.ceil(v / multiple) * multiple);
    fw = Math.max(minSide, up(ow)); fh = Math.max(minSide, up(oh));
  }
  if(fw * fh > maxPixels){
    const k = Math.sqrt(maxPixels / (fw * fh));
    fw = Math.max(multiple, Math.floor(fw * k / multiple) * multiple);
    fh = Math.max(multiple, Math.floor(fh * k / multiple) * multiple);
    if(Math.min(fw, fh) < minSide){
      const s = minSide / Math.min(fw, fh);
      fw = Math.max(minSide, Math.ceil(fw * s / multiple) * multiple);
      fh = Math.max(minSide, Math.ceil(fh * s / multiple) * multiple);
    }
  }
  while(fw * fh > maxPixels && fw > multiple && fh > multiple){
    if(fw / Math.max(1, ow) >= fh / Math.max(1, oh)) fw -= multiple; else fh -= multiple;
  }
  return { fw, fh, ok: fw >= minSide && fh >= minSide && fw * fh <= maxPixels };
}

export function buildInpaint(policy){
  if(!state.paintOrig || !hasPaint()) return null;
  const t = targetSize(policy || 'original');
  if(!t.ok){ toast('⚠️ 当前供应商无法为原图计算合法的重绘尺寸', 'err'); return null; }
  const fw = t.fw, fh = t.fh;
  const k = fw / state.paintEditW;
  const feather = Math.round((Number(state.paintFeather) || 0) * k);
  const expand = Math.round((Number(state.paintExpand) || 0) * k);
  try{
    const mc = document.createElement('canvas');
    mc.width = fw; mc.height = fh;
    const mctx = mc.getContext('2d');
    mctx.fillStyle = '#fff';
    mctx.fillRect(0, 0, fw, fh);
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    if(feather > 0) mctx.filter = 'blur(' + feather + 'px)';
    (state.paintStrokes || []).forEach(stroke=>{
      const pts = stroke.pts.map(p=>({ x: p[0] * k, y: p[1] * k }));
      const width = Math.max(1, stroke.size * k) + expand * 2;
      if(stroke.tool === 'eraser'){
        mctx.globalCompositeOperation = 'source-over';
        mctx.strokeStyle = '#fff';
      }else{
        mctx.globalCompositeOperation = 'destination-out';
        mctx.strokeStyle = '#000';
      }
      strokePath(mctx, stroke, pts, width);
    });
    mctx.globalCompositeOperation = 'source-over';
    mctx.filter = 'none';
    const maskBlob = canvasToPngBlob(mc);

    const ic = document.createElement('canvas');
    ic.width = fw; ic.height = fh;
    ic.getContext('2d').drawImage(state.paintOrig, 0, 0, fw, fh);
    const imageBlob = canvasToPngBlob(ic);

    if(!maskBlob || !imageBlob){ toast('蒙版生成失败', 'err'); return null; }
    return { imageBlob, maskBlob, fw, fh, size: fw + 'x' + fh, caps: currentCaps() };
  }catch(e){
    toast('蒙版生成失败', 'err');
    return null;
  }
}

export function canvasToPngBlob(cv){
  try{
    const b = cv.toDataURL('image/png');
    const bin = atob(b.split(',')[1]);
    const arr = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'image/png' });
  }catch(e){ return null; }
}

/* ================= 提交 ================= */

export function submitPaint(policy){
  if(!hasPaint()){ toast('请先涂抹要修改的区域', 'err'); return null; }
  const prompt = el.paintPrompt.value.trim();
  if(!prompt){ toast('请描述涂抹区域要变成什么', 'err'); return null; }
  const key = el.apiKey.value.trim();
  const baseRaw = el.apiBase.value.trim().replace(/\/+$/, '');
  // 兜底：页面重载后设置里的 Base 可能丢了版本段（如 /v1），而预设 baseUrl 是完整的
  const presetKey = el.providerPreset.value;
  const presetBase = (state.providerConfig && state.providerConfig.presets && state.providerConfig.presets[presetKey] && state.providerConfig.presets[presetKey].baseUrl) || '';
  let base = baseRaw;
  if(presetBase && presetBase.toLowerCase().startsWith(baseRaw.toLowerCase()) && presetBase.length > baseRaw.length){
    base = presetBase.replace(/\/+$/, '');
  }
  if(!key){ toast('请先填写生图 API Key（设置 ⚙️）', 'err'); closePaint(true); closeDrawers(); openDrawer('settings'); return null; }
  if(!base){ toast('请先填写生图 Base URL（设置 ⚙️）', 'err'); closePaint(true); closeDrawers(); openDrawer('settings'); return null; }
  const hint = localApiProxyHint(base);
  if(hint){ toast('⚠️ ' + hint, 'err'); closePaint(true); closeDrawers(); openDrawer('settings'); return null; }
  const payload = buildInpaint(policy);
  if(!payload) return null;

  const paintCaps = getImageModelCapabilities(getSelectedImageModel());
  const src = state.paintSource || {};
  const count = Math.max(1, Math.min(4, Number(el.paintCount && el.paintCount.value) || 1));
  const useOG = !!(el.paintOvershoot && el.paintOvershoot.checked);
  el.canvasEmpty.classList.add('hide');
  const baseOpts = {
    mode: 'img2img',
    files: [],
    inpaint: { image: payload.imageBlob, mask: payload.maskBlob },
    prompt,
    negative: el.negative.value.trim(),
    preset: el.providerPreset.value,
    capabilities: paintCaps,
    model: getSelectedImageModel(),
    quality: state.currentQuality, complexity:el.complexity && !el.complexity.disabled ? el.complexity.value : '', background: state.currentBg, outputFormat: state.currentFmt, resolution: state.currentResolution,
    base, key
  };
  const relation = 'inpaint';
  // 超生成：直接复用画布的超生成调度（目标成功 N 张，失败自动补，达标即停）
  if(useOG){
    const clamp = (v, d, max)=> Math.max(1, Math.min(max, Math.floor(Number(v) || d)));
    const target = clamp(el.paintOGTarget && el.paintOGTarget.value, count, 30);
    const attempts = Math.max(target, clamp(el.paintOGAttempts && el.paintOGAttempts.value, target + 3, 50));
    const og = startOvershoot({ baseOpts, size: payload.size, attempts, target, parentId: src.parentId || null, relation });
    if(!og || !og.ok) return null;
    closePaint(true);
    toast('🎯 局部修改超生成：最多 ' + og.attempts + ' 张，目标 ' + og.target + ' 张成功（' + payload.size + '）', 'ok');
    return og;
  }
  // 普通多张：逐张建任务，带 batchOf 以便卡片互相识别与“删除同批”
  let lastTask = null;
  for(let i = 0; i < count; i++){
    const task = buildTask({ ...baseOpts, parentId: src.parentId || null, relation, size: payload.size, n: 1 });
    if(!task) break;
    if(count > 1){ task.batchOf = count; task.batchIdx = i + 1; }
    task.paintSourceLabel = src.label || '';
    task.paintSourceUploaded = !src.parentId;
    enqueueTask(task);
    lastTask = task;
  }
  closePaint(true);
  toast('🖌 局部修改已提交 ' + count + ' 张（' + payload.size + '）', 'ok');
  return lastTask;
}