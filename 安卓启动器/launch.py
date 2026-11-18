#!/usr/bin/env python3
"""Termux 与 Widget 共用的猫画布启动入口。"""
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request

PROJECT = Path(os.environ.get("CATCANVAS_PROJECT") or Path(__file__).resolve().parent.parent)
SERVER = PROJECT / "生图服务器.py"
PRIVATE = Path("/data/data/com.termux/files/home/.termux/catcanvas")
PREFIX = Path("/data/data/com.termux/files/usr/bin")
BASE = "http://127.0.0.1:8899"
PAGE = BASE + "/" + urllib.parse.quote("图片生成画布版.html")
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def ready():
    try:
        with HTTP.open(BASE + "/api/ping", timeout=1) as response:
            if not json.loads(response.read(4096)).get("ok"):
                return False
        with HTTP.open(PAGE, timeout=1) as response:
            return "猫画布" in response.read(8192).decode("utf-8", "replace")
    except (OSError, ValueError):
        return False


def open_browser():
    try:
        result = subprocess.run([str(PREFIX / "termux-open-url"), PAGE], timeout=10, check=False)
        if result.returncode == 0:
            print("已打开浏览器画布。", flush=True)
            return
    except (OSError, subprocess.TimeoutExpired):
        pass
    print("请在浏览器打开：" + BASE + "/图片生成画布版.html", flush=True)


def failure(message):
    print("\n启动未完成：" + message, flush=True)
    if "--no-wait-on-error" not in sys.argv and sys.stdin.isatty():
        try:
            input("按回车关闭此启动窗口…")
        except (EOFError, KeyboardInterrupt):
            pass
    return 1


def main():
    if ready():
        print("服务已经运行，直接打开画布。", flush=True)
        open_browser()
        return 0
    if not SERVER.is_file():
        return failure("无法读取生图服务器，请检查 Termux 的文件访问权限和项目位置。")
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (PRIVATE / "server.lock").open("a") as lock:
        return launch_locked(lock)


def launch_locked(lock):
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("另一个启动窗口正在准备服务器…", flush=True)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if ready():
                open_browser()
                return 0
            time.sleep(0.4)
        return failure("已有启动进程，但服务尚未响应。请查看原来的猫画布终端；不会自动结束已有进程。")
    if ready():
        open_browser()
        return 0
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as check:
        check.settimeout(1)
        if check.connect_ex(("127.0.0.1", 8899)) == 0:
            return failure("8899 端口已被占用或服务暂时无响应。请检查原有终端；不会自动结束进程。")
    logfile = PRIVATE / "server.log"
    if logfile.exists() and logfile.stat().st_size > 2 * 1024 * 1024:
        logfile.replace(PRIVATE / "server.previous.log")
    env = os.environ.copy()
    env.update(AUTO_OPEN="0", PORT="8899", HOST_ANY="0", PYTHONDONTWRITEBYTECODE="1", PYTHONUNBUFFERED="1")
    env.pop("AUTO_KILL", None)
    print("正在启动猫画布服务器…", flush=True)
    print("终端保留服务器会话；按 Ctrl+C 可停止。", flush=True)
    print("启动日志：" + str(logfile), flush=True)
    with logfile.open("ab", buffering=0) as output:
        output.write(("\n--- " + time.strftime("%Y-%m-%d %H:%M:%S") + " ---\n").encode())
        try:
            process = subprocess.Popen([sys.executable, "-u", str(SERVER)], cwd=str(PROJECT), env=env, stdout=output, stderr=subprocess.STDOUT)
        except OSError as exc:
            return failure("无法运行 Python：" + str(exc))
        deadline = time.monotonic() + 25
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    tail = logfile.read_text(encoding="utf-8", errors="replace")[-3500:]
                    print(tail, flush=True)
                    return failure("服务器退出，请查看上方错误或启动日志。")
                if ready():
                    print("服务器已就绪，进程 PID=" + str(process.pid), flush=True)
                    open_browser()
                    return process.wait()
                time.sleep(0.3)
            print("启动超过 25 秒，终端继续保留。请查看日志并稍后再次点击猫画布。", flush=True)
            return process.wait()
        except KeyboardInterrupt:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    print("服务器仍在退出，请查看原终端。", flush=True)
            print("猫画布启动窗口已结束。", flush=True)
            return 0


if __name__ == "__main__":
    raise SystemExit(main())