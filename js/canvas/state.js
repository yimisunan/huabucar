export const $ = id => document.getElementById(id);

export const LS_KEY = 'img2img_cfg_v1';
export const LS_API_PROFILES = 'img2img_api_profiles_v1';
export const LS_HIST = 'img2img_hist_v1';
export const LS_PRESETS = 'img2img_presets_v1';
export const LS_RECENT = 'img2img_recent_prompts_v1';
export const LS_CANVAS = 'img2img_canvas_v1';
export const MAX_HIST = 30;
export const MAX_CONCURRENT = 3; // 旧版本地并发上限，后台任务模式下不再用于提交延迟
export const REQUEST_TIMEOUTS = { modelCheck: 30000, promptOptimize: 60000, imageGenerate: 300000, videoGenerate: 900000, videoStatus: 20000 };
export const TASK_POLL_INTERVAL = 3000;
export const TASK_STATUS_TIMEOUT = 20000;
export const TASK_RESULT_TIMEOUT = 120000;
export const VIDEO_MODELS = ['grok-imagine-video', 'grok-imagine-video-1.5-preview', 'veo-omni-flash', 'veo-omni-flash-edit', 'veo-omni-3-1', 'seedance-2.0-native', 'seedance-2.0-fast-native', 'seedance-2.5-native'];
export const VIDEO_SECONDS = ['1', '2', '4', '6', '8', '10', '12', '15'];
export const VIDEO_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20'];
export const VIDEO_RESOLUTIONS = ['480P', '720P'];
export const MAX_REFS = 16;
export const MAX_PIXELS = 8294400;
export const PAINT_EDIT_SIDE = 1024;
export const CARD_W = 236;
export const CARD_GAP = 18;
export const PAD = 24;
export const CARD_H_EST = 600;
export const REFERENCE_ROLES = { subject:'主体', outfit:'服装', style:'风格', composition:'构图', none:'不指定' };
export const REFERENCE_ROLE_INSTRUCTIONS = {
  subject:'Use this image only for the subject identity and head appearance: face, facial features, hair, skin tone, and makeup.',
  outfit:'Use this image only for the outfit design, color, material, accessories, garment details, and visible body proportions.',
  style:'Use this image only for the visual style, rendering, lighting, and color treatment.',
  composition:'Use this image only for the pose, action, body orientation, framing, and composition.'
};
export const TIERS = ['1K','2K','4K'];
export const RATIOS = [
  { r:'1:1', d:'正方形', v:{ '1K':'1024x1024', '2K':'2048x2048' } },
  { r:'3:4', d:'立绘竖图', v:{ '1K':'1152x1536', '2K':'1920x2560', '4K':'2480x3312' } },
  { r:'2:3', d:'竖图', v:{ '1K':'1024x1536', '2K':'1712x2560', '4K':'2352x3520' } },
  { r:'5:8', d:'立绘竖图', v:{ '1K':'1088x1728', '2K':'1600x2560', '4K':'2272x3632' } },
  { r:'9:16', d:'手机竖屏', v:{ '1K':'1024x1792', '2K':'1440x2560', '4K':'2160x3840' } },
  { r:'3:2', d:'横图', v:{ '1K':'1536x1024', '2K':'2560x1712', '4K':'3520x2352' } },
  { r:'16:9', d:'宽屏横图', v:{ '1K':'1792x1024', '2K':'2560x1440', '4K':'3840x2160' } },
  { r:'4:3', d:'横版封面', v:{ '1K':'1536x1152', '2K':'2560x1920', '4K':'3312x2480' } }
];
export const QUICK_FILLS = [
  { ico:'hanger', label:'去外衣保脸', fill:'只移除人物外层薄纱披肩/睡袍，人物的脸、发型、五官、身材、内搭服装、画风、光影、白色背景、构图全部保持完全不变，不要改变人物身份和姿势' },
  { ico:'shirt', label:'换装', fill:'保持人物、画风、背景完全不变，只把服装换成一件黑色无袖连衣裙' },
  { ico:'sun', label:'换背景', fill:'保持人物脸部、发型、画风不变，背景换成黄昏海滩，柔光' },
  { ico:'sparkle', label:'高清修复', fill:'整体高清修复，增强皮肤质感与光影细节，其他不变' }
];
export const REL_COLORS = { variant:'#7A6BD1', inpaint:'#4E9E78', optimize:'#E07A5F' };
export const REL_LABELS = { variant:'变体', inpaint:'重绘', optimize:'优化' };
export const DB_NAME = 'img2img_hist_db';
export const DB_STORE = 'originals';
export const THUMB_W = 160;
export const THUMB_Q = 0.7;
export const OV_STATE = { pending:'排队中', running:'生成中', submitting:'提交中', done:'完成', error:'失败', timeout:'超时', cancelled:'取消', interrupted:'服务器重启后需重试', expired:'结果已过期', archived:'存档' };
export const SERVER_TASK_STATES = { queued:'queued', running:'running', done:'done', error:'error', cancelled:'cancelled', interrupted:'interrupted', expired:'expired' };

export const refs = { state:null, el:null, drawers:null };

export function createState(providerConfig){
  return {
    currentMode: 'img2img',
    videoMode: 'txt2video',
    videoModel: VIDEO_MODELS[0],
    videoSeconds: '6',
    videoAspectRatio: '16:9',
    videoResolution: '720P',
    currentTier: '2K',
    selectedSize: '2048x2048',
    currentImageSizeMode: 'preset',
    currentFiles: [],
    taskSeq: 0,
    activeCount: 0,
    taskApi: { available:false, checked:false, maxConcurrent:0, error:'', pollTimer:null },
    currentQuality: '',
    currentComplexity: '',
    currentBg: '',
    currentFmt: '',
    currentResolution: '2k',
    currentSeed: '',
    currentColorCorrection: false,
    currentResizeMethod: '',
    pendingParent: null,
    pendingParentArmed: false,
    taskQueue: [],
    taskEls: {},
    taskWatches: new Map(),
    providerConfig: providerConfig,
    cfgSource: '内置回退配置',
    apiProfiles: [],
    apiProfileActiveId: '',
    proxyStatus: { known:false, allowPrivate:false },
    liveModels: { img: [], chat: [], video: [] },
    liveModelMeta: {},
    modelCatalog: { all: [], image: [], chat: [], video: [], byId: {} },
    modelCatalogFetchedAt: 0,
    modelCatalogError: '',
    toastTimer: null,
    histQuery: '',
    histFavOnly: false,
    detailTask: null,
    paintOrig: null,
    paintMask: null,
    paintStrokes: [],
    paintRedo: [],
    paintSource: null,
    paintOrigW: 0, paintOrigH: 0, paintEditW: 0, paintEditH: 0,
    paintFeather: 1, paintExpand: 1, paintMaskView: false, paintDirty: false,
    paintSrcTask: null,
    paintTool: 'brush',
    paintBrushSize: 24,
    paintScale: 1,
    paintBusy: false,
    painting: false,
    lastPos: null,
    visionItems: [],
    view: { x: 0, y: 0, z: 1 },
    colH: [],
    linkLayer: null,
    links: [],
    skipAutosave: false,
    zoomAnim: null,
    pointers: new Map(),
    dragCard: null,
    dragOffX: 0,
    dragOffY: 0,
    moved: false,
    pressTimer: null,
    pressCard: null,
    pressX: 0,
    pressY: 0,
    pinchDist: 0,
    pinchStart: null,
    panStart: null,
    previewTask: null,
    libDetail: null,
    libDetailBlob: null,
    libDetailBlobUrl: '',
    libToken: 0,
    refBusy: false,
    ctxCard: null,
    batchRatios: new Set(),
    overshoot: null,
    saveTimer: null,
    savedRefFiles: new Map(),
    savedSessionRefFiles: new Map(),
    idbDb: null,
    histQueue: [],
    writingHist: false,
    ovFilter: 'all',
    clientInstanceId: ''
  };
}

export function bindDom(){
  const el = {
    canvas: $('canvas'), world: $('world'), canvasEmpty: $('canvasEmpty'),
    emptyAddRef: $('emptyAddRef'), emptyOptimize: $('emptyOptimize'), emptyParams: $('emptyParams'),
    prompt: $('prompt'), btnPromptEdit: $('btnPromptEdit'), btnGen: $('btnGen'), btnOptimize: $('btnOptimize'),
    promptEditor: $('promptEditor'), promptEditorClose: $('promptEditorClose'), promptEditorText: $('promptEditorText'), promptEditorNegative: $('promptEditorNegative'), promptEditorCount: $('promptEditorCount'), promptEditorNegativeCount: $('promptEditorNegativeCount'), promptEditorCancel: $('promptEditorCancel'), promptEditorApply: $('promptEditorApply'), promptEditorGenerate: $('promptEditorGenerate'), promptEditorMode: $('promptEditorMode'),
    refStrip: $('refStrip'), refAdd: $('refAdd'), fileInput: $('fileInput'),
    qcTier: $('qcTier'), qcRatio: $('qcRatio'), qcCount: $('qcCount'), qcNeg: $('qcNeg'), qcStatus: $('qcStatus'), qcVideo: $('qcVideo'),
    tierTabs: $('tierTabs'), sizeGrid: $('sizeGrid'), tierHint: $('tierHint'),
    customSize: $('customSize'), btnCustomSize: $('btnCustomSize'), count: $('count'), negative: $('negative'),
    quality: $('quality'), complexity: $('complexity'), background: $('background'), format: $('format'), responseFormat: $('responseFormat'), streamMode: $('streamMode'), imageResolution: $('imageResolution'), countHint: $('countHint'), imageOutputPanel: $('imageOutputPanel'), batchPanel: $('secBatch'), videoPanel: $('videoPanel'), videoMode: $('videoMode'), videoSeconds: $('videoSeconds'), videoAspectRatio: $('videoAspectRatio'), videoResolution: $('videoResolution'),
    quickChips: $('quickChips'), recentChips: $('recentChips'),
    libGrid: $('libGrid'), btnClearHist: $('btnClearHist'), histSearch: $('histSearch'), histFavOnly: $('histFavOnly'),
    btnClearCanvas: $('btnClearCanvas'), btnClearByState: $('btnClearByState'),
    providerPreset: $('providerPreset'), apiKey: $('apiKey'), apiBase: $('apiBase'), proxyToken: $('proxyToken'), privateProxyHint: $('privateProxyHint'), btnRefreshProxyStatus: $('btnRefreshProxyStatus'), model: $('model'), customModel: $('customModel'), videoModel: $('videoModel'), videoCustomModel: $('videoCustomModel'),
    apiProfileSelect: $('apiProfileSelect'), apiProfileSave: $('apiProfileSave'), apiProfileOverwrite: $('apiProfileOverwrite'), apiProfileDelete: $('apiProfileDelete'),
    chatKey: $('chatKey'), chatBase: $('chatBase'), chatModel: $('chatModel'), chatCustomModel: $('chatCustomModel'), rememberKey: $('rememberKey'),
    btnToggleKey: $('btnToggleKey'), btnToggleChatKey: $('btnToggleChatKey'), btnCheckApi: $('btnCheckApi'), btnCheckChatApi: $('btnCheckChatApi'), btnRefreshModels: $('btnRefreshModels'),
    btnSaveCfg: $('btnSaveCfg'), apiCheckResult: $('apiCheckResult'), chatApiCheckResult: $('chatApiCheckResult'),
    connDot: $('connDot'), connText: $('connText'),
    usageLine: $('usageLine'), usageText: $('usageText'), btnUsageRefresh: $('btnUsageRefresh'),
    mask: $('mask'), ctx: $('ctx'), preview: $('preview'), previewImg: $('previewImg'), previewVideo: $('previewVideo'), previewMeta: $('previewMeta'),
    previewClose: $('previewClose'), pvDl: $('pvDl'), pvRef: $('pvRef'), pvReuse: $('pvReuse'),
    idea: $('idea'), promptLang: $('promptLang'), btnOptimizeGo: $('btnOptimizeGo'),
    sheetMask: $('sheetMask'), sheet: $('sheet'),
    zoomOut: $('zoomOut'), zoomIn: $('zoomIn'), zoomReset: $('zoomReset'), zoomVal: $('zoomVal'), btnArrange: $('btnArrange'), btnOverview: $('btnOverview'), btnFitAll: $('btnFitAll'), overviewList: $('overviewList'), linkToggle: $('linkToggle'),
    presetSelect: $('presetSelect'), btnPresetSave: $('btnPresetSave'), btnPresetApply: $('btnPresetApply'),
    btnPresetDel: $('btnPresetDel'), btnPresetExport: $('btnPresetExport'), btnPresetImport: $('btnPresetImport'), presetImportFile: $('presetImportFile'),
    batchRatioChips: $('batchRatioChips'), batchMode: $('batchMode'),
    ogMode: $('ogMode'), ogFields: $('ogFields'), ogAttempts: $('ogAttempts'), ogTarget: $('ogTarget'), ogBar: $('ogBar'), ogFill: $('ogFill'), ogText: $('ogText'), ogAct: $('ogAct'),
    detailModal: $('detailModal'), detailText: $('detailText'), detailClose: $('detailClose'), detailCopy: $('detailCopy'),
    nameModal: $('nameModal'), nameInput: $('nameInput'), nameClose: $('nameClose'), nameCancel: $('nameCancel'), nameOk: $('nameOk'),
    paintWrap: $('paintWrap'), paintCanvas: $('paintCanvas'), paintMeta: $('paintMeta'), paintClose: $('paintClose'),
    paintBrush: $('paintBrush'), paintEraser: $('paintEraser'), paintUndo: $('paintUndo'), paintRedo: $('paintRedo'), paintClear: $('paintClear'),
    paintMinus: $('paintMinus'), paintPlus: $('paintPlus'), paintSizeVal: $('paintSizeVal'), paintGo: $('paintGo'), paintPrompt: $('paintPrompt'),
    paintMaskView: $('paintMaskView'), paintFeather: $('paintFeather'), paintFeatherVal: $('paintFeatherVal'),
    paintExpand: $('paintExpand'), paintExpandVal: $('paintExpandVal'), paintSizePolicy: $('paintSizePolicy'),
    paintFile: $('paintFile'), paintFileBtn: $('paintFileBtn'), btnPaintLocal: $('btnPaintLocal'), pvPaint: $('pvPaint'),
    paintZoomOut: $('paintZoomOut'), paintZoomIn: $('paintZoomIn'), paintZoomFit: $('paintZoomFit'), paintZoomVal: $('paintZoomVal'),
    paintCount: $('paintCount'), paintOvershoot: $('paintOvershoot'), paintOGFields: $('paintOGFields'), paintOGTarget: $('paintOGTarget'), paintOGAttempts: $('paintOGAttempts'),
    btnExportCanvas: $('btnExportCanvas'), btnImportCanvas: $('btnImportCanvas'), canvasImportFile: $('canvasImportFile'),
    visionRow: $('visionRow'), visionThumbs: $('visionThumbs'), visionEnable: $('visionEnable'), visionLabel: $('visionLabel'), visionPick: $('visionPick'),
    visionPickModal: $('visionPickModal'), visionPickClose: $('visionPickClose'), visionPickList: $('visionPickList'),
    bootBlock: $('bootBlock')
  };
  const drawers = { params: $('drawerParams'), lib: $('drawerLib'), settings: $('drawerSettings'), overview: $('drawerOverview'), templates: $('drawerTemplates'), gallery: $('drawerGallery') };
  return { el, drawers };
}

export function initShared(providerConfig){
  refs.state = createState(providerConfig);
  const bound = bindDom();
  refs.el = bound.el;
  refs.drawers = bound.drawers;
  return refs;
}