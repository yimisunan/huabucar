#!/usr/bin/env python3
"""使用本机 JDK、aapt、D8 与 apksigner 构建无依赖启动器。"""
from pathlib import Path
import shlex
import ast
import hashlib
import os
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent
SDK = Path(os.environ.get("CATCANVAS_ANDROID_JAR", "/opt/androidsdk/android-35/android.jar"))
R8 = Path(os.environ.get("CATCANVAS_R8_JAR", "/opt/androidsdk/r8.jar"))
RESOURCES_SDK = Path(os.environ.get("CATCANVAS_RESOURCES_JAR", "/opt/androidsdk/android-30.jar"))
TOOL_NAMES = ("aapt", "javac", "java", "zipalign", "apksigner", "keytool")
TOOLS = {name: shlex.split(os.environ.get("CATCANVAS_" + name.upper(), name)) for name in TOOL_NAMES}
BUILD = ROOT / "build"


def run(*args):
    command = TOOLS.get(str(args[0]), [str(args[0])]) + [str(arg) for arg in args[1:]]
    subprocess.run(command, cwd=str(ROOT), check=True)


def main():
    if not SDK.is_file() or not R8.is_file():
        raise SystemExit("请设置 CATCANVAS_ANDROID_JAR 和 CATCANVAS_R8_JAR。")
    for tool in TOOL_NAMES:
        if not TOOLS[tool] or not shutil.which(TOOLS[tool][0]):
            raise SystemExit("缺少构建工具：" + tool)
    ast.parse((ROOT / "launch.py").read_text(encoding="utf-8"))
    run("bash", "-n", ROOT / "start.sh")
    for name in ("generated", "classes", "dex"):
        (BUILD / name).mkdir(parents=True, exist_ok=True)
    drawable = ROOT / "res" / "drawable"
    drawable.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT.parent / "icons" / "icon-512.png", drawable / "app_icon.png")
    run("aapt", "package", "-f", "-M", ROOT / "AndroidManifest.xml", "-S", ROOT / "res", "-I", RESOURCES_SDK, "-J", BUILD / "generated", "-F", BUILD / "resources.ap_")
    sources = sorted((ROOT / "src").rglob("*.java")) + sorted((BUILD / "generated").rglob("*.java"))
    run("javac", "--release", "8", "-encoding", "UTF-8", "-classpath", SDK, "-d", BUILD / "classes", *sources)
    classes = sorted((BUILD / "classes").rglob("*.class"))
    run("java", "-cp", R8, "com.android.tools.r8.D8", "--lib", SDK, "--min-api", "26", "--output", BUILD / "dex", *classes)
    unsigned = BUILD / "unsigned.apk"
    shutil.copyfile(BUILD / "resources.ap_", unsigned)
    with zipfile.ZipFile(unsigned, "a", compression=zipfile.ZIP_DEFLATED) as apk:
        for dex in sorted((BUILD / "dex").glob("*.dex")):
            apk.write(dex, dex.name)
    aligned = BUILD / "aligned.apk"
    run("zipalign", "-f", "4", unsigned, aligned)
    keydir = ROOT / ".signing"
    keydir.mkdir(mode=0o700, exist_ok=True)
    key = keydir / "catcanvas.keystore"
    if not key.exists():
        run("keytool", "-genkeypair", "-keystore", key, "-storepass", "android", "-keypass", "android", "-alias", "catcanvas", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=CatCanvas Local Launcher")
    final = ROOT / "猫画布启动器.apk"
    candidate = BUILD / "signed.apk"
    run("apksigner", "sign", "--ks", key, "--ks-key-alias", "catcanvas", "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", candidate, aligned)
    run("apksigner", "verify", "--verbose", candidate)
    os.replace(candidate, final)
    digest = hashlib.sha256(final.read_bytes()).hexdigest()
    (ROOT / "SHA256SUMS.txt").write_text(digest + "  " + final.name + "\n", encoding="utf-8")
    print("APK:", final, "bytes=", final.stat().st_size, "sha256=", digest)


if __name__ == "__main__":
    main()