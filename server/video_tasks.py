# -*- coding: utf-8 -*-
"""视频后台任务管理器：复用图片任务 SQLite 与线程池。"""

import base64
import json
import os
import re
import secrets
import shutil
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlparse

from server.config import (
    TASK_JOBS_ROOT,
    TASK_MAX_REF_BYTES,
    TASK_RESULT_DOWNLOAD_ATTEMPTS,
    TASK_UPSTREAM_TIMEOUT,
    USER_AGENT,
    VIDEO_MAX_RESPONSE_BYTES,
)
from server.common import (
    TaskApiError,
    TaskCancelled,
    _atomic_write,
    _blocked_target_global,
    _guess_image_mime,
    _guess_video_mime,
    _http_get_with_retry,
    _open_task_url,
    _read_limited,
    _safe_error,
    _sanitize_spec,
    _valid_job_id,
)


class VideoTaskManager:
    """独立的视频后台任务管理器，复用图片任务的 SQLite/线程池和安全边界。"""

    def __init__(self, image_manager):
        self.image_manager = image_manager
        self.lock = image_manager.lock
        self.runtime = {}
        self.executor = image_manager.executor

    def _connect(self):
        return self.image_manager._connect()

    def _row_by_job(self, job_id):
        if not _valid_job_id(job_id):
            raise TaskApiError(400, "job_id 无效")
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE job_id=?", (job_id,)).fetchone()
        if row is None or not str(row["job_id"]).startswith("vjob_"):
            raise TaskApiError(404, "视频任务不存在")
        return row

    @staticmethod
    def _results_from_row(row):
        try:
            value = json.loads(row["results_json"] or "[]")
            return value if isinstance(value, list) else []
        except Exception:
            return []

    def _public_status(self, row):
        results = []
        for item in self._results_from_row(row):
            try:
                index = int(item.get("index"))
            except Exception:
                continue
            results.append({"index": index, "url": "/api/video-tasks/%s/result/%d" % (row["job_id"], index), "mime": str(item.get("mime") or "video/mp4"), "size": int(item.get("size") or 0)})
        provider_id = ""
        progress = 0
        try:
            saved_spec = json.loads(row["spec_json"] or "{}")
            provider_id = saved_spec.get("providerId", "")
            progress = max(0, min(100, float(saved_spec.get("videoProgress", 0) or 0)))
        except Exception:
            pass
        return {"ok": True, "jobId": row["job_id"], "clientTaskId": row["client_task_id"], "providerId": provider_id or "", "state": row["state"], "progress": progress, "createdAt": row["created_at"] or 0, "startedAt": row["started_at"] or 0, "endedAt": row["ended_at"] or 0, "error": row["error"] or "", "results": results}

    def _validate_spec(self, spec):
        if not isinstance(spec, dict):
            raise TaskApiError(400, "spec 必须是 JSON 对象")
        client = str(spec.get("clientTaskId") or "")
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{8,128}", client):
            raise TaskApiError(400, "clientTaskId 无效")
        mode = str(spec.get("mode") or "txt2video")
        if mode not in ("txt2video", "img2video"):
            raise TaskApiError(400, "不支持的视频模式")
        model = str(spec.get("model") or "").strip()
        prompt = str(spec.get("requestPrompt") or spec.get("prompt") or "").strip()
        if not model:
            raise TaskApiError(400, "缺少视频模型")
        if not prompt:
            raise TaskApiError(400, "缺少视频提示词")
        base = str(spec.get("baseUrl") or "").strip().rstrip("/")
        parsed = urlparse(base)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise TaskApiError(400, "视频 Base URL 必须是绝对 http(s) 地址")
        if _blocked_target_global(base):
            raise TaskApiError(403, "视频任务拒绝访问内网/本机 Base URL")
        seconds = str(spec.get("seconds") or "6").strip()
        if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", seconds) or float(seconds) <= 0 or float(seconds) > 60:
            raise TaskApiError(400, "视频时长无效")
        aspect = str(spec.get("aspect_ratio") or spec.get("aspectRatio") or "16:9").strip()
        if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?:[0-9]+(?:\.[0-9]+)?", aspect):
            raise TaskApiError(400, "视频比例无效")
        resolution = str(spec.get("resolution") or "720P").strip()
        if not resolution or len(resolution) > 32:
            raise TaskApiError(400, "视频分辨率无效")
        return client, mode, base, seconds, aspect, resolution

    def create_video_task(self, spec, api_key, uploads):
        if not str(api_key or "").strip():
            raise TaskApiError(401, "缺少视频 API Key")
        client, mode, base, seconds, aspect, resolution = self._validate_spec(spec)
        uploads = list(uploads or [])
        if mode == "txt2video" and uploads:
            raise TaskApiError(400, "文生视频任务不应上传参考图")
        if mode == "img2video" and not uploads:
            raise TaskApiError(400, "图片生视频任务缺少参考图")
        if len(uploads) > 4:
            raise TaskApiError(413, "视频参考图数量超过服务器限制")
        with self.lock:
            old = None
            with self._connect() as conn:
                old = conn.execute("SELECT * FROM tasks WHERE client_task_id=?", (client,)).fetchone()
            if old is not None:
                out = self._public_status(old)
                out["deduplicated"] = True
                return out
            job_id = "vjob_" + str(int(time.time() * 1000)) + "_" + secrets.token_hex(6)
            job_dir = os.path.join(TASK_JOBS_ROOT, job_id)
            refs_dir = os.path.join(job_dir, "refs")
            results_dir = os.path.join(job_dir, "results")
            os.makedirs(refs_dir, mode=0o700, exist_ok=False)
            os.makedirs(results_dir, mode=0o700, exist_ok=False)
            runtime_files = []
            persisted = []
            try:
                for i, item in enumerate(uploads):
                    data = item.get("data") or b""
                    if len(data) > TASK_MAX_REF_BYTES:
                        raise TaskApiError(413, "参考图超过单文件大小限制")
                    mime, ext = _guess_image_mime(data, item.get("mime"))
                    if not mime:
                        raise TaskApiError(400, "视频参考图不是受支持的图片格式")
                    filename = "upload_%d%s" % (i, ext)
                    path = os.path.join(refs_dir, filename)
                    _atomic_write(path, data)
                    field = "ref_%d" % i
                    runtime_files.append({"field": field, "path": path, "filename": filename, "mime": mime})
                    persisted.append({"field": field, "path": "refs/" + filename, "mime": mime})
                safe = _sanitize_spec(spec)
                safe.update({"clientTaskId": client, "mediaType": "video", "mode": mode, "baseUrl": base, "seconds": seconds, "aspect_ratio": aspect, "resolution": resolution, "referenceFiles": persisted, "providerId": ""})
                now = time.time()
                with self._connect() as conn:
                    conn.execute("INSERT INTO tasks(job_id, client_task_id, state, spec_json, created_at, results_json) VALUES(?,?,?,?,?,?)", (job_id, client, "queued", json.dumps(safe, ensure_ascii=False), now, "[]"))
                self.runtime[job_id] = {"spec": safe, "api_key": str(api_key), "files": runtime_files, "cancel": threading.Event(), "job_dir": job_dir}
                try:
                    self.executor.submit(self._run, job_id)
                except Exception as exc:
                    with self._connect() as conn:
                        conn.execute("UPDATE tasks SET state='error', ended_at=?, error=? WHERE job_id=?", (time.time(), "后台线程池无法接受视频任务", job_id))
                    self.runtime.pop(job_id, None)
                    raise TaskApiError(503, "后台线程池无法接受视频任务") from exc
            except Exception:
                shutil.rmtree(job_dir, ignore_errors=True)
                raise
            out = self._public_status(self._row_by_job(job_id))
            out["deduplicated"] = False
            return out

    def _update_spec(self, job_id, **updates):
        row = self._row_by_job(job_id)
        try:
            spec = json.loads(row["spec_json"] or "{}")
        except Exception:
            spec = {}
        spec.update(updates)
        with self._connect() as conn:
            conn.execute("UPDATE tasks SET spec_json=? WHERE job_id=?", (json.dumps(_sanitize_spec(spec), ensure_ascii=False), job_id))

    def _mark_running(self, job_id):
        with self._connect() as conn:
            cur = conn.execute("UPDATE tasks SET state='running', started_at=? WHERE job_id=? AND state='queued'", (time.time(), job_id))
            return cur.rowcount == 1

    def _state(self, job_id):
        try:
            return self._row_by_job(job_id)["state"]
        except TaskApiError:
            return "missing"

    @staticmethod
    def _data_uri(data, mime):
        return "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")

    def _upstream_url(self, runtime, kind):
        spec = runtime["spec"]
        caps = spec.get("videoCapabilities") if isinstance(spec.get("videoCapabilities"), dict) else {}
        eps = spec.get("videoEndpoints") if isinstance(spec.get("videoEndpoints"), dict) else {}
        defaults = {"create": "/videos", "status": "/videos/{id}", "content": "/videos/{id}/content"}
        configured = caps.get("endpoints") if isinstance(caps.get("endpoints"), dict) else {}
        path = eps.get(kind) or configured.get(kind) or defaults[kind]
        path = str(path).replace("{id}", str(spec.get("providerId") or ""))
        if not path.startswith("/") or "://" in path:
            raise TaskApiError(400, "视频接口路径无效")
        url = str(spec["baseUrl"]).rstrip("/") + path
        if _blocked_target_global(url):
            raise TaskApiError(403, "任务拒绝访问视频接口地址")
        return url

    def _request_json(self, request, runtime):
        try:
            with _open_task_url(request, TASK_UPSTREAM_TIMEOUT) as response:
                raw = _read_limited(response, VIDEO_MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read(4096).decode("utf-8", "replace")
            except Exception:
                detail = ""
            safe = _safe_error(detail, runtime["api_key"])
            raise TaskApiError(502, "上游视频 HTTP %d%s" % (exc.code, (": " + safe[:500]) if safe else "")) from exc
        except TaskApiError:
            raise
        except Exception as exc:
            raise TaskApiError(502, "请求视频供应商失败：" + _safe_error(exc, runtime["api_key"])) from exc
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise TaskApiError(502, "上游视频返回不是有效 JSON") from exc
        if not isinstance(payload, dict):
            raise TaskApiError(502, "上游视频响应格式无效")
        return payload

    def _create_upstream(self, runtime):
        spec = runtime["spec"]
        resolution = str(spec.get("resolution") or "720P").strip()
        upstream_resolution = {"480P": "480p", "720P": "720p", "1080P": "1080p"}.get(resolution, resolution.lower())
        body = {"model": str(spec["model"]), "prompt": str(spec.get("requestPrompt") or spec.get("prompt") or ""), "seconds": str(spec.get("seconds") or "6"), "aspect_ratio": str(spec.get("aspect_ratio") or "16:9"), "resolution": upstream_resolution}
        if runtime["files"]:
            uris = []
            for item in runtime["files"]:
                with open(item["path"], "rb") as fh:
                    uris.append(self._data_uri(fh.read(), item["mime"]))
            if len(uris) == 1:
                body["image"] = uris[0]
            else:
                body["images"] = uris
        request = urllib.request.Request(self._upstream_url(runtime, "create"), data=json.dumps(body, ensure_ascii=False).encode("utf-8"), headers={"Authorization": "Bearer " + runtime["api_key"], "Accept": "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT}, method="POST")
        return self._request_json(request, runtime)

    @staticmethod
    def _status_value(payload):
        return str(payload.get("state") or payload.get("status") or "queued").lower()

    def _update_progress(self, job_id, payload):
        try:
            progress = float(payload.get("progress", payload.get("percent", 0)) or 0)
        except Exception:
            progress = 0
        progress = max(0, min(100, progress))
        try:
            with self._connect() as conn:
                spec = json.loads(self._row_by_job(job_id)["spec_json"] or "{}")
                spec["videoProgress"] = progress
                conn.execute("UPDATE tasks SET spec_json=? WHERE job_id=?", (json.dumps(_sanitize_spec(spec), ensure_ascii=False), job_id))
        except Exception:
            pass
        return progress

    @staticmethod
    def _provider_id(payload):
        return str(payload.get("id") or payload.get("video_id") or payload.get("videoId") or payload.get("task_id") or "")

    def _video_url(self, payload):
        if not isinstance(payload, dict):
            return ""
        direct = payload.get("video_url") or payload.get("videoUrl") or payload.get("content_url") or payload.get("contentUrl") or payload.get("output_url") or payload.get("outputUrl") or payload.get("url") or ""
        if direct:
            return str(direct)
        for key in ("data", "results", "output"):
            values = payload.get(key)
            if isinstance(values, list):
                for item in values:
                    value = item if isinstance(item, str) else self._video_url(item)
                    if value:
                        return value
        return ""

    def _save_video_result(self, runtime, index, payload=None):
        spec = runtime["spec"]
        remote = self._video_url(payload or {})
        declared = ""
        if remote.startswith("data:"):
            raw = remote.split(",", 1)[1] if "," in remote else ""
            try:
                data = base64.b64decode(raw, validate=False)
            except Exception as exc:
                raise TaskApiError(502, "上游视频 data URI 无法解码") from exc
            declared = remote.split(";", 1)[0][5:] if ";" in remote else ""
        else:
            if not remote:
                remote = self._upstream_url(runtime, "content")
            else:
                remote = urljoin(str(spec.get("baseUrl") or "") + "/", remote)
            parsed = urlparse(remote)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or _blocked_target_global(remote):
                raise TaskApiError(403, "视频结果地址被服务器安全策略拒绝")
            declared, data = _http_get_with_retry(
                remote,
                {"Authorization": "Bearer " + runtime["api_key"], "Accept": "video/*", "User-Agent": USER_AGENT},
                VIDEO_MAX_RESPONSE_BYTES,
                TASK_UPSTREAM_TIMEOUT,
                cancel=runtime.get("cancel"),
                label="视频结果",
                attempts=TASK_RESULT_DOWNLOAD_ATTEMPTS,
                api_key=runtime["api_key"],
            )
        mime, ext = _guess_video_mime(data, declared)
        if not mime:
            raise TaskApiError(502, "上游结果不是受支持的视频格式")
        filename = "%d%s" % (index, ext)
        path = os.path.join(runtime["job_dir"], "results", filename)
        _atomic_write(path, data)
        return {"index": index, "filename": filename, "mime": mime, "size": len(data)}

    def _run(self, job_id):
        with self.lock:
            runtime = self.runtime.get(job_id)
        if runtime is None or not self._mark_running(job_id):
            if runtime is not None:
                runtime["api_key"] = ""
                self.runtime.pop(job_id, None)
            return
        saved = []
        try:
            if runtime["cancel"].is_set():
                raise TaskCancelled()
            created = self._create_upstream(runtime)
            provider_id = self._provider_id(created)
            if not provider_id and not self._video_url(created):
                raise TaskApiError(502, "上游视频创建响应缺少 id 或视频地址")
            runtime["spec"]["providerId"] = provider_id
            self._update_spec(job_id, providerId=provider_id)
            upstream_state = self._status_value(created)
            if upstream_state not in ("completed", "complete", "succeeded", "success", "done") and not self._video_url(created):
                deadline = time.time() + TASK_UPSTREAM_TIMEOUT
                while time.time() < deadline:
                    if runtime["cancel"].is_set() or self._state(job_id) == "cancelled":
                        raise TaskCancelled()
                    time.sleep(2)
                    if not provider_id:
                        break
                    request = urllib.request.Request(self._upstream_url(runtime, "status"), headers={"Authorization": "Bearer " + runtime["api_key"], "Accept": "application/json", "User-Agent": USER_AGENT}, method="GET")
                    payload = self._request_json(request, runtime)
                    self._update_progress(job_id, payload)
                    upstream_state = self._status_value(payload)
                    if upstream_state in ("failed", "failure", "error"):
                        detail = payload.get("error") or payload.get("message") or "上游视频生成失败"
                        raise TaskApiError(502, _safe_error(detail, runtime["api_key"]))
                    if upstream_state in ("cancelled", "canceled", "aborted"):
                        raise TaskCancelled()
                    if self._video_url(payload):
                        created = payload
                    if upstream_state in ("completed", "complete", "succeeded", "success", "done") or self._video_url(payload):
                        break
                else:
                    raise TaskApiError(504, "上游视频生成超时")
            if runtime["cancel"].is_set() or self._state(job_id) == "cancelled":
                raise TaskCancelled()
            self._update_progress(job_id, {"progress": 100})
            result = self._save_video_result(runtime, 0, created)
            saved.append(os.path.join(runtime["job_dir"], "results", result["filename"]))
            with self._connect() as conn:
                cur = conn.execute("UPDATE tasks SET state='done', ended_at=?, error='', results_json=? WHERE job_id=? AND state='running'", (time.time(), json.dumps([result], ensure_ascii=False), job_id))
            if cur.rowcount != 1:
                for path in saved:
                    try:
                        os.remove(path)
                    except OSError:
                        pass
        except TaskCancelled:
            for path in saved:
                try:
                    os.remove(path)
                except OSError:
                    pass
            with self._connect() as conn:
                conn.execute("UPDATE tasks SET state='cancelled', ended_at=?, error=? WHERE job_id=? AND state='running'", (time.time(), "任务已取消", job_id))
        except Exception as exc:
            for path in saved:
                try:
                    os.remove(path)
                except OSError:
                    pass
            with self._connect() as conn:
                conn.execute("UPDATE tasks SET state='error', ended_at=?, error=? WHERE job_id=? AND state='running'", (time.time(), _safe_error(exc, runtime["api_key"]), job_id))
        finally:
            with self.lock:
                runtime["api_key"] = ""
                self.runtime.pop(job_id, None)

    def status(self, job_id):
        return self._public_status(self._row_by_job(job_id))

    def video_status(self, job_id):
        return self.status(job_id)

    def cancel(self, job_id):
        row = self._row_by_job(job_id)
        if row["state"] in ("queued", "running"):
            with self.lock:
                runtime = self.runtime.get(job_id)
                if runtime is not None:
                    runtime["cancel"].set()
                with self._connect() as conn:
                    conn.execute("UPDATE tasks SET state='cancelled', ended_at=?, error=? WHERE job_id=? AND state IN ('queued','running')", (time.time(), "任务已取消", job_id))
                row = self._row_by_job(job_id)
        return self._public_status(row)

    def cancel_video(self, job_id):
        return self.cancel(job_id)

    def result_path(self, job_id, index):
        if index < 0:
            raise TaskApiError(400, "视频结果索引无效")
        row = self._row_by_job(job_id)
        if row["state"] == "expired":
            raise TaskApiError(410, "视频任务结果已过期")
        if row["state"] != "done":
            raise TaskApiError(409, "视频任务尚未完成")
        item = next((x for x in self._results_from_row(row) if int(x.get("index", -1)) == index), None)
        if not item:
            raise TaskApiError(404, "视频结果不存在")
        filename = os.path.basename(str(item.get("filename") or ""))
        root = os.path.realpath(os.path.join(TASK_JOBS_ROOT, job_id, "results"))
        path = os.path.realpath(os.path.join(root, filename))
        try:
            inside = os.path.commonpath([root, path]) == root
        except ValueError:
            inside = False
        if not filename or filename != str(item.get("filename")) or not inside or not os.path.isfile(path):
            raise TaskApiError(410, "视频结果文件不存在或已清理")
        return path, str(item.get("mime") or "video/mp4")

    def video_result_path(self, job_id, index):
        return self.result_path(job_id, index)
