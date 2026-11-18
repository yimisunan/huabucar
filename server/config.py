# -*- coding: utf-8 -*-
"""全局配置、路径常量、MIME 表与服务端诊断日志。"""

import os
import time

# ---------- 配置 ----------
# server/config.py 位于 <ROOT>/server/config.py，向上两级即为项目根目录 ROOT
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 默认仅本机访问（安全）；需要手机/电脑局域网访问时：HOST_ANY=1 python 生图服务器.py
HOST = "0.0.0.0" if os.environ.get("HOST_ANY", "0") == "1" else "127.0.0.1"
PORT = int(os.environ.get("PORT", "8899"))
# 设置后 /api/proxy 必须带 ?token= 才能转发（局域网共享时建议开启）
PROXY_TOKEN = os.environ.get("PROXY_TOKEN", "").strip()
# 非空 = 白名单模式：仅允许转发这些主机（逗号分隔，如 api.example.com,cdn.example.com）
ALLOW_HOSTS = [h.strip().lower() for h in os.environ.get("PROXY_ALLOW_HOSTS", "").split(",") if h.strip()]
# 代理响应体上限（默认 60MB），超过截断连接，防止内存被超大响应撑爆
MAX_PROXY_BYTES = int(os.environ.get("MAX_PROXY_BYTES", "62914560"))
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"
# 是否允许 /api/proxy 转发到本机或私网 API（默认关闭）
ALLOW_PRIVATE = os.environ.get("ALLOW_PRIVATE", "0") == "1"

# ---------- 后台生图任务配置 ----------
# 任务 API 将生图请求放到后端线程池中执行，浏览器只保存 job_id 并查询状态。
TASK_DATA_ROOT = os.path.abspath(os.environ.get("TASK_DATA_ROOT") or os.path.join(ROOT, ".生图任务"))
TASK_JOBS_ROOT = os.path.join(TASK_DATA_ROOT, "jobs")
TASK_DB_PATH = os.path.join(TASK_DATA_ROOT, "tasks.sqlite3")


SERVER_LOG_PATH = os.path.join(TASK_DATA_ROOT, "server.log")
SERVER_LOG_MAX_BYTES = 2 * 1024 * 1024


def log_server_line(text):
    """诊断日志：请求行 / 任务上传清单 / 拒绝原因，追加写入 .生图任务/server.log（只记录，不影响行为）"""
    try:
        os.makedirs(TASK_DATA_ROOT, mode=0o700, exist_ok=True)
        if os.path.exists(SERVER_LOG_PATH) and os.path.getsize(SERVER_LOG_PATH) > SERVER_LOG_MAX_BYTES:
            try:
                os.replace(SERVER_LOG_PATH, SERVER_LOG_PATH + ".1")
            except Exception:
                pass
        with open(SERVER_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), str(text)))
    except Exception:
        pass

TASK_MAX_CONCURRENT = max(1, int(os.environ.get("TASK_MAX_CONCURRENT", "3")))
# 线程数大于逻辑并发：被上游挂死 / 被系统冻结的线程不能把整条队列饿死（见 _dispatch_queue）
TASK_MAX_WORKERS = max(TASK_MAX_CONCURRENT, int(os.environ.get("TASK_MAX_WORKERS", str(TASK_MAX_CONCURRENT + 3))))
TASK_MAX_BODY_BYTES = int(os.environ.get("TASK_MAX_BODY_BYTES", str(128 * 1024 * 1024)))
TASK_MAX_REF_BYTES = int(os.environ.get("TASK_MAX_REF_BYTES", str(30 * 1024 * 1024)))
TASK_MAX_RESPONSE_BYTES = int(os.environ.get("TASK_MAX_RESPONSE_BYTES", str(60 * 1024 * 1024)))
VIDEO_MAX_RESPONSE_BYTES = int(os.environ.get("VIDEO_MAX_RESPONSE_BYTES", str(256 * 1024 * 1024)))
TASK_RESULT_DOWNLOAD_ATTEMPTS = 4
TASK_MAX_RESULTS = max(1, int(os.environ.get("TASK_MAX_RESULTS", "4")))
TASK_RETENTION_SECONDS = max(3600, int(os.environ.get("TASK_RETENTION_SECONDS", str(7 * 24 * 3600))))
TASK_UPSTREAM_TIMEOUT = max(10, int(os.environ.get("TASK_UPSTREAM_TIMEOUT", "600")))
# 轮询单次请求的超时（秒）。关键：绝不能用 TASK_UPSTREAM_TIMEOUT(600s) 做轮询请求超时，
# 否则上游一次不响应就吃掉全部重试预算，任务会空转卡死在“后端生成中”。
TASK_POLL_TIMEOUT = max(5, int(os.environ.get("TASK_POLL_TIMEOUT", "20")))
# 轮询连续失败上限 / 失败累积时间窗口（秒）：超出则立即失败，不再空转
TASK_POLL_MAX_FAILS = max(2, int(os.environ.get("TASK_POLL_MAX_FAILS", "6")))
TASK_POLL_FAIL_WINDOW = max(20, int(os.environ.get("TASK_POLL_FAIL_WINDOW", "90")))
# 僵尸任务宽限（秒）：running 超过 UPSTREAM_TIMEOUT+GRACE 仍无终态，查询时主动判失败
TASK_STUCK_GRACE = max(30, int(os.environ.get("TASK_STUCK_GRACE", "60")))
TASK_MANAGER = None

MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm":  "text/html; charset=utf-8",
    ".txt":  "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif":  "image/gif",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".mp4":  "video/mp4",
}


def get_task_manager():
    return TASK_MANAGER


def set_task_manager(manager):
    global TASK_MANAGER
    TASK_MANAGER = manager
