import { $, LS_KEY, LS_API_PROFILES, REQUEST_TIMEOUTS, MAX_REFS, VIDEO_MODELS, VIDEO_SECONDS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS } from './state.js';
import { lsGet, lsSet, toast, escapeHtml, fetchWithTimeout, parseApiError, localApiProxyHint } from './util.js';
import { imageRatios } from './imageSizes.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }
function syncQuickRow(){ return state && state.hooks && state.hooks.syncQuickRow ? state.hooks.syncQuickRow() : undefined; }

export function COMMON_IMAGE_CAPS(){

  return {

    modelListEndpoint:'/models',

    imageEndpoints:{ generate:'/images/generations', edit:'/images/edits' },

    negativePrompt:'compat', customModel:true,

    maxPixels:8294400, minSide:256, multipleOf:16, maxRefFileMB:30, maxRefPixels:16777216,

    imageParams:{ quality:true, background:true, outputFormat:true },

    qualityOptions:['auto','low','medium','high'],

    backgroundOptions:['auto','transparent','opaque'],

    outputFormatOptions:['png','jpeg','webp']

  };

}

export function COMMON_VIDEO_CAPS(){

  return {
    models:[...VIDEO_MODELS],
    endpoints:{ create:'/videos', status:'/videos/{id}', content:'/videos/{id}/content' },
    requestFormat:'json', maxReferences:4, referenceField:'image', multiReferenceField:'images',
    defaultSeconds:'6', seconds:[...VIDEO_SECONDS],
    defaultAspectRatio:'16:9', aspectRatios:[...VIDEO_ASPECT_RATIOS],
    defaultResolution:'720P', resolutions:[...VIDEO_RESOLUTIONS], negativePrompt:false, customModel:true
  };

}

export function DEFAULT_PROVIDER_CONFIG(){

  return {

    defaultPreset: 'openai-compatible',

    presets: {

      'openai-compatible': { label:'通用 OpenAI 兼容', baseUrl:'', models:{ image:['gpt-image-2','gpt-image-1'], chat:['gpt-5.5','gpt-5.4-mini'], video:[...VIDEO_MODELS] }, capabilities: Object.assign({ maxReferences:1, referenceFieldStrategy:'repeat-image' }, COMMON_IMAGE_CAPS(), { video:COMMON_VIDEO_CAPS() }) },

      botcf: { label:'botcf 兼容预设', baseUrl:'https://botcf.com/v1', models:{ image:['gpt-image-2','gpt-image-2-1k','gpt-image-2-2k','gpt-image-2-4k','gpt-image-2-4k超分','gpt-image-2-codex','gpt-image-1'], chat:['gpt-5.5','gpt-5.6-sol','gpt-5.6-luna','gpt-5.6-terra','gpt-5.4','gpt-5.4-mini'], video:[...VIDEO_MODELS] }, capabilities: Object.assign({ maxReferences:4, referenceFieldStrategy:'array-image' }, COMMON_IMAGE_CAPS(), { video:COMMON_VIDEO_CAPS() }) }

    },

    fallback: Object.assign({ maxReferences:1, referenceFieldStrategy:'repeat-image' }, COMMON_IMAGE_CAPS(), { video:COMMON_VIDEO_CAPS() })

  };

}

export function getPresetByKey(key){

  const presets = state.providerConfig.presets || {};

  return (key && presets[key]) || presets[state.providerConfig.defaultPreset] || DEFAULT_PROVIDER_CONFIG().presets['openai-compatible'];

}

export function getPreset(){ return getPresetByKey(el.providerPreset.value); }

export function getCapabilitiesForPreset(key){

  const preset = getPresetByKey(key);

  return preset.capabilities || state.providerConfig.fallback || { maxReferences:1, referenceFieldStrategy:'repeat-image', negativePrompt:'compat' };

}

export function getVideoCapabilitiesForPreset(key){

  const preset = getPresetByKey(key);
  const caps = preset.capabilities || {};
  return caps.video || (state.providerConfig.fallback && state.providerConfig.fallback.video) || COMMON_VIDEO_CAPS();

}

export function getVideoCapabilities(){ return getVideoCapabilitiesForPreset(el.providerPreset.value); }

export function getVideoModelsForPreset(key){

  const preset = getPresetByKey(key);
  const models = preset.models && Array.isArray(preset.models.video) ? preset.models.video : getVideoCapabilitiesForPreset(key).models;
  return Array.from(new Set((models || VIDEO_MODELS).filter(Boolean)));

}

export function getCapabilities(){ return getCapabilitiesForPreset(el.providerPreset.value); }

export function getMaxReferences(model, capabilities){
  const caps = getImageModelCapabilities(model || getSelectedImageModel(), capabilities);
  return Math.min(MAX_REFS, Number(caps.maxReferences) || 1);
}

export function getCapNum(key, def, model, capabilities){
  const caps = model ? getImageModelCapabilities(model, capabilities) : (capabilities || getCapabilities());
  const v = Number(caps[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export function getCapsList(key, model, capabilities){
  const caps = model ? getImageModelCapabilities(model, capabilities) : (capabilities || getCapabilities());
  const v = caps[key];
  return Array.isArray(v) ? v : [];
}

function uniqueStrings(values){
  return Array.from(new Set((values || []).flatMap(value=>{
    if(Array.isArray(value)) return value;
    if(value == null) return [];
    return String(value).split(',');
  }).map(value=>String(value || '').trim()).filter(Boolean)));
}

function catalogRows(data){
  if(!data) return [];
  if(Array.isArray(data.data)) return data.data;
  if(Array.isArray(data)) return data;
  return [];
}

function modelIdOf(value){
  if(typeof value === 'string') return value.trim();
  if(!value || typeof value !== 'object') return '';
  return String(value.id || value.name || value.model || '').trim();
}

// FutureAI publishes model-specific controls as param_spec instead of capabilities.
function paramSpecCapabilities(model){
  const rows = model?.param_spec?.params;
  if(!Array.isArray(rows)) return null;
  const byKey = Object.fromEntries(rows.map(row=>[row.key,row]));
  const values = row=>(row?.options || []).map(value=>typeof value === 'object' ? value.value : value).filter(Boolean);
  const caps = {};
  for(const [field,request] of Object.entries({quality:'quality',complexity:'complexity',outputFormat:'output_format',resolution:'resolution'})){
    caps[field] = !!byKey[request];
    if(byKey[request]) caps[field+'Options'] = values(byKey[request]);
  }
  if(byKey.prompt?.max_length) caps.promptMaxChars = byKey.prompt.max_length;
  const size = byKey.size;
  if(size){ caps.aspectRatios = size.ratios || []; caps.sizeModes = size.modes || ['ratio']; }
  const refs = rows.find(row=>row.widget === 'ref_images');
  if(refs){
    caps.maxReferences = refs.max_count;
    caps.maxRefFileBytes = refs.max_file_bytes;
    caps.maxRefFileMB = refs.max_file_bytes / 1048576;
    caps.maxRefTotalBytes = refs.max_total_bytes;
    caps.referenceMimeTypes = refs.allowed_mime_types;
  }
  return caps;
}

function normalizeModelMeta(raw, pricing){
  const model = typeof raw === 'string' ? { id:raw, name:raw } : (raw && typeof raw === 'object' ? raw : {});
  const price = pricing && typeof pricing === 'object' ? pricing : {};
  const id = modelIdOf(model) || modelIdOf(price);
  if(!id) return null;
  const tags = uniqueStrings([model.tags, model.capabilities, price.tags, price.capabilities]);
  const endpoints = uniqueStrings([model.endpoints, model.supported_endpoints, model.supportedEndpoints, price.endpoints, price.supported_endpoints]);
  const online = model.online !== false && price.online !== false;
  return {
    id,
    name: String(model.name || price.name || id),
    online,
    description: String(model.description || price.description || ''),
    provider: String(model.provider || price.provider || ''),
    tags,
    endpoints,
    mode: String(model.mode || price.mode || ''),
    contextLength: Number(model.context_length || model.contextLength || price.context_length || price.contextLength || 0) || 0,
    pricing: pricing ? { ...price } : null,
    capabilities: model.capabilities && !Array.isArray(model.capabilities) && typeof model.capabilities === 'object' ? model.capabilities : (price.capabilities && !Array.isArray(price.capabilities) && typeof price.capabilities === 'object' ? price.capabilities : null),
    paramSpec: model.param_spec || null,
    paramSpecCapabilities: paramSpecCapabilities(model),
    imageParams: model.imageParams || model.image_params || price.imageParams || null,
    source: { models: !!raw, pricing: !!pricing }
  };
}

function classifyModelMeta(meta){
  const id = String(meta && meta.id || '');
  const tags = (meta && meta.tags || []).map(value=>String(value).toLowerCase());
  const endpoints = (meta && meta.endpoints || []).map(value=>String(value).toLowerCase());
  const videoRe = /video|veo|seedance|sora|kling|hailuo|vidu|pika/i;
  const imageRe = /image|img|flux|firefly|banana|seedream|dall|midjourney|sdxl|imagen|kontext|runway|stable.?diff|cogview|kolors|ideogram|recraft|hunyuan-image|wanx|seedvr|upscale|super.?res/i;
  const chatRe = /gpt-5|gpt-4|claude|gemini|deepseek|qwen|llama|mistral|kimi|grok|o1|o3|o4|chat|mini|sol|luna|terra|codex/i;
  const video = tags.includes('video') || endpoints.includes('video') || videoRe.test(id);
  const image = !video && (tags.includes('image') || endpoints.includes('image') || imageRe.test(id));
  const chat = !video && !image && (tags.includes('chat') || endpoints.includes('responses') || chatRe.test(id));
  return { video, image, chat };
}

export function parseModelCatalog(modelData, pricingData){
  const pricingMap = new Map();
  catalogRows(pricingData).forEach(item=>{
    const id = modelIdOf(item);
    if(id) pricingMap.set(id, item);
  });
  const byId = {};
  const all = [];
  catalogRows(modelData).forEach(item=>{
    const id = modelIdOf(item);
    if(!id || byId[id]) return;
    const meta = normalizeModelMeta(item, pricingMap.get(id) || null);
    if(!meta) return;
    byId[id] = meta;
    all.push(meta);
  });
  const image = [], chat = [], video = [];
  all.forEach(meta=>{
    const kind = classifyModelMeta(meta);
    if(kind.video) video.push(meta.id);
    else if(kind.image) image.push(meta.id);
    else if(kind.chat) chat.push(meta.id);
  });
  return { all:all.map(meta=>meta.id), image, chat, video, byId };
}

export function getModelMetadata(model){
  const id = String(model || '').trim();
  return id && state && state.liveModelMeta ? (state.liveModelMeta[id] || null) : null;
}


export function getImageModelCapabilities(model, baseOverride){
  const id = String(model || getSelectedImageModel() || '').trim();
  const base = baseOverride && typeof baseOverride === 'object' ? baseOverride : (getCapabilities() || {});
  const merged = { ...base, imageParams:{ ...(base.imageParams || {}) } };
  const override = base.modelOverrides && id ? (base.modelOverrides[id] || {}) : {};
  Object.keys(override).forEach(key=>{
    if(key === 'qualityOptions' || key === 'resolutionOptions' || key === 'maxReferences') merged[key] = Array.isArray(override[key]) ? [...override[key]] : override[key];
    else if(['quality','n','mask','resolution','stream','size','background','outputFormat','responseFormat','seed','colorCorrection','resizeMethod','complexity'].includes(key)) merged.imageParams[key] = override[key];
    else merged[key] = override[key];
  });
  if(base.complexityModelPattern){
    try{ if(new RegExp(base.complexityModelPattern,'i').test(id)) merged.imageParams.complexity = true; }catch(e){}
  }
  const metadata = !baseOverride || baseOverride === getCapabilities() ? getModelMetadata(id) : null;
  if(base.fallbackPolicy === 'unknown-model-capability-do-not-send' && !base.modelOverrides?.[id] && !metadata?.capabilities && !metadata?.imageParams){
    for(const [key,value] of Object.entries(merged.imageParams)) if(value === 'model') merged.imageParams[key] = false;
  }
  const live = metadata || (merged.modelMetadata && typeof merged.modelMetadata === 'object' ? merged.modelMetadata : null);
  const liveCaps = live && live.capabilities && typeof live.capabilities === 'object' ? live.capabilities : (live && live.imageParams && typeof live.imageParams === 'object' ? live.imageParams : null);
  if(liveCaps){
    Object.keys(liveCaps).forEach(key=>{
      if(['qualityOptions','resolutionOptions','outputFormatOptions','backgroundOptions','responseFormatOptions','complexityOptions','maxReferences','maxPixels'].includes(key)) merged[key] = Array.isArray(liveCaps[key]) ? [...liveCaps[key]] : liveCaps[key];
      else if(['quality','n','mask','background','outputFormat','responseFormat','resolution','size','image','imageUrl','imageUrls','images','seed','colorCorrection','resizeMethod','complexity'].includes(key)) merged.imageParams[key] = liveCaps[key];
    });
  }
  if(base.protocol === 'futureai-image' && metadata?.paramSpecCapabilities){
    const imageKeys = ['quality','complexity','outputFormat','resolution'];
    for(const [key,value] of Object.entries(metadata.paramSpecCapabilities)){
      if(imageKeys.includes(key)) merged.imageParams[key] = value;
      else merged[key] = value;
    }
  }
  if(/^gpt-image-2\.6(?:$|-)/i.test(id)){
    const wasEnabled = merged.imageParams.outputFormat !== false && merged.imageParams.outputFormat !== 'unsupported';
    const options = Array.isArray(merged.outputFormatOptions) ? merged.outputFormatOptions : [];
    const declared = wasEnabled && options.includes('gif');
    merged.gifSupportStatus = declared ? (merged.gifSupportStatus === 'announced' ? 'announced' : 'reported') : (merged.gifSupportStatus || 'unverified');
    merged.gifUserSelectable = true;
    merged.imageParams.outputFormat = true;
    merged.outputFormatOptions = Array.from(new Set((wasEnabled ? options : []).concat('gif')));
  }
  if(metadata) merged.modelMetadata = metadata;
  merged.modelId = id;
  merged.capabilitySource = metadata && metadata.source ? metadata.source : { configured:true, live:false };
  return merged;
}

export function getSelectedImageModel(){ return el.model.value==='__custom__' ? el.customModel.value.trim() : el.model.value; }

export function getSelectedChatModel(){ return el.chatModel.value==='__custom__' ? el.chatCustomModel.value.trim() : el.chatModel.value; }

export function getSelectedVideoModel(){

  if(!el || !el.videoModel) return (state && state.videoModel) || VIDEO_MODELS[0];
  if(el.videoModel.value==='__custom__' && el.videoCustomModel) return el.videoCustomModel.value.trim();
  return el.videoModel.value || (state && state.videoModel) || VIDEO_MODELS[0];

}

export function getImageRatios(){ return imageRatios(getImageModelCapabilities()); }

export function getSizeVal(ratio, tier){ return ratio.v[tier || state.currentTier] || ''; }

export function setConn(text, type){

  el.connText.textContent = text;

  el.connDot.className = 'conn-dot' + (type==='ok'?' ok':type==='error'?' bad':type==='warn'?' warn':'');

}

/* 单价显示（API-12 / API-23）：/v1/pricing 的 per_request_micro 是“每次请求微美元”，/1e6 得美元。
   只有拿到实时 /v1/pricing 时才显示；预设兜底清单没有价格数据，保持纯模型名。*/
function trimMoney(value){
  let s = value >= 0.01 ? value.toFixed(3) : value.toFixed(4);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}
export function modelPriceOf(id){
  const meta = getModelMetadata(id);
  const p = meta && meta.pricing ? meta.pricing : null;
  if(!p) return null;
  const micro = Number(p.per_request_micro != null ? p.per_request_micro : (p.perRequestMicro != null ? p.perRequestMicro : 0));
  if(isFinite(micro) && micro > 0) return micro / 1000000;
  const unit = Number(p.price != null ? p.price : (p.unit_price != null ? p.unit_price : 0));
  if(isFinite(unit) && unit > 0) return unit;
  return null;
}
function modelRiskNote(id){
  // API-19：*-eco 在 65535 站实测上游不可达（重试后仍 failed）、且单价反而更高
  return ''; // Availability comes from the current provider, not a historical suffix-wide warning.
}
function pickDefaultModel(values){
  const list = values || [];
  const safe = list.filter(v=> !/-eco\d*$/i.test(String(v)));
  return (safe.length ? safe[0] : list[0]) || '';
}
function modelPriceNote(id){
  const v = modelPriceOf(id);
  return v == null ? '' : ' · $' + trimMoney(v) + '/张';
}
export function setOptions(select, models, selected){

  const values = Array.from(new Set((models||[]).filter(Boolean)));

  select.innerHTML = '';

  if(select===el.model || select===el.chatModel || select===el.videoModel) select.add(new Option('自定义模型名…', '__custom__'));

  values.forEach(m=>{
    const note = select===el.model ? (modelPriceNote(m) + modelRiskNote(m)) : '';
    const opt = new Option(m + note, m);
    if(note) opt.title = '单价来自 /v1/pricing 实时数据（per_request_micro）';
    select.add(opt);
  });

  if(selected && Array.from(select.options).some(o=>o.value===selected)) select.value = selected;

  else if(values.length) select.value = select===el.model ? pickDefaultModel(values) : values[0];

}

export function syncPresetModels(preserve){

  const preset = getPreset();
  const oldImage = preserve || getSelectedImageModel();
  const oldChat = el.chatModel.value==='__custom__' ? el.chatCustomModel.value.trim() : el.chatModel.value;
  const oldVideo = getSelectedVideoModel();

  setOptions(el.model, state.liveModels.img.length ? state.liveModels.img : (preset.models?.image || []), oldImage);
  setOptions(el.chatModel, state.liveModels.chat.length ? state.liveModels.chat : (preset.models?.chat || []), oldChat);
  const videoModels = state.liveModels.video && state.liveModels.video.length ? state.liveModels.video : getVideoModelsForPreset(el.providerPreset.value);
  if(el.videoModel){
    setOptions(el.videoModel, videoModels, oldVideo);
    if(el.videoCustomModel) keepCustomModel(el.videoModel, el.videoCustomModel, oldVideo);
    state.videoModel = getSelectedVideoModel();
  }else state.videoModel = oldVideo || videoModels[0] || VIDEO_MODELS[0];

  const custom = oldImage && !Array.from(el.model.options).some(o=>o.value===oldImage);
  if(custom && preset.capabilities?.customModel){ el.model.value = '__custom__'; el.customModel.value = oldImage; }
  const customChat = oldChat && !Array.from(el.chatModel.options).some(o=>o.value===oldChat);
  if(customChat && preset.capabilities?.customModel){ el.chatModel.value = '__custom__'; el.chatCustomModel.value = oldChat; }
  if(el.customModel) el.customModel.style.display = el.model.value==='__custom__' ? '' : 'none';
  if(el.chatCustomModel) el.chatCustomModel.style.display = el.chatModel.value==='__custom__' ? '' : 'none';
  if(el.videoModel && el.videoCustomModel) el.videoCustomModel.style.display = el.videoModel.value==='__custom__' ? '' : 'none';
  syncQuickRow();

}

export function syncGifHint(){
  const node = document.getElementById('modelCapabilityHint');
  if(!node) return;
  const caps = getImageModelCapabilities();
  if(el.format && el.format.value === 'gif' && caps.gifUserSelectable){
    node.textContent = caps.gifSupportStatus === 'unverified'
      ? '当前所选模型可能尚未支持 GIF；若供应商已开放，将按实际返回格式保存。'
      : '已选择 GIF；动图与实际文件格式以供应商返图为准。';
  }else{
    node.textContent = caps.capabilityNote || '功能以当前供应商、具体型号和账户权限为准';
  }
}

export function syncImageParamOptions(){

  if(!el.quality) return;

  const model = getSelectedImageModel();
  const base = getCapabilities() || {};
  const caps = getImageModelCapabilities(model, base);
  const params = caps.imageParams || {};
  const setSection = (select, enabled)=>{
    const section = select && select.closest('.d-sec');
    if(section) section.style.display = enabled ? '' : 'none';
    if(select) select.disabled = !enabled;
  };
  const fill = (select, key, labels, enabled=true)=>{
    const cur = select.value;
    const opts = getCapsList(key, model, base);
    if(!enabled || !opts.length){
      setSection(select, false);
      if(select) select.value = '';
      return;
    }
    setSection(select, true);
    select.innerHTML = '';
    select.add(new Option('不指定（跟随模型默认）', ''));
    opts.forEach(v=> select.add(new Option((labels && labels[v]) ? (v + ' ' + labels[v]) : v, v)));
    select.value = Array.from(select.options).some(o=> o.value===cur) ? cur : '';
  };

  const qualityEnabled = params.quality !== false && params.quality !== 'unsupported';
  fill(el.quality, 'qualityOptions', { auto:'自动', low:'低', medium:'中', high:'高', xhigh:'超高', max:'最高' }, qualityEnabled);
  if(el.complexity) fill(el.complexity, 'complexityOptions', {low:'低',medium:'中',high:'高'}, params.complexity === true);
  fill(el.background, 'backgroundOptions', { auto:'自动', transparent:'透明', opaque:'不透明' }, params.background !== false);
  fill(el.format, 'outputFormatOptions', { png:'PNG', jpeg:'JPEG', webp:'WebP', gif:'GIF 动图' }, params.outputFormat !== false);
  fill(el.responseFormat, 'responseFormatOptions', { url:'外链地址', b64_json:'内联 base64' }, params.responseFormat !== false);
  const streamSection = el.streamMode && el.streamMode.closest('.d-sec');
  const streamEnabled = caps.streamCapable === true && state.currentMode !== 'img2img';
  if(streamSection) streamSection.style.display = streamEnabled ? '' : 'none';
  if(el.streamMode){ el.streamMode.disabled = !streamEnabled; if(!streamEnabled) el.streamMode.value = ''; }

  const countSection = el.count && el.count.closest('.d-sec');
  const nEnabled = params.n !== false && params.n !== 'unsupported';
  if(countSection) countSection.style.display = '';
  if(el.count){
    el.count.disabled = false;
    const countHint = el.countHint;
    if(countHint) countHint.textContent = '每张独立任务';
  }

  const resolutionSection = el.imageResolution && el.imageResolution.closest('.d-sec');
  const resolutionOptions = getCapsList('resolutionOptions', model, base);
  const nativeResolutionEnabled = params.resolution !== false && params.resolution !== 'unsupported' && resolutionOptions.length > 0 && (caps.native4K !== false || resolutionOptions.some(v=> String(v).toLowerCase() !== '4k'));
  if(resolutionSection) resolutionSection.style.display = nativeResolutionEnabled && caps.imageSizePolicy !== 'futureai-ratio' ? '' : 'none';
  if(el.imageResolution){
    el.imageResolution.disabled = !nativeResolutionEnabled;
    if(nativeResolutionEnabled){
      const current = el.imageResolution.value;
      el.imageResolution.innerHTML = '';
      resolutionOptions.forEach(v=> el.imageResolution.add(new Option(String(v).toUpperCase(), v)));
      const desired = caps.imageSizePolicy === 'futureai-ratio' ? String(state.currentTier || current).toUpperCase() : current;
      el.imageResolution.value = resolutionOptions.includes(desired) ? desired : (caps.defaultResolution || resolutionOptions[0]);
      state.currentResolution = el.imageResolution.value || '';
    }else{
      el.imageResolution.value = '';
      state.currentResolution = '';
    }
  }

  /* 选项按模型/供应商能力重建后，select 可能被重置或整块隐藏；
     生成时读取的是 state.current*，必须与界面显示保持一致，否则会出现「界面不指定、实际仍发送旧值」 */
  state.currentQuality = el.quality.value || '';
  state.currentComplexity = el.complexity && !el.complexity.disabled ? (el.complexity.value || '') : '';
  state.currentBg = el.background ? (el.background.value || '') : '';
  state.currentFmt = el.format ? (el.format.value || '') : '';

  /* 供应商不支持负面提示词时明确提示：输入框可见但内容不会发送 */
  const negHint = document.getElementById('negativeHint');
  if(negHint) negHint.style.display = caps.negativePrompt === false ? '' : 'none';
  syncGifHint();
  if(caps.imageSizePolicy === 'futureai-ratio'){
    if(state.hooks?.renderTierTabs) state.hooks.renderTierTabs();
    if(state.hooks?.renderSizes) state.hooks.renderSizes();
  }
  document.dispatchEvent(new Event('canvas-mode-change'));
}

export function applyPreset(updateBase){

  const preset = getPreset();
  const changedProvider = state.appliedProviderPreset !== el.providerPreset.value;
  state.appliedProviderPreset = el.providerPreset.value;
  if(changedProvider){
    state.liveModels = { img:[], chat:[], video:[] };
    state.liveModelMeta = {};
    state.modelCatalog = { all:[], image:[], chat:[], video:[], byId:{} };
    state.modelCatalogFetchedAt = 0;
    state.modelCatalogError = '';
  }

  if(updateBase){

    // 预设未提供 Base URL（如通用兼容预设）时清空，避免切换预设残留上一个供应商地址

    el.apiBase.value = preset.baseUrl || '';

    state.liveModels = { img: [], chat: [], video: [] };
    state.liveModelMeta = {};
    state.modelCatalog = { all: [], image: [], chat: [], video: [], byId: {} };
    state.modelCatalogFetchedAt = 0;
    state.modelCatalogError = '';

  }

  syncPresetModels();

  syncImageParamOptions();
  if(state.hooks?.renderTierTabs) state.hooks.renderTierTabs();
  if(state.hooks?.renderSizes) state.hooks.renderSizes();
  if(state.hooks?.renderBatchChips) state.hooks.renderBatchChips();

  setConn('未验证 · ' + preset.label, '');

  refreshUsage();

  if(updateBase) maybeRefreshLiveModels(true);

}

export async function loadProviderConfig(){

  try{

    const res = await fetch('图片生成供应商能力.json', { cache:'no-store' });

    if(!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();

    if(!data || !data.presets || !data.defaultPreset) throw new Error('配置格式无效');

    state.providerConfig = data;

    state.cfgSource = '外部配置 JSON';

  }catch(e){ setConn('使用内置通用兼容规则', 'warn'); state.cfgSource = '内置回退配置'; }

  const cfgHint = $('cfgSourceHint');

  const defaultPreset = state.providerConfig.presets[state.providerConfig.defaultPreset] || {};
  const modelEndpoint = defaultPreset.capabilities?.modelListEndpoint || '/models';
  if(cfgHint) cfgHint.textContent = '配置来源：' + state.cfgSource + '（能力参数）· 模型以当前站点 ' + modelEndpoint + ' 为准';

  const saved = lsGet(LS_KEY, {});

  const presetKeys = Object.keys(state.providerConfig.presets || {});

  presetKeys.forEach(k=> el.providerPreset.add(new Option(state.providerConfig.presets[k].label, k)));

  el.providerPreset.value = state.providerConfig.presets[saved.preset] ? saved.preset : state.providerConfig.defaultPreset;

  applyPreset(!saved.base);

  if(saved.base) el.apiBase.value = saved.base;

}

export function loadCfg(){

  const c = lsGet(LS_KEY, {});

  if(c.key) el.apiKey.value = c.key;

  if(c.chatKey) el.chatKey.value = c.chatKey;

  el.rememberKey.checked = !!(c.key || c.chatKey);

  if(c.chatBase) el.chatBase.value = c.chatBase;

  if(c.proxyToken) el.proxyToken.value = c.proxyToken;
  if(c.videoModel) state.videoModel = String(c.videoModel);
  if(c.videoMode) state.videoMode = String(c.videoMode);
  if(c.videoSeconds) state.videoSeconds = String(c.videoSeconds);
  if(c.videoAspectRatio) state.videoAspectRatio = String(c.videoAspectRatio);
  if(c.videoResolution) state.videoResolution = String(c.videoResolution);

  if(c.model){

    if(Array.from(el.model.options).some(o=>o.value===c.model)) el.model.value = c.model;

    else { el.model.value = '__custom__'; el.customModel.value = c.model; }

  }

  if(c.chatModel){

    if(Array.from(el.chatModel.options).some(o=>o.value===c.chatModel)) el.chatModel.value = c.chatModel;

    else { el.chatModel.value = '__custom__'; el.chatCustomModel.value = c.chatModel; }

  }

  el.customModel.style.display = el.model.value==='__custom__' ? '' : 'none';

  el.chatCustomModel.style.display = el.chatModel.value==='__custom__' ? '' : 'none';

  syncQuickRow(); // 恢复配置后刷新状态摘要

  refreshUsage();

}

export function saveCfg(){

  const cfg = { preset: el.providerPreset.value, base: el.apiBase.value.trim(), model: getSelectedImageModel(), chatModel: getSelectedChatModel(), videoModel: getSelectedVideoModel(), videoMode: state.videoMode || 'txt2video', videoSeconds: state.videoSeconds || '6', videoAspectRatio: state.videoAspectRatio || '16:9', videoResolution: state.videoResolution || '720P', chatBase: el.chatBase.value.trim(), proxyToken: el.proxyToken.value.trim() };

  if(el.rememberKey.checked && el.apiKey.value.trim()) cfg.key = el.apiKey.value.trim(); else cfg.key = '';

  if(el.rememberKey.checked && el.chatKey.value.trim()) cfg.chatKey = el.chatKey.value.trim(); else cfg.chatKey = '';

  if(lsSet(LS_KEY, cfg)) toast(el.rememberKey.checked ? '✅ 配置已保存（仅本机）' : '✅ 配置已保存（Key 未存储）', 'ok');

  else toast('⚠️ 本地存储空间不足，配置保存失败', 'err');

}

function readApiProfileStore(){
  const raw = lsGet(LS_API_PROFILES, {});
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.profiles) ? raw.profiles : []);
  const profiles = list.filter(p=> p && typeof p.id==='string' && typeof p.name==='string' && p.name.trim()).map(p=> ({
    id: p.id,
    name: p.name.trim(),
    preset: p.preset || '',
    base: p.base || '',
    model: p.model || '',
    chatModel: p.chatModel || '',
    chatBase: p.chatBase || '',
    proxyToken: p.proxyToken || '',
    rememberKey: !!p.rememberKey,
    key: p.rememberKey ? (p.key || '') : '',
    chatKey: p.rememberKey ? (p.chatKey || '') : ''
  }));
  const activeId = raw && !Array.isArray(raw) && typeof raw.activeId==='string' ? raw.activeId : '';
  return { version:1, activeId, profiles };
}

function writeApiProfileStore(){
  return lsSet(LS_API_PROFILES, {
    version:1,
    activeId: state.apiProfileActiveId || '',
    profiles: state.apiProfiles || []
  });
}

function hasLegacyApiConfig(c){
  return !!(c && (c.preset || c.base || c.model || c.chatModel || c.chatBase || c.proxyToken || c.key || c.chatKey));
}

function legacyProfile(c){
  return {
    id:'profile_default',
    name:'默认配置',
    preset:c.preset || state.providerConfig.defaultPreset || '',
    base:c.base || '',
    model:c.model || '',
    chatModel:c.chatModel || '',
    chatBase:c.chatBase || '',
    proxyToken:c.proxyToken || '',
    rememberKey:!!(c.key || c.chatKey),
    key:c.key || '',
    chatKey:c.chatKey || ''
  };
}

function makeApiProfile(name){
  const remember = !!el.rememberKey.checked;
  return {
    id:'profile_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name:name.trim(),
    preset:el.providerPreset.value,
    base:el.apiBase.value.trim(),
    model:getSelectedImageModel(),
    chatModel:getSelectedChatModel(),
    chatBase:el.chatBase.value.trim(),
    proxyToken:el.proxyToken.value.trim(),
    rememberKey:remember,
    key:remember ? el.apiKey.value.trim() : '',
    chatKey:remember ? el.chatKey.value.trim() : ''
  };
}

function setModelField(select, customInput, value){
  if(value && Array.from(select.options).some(o=>o.value===value)){
    select.value = value;
  }else if(value){
    select.value = '__custom__';
    customInput.value = value;
  }else if(select.options.length > 1){
    select.value = select.options[1].value;
    customInput.value = '';
  }
  customInput.style.display = select.value==='__custom__' ? '' : 'none';
}

export function renderApiProfiles(){
  if(!el.apiProfileSelect) return;
  const current = state.apiProfileActiveId || '';
  el.apiProfileSelect.innerHTML = '';
  el.apiProfileSelect.add(new Option('当前临时配置', ''));
  (state.apiProfiles || []).forEach(p=> el.apiProfileSelect.add(new Option(p.name, p.id)));
  el.apiProfileSelect.value = (state.apiProfiles || []).some(p=>p.id===current) ? current : '';
  if(el.apiProfileOverwrite) el.apiProfileOverwrite.disabled = !el.apiProfileSelect.value;
  if(el.apiProfileDelete) el.apiProfileDelete.disabled = !el.apiProfileSelect.value;
}

export function applyApiProfile(id, silent){
  if(!id){
    state.apiProfileActiveId = '';
    writeApiProfileStore();
    renderApiProfiles();
    if(!silent) toast('已切换到当前临时配置', 'ok');
    return false;
  }
  const profile = (state.apiProfiles || []).find(p=> p.id===id);
  if(!profile){
    renderApiProfiles();
    if(!silent) toast('配置档案不存在', 'err');
    return false;
  }
  const presetKey = state.providerConfig.presets[profile.preset] ? profile.preset : state.providerConfig.defaultPreset;
  el.providerPreset.value = presetKey;
  state.liveModels = { img:[], chat:[], video:[] };
  state.liveModelMeta = {};
  state.modelCatalog = { all:[], image:[], chat:[], video:[], byId:{} };
  applyPreset(false);
  const preset = getPreset();
  el.apiBase.value = profile.base || preset.baseUrl || '';
  el.chatBase.value = profile.chatBase || '';
  el.proxyToken.value = profile.proxyToken || '';
  el.rememberKey.checked = !!profile.rememberKey;
  el.apiKey.value = profile.rememberKey ? (profile.key || '') : '';
  el.chatKey.value = profile.rememberKey ? (profile.chatKey || '') : '';
  setModelField(el.model, el.customModel, profile.model || '');
  setModelField(el.chatModel, el.chatCustomModel, profile.chatModel || '');
  syncImageParamOptions();
  refreshUsage();
  state.apiProfileActiveId = profile.id;
  writeApiProfileStore();
  renderApiProfiles();
  syncQuickRow();
  if(!silent) toast('✅ 已切换配置：' + profile.name + '（未自动拉取模型）', 'ok');
  return true;
}

export function loadApiProfiles(){
  const store = readApiProfileStore();
  let profiles = store.profiles;
  let activeId = store.activeId;
  if(!profiles.length){
    const legacy = lsGet(LS_KEY, {});
    if(hasLegacyApiConfig(legacy)){
      const migrated = legacyProfile(legacy);
      profiles = [migrated];
      activeId = migrated.id;
    }
  }
  state.apiProfiles = profiles;
  state.apiProfileActiveId = profiles.some(p=>p.id===activeId) ? activeId : '';
  writeApiProfileStore();
  renderApiProfiles();
  if(state.apiProfileActiveId) applyApiProfile(state.apiProfileActiveId, true);
  return state.apiProfiles;
}

export function saveApiProfile(){
  const name = window.prompt('请输入配置档案名称', '站点配置 ' + ((state.apiProfiles || []).length + 1));
  if(name===null) return false;
  const clean = name.trim();
  if(!clean){ toast('配置名称不能为空', 'err'); return false; }
  if((state.apiProfiles || []).some(p=>p.name===clean)){ toast('已有同名配置，请换一个名称', 'err'); return false; }
  const profile = makeApiProfile(clean);
  state.apiProfiles = (state.apiProfiles || []).concat(profile);
  state.apiProfileActiveId = profile.id;
  if(!writeApiProfileStore()){
    state.apiProfiles = state.apiProfiles.filter(p=>p.id!==profile.id);
    state.apiProfileActiveId = '';
    renderApiProfiles();
    toast('⚠️ 本地存储空间不足，配置档案保存失败', 'err');
    return false;
  }
  renderApiProfiles();
  toast('✅ 已保存配置档案：' + clean, 'ok');
  return true;
}

export function overwriteApiProfile(){
  const id = el.apiProfileSelect && el.apiProfileSelect.value;
  const profile = (state.apiProfiles || []).find(p=>p.id===id);
  if(!profile){ toast('请先选择要覆盖的配置档案', 'err'); return false; }
  if(!window.confirm('用当前设置覆盖「' + profile.name + '」？')) return false;
  const next = makeApiProfile(profile.name);
  next.id = profile.id;
  state.apiProfiles = state.apiProfiles.map(p=>p.id===profile.id ? next : p);
  state.apiProfileActiveId = next.id;
  if(!writeApiProfileStore()){ toast('⚠️ 本地存储空间不足，覆盖失败', 'err'); return false; }
  renderApiProfiles();
  toast('✅ 已覆盖配置档案：' + profile.name, 'ok');
  return true;
}

export function deleteApiProfile(){
  const id = el.apiProfileSelect && el.apiProfileSelect.value;
  const profile = (state.apiProfiles || []).find(p=>p.id===id);
  if(!profile){ toast('请先选择要删除的配置档案', 'err'); return false; }
  if(!window.confirm('删除配置档案「' + profile.name + '」？')) return false;
  state.apiProfiles = state.apiProfiles.filter(p=>p.id!==id);
  if(state.apiProfileActiveId===id) state.apiProfileActiveId = '';
  if(!writeApiProfileStore()){ toast('⚠️ 本地存储空间不足，删除状态未保存', 'err'); return false; }
  renderApiProfiles();
  toast('已删除配置档案：' + profile.name, 'ok');
  return true;
}

export function syncPrivateProxyHint(){

  if(!el.privateProxyHint) return;

  if(!state.proxyStatus.known){

    el.privateProxyHint.textContent = '本机/局域网 API：服务器状态暂时无法读取；请求时将由服务器按自身配置判定。';

  }else if(state.proxyStatus.allowPrivate){

    el.privateProxyHint.textContent = '本机/局域网 API：代理私网访问已开启，可直接使用本机或局域网 Base URL。';

  }else{

    el.privateProxyHint.textContent = '本机/局域网 API：当前服务器未开启。请用 ALLOW_PRIVATE=1 python 生图服务器.py 重启后，再点下方刷新。';

  }

}

export async function loadProxyStatus(){

  try{

    const res = await fetch('/api/proxy-status', { cache:'no-store' });

    if(!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();

    state.proxyStatus = { known:true, allowPrivate:!!data.allowPrivate };

  }catch(e){

    state.proxyStatus = { known:false, allowPrivate:false };

  }

  syncPrivateProxyHint();

  return state.proxyStatus;

}

export function parseModelList(data){
  return parseModelCatalog(data, null).all;
}

export function classifyModels(list, metadata){
  const video = [], image = [], chat = [];
  (list || []).map(value=>String(value || '').trim()).filter(Boolean).forEach(id=>{
    const meta = metadata && metadata[id] ? metadata[id] : { id, tags:[], endpoints:[] };
    const kind = classifyModelMeta(meta);
    if(kind.video) video.push(id);
    else if(kind.image) image.push(id);
    else if(kind.chat) chat.push(id);
  });
  return { video, image, chat };
}

export function keepCustomModel(select, customInput, oldVal){

  if(oldVal && !Array.from(select.options).some(o=> o.value===oldVal) && getCapabilities().customModel !== false){

    select.value = '__custom__';

    customInput.value = oldVal;

  }

  customInput.style.display = select.value==='__custom__' ? '' : 'none';

}

export function applyLiveModels(which, list, metadata){
  const values = Array.from(new Set((list || []).map(value=>String(value || '').trim()).filter(Boolean)));
  const modelMeta = metadata && typeof metadata === 'object' ? metadata : (state.liveModelMeta || {});
  if(which !== 'chat') state.liveModelMeta = { ...modelMeta };
  const classified = classifyModels(values, state.liveModelMeta);
  const nonVideo = values.filter(id=> classified.video.indexOf(id) < 0);
  if(which === 'img' || which === 'both'){
    const oldImage = getSelectedImageModel();
    state.liveModels.img = classified.image.length ? classified.image : nonVideo.slice();
    setOptions(el.model, state.liveModels.img, oldImage);
    keepCustomModel(el.model, el.customModel, oldImage);
    const oldVideo = getSelectedVideoModel();
    state.liveModels.video = Array.from(new Set(getVideoModelsForPreset(el.providerPreset.value).concat(classified.video)));
    if(el.videoModel){ setOptions(el.videoModel, state.liveModels.video, oldVideo); if(el.videoCustomModel) keepCustomModel(el.videoModel, el.videoCustomModel, oldVideo); state.videoModel = getSelectedVideoModel(); }
    else state.videoModel = oldVideo || state.liveModels.video[0] || VIDEO_MODELS[0];
  }
  if(which === 'chat' || which === 'both'){
    const oldChat = getSelectedChatModel();
    state.liveModels.chat = classified.chat.length ? classified.chat : nonVideo.slice();
    setOptions(el.chatModel, state.liveModels.chat, oldChat);
    keepCustomModel(el.chatModel, el.chatCustomModel, oldChat);
  }
  if(which === 'img' || which === 'both'){ syncImageParamOptions(); if(state.hooks?.renderTierTabs) state.hooks.renderTierTabs(); if(state.hooks?.renderSizes) state.hooks.renderSizes(); }
  syncQuickRow();
}

export async function fetchLiveModels(which){
  const key = which==='chat' ? (el.chatKey.value.trim() || el.apiKey.value.trim()) : el.apiKey.value.trim();
  const base = (which==='chat' ? (el.chatBase.value.trim() || el.apiBase.value.trim()) : el.apiBase.value.trim()).replace(/\/+$/,'');
  if(!key || !base) return { ok:false, reason:'missing' };
  if(localApiProxyHint(base)) return { ok:false, reason:'private' };
  const caps = getCapabilities() || {};
  const modelPath = caps.modelListEndpoint || state.providerConfig.fallback?.modelListEndpoint || '/models';
  const pricingPath = caps.pricingEndpoint || '';
  try{
    const res = await fetchWithTimeout(base + joinApiPath(base, modelPath), { headers:{ 'Authorization':'Bearer '+key } }, REQUEST_TIMEOUTS.modelCheck);
    if(res.status===401 || res.status===403) return { ok:false, reason:'auth' };
    if(res.status===404) return { ok:false, reason:'no-list' };
    if(!res.ok) return { ok:false, reason:'http', status:res.status };
    const modelData = await res.json();
    let pricingData = null;
    let pricingError = '';
    if(pricingPath){
      try{
        const pricingRes = await fetchWithTimeout(base + joinApiPath(base, pricingPath), { headers:{ 'Authorization':'Bearer '+key } }, REQUEST_TIMEOUTS.modelCheck);
        if(pricingRes.ok) pricingData = await pricingRes.json();
        else pricingError = 'HTTP ' + pricingRes.status;
      }catch(err){
        pricingError = err && err.message ? err.message : String(err);
      }
    }
    const currentBase = (which==='chat' ? (el.chatBase.value.trim() || el.apiBase.value.trim()) : el.apiBase.value.trim()).replace(/\/+$/,'');
    const currentKey = which==='chat' ? (el.chatKey.value.trim() || el.apiKey.value.trim()) : el.apiKey.value.trim();
    if(base !== currentBase || key !== currentKey) return { ok:false, reason:'stale' };
    const catalog = parseModelCatalog(modelData, pricingData);
    if(!catalog.all.length) return { ok:false, reason:'empty' };
    state.modelCatalog = catalog;
    state.modelCatalogFetchedAt = Date.now();
    state.modelCatalogError = pricingError;
    applyLiveModels(which, catalog.all, catalog.byId);
    return { ok:true, list:catalog.all, metadata:catalog.byId, catalog, pricingConfigured:!!pricingPath, pricingOk:!pricingPath || !!pricingData, pricingError };
  }catch(e){
    return { ok:false, reason:'error', message:e.message };
  }
}

/* API-16：用量/模型/定价路径依赖“Base 是否已含 /v1”。
   65535 的 base 是 https://task-api-1-cn.65535.space（不带 /v1）+ \/v1/usage 正常；
   但若用户把 base 填成 .../v1，就会拼出 .../v1/v1/usage。这里去重。*/
function joinApiPath(base, path){
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '');
  if(!p) return '';
  if(/\/v1$/i.test(b) && /^\/v1\//i.test(p)) return p.replace(/^\/v1/i, '');
  return p;
}
function resolveUsagePath(caps, base){
  if(caps && caps.usageEndpoint) return caps.usageEndpoint;
  try{
    const host = new URL(base).hostname.toLowerCase();
    if(host === '65535.space' || host.endsWith('.65535.space')) return '/v1/usage';
  }catch(e){}
  return '';
}

export async function fetchUsage(){
  const key = el.apiKey.value.trim();
  const base = el.apiBase.value.trim().replace(/\/+$/,'');
  const caps = getCapabilities() || {};
  const usagePath = resolveUsagePath(caps, base);
  if(!usagePath) return { ok:false, reason:'no-usage' };
  if(!key || !base) return { ok:false, reason:'missing' };
  if(localApiProxyHint(base)) return { ok:false, reason:'private' };
  try{
    const res = await fetchWithTimeout(base + joinApiPath(base, usagePath), { headers:{ 'Authorization':'Bearer '+key } }, REQUEST_TIMEOUTS.modelCheck);
    if(res.status===401 || res.status===403) return { ok:false, reason:'auth' };
    if(res.status===404) return { ok:false, reason:'no-usage' };
    if(!res.ok) return { ok:false, reason:'http', status:res.status };
    const data = await res.json();
    return { ok:true, data };
  }catch(e){
    return { ok:false, reason:'error', message:e.message };
  }
}

function pickUsageBalance(data){
  if(!data || typeof data!=='object') return null;
  const keys = ['balance','remaining','remain','left','available','quota_remaining','credit','credits'];
  for(const k of keys){
    const v = data[k];
    if(typeof v==='number' && isFinite(v)) return v;
    if(typeof v==='string' && v.trim()!=='' && isFinite(Number(v))) return Number(v);
  }
  return null;
}

function setUsageText(text){
  if(!el.usageText) return;
  el.usageText.textContent = text;
}

export async function refreshConcurrency(){
  const node = document.getElementById('concurrencyHint');
  if(!node) return;
  try{
    const headers = el.proxyToken && el.proxyToken.value.trim() ? { 'X-Proxy-Token':el.proxyToken.value.trim() } : {};
    const data = await fetchWithTimeout('/api/task-capabilities', {headers}, 10000, null, r=>r.json());
    if(data.ok){
      state.taskApi.maxConcurrent = Number(data.maxConcurrent) || 0;
      node.textContent = '本地并发 ' + data.maxConcurrent + ' · 运行 ' + data.active + ' · 排队 ' + data.queued + '；供应商账户并发：未提供可核实数值';
    }
  }catch(e){ node.textContent = '本地并发状态暂不可用；供应商账户并发：未核实'; }
}

export async function refreshUsage(){
  if(!el.usageLine) return { ok:false, reason:'no-ui' };
  const caps = getCapabilities() || {};
  const base = el.apiBase.value.trim().replace(/\/+$/,'');
  if(!resolveUsagePath(caps, base)){ el.usageLine.style.display = 'none'; return { ok:false, reason:'no-usage' }; }
  el.usageLine.style.display = 'flex';
  const key = el.apiKey.value.trim();
  if(!key || !base){ setUsageText('余额：未配置 Key/Base'); return { ok:false, reason:'missing' }; }
  setUsageText('余额：查询中…');
  const result = await fetchUsage();
  if(result.ok){
    const bal = pickUsageBalance(result.data);
    setUsageText(bal===null ? '余额：已响应（未识别字段）' : '余额：' + (Math.round(bal*1e6)/1e6));
    if(el.usageText) el.usageText.title = '更新于 ' + new Date().toLocaleTimeString();
  }else{
    const msg = { auth:'Key无效或未授权', 'no-usage':'该站点未提供用量接口', private:'需开启私网代理', missing:'未配置 Key/Base', http:'HTTP ' + (result.status||'错误') }[result.reason] || (result.message || '查询失败');
    setUsageText('余额：' + msg);
  }
  return result;
}

export async function maybeRefreshLiveModels(silent){

  const imgBase = el.apiBase.value.trim().replace(/\/+$/,'');

  const chatBase = (el.chatBase.value.trim() || el.apiBase.value.trim()).replace(/\/+$/,'');

  const imgKey = el.apiKey.value.trim();

  const chatKey = el.chatKey.value.trim() || imgKey;

  let imgRes = { ok:false };

  if(imgKey && imgBase) imgRes = await fetchLiveModels('img');

  if(chatKey && chatBase){

    if(chatBase === imgBase && imgRes.ok) applyLiveModels('both', imgRes.list);

    else await fetchLiveModels('chat');

  }

  if(imgRes.ok) setConn('已连接 · ' + imgRes.list.length + ' 个模型', 'ok');

  if(!silent){

    if(imgRes.ok) toast('✅ 已从当前站点拉取 ' + imgRes.list.length + ' 个模型', 'ok');

    else if(!imgKey || !imgBase) toast('请先填写生图 Key 和 Base URL', 'err');

    else toast('⚠️ 未能拉取站点模型，已保留当前/兜底列表', 'err');

  }

  return imgRes;

}

export function bindLiveModelRefresh(){

  let timer = null;

  const kick = ()=>{

    clearTimeout(timer);

    timer = setTimeout(()=> maybeRefreshLiveModels(true), 400);

  };

  ['apiBase','apiKey','chatBase','chatKey'].forEach(id=>{

    const node = el[id];

    if(!node) return;

    node.addEventListener('change', kick);

    node.addEventListener('blur', kick);

  });

  if(el.btnRefreshModels){

    el.btnRefreshModels.onclick = async ()=>{

      const old = (el.btnRefreshModels.querySelector('.lbl')||el.btnRefreshModels).textContent;

      el.btnRefreshModels.disabled = true;

      (el.btnRefreshModels.querySelector('.lbl')||el.btnRefreshModels).textContent = '拉取中…';

      await maybeRefreshLiveModels(false);

      el.btnRefreshModels.disabled = false;

      (el.btnRefreshModels.querySelector('.lbl')||el.btnRefreshModels).textContent = old;

    };

  }

}

export function bindUsageRefresh(){
  const concurrencyButton = document.getElementById('btnConcurrencyRefresh');
  if(concurrencyButton) concurrencyButton.onclick = ()=> refreshConcurrency();
  void refreshConcurrency();
  if(el.btnUsageRefresh){
    el.btnUsageRefresh.onclick = async ()=>{
      el.btnUsageRefresh.disabled = true;
      try{ await refreshUsage(); } finally { el.btnUsageRefresh.disabled = false; }
    };
  }
  let usageTimer = null;
  const kick = ()=>{ clearTimeout(usageTimer); usageTimer = setTimeout(()=> refreshUsage(),500); };
  ['apiBase','apiKey'].forEach(id=>{
    const node = el[id];
    if(!node) return;
    node.addEventListener('change', kick);
    node.addEventListener('blur', kick);
  });
}

export function runCheck(which){
  return async ()=>{
    const key = which==='chat' ? (el.chatKey.value.trim() || el.apiKey.value.trim()) : el.apiKey.value.trim();
    const base = (which==='chat' ? (el.chatBase.value.trim() || el.apiBase.value.trim()) : el.apiBase.value.trim()).replace(/\/+$/,'');
    const box = which==='chat' ? el.chatApiCheckResult : el.apiCheckResult;
    if(!key){ toast('请先填写 API Key 再校验', 'err'); return; }
    if(!base){ toast('请先填写 Base URL', 'err'); return; }
    const btn = which==='chat' ? el.btnCheckChatApi : el.btnCheckApi;
    const old = (btn.querySelector('.lbl')||btn).textContent;
    btn.disabled = true;
    (btn.querySelector('.lbl')||btn).textContent = '校验中…';
    box.style.display = 'block';
    box.innerHTML = '正在读取模型与能力目录…';
    const localHint = localApiProxyHint(base);
    if(localHint){
      box.innerHTML = '<span class="warn">⚠️ ' + escapeHtml(localHint) + '</span>';
      setConn('本机/局域网 API 需开启代理私网访问', 'warn');
      toast('⚠️ ' + localHint, 'err');
      btn.disabled = false;
      (btn.querySelector('.lbl')||btn).textContent = old;
      return;
    }
    try{
      const result = await fetchLiveModels(which);
      if(!result.ok){
        const reasonText = { auth:'认证失败，请检查 API Key。', 'no-list':'接口未提供模型列表。', empty:'模型列表为空。', private:'当前服务器未允许访问该地址。', missing:'缺少 API Key 或 Base URL。' }[result.reason] || result.message || ('HTTP ' + (result.status || '请求失败'));
        throw new Error(reasonText);
      }
      const selected = which==='chat' ? getSelectedChatModel() : getSelectedImageModel();
      const hit = selected && result.list.indexOf(selected) > -1;
      const metadataCount = Object.keys(result.metadata || {}).length;
      const pricingNote = result.pricingConfigured && !result.pricingOk ? '价格/能力目录读取失败，已使用模型列表安全回退。' : '';
      const prefix = which==='chat' ? '提示词分组' : '生图分组';
      box.innerHTML = '<span class="ok">✅ ' + prefix + '连接成功，已写入下拉 ' + result.list.length + ' 个模型，读取 ' + metadataCount + ' 条能力元数据。' + pricingNote + (selected ? (hit ? '当前模型在列表中。' : '当前模型未出现在列表中，已保留手动选择。') : '') + '</span>';
      setConn('已连接 · ' + result.list.length + ' 个模型', 'ok');
      toast('✅ 连接校验完成', 'ok');
    }catch(err){
      const msg = err.message || String(err);
      const cors = /failed to fetch|networkerror|load failed/i.test(msg);
      box.innerHTML = '<span class="bad">❌ 校验失败：</span>' + escapeHtml(cors ? '网络请求被阻止。请检查 Base URL、网络连接与服务端 CORS。' : msg);
      setConn(cors ? '网络或 CORS 被拦截' : '校验失败', 'error');
    }finally{
      btn.disabled = false;
      (btn.querySelector('.lbl')||btn).textContent = old;
    }
  };
}