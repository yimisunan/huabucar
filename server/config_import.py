# -*- coding: utf-8 -*-
"""Short-lived local configuration handoff to the user's existing browser origin."""
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import secrets
import time
from urllib.parse import parse_qs, quote, urlsplit

from server.config import TASK_DATA_ROOT


def handle_config_import(handler, consume=False):
    query = parse_qs(urlsplit(handler.path).query)
    token = query.get('token', [''])[0]
    try:
        local = ipaddress.ip_address(handler.client_address[0]).is_loopback
    except ValueError:
        local = False
    if not local or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', token):
        handler._send_json({'error': {'message': '配置链接无效或已过期'}}, 404)
        return
    path = Path(TASK_DATA_ROOT) / 'provider-imports' / (hashlib.sha256(token.encode()).hexdigest() + '.json')
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if float(data['expiresAt']) <= time.time():
            raise ValueError('expired')
        profile = data['profile']
        if not isinstance(profile, dict) or not profile.get('key') or not profile.get('id'):
            raise ValueError('profile')
    except (OSError, ValueError, KeyError, TypeError):
        handler._send_json({'error': {'message': '配置链接无效或已过期，请在设置里手动选择 FutureAI'}}, 404)
        return
    if consume:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        handler._send_json({'ok': True})
        return
    nonce = secrets.token_urlsafe(24)
    serialized = json.dumps(profile, ensure_ascii=True).replace('<', '\\u003c')
    ack = json.dumps('/api/config-import?token=' + quote(token, safe=''))
    target = json.dumps('/' + quote('图片生成画布版.html'))
    html = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>载入 FutureAI 配置</title><body><p id="status">正在载入 FutureAI 配置…</p><script nonce="%s">
(async()=>{
  try{
    const profile=%s;
    const cfgKey='img2img_cfg_v1', storeKey='img2img_api_profiles_v1';
    const previousCfg=localStorage.getItem(cfgKey), previousStore=localStorage.getItem(storeKey);
    sessionStorage.setItem('futureai_import_previous',JSON.stringify({cfg:previousCfg,profiles:previousStore}));
    const cfg=JSON.parse(previousCfg||'{}');
    let raw=JSON.parse(previousStore||'{}');
    const profiles=Array.isArray(raw)?raw:(Array.isArray(raw.profiles)?raw.profiles:[]);
    if(!profiles.length && cfg.base){
      profiles.push({id:'profile_before_futureai',name:'原配置',preset:cfg.preset||'',base:cfg.base,model:cfg.model||'',chatModel:cfg.chatModel||'',chatBase:cfg.chatBase||'',proxyToken:cfg.proxyToken||'',rememberKey:!!cfg.key,key:cfg.key||'',chatKey:cfg.chatKey||''});
    }
    const i=profiles.findIndex(p=>p.id===profile.id);
    if(i<0)profiles.push(profile);else profiles[i]=profile;
    try{
      localStorage.setItem(storeKey,JSON.stringify({version:1,activeId:profile.id,profiles}));
      localStorage.setItem(cfgKey,JSON.stringify({...cfg,preset:profile.preset,base:profile.base,model:profile.model,key:profile.key,chatBase:profile.chatBase,chatKey:profile.chatKey}));
    }catch(error){
      if(previousStore===null)localStorage.removeItem(storeKey);else localStorage.setItem(storeKey,previousStore);
      if(previousCfg===null)localStorage.removeItem(cfgKey);else localStorage.setItem(cfgKey,previousCfg);
      throw error;
    }
    await fetch(%s,{method:'POST',credentials:'same-origin'}).catch(()=>{});
    location.replace(%s);
  }catch(error){document.getElementById('status').textContent='配置未能保存，请在此浏览器允许本地存储后重试。';}
})();
</script></body></html>''' % (nonce, serialized, ack, target)
    body = html.encode('utf-8')
    handler.send_response(200)
    handler.send_header('Content-Type', 'text/html; charset=utf-8')
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Referrer-Policy', 'no-referrer')
    handler.send_header('Content-Security-Policy', "default-src 'none'; script-src 'nonce-%s'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" % nonce)
    handler.send_header('Connection', 'close')
    handler.close_connection = True
    handler.end_headers()
    handler.wfile.write(body)