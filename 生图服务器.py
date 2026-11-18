#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生图工具静态服务器
==================
作用：把本文件夹（图片生成画布版.html、图片生成供应商能力.json、提示词 txt 等）通过 HTTP 提供出去，
     并通过同源 /api/proxy 转发模型、提示词优化和图片请求，避免浏览器跨域限制，
     同时手机、电脑都能访问。

零依赖：只用 Python 标准库，Termux 装好 python 即可直接跑，无需 pip。
用法：  python 生图服务器.py
默认：  监听 0.0.0.0:8899，可改环境变量 PORT 换端口。
"""

import os
import shutil
import socket
import subprocess
import sys

# 确保从任意工作目录启动（含 Pydroid3 / Termux）都能找到同目录下的 server 包
_ENTRY_DIR = os.path.dirname(os.path.abspath(__file__))
if _ENTRY_DIR not in sys.path:
    sys.path.insert(0, _ENTRY_DIR)

from server.config import (  # noqa: E402
    ALLOW_HOSTS,
    ALLOW_PRIVATE,
    HOST,
    MAX_PROXY_BYTES,
    MIME,
    PORT,
    PROXY_TOKEN,
    ROOT,
    SERVER_LOG_MAX_BYTES,
    SERVER_LOG_PATH,
    TASK_DATA_ROOT,
    TASK_DB_PATH,
    TASK_JOBS_ROOT,
    TASK_MANAGER,
    TASK_MAX_BODY_BYTES,
    TASK_MAX_CONCURRENT,
    TASK_MAX_REF_BYTES,
    TASK_MAX_RESPONSE_BYTES,
    TASK_MAX_RESULTS,
    TASK_MAX_WORKERS,
    TASK_POLL_FAIL_WINDOW,
    TASK_POLL_MAX_FAILS,
    TASK_POLL_TIMEOUT,
    TASK_RESULT_DOWNLOAD_ATTEMPTS,
    TASK_RETENTION_SECONDS,
    TASK_STUCK_GRACE,
    TASK_UPSTREAM_TIMEOUT,
    USER_AGENT,
    VIDEO_MAX_RESPONSE_BYTES,
    get_task_manager,
    log_server_line,
    set_task_manager,
)
from server.common import (  # noqa: E402
    TaskApiError,
    TaskCancelled,
    _SafeRedirectHandler,
    _atomic_write,
    _blocked_target_global,
    _decode_b64_image,
    _friendly_task_error,
    _guess_image_mime,
    _guess_video_mime,
    _http_get_with_retry,
    _json_bytes,
    _multipart_body,
    _open_task_url,
    _parse_multipart_form,
    _read_limited,
    _safe_error,
    _sanitize_spec,
    _task_error_text,
    _valid_job_id,
)
from server.http_handler import Handler, _QueueThreadingHTTPServer  # noqa: E402
from server.image_tasks import TaskManager  # noqa: E402
from server.video_tasks import VideoTaskManager  # noqa: E402


def get_lan_ip():
    """尝试获取本机局域网 IP，失败则回退 127.0.0.1"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def open_browser(url):
    """自动打开浏览器：Termux 用 termux-open-url，其他环境用 webbrowser"""
    termux_open = shutil.which("termux-open-url")
    if termux_open:
        try:
            subprocess.run([termux_open, url], timeout=5)
            print("  已自动打开浏览器（Termux）")
            return True
        except Exception:
            pass
    import webbrowser
    try:
        if webbrowser.open(url):
            print("  已自动打开浏览器")
            return True
    except Exception:
        pass
    print("  未能自动打开浏览器，请手动访问上面的链接")
    return False


if __name__ == "__main__":
    ip = get_lan_ip()
    print("=" * 60)
    print("  生图工具服务器已启动")
    print("-" * 60)
    print("  本机打开：  http://127.0.0.1:%d/图片生成画布版.html" % PORT)
    if HOST == "0.0.0.0":
        print("  局域网打开：http://%s:%d/图片生成画布版.html" % (ip, PORT))
    else:
        print("  局域网访问：需设置 HOST_ANY=1 重启服务器")
    print("  代理安全：默认拒绝内网地址（ALLOW_PRIVATE=1 可放开）")
    print("  代理私网访问：%s" % ("已开启" if ALLOW_PRIVATE else "未开启"))
    print("  代理令牌：%s（PROXY_TOKEN 设置后生效）" % ("已开启" if PROXY_TOKEN else "未开启"))
    print("  代理白名单：%s（PROXY_ALLOW_HOSTS 设置后生效）" % (",".join(ALLOW_HOSTS) if ALLOW_HOSTS else "未开启"))
    print("  供应商配置：图片生成供应商能力.json（存在则自动生效，否则用内置预设）")
    print("  停止服务器：按 Ctrl + C")
    print("=" * 60, flush=True)

    srv = None
    try:
        # 先绑定端口，再初始化任务数据库；端口冲突时不会误把另一实例的任务标为 interrupted。
        srv = _QueueThreadingHTTPServer((HOST, PORT), Handler)
        log_server_line("SERVER-START queue=%d protocol=%s pid=%d" % (
            getattr(srv, "request_queue_size", 0), getattr(Handler, "protocol_version", "?"), os.getpid()))
        TASK_MANAGER = TaskManager()
        TASK_MANAGER.video_manager = VideoTaskManager(TASK_MANAGER)
        set_task_manager(TASK_MANAGER)
        if os.environ.get("AUTO_OPEN", "1") != "0":
            open_browser("http://127.0.0.1:%d/图片生成画布版.html" % PORT)
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已停止。")
        if TASK_MANAGER is not None:
            TASK_MANAGER.shutdown()
        if srv is not None:
            srv.server_close()
        sys.exit(0)
    except OSError as e:
        if getattr(e, "errno", None) == 98:
            print("\n端口 %d 已被占用（很可能生图服务器已在后台运行）" % PORT)
            print("处理方法：")
            print("  1. 直接打开 http://127.0.0.1:%d/图片生成画布版.html 使用现有实例" % PORT)
            print("  2. 代码更新后必须重启才生效：")
            print("       pkill -f 生图服务器.py")
            print("       然后重新运行本命令")
            print("  3. 或换端口：PORT=8890 python 生图服务器.py")
            if os.environ.get("AUTO_KILL") == "1":
                import subprocess
                import signal
                import time
                print("\n检测到 AUTO_KILL=1，正在自动清理旧实例…")
                try:
                    out = subprocess.run(["ps", "-A", "-o", "pid=", "-o", "args="], capture_output=True, text=True).stdout
                    me = str(os.getpid())
                    killed = []
                    for line in out.splitlines():
                        parts = line.strip().split(None, 1)
                        if len(parts) == 2 and "生图服务器.py" in parts[1] and parts[0] != me:
                            try:
                                os.kill(int(parts[0]), signal.SIGTERM)
                                killed.append(parts[0])
                            except Exception:
                                pass
                    if killed:
                        print("已终止旧进程：" + ", ".join(killed))
                        time.sleep(0.6)
                        srv = _QueueThreadingHTTPServer((HOST, PORT), Handler)
                        log_server_line("SERVER-START queue=%d protocol=%s pid=%d" % (
                            getattr(srv, "request_queue_size", 0), getattr(Handler, "protocol_version", "?"), os.getpid()))
                        TASK_MANAGER = TaskManager()
                        TASK_MANAGER.video_manager = VideoTaskManager(TASK_MANAGER)
                        srv.serve_forever()
                    else:
                        print("未找到旧进程，可能是其他程序占用该端口，请换端口或手动处理。")
                except Exception as ex:
                    print("自动清理失败：%s" % ex)
            sys.exit(1)
        print("启动失败：%s\n可能是端口 %d 被占用，可用 PORT=8890 python 生图服务器.py 换端口。" % (e, PORT))
        sys.exit(1)
