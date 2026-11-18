import { ICO } from './icons.js';
import { TIERS, QUICK_FILLS, LS_RECENT, REFERENCE_ROLES, REL_LABELS, OV_STATE, VIDEO_SECONDS, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS } from './state.js';
import { toast, escapeHtml, lsGet } from './util.js';
import { getSelectedImageModel, getSelectedVideoModel, getImageRatios, getSizeVal, getImageModelCapabilities, getVideoCapabilities, syncGifHint } from './settings.js';
import { findImageSize } from './imageSizes.js';

let state = null, el = null, hooks = {};

export function bindStudioRuntime(s, e, h){
  state = s;
  el = e;
  hooks = h || {};
}

/* ================= 1. 定制品牌与空态 SVG 插画 ================= */
export function buildCatMascotSvg(uid){
  const gid = 'catWarmGrad_' + String(uid || 'main').replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    '<svg class="cat-svg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs><linearGradient id="' + gid + '" x1="8" y1="6" x2="56" y2="60" gradientUnits="userSpaceOnUse">' +
        '<stop offset="0%" stop-color="#FDE3CE"/><stop offset="100%" stop-color="#F6B88D"/></linearGradient></defs>' +
      '<circle cx="32" cy="32" r="30" fill="#FDE3CE"/>' +
      '<circle cx="32" cy="32" r="30" fill="url(#' + gid + ')"/>' +
      '<path d="M16 27L13 11L25 19" fill="#FFF7F0" stroke="#47362D" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<path d="M48 27L51 11L39 19" fill="#FFF7F0" stroke="#47362D" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<path d="M16.5 23L15.2 14.8L22.2 19.6Z" fill="#F29B74"/>' +
      '<path d="M47.5 23L48.8 14.8L41.8 19.6Z" fill="#F29B74"/>' +
      '<ellipse cx="32" cy="36" rx="19" ry="16" fill="#FFF9F3" stroke="#47362D" stroke-width="2.4"/>' +
      '<path d="M29.5 21.5V25M34.5 21.5V25" stroke="#EF8558" stroke-width="2.2" stroke-linecap="round"/>' +
      '<g class="cat-eyes">' +
        '<circle cx="24.5" cy="34" r="2.6" fill="#3A2E28"/><circle cx="23.7" cy="33.1" r="0.9" fill="#FFF"/>' +
        '<circle cx="39.5" cy="34" r="2.6" fill="#3A2E28"/><circle cx="38.7" cy="33.1" r="0.9" fill="#FFF"/>' +
      '</g>' +
      '<ellipse cx="20.5" cy="38.5" rx="3.2" ry="1.8" fill="#F6A68E" opacity="0.65"/>' +
      '<ellipse cx="43.5" cy="38.5" rx="3.2" ry="1.8" fill="#F6A68E" opacity="0.65"/>' +
      '<path d="M30.4 37.8L33.6 37.8L32 39.8Z" fill="#EF8558"/>' +
      '<path d="M28.5 41.2C29.8 42.6 31.2 42.2 32 40.4C32.8 42.2 34.2 42.6 35.5 41.2" stroke="#47362D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="51" cy="49" r="6" fill="#EF8558" stroke="#FFF9F3" stroke-width="2"/>' +
      '<path d="M48.5 49.5L53.2 46.8" stroke="#FFF9F3" stroke-width="1.8" stroke-linecap="round"/>' +
    '</svg>'
  );
}
export const CAT_MASCOT_SVG = buildCatMascotSvg('main');

export const EMPTY_CANVAS_SVG =
  '<svg viewBox="0 0 260 210" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<defs>' +
      '<linearGradient id="ecCard1" x1="48" y1="28" x2="188" y2="162" gradientUnits="userSpaceOnUse">' +
        '<stop offset="0%" stop-color="#FFFFFF"/><stop offset="100%" stop-color="#FAF0E4"/>' +
      '</linearGradient>' +
      '<linearGradient id="ecSun" x1="88" y1="62" x2="162" y2="128" gradientUnits="userSpaceOnUse">' +
        '<stop offset="0%" stop-color="#F9AF86"/><stop offset="100%" stop-color="#EF8558"/>' +
      '</linearGradient>' +
    '</defs>' +
    '<ellipse cx="130" cy="182" rx="88" ry="12" fill="#E8D8C6" opacity="0.55"/>' +
    '<rect x="44" y="42" width="112" height="128" rx="16" transform="rotate(-7 44 42)" fill="#F3E6D7" stroke="#D9C5B2" stroke-width="2"/>' +
    '<rect x="70" y="34" width="136" height="132" rx="18" fill="url(#ecCard1)" stroke="#D4BEAA" stroke-width="2.2"/>' +
    '<rect x="82" y="47" width="112" height="84" rx="12" fill="#FBF5EE" stroke="#E8D8C7" stroke-width="1.5"/>' +
    '<circle cx="116" cy="79" r="14" fill="url(#ecSun)" opacity="0.9"/>' +
    '<path d="M84 121L112 95L133 114L154 91L192 124V129H84V121Z" fill="#7FB49B" opacity="0.72"/>' +
    '<path d="M98 148H166" stroke="#D5C3B3" stroke-width="4.5" stroke-linecap="round"/>' +
    '<path d="M98 158H138" stroke="#E6D7C8" stroke-width="3.5" stroke-linecap="round"/>' +
    '<g class="ec-float">' +
      '<path d="M214 54L217 61L224 64L217 67L214 74L211 67L204 64L211 61Z" fill="#EF8558"/>' +
      '<path d="M40 94L42 99L47 101L42 103L40 108L38 103L33 101L38 99Z" fill="#7FB49B"/>' +
    '</g>' +
    '<g transform="translate(154,108)">' +
      '<path d="M12 20L9 5L21 13" fill="#FFF9F3" stroke="#47362D" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<path d="M44 20L47 5L35 13" fill="#FFF9F3" stroke="#47362D" stroke-width="2.2" stroke-linejoin="round"/>' +
      '<path d="M13 16L11.5 9L18 13.5Z" fill="#F29B74"/>' +
      '<path d="M43 16L44.5 9L38 13.5Z" fill="#F29B74"/>' +
      '<ellipse cx="28" cy="28" rx="18" ry="15" fill="#FFF9F3" stroke="#47362D" stroke-width="2.2"/>' +
      '<circle cx="21.5" cy="26.5" r="2.1" fill="#3A2E28"/>' +
      '<circle cx="34.5" cy="26.5" r="2.1" fill="#3A2E28"/>' +
      '<ellipse cx="18" cy="30" rx="2.6" ry="1.5" fill="#F6A68E" opacity="0.65"/>' +
      '<ellipse cx="38" cy="30" rx="2.6" ry="1.5" fill="#F6A68E" opacity="0.65"/>' +
      '<path d="M26.6 29.6H29.4L28 31.3Z" fill="#EF8558"/>' +
      '<path d="M25 32.5C26.2 33.7 27.3 33.4 28 32C28.7 33.4 29.8 33.7 31 32.5" stroke="#47362D" stroke-width="1.8" stroke-linecap="round"/>' +
    '</g>' +
  '</svg>';

export const EMPTY_STATE_SVG =
  '<svg class="empty-mini-svg" viewBox="0 0 120 96" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<rect x="20" y="18" width="62" height="58" rx="12" transform="rotate(-6 20 18)" fill="#F3E8DC" stroke="#DECBB8" stroke-width="1.8"/>' +
    '<rect x="34" y="14" width="66" height="62" rx="13" fill="#FFF" stroke="#D5C2B0" stroke-width="1.8"/>' +
    '<circle cx="54" cy="36" r="6" fill="#F6B28B"/>' +
    '<path d="M40 58L55 44L66 54L77 43L94 58V64H40Z" fill="#9BC6B1" opacity="0.75"/>' +
  '</svg>';

export function ratioFrameSvg(ratioStr){
  const parts = String(ratioStr || '1:1').split(':').map(Number);
  const rw = (parts[0] > 0 && parts[1] > 0) ? parts[0] : 1;
  const rh = (parts[0] > 0 && parts[1] > 0) ? parts[1] : 1;
  const box = 18;
  let w, h;
  if(rw >= rh){ w = box; h = Math.max(6, Math.round(box * (rh / rw))); }
  else { h = box; w = Math.max(6, Math.round(box * (rw / rh))); }
  const x = (24 - w) / 2, y = (24 - h) / 2;
  return '<svg class="ratio-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2.4" fill="currentColor" fill-opacity="0.14" stroke="currentColor" stroke-width="1.8"/></svg>';
}

/* ================= 2. 品牌自定义 Confirm / Prompt 对话框 ================= */
let dialogResolver = null;

function ensureDialogWired(){
  const modal = document.getElementById('appDialogModal');
  if(!modal || modal.dataset.wired) return modal;
  modal.dataset.wired = '1';
  const closeBtn = document.getElementById('appDialogClose');
  const cancelBtn = document.getElementById('appDialogCancel');
  const okBtn = document.getElementById('appDialogOk');
  const input = document.getElementById('appDialogInput');
  const finish = (val)=>{
    modal.classList.remove('open');
    const fn = dialogResolver;
    dialogResolver = null;
    if(fn) fn(val);
  };
  if(closeBtn) closeBtn.onclick = ()=> finish(modal.dataset.kind === 'prompt' ? null : (modal.dataset.withCheck ? { ok:false, checked:false } : false));
  if(cancelBtn) cancelBtn.onclick = ()=> finish(modal.dataset.kind === 'prompt' ? null : (modal.dataset.withCheck ? { ok:false, checked:false } : false));
  if(okBtn) okBtn.onclick = ()=>{
    if(modal.dataset.kind === 'prompt') finish(input ? input.value : '');
    else if(modal.dataset.withCheck){
      const chk = document.getElementById('appDialogCheck');
      finish({ ok:true, checked: !!(chk && chk.checked) });
    }else finish(true);
  };
  if(input) input.addEventListener('keydown', e=>{
    if(e.key === 'Enter'){ e.preventDefault(); if(okBtn) okBtn.click(); }
  });
  modal.addEventListener('click', e=>{
    if(e.target === modal && cancelBtn) cancelBtn.click();
  });
  return modal;
}

export function closeAppDialog(){
  const modal = document.getElementById('appDialogModal');
  if(!modal || !modal.classList.contains('open')) return;
  const cancelBtn = document.getElementById('appDialogCancel');
  if(cancelBtn) cancelBtn.click();
}

export function uiConfirm(opts){
  const cfg = typeof opts === 'string' ? { message: opts } : (opts || {});
  const modal = ensureDialogWired();
  if(!modal) return Promise.resolve(cfg.checkboxLabel ? { ok:true, checked:!!cfg.checkboxDefault } : true);
  if(dialogResolver){ const prev = dialogResolver; dialogResolver = null; prev(false); }
  modal.dataset.kind = 'confirm';
  modal.dataset.withCheck = cfg.checkboxLabel ? '1' : '';
  const iconEl = document.getElementById('appDialogIcon');
  const titleEl = document.getElementById('appDialogTitle');
  const msgEl = document.getElementById('appDialogMessage');
  const inpEl = document.getElementById('appDialogInput');
  const chkWrap = document.getElementById('appDialogCheckWrap');
  const chkEl = document.getElementById('appDialogCheck');
  const chkLbl = document.getElementById('appDialogCheckText');
  const okBtn = document.getElementById('appDialogOk');
  const cancelBtn = document.getElementById('appDialogCancel');
  if(iconEl){
    iconEl.className = 'dialog-ico ' + (cfg.danger ? 'danger' : 'warn');
    iconEl.innerHTML = cfg.danger ? ICO.trash : ICO.warn;
  }
  if(titleEl) titleEl.textContent = cfg.title || '确认操作';
  if(msgEl){ msgEl.textContent = cfg.message || ''; msgEl.style.display = cfg.message ? '' : 'none'; }
  if(inpEl) inpEl.style.display = 'none';
  if(chkWrap){
    chkWrap.style.display = cfg.checkboxLabel ? 'flex' : 'none';
    if(chkEl) chkEl.checked = !!cfg.checkboxDefault;
    if(chkLbl) chkLbl.textContent = cfg.checkboxLabel || '';
  }
  if(okBtn){
    okBtn.textContent = cfg.confirmText || '确定';
    okBtn.className = 'd-btn ' + (cfg.danger ? 'danger-solid' : 'primary');
  }
  if(cancelBtn) cancelBtn.textContent = cfg.cancelText || '取消';
  modal.classList.add('open');
  setTimeout(()=>{ if(okBtn) okBtn.focus(); }, 60);
  return new Promise(resolve=>{ dialogResolver = resolve; });
}

export function uiPrompt(opts){
  const cfg = typeof opts === 'string' ? { title: opts } : (opts || {});
  const modal = ensureDialogWired();
  if(!modal) return Promise.resolve(null);
  if(dialogResolver){ const prev = dialogResolver; dialogResolver = null; prev(null); }
  modal.dataset.kind = 'prompt';
  modal.dataset.withCheck = '';
  const iconEl = document.getElementById('appDialogIcon');
  const titleEl = document.getElementById('appDialogTitle');
  const msgEl = document.getElementById('appDialogMessage');
  const inpEl = document.getElementById('appDialogInput');
  const chkWrap = document.getElementById('appDialogCheckWrap');
  const okBtn = document.getElementById('appDialogOk');
  const cancelBtn = document.getElementById('appDialogCancel');
  if(iconEl){ iconEl.className = 'dialog-ico info'; iconEl.innerHTML = ICO.file; }
  if(titleEl) titleEl.textContent = cfg.title || '请输入';
  if(msgEl){ msgEl.textContent = cfg.message || ''; msgEl.style.display = cfg.message ? '' : 'none'; }
  if(chkWrap) chkWrap.style.display = 'none';
  if(inpEl){
    inpEl.style.display = '';
    inpEl.placeholder = cfg.placeholder || '';
    inpEl.value = cfg.defaultValue != null ? String(cfg.defaultValue) : '';
  }
  if(okBtn){
    okBtn.textContent = cfg.confirmText || '保存';
    okBtn.className = 'd-btn primary';
  }
  if(cancelBtn) cancelBtn.textContent = cfg.cancelText || '取消';
  modal.classList.add('open');
  setTimeout(()=>{ if(inpEl){ inpEl.focus(); inpEl.select(); } }, 80);
  return new Promise(resolve=>{ dialogResolver = resolve; });
}

/* ================= 3. 顶栏即时状态同步 ================= */
export function syncTopbarHud(){
  if(!state || !el) return;
  const subSwitch = document.getElementById('videoSubSwitch');
  if(subSwitch){
    const isVideo = state.currentMode === 'video';
    subSwitch.style.display = isVideo ? 'flex' : 'none';
    subSwitch.querySelectorAll('button').forEach(b=>{
      b.classList.toggle('active', b.dataset.vmode === (state.videoMode === 'img2video' ? 'img2video' : 'txt2video'));
    });
  }
  const topConnDot = document.getElementById('topConnDot');
  const topConnText = document.getElementById('topConnText');
  if(topConnDot && el.connDot){
    topConnDot.className = el.connDot.className;
  }
  if(topConnText){
    const model = state.currentMode === 'video' ? getSelectedVideoModel() : getSelectedImageModel();
    const rawConn = (el.connText && el.connText.textContent) || '未验证';
    if(model) topConnText.textContent = model.length > 18 ? model.slice(0, 17) + '…' : model;
    else topConnText.textContent = rawConn.split('·')[0].trim() || '未配置';
    topConnText.title = rawConn + (model ? (' · 当前模型：' + model) : '');
  }
  const qBtn = document.getElementById('btnTopQueue');
  const qBadge = document.getElementById('topQueueBadge');
  const qSpin = document.getElementById('topQueueSpin');
  if(qBtn && qBadge){
    let run = 0, pend = 0;
    Object.keys(state.taskEls || {}).forEach(id=>{
      const t = state.taskEls[id];
      if(!t || !t.task) return;
      if(t.task.state === 'running') run++;
      else if(t.task.state === 'pending') pend++;
    });
    const active = run + pend;
    qBadge.textContent = active ? String(active) : '0';
    qBtn.classList.toggle('busy', active > 0);
    if(qSpin) qSpin.style.display = run > 0 ? '' : 'none';
    qBtn.title = active ? ('进行中 ' + run + ' · 排队 ' + pend + '（点击打开任务总览）') : '任务与画布总览';
  }
  const linkHud = document.getElementById('btnCanvasLinks');
  if(linkHud && el.linkToggle){
    linkHud.classList.toggle('on', !!el.linkToggle.checked);
    linkHud.setAttribute('aria-pressed', el.linkToggle.checked ? 'true' : 'false');
  }
}

/* ================= 4. 底部创作坞即时悬浮面板（Popover） ================= */
let activePopover = null;
let popoverAnchorEl = null;

function positionPopover(){
  const pop = document.getElementById('dockPopover');
  const dock = document.querySelector('.dock');
  if(!pop || !dock || pop.hidden) return;
  if(!popoverAnchorEl){ pop.style.left = ''; pop.style.right = ''; return; }
  const dRect = dock.getBoundingClientRect();
  const aRect = popoverAnchorEl.getBoundingClientRect();
  const pW = pop.offsetWidth || 320;
  let left = (aRect.left + aRect.width / 2 - dRect.left) - pW / 2;
  left = Math.max(8, Math.min(dRect.width - pW - 8, left));
  pop.style.left = left + 'px';
  pop.style.right = 'auto';
}

export function closeDockPopover(){
  const pop = document.getElementById('dockPopover');
  if(!pop) return;
  pop.hidden = true;
  pop.innerHTML = '';
  document.querySelectorAll('.q-chip.pop-open, .act-btn.pop-open').forEach(b=> b.classList.remove('pop-open'));
  activePopover = null;
  popoverAnchorEl = null;
}

export function toggleDockPopover(kind, anchorEl){
  const pop = document.getElementById('dockPopover');
  if(!pop) return;
  if(activePopover === kind && !pop.hidden){ closeDockPopover(); return; }
  openDockPopover(kind, anchorEl);
}

export function openDockPopover(kind, anchorEl){
  const pop = document.getElementById('dockPopover');
  if(!pop) return;
  activePopover = kind;
  popoverAnchorEl = anchorEl || null;
  document.querySelectorAll('.q-chip.pop-open, .act-btn.pop-open').forEach(b=> b.classList.remove('pop-open'));
  if(anchorEl) anchorEl.classList.add('pop-open');

  pop.innerHTML = '';
  pop.className = 'dock-popover pop-' + kind;
  const head = document.createElement('div');
  head.className = 'dp-head';
  const titleSpan = document.createElement('b');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button'; closeBtn.className = 'dp-close'; closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.innerHTML = ICO.close;
  closeBtn.onclick = closeDockPopover;
  head.append(titleSpan, closeBtn);
  const body = document.createElement('div');
  body.className = 'dp-body';
  pop.append(head, body);

  const mkMore = (label, onClick)=>{
    const foot = document.createElement('div');
    foot.className = 'dp-foot';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dp-more';
    b.innerHTML = '<span>' + escapeHtml(label) + '</span>' + ICO.chevRight;
    b.onclick = ()=>{ closeDockPopover(); onClick(); };
    foot.appendChild(b);
    pop.appendChild(foot);
  };

  if(kind === 'tier'){
    titleSpan.textContent = '清晰度与像素档位';
    const caps = getImageModelCapabilities();
    const tiers = caps.imageSizePolicy === 'futureai-ratio' ? (caps.resolutionOptions || TIERS) : TIERS;
    const row = document.createElement('div'); row.className = 'dp-pills';
    tiers.forEach(t=>{
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dp-pill' + (t === state.currentTier ? ' active' : '');
      b.innerHTML = '<b>' + escapeHtml(t) + '</b><small>' + (t==='1K'?'快速轻量':t==='2K'?'均衡推荐':'超清细节') + '</small>';
      b.onclick = ()=>{
        const buttons = el.tierTabs ? Array.from(el.tierTabs.querySelectorAll('.tier-tab')) : [];
        const match = buttons.find(x=> x.textContent.trim() === t);
        if(match) match.click();
        openDockPopover('tier', anchorEl);
      };
      row.appendChild(b);
    });
    const note = document.createElement('div'); note.className = 'dp-note';
    note.textContent = (el.tierHint && el.tierHint.textContent) || ('当前尺寸：' + (state.selectedSize || '—'));
    body.append(row, note);
    mkMore('全部清晰度与质量参数', ()=> hooks.focusDrawer && hooks.focusDrawer('params', el.tierTabs));

  }else if(kind === 'ratio'){
    titleSpan.textContent = '选择画幅比例';
    const grid = document.createElement('div'); grid.className = 'dp-ratio-grid';
    getImageRatios().forEach(s=>{
      const v = getSizeVal(s);
      if(!v) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dp-ratio-opt' + (v === state.selectedSize ? ' active' : '');
      b.innerHTML = ratioFrameSvg(s.r) + '<b>' + escapeHtml(s.r) + '</b><span>' + escapeHtml(s.d) + '</span>';
      b.onclick = ()=>{
        const btns = el.sizeGrid ? Array.from(el.sizeGrid.querySelectorAll('.size-opt')) : [];
        const target = btns.find(x=> x.querySelector('.r') && x.querySelector('.r').textContent === s.r);
        if(target) target.click();
        openDockPopover('ratio', anchorEl);
      };
      grid.appendChild(b);
    });
    const customRow = document.createElement('div'); customRow.className = 'dp-custom-row';
    const cInp = document.createElement('input');
    cInp.className = 'inp'; cInp.placeholder = '自定义像素（如 1024x1024）';
    cInp.value = state.currentImageSizeMode === 'custom' ? (state.selectedSize || '') : '';
    const cBtn = document.createElement('button'); cBtn.type = 'button'; cBtn.className = 'd-btn primary'; cBtn.textContent = '应用';
    cBtn.onclick = ()=>{
      if(el.customSize){ el.customSize.value = cInp.value; hooks.applyCustomSize && hooks.applyCustomSize(); }
      openDockPopover('ratio', anchorEl);
    };
    cInp.addEventListener('keydown', e=>{ if(e.key === 'Enter'){ e.preventDefault(); cBtn.click(); } });
    customRow.append(cInp, cBtn);
    body.append(grid, customRow);
    mkMore('打开批量比例与高级设置', ()=> hooks.focusDrawer && hooks.focusDrawer('params', el.sizeGrid));

  }else if(kind === 'count'){
    titleSpan.textContent = '单次生成张数 & 质量';
    const curCount = String((el.count && el.count.value) || '1');
    const cRow = document.createElement('div'); cRow.className = 'dp-pills';
    ['1','2','3','4'].forEach(n=>{
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dp-pill' + (curCount === n ? ' active' : '');
      b.innerHTML = '<b>' + n + ' 张</b>';
      b.onclick = ()=>{
        if(el.count){ el.count.value = n; el.count.dispatchEvent(new Event('change')); }
        openDockPopover('count', anchorEl);
      };
      cRow.appendChild(b);
    });
    body.appendChild(cRow);

    const mirrorSelectRow = (label, sel, onVal)=>{
      if(!sel || sel.disabled || sel.closest('.d-sec')?.style.display === 'none') return;
      const box = document.createElement('div'); box.className = 'dp-mini-field';
      const lbl = document.createElement('span'); lbl.textContent = label;
      const cloneSel = document.createElement('select'); cloneSel.className = 'inp dp-sel';
      Array.from(sel.options).forEach(o=> cloneSel.add(new Option(o.textContent, o.value)));
      cloneSel.value = sel.value;
      cloneSel.onchange = ()=>{
        sel.value = cloneSel.value;
        sel.dispatchEvent(new Event('change'));
        if(onVal) onVal();
      };
      box.append(lbl, cloneSel);
      body.appendChild(box);
    };
    mirrorSelectRow('渲染质量', el.quality);
    mirrorSelectRow('规划复杂度', el.complexity);
    mirrorSelectRow('输出格式', el.format, ()=> syncGifHint());
    mirrorSelectRow('背景模式', el.background);

    const toggleRow = document.createElement('div'); toggleRow.className = 'dp-toggle-row';
    const mkTog = (label, checked, fn)=>{
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dp-chip' + (checked ? ' active' : '');
      b.textContent = label;
      b.onclick = fn;
      toggleRow.appendChild(b);
    };
    if(el.ogMode) mkTog('超生成防审核：' + (el.ogMode.checked ? '已开' : '关闭'), el.ogMode.checked, ()=>{
      el.ogMode.checked = !el.ogMode.checked;
      el.ogMode.dispatchEvent(new Event('change'));
      openDockPopover('count', anchorEl);
    });
    if(el.batchMode) mkTog('多比例批量：' + (el.batchMode.checked ? '已开' : '关闭'), el.batchMode.checked, ()=>{
      el.batchMode.checked = !el.batchMode.checked;
      el.batchMode.dispatchEvent(new Event('change'));
      openDockPopover('count', anchorEl);
    });
    body.appendChild(toggleRow);
    mkMore('参数详情 / 批量与配方预设', ()=> hooks.focusDrawer && hooks.focusDrawer('params', el.count));

  }else if(kind === 'video'){
    titleSpan.textContent = '视频快捷参数';
    const subRow = document.createElement('div'); subRow.className = 'dp-pills';
    [['txt2video','文生视频'],['img2video','图片生视频']].forEach(([vm, lbl])=>{
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'dp-pill' + (state.videoMode === vm ? ' active' : '');
      b.innerHTML = '<b>' + lbl + '</b>';
      b.onclick = ()=>{
        state.videoMode = vm;
        if(el.videoMode) el.videoMode.value = vm;
        hooks.setMode && hooks.setMode('video');
        openDockPopover('video', anchorEl);
      };
      subRow.appendChild(b);
    });
    body.appendChild(subRow);
    const caps = getVideoCapabilities() || {};
    const addPillGroup = (label, values, cur, fmt, applyFn)=>{
      const gLbl = document.createElement('div'); gLbl.className = 'dp-sub-lbl'; gLbl.textContent = label;
      const gRow = document.createElement('div'); gRow.className = 'dp-chip-wrap';
      (values || []).forEach(v=>{
        const b = document.createElement('button'); b.type = 'button';
        b.className = 'dp-chip' + (String(cur) === String(v) ? ' active' : '');
        b.textContent = fmt ? fmt(v) : String(v);
        b.onclick = ()=>{ applyFn(String(v)); openDockPopover('video', anchorEl); };
        gRow.appendChild(b);
      });
      body.append(gLbl, gRow);
    };
    addPillGroup('时长', caps.seconds || VIDEO_SECONDS, state.videoSeconds, v=> v + 's', v=>{
      state.videoSeconds = v;
      if(el.videoSeconds){ el.videoSeconds.value = v; el.videoSeconds.dispatchEvent(new Event('change')); }
    });
    addPillGroup('清晰度', caps.resolutions || VIDEO_RESOLUTIONS, state.videoResolution, null, v=>{
      state.videoResolution = v;
      if(el.videoResolution){ el.videoResolution.value = v; el.videoResolution.dispatchEvent(new Event('change')); }
    });
    addPillGroup('画面比例', (caps.aspectRatios || VIDEO_ASPECT_RATIOS).slice(0, 7), state.videoAspectRatio, null, v=>{
      state.videoAspectRatio = v;
      if(el.videoAspectRatio){ el.videoAspectRatio.value = v; el.videoAspectRatio.dispatchEvent(new Event('change')); }
    });
    mkMore('全部视频模型与参数', ()=> hooks.focusDrawer && hooks.focusDrawer('params', el.videoPanel));

  }else if(kind === 'neg'){
    titleSpan.textContent = state.currentMode === 'video' ? '视频负面排除词' : '负面排除词';
    const ta = document.createElement('textarea');
    ta.className = 'inp dp-neg-ta';
    ta.placeholder = '输入想避开的元素：多余手指、文字、水印、模糊…';
    ta.value = el.negative ? el.negative.value : '';
    ta.oninput = ()=>{
      if(el.negative) el.negative.value = ta.value;
      hooks.syncQuickRow && hooks.syncQuickRow();
    };
    const quickNeg = ['禁止文字与水印', '畸形手指', '画面模糊', '多余人物'];
    const qRow = document.createElement('div'); qRow.className = 'dp-chip-wrap';
    quickNeg.forEach(term=>{
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dp-chip';
      b.textContent = '+ ' + term;
      b.onclick = ()=>{
        const cur = ta.value.trim();
        ta.value = cur ? (cur + '，' + term) : term;
        if(el.negative) el.negative.value = ta.value;
        hooks.syncQuickRow && hooks.syncQuickRow();
      };
      qRow.appendChild(b);
    });
    const capNeg = document.getElementById('negativeHint');
    if(capNeg && capNeg.style.display !== 'none'){
      const w = document.createElement('div'); w.className = 'dp-note warn';
      w.textContent = capNeg.textContent;
      body.appendChild(w);
    }
    body.append(ta, qRow);
    setTimeout(()=> ta.focus(), 40);
    mkMore('打开完整双栏提示词编辑器', ()=> hooks.openPromptEditor && hooks.openPromptEditor());

  }else if(kind === 'inspire'){
    titleSpan.textContent = '快捷指令 · 样板与图库';
    const qLbl = document.createElement('div'); qLbl.className = 'dp-sub-lbl'; qLbl.textContent = '常用修图与创作指令';
    const qWrap = document.createElement('div'); qWrap.className = 'dp-chip-wrap';
    QUICK_FILLS.forEach(q=>{
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dp-chip';
      b.innerHTML = (q.ico && ICO[q.ico] ? ICO[q.ico] : '') + '<span>' + escapeHtml(q.label) + '</span>';
      b.onclick = ()=>{
        if(el.prompt){ el.prompt.value = q.fill; hooks.autosize && hooks.autosize(); }
        closeDockPopover();
        toast('已填入快捷指令，可直接补充细节', 'ok');
      };
      qWrap.appendChild(b);
    });
    body.append(qLbl, qWrap);

    const recent = lsGet(LS_RECENT, []);
    if(recent.length){
      const rLbl = document.createElement('div'); rLbl.className = 'dp-sub-lbl'; rLbl.textContent = '最近用过的提示词';
      const rWrap = document.createElement('div'); rWrap.className = 'dp-chip-wrap';
      recent.slice(0, 6).forEach(p=>{
        const b = document.createElement('button'); b.type = 'button'; b.className = 'dp-chip';
        b.textContent = p.length > 18 ? p.slice(0, 18) + '…' : p;
        b.title = p;
        b.onclick = ()=>{
          if(el.prompt){ el.prompt.value = p; hooks.autosize && hooks.autosize(); }
          closeDockPopover();
          toast('已填入最近提示词', 'ok');
        };
        rWrap.appendChild(b);
      });
      body.append(rLbl, rWrap);
    }

    const navGrid = document.createElement('div'); navGrid.className = 'dp-nav-cards';
    const mkCard = (ico, title, desc, fn)=>{
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dp-nav-card';
      b.innerHTML = '<span class="dnc-ico">' + ico + '</span><span><b>' + title + '</b><small>' + desc + '</small></span>';
      b.onclick = ()=>{ closeDockPopover(); fn(); };
      navGrid.appendChild(b);
    };
    mkCard(ICO.template, '逛逛方案样板', '提示词仓库 · 一键套用正负词', ()=> hooks.openTemplates && hooks.openTemplates());
    mkCard(ICO.gallery, '挑选参考图库', '姿势 / 服装 / 人像免切出图', ()=> hooks.openGallery && hooks.openGallery());
    body.appendChild(navGrid);

  }else if(kind === 'status'){
    titleSpan.textContent = '当前工作模型与连接';
    const isVideo = state.currentMode === 'video';
    const sel = isVideo ? el.videoModel : el.model;
    const box = document.createElement('div'); box.className = 'dp-mini-field';
    const lbl = document.createElement('span'); lbl.textContent = isVideo ? '视频模型' : '生图模型';
    const clone = document.createElement('select'); clone.className = 'inp dp-sel';
    if(sel) Array.from(sel.options).forEach(o=> clone.add(new Option(o.textContent, o.value)));
    if(sel) clone.value = sel.value;
    clone.onchange = ()=>{
      if(sel){ sel.value = clone.value; sel.dispatchEvent(new Event('change')); }
      syncTopbarHud();
      openDockPopover('status', anchorEl);
    };
    box.append(lbl, clone);
    const connState = document.createElement('div'); connState.className = 'dp-conn-box';
    connState.innerHTML = '<span class="' + ((el.connDot && el.connDot.className) || 'conn-dot') + '"></span><span>' + escapeHtml((el.connText && el.connText.textContent) || '未验证') + '</span>';
    body.append(connState, box);
    mkMore('打开 API 连接设置与档案管理', ()=> hooks.focusDrawer && hooks.focusDrawer('settings', el.apiBase));

  }else if(kind === 'ref'){
    titleSpan.textContent = '添加参考图';
    const navGrid = document.createElement('div'); navGrid.className = 'dp-nav-cards';
    const mkCard = (ico, title, desc, fn)=>{
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dp-nav-card';
      b.innerHTML = '<span class="dnc-ico">' + ico + '</span><span><b>' + title + '</b><small>' + desc + '</small></span>';
      b.onclick = ()=>{ closeDockPopover(); fn(); };
      navGrid.appendChild(b);
    };
    mkCard(ICO.image, '选择本地图片', '支持多张 · 拖拽/粘贴亦可', ()=> el.fileInput && el.fileInput.click());
    mkCard(ICO.gallery, '从参考图库挑选', '姿势 / 服装 / 人像参考图', ()=> hooks.openGallery && hooks.openGallery());
    body.appendChild(navGrid);
    const note = document.createElement('div'); note.className = 'dp-note';
    note.textContent = '小贴士：桌面端可以直接把图片拖拽到画布，或 Ctrl+V 粘贴剪贴板图片。';
    body.appendChild(note);
  }

  pop.hidden = false;
  positionPopover();
}

/* ================= 5. 全局拖拽 / 粘贴加参考图 ================= */
export function initDropAndPaste(){
  const overlay = document.getElementById('dropOverlay');
  let dragDepth = 0;
  const hasFiles = e=> e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  const isOverlayOpen = ()=>{
    const pw = document.getElementById('paintWrap');
    return !!(pw && pw.classList.contains('open'));
  };

  document.addEventListener('dragenter', e=>{
    if(!hasFiles(e) || isOverlayOpen()) return;
    e.preventDefault();
    dragDepth++;
    if(overlay) overlay.classList.add('open');
  });
  document.addEventListener('dragover', e=>{
    if(!hasFiles(e) || isOverlayOpen()) return;
    e.preventDefault();
    if(e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', e=>{
    if(!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if(dragDepth === 0 && overlay) overlay.classList.remove('open');
  });
  document.addEventListener('drop', async e=>{
    dragDepth = 0;
    if(overlay) overlay.classList.remove('open');
    if(!hasFiles(e) || isOverlayOpen()) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f=> /^image\//.test(f.type));
    if(!files.length) return;
    e.preventDefault();
    if(state.currentMode === 'txt2img' && hooks.setMode) hooks.setMode('img2img');
    if(hooks.addRefFiles) await hooks.addRefFiles(files);
    toast('已从拖拽加入 ' + files.length + ' 张参考图', 'ok');
  });

  document.addEventListener('paste', async e=>{
    if(isOverlayOpen()) return;
    const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
    const imgFiles = items.filter(it=> it.kind === 'file' && /^image\//.test(it.type)).map(it=> it.getAsFile()).filter(Boolean);
    if(!imgFiles.length) return;
    e.preventDefault();
    if(state.currentMode === 'txt2img' && hooks.setMode) hooks.setMode('img2img');
    if(hooks.addRefFiles) await hooks.addRefFiles(imgFiles);
    toast('已从剪贴板加入 ' + imgFiles.length + ' 张参考图', 'ok');
  });
}

/* ================= 6. 预览灯箱多图导航与缩放 ================= */
let pvScale = 1;
export function resetPreviewZoom(){
  pvScale = 1;
  if(el && el.previewImg){
    el.previewImg.style.transform = '';
    el.previewImg.style.width = '';
    el.previewImg.style.height = '';
    el.previewImg.classList.remove('zoomed');
  }
}

export function syncPreviewControls(){
  if(!el || !state) return;
  const prev = document.getElementById('pvPrev');
  const next = document.getElementById('pvNext');
  const zoomBtn = document.getElementById('pvZoom');
  const t = state.previewTask;
  const count = t && t.resultItems ? t.resultItems.length : 0;
  const idx = t ? (Number(t.resultIndex) || 0) : 0;
  const isVideo = (t && t.task.mediaType === 'video') || (state.libDetail && state.libDetail.mediaType === 'video');
  if(prev && next){
    const showNav = count > 1;
    prev.style.display = showNav ? 'flex' : 'none';
    next.style.display = showNav ? 'flex' : 'none';
    prev.disabled = idx <= 0;
    next.disabled = idx >= count - 1;
  }
  if(zoomBtn){
    zoomBtn.style.display = isVideo ? 'none' : 'inline-flex';
    zoomBtn.innerHTML = pvScale > 1 ? ICO.zoomOut : ICO.zoomIn;
    zoomBtn.title = pvScale > 1 ? '还原适应尺寸' : '放大查看细节';
  }
}

export function initPreviewEnhancements(){
  const prev = document.getElementById('pvPrev');
  const next = document.getElementById('pvNext');
  const zoomBtn = document.getElementById('pvZoom');
  const stepResult = delta=>{
    const t = state && state.previewTask;
    if(!t || !t.resultItems || t.resultItems.length <= 1) return;
    const nextIdx = Math.max(0, Math.min(t.resultItems.length - 1, (Number(t.resultIndex) || 0) + delta));
    if(nextIdx === (Number(t.resultIndex) || 0)) return;
    resetPreviewZoom();
    hooks.setTaskResultIndex && hooks.setTaskResultIndex(t, nextIdx);
  };
  if(prev) prev.onclick = e=>{ e.stopPropagation(); stepResult(-1); };
  if(next) next.onclick = e=>{ e.stopPropagation(); stepResult(1); };

  const toggleZoom = ()=>{
    if(!el || !el.previewImg || el.previewImg.style.display === 'none') return;
    if(pvScale > 1){
      resetPreviewZoom();
      syncPreviewControls();
      return;
    }
    const baseW = el.previewImg.getBoundingClientRect().width || el.previewImg.clientWidth || 320;
    const targetW = Math.round(Math.max(baseW * 1.85, (el.previewImg.naturalWidth || 0) * 1.5));
    pvScale = 2;
    el.previewImg.style.transform = '';
    el.previewImg.style.width = targetW + 'px';
    el.previewImg.style.height = 'auto';
    el.previewImg.classList.add('zoomed');
    const box = el.previewImg.parentElement;
    if(box){
      requestAnimationFrame(()=>{
        box.scrollLeft = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
        box.scrollTop = Math.max(0, (box.scrollHeight - box.clientHeight) / 2);
      });
    }
    syncPreviewControls();
  };
  if(zoomBtn) zoomBtn.onclick = e=>{ e.stopPropagation(); toggleZoom(); };
  if(el && el.previewImg){
    el.previewImg.ondblclick = e=>{ e.stopPropagation(); toggleZoom(); };
  }

  document.addEventListener('keydown', e=>{
    if(!el || !el.preview || !el.preview.classList.contains('open')) return;
    if(e.key === 'ArrowLeft') stepResult(-1);
    else if(e.key === 'ArrowRight') stepResult(1);
  });
}

/* ================= 7. 涂抹画笔实时圆形光标 ================= */
export function initPaintCursor(){
  const box = document.getElementById('paintCanvasBox');
  const cursor = document.getElementById('paintCursor');
  const canvas = document.getElementById('paintCanvas');
  if(!box || !cursor || !canvas) return;
  let lastClientX = null, lastClientY = null;
  const renderAt = (cx, cy)=>{
    if(cx == null || cy == null || !state || !state.paintOrig){
      cursor.style.opacity = '0';
      return;
    }
    const cRect = canvas.getBoundingClientRect();
    const bRect = box.getBoundingClientRect();
    if(!cRect.width || !canvas.width){ cursor.style.opacity = '0'; return; }
    const dispScale = cRect.width / canvas.width;
    const dia = Math.max(6, (state.paintBrushSize || 24) * dispScale);
    cursor.style.width = dia + 'px';
    cursor.style.height = dia + 'px';
    cursor.style.left = (cx - bRect.left) + 'px';
    cursor.style.top = (cy - bRect.top) + 'px';
    cursor.style.opacity = '1';
    cursor.classList.toggle('eraser', state.paintTool === 'eraser');
  };
  const updateCursor = e=>{
    if(e.pointerType === 'touch'){
      lastClientX = null; lastClientY = null;
      cursor.style.opacity = '0';
      return;
    }
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    renderAt(lastClientX, lastClientY);
  };
  box.addEventListener('pointermove', updateCursor);
  box.addEventListener('pointerdown', updateCursor);
  box.addEventListener('wheel', ()=> requestAnimationFrame(()=> renderAt(lastClientX, lastClientY)), { passive:true });
  box.addEventListener('pointerleave', ()=>{ lastClientX = null; lastClientY = null; cursor.style.opacity = '0'; });
  ['paintMinus','paintPlus','paintZoomIn','paintZoomOut','paintZoomFit','paintBrush','paintEraser'].forEach(id=>{
    const btn = document.getElementById(id);
    if(btn) btn.addEventListener('click', ()=> requestAnimationFrame(()=> renderAt(lastClientX, lastClientY)));
  });
}

/* ================= 8. 任务参数详情可视化卡片 ================= */
export function renderDetailModalContent(task){
  const host = document.getElementById('detailCards');
  if(!host || !task) return;
  const stateMap = { pending:'排队中', running:'生成中', submitting:'提交后台', queued:'后端排队中', done:'已完成', error:'失败', timeout:'超时', cancelled:'已取消', interrupted:'服务中断', expired:'已过期', archived:'已存档' };
  const isVideo = task.mediaType === 'video';
  const modeLabel = isVideo ? (task.mode === 'img2video' ? '图片生视频' : '文生视频') : (task.mode === 'img2img' ? '图生图' : '文生图');
  const statusLabel = stateMap[task.serverState] || stateMap[task.state] || task.state;
  const sizeVal = isVideo ? ((task.videoSeconds || '6') + '秒 · ' + (task.videoAspectRatio || '16:9') + ' · ' + (task.videoResolution || '720P')) : (task.serverSize || task.size || '未指定');
  const sourceVal = (task.parentId && state && state.taskEls[task.parentId]) ? ('#' + task.parentId + ' (' + (REL_LABELS[task.relation] || task.relation) + ')') : '独立创作';
  const refsVal = (task.files && task.files.length) ? task.files.map((f, i)=> '图' + (i+1) + ':' + (REFERENCE_ROLES[f.role] || f.role || '不指定')).join('  ') : '无参考图';
  const rows = [
    ['状态', statusLabel],
    ['模式', modeLabel],
    ['模型', task.model || task.videoModel || '—'],
    ['画幅', sizeVal],
    ['来源', sourceVal],
    ['参考图', refsVal]
  ];
  if(!isVideo && task.complexity) rows.push(['规划复杂度', task.complexity]);
  if(!isVideo && task.serverCostUsd !== '' && task.serverCostUsd != null) rows.push(['估算费用', '$' + task.serverCostUsd]);
  if(task.serverTaskId) rows.push(['上游ID', task.serverTaskId]);

  host.innerHTML =
    '<div class="dt-kv">' +
      rows.map(([k, v])=> '<div class="dt-cell"><span>' + escapeHtml(k) + '</span><b>' + escapeHtml(v) + '</b></div>').join('') +
    '</div>' +
    '<div class="dt-block"><span>正向提示词</span><p>' + escapeHtml(task.prompt || '（无）') + '</p></div>' +
    (task.negative ? '<div class="dt-block neg"><span>负面排除词</span><p>' + escapeHtml(task.negative) + '</p></div>' : '');
}

/* ================= 9. 初始化插画、外部点击收起及绑定 ================= */
export function initStudioDecor(){
  // 确保矢量猫猫头像存在（HTML 已内联首屏兜底；若缺失则按独立渐变 ID 补全）
  document.querySelectorAll('.brand-mark, .boot-cat').forEach((node, idx)=>{
    if(!node.querySelector('svg.cat-svg')){
      node.innerHTML = buildCatMascotSvg('decor_' + idx);
    }
  });
  const emptyArt = document.querySelector('#canvasEmpty .empty-art');
  if(emptyArt) emptyArt.innerHTML = EMPTY_CANVAS_SVG;

  // 注册空态 SVG 给 CSS/JS 使用
  window.__CAT_STUDIO = { EMPTY_STATE_SVG };

  // 点击弹出层外自动关闭 Popover
  document.addEventListener('pointerdown', e=>{
    const pop = document.getElementById('dockPopover');
    if(!pop || pop.hidden) return;
    if(pop.contains(e.target)) return;
    if(e.target.closest('#quickRow') || e.target.closest('.btn-ref') || e.target.closest('#refAdd') || e.target.closest('#emptyAddRef')) return;
    closeDockPopover();
  });

  window.addEventListener('resize', positionPopover);
}
