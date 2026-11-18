import { ICO } from './icons.js';
import { REFERENCE_ROLES, REFERENCE_ROLE_INSTRUCTIONS, REQUEST_TIMEOUTS, QUICK_FILLS } from './state.js';
import { toast, escapeHtml, getRequestUrl, fetchWithTimeout, parseApiError, localApiProxyHint } from './util.js';
import { getSelectedChatModel } from './settings.js';
import { getTaskResult, getTaskResultIndex } from './paint.js';

let state = null, el = null;
export function bindRuntime(s, e){ state = s; el = e; }
function openDrawer(name){ return state && state.hooks && state.hooks.openDrawer ? state.hooks.openDrawer(name) : undefined; }
function closeDrawers(){ return state && state.hooks && state.hooks.closeDrawers ? state.hooks.closeDrawers() : undefined; }

  export function parseDualPrompt(text){
    let t = String(text || '').trim();
    t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim(); // 去掉可能的 Markdown 代码块围栏
    const m = /\[NEGATIVE\]/i.exec(t); // 兼容 [negative] 小写标记
    if(!m) return { positive:t, negative:'' };
    const negIdx = m.index;
    return {
      positive: t.slice(0, negIdx).replace(/^\[POSITIVE\]\s*/i, '').trim(),
      negative: t.slice(negIdx).replace(/^\[NEGATIVE\]\s*/i, '').trim()
    };
  }

  export function renderQuickChips(){
    el.quickChips.innerHTML = '';
    QUICK_FILLS.forEach(q=>{
      const c = document.createElement('button');
      c.className = 'lib-chip'; c.innerHTML = (q.ico && ICO[q.ico] ? ICO[q.ico] : '') + q.label;
      c.onclick = ()=>{ el.prompt.value = q.fill; autosize(); toast('已填入快捷指令，可再补充细节', 'ok'); };
      el.quickChips.appendChild(c);
    });
  }

  export function autosize(){
    el.prompt.style.height = 'auto';
    el.prompt.style.height = Math.min(88, el.prompt.scrollHeight) + 'px';
  }

  export function collectVisionSources(){
    const srcs = [];
    state.currentFiles.forEach((f, i)=> srcs.push({ label:'参考图 ' + (i+1) + '（' + (REFERENCE_ROLES[f.role] || f.role) + '）', blob:f.file }));
    Object.keys(state.taskEls).forEach(id=>{
      const t = state.taskEls[id];
      if(!t || t.task.state !== 'done' || !t.resultItems || !t.resultItems.length) return;
const ri = getTaskResult(t);
       srcs.push({ label:'画布 #' + t.task.id + (t.resultItems.length > 1 ? ' · ' + (getTaskResultIndex(t) + 1) + '/' + t.resultItems.length : ''), blob: ri.blob || null, url: ri.url || null });
    });
    return srcs;
  }

  export async function blobFromSource(s){
    if(s.blob) return s.blob;
    if(s.url) return await fetch(getRequestUrl(s.url)).then(r=> r.blob());
    return null;
  }

  export async function imageToDataUrl(blob, maxSide, q){
    const url = URL.createObjectURL(blob);
    try{
      const img = await new Promise((res, rej)=>{
        const i = new Image();
        i.onload = ()=> res(i);
        i.onerror = ()=> rej(new Error('图片加载失败'));
        i.src = url;
      });
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    }finally{
      setTimeout(()=> URL.revokeObjectURL(url), 1000);
    }
  }

  export function renderVisionThumbs(){
    el.visionThumbs.innerHTML = '';
    state.visionItems.forEach((it, i)=>{
      const d = document.createElement('div');
      d.className = 'vt';
      const img = document.createElement('img');
      img.src = it.thumbUrl;
      const x = document.createElement('button');
      x.className = 'vt-x'; x.textContent = '✕';
      x.onclick = ()=>{ state.visionItems.splice(i, 1); renderVisionThumbs(); };
      d.append(img, x);
      el.visionThumbs.appendChild(d);
    });
    el.visionLabel.textContent = state.visionItems.length ? state.visionItems.map(v=> v.label).join('、') : '';
    el.visionRow.style.display = state.visionItems.length ? 'flex' : 'none';
  }

  export async function addVisionItem(src){
    if(state.visionItems.some(v=> v.label === src.label)){ toast('该图已在列表中', 'err'); return; }
    try{
      const blob = await blobFromSource(src);
      if(!blob) throw new Error('无图片');
      const thumbUrl = await imageToDataUrl(blob, 96, .7);
      const sendUrl = await imageToDataUrl(blob, 1024, .82);
      state.visionItems.push({ label: src.label, thumbUrl, sendUrl });
      renderVisionThumbs();
    }catch(e){
      toast('图片读取失败：' + src.label, 'err');
    }
  }

  export function clearVision(){
    state.visionItems = [];
    renderVisionThumbs();
  }

  export function openOptimizeWithImage(task){
    const t = state.taskEls[task.id];
    if(!t || !t.resultItems.length){ toast('没有可用图片', 'err'); return; }
    state.pendingParent = { id: task.id, rel: 'optimize' };
    state.pendingParentArmed = false; // 先暂存候选，优化成功回填后才确认血缘
    const ri = getTaskResult(t);
    clearVision();
    addVisionItem({ label:'画布 #' + task.id, blob: ri.blob || null, url: ri.url || null }).then(()=>{
      el.sheet.classList.add('open');
      el.sheetMask.classList.add('open');
      setTimeout(()=> el.idea.focus(), 260);
    });
  }

  export function visionNote(){
    if(el.visionEnable.checked && state.visionItems.length){
      return '\nImages provided (' + state.visionItems.length + '): ' + state.visionItems.map(v=> v.label).join('; ');
    }
    return '';
  }

  export function closeSheet(){
    // 未成功优化就关闭面板时，丢弃未确认的血缘候选，避免污染下一次生成
    if(!state.pendingParentArmed) state.pendingParent = null;
    el.sheet.classList.remove('open');
    el.sheetMask.classList.remove('open');
  }

  export function normalizeGeneratedNegative(text){
    return String(text || '')
      .split(/[,，;；\n]+/)
      .map(s=> s.trim().replace(/^(?:[-*]\s*)+/,'').replace(/^(?:\d+[.、)）]\s*)/,''))
      .filter(Boolean)
      .map(s=>{
        if(/^禁止\s*/.test(s)) return s;                                    // 已规范：保留
        if(/^(?:no|without|avoid|never|don'?t)\b/i.test(s)) return s;       // 英文否定：保留原样
        if(/^(?:不要|请勿|切勿|避免|别|勿|无需)\s*/.test(s))                // 中文否定：归一为「禁止」防双重否定
          return s.replace(/^(?:不要|请勿|切勿|避免|别|勿|无需)\s*/, '禁止');
        return '禁止' + s;                                                  // 裸词：补前缀
      })
      .join('，');
  }

  export function describeReferences(files){
    return files.map((item, i)=>{
      const role = item && item.role;
      if(!role || role === 'none') return '';
      return 'Image ' + (i+1) + ' (' + (REFERENCE_ROLES[role] || '参考') + '): ' + (REFERENCE_ROLE_INSTRUCTIONS[role] || 'Use only as explicitly requested.');
    }).filter(Boolean).join('\n');
  }

  export function buildRequestPrompt(userPrompt, mode, files){
    if(mode!=='img2img' || !files.length) return userPrompt;
    const refs = describeReferences(files);
    if(!refs) return userPrompt;
    return [
      'REFERENCE IMAGE ASSIGNMENTS (follow by uploaded order):',
      refs,
      'Keep these assignments separate. Do not copy clothing, pose, composition, or style from an image assigned to another role.',
      'Combine the assigned attributes into one coherent final image, then follow the user request below.',
      '',
      userPrompt
    ].join('\n');
  }

  export function normalizePromptAndNegative(prompt, negative, strategy){
    if(!negative || strategy !== 'merge') return { prompt, negative };
    return { prompt: prompt + '\n\nAvoid: ' + negative, negative:'' };
  }