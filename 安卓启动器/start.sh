#!/data/data/com.termux/files/usr/bin/bash
export PATH="/data/data/com.termux/files/usr/bin:/system/bin:/system/xbin"
export LANG="C.UTF-8"
export PYTHONDONTWRITEBYTECODE=1
export CATCANVAS_PROJECT="/storage/emulated/0/互动对话项目/猫画布"
exec /data/data/com.termux/files/usr/bin/python -u /data/data/com.termux/files/home/.termux/catcanvas/launch.py "$@"
