# -*- coding: utf-8 -*-
"""图片任务上游协议适配层（OpenAI 同步/流式 SSE、OpenAI 异步、原生任务协议）。"""

import base64
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urljoin, urlparse

from server.config import (
    TASK_MAX_REF_BYTES,
    TASK_MAX_RESULTS,
    TASK_MAX_RESPONSE_BYTES,
    TASK_POLL_FAIL_WINDOW,
    TASK_POLL_MAX_FAILS,
    TASK_POLL_TIMEOUT,
    TASK_RESULT_DOWNLOAD_ATTEMPTS,
    TASK_UPSTREAM_TIMEOUT,
    USER_AGENT,
    log_server_line,
)
from server.image_sizes import resolve_image_size
from server.futureai import FutureAIUpstreamMixin
from server.common import (
    TaskApiError,
    TaskCancelled,
    _api_url,
    _atomic_write,
    _blocked_target_global,
    _decode_b64_image,
    _guess_image_mime,
    _http_get_with_retry,
    _multipart_body,
    _open_task_url,
    _read_limited,
    _safe_error,
    _sanitize_spec,
)


class ImageUpstreamMixin(FutureAIUpstreamMixin):
    """图片上游请求构造、轮询与结果解析混入类（供 TaskManager 继承）。"""

    @staticmethod
    def _check_body_limit(data, caps):
        limit = float(caps.get("maxBodyMiB") or 0) * 1024 * 1024
        if limit and len(data) > limit:
            raise TaskApiError(413, "序列化请求体超过供应商 %.0f MiB 上限（含 base64/表单开销），请减少参考图或改用直传预设" % (limit / 1048576), "provider_body_too_large")

    @staticmethod
    def _effective_caps(spec):
        base = spec.get("capabilities") if isinstance(spec.get("capabilities"), dict) else {}
        caps = dict(base)
        params = dict(base.get("imageParams") or {})
        override = {} if base.get("resolvedForModel") == spec.get("model") else (base.get("modelOverrides") or {}).get(str(spec.get("model") or "")) or {}
        for key, value in override.items():
            if key in ("quality", "n", "mask", "resolution", "stream", "size", "background", "outputFormat", "responseFormat", "seed", "colorCorrection", "resizeMethod", "complexity"):
                params[key] = value
            else:
                caps[key] = value
        import re
        if re.match(r"^gpt-image-2\.6(?:$|-)", str(spec.get("model") or ""), re.I) and str(spec.get("outputFormat") or "").lower() == "gif":
            params["outputFormat"] = True
            caps["outputFormatOptions"] = list(dict.fromkeys(list(caps.get("outputFormatOptions") or []) + ["gif"]))
        pattern = caps.get("complexityModelPattern")
        if pattern:
            try:
                if re.match(str(pattern), str(spec.get("model") or ""), re.I):
                    params["complexity"] = True
            except re.error:
                pass
        caps["imageParams"] = params
        return caps

    def _option_values(self, spec):
        caps = self._effective_caps(spec)
        params = caps.get("imageParams") if isinstance(caps.get("imageParams"), dict) else {}
        values = []
        for key, request_key in (("quality", "quality"), ("background", "background"), ("outputFormat", "output_format")):
            value = spec.get(key)
            allowed = params.get(key, True) not in (False, "unsupported")
            options = caps.get({"quality":"qualityOptions", "background":"backgroundOptions", "outputFormat":"outputFormatOptions"}[key])
            if value and allowed and (not isinstance(options, list) or value in options):
                values.append((request_key, value))
        complexity = spec.get("complexity")
        if complexity and params.get("complexity") is True:
            if complexity not in caps.get("complexityOptions", ["low", "medium", "high"]):
                raise TaskApiError(400, "规划复杂度必须为 low、medium 或 high", "invalid_complexity")
            values.append(("complexity", complexity))
        return values

    @staticmethod
    def _is_native_protocol(spec):
        caps = spec.get("capabilities") if isinstance(spec.get("capabilities"), dict) else {}
        protocol = spec.get("protocol") or caps.get("protocol") or ""
        return str(protocol).strip().lower() in ("65535-native-task", "65535-native")

    @staticmethod
    def _native_status(payload):
        if not isinstance(payload, dict):
            return ""
        value = payload.get("status") or payload.get("state") or payload.get("task_status") or ""
        if not value and isinstance(payload.get("data"), dict):
            data = payload["data"]
            value = data.get("status") or data.get("state") or ""
        return str(value or "").strip().lower().replace("-", "_")

    @staticmethod
    def _native_task_id(payload):
        if not isinstance(payload, dict):
            return ""
        for key in ("id", "task_id", "taskId"):
            if payload.get(key):
                return str(payload[key])
        data = payload.get("data")
        if isinstance(data, dict):
            for key in ("id", "task_id", "taskId"):
                if data.get(key):
                    return str(data[key])
        return ""

    @staticmethod
    def _shrink(node, limit=200, depth=0):
        """打印上游回包前把 base64 之类的巨串压成标记，避免日志被水没。"""
        if depth > 3:
            return node
        if isinstance(node, dict):
            return {k: ImageUpstreamMixin._shrink(v, limit, depth + 1) for k, v in list(node.items())[:24]}
        if isinstance(node, list):
            return [ImageUpstreamMixin._shrink(v, limit, depth + 1) for v in node[:6]]
        if isinstance(node, str) and len(node) > limit:
            return node[:limit] + "…(len=%d)" % len(node)
        return node

    @staticmethod
    def _deep_find_message(node, depth=0):
        """各中转站错误字段名差异极大，在任意嵌套里找第一个可读的错误文案。"""
        if depth > 4:
            return ""
        if isinstance(node, dict):
            for key in ("message", "msg", "detail", "reason", "fail_reason", "failReason", "error_message", "errorMessage"):
                value = node.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            for key in ("error", "data", "result", "response", "errors"):
                if key in node:
                    found = ImageUpstreamMixin._deep_find_message(node.get(key), depth + 1)
                    if found:
                        return found
            for value in node.values():
                if isinstance(value, (dict, list)):
                    found = ImageUpstreamMixin._deep_find_message(value, depth + 1)
                    if found:
                        return found
        elif isinstance(node, list):
            for item in node:
                found = ImageUpstreamMixin._deep_find_message(item, depth + 1)
                if found:
                    return found
        return ""

    @staticmethod
    def _native_error(payload, fallback="原生图片任务失败"):
        try:
            log_server_line("NATIVE-PAYLOAD " + json.dumps(ImageUpstreamMixin._shrink(payload), ensure_ascii=False)[:1500])
        except Exception:
            pass
        code = "native_task_error"
        message = fallback
        if isinstance(payload, dict):
            value = payload.get("error")
            if isinstance(value, dict):
                code = str(value.get("code") or value.get("type") or payload.get("error_code") or code)
                message = value.get("message") or value.get("detail") or message
            elif value:
                message = value
            else:
                code = str(payload.get("error_code") or payload.get("code") or code)
                message = payload.get("message") or payload.get("detail") or message
        if message == fallback:
            deep = ImageUpstreamMixin._deep_find_message(payload)
            if deep:
                message = deep
        return code, _safe_error(message)

    @staticmethod
    def _native_result_items(payload):
        """Prefer the primary image list, pairing mirrored result_urls by index."""
        def item(value):
            if isinstance(value, str):
                return {"url": value} if value.startswith(("data:", "http://", "https://", "/")) else None
            if not isinstance(value, dict):
                return None
            b64 = value.get("b64_json") or value.get("b64") or value.get("base64")
            url = value.get("url") or value.get("image_url") or value.get("imageUrl") or value.get("result_url") or value.get("resultUrl")
            if isinstance(url, dict):
                url = url.get("url")
            if not b64 and not url:
                return None
            result = {}
            if b64:
                result["b64_json"] = b64
            if url:
                result["url"] = str(url)
            return result

        def find(value, depth=0):
            if depth > 8:
                return []
            if isinstance(value, list):
                out = []
                for entry in value:
                    out.extend(find(entry, depth + 1))
                return out
            direct = item(value)
            if direct:
                return [direct]
            if isinstance(value, dict):
                for key in ("result", "data", "output", "images", "results", "image_urls", "urls", "result_urls", "resultUrls"):
                    found = find(value.get(key), depth + 1)
                    if found:
                        return found
            return []

        items = find(payload)
        mirrors = payload.get("result_urls") or payload.get("resultUrls") if isinstance(payload, dict) else None
        if isinstance(mirrors, list) and len(mirrors) == len(items):
            for result, mirror in zip(items, mirrors):
                fallback = item(mirror)
                if fallback and fallback.get("url") and not result.get("url"):
                    result["url"] = fallback["url"]
        return items[:TASK_MAX_RESULTS]

    def _native_json_request(self, request, runtime, timeout=None):
        try:
            with _open_task_url(request, timeout or TASK_UPSTREAM_TIMEOUT) as response:
                raw = _read_limited(response, TASK_MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as exc:
            try:
                detail_raw = exc.read(4096).decode("utf-8", "replace")
                detail_payload = json.loads(detail_raw) if detail_raw else {}
            except Exception:
                detail_raw, detail_payload = "", {}
            code, detail = self._native_error(detail_payload, detail_raw or "上游任务请求失败")
            raise TaskApiError(exc.code, "上游任务 HTTP %d：%s" % (exc.code, detail[:500]), code) from exc
        except TaskApiError:
            raise
        except Exception as exc:
            raise TaskApiError(502, "请求 65535 原生任务失败：" + _safe_error(exc, runtime.get("api_key", "")), "native_request_error") from exc
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise TaskApiError(502, "65535 原生任务返回不是有效 JSON", "native_invalid_json") from exc
        if not isinstance(payload, dict):
            raise TaskApiError(502, "65535 原生任务响应格式无效", "native_invalid_payload")
        return payload

    def _build_native_task_request(self, runtime):
        spec = runtime["spec"]
        base = str(spec["baseUrl"]).rstrip("/")
        caps = self._effective_caps(spec)
        endpoint = str(spec.get("taskEndpoint") or caps.get("taskEndpoint") or "/v1/tasks")
        if not endpoint.startswith("/") or "://" in endpoint:
            raise TaskApiError(400, "原生任务接口路径无效", "native_endpoint_invalid")
        url = _api_url(base, endpoint)
        if _blocked_target_global(url):
            raise TaskApiError(403, "任务拒绝访问原生任务接口地址", "native_endpoint_blocked")

        params = caps.get("imageParams") if isinstance(caps.get("imageParams"), dict) else {}
        prompt = str(spec.get("requestPrompt") or spec.get("prompt") or "")
        if not prompt.strip():
            raise TaskApiError(400, "缺少图片提示词", "native_prompt_missing")
        input_data = {"prompt": prompt}
        for key, value in self._option_values(spec):
            if key == "complexity":
                input_data[key] = value
        for source_key, target_key in (("size", "size"), ("resolution", "resolution"), ("quality", "quality")):
            value = spec.get(source_key)
            if value and params.get(source_key, True) is not False:
                input_data[target_key] = value
        negative = str(spec.get("requestNegative") or spec.get("negative") or "")
        if negative and caps.get("negativePrompt", True) is not False:
            input_data["negative_prompt"] = negative
        try:
            n = int(spec.get("n") or 1)
        except Exception:
            n = 1
        if params.get("n", True) is not False and n > 0:
            input_data["n"] = n
        response_format = spec.get("responseFormat") or caps.get("preferredResponseFormat") or ""
        if response_format and params.get("responseFormat", True) is not False:
            input_data["response_format"] = response_format
        output_format = spec.get("outputFormat") or ""
        if isinstance(caps.get("outputFormatOptions"), list) and output_format not in caps["outputFormatOptions"]:
            output_format = ""
        if output_format and params.get("outputFormat", False) not in (False, "unsupported"):
            input_data["output_format"] = output_format

        # 特殊参数（seed / color_correction / resize_method）过滤规则：
        # 1) 布尔 false 一律不下发。上游普遍把未知参数当硬错误（65535 会直接回
        #    "Unknown parameter: color_correction" 并在某些路径上断开连接）。
        # 2) color_correction / resize_method 属于个别模型专有参数，只有能力表显式支持才下发：
        #    modelOverrides.<model>.specialParams 里列了它，或 imageParams 里显式写了 true。
        _model_name = str(spec.get("model") or "")
        _overrides = caps.get("modelOverrides") if isinstance(caps.get("modelOverrides"), dict) else {}
        _model_cfg = _overrides.get(_model_name) if isinstance(_overrides, dict) else None
        _special = _model_cfg.get("specialParams") if isinstance(_model_cfg, dict) else None
        _special = _special if isinstance(_special, list) else []
        for source_key, target_key in (("seed", "seed"), ("colorCorrection", "color_correction"), ("resizeMethod", "resize_method")):
            value = spec.get(source_key)
            if value in (None, "") or value is False:
                continue
            allow = params.get(source_key, None)
            if allow is False:
                continue
            if source_key in ("colorCorrection", "resizeMethod") and allow is not True:
                if target_key not in _special and source_key not in _special:
                    continue
            input_data[target_key] = value

        refs = runtime.get("files") or []
        mode = str(spec.get("mode") or "txt2img")
        if mode == "img2img":
            if runtime.get("inpaint"):
                image_items = [x for x in refs if x.get("field") in ("image", "inpaint_image")]
                mask_items = [x for x in refs if x.get("field") in ("mask", "inpaint_mask")]
                if not image_items or not mask_items:
                    raise TaskApiError(400, "涂抹重绘任务缺少原图或蒙版", "native_mask_missing")
                input_data["image"] = self._file_data_uri(image_items[0])
                input_data["mask"] = self._file_data_uri(mask_items[0])
            else:
                uris = [self._file_data_uri(item) for item in refs]
                if not uris:
                    raise TaskApiError(400, "原生图生图任务缺少参考图", "native_reference_missing")
                strategy = str(spec.get("referenceFieldStrategy") or caps.get("referenceFieldStrategy") or "image_urls")
                if strategy == "image":
                    input_data["image"] = uris[0]
                elif strategy == "image_url":
                    input_data["image_url"] = uris[0]
                elif strategy == "images":
                    input_data["images"] = uris
                else:
                    input_data["image_urls"] = uris

        try:
            _shape = {}
            for _k, _v in input_data.items():
                if isinstance(_v, str) and _v.startswith("data:"):
                    _shape[_k] = "dataURI(%d chars,%s)" % (len(_v), _v[5:_v.find(";", 5)] or "?")
                elif isinstance(_v, list):
                    _shape[_k] = "[%s]" % ",".join(
                        ("dataURI(%d chars,%s)" % (len(x), x[5:x.find(";", 5)] or "?")) if isinstance(x, str) and x.startswith("data:")
                        else ("str(%d)" % len(x)) if isinstance(x, str) else type(x).__name__ for x in _v)
                else:
                    _shape[_k] = _v
            log_server_line("NATIVE-SEND strategy=%s operation=%s model=%s input=%s" % (
                locals().get("strategy", "-"), "edit" if mode == "img2img" else "generate",
                str(spec.get("model") or ""), json.dumps(_shape, ensure_ascii=False)[:600]))
        except Exception:
            pass
        body = {
            "kind": "image",
            "model": str(spec.get("model") or ""),
            "operation": "edit" if mode == "img2img" else "generate",
            "input": input_data,
        }
        client_id = str(spec.get("clientTaskId") or "")
        idem = "imgtask-" + hashlib.sha256(client_id.encode("utf-8")).hexdigest()[:48]
        headers = {
            "Authorization": "Bearer " + runtime["api_key"],
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": idem,
            "User-Agent": USER_AGENT,
        }
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self._check_body_limit(data, caps)
        return urllib.request.Request(url, data=data, headers=headers, method="POST")

    @staticmethod
    def _file_data_uri(item):
        with open(item["path"], "rb") as fh:
            data = fh.read(TASK_MAX_REF_BYTES + 1)
        if len(data) > TASK_MAX_REF_BYTES:
            raise TaskApiError(413, "参考图超过单文件大小限制", "native_reference_too_large")
        return "data:%s;base64,%s" % (item.get("mime") or "application/octet-stream", base64.b64encode(data).decode("ascii"))

    @staticmethod
    def _is_openai_async_protocol(spec):
        caps = spec.get("capabilities") if isinstance(spec.get("capabilities"), dict) else {}
        protocol = spec.get("protocol") or caps.get("protocol") or ""
        return str(protocol).strip().lower() in ("openai-async-image", "openai-async")

    @staticmethod
    def _async_endpoints(spec):
        caps = spec.get("capabilities") if isinstance(spec.get("capabilities"), dict) else {}
        endpoints = caps.get("asyncEndpoints") if isinstance(caps.get("asyncEndpoints"), dict) else {}
        return endpoints, caps

    def _async_status_request(self, runtime, task_ref):
        """查询 OpenAI 风格异步图像任务。

        上游可能给三种形态：完整 URL、站内绝对路径（如 /v1/images/tasks/<id>，相对域名根而非 baseUrl）、
        或纯任务编号（此时套用 capabilities.asyncEndpoints.status 模板）。
        """
        import urllib.parse as _uparse
        spec = runtime["spec"]
        endpoints, caps = self._async_endpoints(spec)
        fallback_status = "/images/tasks/{id}" if str(spec["baseUrl"]).rstrip("/").endswith("/v1") else "/v1/images/tasks/{id}"
        template = str(endpoints.get("status") or caps.get("asyncStatusEndpoint") or fallback_status)
        ref = str(task_ref or "").strip()
        base = str(spec["baseUrl"]).rstrip("/")
        if ref.startswith("http://") or ref.startswith("https://"):
            url = ref
        elif ref.startswith("/"):
            parts = _uparse.urlsplit(base)
            url = "%s://%s%s" % (parts.scheme, parts.netloc, ref)
        else:
            encoded = quote(ref, safe="")
            endpoint = template.replace("{id}", encoded)
            if "{id}" not in template and endpoint.rstrip("/").endswith("/images/tasks"):
                endpoint = endpoint.rstrip("/") + "/" + encoded
            if not endpoint.startswith("/") or "://" in endpoint:
                raise TaskApiError(400, "异步任务状态接口路径无效", "async_status_endpoint_invalid")
            url = _api_url(base, endpoint)
        if _blocked_target_global(url):
            raise TaskApiError(403, "任务拒绝访问异步任务状态接口", "async_status_endpoint_blocked")
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + runtime["api_key"], "Accept": "application/json", "User-Agent": USER_AGENT}, method="GET")
        return self._native_json_request(request, runtime, TASK_POLL_TIMEOUT)

    def _build_openai_async_request(self, runtime):
        """复用 OpenAI 兼容请求体的构造（JSON / multipart），只把端点换成异步任务端点。"""
        spec = runtime["spec"]
        endpoints, _caps = self._async_endpoints(spec)
        mode = str(spec.get("mode") or "txt2img")
        key_name = "edit" if mode == "img2img" else "generate"
        endpoint = str(endpoints.get(key_name) or "")
        if not endpoint:
            prefix = "" if str(spec["baseUrl"]).rstrip("/").endswith("/v1") else "/v1"
            endpoint = "%s/images/%s/async" % (prefix, "edits" if mode == "img2img" else "generations")
        if not endpoint.startswith("/") or "://" in endpoint:
            raise TaskApiError(400, "异步图像任务端点无效", "async_endpoint_invalid")
        base = self._build_upstream_request(runtime)
        url = _api_url(spec["baseUrl"], endpoint)
        if _blocked_target_global(url):
            raise TaskApiError(403, "任务拒绝访问异步图像任务端点", "async_endpoint_blocked")
        headers = dict(base.headers)
        client_id = str(spec.get("clientTaskId") or "")
        if client_id:
            headers["Idempotency-Key"] = "imgasync-" + hashlib.sha256(client_id.encode("utf-8")).hexdigest()[:48]
        return urllib.request.Request(url, data=base.data, headers=headers, method="POST")

    def _call_openai_async_task(self, runtime):
        payload = None
        last_error = None
        caps = runtime["spec"].get("capabilities") or {}
        attempts = 2 if caps.get("supportsIdempotency") is True else 1
        for attempt in range(attempts):
            try:
                payload = self._native_json_request(self._build_openai_async_request(runtime), runtime)
                break
            except TaskApiError as exc:
                last_error = exc
                retriable = exc.status in (408, 409, 429, 500, 502, 503, 504) or exc.code == "native_request_error"
                if attempt + 1 < attempts and retriable and not runtime["cancel"].is_set():
                    time.sleep(2.0 * (attempt + 1))
                    continue
                raise
        if payload is None:
            if last_error is not None:
                raise last_error
            raise TaskApiError(502, "异步图像任务提交失败", "async_request_error")
        log_server_line("ASYNC-SEND " + json.dumps(self._shrink(payload), ensure_ascii=False)[:400])
        self._save_task_meta(runtime.get("job_id"), payload)
        state = self._native_status(payload)
        items = self._native_result_items(payload)
        if items and (not state or state in ("done", "completed", "complete", "succeeded", "success")):
            return items
        if state in ("failed", "failure", "error", "cancelled", "canceled", "aborted"):
            code, message = self._native_error(payload)
            raise TaskApiError(502, message, code)
        task_id = self._native_task_id(payload)
        poll_ref = str(payload.get("poll_url") or payload.get("status_url") or task_id or "").strip()
        if not poll_ref:
            raise TaskApiError(502, "异步图像任务响应缺少任务编号", "async_task_id_missing")
        self._save_provider_task_id(runtime.get("job_id"), task_id or poll_ref)
        self._save_task_meta(runtime.get("job_id"), {"provider_poll_ref": poll_ref})
        return self._poll_openai_async_task(runtime, poll_ref)

    def _poll_openai_async_task(self, runtime, task_ref):
        _endpoints, caps = self._async_endpoints(runtime["spec"])
        try:
            interval = float(caps.get("pollIntervalMs") or 4000) / 1000.0
        except Exception:
            interval = 4.0
        interval = min(max(interval, 1.0), 15.0)
        deadline = time.time() + TASK_UPSTREAM_TIMEOUT
        delay = interval
        last_state = ""
        poll_fails = 0
        first_fail_at = None
        while time.time() < deadline:
            if runtime["cancel"].is_set():
                raise TaskCancelled()
            if runtime["cancel"].wait(min(delay, max(0.0, deadline - time.time()))):
                raise TaskCancelled()
            try:
                payload = self._async_status_request(runtime, task_ref)
                self._save_task_meta(runtime.get("job_id"), payload)
                poll_fails = 0
                first_fail_at = None
            except TaskApiError as exc:
                if exc.status in (404, 408, 409, 429) or 500 <= exc.status < 600 or exc.code == "native_request_error":
                    poll_fails += 1
                    if first_fail_at is None:
                        first_fail_at = time.time()
                    log_server_line("POLL-ERR job=%s code=%s status=%s fails=%d %s" % (runtime.get("job_id"), exc.code, exc.status, poll_fails, str(exc.message)[:160]))
                    if poll_fails >= TASK_POLL_MAX_FAILS or (time.time() - first_fail_at) > TASK_POLL_FAIL_WINDOW:
                        raise TaskApiError(504, "上游任务状态接口连续 %d 次不可达（%s），已停止等待；可点「恢复」重试" % (poll_fails, exc.code or exc.status), "poll_unreachable") from exc
                    delay = min(delay * 2.0, 15.0)
                    continue
                raise
            state = self._native_status(payload)
            if state:
                last_state = state
            items = self._native_result_items(payload)
            if state in ("failed", "failure", "error", "cancelled", "canceled", "aborted"):
                code, message = self._native_error(payload)
                raise TaskApiError(502, message, code)
            if state in ("done", "completed", "complete", "succeeded", "success"):
                if not items:
                    raise TaskApiError(502, "异步图像任务完成但没有图片结果", "async_result_missing")
                log_server_line("ASYNC-OK state=%s items=%d" % (state, len(items)))
                return items
            if items and state not in ("pending", "queued", "running", "processing"):
                log_server_line("ASYNC-OK state=%s items=%d" % (state or "-", len(items)))
                return items
            delay = interval
        raise TaskApiError(504, "异步图像任务超时（最后状态：%s）" % (last_state or "未知"), "async_task_timeout")

    def _native_status_request(self, runtime, task_id):
        spec = runtime["spec"]
        caps = spec.get("capabilities") if isinstance(spec.get("capabilities"), dict) else {}
        endpoint = str(spec.get("taskStatusEndpoint") or caps.get("taskStatusEndpoint") or "/v1/tasks/{id}")
        encoded = quote(str(task_id), safe="")
        endpoint = endpoint.replace("{id}", encoded)
        if "{id}" not in str(spec.get("taskStatusEndpoint") or caps.get("taskStatusEndpoint") or "/v1/tasks/{id}") and endpoint.rstrip("/").endswith("/v1/tasks"):
            endpoint = endpoint.rstrip("/") + "/" + encoded
        if not endpoint.startswith("/") or "://" in endpoint:
            raise TaskApiError(400, "原生任务状态接口路径无效", "native_status_endpoint_invalid")
        url = _api_url(spec["baseUrl"], endpoint)
        if _blocked_target_global(url):
            raise TaskApiError(403, "任务拒绝访问原生任务状态接口", "native_status_endpoint_blocked")
        request = urllib.request.Request(url, headers={"Authorization": "Bearer " + runtime["api_key"], "Accept": "application/json", "User-Agent": USER_AGENT}, method="GET")
        return self._native_json_request(request, runtime, TASK_POLL_TIMEOUT)

    def _call_native_task(self, runtime):
        payload = self._native_create_with_retry(runtime)
        self._save_task_meta(runtime.get("job_id"), payload)
        task_id = self._native_task_id(payload)
        if task_id:
            self._save_provider_task_id(runtime.get("job_id"), task_id)
        items = self._native_result_items(payload)
        state = self._native_status(payload)
        if items and (state in ("", "done", "completed", "complete", "succeeded", "success") or not task_id):
            return items
        if state in ("failed", "failure", "error", "cancelled", "canceled", "aborted"):
            code, message = self._native_error(payload)
            raise TaskApiError(502, message, code)
        if not task_id:
            raise TaskApiError(502, "原生任务响应缺少任务 ID", "native_task_id_missing")
        return self._poll_native_task(runtime, task_id)

    def _save_provider_task_id(self, job_id, task_id):
        if not job_id or not task_id:
            return
        try:
            with self._connect() as conn:
                conn.execute("UPDATE tasks SET provider_task_id=? WHERE job_id=?", (str(task_id), str(job_id)))
        except Exception:
            pass

    def _save_task_meta(self, job_id, payload):
        """把上游终态里的成本/耗时/过期等展示字段落库；纯展示用途，任何失败都不影响任务本身。"""
        if not job_id or not isinstance(payload, dict):
            return
        fields = ("cost_usd", "upstream_ms", "queue_ms", "retry_count", "image_size_tier", "expires_at", "finished_at", "created_at", "provider_poll_ref", "result_warning", "result_count_expected", "result_count_saved")
        meta = {}
        for key in fields:
            value = payload.get(key)
            if value not in (None, "") or key == "result_warning" and key in payload:
                meta[key] = value
        if not meta:
            return
        try:
            with self._connect() as conn:
                row = conn.execute("SELECT meta_json FROM tasks WHERE job_id=?", (str(job_id),)).fetchone()
                current = {}
                if row is not None:
                    try:
                        current = json.loads(row["meta_json"] or "{}")
                    except Exception:
                        current = {}
                if not isinstance(current, dict):
                    current = {}
                current.update(meta)
                conn.execute("UPDATE tasks SET meta_json=? WHERE job_id=?", (json.dumps(current, ensure_ascii=False), str(job_id)))
        except Exception:
            pass

    def _native_create_with_retry(self, runtime):
        last_error = None
        caps = runtime["spec"].get("capabilities") or {}
        attempts = 2 if caps.get("supportsIdempotency") is True else 1
        for attempt in range(attempts):
            try:
                return self._native_json_request(self._build_native_task_request(runtime), runtime)
            except TaskApiError as exc:
                last_error = exc
                retriable = exc.status in (408, 409, 429, 500, 502, 503, 504) or exc.code == "native_request_error"
                if attempt + 1 < attempts and retriable and not runtime["cancel"].is_set():
                    time.sleep(2.0 * (attempt + 1))
                    continue
                raise
        if last_error is not None:
            raise last_error
        raise TaskApiError(502, "原生任务提交失败", "native_request_error")

    def _poll_native_task(self, runtime, task_id):
        deadline = time.time() + TASK_UPSTREAM_TIMEOUT
        delay = 2.0
        poll_fails = 0
        first_fail_at = None
        while time.time() < deadline:
            if runtime["cancel"].wait(min(delay, max(0.0, deadline - time.time()))):
                raise TaskCancelled()
            try:
                payload = self._native_status_request(runtime, task_id)
                self._save_task_meta(runtime.get("job_id"), payload)
                poll_fails = 0
                first_fail_at = None
            except TaskApiError as exc:
                if exc.status in (404, 408, 409, 429) or 500 <= exc.status < 600 or exc.code == "native_request_error":
                    poll_fails += 1
                    if first_fail_at is None:
                        first_fail_at = time.time()
                    log_server_line("POLL-ERR job=%s code=%s status=%s fails=%d %s" % (runtime.get("job_id"), exc.code, exc.status, poll_fails, str(exc.message)[:160]))
                    if poll_fails >= TASK_POLL_MAX_FAILS or (time.time() - first_fail_at) > TASK_POLL_FAIL_WINDOW:
                        raise TaskApiError(504, "上游任务状态接口连续 %d 次不可达（%s），已停止等待；可点「恢复」重试" % (poll_fails, exc.code or exc.status), "poll_unreachable") from exc
                    delay = min(delay * 2.0, 15.0)
                    continue
                raise
            state = self._native_status(payload)
            items = self._native_result_items(payload)
            if state in ("failed", "failure", "error", "cancelled", "canceled", "aborted"):
                code, message = self._native_error(payload)
                raise TaskApiError(502, message, code)
            if items and (state in ("", "done", "completed", "complete", "succeeded", "success") or state not in ("pending", "queued", "running", "processing")):
                return items
            if state in ("done", "completed", "complete", "succeeded", "success"):
                raise TaskApiError(502, "原生任务完成但没有图片结果", "native_result_missing")
            delay = 2.0
        raise TaskApiError(504, "65535 原生图片任务超时", "native_task_timeout")

    def _build_upstream_request(self, runtime, stream=False):
        spec = runtime["spec"]
        if self._is_native_protocol(spec):
            return self._build_native_task_request(runtime)
        base = str(spec["baseUrl"]).rstrip("/")
        caps = self._effective_caps(spec)
        endpoints = caps.get("imageEndpoints") if isinstance(caps.get("imageEndpoints"), dict) else {}
        mode = spec.get("mode")
        endpoint = spec.get("editEndpoint") if mode == "img2img" else spec.get("imageEndpoint")
        endpoint = endpoint or endpoints.get("edit" if mode == "img2img" else "generate") or ("/images/edits" if mode == "img2img" else "/images/generations")
        endpoint = str(endpoint)
        if not endpoint.startswith("/") or "://" in endpoint:
            raise TaskApiError(400, "图片接口路径无效")
        url = _api_url(base, endpoint)
        if _blocked_target_global(url):
            raise TaskApiError(403, "任务拒绝访问图片接口地址")
        prompt = str(spec.get("requestPrompt") or spec.get("prompt") or "")
        negative = str(spec.get("requestNegative") or spec.get("negative") or "")
        model = str(spec.get("model") or "")
        size = resolve_image_size(spec, inpaint=bool(runtime.get("inpaint")))
        n = int(spec.get("n") or 1)
        headers = {"Authorization": "Bearer " + runtime["api_key"], "Accept": "application/json", "User-Agent": USER_AGENT}
        params = caps.get("imageParams") if isinstance(caps.get("imageParams"), dict) else {}
        if mode != "img2img":
            body = {"model": model, "prompt": prompt}
            # API-06：size / n 仅在能力配置允许时下发（modelOverrides 里 n:false / size:false 优先）
            if size and params.get("size", True) is not False:
                body["size"] = size
            if n > 0 and params.get("n", True) is not False:
                body["n"] = n
            if negative and caps.get("negativePrompt", True) is not False:
                body["negative_prompt"] = negative
            for key, value in self._option_values(spec):
                body[key] = value
            response_format = str(spec.get("responseFormat") or caps.get("preferredResponseFormat") or "")
            if response_format and params.get("responseFormat", True) is not False:
                body["response_format"] = response_format
            if stream and params.get("stream", True) is not False:
                body["stream"] = True
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self._check_body_limit(data, caps)
            return urllib.request.Request(url, data=data, headers=headers, method="POST")

        fields = [("prompt", prompt)]
        if negative and caps.get("negativePrompt", True) is not False:
            fields.append(("negative_prompt", negative))
        fields.extend(self._option_values(spec))
        edit_response_format = str(spec.get("responseFormat") or caps.get("preferredResponseFormat") or "")
        if edit_response_format and params.get("responseFormat", True) is not False:
            fields.append(("response_format", edit_response_format))
        fields.extend([("model", model)])
        # API-06：edits 路径同样按能力守卫，避免不支持 size/n 的模型被 400
        if size and params.get("size", True) is not False:
            fields.append(("size", size))
        if n > 0 and params.get("n", True) is not False:
            fields.append(("n", n))
        refs = runtime["files"]
        if not refs:
            raise TaskApiError(400, "图生图任务缺少参考图")
        if runtime.get("inpaint"):
            image_items = [x for x in refs if x["field"] in ("image", "inpaint_image")]
            mask_items = [x for x in refs if x["field"] in ("mask", "inpaint_mask")]
            if not image_items or not mask_items:
                raise TaskApiError(400, "涂抹重绘任务缺少原图或蒙版")
            file_parts = [
                {"field": "image", "path": image_items[0]["path"], "filename": image_items[0]["filename"], "mime": image_items[0]["mime"]},
                {"field": "mask", "path": mask_items[0]["path"], "filename": mask_items[0]["filename"], "mime": mask_items[0]["mime"]},
            ]
        else:
            strategy = str(spec.get("referenceFieldStrategy") or caps.get("referenceFieldStrategy") or "repeat-image")
            file_parts = []
            for index, item in enumerate(refs):
                if strategy == "array-image":
                    field = "image[]"
                elif strategy == "numbered-image" and index > 0:
                    field = "image%d" % (index + 1)
                else:
                    field = "image"
                file_parts.append({"field": field, "path": item["path"], "filename": item["filename"], "mime": item["mime"]})
        body, content_type = _multipart_body(fields, file_parts)
        self._check_body_limit(body, caps)
        headers["Content-Type"] = content_type
        return urllib.request.Request(url, data=body, headers=headers, method="POST")

    @staticmethod
    def _stream_requested(spec):
        """是否走 SSE 流式：预设声明 streamCapable、spec 已开启 stream，且不是图生图（文档未声明 edits 支持流式）。"""
        caps = spec.get("capabilities") if isinstance(spec.get("capabilities"), dict) else {}
        if caps.get("streamCapable") is False:
            return False
        if not spec.get("stream"):
            return False
        if str(spec.get("mode") or "txt2img") == "img2img":
            return False
        return True

    def _call_upstream(self, runtime):
        spec = runtime["spec"]
        if self._is_futureai_protocol(spec):
            return self._call_futureai_task(runtime)
        if self._is_native_protocol(spec):
            return self._call_native_task(runtime)
        if self._is_openai_async_protocol(spec):
            return self._call_openai_async_task(runtime)
        caps = spec.get("capabilities") or {}
        if self._stream_requested(spec):
            try:
                return self._call_stream_upstream(runtime)
            except TaskApiError as exc:
                # Only an explicit rejection of the stream parameter is safe to resubmit.
                if caps.get("streamFallbackToSync", True) is False or exc.code != "stream_parameter_rejected":
                    raise
                log_server_line("STREAM-FALLBACK explicit unsupported parameter")
        return self._call_sync_upstream(runtime)

    def _call_sync_upstream(self, runtime):
        request = self._build_upstream_request(runtime)
        try:
            with _open_task_url(request, TASK_UPSTREAM_TIMEOUT) as response:
                raw = _read_limited(response, TASK_MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read(4096).decode("utf-8", "replace")
            except Exception:
                detail = ""
            detail = _safe_error(detail, runtime["api_key"])
            raise TaskApiError(502, "上游 HTTP %d%s" % (exc.code, (": " + detail[:500]) if detail else "")) from exc
        except TaskApiError:
            raise
        except Exception as exc:
            raise TaskApiError(502, "请求图片供应商失败：" + _safe_error(exc, runtime["api_key"])) from exc
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise TaskApiError(502, "上游返回不是有效 JSON") from exc
        items = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(items, list) or not items:
            raise TaskApiError(502, "上游响应中没有图片数据")
        if len(items) > TASK_MAX_RESULTS:
            raise TaskApiError(502, "上游返回图片数量超过服务器限制")
        return items

    def _call_stream_upstream(self, runtime):
        """Read final SSE events; never resubmit an accepted generation after a read failure."""
        request = self._build_upstream_request(runtime, stream=True)
        items, seen, event_lines = [], set(), []
        event_type = ""
        def consume():
            if not event_lines:
                return
            content = "\n".join(event_lines).strip()
            event_lines.clear()
            if not content or content == "[DONE]":
                return
            try:
                payload = json.loads(content)
            except (ValueError, TypeError):
                return
            if not isinstance(payload, dict):
                return
            kind = str(payload.get("type") or event_type or "").lower()
            if "partial" in kind or payload.get("partial_image_b64"):
                return
            if payload.get("error") or kind in ("error", "image_generation.failed"):
                code, message = self._native_error(payload)
                raise TaskApiError(502, message, code)
            for value in self._native_result_items(payload):
                key = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
                if key not in seen:
                    seen.add(key)
                    items.append(value)
        try:
            with _open_task_url(request, TASK_UPSTREAM_TIMEOUT) as response:
                declared = str(response.headers.get("Content-Type") or "")
                if "text/event-stream" not in declared.lower():
                    raw = _read_limited(response, TASK_MAX_RESPONSE_BYTES)
                    try:
                        payload = json.loads(raw.decode("utf-8"))
                    except Exception as exc:
                        raise TaskApiError(502, "上游已响应但返回内容无效，请核对原任务；不会重复生图", "stream_invalid_response") from exc
                    result = self._native_result_items(payload)
                    if result:
                        return result
                    code, message = self._native_error(payload, "上游已响应但没有图片；不会自动重复生图")
                    raise TaskApiError(502, message, code)
                total = 0
                deadline = time.monotonic() + TASK_UPSTREAM_TIMEOUT
                while True:
                    if runtime["cancel"].is_set():
                        raise TaskCancelled()
                    if time.monotonic() > deadline:
                        raise TaskApiError(504, "流式读取超时；请核对原任务", "stream_timeout")
                    line = response.readline(TASK_MAX_RESPONSE_BYTES + 1)
                    if not line:
                        consume()
                        break
                    total += len(line)
                    if total > TASK_MAX_RESPONSE_BYTES:
                        raise TaskApiError(502, "上游流式响应超过限制", "stream_too_large")
                    text = line.decode("utf-8", "replace").rstrip("\r\n")
                    if text.startswith("event:"):
                        event_type = text[6:].strip()
                    elif text.startswith("data:"):
                        event_lines.append(text[5:].lstrip())
                    elif not text:
                        consume()
                        event_type = ""
                        if items:
                            break  # final image event; some gateways never close or send [DONE]
        except urllib.error.HTTPError as exc:
            detail = _safe_error(exc.read(4096).decode("utf-8", "replace"), runtime["api_key"])
            rejected = exc.code in (400, 404, 405, 415, 422, 501) and "stream" in detail.lower() and any(x in detail.lower() for x in ("unsupported", "not supported", "unknown parameter", "不支持"))
            raise TaskApiError(exc.code, "上游流式 HTTP %d：%s" % (exc.code, detail[:500]), "stream_parameter_rejected" if rejected else "stream_http_error") from exc
        except TaskCancelled:
            raise
        except Exception:
            if not items:
                raise
        if not items:
            raise TaskApiError(502, "流式响应没有最终图片；请核对原任务，不会自动重发", "stream_empty")
        return items[:TASK_MAX_RESULTS]

    def _resolve_result(self, item, spec, cancel=None, api_key=""):
        if not isinstance(item, dict):
            raise TaskApiError(502, "上游图片数据格式无效")
        declared = ""
        b64_value = item.get("b64_json") or item.get("b64") or item.get("base64")
        raw_value = item.get("url") or item.get("image_url") or item.get("imageUrl") or item.get("result_url") or item.get("resultUrl")
        if b64_value:
            try:
                data = _decode_b64_image(b64_value)
                if _guess_image_mime(data)[0]:
                    return data, *_guess_image_mime(data)
                if not raw_value:
                    raise TaskApiError(502, "上游内联图片格式无效")
            except TaskApiError:
                if not raw_value:
                    raise
        if raw_value:
            raw_url = str(raw_value)
            if raw_url.startswith("data:"):
                data = _decode_b64_image(raw_url)
                declared = raw_url.split(";", 1)[0][5:] if ";" in raw_url else ""
            else:
                target = urljoin(str(spec.get("baseUrl") or "") + "/", raw_url)
                parsed = urlparse(target)
                if parsed.scheme not in ("http", "https") or not parsed.netloc or _blocked_target_global(target):
                    raise TaskApiError(403, "结果图片地址被服务器安全策略拒绝")
                declared, data = _http_get_with_retry(
                    target,
                    {"Accept": "image/*", "User-Agent": USER_AGENT},
                    TASK_MAX_RESPONSE_BYTES,
                    TASK_POLL_TIMEOUT,
                    cancel=cancel,
                    label="结果图片",
                    attempts=TASK_RESULT_DOWNLOAD_ATTEMPTS,
                    api_key=api_key,
                )
        else:
            raise TaskApiError(502, "上游图片数据缺少 b64_json 或 url")
        mime, ext = _guess_image_mime(data, declared)
        if not mime:
            raise TaskApiError(502, "上游结果不是受支持的图片格式")
        return data, mime, ext
