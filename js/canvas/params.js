import { TIERS, MAX_PIXELS, LS_PRESETS, LS_RECENT, VIDEO_MODELS, VIDEO_SECONDS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS } from './state.js';
import { toast, lsGet, lsSet, escapeHtml } from './util.js';
import { getSelectedImageModel, getSelectedChatModel, getSelectedVideoModel, getVideoCapabilities, getVideoModelsForPreset, getSizeVal, getCapNum, getImageModelCapabilities, getImageRatios, syncImageParamOptions, syncGifHint, applyPreset, maybeRefreshLiveModels } from './settings.js';

import { findImageSize, resolveImageSize } from './imageSizes.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }
function autosize(){ return state && state.hooks && state.hooks.autosize ? state.hooks.autosize() : undefined; }

export function setMode(mode){
  state.currentMode = mode;
  const isVideo = mode === 'video';
  const videoMode = state.videoMode === 'img2video' ? 'img2video' : 'txt2video';
  state.videoMode = videoMode;
  if(el.videoMode) el.videoMode.value = videoMode;
  document.querySelectorAll('#modeSwitch button').forEach(b=> b.classList.toggle('active', b.dataset.mode===mode));
  if(el.refStrip) el.refStrip.style.display = mode==='img2img' || (isVideo && videoMode==='img2video') ? 'flex' : 'none';
  if(el.imageOutputPanel) el.imageOutputPanel.style.display = isVideo ? 'none' : '';
  if(el.videoPanel) el.videoPanel.style.display = isVideo ? '' : 'none';
  /* 批量比例 / 超生成只在图片任务里生效（视频提交直接返回，不走批量逻辑），视频模式下隐藏避免误导 */
  if(el.batchPanel) el.batchPanel.style.display = isVideo ? 'none' : '';
  if(el.btnGen){ const gl = el.btnGen.querySelector('.lbl'); const gt = isVideo ? '生成视频' : '生成'; if(gl) gl.textContent = gt; else el.btnGen.textContent = gt; }
  if(el.btnOptimize) el.btnOptimize.style.display = isVideo ? 'none' : '';
  if(el.emptyOptimize) el.emptyOptimize.style.display = isVideo ? 'none' : '';
  if(el.emptyAddRef){
    el.emptyAddRef.style.display = isVideo && videoMode !== 'img2video' ? 'none' : '';
    const elbl = el.emptyAddRef.querySelector('.lbl');
    const etxt = isVideo ? '添加首帧参考图' : '添加参考图';
    if(elbl) elbl.textContent = etxt; else el.emptyAddRef.textContent = etxt;
  }
  el.prompt.placeholder = isVideo
    ? (videoMode === 'img2video' ? '描述如何让参考图动起来…' : '描述你想生成的视频…')
    : (mode === 'img2img' ? '描述要如何修改参考图…' : '描述你想要的画面…');
  const t2 = el.canvasEmpty && el.canvasEmpty.querySelector('.t2');
  if(t2) t2.innerHTML = isVideo
    ? (videoMode === 'img2video' ? '图片生视频：先添加参考图，再描述动作 → 点「生成视频」<br>结果会以视频卡片出现在画布上' : '文生视频：输入视频描述 → 点「生成视频」<br>结果会以视频卡片出现在画布上')
    : (mode === 'img2img' ? '图生图：先加参考图，再描述怎么改 → 点「生成」<br>结果以卡片出现在画布上，可拖拽整理、双指缩放' : '文生图：在下方输入描述 → 点「生成」<br>结果以卡片出现在画布上，可拖拽整理、双指缩放');
  renderVideoParams();
  syncQuickRow();
  if(!isVideo) syncImageParamOptions();
  document.dispatchEvent(new Event('canvas-mode-change'));
}

export function renderVideoParams(){
  if(!el.videoPanel) return;
  const caps = getVideoCapabilities() || {};
  const fill = (node, values, selected, labeler)=>{
    if(!node) return;
    const list = Array.from(new Set((values || []).filter(Boolean).map(String)));
    node.innerHTML = '';
    list.forEach(v=> node.add(new Option(labeler ? labeler(v) : v, v)));
    if(selected != null && list.includes(String(selected))) node.value = String(selected);
    else if(list.length) node.value = list[0];
  };
  const models = getVideoModelsForPreset() || VIDEO_MODELS;
  const selectedModel = getSelectedVideoModel();
  if(el.videoModel){
    el.videoModel.innerHTML = '';
    el.videoModel.add(new Option('自定义视频模型名…', '__custom__'));
    Array.from(new Set((models || VIDEO_MODELS).filter(Boolean))).forEach(v=> el.videoModel.add(new Option(v, v)));
    if(Array.from(el.videoModel.options).some(o=> o.value===String(selectedModel))) el.videoModel.value = String(selectedModel);
    else if(selectedModel){
      el.videoModel.value = '__custom__';
      if(el.videoCustomModel) el.videoCustomModel.value = String(selectedModel);
    }else if(el.videoModel.options.length > 1){
      el.videoModel.value = el.videoModel.options[1].value;
    }
    if(el.videoCustomModel) el.videoCustomModel.style.display = el.videoModel.value === '__custom__' ? '' : 'none';
    state.videoModel = getSelectedVideoModel();
  }
  fill(el.videoSeconds, caps.seconds || VIDEO_SECONDS, state.videoSeconds || caps.defaultSeconds || '6', v=> v + ' 秒');
  fill(el.videoAspectRatio, caps.aspectRatios || VIDEO_ASPECT_RATIOS, state.videoAspectRatio || caps.defaultAspectRatio || '16:9');
  fill(el.videoResolution, caps.resolutions || VIDEO_RESOLUTIONS, state.videoResolution || caps.defaultResolution || '720P');
  state.videoSeconds = el.videoSeconds && el.videoSeconds.value ? el.videoSeconds.value : '6';
  state.videoAspectRatio = el.videoAspectRatio && el.videoAspectRatio.value ? el.videoAspectRatio.value : '16:9';
  state.videoResolution = el.videoResolution && el.videoResolution.value ? el.videoResolution.value : '720P';
}

function ratioForSize(size){

  if(state.currentImageSizeMode === 'custom') return null;
  return findImageSize(size, getImageModelCapabilities())?.ratio || null;

}

function syncImageSelection(){

  if(state.currentImageSizeMode === 'custom'){
    state.selectedSize = resolveImageSize(state.selectedSize, getImageModelCapabilities(), 'custom');
    return;
  }
  const caps = getImageModelCapabilities();
  const found = findImageSize(state.selectedSize, caps);
  if(caps.imageSizePolicy === 'futureai-ratio'){
    const tiers = caps.resolutionOptions || TIERS;
    if(!tiers.includes(state.currentTier)) state.currentTier = caps.defaultResolution || tiers[0];
    const previousRatio = Object.entries(caps.imageSizePresets || {}).find(([r,values])=>Object.values(values).includes(state.selectedSize))?.[0];
    const ratio = found?.ratio || getImageRatios().find(item=>item.r === previousRatio);
    if(ratio){ state.selectedSize = ratio.v[state.currentTier]; }
    else{
      const first = getImageRatios()[0];
      if(first) state.selectedSize = first.v[state.currentTier];
    }
    state.currentResolution = state.currentTier;
    if(el.imageResolution) el.imageResolution.value = state.currentTier;
    return;
  }
  if(found){
    state.currentTier = found.tier;
    state.selectedSize = found.size;
  }
  // A previously saved custom size must not silently become the first preset.
  else if(state.selectedSize) state.currentImageSizeMode = 'custom';


}

function renderImageParamSummary(mode){

  if(!el.tierHint) return;
  if(getImageModelCapabilities().imageSizePolicy === 'futureai-ratio' && state.currentImageSizeMode !== 'custom'){
    const ratio = ratioForSize(state.selectedSize);
    el.tierHint.textContent = '分辨率 ' + state.currentTier + ' · 比例 ' + (ratio?.r || '自动');
    return;
  }
  const imageResolutionNote = state.currentResolution ? ' · 原生分辨率 ' + state.currentResolution.toUpperCase() : '';
  if(mode === 'custom' || state.currentImageSizeMode === 'custom'){
    el.tierHint.textContent = '自定义像素尺寸 ' + state.selectedSize + imageResolutionNote;
    return;
  }
  el.tierHint.textContent = '像素档位 ' + state.currentTier + ' · 所选尺寸 ' + state.selectedSize + imageResolutionNote;

}

export function renderTierTabs(){

  if(!el.tierTabs) return;
  syncImageSelection();
  el.tierTabs.innerHTML = '';

  const caps = getImageModelCapabilities();
  const tiers = caps.imageSizePolicy === 'futureai-ratio' ? (caps.resolutionOptions || TIERS) : TIERS;
  tiers.forEach(t=>{

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier-tab' + (t===state.currentTier ? ' active' : '');
    b.textContent = t;

    b.onclick = ()=>{
      const currentRatio = ratioForSize(state.selectedSize);
      state.currentImageSizeMode = 'preset';
      state.currentTier = t;
      if(caps.imageSizePolicy === 'futureai-ratio'){ state.currentResolution = t; if(el.imageResolution) el.imageResolution.value = t; }
      if(currentRatio && currentRatio.v[t]){
        state.selectedSize = currentRatio.v[t];
      }else{
        // 当前比例在该档位无尺寸（如 1:1 无 4K）时，自动切换到该档位首个可用比例，避免档位与尺寸不同步
        const first = getImageRatios().find(r=> r.v[t]);
        if(first){
          state.selectedSize = first.v[t];
          toast((currentRatio ? currentRatio.r : '当前比例') + ' 在 ' + t + ' 无对应尺寸，已切到 ' + first.r, 'ok');
        }
      }
      renderTierTabs();
      renderSizes();
      syncQuickRow();
    };

    el.tierTabs.appendChild(b);
  });

  renderImageParamSummary();

}

export function renderSizes(){

  if(!el.sizeGrid) return;
  syncImageSelection();
  el.sizeGrid.innerHTML = '';

  getImageRatios().forEach(s=>{

    const v = getSizeVal(s);
    if(!v) return;

    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'size-opt' + (v===state.selectedSize ? ' active' : '');
    d.innerHTML = '<div class="r">' + s.r + '</div><div class="d">' + s.d + '</div>';

    d.onclick = ()=>{
      state.selectedSize = v;
      state.currentImageSizeMode = 'preset';
      if(getImageModelCapabilities().imageSizePolicy !== 'futureai-ratio') state.currentTier = TIERS.find(t=> s.v[t] === v) || state.currentTier;
      renderTierTabs();
      renderSizes();
      syncQuickRow();
    };

    el.sizeGrid.appendChild(d);
  });

  renderImageParamSummary();

}

export function applyCustomSize(){

  const raw = (el.customSize.value || '').trim().toLowerCase().replace(/×/g,'x');

  const m = /^(\d+)\s*x\s*(\d+)$/.exec(raw);

  if(!m){ toast('自定义尺寸格式应为 宽x高，例如 1024x1024', 'err'); return; }

  const w = +m[1], h = +m[2];

  if(!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w<=0 || h<=0){ toast('尺寸需为有效正整数', 'err'); return; }

  const caps = getImageModelCapabilities();
  if(caps.imageSizePolicy === 'futureai-ratio' && !(caps.sizeModes || []).includes('pixel')){ toast('当前 FutureAI 模型只支持比例，请从比例列表选择', 'err'); return; }
  const minSide = getCapNum('minSide', 256), maxPixels = getCapNum('maxPixels', MAX_PIXELS), mult = getCapNum('multipleOf', 0);
  const isStudio = caps.imageSizePolicy === 'change2pro-studio';
  if(!isStudio){
    if(Math.min(w,h) < minSide){ toast('⚠️ 单边尺寸至少 ' + minSide + 'px，过小可能被服务端拒绝', 'err'); return; }
    if(mult > 1 && (w % mult !== 0 || h % mult !== 0)){ toast('⚠️ 当前供应商要求宽高为 ' + mult + ' 的倍数', 'err'); return; }
    if(w*h > maxPixels){ toast('⚠️ 总像素 ' + (w*h).toLocaleString() + ' 超过上限 ' + maxPixels.toLocaleString(), 'err'); return; }
  }
  state.currentImageSizeMode = 'custom';
  state.selectedSize = resolveImageSize(w + 'x' + h, caps, 'custom');

  el.customSize.value = state.selectedSize;

  const matchedRatio = ratioForSize(state.selectedSize);
  const matchedTier = matchedRatio ? TIERS.find(t=> matchedRatio.v[t] === state.selectedSize) : null;
  if(matchedTier) state.currentTier = matchedTier;

  renderTierTabs();
  renderSizes();
  renderImageParamSummary(matchedRatio && matchedTier ? undefined : 'custom');
  syncQuickRow();

  toast('✅ 已应用自定义尺寸：' + state.selectedSize, 'ok');

}

export function syncQuickRow(){
  const isVideo = state.currentMode === 'video';
  if(!isVideo && el.qcTier && el.qcRatio && el.qcCount){
    const ratio = ratioForSize(state.selectedSize);
    el.qcTier.innerHTML = '<b>' + escapeHtml(state.currentTier || '—') + '</b> 档位';
    el.qcRatio.innerHTML = '<b>' + escapeHtml(ratio ? ratio.r : '自定义') + '</b> 比例';
    el.qcCount.innerHTML = '<b>' + escapeHtml(String(el.count && el.count.value ? el.count.value : '1')) + '</b> 张';
  }
  [el.qcTier, el.qcRatio, el.qcCount].forEach(n=>{ if(n) n.style.display = isVideo ? 'none' : ''; });
  if(el.qcVideo){
    el.qcVideo.style.display = isVideo ? '' : 'none';
    el.qcVideo.innerHTML = '<b>' + (state.videoSeconds || '6') + 's</b> · ' + escapeHtml(state.videoResolution || '720P') + ' · ' + escapeHtml(state.videoAspectRatio || '16:9');
  }
  if(el.qcStatus){
    const model = isVideo ? getSelectedVideoModel() : getSelectedImageModel();
    const label = isVideo ? (state.videoMode === 'img2video' ? '图片生视频' : '文生视频') : (state.currentMode === 'img2img' ? '图生图' : '文生图');
    el.qcStatus.innerHTML = '<b>' + label + '</b>' + (isVideo && state.videoMode === 'img2video' ? ' ' + state.currentFiles.length + ' 图' : '') + (model ? ' · ' + escapeHtml(model) : '');
  }
  if(el.qcNeg) el.qcNeg.textContent = isVideo ? '视频负面词' : '负面词';
}

export function renderRecentChips(){

  el.recentChips.innerHTML = '';

  const list = lsGet(LS_RECENT, []);

  list.forEach(p=>{

    const c = document.createElement('button');

    c.className = 'lib-chip';

    c.textContent = p.length > 16 ? p.slice(0, 16) + '…' : p;

    c.title = p;

    c.onclick = ()=>{ el.prompt.value = p; autosize(); toast('已填入最近提示词', 'ok'); };

    el.recentChips.appendChild(c);

  });

}

export function pushRecent(p){

  const list = [p].concat(lsGet(LS_RECENT, []).filter(x=> x !== p)).slice(0, 8);

  lsSet(LS_RECENT, list);

  renderRecentChips();

}

export function loadPresets(){ return lsGet(LS_PRESETS, []); }

export function savePresets(list){ lsSet(LS_PRESETS, list); }

export function renderPresetSelect(){

  const list = loadPresets();

  const cur = el.presetSelect.value;

  el.presetSelect.innerHTML = '<option value="">— 选择预设 —</option>';

  list.forEach(p=> el.presetSelect.add(new Option(p.name, p.name)));

  if(cur && list.some(p=> p.name===cur)) el.presetSelect.value = cur;

}

export function collectCfg(){

  return {

    mode: state.currentMode, preset: el.providerPreset.value,

    base: el.apiBase.value.trim(), model: getSelectedImageModel(), chatModel: getSelectedChatModel(),
    videoModel: getSelectedVideoModel(), videoMode: state.videoMode || 'txt2video', videoSeconds: state.videoSeconds || '6', videoAspectRatio: state.videoAspectRatio || '16:9', videoResolution: state.videoResolution || '720P',

    chatBase: el.chatBase.value.trim(),

    tier: state.currentTier, size: state.selectedSize, imageSizeMode:state.currentImageSizeMode || 'preset', count: el.count.value,

    prompt: el.prompt.value, negative: el.negative.value,

    quality: state.currentQuality, complexity:state.currentComplexity || '', background: state.currentBg, format: state.currentFmt, resolution: state.currentResolution || '',
    responseFormat: el.responseFormat ? el.responseFormat.value : '', stream: !!(el.streamMode && el.streamMode.value === '1'),

    batchMode: el.batchMode.checked, batchRatios: Array.from(state.batchRatios),

    overshootMode: el.ogMode ? !!el.ogMode.checked : false, overshootAttempts: el.ogAttempts ? String(el.ogAttempts.value || '20') : '20', overshootTarget: el.ogTarget ? String(el.ogTarget.value || '5') : '5',

    promptLang: el.promptLang.value

  };

}

export function applyCfg(c){

  if(!c) return;

  if(c.videoMode) state.videoMode = c.videoMode === 'img2video' ? 'img2video' : 'txt2video';
  if(c.videoModel) state.videoModel = String(c.videoModel);
  if(c.videoSeconds) state.videoSeconds = String(c.videoSeconds);
  if(c.videoAspectRatio) state.videoAspectRatio = String(c.videoAspectRatio);
  if(c.videoResolution) state.videoResolution = String(c.videoResolution);
  setMode(c.mode || 'txt2img');
  renderVideoParams();
  if(el.videoModel){
    if(c.videoModel && Array.from(el.videoModel.options).some(o=>o.value===String(c.videoModel))) el.videoModel.value = String(c.videoModel);
    else if(c.videoModel && el.videoCustomModel){ el.videoModel.value = '__custom__'; el.videoCustomModel.value = String(c.videoModel); }
    el.videoCustomModel.style.display = el.videoModel.value === '__custom__' ? '' : 'none';
  }
  if(el.videoSeconds) el.videoSeconds.value = state.videoSeconds;
  if(el.videoAspectRatio) el.videoAspectRatio.value = state.videoAspectRatio;
  if(el.videoResolution) el.videoResolution.value = state.videoResolution;

  if(c.preset && state.providerConfig.presets[c.preset]){ el.providerPreset.value = c.preset; applyPreset(false); }

  // 应用预设时总是显式写入 Base URL：预设为空时清空，避免残留上一个供应商地址

  const presetBase = c.preset && state.providerConfig.presets[c.preset] ? (state.providerConfig.presets[c.preset].baseUrl || '') : '';

  el.apiBase.value = c.base || presetBase;

  if(c.model){

    if(Array.from(el.model.options).some(o=> o.value===c.model)) el.model.value = c.model;

    else { el.model.value = '__custom__'; el.customModel.value = c.model; }

    el.customModel.style.display = el.model.value==='__custom__' ? '' : 'none';

  }

  if(c.chatModel){

    if(Array.from(el.chatModel.options).some(o=> o.value===c.chatModel)) el.chatModel.value = c.chatModel;

    else { el.chatModel.value = '__custom__'; el.chatCustomModel.value = c.chatModel; }

  }

  el.chatCustomModel.style.display = el.chatModel.value==='__custom__' ? '' : 'none';

  if('chatBase' in c) el.chatBase.value = c.chatBase || '';

  if(c.promptLang && ['en','zh','mix'].includes(c.promptLang)) el.promptLang.value = c.promptLang;

  el.batchMode.checked = !!c.batchMode;

  state.batchRatios.clear();

  (Array.isArray(c.batchRatios) ? c.batchRatios : []).forEach(r=> state.batchRatios.add(r));

  renderBatchChips();

  state.currentQuality = (c.quality && ['auto','low','medium','high','xhigh','max'].includes(c.quality)) ? c.quality : '';

  state.currentBg = (c.background && ['auto','transparent','opaque'].includes(c.background)) ? c.background : '';

  state.currentFmt = (c.format && ['png','jpeg','webp','gif'].includes(c.format)) ? c.format : '';

  /* 先按已恢复的模型/预设重建可选项，再写入保存值：
     被能力配置禁用（隐藏）的参数一律不恢复，否则会在界面看不到的情况下仍被发送 */
  const requested = { complexity:c.complexity || '', quality:state.currentQuality, background:state.currentBg, format:state.currentFmt };
  syncImageParamOptions();
  const restoreSelect = (select, value)=>{
    if(!select) return '';
    select.value = select.disabled ? '' : (value || '');
    return select.value;
  };
  state.currentQuality = restoreSelect(el.quality, requested.quality);
  state.currentComplexity = restoreSelect(el.complexity, requested.complexity);
  state.currentBg = restoreSelect(el.background, requested.background);
  state.currentFmt = restoreSelect(el.format, requested.format);
  syncGifHint();
  restoreSelect(el.responseFormat, c.responseFormat);
  if(el.streamMode) el.streamMode.value = (c.stream && !el.streamMode.disabled) ? '1' : '';
  if(c.resolution && el.imageResolution && !el.imageResolution.disabled && Array.from(el.imageResolution.options).some(o=> o.value === c.resolution)){
    el.imageResolution.value = c.resolution;
    state.currentResolution = c.resolution;
  }

  if(el.ogMode) el.ogMode.checked = !!c.overshootMode;

  if(el.ogAttempts && c.overshootAttempts) el.ogAttempts.value = String(c.overshootAttempts);

  if(el.ogTarget && c.overshootTarget) el.ogTarget.value = String(c.overshootTarget);

  updateOgFields();

  state.currentImageSizeMode = c.imageSizeMode === 'custom' ? 'custom' : 'preset';
  if(c.tier && (getImageModelCapabilities().imageSizePolicy === 'futureai-ratio' ? (getImageModelCapabilities().resolutionOptions || TIERS) : TIERS).includes(c.tier)) state.currentTier = c.tier;

  if(c.size && (/^\d+x\d+$/.test(c.size) || (getImageModelCapabilities().imageSizePolicy === 'futureai-ratio' && (getImageModelCapabilities().aspectRatios || []).includes(c.size)))) state.selectedSize = c.size;

  el.count.value = c.count || '1';

  el.prompt.value = c.prompt || '';

  el.negative.value = c.negative || '';

  renderTierTabs(); renderSizes(); syncQuickRow(); autosize();

  maybeRefreshLiveModels(true);

}

export function openNameModal(){

  el.nameInput.value = '';

  el.nameModal.classList.add('open');

  setTimeout(()=> el.nameInput.focus(), 200);

}

export function closeNameModal(){ el.nameModal.classList.remove('open'); }

export function renderBatchChips(){

  el.batchRatioChips.innerHTML = '';

  getImageRatios().forEach(r=>{

    const b = document.createElement('button');

    b.className = 'batch-tab' + (state.batchRatios.has(r.r) ? ' active' : '');

    b.textContent = r.r;

    b.onclick = ()=>{

      if(state.batchRatios.has(r.r)) state.batchRatios.delete(r.r); else state.batchRatios.add(r.r);

      renderBatchChips();

    };

    el.batchRatioChips.appendChild(b);

  });

}

export function presetBatchFromSize(size){

  const ratio = findImageSize(size, getImageModelCapabilities())?.ratio;

  if(ratio){ state.batchRatios.clear(); state.batchRatios.add(ratio.r); renderBatchChips(); }

}

export function updateOgFields(){
  if(!el || !el.ogFields) return;
  el.ogFields.style.display = (el.ogMode && el.ogMode.checked) ? '' : 'none';
}