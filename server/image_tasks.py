# -*- coding: utf-8 -*-
"""图片后台任务管理器：SQLite 持久化、队列调度、取消/恢复/过期清理。"""

import concurrent.futures
from contextlib import contextmanager
import json
import os
import re
import secrets
import shutil
import sqlite3
import threading
import time
from urllib.parse import urlparse

from server.config import (
    TASK_DATA_ROOT,
    TASK_DB_PATH,
    TASK_JOBS_ROOT,
    TASK_MAX_CONCURRENT,
    TASK_MAX_REF_BYTES,
    TASK_MAX_RESULTS,
    TASK_MAX_WORKERS,
    TASK_RETENTION_SECONDS,
    TASK_STUCK_GRACE,
    TASK_UPSTREAM_TIMEOUT,
    log_server_line,
)
from server.common import (
    TaskApiError,
    TaskCancelled,
    _atomic_write,
    _blocked_target_global,
    _guess_image_mime,
    _safe_error,
    _sanitize_spec,
    _task_error_text,
    _valid_job_id,
)
from server.image_upstream import ImageUpstreamMixin


class TaskManager(ImageUpstreamMixin):
    """负责后台生图、状态持久化、结果文件和幂等提交。"""

    def __init__(self):
        os.makedirs(TASK_JOBS_ROOT, mode=0o700, exist_ok=True)
        self.lock = threading.RLock()
        self.runtime = {}
        self.max_concurrent = TASK_MAX_CONCURRENT
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=TASK_MAX_WORKERS)
        self.stop_event = threading.Event()
        self._init_db()
        self._mark_interrupted()
        self.cleanup()
        self.cleanup_thread = threading.Thread(target=self._cleanup_loop, name="image-task-cleanup", daemon=True)
        self.cleanup_thread.start()
        self.watch_thread = threading.Thread(target=self._watch_loop, name="image-task-watch", daemon=True)
        self.watch_thread.start()

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(TASK_DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_db(self):
        os.makedirs(TASK_DATA_ROOT, mode=0o700, exist_ok=True)
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS tasks ("
                "job_id TEXT PRIMARY KEY, client_task_id TEXT NOT NULL UNIQUE, "
                "state TEXT NOT NULL, spec_json TEXT NOT NULL, created_at REAL NOT NULL, "
                "started_at REAL, ended_at REAL, error TEXT NOT NULL DEFAULT '', "
                "results_json TEXT NOT NULL DEFAULT '[]')"
            )
            task_columns = [entry[1] for entry in conn.execute("PRAGMA table_info(tasks)").fetchall()]
            if "provider_task_id" not in task_columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN provider_task_id TEXT NOT NULL DEFAULT ''")
            if "overshoot_batch_id" not in task_columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN overshoot_batch_id TEXT NOT NULL DEFAULT ''")
            if "meta_json" not in task_columns:
                conn.execute("ALTER TABLE tasks ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_task_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_overshoot ON tasks(overshoot_batch_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tasks_state_time ON tasks(state, ended_at)")

    def _mark_interrupted(self):
        with self._connect() as conn:
            conn.execute(
                "UPDATE tasks SET state='interrupted', ended_at=?, error=? WHERE state IN ('queued','running')",
                (time.time(), "服务器重启后任务中断，可点击「恢复」找回上游状态"),
            )

    def capabilities(self):
        with self.lock:
            active = sum(1 for rt in self.runtime.values() if rt.get("submitted") and not rt.get("expired"))
        with self._connect() as conn:
            queued = conn.execute("SELECT COUNT(*) FROM tasks WHERE state='queued'").fetchone()[0]
        return {"ok": True, "taskApi": True, "videoTaskApi": True, "version": 3,
                "maxConcurrent": self.max_concurrent, "maxWorkers": TASK_MAX_WORKERS,
                "active": active, "queued": queued, "concurrencyScope": "local",
                "providerMaxConcurrent": None}

    def _release_stuck_runtime(self, job_id):
        """把一个已判失败的任务移出并发计数，并置取消标记让仍存活的线程尽快退出。"""
        with self.lock:
            rt = self.runtime.get(str(job_id))
            if not isinstance(rt, dict):
                return False
            try:
                rt["cancel"].set()
            except Exception:
                pass
            rt["expired"] = True
            rt["expiredAt"] = time.time()
            return True

    def _dispatch_queue(self):
        if self.stop_event.is_set():
            return
        with self.lock:
            active = sum(1 for rt in self.runtime.values() if rt.get("submitted") and not rt.get("expired"))
            if active >= self.max_concurrent:
                return
            with self._connect() as conn:
                rows = conn.execute("SELECT job_id FROM tasks WHERE state='queued' ORDER BY created_at ASC").fetchall()
            for row in rows:
                if active >= self.max_concurrent:
                    break
                job_id = str(row["job_id"])
                rt = self.runtime.get(job_id)
                if not rt or rt.get("submitted") or rt.get("expired"):
                    continue
                if not rt.get("resume"):
                    reason = self._overshoot_skip_reason(rt)
                    if reason:
                        with self._connect() as conn:
                            conn.execute("UPDATE tasks SET state='cancelled', ended_at=?, error=? WHERE job_id=? AND state='queued'", (time.time(), reason, job_id))
                        rt["api_key"] = ""
                        self.runtime.pop(job_id, None)
                        continue
                    spec = rt["spec"]
                    batch = str(spec.get("overshootBatchId") or "")
                    target = int(spec.get("overshootTarget") or 0)
                    if batch and target > 0:
                        done = self._overshoot_done_count(batch)
                        reserved = sum(1 for x in self.runtime.values() if x.get("submitted") and not x.get("expired") and x["spec"].get("overshootBatchId") == batch)
                        if done + reserved >= target:
                            continue
                rt["submitted"] = True
                try:
                    runner = self._resume_run if rt.get("resume") else self._run
                    rt["future"] = self.executor.submit(runner, job_id)
                    active += 1
                except Exception as exc:
                    rt["submitted"] = False
                    with self._connect() as conn:
                        conn.execute("UPDATE tasks SET state='error', ended_at=?, error=? WHERE job_id=? AND state='queued'", (time.time(), _safe_error(exc), job_id))
                    rt["api_key"] = ""
                    self.runtime.pop(job_id, None)

    def _overshoot_done_count(self, batch_id):
        with self._connect() as conn:
            rows = conn.execute("SELECT results_json FROM tasks WHERE overshoot_batch_id=? AND state='done'", (batch_id,)).fetchall()
        return sum(len(self._results_from_row(row)) for row in rows)

    def _sweep_stuck(self):
        """后台巡检：running 超过上限仍无终态 → 判失败并让出并发位。"""
        limit = TASK_UPSTREAM_TIMEOUT + TASK_STUCK_GRACE
        now = time.time()
        try:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT job_id, started_at, created_at FROM tasks WHERE state='running'"
                ).fetchall()
        except Exception:
            return 0
        released = 0
        for row in rows:
            job_id = str(row["job_id"])
            try:
                started = float(row["started_at"] or row["created_at"] or 0)
            except Exception:
                started = 0
            if not started or now - started < limit:
                continue
            message = "任务已超过 %d 秒没有终态，判定为失败（后台轮询线程失联）；可按「恢复」重新从上游取回结果" % limit
            try:
                with self._connect() as conn:
                    cur = conn.execute(
                        "UPDATE tasks SET state='error', ended_at=?, error=? WHERE job_id=? AND state='running'",
                        (now, message, job_id),
                    )
                if cur.rowcount == 1:
                    released += 1
                    self._release_stuck_runtime(job_id)
                    log_server_line("STUCK-SWEEP " + job_id)
            except Exception:
                continue
        return released

    def _watch_loop(self):
        """5 秒巡检：给卡死任务收尾 + 补派发排队任务（不依赖前端是否在轮询）。"""
        while not self.stop_event.wait(5.0):
            try:
                self._sweep_stuck()
                self._purge_expired_runtime()
                self._dispatch_queue()
            except Exception as exc:
                log_server_line("WATCH-ERR " + _safe_error(exc))

    def _purge_expired_runtime(self):
        """线程被系统冻结后可能永远不返回：过期运行时条目保留 10 分钟后回收，避免密钥常驻内存。"""
        now = time.time()
        with self.lock:
            stale = [
                jid for jid, rt in self.runtime.items()
                if isinstance(rt, dict) and rt.get("expired") and now - float(rt.get("expiredAt") or now) > 600
            ]
            for jid in stale:
                rt = self.runtime.pop(jid, None)
                if isinstance(rt, dict):
                    try:
                        rt["api_key"] = ""
                    except Exception:
                        pass

    def _row_by_job(self, job_id):
        if not _valid_job_id(job_id):
            raise TaskApiError(400, "job_id 无效")
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE job_id=?", (job_id,)).fetchone()
        if row is None:
            raise TaskApiError(404, "任务不存在")
        return row

    def _row_by_client(self, client_task_id):
        with self._connect() as conn:
            return conn.execute("SELECT * FROM tasks WHERE client_task_id=?", (client_task_id,)).fetchone()

    @staticmethod
    def _results_from_row(row):
        try:
            value = json.loads(row["results_json"] or "[]")
            return value if isinstance(value, list) else []
        except Exception:
            return []

    @staticmethod
    def _meta_from_row(row):
        """成本/耗时等展示用元信息（旧库可能没有该列，全部容错）。"""
        try:
            value = json.loads(row["meta_json"] or "{}") if "meta_json" in row.keys() else {}
            return value if isinstance(value, dict) else {}
        except Exception:
            return {}

    def _recover_stuck_row(self, row):
        """僵尸任务兜底：state 仍是 queued/running，但已超过 UPSTREAM_TIMEOUT+STUCK_GRACE，
        说明后台轮询线程早已失联（进程被系统冻结、上游请求挂起、线程异常退出等）。
        查询时主动判为 error，避免前端永远转圈。"""
        try:
            state = str(row["state"] or "")
            if state != "running":
                return row
            started = float(row["started_at"] or row["created_at"] or 0)
            if not started:
                return row
            limit = TASK_UPSTREAM_TIMEOUT + TASK_STUCK_GRACE
            if time.time() - started < limit:
                return row
            message = "任务已超过 %d 秒没有终态，判定为失败（后台轮询线程失联）；可按「恢复」重新从上游取回结果" % limit
            with self._connect() as conn:
                conn.execute(
                    "UPDATE tasks SET state='error', ended_at=?, error=? WHERE job_id=? AND state='running'",
                    (time.time(), message, row["job_id"]),
                )
            log_server_line("STUCK-RECOVER " + str(row["job_id"]))
            # 让出并发位并把卡死任务踢出计数，排队任务不再被它拖住
            self._release_stuck_runtime(str(row["job_id"]))
            self._dispatch_queue()
            with self._connect() as conn:
                fresh = conn.execute("SELECT * FROM tasks WHERE job_id=?", (row["job_id"],)).fetchone()
            return fresh or row
        except Exception:
            return row

    def _public_status(self, row):
        row = self._recover_stuck_row(row)
        results = []
        for item in self._results_from_row(row):
            try:
                index = int(item.get("index"))
            except Exception:
                continue
            results.append({
                "index": index,
                "url": "/api/tasks/%s/result/%d" % (row["job_id"], index),
                "mime": str(item.get("mime") or "application/octet-stream"),
                "size": int(item.get("size") or 0),
            })
        return {
            "ok": True, "jobId": row["job_id"], "clientTaskId": row["client_task_id"],
            "state": row["state"], "createdAt": row["created_at"] or 0,
            "startedAt": row["started_at"] or 0, "endedAt": row["ended_at"] or 0,
            "error": row["error"] or "", "results": results,
            "providerTaskId": (row["provider_task_id"] or "") if "provider_task_id" in row.keys() else "",
            "meta": self._meta_from_row(row),
        }

    def status(self, job_id):
        return self._public_status(self._row_by_job(job_id))

    def by_client_status(self, client_task_id):
        # 只读查询：按客户端任务标识查任务；不存在返回 404，不会创建新任务。
        row = self._row_by_client(str(client_task_id or "").strip())
        if row is None:
            raise TaskApiError(404, "任务不存在", "task_not_found")
        return self._public_status(row)

    def _validate_spec(self, spec):
        if not isinstance(spec, dict):
            raise TaskApiError(400, "spec 必须是 JSON 对象")
        complexity = spec.get("complexity")
        if complexity not in (None, "", "low", "medium", "high"):
            raise TaskApiError(400, "规划复杂度必须为 low、medium 或 high", "invalid_complexity")
        client_task_id = str(spec.get("clientTaskId") or "")
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{8,128}", client_task_id):
            raise TaskApiError(400, "clientTaskId 无效")
        mode = str(spec.get("mode") or "txt2img")
        if mode not in ("txt2img", "img2img"):
            raise TaskApiError(400, "不支持的生图模式")
        if not str(spec.get("model") or "").strip():
            raise TaskApiError(400, "缺少生图模型")
        if not str(spec.get("requestPrompt") or spec.get("prompt") or "").strip():
            raise TaskApiError(400, "缺少提示词")
        base = str(spec.get("baseUrl") or "").strip().rstrip("/")
        parsed = urlparse(base)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise TaskApiError(400, "Base URL 必须是绝对 http(s) 地址")
        if _blocked_target_global(base):
            raise TaskApiError(403, "任务拒绝访问内网/本机 Base URL")
        try:
            n = int(spec.get("n") or 1)
        except Exception as exc:
            raise TaskApiError(400, "生成数量无效") from exc
        if n < 1 or n > TASK_MAX_RESULTS:
            raise TaskApiError(400, "生成数量超过服务器限制")
        return client_task_id, mode, base, n

    def create_task(self, spec, api_key, uploads):
        if not str(api_key or "").strip():
            raise TaskApiError(401, "缺少生图 API Key")
        client_task_id, mode, base, n = self._validate_spec(spec)
        safe_spec = _sanitize_spec(spec)
        safe_spec.update({"clientTaskId": client_task_id, "mode": mode, "baseUrl": base, "n": n})
        uploads = list(uploads or [])
        caps = safe_spec.get("capabilities") or {}
        max_refs = max(1, min(16, int(caps.get("maxReferences") or 4))) + (1 if safe_spec.get("inpaint") else 0)
        if len(uploads) > max_refs:
            raise TaskApiError(413, "参考图数量超过当前模型上限")
        inpaint = bool(safe_spec.get("inpaint"))
        if mode == "txt2img" and uploads:
            raise TaskApiError(400, "文生图任务不应上传参考图")
        if mode == "img2img" and not uploads:
            raise TaskApiError(400, "图生图任务缺少参考图")

        with self.lock:
            existing = self._row_by_client(client_task_id)
            if existing is not None:
                result = self._public_status(existing)
                result["deduplicated"] = True
                return result
            job_id = "job_" + str(int(time.time() * 1000)) + "_" + secrets.token_hex(6)
            job_dir = os.path.join(TASK_JOBS_ROOT, job_id)
            refs_dir = os.path.join(job_dir, "refs")
            results_dir = os.path.join(job_dir, "results")
            os.makedirs(refs_dir, mode=0o700, exist_ok=False)
            os.makedirs(results_dir, mode=0o700, exist_ok=False)
            runtime_files = []
            persisted_files = []
            try:
                roles = safe_spec.get("referenceRoles") if isinstance(safe_spec.get("referenceRoles"), list) else []
                for index, item in enumerate(uploads):
                    data = item.get("data") or b""
                    if len(data) > TASK_MAX_REF_BYTES:
                        raise TaskApiError(413, "参考图超过单文件大小限制")
                    mime, ext = _guess_image_mime(data, item.get("mime"))
                    if not mime:
                        raise TaskApiError(400, "参考图不是受支持的图片格式")
                    filename = "upload_%d%s" % (index, ext)
                    path = os.path.join(refs_dir, filename)
                    _atomic_write(path, data)
                    field = str(item.get("field") or "ref_%d" % index)
                    runtime_files.append({
                        "field": field, "path": path, "filename": filename,
                        "mime": mime, "role": str(roles[index]) if index < len(roles) else ("subject" if index == 0 else "style"),
                    })
                    persisted_files.append({"field": field, "path": "refs/" + filename, "mime": mime})
                safe_spec["referenceFiles"] = persisted_files
                now = time.time()
                with self._connect() as conn:
                    overshoot_batch_id = str(safe_spec.get("overshootBatchId") or "").strip()[:128]
                    conn.execute(
                        "INSERT INTO tasks(job_id, client_task_id, state, spec_json, created_at, results_json, overshoot_batch_id) VALUES(?,?,?,?,?,?,?)",
                        (job_id, client_task_id, "queued", json.dumps(safe_spec, ensure_ascii=False), now, "[]", overshoot_batch_id),
                    )
                self.runtime[job_id] = {
                    "spec": safe_spec, "api_key": str(api_key), "files": runtime_files,
                    "cancel": threading.Event(), "job_dir": job_dir, "inpaint": inpaint,
                    "job_id": job_id,
                }
                # 交给排队调度器：逻辑并发有空位才真正起线程（避免挂死任务拖住整条队列）
                self.runtime[job_id]["submitted"] = False
                self._dispatch_queue()
            except Exception:
                if os.path.isdir(job_dir):
                    shutil.rmtree(job_dir, ignore_errors=True)
                raise
            result = self._public_status(self._row_by_job(job_id))
            result["deduplicated"] = False
            return result

    def _mark_running(self, job_id):
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE tasks SET state='running', started_at=? WHERE job_id=? AND state='queued'",
                (time.time(), job_id),
            )
            return cur.rowcount == 1

    def _current_state(self, job_id):
        try:
            return self._row_by_job(job_id)["state"]
        except TaskApiError:
            return "missing"

    def _run(self, job_id):
        with self.lock:
            runtime = self.runtime.get(job_id)
        if runtime is None or not self._mark_running(job_id):
            if runtime is not None:
                with self.lock:
                    runtime["api_key"] = ""
                    self.runtime.pop(job_id, None)
            # 没抢到 running（已被取消/已完成）：立刻让位给排队任务
            self._dispatch_queue()
            return
        try:
            if runtime["cancel"].is_set():
                raise TaskCancelled()
            skip_reason = self._overshoot_skip_reason(runtime)
            if skip_reason:
                with self._connect() as conn:
                    conn.execute("UPDATE tasks SET state='cancelled', ended_at=?, error=? WHERE job_id=? AND state='running'", (time.time(), skip_reason, job_id))
                return
            items = self._call_upstream(runtime)
            _atomic_write(os.path.join(runtime["job_dir"], "upstream-results.json"), json.dumps(items, ensure_ascii=False).encode("utf-8"))
            # 上游已返回结果说明任务已实际执行（可能已计费）：无条件保存结果，不再因取消标记丢弃。
            self._finish_with_items(job_id, runtime, items)
        except TaskCancelled:
            with self._connect() as conn:
                conn.execute("UPDATE tasks SET state='cancelled', ended_at=?, error=? WHERE job_id=? AND state IN ('queued','running')", (time.time(), "任务已取消", job_id))
        except Exception as exc:
            with self._connect() as conn:
                conn.execute("UPDATE tasks SET state='error', ended_at=?, error=? WHERE job_id=? AND state IN ('queued','running')", (time.time(), _task_error_text(exc, runtime["api_key"]), job_id))
        finally:
            with self.lock:
                runtime["api_key"] = ""
                if self.runtime.get(job_id) is runtime:
                    self.runtime.pop(job_id, None)
            # 让出一个并发位后立即补齐排队任务
            self._dispatch_queue()

    def _finish_with_items(self, job_id, runtime, items):
        if not items:
            raise TaskApiError(502, "上游未返回可用图片")
        result_dir = os.path.join(runtime["job_dir"], "results")
        os.makedirs(result_dir, mode=0o700, exist_ok=True)
        results = self._results_from_row(self._row_by_job(job_id))
        by_index = {int(x["index"]): x for x in results if os.path.isfile(os.path.join(result_dir, os.path.basename(x["filename"])))}
        errors = []
        for index, item in enumerate(items):
            previous = by_index.get(index)
            if previous and os.path.isfile(os.path.join(result_dir, os.path.basename(previous["filename"]))):
                continue
            try:
                # A completed upstream result remains valuable after a local watchdog timeout.
                data, mime, ext = self._resolve_result(item, runtime["spec"], api_key=runtime.get("api_key") or "")
                filename = "%d%s" % (index, ext)
                _atomic_write(os.path.join(result_dir, filename), data)
                by_index[index] = {"index": index, "filename": filename, "mime": mime, "size": len(data)}
                with self._connect() as conn:
                    conn.execute("UPDATE tasks SET results_json=? WHERE job_id=?", (json.dumps(list(by_index.values())), job_id))
            except Exception as exc:
                errors.append("第 %d 张：%s" % (index + 1, _task_error_text(exc, runtime.get("api_key") or "")))
        warning = ("已保存 %d/%d 张，点「补取返图」只下载缺失图片，不重复生图。" % (len(by_index), len(items)) + "；".join(errors)) if errors else ""
        self._save_task_meta(job_id, {"result_count_expected": len(items), "result_count_saved": len(by_index), "result_warning": warning})
        if not by_index:
            raise TaskApiError(502, warning or "返图失败，可恢复原结果", "result_download_failed")
        with self._connect() as conn:
            conn.execute("UPDATE tasks SET state='done', ended_at=?, error='', results_json=? WHERE job_id=?", (time.time(), json.dumps(sorted(by_index.values(), key=lambda x:x["index"])), job_id))

    def _overshoot_skip_reason(self, runtime):
        # 超生成防超额：任务即将发出上游请求前，检查同批次成功数是否已达目标；已达则不再开始。
        spec = runtime.get("spec") if isinstance(runtime, dict) else None
        if not isinstance(spec, dict):
            return ""
        batch_id = str(spec.get("overshootBatchId") or "").strip()
        if not batch_id:
            return ""
        try:
            target = int(spec.get("overshootTarget") or 0)
        except Exception:
            target = 0
        if target <= 0:
            return ""
        try:
            done = self._overshoot_done_count(batch_id)
        except Exception:
            return ""
        if done >= target:
            return "已达成功目标（%d/%d），未开始生成的任务已停止" % (done, target)
        return ""

    def cancel(self, job_id):
        with self.lock:
            self._row_by_job(job_id)
            with self._connect() as conn:
                cur = conn.execute("UPDATE tasks SET state='cancelled', ended_at=?, error=? WHERE job_id=? AND state='queued'", (time.time(), "任务已取消（未开始生成）", job_id))
            if cur.rowcount:
                runtime = self.runtime.get(job_id)
                if runtime:
                    runtime["cancel"].set()
                    if not runtime.get("submitted"):
                        runtime["api_key"] = ""
                        self.runtime.pop(job_id, None)
            row = self._row_by_job(job_id)
            result = self._public_status(row)
            result["cancelResult"] = "cancelled" if cur.rowcount else ("declined" if row["state"] == "running" else "noop")
            if result["cancelResult"] == "declined":
                result["cancelReason"] = "任务已开始生成，将继续完成并保留结果"
        self._dispatch_queue()
        return result

    def _runtime_from_row(self, row, spec, api_key):
        job_id = row["job_id"]
        job_dir = os.path.join(TASK_JOBS_ROOT, job_id)
        files = []
        for item in (spec.get("referenceFiles") or []):
            rel = str(item.get("path") or "").replace("\\", "/")
            if not rel:
                continue
            path = os.path.normpath(os.path.join(job_dir, rel))
            if not path.startswith(os.path.normpath(job_dir) + os.sep):
                continue
            files.append({
                "field": str(item.get("field") or ("ref_%d" % len(files))),
                "path": path,
                "filename": os.path.basename(path),
                "mime": str(item.get("mime") or "application/octet-stream"),
                "role": "subject" if len(files) == 0 else "style",
            })
        return {
            "spec": spec, "api_key": str(api_key), "files": files,
            "cancel": threading.Event(), "job_dir": job_dir,
            "inpaint": bool(spec.get("inpaint")), "job_id": job_id,
        }

    def _resume_status_result(self, row, ok, mode, reason):
        result = self._public_status(row)
        result["resume"] = {"ok": bool(ok), "mode": str(mode), "reason": str(reason)}
        return result

    def _resume_mark_running(self, job_id):
        with self._connect() as conn:
            cur = conn.execute(
                "UPDATE tasks SET state='running', started_at=?, error='', ended_at=NULL WHERE job_id=? AND state IN ('queued','error','interrupted','expired','cancelled')",
                (time.time(), job_id),
            )
            return cur.rowcount == 1

    def resume(self, job_id, api_key, base_url=None):
        row = self._row_by_job(job_id)
        if row["state"] in ("queued", "running"):
            return self._resume_status_result(row, True, "active", "任务仍在运行中")
        spec = json.loads(row["spec_json"] or "{}")
        manifest = os.path.join(TASK_JOBS_ROOT, job_id, "upstream-results.json")
        results = self._results_from_row(row)
        expected = int(self._meta_from_row(row).get("result_count_expected") or len(results))
        files_ok = all(os.path.isfile(os.path.join(TASK_JOBS_ROOT, job_id, "results", os.path.basename(x["filename"]))) for x in results)
        if row["state"] == "done" and len(results) >= expected and files_ok:
            return self._resume_status_result(row, True, "done", "任务已完成")
        # Original provider binding is immutable during recovery. A UI profile switch cannot redirect its Key.
        override = str(base_url or "").strip().rstrip("/")
        if override and urlparse(override).netloc.lower() != urlparse(str(spec.get("baseUrl") or "")).netloc.lower():
            return self._resume_status_result(row, False, "provider-mismatch", "请切回原供应商配置后恢复该任务")
        local_result = os.path.isfile(manifest)
        if not local_result and not (self._is_native_protocol(spec) or self._is_openai_async_protocol(spec) or self._is_futureai_protocol(spec)):
            return self._resume_status_result(row, False, "unsupported", "原同步请求尚未返回结果；请在供应商后台核对是否计费")
        key = str(api_key or "").strip()
        if not key and not local_result:
            return self._resume_status_result(row, False, "no-key", "恢复上游任务需要原供应商 API Key")
        if not local_result and not str(row["provider_task_id"] or ""):
            return self._resume_status_result(row, False, "no-upstream-id", "尚未取得上游任务编号，请在供应商后台核对；不会重新生图")
        with self.lock:
            existing = self.runtime.get(job_id)
            if existing:
                future = existing.get("future")
                if not existing.get("expired") or (future and not future.done()):
                    return self._resume_status_result(row, False, "active", "原任务线程仍在收尾，请稍后恢复")
                existing["api_key"] = ""
                self.runtime.pop(job_id, None)
            runtime = self._runtime_from_row(row, spec, key)
            runtime.update({"resume": True, "submitted": False})
            with self._connect() as conn:
                conn.execute("UPDATE tasks SET state='queued', started_at=NULL, ended_at=NULL, error='' WHERE job_id=?", (job_id,))
            self.runtime[job_id] = runtime
            self._dispatch_queue()
        return self._resume_status_result(self._row_by_job(job_id), True, "provider", "已排队补取原任务，不会重新生成")

    def _resume_run(self, job_id):
        with self.lock:
            runtime = self.runtime.get(job_id)
        if runtime is None:
            self._dispatch_queue()
            return
        try:
            if not self._resume_mark_running(job_id):
                return
            manifest = os.path.join(runtime["job_dir"], "upstream-results.json")
            if os.path.isfile(manifest):
                with open(manifest, encoding="utf-8") as fh:
                    items = json.load(fh)
            else:
                row = self._row_by_job(job_id)
                provider_id = str(row["provider_task_id"] or "")
                if not provider_id:
                    raise TaskApiError(409, "没有上游任务编号，不会重复生成")
                if self._is_futureai_protocol(runtime["spec"]):
                    items = self._poll_futureai_task(runtime, provider_id)
                elif self._is_openai_async_protocol(runtime["spec"]):
                    ref = self._meta_from_row(row).get("provider_poll_ref") or provider_id
                    items = self._poll_openai_async_task(runtime, ref)
                else:
                    items = self._poll_native_task(runtime, provider_id)
                _atomic_write(manifest, json.dumps(items, ensure_ascii=False).encode("utf-8"))
            self._finish_with_items(job_id, runtime, items)
        except TaskCancelled:
            with self._connect() as conn:
                conn.execute("UPDATE tasks SET state='cancelled', ended_at=? WHERE job_id=? AND state IN ('queued','running')", (time.time(), job_id))
        except Exception as exc:
            with self._connect() as conn:
                conn.execute("UPDATE tasks SET state='error', ended_at=?, error=? WHERE job_id=? AND state IN ('queued','running')", (time.time(), _task_error_text(exc, runtime.get("api_key") or ""), job_id))
        finally:
            with self.lock:
                runtime["api_key"] = ""
                if self.runtime.get(job_id) is runtime:
                    self.runtime.pop(job_id, None)
            self._dispatch_queue()

    def result_path(self, job_id, index):
        if index < 0:
            raise TaskApiError(400, "结果索引无效")
        row = self._row_by_job(job_id)
        if row["state"] == "expired":
            raise TaskApiError(410, "任务结果已过期")
        if row["state"] != "done":
            raise TaskApiError(409, "任务尚未完成")
        item = next((x for x in self._results_from_row(row) if int(x.get("index", -1)) == index), None)
        if not item:
            raise TaskApiError(404, "结果不存在")
        filename = os.path.basename(str(item.get("filename") or ""))
        if not filename or filename != str(item.get("filename")):
            raise TaskApiError(404, "结果路径无效")
        root = os.path.realpath(os.path.join(TASK_JOBS_ROOT, job_id, "results"))
        path = os.path.realpath(os.path.join(root, filename))
        try:
            inside = os.path.commonpath([root, path]) == root
        except ValueError:
            inside = False
        if not inside or not os.path.isfile(path):
            raise TaskApiError(410, "结果文件不存在或已清理")
        return path, str(item.get("mime") or "application/octet-stream")

    def forget(self, job_id):
        """清理本机任务记录与结果文件（不触碰上游中转站）。运行中的任务需先终止。"""
        row = self._row_by_job(job_id)
        state = str(row["state"])
        if state in ("queued", "running"):
            return {"jobId": job_id, "forgotten": False, "state": state, "reason": "任务仍在运行，请先终止后再清理"}
        with self.lock:
            runtime = self.runtime.get(job_id)
            if runtime and runtime.get("future") and not runtime["future"].done():
                return {"jobId": job_id, "forgotten": False, "state": state, "reason": "原任务线程仍在保存结果，请稍后清理"}
            with self._connect() as conn:
                conn.execute("DELETE FROM tasks WHERE job_id=?", (job_id,))
            shutil.rmtree(os.path.join(TASK_JOBS_ROOT, job_id), ignore_errors=True)
        return {"jobId": job_id, "forgotten": True, "state": state, "reason": "本机任务记录与结果文件已清理（未触碰上游）"}

    def cleanup(self):
        cutoff = time.time() - TASK_RETENTION_SECONDS
        with self.lock:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT job_id FROM tasks WHERE state IN ('done','error','cancelled','interrupted','expired') AND ended_at IS NOT NULL AND ended_at < ?",
                    (cutoff,),
                ).fetchall()
                for row in rows:
                    shutil.rmtree(os.path.join(TASK_JOBS_ROOT, row["job_id"]), ignore_errors=True)
                    conn.execute("UPDATE tasks SET state='expired', error=?, results_json='[]' WHERE job_id=?", ("任务结果已过期", row["job_id"]))

    def _cleanup_loop(self):
        while not self.stop_event.wait(3600):
            try:
                self.cleanup()
            except Exception:
                pass

    def create_video_task(self, spec, api_key, uploads):
        return self.video_manager.create_video_task(spec, api_key, uploads)

    def video_status(self, job_id):
        return self.video_manager.video_status(job_id)

    def cancel_video(self, job_id):
        return self.video_manager.cancel_video(job_id)

    def video_result_path(self, job_id, index):
        return self.video_manager.video_result_path(job_id, index)

    def shutdown(self):
        self.stop_event.set()
        try:
            self.executor.shutdown(wait=False, cancel_futures=True)
        except TypeError:
            self.executor.shutdown(wait=False)
