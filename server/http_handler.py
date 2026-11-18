# -*- coding: utf-8 -*-
"""HTTP 服务器与路由处理器（静态文件、同源代理、任务 API、提示词库、缩略图）。"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

from server.config_import import handle_config_import
from server.config import (
    ALLOW_HOSTS,
    ALLOW_PRIVATE,
    MAX_PROXY_BYTES,
    MIME,
    PROXY_TOKEN,
    ROOT,
    TASK_DATA_ROOT,
    TASK_MAX_BODY_BYTES,
    USER_AGENT,
    get_task_manager,
    log_server_line,
)
from server.common import (
    TaskApiError,
    _blocked_target_global,
    _json_bytes,
    _parse_multipart_form,
)


class _QueueThreadingHTTPServer(ThreadingHTTPServer):
    """默认 request_queue_size=5 太小：浏览器短连接高频请求时会丢新连接（表现为 Failed to fetch）"""
    daemon_threads = True
    request_queue_size = 128
    allow_reuse_address = True


class Handler(SimpleHTTPRequestHandler):
    """提供静态资源、同源 API 转发和请求日志。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        # 解码 %E4%B8%AD%E6%96%87 之类的编码，确保中文文件名可访问。
        translated = super().translate_path(unquote(path))
        relative = os.path.relpath(translated, ROOT).replace("\\", "/")
        if any(part.startswith(".") or part in ("__pycache__", ".signing") for part in relative.split("/")):
            return os.path.join(ROOT, "__private_data_hidden__")
        try:
            data_root = os.path.realpath(TASK_DATA_ROOT)
            candidate = os.path.realpath(translated)
            if os.path.commonpath([data_root, candidate]) == data_root:
                return os.path.join(ROOT, "__task_data_hidden__")
        except (OSError, ValueError):
            pass
        return translated

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIME.get(ext, "application/octet-stream")

    def end_headers(self):
        # 允许局域网中的页面访问本服务器资源和代理响应
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        # 静态资源禁止缓存，保证 HTML/JS 更新即时生效（避免浏览器加载旧版）
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def send_head(self):
        # SimpleHTTPRequestHandler 默认按 If-Modified-Since 返回 304；开发阶段会让旧 HTML/JS 持续留在浏览器缓存中。
        # 忽略条件请求，始终发送当前磁盘文件，确保 module 入口和拆分后的子模块同步。
        saved = self.headers.get("If-Modified-Since")
        if saved:
            del self.headers["If-Modified-Since"]
        try:
            return super().send_head()
        finally:
            if saved is not None:
                self.headers["If-Modified-Since"] = saved

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _proxy_target(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/proxy":
            return None
        target = parse_qs(parsed.query).get("url", [""])[0].strip()
        target_parsed = urlparse(target)
        if target_parsed.scheme not in ("http", "https") or not target_parsed.netloc:
            return None
        return target

    def _blocked_target(self, target):
        return _blocked_target_global(target)

    def _proxy_authorized(self):
        if not PROXY_TOKEN:
            return True
        query = parse_qs(urlparse(self.path).query)
        return query.get("token", [""])[0] == PROXY_TOKEN

    def _proxy_deny(self):
        payload = json.dumps({"error": {"message": "代理令牌缺失或不正确（服务器已开启 PROXY_TOKEN）", "type": "proxy_token"}}, ensure_ascii=False).encode("utf-8")
        self.send_response(401)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _proxy_status(self):
        payload = json.dumps({
            "allowPrivate": ALLOW_PRIVATE,
            "tokenRequired": bool(PROXY_TOKEN),
            "allowHostsConfigured": bool(ALLOW_HOSTS),
        }, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


    def _send_json(self, payload, status=200):
        data = _json_bytes(payload)
        self.send_response(status)
        # API-CONNECTION-CLOSE：API 响应一律用完即关，避免浏览器复用已被服务端关闭的
        # keep-alive 连接（浏览器对 GET 会自动重连重试、对 POST 不会，表现为"GET 正常但 POST 全部 Failed to fetch"）。
        try:
            self.send_header("Connection", "close")
            self.close_connection = True
        except Exception:
            pass
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _task_authorized(self):
        if not PROXY_TOKEN:
            return True
        query = parse_qs(urlparse(self.path).query)
        token = self.headers.get("X-Proxy-Token") or query.get("token", [""])[0]
        return token == PROXY_TOKEN

    def _task_deny(self):
        self._send_json({"error": {"message": "任务令牌缺失或不正确（服务器已开启 PROXY_TOKEN）", "type": "task_token"}}, 401)

    def _handle_client_log(self):
        """接收前端诊断回传（页面侧失败无法进入常规日志），落盘便于离线排查。"""
        raw = b""
        try:
            raw = self._read_task_body()
        except Exception:
            raw = b""
        try:
            text = raw.decode("utf-8", "replace")
        except Exception:
            text = ""
        log_server_line("CLIENT-REPORT " + text[:4000])
        self._send_json({"ok": True}, 200)

    def _task_manager(self):
        mgr = get_task_manager()
        if mgr is None:
            raise TaskApiError(503, "后台任务管理器尚未启动")
        return mgr

    def _read_task_body(self):
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise TaskApiError(411, "任务请求必须提供 Content-Length")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise TaskApiError(400, "Content-Length 无效") from exc
        if length < 0 or length > TASK_MAX_BODY_BYTES:
            raise TaskApiError(413, "任务上传数据超过服务器限制")
        return self.rfile.read(length)

    def _send_task_error(self, exc):
        try:
            log_server_line("TASK-DENY status=%s type=%s message=%s" % (
                getattr(exc, "status", 500), getattr(exc, "code", "internal"), getattr(exc, "message", exc)))
        except Exception:
            pass
        if isinstance(exc, TaskApiError):
            self._send_json({"error": {"message": exc.message, "type": exc.code, "code": exc.code}}, exc.status)
        else:
            self._send_json({"error": {"message": "后台任务服务器内部错误", "type": "task_internal"}}, 500)

    def _handle_task_capabilities(self):
        try:
            self._send_json(self._task_manager().capabilities())
        except Exception as exc:
            self._send_task_error(exc)

    def _handle_task_create(self):
        try:
            body = self._read_task_body()
            fields, files = _parse_multipart_form(body, self.headers.get("Content-Type", ""))
            try:
                _inv = ", ".join(["%s=%dB" % (f.get("field"), len(f.get("data") or b"")) for f in files]) or "(无文件部件)"
                log_server_line("TASK-UPLOAD declared=%s received=%dB fields=[%s] files=[%s]" % (
                    self.headers.get("Content-Length"), len(body), ",".join(sorted(str(k) for k in fields.keys())), _inv))
            except Exception:
                pass
            try:
                spec = json.loads(fields.get("spec", ""))
            except Exception as exc:
                raise TaskApiError(400, "任务 spec 不是有效 JSON") from exc
            api_key = self.headers.get("X-Provider-API-Key", "").strip()
            result = self._task_manager().create_task(spec, api_key, files)
            self._send_json(result, 202)
        except Exception as exc:
            self._send_task_error(exc)

    def _task_path_parts(self):
        path = unquote(urlparse(self.path).path).strip("/")
        return path.split("/") if path else []

    def _handle_task_get(self):
        parts = self._task_path_parts()
        try:
            manager = self._task_manager()
            if len(parts) == 3 and parts[:2] == ["api", "tasks"]:
                self._send_json(manager.status(parts[2]))
                return
            if len(parts) == 5 and parts[:2] == ["api", "tasks"] and parts[3] == "result":
                try:
                    index = int(parts[4])
                except ValueError as exc:
                    raise TaskApiError(400, "结果索引无效") from exc
                path, mime = manager.result_path(parts[2], index)
                size = os.path.getsize(path)
                self.send_response(200)
                self.send_header("Content-Type", mime or "application/octet-stream")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(path, "rb") as fh:
                    while True:
                        chunk = fh.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                return
            raise TaskApiError(404, "后台任务路径不存在")
        except Exception as exc:
            self._send_task_error(exc)

    def _handle_task_by_client(self):
        parts = self._task_path_parts()
        try:
            if len(parts) != 4 or parts[:3] != ["api", "tasks", "by-client"]:
                raise TaskApiError(404, "后台任务路径不存在")
            self._send_json(self._task_manager().by_client_status(parts[3]))
        except Exception as exc:
            self._send_task_error(exc)

    def _handle_task_cancel(self):
        parts = self._task_path_parts()
        try:
            if len(parts) != 4 or parts[:2] != ["api", "tasks"] or parts[3] != "cancel":
                raise TaskApiError(404, "后台任务路径不存在")
            self._send_json(self._task_manager().cancel(parts[2]))
        except Exception as exc:
            self._send_task_error(exc)

    def _query_param(self, name):
        try:
            import urllib.parse as _uparse
            query = _uparse.urlparse(getattr(self, "path", "") or "").query
            values = _uparse.parse_qs(query, keep_blank_values=False)
        except Exception:
            return ""
        items = values.get(name) or []
        return str(items[0]).strip() if items else ""

    def _handle_task_resume(self):
        parts = self._task_path_parts()
        try:
            if len(parts) != 4 or parts[:2] != ["api", "tasks"] or parts[3] != "resume":
                raise TaskApiError(404, "后台任务路径不存在")
            api_key = self.headers.get("X-Provider-API-Key", "").strip()
            base_url = self._query_param("baseUrl")
            self._send_json(self._task_manager().resume(parts[2], api_key, base_url))
        except Exception as exc:
            self._send_task_error(exc)

    def _handle_task_forget(self):
        parts = self._task_path_parts()
        try:
            if len(parts) != 4 or parts[:2] != ["api", "tasks"] or parts[3] != "forget":
                raise TaskApiError(404, "后台任务路径不存在")
            self._send_json(self._task_manager().forget(parts[2]))
        except Exception as exc:
            self._send_task_error(exc)

    def _handle_video_task_create(self):
        try:
            body = self._read_task_body()
            fields, files = _parse_multipart_form(body, self.headers.get("Content-Type", ""))
            try:
                spec = json.loads(fields.get("spec", ""))
            except Exception as exc:
                raise TaskApiError(400, "视频任务 spec 不是有效 JSON") from exc
            api_key = self.headers.get("X-Provider-API-Key", "").strip()
            result = self._task_manager().create_video_task(spec, api_key, files)
            self._send_json(result, 202)
        except Exception as exc:
            self._send_task_error(exc)

    def _handle_video_task_get(self):
        parts = self._task_path_parts()
        try:
            manager = self._task_manager()
            if len(parts) == 3 and parts[:2] == ["api", "video-tasks"]:
                self._send_json(manager.video_status(parts[2]))
                return
            if len(parts) == 5 and parts[:2] == ["api", "video-tasks"] and parts[3] == "result":
                try:
                    index = int(parts[4])
                except ValueError as exc:
                    raise TaskApiError(400, "视频结果索引无效") from exc
                path, mime = manager.video_result_path(parts[2], index)
                size = os.path.getsize(path)
                self.send_response(200)
                self.send_header("Content-Type", mime or "application/octet-stream")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                with open(path, "rb") as fh:
                    while True:
                        chunk = fh.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                return
            raise TaskApiError(404, "视频后台任务路径不存在")
        except Exception as exc:
            self._send_task_error(exc)

    def _handle_video_task_cancel(self):
        parts = self._task_path_parts()
        try:
            if len(parts) != 4 or parts[:2] != ["api", "video-tasks"] or parts[3] != "cancel":
                raise TaskApiError(404, "视频后台任务路径不存在")
            self._send_json(self._task_manager().cancel_video(parts[2]))
        except Exception as exc:
            self._send_task_error(exc)

    def _proxy_request(self):
        target = self._proxy_target()
        if not target:
            self.send_error(400, "proxy url must be an absolute http(s) URL")
            return
        if self._blocked_target(target):
            payload = json.dumps({"error": {"message": "代理拒绝内网/本机地址（ALLOW_PRIVATE=1 可放开）", "type": "proxy_blocked"}}, ensure_ascii=False).encode("utf-8")
            self.send_response(403)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return

        length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(length) if length else None
        headers = {}
        for name in ("Authorization", "Content-Type", "Accept"):
            value = self.headers.get(name)
            if value:
                headers[name] = value
        headers["User-Agent"] = USER_AGENT
        request = urllib.request.Request(target, data=body, headers=headers, method=self.command)
        response = None
        try:
            response = urllib.request.urlopen(request, timeout=600)
            status = response.status
            content_type = response.headers.get("Content-Type", "application/octet-stream")
        except urllib.error.HTTPError as exc:
            response = exc
            status = exc.code
            content_type = exc.headers.get("Content-Type", "application/json")
        except Exception as exc:
            payload = json.dumps({"error": {"message": str(exc), "type": "proxy_error"}}, ensure_ascii=False).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # 流式转发：边读边写，大图不整体驻留内存；超过上限截断连接
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.end_headers()
        total = 0
        try:
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_PROXY_BYTES:
                    print("代理响应超过上限 %d 字节，已截断：%s" % (MAX_PROXY_BYTES, target))
                    break
                self.wfile.write(chunk)
        except Exception:
            pass
        finally:
            try:
                response.close()
            except Exception:
                pass

    def _prompt_list(self):
        """扫描 提示词仓库/ 目录下的 txt 文件，返回提示词库清单（目录不存在时回退 提示词归档/）"""
        lib_dir = "提示词仓库" if os.path.isdir(os.path.join(ROOT, "提示词仓库")) else "提示词归档"
        lib_root = os.path.join(ROOT, lib_dir)
        files = []
        if os.path.isdir(lib_root):
            skip_dirs = {"备份", ".backup", "__pycache__"}
            for dirpath, dirnames, filenames in os.walk(lib_root):
                dirnames[:] = [d for d in dirnames if d not in skip_dirs]
                dirnames.sort()
                rel = os.path.relpath(dirpath, ROOT)
                if any(p in skip_dirs for p in rel.replace("\\", "/").split("/")):
                    continue
                for fn in sorted(filenames):
                    if fn.lower().endswith(".txt"):
                        path = os.path.join(rel, fn)
                        files.append({"path": path.replace(os.sep, "/"), "name": fn, "dir": "" if rel == "." else rel})
        payload = json.dumps({"dir": lib_dir, "files": files}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def _thumb(self):
        """接收原图 base64，用 Pillow 等比压缩成小图 JPEG base64 返回（绕开移动端浏览器大图解码瓶颈）"""
        import base64 as _b64
        from io import BytesIO
        try:
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = None
        except Exception:
            payload = json.dumps({"error": "server has no Pillow"}, ensure_ascii=False).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
            return
        length = int(self.headers.get("Content-Length", "0") or 0)
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            data = {}
        b64 = str(data.get("b64") or "")
        if "," in b64[:64]:
            b64 = b64.split(",", 1)[1]
        max_side = max(32, min(1024, int(data.get("maxSide") or 320)))
        try:
            img = Image.open(BytesIO(_b64.b64decode(b64)))
            img.thumbnail((max_side, max_side))
            if img.mode in ("RGBA", "P", "LA"):
                img = img.convert("RGB")
            buf = BytesIO()
            img.save(buf, "JPEG", quality=82)
            out = _b64.b64encode(buf.getvalue()).decode("ascii")
            payload = json.dumps({"b64": "data:image/jpeg;base64," + out}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
        except Exception as exc:
            payload = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_response(400)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/config-import":
            handle_config_import(self)
            return
        if path == "/":
            self.send_response(302)
            # HTTP 头只允许 latin-1：中文路径必须百分号编码，否则 send_header 抛 UnicodeEncodeError
            self.send_header("Location", quote("/图片生成画布版.html"))
            self.end_headers()
            return
        if path == "/api/task-capabilities":
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_task_capabilities()
            return
        if path.startswith("/api/video-tasks/"):
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_video_task_get()
            return
        if path.startswith("/api/tasks/by-client/"):
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_task_by_client()
            return
        if path.startswith("/api/tasks/"):
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_task_get()
            return
        if path == "/api/proxy" and not self._proxy_authorized():
            self._proxy_deny()
            return
        if self._proxy_target():
            self._proxy_request()
            return
        if path == "/api/proxy-status":
            self._proxy_status()
            return
        if path == "/api/ping":
            # 与 do_POST 对称：探活/诊断用 GET 也能确认服务器在线（原先只支持 POST，GET 落到 404）
            self._send_json({"ok": True}, 200)
            return
        if path == "/api/prompt-list":
            self._prompt_list()
            return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/config-import":
            handle_config_import(self, consume=True)
            return
        if path == "/api/ping":
            self._send_json({"ok": True}, 200)
            return
        if path == "/api/client-log":
            self._handle_client_log()
            return
        if path == "/api/video-tasks":
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_video_task_create()
            return
        if path.startswith("/api/video-tasks/") and path.endswith("/cancel"):
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_video_task_cancel()
            return
        if path == "/api/tasks":
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_task_create()
            return
        if path.startswith("/api/tasks/") and path.endswith("/cancel"):
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_task_cancel()
            return
        if path.startswith("/api/tasks/") and path.endswith("/resume"):
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_task_resume()
            return
        if path.startswith("/api/tasks/") and path.endswith("/forget"):
            if not self._task_authorized():
                self._task_deny()
                return
            self._handle_task_forget()
            return
        if path == "/api/proxy" and not self._proxy_authorized():
            self._proxy_deny()
            return
        if self._proxy_target():
            self._proxy_request()
            return
        if path == "/api/thumb":
            self._thumb()
            return
        self.send_error(404, "not found")

    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))
        log_server_line("ACCESS " + (fmt % args))
