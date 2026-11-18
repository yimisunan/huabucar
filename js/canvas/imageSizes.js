import { RATIOS, TIERS } from './state.js';

// Tables come from the provider configuration; other providers keep their own sizes.
export function imageRatios(caps = {}){
  if(caps.imageSizePolicy === 'futureai-ratio'){
    const tiers = caps.resolutionOptions || TIERS;
    return (caps.aspectRatios || []).map(r=>({
      r, d:r === 'auto' ? '自动比例' : (RATIOS.find(item=>item.r===r)?.d || '图片'),
      v:Object.fromEntries(tiers.map(t=>[t, r === 'auto' ? 'auto' : (caps.imageSizePresets?.[r]?.[t] || caps.imageSizePresets?.[r]?.['1K'] || r)]))
    }));
  }
  const table = caps.imageSizePresets;
  if(caps.imageSizePolicy !== 'change2pro-studio' || !table) return RATIOS;
  return Object.keys(table['1K'] || {}).map(r=>({
    r, d:RATIOS.find(item=>item.r === r)?.d || (r === '21:9' ? '超宽横图' : '图片'),
    v:Object.fromEntries(TIERS.filter(t=>table[t]?.[r]).map(t=>[t,table[t][r]]))
  }));
}

export function findImageSize(size, caps = {}, includeLegacy = true){
  const tiers = caps.imageSizePolicy === 'futureai-ratio' ? (caps.resolutionOptions || TIERS) : TIERS;
  for(const ratio of imageRatios(caps)) for(const tier of tiers){
    if(ratio.v[tier] === size) return {ratio, tier, size};
  }
  if(includeLegacy && caps.imageSizePolicy === 'futureai-ratio'){
    for(const old of RATIOS) for(const tier of TIERS){
      const ratio = imageRatios(caps).find(item=>item.r === old.r);
      if(old.v[tier] === size && ratio?.v[tier]) return {ratio,tier,size:ratio.v[tier],legacy:true};
    }
  }
  if(includeLegacy && caps.imageSizePolicy === 'change2pro-studio'){
    for(const old of RATIOS) for(const tier of TIERS){
      const ratio = imageRatios(caps).find(item=>item.r === old.r);
      if(old.v[tier] === size && ratio?.v[tier]) return {ratio, tier, size:ratio.v[tier], legacy:true};
    }
  }
  return null;
}

export function normalizeStudioDimensions(width, height){
  const step = 16, maxSide = 3840, maxPixels = 8294400, minPixels = 655360;
  const round = x=>Math.max(step,Math.round(x / step) * step);
  const down = x=>Math.max(step,Math.floor(x / step) * step);
  const up = x=>Math.max(step,Math.ceil(x / step) * step);
  let w=round(width),h=round(height);
  for(let i=0;i<4;i++){
    let longest=Math.max(w,h);
    if(longest > maxSide){ const scale=maxSide/longest; w=down(w*scale); h=down(h*scale); }
    if(w/h > 3) w=down(h*3); else if(h/w > 3) h=down(w*3);
    const pixels=w*h;
    if(pixels > maxPixels){ const scale=Math.sqrt(maxPixels/pixels); w=down(w*scale); h=down(h*scale); }
    else if(pixels < minPixels){ const scale=Math.sqrt(minPixels/pixels); w=up(w*scale); h=up(h*scale); }
  }
  return w+'x'+h;
}

export function resolveImageSize(size, caps = {}, mode = ''){
  if(caps.imageSizePolicy !== 'change2pro-studio') return size;
  if(mode !== 'custom'){
    const found=findImageSize(size,caps);
    if(found) return found.size;
  }
  const match=/^(\d+)x(\d+)$/.exec(String(size));
  return match ? normalizeStudioDimensions(Number(match[1]),Number(match[2])) : size;
}
