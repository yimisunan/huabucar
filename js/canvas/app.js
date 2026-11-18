(async function () {
  'use strict';
  const base = new URL('./', import.meta.url);
  const stateMod = await import(new URL('state.js', base));
  const videoTasksMod = await import(new URL('videoTasks.js', base));
  const serverTasksMod = await import(new URL('serverTasks.js', base));
  const utilMod = await import(new URL('util.js', base));
  const {
    $, LS_KEY, LS_HIST, LS_PRESETS, LS_RECENT, LS_CANVAS,
    MAX_HIST, MAX_CONCURRENT, REQUEST_TIMEOUTS, MAX_REFS, MAX_PIXELS, PAINT_EDIT_SIDE,
    CARD_W, CARD_GAP, PAD, CARD_H_EST, REFERENCE_ROLES, REFERENCE_ROLE_INSTRUCTIONS,
    TIERS, RATIOS, QUICK_FILLS, REL_COLORS, REL_LABELS, DB_NAME, DB_STORE, THUMB_W, THUMB_Q, OV_STATE,
    refs, initShared
  } = stateMod;
  const {
    submitVideoTask, fetchVideoResults, getVideoTaskResultUrl,
    cancelVideoTask, watchVideoTask, stopVideoTaskWatch, ensureVideoClientTaskId
  } = videoTasksMod;
  const { bindRuntime: bindServerTasksRuntime, checkTaskApi } = serverTasksMod;
  const {
    lsGet, lsSet, escapeHtml, cleanB64, sniffMime, mimeToExt, b64ToBlob, clamp, dataUrlToBlob,
    toast, fileFromBlob, isPrivateApiUrl, localApiProxyHint, getRequestUrl, fetchWithTimeout, parseApiError, copyText
  } = utilMod;
  const settingsMod = await import(new URL('settings.js', base));
  const paramsMod = await import(new URL('params.js', base));
  const refsMod = await import(new URL('refs.js', base));
  const {
    setConn, setOptions, syncPresetModels, syncImageParamOptions, syncGifHint, applyPreset,
    loadProviderConfig, loadCfg, saveCfg, syncPrivateProxyHint, loadProxyStatus,
    loadApiProfiles, saveApiProfile, overwriteApiProfile, deleteApiProfile, applyApiProfile, renderApiProfiles,
    parseModelList, classifyModels, keepCustomModel, applyLiveModels, fetchLiveModels,
    maybeRefreshLiveModels, bindLiveModelRefresh, bindUsageRefresh, runCheck,
    DEFAULT_PROVIDER_CONFIG, COMMON_IMAGE_CAPS, getPresetByKey, getPreset,
    getCapabilitiesForPreset, getCapabilities, getMaxReferences, getCapNum, getCapsList,
    getSelectedImageModel, getSelectedChatModel, getSelectedVideoModel, getImageModelCapabilities, getImageRatios, getSizeVal,
    bindRuntime: bindSettingsRuntime
  } = settingsMod;
  const {
    setMode, renderTierTabs, renderSizes, renderVideoParams, applyCustomSize, syncQuickRow,
    renderRecentChips, pushRecent, loadPresets, savePresets, renderPresetSelect,
    collectCfg, applyCfg, openNameModal, closeNameModal, renderBatchChips, presetBatchFromSize, updateOgFields,
    bindRuntime: bindParamsRuntime
  } = paramsMod;
  const {
    normalizeRefFile, addRefFiles, removeRef, addRefFromBlob, renderRefStrip,
    bindRuntime: bindRefsRuntime
  } = refsMod;
  const promptsMod = await import(new URL('prompts.js', base));
  const paintMod = await import(new URL('paint.js', base));
  const {
    parseDualPrompt, renderQuickChips,
    autosize, collectVisionSources, blobFromSource, imageToDataUrl, renderVisionThumbs, addVisionItem, clearVision,
    openOptimizeWithImage, visionNote, closeSheet, normalizeGeneratedNegative, describeReferences, buildRequestPrompt,
    normalizePromptAndNegative, bindRuntime: bindPromptsRuntime
  } = promptsMod;
  const {
    getTaskResultIndex, getTaskResult, setTaskResultIndex, openPaint, openPaintSource, openPaintFile, closePaint,
    autosizePaint, syncPaintControls, paintPos, startStroke, moveStroke, endStroke, undoPaint, redoPaint,
    clearPaintStrokes, setPaintTool, bumpBrush, setFeather, setExpand, toggleMaskView, submitPaint, hasPaint,
    onPaintPointerDown, onPaintPointerMove, onPaintPointerUp, onPaintWheel, zoomPaintBy, resetPaintZoom,
    drawPaint, canvasToPngBlob, bindRuntime: bindPaintRuntime
  } = paintMod;
  const viewMod = await import(new URL('view.js', base));
  const tasksMod = await import(new URL('tasks.js', base));
  const persistMod = await import(new URL('persist.js', base));
  const {
    addLink, cardAnchor, updateLinks, removeLinksOf, applyView, zoomAnimate, zoomBy, goLatest,
    rebuildColumns, colCount, nextSlot, updateCol, reflowAfterResize, ensureVisible, createCard,
    renderCardState, slotOf, bindCardGestures, endCanvasPointer, openCard, showPreview, closePreview,
    downloadRemote, openLibDetail, openCtx, closeCtx, goActive, stageText, bindRuntime: bindViewRuntime
  } = viewMod;
  const {
    buildTask, enqueueTask, cloneTask, renderTaskCard, releaseTaskRefs, removeCard, dispatchTasks,
    runGenTask, retryTask, closeTask, copyPrompt, removeBatchGroup, abortAllTasks, abortQueuedTasks, retryAllFailed,
    startOvershoot, checkOvershoot, overshootAction, updateOvershootUI,
    reuseTask, renderResults, updateEmpty, bindRuntime: bindTasksRuntime
  } = tasksMod;
  const {
    scheduleAutosave, autosave, restoreCanvas, downloadBlob, idbOpen, idbPut, idbGet, idbDel,
    idbClearPrefix, idbPrunePrefix, releaseCanvasBlob, processHistQueue, thumbFromImage,
    thumbViaServer, makeThumb, makeThumbFromUrl, saveHistory, delHistItem, renderLib, thumbFromUrl,
    clearCanvas, clearByState, bindRuntime: bindPersistRuntime
  } = persistMod;
  const pngMetaMod = await import(new URL('pngMeta.js', base));
  const videoCtlMod = await import(new URL('videoController.js', base));
  const canvasProjMod = await import(new URL('canvasProject.js', base));
  const studioMod = await import(new URL('ui-studio.js', base));
  const {
    taskDetailText, openDetail, closeDetail, crc32, b64encodeUtf8, pngInsertText, taskMeta,
    bindRuntime: bindPngMetaRuntime
  } = pngMetaMod;
  const {
    getVideoCapabilities, getVideoModelForTask, buildVideoTaskFromForm, videoServerOptions,
    videoTaskIsActive, clearVideoResult, applyVideoStatus, fillVideoResult, watchVideoTaskEntry,
    runVideoTask, cancelVideoEntry, downloadArchivedVideo, bindRuntime: bindVideoCtlRuntime
  } = videoCtlMod;
  const {
    exportCanvasProject, importCanvasProject, renderOverview, bindRuntime: bindCanvasProjRuntime
  } = canvasProjMod;
  const {
    bindStudioRuntime, closeAppDialog, uiConfirm, syncTopbarHud,
    closeDockPopover, toggleDockPopover, initDropAndPaste,
    initPreviewEnhancements, initPaintCursor, initStudioDecor
  } = studioMod;


  /* ================= DOM 引用 ================= */

  initShared(DEFAULT_PROVIDER_CONFIG());
  const state = refs.state;
  const el = refs.el;
  const drawers = refs.drawers;
  bindSettingsRuntime(state, el);
  bindParamsRuntime(state, el);
  bindRefsRuntime(state, el);
  bindServerTasksRuntime(state, el);
  state.hooks = state.hooks || {};
  state.hooks.syncQuickRow = syncQuickRow;
  state.hooks.renderTierTabs = renderTierTabs;
  state.hooks.renderSizes = renderSizes;
  state.hooks.renderBatchChips = renderBatchChips;
  state.hooks.autosize = autosize;
  state.hooks.scheduleAutosave = scheduleAutosave;
  state.hooks.openDrawer = openDrawer;
  state.hooks.closeDrawers = closeDrawers;
  state.hooks.openDetail = openDetail;
  state.hooks.taskMeta = taskMeta;
  state.hooks.pngInsertText = pngInsertText;
  state.hooks.b64encodeUtf8 = b64encodeUtf8;
  state.hooks.renderCardState = renderCardState;
  state.hooks.showPreview = showPreview;
  state.hooks.openPaint = openPaint;
  state.hooks.openPaintSource = openPaintSource;
  state.hooks.openPaintFile = openPaintFile;
  state.hooks.openOptimizeWithImage = openOptimizeWithImage;
  state.hooks.buildTask = buildTask;
  state.hooks.enqueueTask = enqueueTask;
  state.hooks.startOvershoot = startOvershoot;
  state.hooks.addLink = addLink;
  state.hooks.cardAnchor = cardAnchor;
  state.hooks.updateLinks = updateLinks;
  state.hooks.removeLinksOf = removeLinksOf;
  state.hooks.applyView = applyView;
  state.hooks.zoomAnimate = zoomAnimate;
  state.hooks.zoomBy = zoomBy;
  state.hooks.goLatest = goLatest;
  state.hooks.rebuildColumns = rebuildColumns;
  state.hooks.colCount = colCount;
  state.hooks.nextSlot = nextSlot;
  state.hooks.updateCol = updateCol;
  state.hooks.reflowAfterResize = reflowAfterResize;
  state.hooks.ensureVisible = ensureVisible;
  state.hooks.createCard = createCard;
  state.hooks.slotOf = slotOf;
  state.hooks.openCard = openCard;
  state.hooks.closePreview = closePreview;
  state.hooks.downloadRemote = downloadRemote;
  state.hooks.openLibDetail = openLibDetail;
  state.hooks.openCtx = openCtx;
  state.hooks.closeCtx = closeCtx;
  state.hooks.renderTaskCard = renderTaskCard;
  state.hooks.cloneTask = cloneTask;
  state.hooks.releaseTaskRefs = releaseTaskRefs;
  state.hooks.removeCard = removeCard;
  state.hooks.dispatchTasks = dispatchTasks;
  state.hooks.runGenTask = runGenTask;
  state.hooks.retryTask = retryTask;
  state.hooks.closeTask = closeTask;
  state.hooks.copyPrompt = copyPrompt;
  state.hooks.removeBatchGroup = removeBatchGroup;
  state.hooks.abortAllTasks = abortAllTasks;
  state.hooks.retryAllFailed = retryAllFailed;
  state.hooks.overshootSettled = () => checkOvershoot();
  state.hooks.reuseTask = reuseTask;
  state.hooks.updateEmpty = updateEmpty;
  state.hooks.downloadBlob = downloadBlob;
  state.hooks.idbGet = idbGet;
  state.hooks.thumbViaServer = thumbViaServer;
  state.hooks.renderLib = renderLib;
  state.hooks.releaseCanvasBlob = releaseCanvasBlob;
  state.hooks.idbClearPrefix = idbClearPrefix;
  state.hooks.saveHistory = saveHistory;
  state.hooks.submitVideoTask = submitVideoTask;
  state.hooks.fetchVideoResults = fetchVideoResults;
  state.hooks.getVideoTaskResultUrl = getVideoTaskResultUrl;
  state.hooks.watchVideoTask = watchVideoTask;
  state.hooks.stopVideoTaskWatch = stopVideoTaskWatch;
  state.hooks.cancelVideoTask = cancelVideoTask;
  state.hooks.ensureVideoClientTaskId = ensureVideoClientTaskId;
  state.hooks.getVideoTaskStatus = videoTasksMod.getVideoTaskStatus;
  state.hooks.openRefPopover = anchor => toggleDockPopover('ref', anchor);
  state.videoWatches = state.videoWatches || new Map();
  bindPromptsRuntime(state, el);
  bindPaintRuntime(state, el);
  bindViewRuntime(state, el);
  bindTasksRuntime(state, el);
  bindPersistRuntime(state, el);
  bindPngMetaRuntime(state, el);
  bindVideoCtlRuntime(state, el);
  bindCanvasProjRuntime(state, el);
  bindStudioRuntime(state, el, {
    focusDrawer: focusDrawerTarget,
    applyCustomSize,
    setMode,
    syncQuickRow,
    openPromptEditor,
    autosize,
    openTemplates,
    openGallery,
    addRefFiles,
    setTaskResultIndex
  });
  state.hooks.thumbFromUrl = thumbFromUrl;
  function openTemplates() {
    openDrawer('templates');
    const f = $('tplFrame');
    if (f && !f.getAttribute('src')) f.setAttribute('src', '页面/方案样板选择.html');
  }

  function openGallery() {
    openDrawer('gallery');
    const f = $('galFrame');
    if (f && !f.getAttribute('src')) f.setAttribute('src', '页面/参考图库选择.html?v=catui17');
  }

  /* 参考图库（iframe）→ 加入参考图。
     档 0：只交付图片字节，不附带任何提示词、不写角色语义（role 保持「不指定」），
     姿势/服装的含义完全由宿主自己的提示词决定。 */
  async function addGalleryRefs(items) {
    const list = (Array.isArray(items) ? items : []).filter(x => x && x.url);
    if (!list.length) return;
    let added = 0, dup = 0, fail = 0;
    for (const it of list) {
      if (state.currentFiles.length >= MAX_REFS) { fail++; continue; }
      const fname = String(it.url).split('?')[0].split('/').pop() || (String(it.id || 'ref') + '.png');
      if (state.currentFiles.some(f => f.file && f.file.name === fname)) { dup++; continue; }
      try {
        const res = await fetch(getRequestUrl(it.url), { cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        if (!blob || !blob.size) throw new Error('empty');
        const ok = await addRefFromBlob(blob, fname);
        if (ok) added++; else fail++;
      } catch (e) { fail++; }
    }
    if (added) toast('✅ 已加入 ' + added + ' 张参考图（角色：不指定，语义由你写）', 'ok');
    if (dup) toast('已跳过 ' + dup + ' 张：参考条里已有同一张', 'err');
    if (fail) toast('跳过 ' + fail + ' 张：已达参考图上限或下载失败', 'err');
    scheduleAutosave();
  }


  function openDrawer(name){
    closeSheet();
    closeConsole();
    closeDockPopover();
    Object.values(drawers).forEach(d=> d.classList.remove('open'));
    if(!drawers[name]) return;
    state.lastDrawerTab = name;
    drawers[name].classList.add('open');
    el.mask.classList.add('open');
    const cbtn = $('btnConsole');
    if (cbtn) cbtn.setAttribute('aria-expanded', 'true');
    if(name==='lib') renderLib();
    if(name==='overview') renderOverview();
  }
  function closeDrawers(){
    Object.values(drawers).forEach(d=> d.classList.remove('open'));
    el.mask.classList.remove('open');
    const cbtn = $('btnConsole');
    if (cbtn) cbtn.setAttribute('aria-expanded', 'false');
  }
  function focusDrawerTarget(drawerName, target, opts) {
    openDrawer(drawerName);
    const run = () => {
      const node = typeof target === 'string' ? $(target) : target;
      if (!node) return;
      const fold = node.closest('details.fold');
      if (fold) fold.open = true;
      requestAnimationFrame(() => {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        node.classList.remove('ui-focus-target');
        void node.offsetWidth;
        node.classList.add('ui-focus-target');
        setTimeout(() => node.classList.remove('ui-focus-target'), 1400);
        if (opts && opts.focus) setTimeout(() => node.focus(), 220);
      });
    };
    setTimeout(run, 80);
  }

  function updatePromptEditorCounts() {
    if (!el.promptEditorCount || !el.promptEditorNegativeCount) return;
    el.promptEditorCount.textContent = Array.from(el.promptEditorText.value || '').length + ' 字';
    el.promptEditorNegativeCount.textContent = Array.from(el.promptEditorNegative.value || '').length + ' 字';
  }
  function openPromptEditor() {
    if (!el.promptEditor) return;
    el.promptEditorText.value = el.prompt.value || '';
    el.promptEditorNegative.value = el.negative.value || '';
    const modeLbl = state.currentMode === 'video' ? (state.videoMode === 'img2video' ? '图片生视频' : '文生视频') : (state.currentMode === 'img2img' ? '图生图' : '文生图');
    el.promptEditorMode.textContent = modeLbl + ' · 正向提示词与负面提示词';
    updatePromptEditorCounts();
    el.promptEditor.classList.add('open');
    document.body.classList.add('prompt-editor-open');
    setTimeout(() => el.promptEditorText.focus(), 120);
  }
  function closePromptEditor() {
    if (!el.promptEditor) return;
    el.promptEditor.classList.remove('open');
    document.body.classList.remove('prompt-editor-open');
  }
  function applyPromptEditor(andGenerate) {
    el.prompt.value = el.promptEditorText.value;
    el.negative.value = el.promptEditorNegative.value;
    autosize();
    syncQuickRow();
    closePromptEditor();
    if (andGenerate) setTimeout(() => el.btnGen.click(), 0);
    else toast('✅ 提示词已应用', 'ok');
  }
  el.btnPromptEdit.onclick = openPromptEditor;
  el.promptEditorClose.onclick = closePromptEditor;
  el.promptEditorCancel.onclick = closePromptEditor;
  el.promptEditorApply.onclick = () => applyPromptEditor(false);
  el.promptEditorGenerate.onclick = () => applyPromptEditor(true);
  el.promptEditor.addEventListener('click', e => { if (e.target === el.promptEditor) closePromptEditor(); });
  [el.promptEditorText, el.promptEditorNegative].forEach(node => node.addEventListener('input', updatePromptEditorCounts));

  state.hooks.runVideoTask = runVideoTask;
  state.hooks.cancelVideoEntry = cancelVideoEntry;
  state.hooks.downloadArchivedVideo = downloadArchivedVideo;
  state.videoWatches = state.videoWatches || new Map();
  /* 控制台：顶栏工作台直开最近抽屉，顶栏导航与抽屉内 6 个 tab 共用 goConsole 分发 */
  function goConsole(name) {
    closeConsole();
    if (name === 'templates') { openTemplates(); return; }
    if (name === 'gallery') { openGallery(); return; }
    openDrawer(name);
  }
  function openConsole() {
    const sheetEl = $('consoleSheet');
    if (!sheetEl) return;
    closeDrawers();
    sheetEl.classList.add('open');
    const cbtn = $('btnConsole');
    if (cbtn) cbtn.setAttribute('aria-expanded', 'true');
  }
  function closeConsole() {
    const sheetEl = $('consoleSheet');
    if (sheetEl) sheetEl.classList.remove('open');
    const cbtn = $('btnConsole');
    if (cbtn) cbtn.setAttribute('aria-expanded', 'false');
  }
  if ($('btnConsole')) $('btnConsole').onclick = () => {
    const anyOpen = Object.values(drawers).some(d => d && d.classList.contains('open'));
    if (anyOpen) closeDrawers();
    else goConsole(state.lastDrawerTab || 'params');
  };
  if ($('consoleSheet')) $('consoleSheet').addEventListener('click', e => {
    if (e.target === $('consoleSheet')) closeConsole();
  });
  document.addEventListener('click', e => {
    const goBtn = e.target && e.target.closest ? e.target.closest('[data-go]') : null;
    if (!goBtn) return;
    e.preventDefault();
    goConsole(goBtn.getAttribute('data-go'));
  });
  $('btnOpenTemplates').onclick = () => openTemplates();
  el.mask.onclick = closeDrawers;
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeDrawers);

  /* 方案样板选择器（iframe）→ 回填提示词 / 负面词 */
  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || d.source !== 'template-picker' || ev.origin !== location.origin || ev.source !== $('tplFrame')?.contentWindow) return;
    if (d.type === 'close') { closeDrawers(); return; }
    if (d.type !== 'apply-template') return;
    if (typeof d.positive === 'string' && d.positive) {
      el.prompt.value = d.positive;
      el.prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (el.negative && typeof d.negative === 'string') el.negative.value = d.negative;
    if (el.promptEditor && el.promptEditor.classList.contains('open')) {
      el.promptEditorText.value = el.prompt.value;
      el.promptEditorNegative.value = el.negative.value;
      updatePromptEditorCounts();
    }
    autosize();
    syncQuickRow();
    scheduleAutosave();
    closeDrawers();
    toast('✅ 已套用样板：' + (d.name || ''), 'ok');
  });

  /* 参考图库选择器（iframe）→ 加入参考图 / 关闭面板 */
  window.addEventListener('message', (ev) => {
    const d = ev && ev.data;
    if (!d || d.source !== 'ref-gallery' || ev.origin !== location.origin || ev.source !== $('galFrame')?.contentWindow) return;
    if (d.type === 'close') { closeDrawers(); return; }
    if (d.type === 'add-ref') { addGalleryRefs(d.items); return; }
  });

  /* ================= 连接状态 ================= */

  /* ================= 供应商与模型 ================= */
  function showBootBlock() {
    if (!el.bootBlock) return;
    el.bootBlock.style.display = 'flex';
    document.body.classList.add('boot-lock');
  }
  function hideBootBlock() {
    if (!el.bootBlock) return;
    el.bootBlock.style.display = 'none';
    document.body.classList.remove('boot-lock');
  }
  function bindBoot() {
    const btn = $('bootReload');
    if (btn) btn.onclick = () => location.reload();
  }
  async function ensureServer() {
    if (location.protocol === 'file:') return false;
    try {
      const res = await fetch('/api/prompt-list', { cache: 'no-store' });
      if (res && res.ok) await res.text().catch(() => {});
      return !!res.ok;
    } catch (e) { return false; }
  }

  async function ensureTaskApi() {
    try {
      const caps = await checkTaskApi();
      state.taskApi.available = true;
      state.taskApi.checked = true;
      state.taskApi.maxConcurrent = Number(caps.maxConcurrent) || 0;
      state.taskApi.error = '';
      return true;
    } catch (err) {
      state.taskApi.available = false;
      state.taskApi.checked = true;
      state.taskApi.error = err && err.message ? err.message : String(err);
      return false;
    }
  }

  function showTaskApiUnavailable() {
    showBootBlock();
    if (el.bootBlock) {
      const hint = el.bootBlock.querySelector('.boot-hint');
      if (hint) hint.textContent = '当前服务器不支持后台生图任务 API，请重启新版「生图服务器.py」后再使用。为保证刷新续跑，不会退回浏览器直连生图。';
      const title = el.bootBlock.querySelector('.boot-title');
      if (title) title.textContent = '需要启动支持后台任务的新版服务器';
    }
  }
  el.btnSaveCfg.onclick = saveCfg;
  if (el.apiProfileSelect) el.apiProfileSelect.onchange = () => applyApiProfile(el.apiProfileSelect.value, false);
  if (el.apiProfileSave) el.apiProfileSave.onclick = saveApiProfile;
  if (el.apiProfileOverwrite) el.apiProfileOverwrite.onclick = overwriteApiProfile;
  if (el.apiProfileDelete) el.apiProfileDelete.onclick = deleteApiProfile;
  el.providerPreset.onchange = () => applyPreset(true);
  el.model.onchange = () => { el.customModel.style.display = el.model.value === '__custom__' ? '' : 'none'; syncImageParamOptions(); syncQuickRow(); };
  if (el.customModel) el.customModel.oninput = syncQuickRow;
  el.chatModel.onchange = () => { el.chatCustomModel.style.display = el.chatModel.value === '__custom__' ? '' : 'none'; };
  if (el.videoMode) el.videoMode.onchange = () => { state.videoMode = el.videoMode.value === 'img2video' ? 'img2video' : 'txt2video'; setMode('video'); };
  if (el.videoModel) el.videoModel.onchange = () => { if (el.videoCustomModel) el.videoCustomModel.style.display = el.videoModel.value === '__custom__' ? '' : 'none'; state.videoModel = getSelectedVideoModel(); syncQuickRow(); };
  if (el.videoCustomModel) el.videoCustomModel.oninput = () => { state.videoModel = el.videoCustomModel.value.trim(); syncQuickRow(); };
  if (el.videoSeconds) el.videoSeconds.onchange = () => { state.videoSeconds = el.videoSeconds.value || '6'; syncQuickRow(); };
  if (el.videoAspectRatio) el.videoAspectRatio.onchange = () => { state.videoAspectRatio = el.videoAspectRatio.value || '16:9'; syncQuickRow(); };
  if (el.videoResolution) el.videoResolution.onchange = () => { state.videoResolution = el.videoResolution.value || '720P'; syncQuickRow(); };
  el.btnToggleKey.onclick = () => {
    const show = el.apiKey.type === 'password';
    el.apiKey.type = show ? 'text' : 'password';
    el.btnToggleKey.classList.toggle('show', show);
  };
  if (el.btnToggleChatKey) {
    el.btnToggleChatKey.onclick = () => {
      const show = el.chatKey.type === 'password';
      el.chatKey.type = show ? 'text' : 'password';
      el.btnToggleChatKey.classList.toggle('show', show);
    };
  }

  /* ===== API 校验 ===== */
  el.btnCheckApi.onclick = runCheck('img');
  el.btnCheckChatApi.onclick = runCheck('chat');
  if (el.btnRefreshProxyStatus) {
    el.btnRefreshProxyStatus.onclick = async () => {
      const old = (el.btnRefreshProxyStatus.querySelector('.lbl') || el.btnRefreshProxyStatus).textContent;
      el.btnRefreshProxyStatus.disabled = true;
      (el.btnRefreshProxyStatus.querySelector('.lbl') || el.btnRefreshProxyStatus).textContent = '刷新中…';
      await loadProxyStatus();
      el.btnRefreshProxyStatus.disabled = false;
      (el.btnRefreshProxyStatus.querySelector('.lbl') || el.btnRefreshProxyStatus).textContent = old;
      toast(state.proxyStatus.known ? (state.proxyStatus.allowPrivate ? '✅ 本机/局域网 API 代理已开启' : '⚠️ 本机/局域网 API 代理未开启') : '⚠️ 未读取到代理状态，已保留服务器实际判定', state.proxyStatus.known && state.proxyStatus.allowPrivate ? 'ok' : 'err');
    };
  }

  /* ================= 模式切换与顶栏快捷入口 ================= */
  document.querySelectorAll('#modeSwitch button').forEach(b => {
    b.onclick = () => setMode(b.dataset.mode);
  });
  document.querySelectorAll('#videoSubSwitch button').forEach(b => {
    b.onclick = () => {
      state.videoMode = b.dataset.vmode === 'img2video' ? 'img2video' : 'txt2video';
      if (el.videoMode) el.videoMode.value = state.videoMode;
      setMode('video');
    };
  });
  const topConnBtn = $('btnTopConn');
  if (topConnBtn) topConnBtn.onclick = () => focusDrawerTarget('settings', el.apiBase);
  const topQueueBtn = $('btnTopQueue');
  if (topQueueBtn) topQueueBtn.onclick = () => goConsole('overview');

  /* ================= 参考图 ================= */
  const openRefFromEmpty = () => {
    const br = document.querySelector('.action-row .btn-ref');
    const anchor = (br && br.offsetParent) ? br : ((el.refAdd && el.refAdd.offsetParent) ? el.refAdd : null);
    toggleDockPopover('ref', anchor);
  };
  el.refAdd.onclick = () => toggleDockPopover('ref', el.refAdd);
  document.querySelectorAll('.btn-ref').forEach(b => { b.onclick = () => toggleDockPopover('ref', b); });
  el.fileInput.onchange = e => { addRefFiles(e.target.files); e.target.value = ''; };
  if (el.emptyAddRef) el.emptyAddRef.onclick = openRefFromEmpty;
  if (el.emptyOptimize) el.emptyOptimize.onclick = () => el.btnOptimize.click();
  if (el.emptyParams) el.emptyParams.onclick = () => focusDrawerTarget('params', el.tierTabs);

  /* ================= 尺寸/档位 ================= */
  el.btnCustomSize.onclick = applyCustomSize;
  el.customSize.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyCustomSize(); } });

  /* ================= 快捷行（即点即改 Popover） ================= */
  const qcInspireBtn = $('qcInspire');
  if (qcInspireBtn) qcInspireBtn.onclick = e => toggleDockPopover('inspire', e.currentTarget);
  el.qcStatus.onclick = e => toggleDockPopover('status', e.currentTarget);
  if (el.qcVideo) el.qcVideo.onclick = e => toggleDockPopover('video', e.currentTarget);
  el.qcTier.onclick = e => toggleDockPopover('tier', e.currentTarget);
  el.qcRatio.onclick = e => toggleDockPopover('ratio', e.currentTarget);
  el.qcCount.onclick = e => toggleDockPopover('count', e.currentTarget);
  el.qcNeg.onclick = e => toggleDockPopover('neg', e.currentTarget);
  if (el.negative) el.negative.addEventListener('input', syncQuickRow);
  if (el.imageResolution) el.imageResolution.onchange = () => { state.currentResolution = el.imageResolution.value || ''; syncQuickRow(); };
  el.count.onchange = syncQuickRow;
  el.quality.onchange = () => state.currentQuality = el.quality.value;
  if(el.complexity) el.complexity.onchange = () => state.currentComplexity = el.complexity.value;
  el.background.onchange = () => state.currentBg = el.background.value;
  el.format.onchange = () => { state.currentFmt = el.format.value; syncGifHint(); };

  /* ================= 参数预设（配方） ================= */
  el.nameClose.onclick = closeNameModal;
  el.nameCancel.onclick = closeNameModal;
  el.nameOk.onclick = () => {
    const name = el.nameInput.value.trim();
    if (!name) { toast('请输入预设名称', 'err'); return; }
    const list = loadPresets();
    const cfg = collectCfg();
    cfg.name = name;
    const idx = list.findIndex(p => p.name === name);
    if (idx > -1) list[idx] = cfg; else list.push(cfg);
    savePresets(list);
    renderPresetSelect();
    el.presetSelect.value = name;
    closeNameModal();
    toast('✅ 预设「' + name + '」已保存', 'ok');
  };
  el.nameModal.addEventListener('click', e => { if (e.target === el.nameModal) closeNameModal(); });
  el.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.nameOk.click(); } });
  el.btnPresetSave.onclick = openNameModal;
  el.btnPresetApply.onclick = () => {
    const name = el.presetSelect.value;
    if (!name) { toast('请先选择一个预设', 'err'); return; }
    const p = loadPresets().find(x => x.name === name);
    if (!p) { toast('预设不存在', 'err'); return; }
    applyCfg(p);
    toast('✅ 已应用预设「' + name + '」', 'ok');
  };
  el.btnPresetDel.onclick = async () => {
    const name = el.presetSelect.value;
    if (!name) { toast('请先选择一个预设', 'err'); return; }
    if (!(await uiConfirm({ title:'删除参数预设', message:'确定删除预设「' + name + '」？', confirmText:'删除', danger:true }))) return;
    savePresets(loadPresets().filter(p => p.name !== name));
    renderPresetSelect();
    toast('已删除预设「' + name + '」', 'ok');
  };
  el.btnPresetExport.onclick = () => {
    const list = loadPresets();
    if (!list.length) { toast('没有预设可导出', 'err'); return; }
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '生图预设_' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast('✅ 已导出 ' + list.length + ' 个预设', 'ok');
  };
  el.btnPresetImport.onclick = () => el.presetImportFile.click();
  el.presetImportFile.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!Array.isArray(data)) throw new Error('格式错误');
        const list = loadPresets();
        let added = 0;
        data.forEach(p => {
          if (!p || typeof p.name !== 'string' || !p.name.trim()) return;
          const idx = list.findIndex(x => x.name === p.name);
          if (idx > -1) list[idx] = p; else list.push(p);
          added++;
        });
        savePresets(list);
        renderPresetSelect();
        toast('✅ 导入完成：' + added + ' 个预设', 'ok');
      } catch (err) {
        toast('❌ 预设文件解析失败', 'err');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  /* ================= 任务详情（实现见 pngMeta.js） ================= */
  el.detailClose.onclick = closeDetail;
  el.detailModal.addEventListener('click', e=>{ if(e.target === el.detailModal) closeDetail(); });
  el.detailCopy.onclick = async ()=>{
    if(!state.detailTask) return;
    try{
      const ok = await copyText(taskDetailText(state.detailTask));
      if(!ok) throw new Error('clipboard-unavailable');
      toast('✅ 参数已复制到剪贴板', 'ok');
    }catch(e){
      toast('复制失败，请手动选择复制', 'err');
    }
  };

  /* ================= 局部修改（蒙版重绘） ================= */
  el.paintClose.onclick = () => closePaint();
  el.paintPrompt.addEventListener('input', autosizePaint);

  el.paintBrush.onclick = () => setPaintTool('brush');
  el.paintEraser.onclick = () => setPaintTool('eraser');
  el.paintUndo.onclick = () => undoPaint();
  if (el.paintRedo) el.paintRedo.onclick = () => redoPaint();
  el.paintClear.onclick = () => clearPaintStrokes();
  el.paintMinus.onclick = () => bumpBrush(-4);
  el.paintPlus.onclick = () => bumpBrush(4);
  if (el.paintMaskView) el.paintMaskView.onclick = () => toggleMaskView();
  if (el.paintFeather) el.paintFeather.oninput = () => setFeather(el.paintFeather.value);
  if (el.paintExpand) el.paintExpand.oninput = () => setExpand(el.paintExpand.value);
  el.paintGo.onclick = () => submitPaint(el.paintSizePolicy ? el.paintSizePolicy.value : 'original');

  // 单指涂抹 / 双指缩放平移 / 滚轮缩放（逻辑在 paint.js）
  el.paintCanvas.addEventListener('pointerdown', onPaintPointerDown);
  el.paintCanvas.addEventListener('pointermove', onPaintPointerMove);
  el.paintCanvas.addEventListener('pointerup', onPaintPointerUp);
  el.paintCanvas.addEventListener('pointercancel', onPaintPointerUp);
  el.paintCanvas.addEventListener('wheel', onPaintWheel, { passive: false });

  if (el.paintZoomIn) el.paintZoomIn.onclick = () => zoomPaintBy(1.25);
  if (el.paintZoomOut) el.paintZoomOut.onclick = () => zoomPaintBy(0.8);
  if (el.paintZoomFit) el.paintZoomFit.onclick = () => resetPaintZoom();
  if (el.paintOvershoot && el.paintOGFields) {
    const syncPaintOG = () => {
      const on = !!el.paintOvershoot.checked;
      el.paintOGFields.hidden = !on;
      if (el.paintCount) {
        el.paintCount.disabled = on;
        if (on) {
          const n = Math.max(1, Math.min(4, Number(el.paintCount.value) || 1));
          if (el.paintOGTarget && !Number(el.paintOGTarget.value)) el.paintOGTarget.value = String(n);
          if (el.paintOGAttempts && !Number(el.paintOGAttempts.value)) el.paintOGAttempts.value = String(n + 3);
        }
      }
    };
    el.paintOvershoot.onchange = syncPaintOG;
    if (el.paintCount) el.paintCount.onchange = () => { if (el.paintOvershoot.checked && el.paintOGTarget) el.paintOGTarget.value = String(Math.max(1, Math.min(4, Number(el.paintCount.value) || 1))); };
    syncPaintOG();
  }

  // 素材库 / 预览共用：把一张图送进涂抹
  const paintFromHist = async (h) => {
    if (!h) return;
    if (h.mediaType === 'video') { toast('视频不支持局部修改', 'err'); return; }
    const cached = (state.libDetail === h && state.libDetailBlob) ? state.libDetailBlob : null;
    if (cached) { openPaintSource({ blob: cached, label: '素材库', parentId: null }); return; }
    if (h.origType === 'idb' || h.origType === 'canvas') {
      const blob = await idbGet(h.origType === 'canvas' ? (h.origKey || '') : h.id);
      if (blob) { openPaintSource({ blob, label: '素材库', parentId: null }); return; }
      toast('素材原图读取失败', 'err');
      return;
    }
    if (h.origUrl) { openPaintSource({ url: h.origUrl, label: '素材库', parentId: null }); return; }
    toast('该素材没有可用的原图', 'err');
  };
  state.hooks.paintHist = paintFromHist;

  // 入口①：本机图片
  const pickPaintFile = () => {
    if (el.paintFile) el.paintFile.click();
    else toast('当前环境不支持选择文件', 'err');
  };
  if (el.btnPaintLocal) el.btnPaintLocal.onclick = pickPaintFile;
  if (el.paintFileBtn) el.paintFileBtn.onclick = pickPaintFile;
  if (el.paintFile) el.paintFile.onchange = () => {
    const f = el.paintFile.files && el.paintFile.files[0];
    el.paintFile.value = '';
    if (f) openPaintFile(f);
  };

  // 入口②：预览面板「局部修改」（生成结果 / 素材库通用）
  if (el.pvPaint) el.pvPaint.onclick = () => {
    const t = state.previewTask;
    if (t) {
      const ri = getTaskResult(t);
      if (ri) openPaintSource({ blob: ri.blob || null, url: ri.url || '', label: '#' + t.task.id, parentId: t.task.id, task: t.task, caps: t.task.capabilities || null });
      return;
    }
    paintFromHist(state.libDetail);
  };

  /* ================= 提示词优化 ================= */
  el.prompt.addEventListener('input', autosize);

  /* ===== 视觉输入（让 AI 看图，支持多图） ===== */
  el.visionPick.onclick = () => {
    const srcs = collectVisionSources();
    if (!srcs.length) { toast('没有可用图片（请先添加参考图或生成结果）', 'err'); return; }
    el.visionPickList.innerHTML = '';
    srcs.forEach(s => {
      const added = state.visionItems.some(v => v.label === s.label);
      const row = document.createElement('div');
      row.className = 'vp-row' + (added ? ' on' : '');
      row.innerHTML = '<span>' + escapeHtml(s.label) + '</span><b>' + (added ? '已添加' : '添加') + '</b>';
      row.onclick = () => { addVisionItem(s); };
      el.visionPickList.appendChild(row);
    });
    el.visionPickModal.classList.add('open');
  };
  el.visionPickClose.onclick = () => el.visionPickModal.classList.remove('open');
  el.visionPickModal.addEventListener('click', e => { if (e.target === el.visionPickModal) el.visionPickModal.classList.remove('open'); });
  el.btnOptimize.onclick = async () => {
    // 普通优化面板与「看图优化」无关，先清掉未确认的血缘候选
    state.pendingParent = null;
    state.pendingParentArmed = false;
    el.sheet.classList.add('open');
    el.sheetMask.classList.add('open');
    clearVision();
    for (let i = 0; i < state.currentFiles.length; i++) {
      const f = state.currentFiles[i];
      await addVisionItem({ label: '参考图 ' + (i + 1) + '（' + (REFERENCE_ROLES[f.role] || f.role) + '）', blob: f.file });
    }
    setTimeout(() => el.idea.focus(), 260);
  };
  el.sheetMask.onclick = closeSheet;
  el.btnOptimizeGo.onclick = async () => {
    const chatBase = (el.chatBase.value.trim() || el.apiBase.value.trim()).replace(/\/+$/, '');
    const chatKey = (el.chatKey.value.trim() || el.apiKey.value.trim());
    const idea = el.idea.value.trim();
    if (!chatKey) { toast('请先填写 API Key（设置 ⚙️）', 'err'); closeDrawers(); openDrawer('settings'); return; }
    if (!chatBase) { toast('请先填写 Base URL（设置 ⚙️）', 'err'); closeDrawers(); openDrawer('settings'); return; }
    const localChatHint = localApiProxyHint(chatBase);
    if (localChatHint) { toast('⚠️ ' + localChatHint, 'err'); closeDrawers(); openDrawer('settings'); return; }
    if (!idea) { toast('请先描述你的想法', 'err'); return; }
    const mode = state.currentMode === 'img2img' ? 'IMAGE EDIT (img2img)' : 'TEXT TO IMAGE (txt2img)';
    const referenceContext = state.currentMode === 'img2img' && state.currentFiles.length ? '\nReference context: ' + describeReferences(state.currentFiles) : '';
    const lang = el.promptLang.value;
    const langRule = lang === 'en' ? 'Write the prompts in ENGLISH only.'
      : lang === 'zh' ? 'Write the prompts in CHINESE only.'
        : 'Write a mixed Chinese-English prompt: keep useful visual/style terms in English, and keep the user intent in Chinese. Do not output a full English prompt plus a separate Chinese translation.';
    const sys = 'You are an expert AI image prompt engineer for the gpt-image-2 image generation/edit API.\n'
      + 'Task mode: ' + mode + '.\n'
      + 'Rewrite the user\'s rough description into a POSITIVE prompt and a NEGATIVE prompt.\n'
      + 'Output exactly two sections with these markers, nothing else:\n[POSITIVE]\n...the refined positive prompt...\n[NEGATIVE]\n...the negative prompt listing elements to avoid...\n\n'
      + 'Rules:\n'
      + '1. Preserve the user\'s core intent completely; do NOT invent major content changes.\n'
      + '2. For IMAGE EDIT tasks: use the supplied Reference context. Preserve only attributes the user explicitly asks to preserve; do not assume the subject is a person or invent identity, face, pose, clothing, background, or style constraints.\n'
      + '3. Compose the positive prompt with a concise physical skeleton: main subject (pose/expression/gaze/appearance) + scene/environment + composition (viewpoint/framing) + core lighting and color + medium/style. Keep the core scene description around 60-80 English words. NEVER use subjective sensory words (beautiful, elegant, perfect, stunning, high-end, exquisite); express atmosphere only via concrete physical light sources, optical parameters, material properties and environment nouns. Physical quality words allowed: soft skin translucency, fine skin texture, soft shadows, smooth fabric drape.\n'
      + '4. In the [NEGATIVE] section: list 5-10 concrete things to avoid for this specific image. Start each item with 禁止 (or "no/without" if writing in English); NEVER use 不要/避免/please do not as the prefix — each item must be a single negation without double negatives. Always include killer words that cause deformed hands, melted structures and extra limbs (deformed fingers, extra fingers, malformed hands, extra limbs, melted structure, merged objects).\n'
      + '5. Output ONLY the two marked sections. No explanation, no quotes, no prefix.\n'
      + '6. You may receive one or more reference images with this request. If images are provided, LOOK at them carefully and describe what you actually see: the real art style (anime / 2D cel-shaded illustration / realistic photo / 3D render / oil painting / watercolor etc.), the character\'s actual appearance, hair, outfit, colors and composition. NEVER assume a realistic-photo style when the image is clearly anime or illustration. Match the observed style exactly unless the user explicitly asks to change it.\n'
      + '7. If the user requests a transparent/alpha background: do not describe checkerboards or promise any later cutout. Describe an isolated clean silhouette and rely on the API background=transparent parameter.';
    const userMsg = 'My request: ' + idea + referenceContext + visionNote() + '\n' + langRule;
    const content = [{ type: 'text', text: userMsg }];
    if (el.visionEnable.checked && state.visionItems.length) {
      state.visionItems.forEach(v => content.push({ type: 'image_url', image_url: { url: v.sendUrl } }));
    }
    el.btnOptimizeGo.disabled = true;
    el.btnOptimizeGo.textContent = '⏳ 优化中…';
    try {
      const res = await fetchWithTimeout(chatBase + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + chatKey },
        body: JSON.stringify({ model: getSelectedChatModel(), messages: [{ role: 'system', content: sys }, { role: 'user', content }], temperature: 0.7 })
      }, REQUEST_TIMEOUTS.promptOptimize);
      if (!res.ok) throw new Error(await parseApiError(res));
      const data = await res.json();
      const out = data.choices?.[0]?.message?.content?.trim();
      if (!out) throw new Error('模型未返回内容');
      const dual = parseDualPrompt(out);
      el.prompt.value = dual.positive;
      el.negative.value = normalizeGeneratedNegative(dual.negative);
      state.pendingParentArmed = true; // 优化成功回填，血缘才正式生效
      autosize();
      syncQuickRow();
      closeSheet();
      toast(dual.negative ? '✅ 正向 + 负面提示词已回填' : '✅ 正向提示词已回填', 'ok');
    } catch (err) {
      toast('❌ 优化失败\n' + err.message, 'err');
    } finally {
      el.btnOptimizeGo.disabled = false;
      el.btnOptimizeGo.textContent = '优化并回填';
    }
  };

  /* ================= 画布引擎 ================= */

  /* ================= 血缘连线（谁基于谁） ================= */
  state.linkLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  state.linkLayer.setAttribute('class', 'link-layer');
  el.world.insertBefore(state.linkLayer, el.world.firstChild);

  el.zoomIn.onclick = () => zoomBy(1.25);
  el.zoomOut.onclick = () => zoomBy(0.8);
  el.zoomReset.onclick = () => {
    // 优先定位「进行中」（生成中 → 排队最前），没有进行中任务时才回到最新卡片
    if (!goActive()) {
      goLatest();
      toast('当前没有进行中的任务，已定位到最新卡片');
    }
  };
  el.zoomReset.title = '定位进行中（无则最新）';
  el.zoomReset.setAttribute('aria-label', '定位进行中任务');
  /* 画布工具 FAB：把 5 个纯图标动作收进一个带文字的菜单 */
  {
    const fabBtn = $('btnCanvasTools'), ctMenu = $('ctMenu');
    if (fabBtn && ctMenu) {
      const setMenu = open => {
        ctMenu.hidden = !open;
        fabBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      fabBtn.onclick = e => { e.stopPropagation(); setMenu(ctMenu.hidden); };
      ctMenu.addEventListener('click', () => setMenu(false));
      document.addEventListener('pointerdown', e => {
        if (ctMenu.hidden) return;
        if (!ctMenu.contains(e.target) && !fabBtn.contains(e.target)) setMenu(false);
      });
    }
    document.querySelectorAll('#ctMenu [data-proxy-click]').forEach(btn => {
      btn.onclick = () => {
        const target = $(btn.getAttribute('data-proxy-click'));
        if (target) target.click();
      };
    });
    const linksHudBtn = $('btnCanvasLinks');
    if (linksHudBtn) linksHudBtn.onclick = () => {
      if (!el.linkToggle) return;
      el.linkToggle.checked = !el.linkToggle.checked;
      el.linkToggle.dispatchEvent(new Event('change'));
    };
    if (el.zoomVal) el.zoomVal.onclick = () => {
      zoomAnimate(1, el.canvas.clientWidth / 2, el.canvas.clientHeight / 2);
    };
    const locateBtn = $('btnLocate');
    if (locateBtn) locateBtn.onclick = () => {
      if (!goActive()) { goLatest(); toast('当前没有进行中的任务，已定位到最新卡片'); }
    };
  }
  {
    const stopBtnEl = document.getElementById('btnStopQueued');
    if (stopBtnEl) stopBtnEl.onclick = async () => {
      if (!(await uiConfirm({ title:'终止排队中的任务', message:'只影响「尚未开始生成」的任务，已开始生成的会继续完成。', confirmText:'确定终止', danger:true }))) return;
      abortQueuedTasks();
    };
  }
  el.btnFitAll.onclick = () => {
    const entries = Object.keys(state.taskEls).map(id => state.taskEls[id]).filter(t => t && t.card);
    if (!entries.length) { toast('画布为空，没有可适应的卡片', 'err'); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    entries.forEach(t => {
      const x = parseFloat(t.card.style.left) || 0;
      const y = parseFloat(t.card.style.top) || 0;
      const h = t.card.offsetHeight || CARD_H_EST;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + CARD_W); maxY = Math.max(maxY, y + h);
    });
    const pad = 24;
    const cw = el.canvas.clientWidth, ch = el.canvas.clientHeight;
    const bw = Math.max(1, maxX - minX + pad * 2), bh = Math.max(1, maxY - minY + pad * 2);
    const z = clamp(Math.min(cw / bw, ch / bh), 0.3, 1);
    state.view.z = z;
    state.view.x = cw / 2 - ((minX + maxX) / 2) * z;
    state.view.y = ch / 2 - ((minY + maxY) / 2) * z;
    applyView();
    toast('⛶ 已适应全部卡片', 'ok');
  };
  el.btnArrange.onclick = () => {
    const entries = Object.keys(state.taskEls).map(id => state.taskEls[id]).sort((a, b) => a.task.id - b.task.id);
    if (!entries.length) { toast('画布为空，没有可整理的卡片', 'err'); return; }
    const cols = colCount();
    const colH2 = new Array(cols).fill(0);
    entries.forEach(t => {
      let ci = 0;
      for (let i = 1; i < cols; i++) if (colH2[i] < colH2[ci]) ci = i;
      const x = PAD + ci * (CARD_W + CARD_GAP), y = PAD + colH2[ci];
      t.card.style.left = x + 'px';
      t.card.style.top = y + 'px';
      const media = t.card.querySelector('.c-img, .c-video');
      const mediaH = media && media.naturalHeight && media.naturalWidth ? Math.round(CARD_W * media.naturalHeight / media.naturalWidth) : (t.task.mediaType === 'video' ? Math.round(CARD_W * 9 / 16) : CARD_H_EST);
      const extra = (t.task.state === 'done' || t.task.state === 'archived') ? 66 : 36;
      colH2[ci] = y + mediaH + extra + CARD_GAP;
    });
    state.colH.length = 0; state.colH.push(...colH2); // colH 是 const 数组，禁止整体赋值（原代码在严格模式下会抛 TypeError）
    updateLinks();
    scheduleAutosave(); // 自动整理的布局落盘，刷新后保持
    toast('🧹 已整理 ' + entries.length + ' 张卡片', 'ok');
  };


  setInterval(() => {
    // 进行中卡片每秒刷新阶段文案与计时（单一全局定时器，无任务时开销可忽略）
    Object.keys(state.taskEls).forEach(id => {
      const t = state.taskEls[id];
      if (!t || !t.card || !t.task) return;
      const task = t.task;
      if (task.state !== 'running' && task.state !== 'pending') return;
      const stageEl = t.card.querySelector('.stage');
      if (stageEl) stageEl.textContent = stageText(task);
      const q = t.card.querySelector('.elapsed');
      if (!q) return;
      const secs = Math.max(0, Math.round((Date.now() - (task.startTs || Date.now())) / 1000));
      q.textContent = task.state === 'running' ? ('已用时 ' + secs + 's') : ('已等待 ' + secs + 's');
    });
  }, 1000);

  /* ===== 卡片手势：拖拽 / 点击 / 长按 / 双指缩放 ===== */


  /* 画布空白区：pan / 捏合 */
  el.canvas.addEventListener('scroll', () => {
    if (el.canvas.scrollLeft || el.canvas.scrollTop) {
      el.canvas.scrollLeft = 0;
      el.canvas.scrollTop = 0;
    }
  });
  el.canvas.addEventListener('pointerdown', e => {
    if (e.target.closest('.c-card') || e.target.closest('.canvas-tools')) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, card: false });
    if (state.pointers.size === 1) {
      state.moved = false;
      state.panStart = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
    } else if (state.pointers.size === 2) {
      const pts = Array.from(state.pointers.values());
      state.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      state.pinchStart = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, z: state.view.z };
    }
  });
  el.canvas.addEventListener('pointermove', e => {
    const it = state.pointers.get(e.pointerId);
    if (!it) return;
    // 保留 card 标记：卡片冒泡上来的事件曾被覆盖成 card:false，导致捏合后单指无法恢复拖卡
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, card: it.card });
    if (state.pointers.size === 2) {
      const pts = Array.from(state.pointers.values());
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (state.pinchDist > 0 && state.pinchStart) {
        // 平方根衰减：手指张开2倍距离只缩放约1.4倍，缩放更平缓可控
        const k = Math.pow(d / state.pinchDist, 0.5);
        state.view.z = clamp(state.pinchStart.z * k, 0.3, 2.5);
        const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
        state.view.x = cx - (cx - state.view.x) * (state.view.z / state.pinchStart.z);
        state.view.y = cy - (cy - state.view.y) * (state.view.z / state.pinchStart.z);
        applyView();
      }
      return;
    }
    if (state.panStart && state.pointers.size === 1) {
      state.view.x = state.panStart.vx + (e.clientX - state.panStart.x);
      state.view.y = state.panStart.vy + (e.clientY - state.panStart.y);
      applyView();
    }
  });
  el.canvas.addEventListener('pointerup', endCanvasPointer);
  el.canvas.addEventListener('pointercancel', endCanvasPointer);
  // 桌面端鼠标滚轮缩放（移动端触摸已覆盖；passive:false 以阻止页面滚动）
  el.canvas.addEventListener('wheel', e => {
    if (e.target.closest('.c-card') || e.target.closest('.canvas-tools')) return;
    e.preventDefault();
    const rect = el.canvas.getBoundingClientRect();
    zoomAnimate(clamp(state.view.z * Math.pow(1.0015, -e.deltaY), 0.3, 2.5), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  /* ===== 点击卡片 → 预览 ===== */
  el.previewClose.onclick = closePreview;
  el.preview.addEventListener('click', e => { if (e.target === el.preview) closePreview(); });

  el.pvDl.onclick = async () => {
    if (state.previewTask) {
      const entry = state.previewTask;
      const task = entry.task;
      const ri = getTaskResult(entry);
      const isVideo = task.mediaType === 'video';
      if (!ri) { toast('没有可下载的' + (isVideo ? '视频' : '图片'), 'err'); return; }
      const index = getTaskResultIndex(entry) + 1;
      const ext = isVideo ? (mimeToExt(ri.blob && ri.blob.type || task.videoMime || 'video/mp4') || 'mp4') : mimeToExt(ri.blob && ri.blob.type);
      const name = (isVideo ? 'ai_video_' : 'ai_result_') + Date.now() + '_t' + task.id + '_r' + index + '.' + ext;
      if (ri.blob) downloadBlob(ri.blob, name, isVideo ? null : taskMeta(task));
      else if (ri.url && /^https?:/i.test(ri.url)) downloadRemote(ri.url, name.replace(/\.[^.]+$/, ''), isVideo ? null : taskMeta(task), el.pvDl);
      else if (ri.url) { const a = document.createElement('a'); a.href = ri.url; a.target = '_blank'; a.rel = 'noopener'; a.download = name; a.click(); }
      else toast('没有可下载的' + (isVideo ? '视频' : '图片'), 'err');
      return;
    }
    if (state.libDetail) {
      const meta = { p: state.libDetail.prompt || '', n: state.libDetail.negative || '', m: state.libDetail.model || '', s: state.libDetail.size || '', d: state.libDetail.mode || '', t: state.libDetail.ts || '' };
      const isVideoHist = state.libDetail.mediaType === 'video';
      const histPrefix = isVideoHist ? '历史视频_' : '历史原图_';
      const histExt = mimeToExt(state.libDetailBlob && state.libDetailBlob.type || (isVideoHist ? 'video/mp4' : 'image/png')) || (isVideoHist ? 'mp4' : 'png');
      if (state.libDetailBlob) downloadBlob(state.libDetailBlob, histPrefix + Date.now() + '.' + histExt, isVideoHist ? null : meta);
      else if (state.libDetail.origUrl && /^https?:/i.test(state.libDetail.origUrl)) downloadRemote(state.libDetail.origUrl, histPrefix + Date.now(), isVideoHist ? null : meta, el.pvDl);
      else if (state.libDetail.origUrl) { const a = document.createElement('a'); a.href = state.libDetail.origUrl; a.target = '_blank'; a.rel = 'noopener'; a.click(); }
      else toast('没有可下载的' + (isVideoHist ? '视频' : '原图'), 'err');
    }
  };
  // 「设为参考」防重复：远程下载期间忽略后续点击，避免并发下载导致突然连加多图
  el.pvRef.onclick = async () => {
    if (state.refBusy) return;
    if (state.previewTask) {
      if (state.previewTask.task.mediaType === 'video') { toast('视频结果不能作为图片参考图', 'err'); return; }
      const ri = getTaskResult(state.previewTask);
      if (!ri) { toast('没有可设为参考图的图片', 'err'); return; }
      let blob = ri.blob;
      if (!blob && ri.url) {
        // 远程 URL 图需走代理下载（大图较慢）：禁用按钮 + 显示加载提示
        state.refBusy = true;
        const btn = el.pvRef;
        const oldText = (btn.querySelector('.lbl') || btn).textContent;
        btn.disabled = true;
        (btn.querySelector('.lbl') || btn).textContent = '加载中…';
        toast('⏳ 正在下载原图（较大，请稍候）…', 'loading');
        try {
          blob = await fetch(getRequestUrl(ri.url)).then(r => r.blob());
        } catch (e) {
          toast('无法获取图片数据', 'err');
          btn.disabled = false; (btn.querySelector('.lbl') || btn).textContent = oldText; state.refBusy = false;
          return;
        }
        btn.disabled = false; (btn.querySelector('.lbl') || btn).textContent = oldText; state.refBusy = false;
      }
      if (!blob) { toast('无法获取图片数据', 'err'); return; }
      const ok = await addRefFromBlob(blob, '画布结果_' + state.previewTask.task.id + '.' + mimeToExt(blob.type));
      closePreview();
      toast(ok ? '✅ 已设为参考图（图生图模式）' : '❌ 参考图已达上限，未添加', ok ? 'ok' : 'err');
      return;
    }
    if (state.libDetail) {
      if (state.libDetailBlob) {
        const ok = await addRefFromBlob(state.libDetailBlob, '素材_' + Date.now() + '.' + mimeToExt(state.libDetailBlob.type));
        closePreview();
        toast(ok ? '✅ 已设为参考图' : '❌ 参考图已达上限，未添加', ok ? 'ok' : 'err');
        return;
      }
      if (state.libDetail.origUrl) {
        // 远程 URL 图：同样防重复 + 加载提示
        state.refBusy = true;
        const btn = el.pvRef;
        const oldText = (btn.querySelector('.lbl') || btn).textContent;
        btn.disabled = true;
        (btn.querySelector('.lbl') || btn).textContent = '加载中…';
        toast('⏳ 正在下载原图（较大，请稍候）…', 'loading');
        fetch(getRequestUrl(state.libDetail.origUrl)).then(r => r.blob()).then(async b => {
          const ok = await addRefFromBlob(b, '素材_' + Date.now() + '.' + mimeToExt(b.type));
          closePreview();
          toast(ok ? '✅ 已设为参考图' : '❌ 参考图已达上限，未添加', ok ? 'ok' : 'err');
        }).catch(() => toast('无法获取图片数据', 'err')).finally(() => {
          btn.disabled = false; (btn.querySelector('.lbl') || btn).textContent = oldText; state.refBusy = false;
        });
        return;
      }
      toast('该素材没有可用的原图', 'err');
    }
  };
  el.pvReuse.onclick = () => {
    if (state.previewTask) {
      reuseTask(state.previewTask.task);
      closePreview();
      return;
    }
    if (state.libDetail) {
      el.prompt.value = state.libDetail.prompt || '';
      el.negative.value = state.libDetail.negative || '';
      autosize();
      syncQuickRow();
      closePreview();
      toast(state.libDetail.negative ? '✅ 已回填正向 + 负面提示词' : '✅ 已回填提示词', 'ok');
    }
  };

  /* ===== 长按菜单 ===== */
  el.ctx.addEventListener('pointerdown', e => e.stopPropagation());
  document.addEventListener('pointerdown', e => {
    if (!el.ctx.classList.contains('open')) return;
    if (!e.target.closest('.ctx')) closeCtx();
  });

  /* ================= 批量比例 ================= */

  /* ================= 任务系统 ================= */
  /* ================= 超生成 ================= */
  if (el.ogMode) {
    el.ogMode.addEventListener('change', () => {
      if (el.ogMode.checked && el.batchMode && el.batchMode.checked) el.batchMode.checked = false;
      updateOgFields();
      updateOvershootUI();
    });
  }
  if (el.batchMode) {
    el.batchMode.addEventListener('change', () => {
      if (el.batchMode.checked && el.ogMode && el.ogMode.checked) { el.ogMode.checked = false; updateOgFields(); }
    });
  }
  if (el.ogAct) el.ogAct.onclick = () => overshootAction();

  /* 参考图可用性自检：切后台 / 系统回收可能让 File 句柄失效，
     此时提交只会空等到超时，故在生成前先本地解码验证。 */
  function decodeRefOk(file, timeoutMs) {
    return new Promise(resolve => {
      let done = false, url = '';
      const finish = ok => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { if (url) URL.revokeObjectURL(url); } catch (e) { }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs || 3000);
      try { url = URL.createObjectURL(file); } catch (e) { finish(false); return; }
      const img = new Image();
      img.onload = () => finish(img.naturalWidth > 0 && img.naturalHeight > 0);
      img.onerror = () => finish(false);
      img.src = url;
    });
  }
  async function findInvalidRefs() {
    const bad = [];
    for (let i = 0; i < state.currentFiles.length; i++) {
      const item = state.currentFiles[i];
      const file = item && item.file;
      if (!file || !file.size) { bad.push(i); continue; }
      if (!(await decodeRefOk(file, 3000))) bad.push(i);
    }
    return bad;
  }
  function markInvalidRefs(bad) {
    bad.forEach(i => { const it = state.currentFiles[i]; if (it) it.invalid = true; });
    renderRefStrip();
    toast('⚠️ 参考图第 ' + bad.map(i => i + 1).join('、') + ' 张已失效（切到后台后本地图片可能被系统回收）。请删掉后重新添加，再点生成', 'err');
  }

  function doGenerate() {
    const key = el.apiKey.value.trim();
    const baseUrl = el.apiBase.value.trim().replace(/\/+$/, '');
    const prompt = el.prompt.value.trim();
    const isVideo = state.currentMode === 'video';
    if (!key) { toast('请先填写' + (isVideo ? '视频' : '生图') + ' API Key（设置 ⚙️）', 'err'); closeDrawers(); openDrawer('settings'); return; }
    if (!baseUrl) { toast('请先填写' + (isVideo ? '视频' : '生图') + ' Base URL（设置 ⚙️）', 'err'); closeDrawers(); openDrawer('settings'); return; }
    const localApiHint = localApiProxyHint(baseUrl);
    if (localApiHint) { toast('⚠️ ' + localApiHint, 'err'); closeDrawers(); openDrawer('settings'); return; }
    if (!prompt) { toast('请先描述' + (isVideo ? '视频' : '画面') + '（输入提示词）', 'err'); el.prompt.focus(); return; }

    if (isVideo) {
      const model = getSelectedVideoModel();
      if (!model) { toast('请填写或选择视频模型', 'err'); closeDrawers(); openDrawer('settings'); return; }
      const videoCaps = getVideoCapabilities();
      if (state.videoMode === 'img2video' && !state.currentFiles.length) { toast('图片生视频模式需要先添加参考图', 'err'); return; }
      const maxVideoRefs = Math.max(1, Number(videoCaps.maxReferences) || MAX_REFS);
      if (state.videoMode === 'img2video' && state.currentFiles.length > maxVideoRefs) { toast('参考图超过当前视频能力上限 ' + maxVideoRefs + ' 张', 'err'); return; }
      pushRecent(prompt);
      const videoTask = buildVideoTaskFromForm();
      const parent = state.pendingParentArmed ? state.pendingParent : null;
      state.pendingParent = null;
      state.pendingParentArmed = false;
      if (parent) { videoTask.parentId = parent.id; videoTask.relation = parent.rel; }
      el.canvasEmpty.classList.add('hide');
      enqueueTask(videoTask);
      toast('视频任务 #' + videoTask.id + ' 已提交后台', 'ok');
      return;
    }

    const model = getSelectedImageModel();
    const size = state.selectedSize;
    const imageCaps = getImageModelCapabilities(model);
    const n = Math.max(1, Math.min(4, parseInt(el.count.value) || 1));
    if (!model) { toast('请填写或选择生图模型', 'err'); closeDrawers(); openDrawer('settings'); return; }
    if (state.currentMode === 'img2img' && !state.currentFiles.length) { toast('图生图模式需要先添加参考图', 'err'); return; }
    if (state.currentMode === 'img2img' && state.currentFiles.length > getMaxReferences()) { toast('参考图超过当前预设上限 ' + getMaxReferences() + ' 张', 'err'); return; }
    const m = /^(\d+)x(\d+)$/.exec(size);
    if (m && (+m[1]) * (+m[2]) > getCapNum('maxPixels', MAX_PIXELS)) { toast('⚠️ 尺寸总像素超过当前供应商上限', 'err'); return; }
    pushRecent(prompt);
    const baseOpts = {
      mode: state.currentMode,
      files: state.currentFiles.map(f => ({ file: f.file, role: f.role || 'none' })),
      prompt, negative: el.negative.value.trim(),
      preset: el.providerPreset.value, capabilities: imageCaps,
      model, n, base: baseUrl, key, resolution: state.currentResolution, imageSizeMode:state.currentImageSizeMode || 'preset',
      quality: state.currentQuality, complexity:el.complexity && !el.complexity.disabled ? el.complexity.value : '', background: state.currentBg, outputFormat: state.currentFmt,
      responseFormat: el.responseFormat ? el.responseFormat.value : '',
      stream: !!(el.streamMode && el.streamMode.value === '1' && state.currentMode !== 'img2img')
    };
    if (el.ogMode && el.ogMode.checked) {
      const attempts = parseInt(el.ogAttempts.value, 10) || 20;
      const target = parseInt(el.ogTarget.value, 10) || 5;
      const parent = state.pendingParentArmed ? state.pendingParent : null;
      state.pendingParent = null;
      state.pendingParentArmed = false;
      const og = startOvershoot({ baseOpts, size, attempts, target, parentId: parent ? parent.id : null, relation: parent ? parent.rel : null });
      if (!og || !og.ok) return;
      el.canvasEmpty.classList.add('hide');
      toast('🎯超生成已启动：最多尝试 ' + og.attempts + '张，目标成功 ' + og.target + '张；达标后自动终止剩余排队', 'ok');
      return;
    }
    if (el.batchMode.checked) {
      const ratios = Array.from(state.batchRatios);
      if (ratios.length < 2) { toast('批量模式请至少勾选 2 个比例', 'err'); return; }
      const validRatios = [], skippedRatios = [];
      ratios.forEach(r => {
        const ratio = getImageRatios().find(x => x.r === r);
        if (ratio && ratio.v[state.currentTier]) validRatios.push(r); else skippedRatios.push(r);
      });
      if (validRatios.length < 2) {
        toast('批量模式至少需要 2 个在当前档位 ' + state.currentTier + ' 下有可用尺寸的比例' + (skippedRatios.length ? '（不支持：' + skippedRatios.join('、') + '）' : ''), 'err');
        return;
      }
      const parent = state.pendingParentArmed ? state.pendingParent : null;
      state.pendingParent = null;
      state.pendingParentArmed = false;
      validRatios.forEach(r => {
        const ratio = getImageRatios().find(x => x.r === r);
        enqueueTask(buildTask({ ...baseOpts, size: getSizeVal(ratio), imageSizeMode:'preset', n: 1, parentId: parent ? parent.id : null, relation: parent ? parent.rel : null }));
      });
      el.canvasEmpty.classList.add('hide');
      toast('✅ 批量任务已入队：' + validRatios.join('、') + '（' + validRatios.length + ' 个）' + (skippedRatios.length ? ' 已跳过不支持比例：' + skippedRatios.join('、') : ''), 'ok');
      return;
    }
    el.canvasEmpty.classList.add('hide');
    const parent = state.pendingParentArmed ? state.pendingParent : null;
    state.pendingParent = null;
    state.pendingParentArmed = false;
    const task = enqueueTask(buildTask({ ...baseOpts, size, parentId: parent ? parent.id : null, relation: parent ? parent.rel : null }));
    toast('任务 #' + task.id + ' 已提交后台', 'ok');
  }

  el.btnGen.onclick = async () => {
    if (el.btnGen.disabled || state.genBusy) return;
    state.genBusy = true;
    el.btnGen.disabled = true;
    try {
      if (state.currentMode === 'img2img' && state.currentFiles.length) {
        const bad = await findInvalidRefs();
        if (bad.length) { markInvalidRefs(bad); return; }
      }
      doGenerate();
    } finally {
      state.genBusy = false;
      setTimeout(() => { el.btnGen.disabled = false; }, 300);
    }
  };

  /* 页签回到前台：核对参考图是否仍可读，提前暴露「点生成后才失败」的问题 */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.currentFiles.length) return;
    findInvalidRefs().then(bad => {
      if (!bad.length) return;
      bad.forEach(i => { const it = state.currentFiles[i]; if (it) it.invalid = true; });
      renderRefStrip();
      toast('⚠️ 有 ' + bad.length + ' 张参考图在后台被系统回收，已标记为失效，请替换后再生成', 'err');
    }).catch(() => { });
  });

  /* ================= 画布持久化（刷新自动恢复） ================= */

  /* ================= 下载 ================= */


  /* ================= 历史 / 素材库 ================= */

  el.histSearch.addEventListener('input', () => { state.histQuery = el.histSearch.value; renderLib(); });
  el.histFavOnly.addEventListener('change', () => { state.histFavOnly = el.histFavOnly.checked; renderLib(); });
  /* ================= 画布工程文件（实现见 canvasProject.js） ================= */
  el.btnExportCanvas.onclick = exportCanvasProject;
  el.btnImportCanvas.onclick = ()=> el.canvasImportFile.click();
  el.canvasImportFile.onchange = importCanvasProject;

  /* ===== 画布批量清理 ===== */
  el.btnClearCanvas.onclick = clearCanvas;
  el.btnClearByState.onclick = clearByState;

  el.btnClearHist.onclick = async () => {
    const hist = lsGet(LS_HIST, []);
    if (!hist.length) { toast('素材库已经是空的', 'ok'); return; }
    if (!(await uiConfirm({ title:'清空历史素材库', message:'将清空全部已保存的本地历史素材，此操作无法撤销。', confirmText:'清空素材库', danger:true }))) return;
    hist.forEach(r => { if (r && r.origType === 'idb') idbDel(r.id); });
    localStorage.removeItem(LS_HIST);
    renderLib();
    toast('已清空素材库', 'ok');
  };

  /* ================= 画布总览（实现见 canvasProject.js） ================= */
  el.btnOverview.onclick = ()=> openDrawer('overview');
  const linksOn = localStorage.getItem('img2img_links_v1') !== '0';
  el.linkToggle.checked = linksOn;
  state.linkLayer.style.display = linksOn ? '' : 'none';
  el.linkToggle.onchange = () => {
    localStorage.setItem('img2img_links_v1', el.linkToggle.checked ? '1' : '0');
    state.linkLayer.style.display = el.linkToggle.checked ? '' : 'none';
    syncTopbarHud();
  };

  /* ================= 键盘与无障碍 ================= */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const dlg = $('appDialogModal');
      if (dlg && dlg.classList.contains('open')) { closeAppDialog(); return; }
      closeDockPopover();
      closePromptEditor();
      closeDrawers();
      closePreview();
      closeDetail();
      closeNameModal();
      closeSheet();
      if (el.paintWrap && el.paintWrap.classList.contains('open')) closePaint();
      closeCtx();
      if (el.visionPickModal) el.visionPickModal.classList.remove('open');
      { const __cs = document.getElementById('consoleSheet'); if (__cs) __cs.classList.remove('open'); const __cb = document.getElementById('btnConsole'); if (__cb) __cb.setAttribute('aria-expanded', 'false'); }
    }
  });

  /* ================= 初始化 ================= */
  async function init() {
    bindBoot();
    initStudioDecor();
    const serverOk = await ensureServer();
    if (!serverOk) {
      showBootBlock();
      return;
    }
    const taskApiOk = await ensureTaskApi();
    if (!taskApiOk) {
      showTaskApiUnavailable();
      return;
    }
    hideBootBlock();
    initDropAndPaste();
    initPreviewEnhancements();
    initPaintCursor();
    renderTierTabs();
    renderSizes();
    renderQuickChips();
    renderRecentChips();
    renderPresetSelect();
    renderBatchChips();
    presetBatchFromSize(state.selectedSize);
    syncQuickRow();
    setMode('img2img');
    await loadProviderConfig();
    loadCfg();
    syncImageParamOptions();
    renderVideoParams();
    loadApiProfiles();
    await loadProxyStatus();
    bindLiveModelRefresh();
    bindUsageRefresh();
    await maybeRefreshLiveModels(true);
    syncQuickRow();
    el.prompt.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); el.btnGen.click(); }
    });
    autosize();
    updateEmpty();
    await restoreCanvas(); // 刷新后自动恢复画布（布局/参数/连线/原图）
    state.taskApi.restored = true;
    scheduleAutosave();
    checkOvershoot(); // 超生成：恢复状态条；若已达标则兜底终止剩余排队
    syncTopbarHud();
    goLatest(); // 必须在 restoreCanvas 之后定位，避免初始化时把空画布写回 localStorage
    window.addEventListener('resize', () => { applyView(); rebuildColumns(); syncTopbarHud(); });
    if (window.visualViewport) {
      // 软键盘弹出时把底部坞/抽屉/面板抬到键盘上方（--kb-h 注入底部 padding）
      window.visualViewport.addEventListener('resize', () => {
        const kb = Math.max(0, window.innerHeight - window.visualViewport.height);
        document.documentElement.style.setProperty('--kb-h', kb + 'px');
      });
    }
  }
  // 初始化兜底：任一 await 抛错都不再白屏无提示（原先是 init(); 裸调用）
  init().catch(err => {
    console.error('[init]', err);
    try { showBootBlock(); } catch (e) { }
    try {
      const hint = document.querySelector('.boot-hint');
      if (hint) hint.textContent = '初始化失败：' + ((err && err.message) || err) +
        '　｜　可先刷新页面重试；若反复出现，请查看浏览器控制台或重开服务器。';
    } catch (e) { }
  });
})();
