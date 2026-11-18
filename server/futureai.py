# -*- coding: utf-8 -*-
"""FutureAI: upload original references, submit JSON, query the accepted task."""
import json
import os
import re
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlsplit

from server.config import TASK_MAX_RESPONSE_BYTES, TASK_UPSTREAM_TIMEOUT, TASK_POLL_TIMEOUT, USER_AGENT
from server.common import TaskApiError, TaskCancelled, _api_url, _blocked_target_global, _multipart_body, _open_task_url, _read_limited, _safe_error


class FutureAIUpstreamMixin:
    @staticmethod
    def _is_futureai_protocol(spec):
        return (spec.get('protocol') or (spec.get('capabilities') or {}).get('protocol')) == 'futureai-image'

    def _future_json_request(self, request, runtime, timeout=None):
        try:
            with _open_task_url(request, timeout or TASK_UPSTREAM_TIMEOUT) as response:
                raw = _read_limited(response, TASK_MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as exc:
            detail = _safe_error(exc.read(4096).decode('utf-8', 'replace'), runtime.get('api_key', ''))
            raise TaskApiError(exc.code, 'FutureAI HTTP %d：%s' % (exc.code, detail[:500]), 'futureai_http_error') from exc
        except TaskApiError:
            raise
        except Exception as exc:
            raise TaskApiError(502, 'FutureAI 请求失败：' + _safe_error(exc, runtime.get('api_key', '')), 'futureai_request_error') from exc
        try:
            payload = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeError) as exc:
            raise TaskApiError(502, 'FutureAI 返回不是有效 JSON', 'futureai_invalid_json') from exc
        if not isinstance(payload, dict):
            raise TaskApiError(502, 'FutureAI 响应格式无效', 'futureai_invalid_payload')
        if payload.get('code') in ('fail', 'failed', 'error') or payload.get('success') is False or payload.get('error'):
            code, message = self._native_error(payload, 'FutureAI 请求失败')
            raise TaskApiError(502, _safe_error(message, runtime.get('api_key', '')), code)
        return payload

    @staticmethod
    def _future_endpoint(spec, endpoint):
        url = _api_url(spec['baseUrl'], endpoint)
        if _blocked_target_global(url):
            raise TaskApiError(403, 'FutureAI 接口地址被服务器拒绝', 'futureai_endpoint_blocked')
        return url

    @staticmethod
    def _future_size(spec, caps):
        size = str(spec.get('size') or 'auto')
        ratios = caps.get('aspectRatios') or []
        if size in ratios:
            return size
        match = re.fullmatch(r'(\d+)x(\d+)', size)
        if not match:
            raise TaskApiError(400, 'FutureAI 尺寸必须为支持的比例或像素尺寸', 'futureai_invalid_size')
        w, h = map(int, match.groups())
        if min(w, h) <= 0:
            raise TaskApiError(400, 'FutureAI 像素尺寸无效', 'futureai_invalid_size')
        # Previous canvas pixel presets have intentionally approximate aspect ratios.
        if spec.get('imageSizeMode') != 'custom':
            for ratio, tiers in (caps.get('imageSizePresets') or {}).items():
                if size in tiers.values() and ratio in ratios:
                    return ratio
        if spec.get('imageSizeMode') == 'custom' and 'pixel' in (caps.get('sizeModes') or []):
            if max(w, h) > 3840 or w * h > 8294400 or max(w, h) / min(w, h) > 3 or w % 16 or h % 16:
                raise TaskApiError(400, 'FutureAI 自定义尺寸需为16的倍数，最长边≤3840，总像素≤8294400，比例≤3:1', 'futureai_invalid_size')
            return size
        for allowed in ratios:
            if ':' in allowed:
                a, b = map(int, allowed.split(':'))
                if w * b == h * a:
                    return allowed
        raise TaskApiError(400, '当前 FutureAI 模型只支持这些比例：' + '、'.join(ratios), 'futureai_invalid_size')

    def _future_upload_references(self, runtime, caps):
        files = runtime.get('files') or []
        if len(files) > int(caps.get('maxReferences') or 16):
            raise TaskApiError(413, '参考图数量超过 FutureAI 当前模型上限', 'futureai_reference_limit')
        total = 0
        # Validate every file before uploading any reference.
        for item in files:
            size = os.path.getsize(item['path'])
            total += size
            if size > int(caps.get('maxRefFileBytes') or 20971520):
                raise TaskApiError(413, '参考图超过 FutureAI 当前模型的单文件上限', 'futureai_reference_limit')
            if item.get('mime') not in (caps.get('referenceMimeTypes') or ['image/png', 'image/jpeg', 'image/webp']):
                raise TaskApiError(400, 'FutureAI 参考图仅支持 PNG、JPEG、WebP', 'futureai_reference_type')
        if total > int(caps.get('maxRefTotalBytes') or 335544320):
            raise TaskApiError(413, '参考图合计超过 FutureAI 当前模型上限', 'futureai_reference_limit')
        url = self._future_endpoint(runtime['spec'], caps.get('uploadEndpoint') or '/uploads/images')
        urls = []
        for item in files:
            if runtime['cancel'].is_set():
                raise TaskCancelled()
            body, content_type = _multipart_body([], [dict(item, field='file')])
            request = urllib.request.Request(url, data=body, headers={
                'Authorization': 'Bearer ' + runtime['api_key'], 'Content-Type': content_type,
                'Accept': 'application/json', 'User-Agent': USER_AGENT,
            }, method='POST')
            payload = self._future_json_request(request, runtime)
            node = payload.get('data') if isinstance(payload.get('data'), dict) else payload
            ref = node.get('url')
            if not isinstance(ref, str) or urlsplit(ref).scheme not in ('https', 'http') or not urlsplit(ref).netloc:
                raise TaskApiError(502, 'FutureAI 上传成功但没有有效图片 URL', 'futureai_upload_url_missing')
            urls.append(ref)
        return urls

    def _build_futureai_request(self, runtime):
        spec = runtime['spec']
        caps = self._effective_caps(spec)
        if runtime.get('inpaint') or spec.get('inpaint'):
            raise TaskApiError(400, 'FutureAI 未声明蒙版编辑接口，请使用支持蒙版的供应商', 'futureai_mask_unsupported')
        prompt = str(spec.get('requestPrompt') or spec.get('prompt') or '')
        if not prompt.strip() or len(prompt) > int(caps.get('promptMaxChars') or 2000):
            raise TaskApiError(400, 'FutureAI 提示词须为1～%d个字符（含参考图说明）' % int(caps.get('promptMaxChars') or 2000), 'futureai_prompt_limit')
        resolution = str(spec.get('resolution') or caps.get('defaultResolution') or '1K').upper()
        if resolution not in (caps.get('resolutionOptions') or ['1K', '2K', '4K']):
            raise TaskApiError(400, 'FutureAI 当前模型不支持分辨率 ' + resolution, 'futureai_resolution_invalid')
        body = {'model': spec['model'], 'prompt': prompt, 'size': self._future_size(spec, caps), 'resolution': resolution}
        body.update(self._option_values(spec))
        if spec.get('mode') == 'img2img':
            if not runtime.get('files'):
                raise TaskApiError(400, '图生图任务缺少参考图', 'futureai_reference_missing')
            body['image_urls'] = self._future_upload_references(runtime, caps)
        if runtime['cancel'].is_set():
            raise TaskCancelled()
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self._check_body_limit(data, caps)
        url = self._future_endpoint(spec, '/images/generations')
        return urllib.request.Request(url, data=data, headers={
            'Authorization': 'Bearer ' + runtime['api_key'], 'Content-Type': 'application/json',
            'Accept': 'application/json', 'User-Agent': USER_AGENT,
        }, method='POST')

    @staticmethod
    def _future_task_id(payload):
        for node in (payload, payload.get('data'), payload.get('result')):
            if isinstance(node, dict):
                value = node.get('taskId') or node.get('task_id') or node.get('id')
                if value:
                    return str(value)
        return ''

    def _future_result(self, payload):
        state = self._native_status(payload)
        if state in ('fail', 'failed', 'failure', 'error', 'cancelled', 'canceled'):
            code, message = self._native_error(payload, 'FutureAI 图片任务失败')
            raise TaskApiError(502, message, code)
        items = self._native_result_items(payload)
        if items and state not in ('pending', 'queued', 'running', 'processing', 'submitted', 'accepted'):
            return items
        if state in ('success', 'succeeded', 'done', 'completed', 'complete'):
            # Some APIs use success for submission, so an ID without images still needs polling.
            if not self._future_task_id(payload):
                raise TaskApiError(502, 'FutureAI 任务完成但没有图片', 'futureai_result_missing')
        return None

    def _call_futureai_task(self, runtime):
        # No retry of generation: the site does not document idempotent submission.
        payload = self._future_json_request(self._build_futureai_request(runtime), runtime)
        task_id = self._future_task_id(payload)
        if task_id:
            self._save_provider_task_id(runtime.get('job_id'), task_id)
        result = self._future_result(payload)
        if result:
            return result
        if not task_id:
            raise TaskApiError(502, 'FutureAI 响应缺少图片和任务编号，请在站点后台核对；不会自动重发', 'futureai_task_id_missing')
        return self._poll_futureai_task(runtime, task_id)

    def _poll_futureai_task(self, runtime, task_id):
        url = self._future_endpoint(runtime['spec'], '/tasks/' + quote(str(task_id), safe=''))
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + runtime['api_key'], 'Accept': 'application/json', 'User-Agent': USER_AGENT})
        deadline = time.monotonic() + TASK_UPSTREAM_TIMEOUT
        delay, failures = 3.0, 0
        while time.monotonic() < deadline:
            if runtime['cancel'].wait(min(delay, max(0, deadline - time.monotonic()))):
                raise TaskCancelled()
            try:
                payload = self._future_json_request(request, runtime, TASK_POLL_TIMEOUT)
            except TaskApiError as exc:
                if exc.status in (404, 408, 429, 500, 502, 503, 504) and failures < 8:
                    failures += 1
                    delay = min(delay * 2, 15)
                    continue
                raise
            failures, delay = 0, 3.0
            result = self._future_result(payload)
            if result:
                return result
        raise TaskApiError(504, 'FutureAI 原任务查询超时，可恢复查询；不会自动重发生成', 'futureai_poll_timeout')
