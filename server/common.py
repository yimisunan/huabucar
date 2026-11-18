# -*- coding: utf-8 -*-
"""公共异常、MIME 嗅探、SSRF 防护、HTTP 重试与 multipart 工具函数。"""

import base64
import json
import os
import re
import secrets
import socket
import time
import urllib.error
import urllib.request
from email import policy
from email.parser import BytesParser
from urllib.parse import urljoin, urlparse

from server.config import (
    ALLOW_HOSTS,
    ALLOW_PRIVATE,
    TASK_MAX_REF_BYTES,
     log_server_line,
)


class TaskApiError(Exception):
    """可安全返回给任务 API 客户端的错误。"""

    def __init__(self, status, message, code="task_api"):
        super().__init__(message)
        self.status = int(status)
        self.message = str(message)
        self.code = str(code or "task_api")


class TaskCancelled(Exception):
    """后台任务收到取消标记。"""


_VIDEO_TYPES = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-m4v": ".m4v",
}


_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def _json_bytes(payload):
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _valid_job_id(value):
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{8,120}", str(value or "")))


def _blocked_target_global(target):
    """SSRF 防护：白名单始终生效；私网地址仅在 ALLOW_PRIVATE=1 时允许。"""
    hostname = urlparse(target).hostname
    if not hostname:
        return True
    if ALLOW_HOSTS and hostname.lower() not in ALLOW_HOSTS:
        return True
    if ALLOW_PRIVATE:
        return False
    if hostname.lower() == "localhost":
        return True
    try:
        infos = socket.getaddrinfo(hostname, None)
    except Exception:
        return True
    for info in infos:
        ip = info[4][0]
        ip_lower = ip.lower()
        if ip == "::1" or ip == "::" or ip_lower.startswith("fe80:"):
            return True
        if ip.startswith("127.") or ip.startswith("0.") or ip.startswith("169.254."):
            return True
        if ip.startswith("10.") or ip.startswith("192.168."):
            return True
        if ip.startswith("172."):
            try:
                if 16 <= int(ip.split(".")[1]) <= 31:
                    return True
            except Exception:
                pass
    return False


def _guess_video_mime(data, declared=""):
    """按响应头和文件头识别常见视频格式，不把未知内容伪装成视频。"""
    declared = str(declared or "").split(";", 1)[0].strip().lower()
    declared_ext = _VIDEO_TYPES.get(declared, "")
    if len(data) >= 12 and data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand == b"qt  ":
            return "video/quicktime", ".mov"
        return "video/mp4", ".mp4"
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm", ".webm"
    if declared_ext and declared.startswith("video/"):
        return declared, declared_ext
    return "", ".bin"


def _guess_image_mime(data, declared=""):
    """按声明和文件头判断结果是否为受支持的图片格式。"""
    declared = str(declared or "").split(";", 1)[0].strip().lower()
    declared_ext = _IMAGE_TYPES.get(declared, "")
    signatures = (
        (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
        (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
        (b"GIF87a", "image/gif", ".gif"),
        (b"GIF89a", "image/gif", ".gif"),
    )
    for signature, mime, ext in signatures:
        if data.startswith(signature):
            return mime, ext
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return "", ".bin"


def _safe_error(exc, secret=""):
    message = str(exc or "未知错误")[:2000]
    if secret:
        message = message.replace(str(secret), "[redacted]")
    return message


def _friendly_task_error(text):
    """给上游拒绝 / 中断类错误补上可执行的中文建议（不改变原始信息）。"""
    low = str(text or "")
    marker = ""
    if ("内容政策" in low) or ("content policy" in low.lower()):
        marker = "｜💡 建议：上游按内容政策拒绝。请修改提示词（涉及身材 / 服装 / 裸露 / 未成年人的描述最易触发）或更换参考图后再试；同一提示词重复重试通常仍会被拒。"
    elif ("did not complete" in low) or ("上游生成未完成" in low):
        marker = "｜💡 建议：上游生成中断（常见原因是内容政策触发或站点繁忙）。先改提示词 / 参考图再试；若整批都失败，用「超生成」堆量重试没有意义。"
    elif "reference_image_rejected" in low:
        marker = "｜💡 建议：上游拒绝了参考图（多为单张体积过大或图像异常）。可压缩参考图（长边≤2048、单张≤2MB）或换图后重试。"
    return (low + marker) if marker else low


def _task_error_text(exc, secret=""):
    message = _safe_error(exc, secret)
    code = str(getattr(exc, "code", "") or "")
    text = (code + ": " + message) if code and code != "task_api" else message
    return _friendly_task_error(text)


def _atomic_write(path, data):
    """同目录临时文件写完并刷盘后原子替换，避免读到半张图片。"""
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    temp = path + ".tmp-" + secrets.token_hex(8)
    try:
        with open(temp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(temp, path)
    finally:
        try:
            if os.path.exists(temp):
                os.remove(temp)
        except OSError:
            pass


def _read_limited(response, limit):
    chunks = []
    total = 0
    while True:
        chunk = response.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise TaskApiError(502, "上游响应超过服务器限制")
        chunks.append(chunk)
    return b"".join(chunks)


def _decode_b64_image(value):
    raw = str(value or "")
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        return base64.b64decode(raw, validate=False)
    except Exception as exc:
        raise TaskApiError(502, "上游返回的 base64 图片无法解码") from exc


def _sanitize_spec(value):
    """递归移除可能携带密钥的字段，再写入 SQLite。"""
    secret_keys = {
        "apikey", "api_key", "providerapikey", "provider_api_key",
        "authorization", "proxy_token", "proxytoken", "secret",
    }
    if isinstance(value, dict):
        return {
            str(key): _sanitize_spec(item)
            for key, item in value.items()
            if str(key).lower() not in secret_keys and str(key).lower() != "key"
        }
    if isinstance(value, list):
        return [_sanitize_spec(item) for item in value]
    return value


def _multipart_body(fields, files):
    boundary = "----OperitImageTask" + secrets.token_hex(12)
    chunks = []
    for name, value in fields:
        chunks.extend([
            ("--" + boundary + "\r\n").encode("ascii"),
            ("Content-Disposition: form-data; name=\"" + str(name) + "\"\r\n\r\n").encode("utf-8"),
            str(value).encode("utf-8"),
            b"\r\n",
        ])
    for item in files:
        field = str(item["field"])
        filename = os.path.basename(str(item.get("filename") or "upload.bin"))
        filename = filename.replace("\"", "_").replace("\r", "_").replace("\n", "_")
        with open(item["path"], "rb") as fh:
            data = fh.read(TASK_MAX_REF_BYTES + 1)
        if len(data) > TASK_MAX_REF_BYTES:
            raise TaskApiError(413, "参考图超过单文件大小限制")
        chunks.extend([
            ("--" + boundary + "\r\n").encode("ascii"),
            ("Content-Disposition: form-data; name=\"" + field + "\"; filename=\"" + filename + "\"\r\n").encode("utf-8"),
            ("Content-Type: " + str(item.get("mime") or "application/octet-stream") + "\r\n\r\n").encode("ascii", "replace"),
            data,
            b"\r\n",
        ])
    chunks.append(("--" + boundary + "--\r\n").encode("ascii"))
    return b"".join(chunks), "multipart/form-data; boundary=" + boundary


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urljoin(req.full_url, newurl)
        if _blocked_target_global(target):
            raise urllib.error.URLError("重定向目标被服务器安全策略拒绝")
        return super().redirect_request(req, fp, code, msg, headers, target)


def _http_get_with_retry(url, headers, max_bytes, timeout, cancel=None, label="结果", attempts=4, api_key=""):
    """带指数退避的 GET 下载，返回 (declared_content_type, data)。

    · 可重试：HTTP 408/425/429/5xx、连接重置 / SSL EOF / 超时等网络类异常
    · 不重试：其他 HTTP 4xx、安全策略拦截、体积超限（TaskApiError 直接上抛）
    · 退避：1.2s → 2.4s → 4.8s（含小幅步进抖动）
    """
    last = ""
    for attempt in range(max(1, int(attempts))):
        if cancel is not None and cancel.is_set():
            raise TaskCancelled()
        request = urllib.request.Request(url, headers=dict(headers), method="GET")
        try:
            with _open_task_url(request, timeout) as response:
                declared = response.headers.get("Content-Type", "")
                data = _read_limited(response, max_bytes)
            if attempt:
                log_server_line("%s下载重试成功（第 %d 次尝试）" % (label, attempt + 1))
            return declared, data
        except urllib.error.HTTPError as exc:
            if not (exc.code in (408, 425, 429) or 500 <= exc.code < 600):
                raise TaskApiError(502, "%s下载失败：HTTP %d" % (label, exc.code)) from exc
            last = "HTTP %d" % exc.code
        except TaskApiError:
            raise
        except Exception as exc:
            last = _safe_error(exc, api_key)
        if attempt < max(1, int(attempts)) - 1:
            delay = 1.2 * (2 ** attempt) + 0.15 * (attempt + 1)
            log_server_line("%s下载失败（第 %d 次）：%s；%.2fs 后重试" % (label, attempt + 1, last or "未知错误", delay))
            if cancel is not None:
                if cancel.wait(delay):
                    raise TaskCancelled()
            else:
                time.sleep(delay)
    raise TaskApiError(502, "%s下载失败（已重试 %d 次）：%s" % (label, max(1, int(attempts)), last or "未知错误"))


def _open_task_url(request, timeout):
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    return opener.open(request, timeout=timeout)


def _parse_multipart_form(body, content_type):
    if not str(content_type or "").lower().startswith("multipart/form-data"):
        raise TaskApiError(415, "任务创建必须使用 multipart/form-data")
    header = ("Content-Type: " + str(content_type) + "\r\nMIME-Version: 1.0\r\n\r\n").encode("latin-1", "replace")
    try:
        message = BytesParser(policy=policy.default).parsebytes(header + body)
    except Exception as exc:
        raise TaskApiError(400, "无法解析任务上传数据") from exc
    if not message.is_multipart():
        raise TaskApiError(400, "任务上传数据不是 multipart 表单")
    fields = {}
    files = []
    for part in message.iter_parts():
        params = dict(part.get_params(header="content-disposition", failobj=[]))
        name = str(params.get("name") or "")
        if not name:
            continue
        payload = part.get_payload(decode=True) or b""
        filename = params.get("filename")
        if filename is not None:
            files.append({
                "field": name,
                "filename": str(filename),
                "mime": str(part.get_content_type() or "application/octet-stream"),
                "data": payload,
            })
        else:
            fields[name] = payload.decode("utf-8", "replace")
    return fields, files


def _api_url(base, endpoint):
    base = str(base or "").rstrip("/")
    endpoint = str(endpoint or "")
    if base.lower().endswith("/v1") and endpoint.lower().startswith("/v1/"):
        endpoint = endpoint[3:]
    if not endpoint.startswith("/") or "://" in endpoint:
        raise TaskApiError(400, "接口路径无效")
    return base + endpoint
