/* ============================================================
   ui-nav.js · 安卓端导航增强（纯 DOM，不依赖 app.js 内部状态）
   1) 安卓返回键：抽屉 / 控制台 / 预览 / 弹窗 / 局部修改 依次回退，而不是直接退出页面
   2) 抽屉内「区块快速跳转」栏：点一下滚动并展开对应折叠区，按当前模式隐藏不适用项
   3) 折叠区展开状态记忆（刷新后保持）
   ============================================================ */
(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const LS_FOLDS = 'img2img_ui_folds_v1';

  /* ---------------- 3) 折叠区状态记忆 ---------------- */
  function readFolds(){
    try{ return JSON.parse(localStorage.getItem(LS_FOLDS) || '{}') || {}; }catch(e){ return {}; }
  }
  function initFolds(){
    const saved = readFolds();
    document.querySelectorAll('details.fold[id]').forEach(d=>{
      if(Object.prototype.hasOwnProperty.call(saved, d.id)) d.open = !!saved[d.id];
      d.addEventListener('toggle', ()=>{
        const cur = readFolds();
        cur[d.id] = d.open;
        try{ localStorage.setItem(LS_FOLDS, JSON.stringify(cur)); }catch(e){}
      });
    });
  }

  /* ---------------- 2) 区块快速跳转 ---------------- */
  function isShown(node){
    if(!node) return false;
    for(let n=node; n && n!==document.body; n=n.parentElement){
      if(n.hidden || getComputedStyle(n).display === 'none') return false;
    }
    return true;
  }

  function refreshJumpBars(){
    document.querySelectorAll('.d-jump').forEach(bar=>{
      bar.querySelectorAll('[data-jump]').forEach(btn=>{
        btn.hidden = !isShown($(btn.getAttribute('data-jump')));
      });
    });
  }

  function jumpTo(id){
    const target = $(id);
    if(!target || !isShown(target)) return;
    for(let n=target; n; n=n.parentElement) if(n.tagName === 'DETAILS') n.open = true;
    requestAnimationFrame(()=>{
      target.scrollIntoView({ behavior:'smooth', block:'start' });
      target.classList.remove('ui-focus-target');
      void target.offsetWidth;
      target.classList.add('ui-focus-target');
      setTimeout(()=> target.classList.remove('ui-focus-target'), 1400);
    });
  }

  function updateActiveChip(body){
    const bar = body.querySelector('.d-jump');
    if(!bar) return;
    const top = body.getBoundingClientRect().top + 64;
    let active = null;
    bar.querySelectorAll('[data-jump]:not([hidden])').forEach(btn=>{
      const t = $(btn.getAttribute('data-jump'));
      if(t && t.getBoundingClientRect().top <= top) active = btn;
    });
    bar.querySelectorAll('[data-jump]').forEach(btn=> btn.classList.toggle('active', btn === active));
    if(active && bar.scrollWidth > bar.clientWidth){
      const left = active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2;
      bar.scrollLeft = Math.max(0, left);
    }
  }

  function initJump(){
    document.addEventListener('click', e=>{
      const btn = e.target && e.target.closest ? e.target.closest('[data-jump]') : null;
      if(btn) jumpTo(btn.getAttribute('data-jump'));
    });
    document.querySelectorAll('.drawer-body').forEach(body=>{
      if(!body.querySelector('.d-jump')) return;
      let ticking = false;
      body.addEventListener('scroll', ()=>{
        if(ticking) return;
        ticking = true;
        requestAnimationFrame(()=>{ ticking = false; updateActiveChip(body); });
      }, { passive:true });
    });
    /* 抽屉打开时、模式切换后，刷新可见项 */
    const obs = new MutationObserver(()=>{
      refreshJumpBars();
      document.querySelectorAll('.drawer.open .drawer-body').forEach(updateActiveChip);
    });
    document.querySelectorAll('.drawer').forEach(d=> obs.observe(d, { attributes:true, attributeFilter:['class'] }));
    const ms = $('modeSwitch');
    if(ms) ms.addEventListener('click', ()=> setTimeout(refreshJumpBars, 0));
    document.querySelectorAll('details.fold').forEach(d=> d.addEventListener('toggle', ()=>{
      document.querySelectorAll('.drawer.open .drawer-body').forEach(updateActiveChip);
    }));
    document.addEventListener('canvas-mode-change', ()=>{ refreshJumpBars(); });
    refreshJumpBars();
  }

  /* ---------------- 1) 安卓返回键 ---------------- */
  /* 自上而下 = 视觉层级由高到低；每层给出「是否打开」与「怎么关」 */
  const hasOpen = id => { const n = $(id); return !!n && n.classList.contains('open'); };
  const click = id => { const n = $(id); if(n) n.click(); };
  const DRAWER_IDS = ['drawerParams','drawerLib','drawerSettings','drawerOverview','drawerTemplates','drawerGallery'];
  const LAYERS = [
    { ids:['appDialogModal'],  close: ()=> click('appDialogCancel') },
    { ids:['paintWrap'],       close: ()=> click('paintClose') },
    { ids:['promptEditor'],    close: ()=> click('promptEditorClose') },
    { ids:['nameModal'],       close: ()=> click('nameClose') },
    { ids:['detailModal'],     close: ()=> click('detailClose') },
    { ids:['visionPickModal'], close: ()=> click('visionPickClose') },
    { ids:['preview'],         close: ()=> click('previewClose') },
    { ids:['sheet'],           close: ()=> click('sheetMask') },
    { ids:['consoleSheet'],    close: ()=> { const n = $('consoleSheet'); if(n) n.classList.remove('open'); const b = $('btnConsole'); if(b) b.setAttribute('aria-expanded', 'false'); } },
    { ids:DRAWER_IDS,          close: ()=> click('mask') }
  ];
  const layerOpen = layer => layer.ids.some(hasOpen);
  const openCount = () => LAYERS.filter(layerOpen).length;

  let pushed = 0;      // 已压入历史栈的层数
  let silent = 0;      // 程序主动 history.go 产生的 popstate，需要忽略
  let settleTimer = 0;

  function reconcile(){
    const n = openCount();
    while(pushed < n){
      try{ history.pushState({ uiLayer: pushed + 1 }, ''); }catch(e){ break; }
      pushed++;
    }
    if(pushed > n){
      const back = pushed - n;
      pushed = n;
      silent++;
      history.go(-back);
    }
  }

  function initBack(){
    const watched = new Set();
    LAYERS.forEach(l => l.ids.forEach(id => { if($(id)) watched.add($(id)); }));
    const obs = new MutationObserver(()=> reconcile());
    watched.forEach(n => obs.observe(n, { attributes:true, attributeFilter:['class'] }));

    window.addEventListener('popstate', ()=>{
      if(silent > 0){ silent--; return; }
      if(pushed > 0) pushed--;
      const top = LAYERS.find(layerOpen);
      if(top) top.close();
      /* 关闭可能被拦截（如局部修改有未保存内容的确认框）：稍后若仍有层未关，补回历史条目 */
      clearTimeout(settleTimer);
      settleTimer = setTimeout(reconcile, 80);
    });
  }

  function init(){
    initFolds();
    initJump();
    initBack();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

