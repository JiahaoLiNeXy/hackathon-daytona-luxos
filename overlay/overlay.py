"""LuxOS screen overlay: shows a rendering on top of the FaceTime window (your drawing) to project the result.

A transparent, borderless, always-on-top, click-through window that sits exactly over the FaceTime window and
follows it if it moves. It shows any file you give it and reloads automatically when that file changes.

Usage:
    python overlay/overlay.py render.html                 # HTML / canvas page (transparent background)
    python overlay/overlay.py result.png                  # png/jpg/gif/svg/webp/mp4/webm are wrapped for you
    python overlay/overlay.py render.html --app FaceTime  # window to cover (default FaceTime)
    python overlay/overlay.py render.html --fullscreen    # cover the whole main display instead
    python overlay/overlay.py render.html --interactive   # let the mouse reach the page (e.g. a speed slider)
"""
from __future__ import annotations

import argparse
import html
import tempfile
import threading
import time
from pathlib import Path

import Quartz
import webview

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"}
VIDEO_EXT = {".mp4", ".webm", ".mov"}
STATUS_WINDOW_LEVEL = 25  # NSStatusWindowLevel: above normal windows and FaceTime's full screen


def find_window_rect(app_name: str) -> tuple[int, int, int, int] | None:
    """(x, y, w, h) in screen points of the largest on-screen window owned by app_name, else None."""
    best = None
    windows = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID,
    )
    for w in windows or []:
        if w.get("kCGWindowOwnerName") != app_name or w.get("kCGWindowLayer") != 0:
            continue
        b = w["kCGWindowBounds"]
        rect = (int(b["X"]), int(b["Y"]), int(b["Width"]), int(b["Height"]))
        if rect[2] > 100 and rect[3] > 100 and (best is None or rect[2] * rect[3] > best[2] * best[3]):
            best = rect
    return best


def main_screen_rect() -> tuple[int, int, int, int]:
    screen = webview.screens[0]
    return 0, 0, screen.width, screen.height


def page_for(path: Path, wrap_dir: Path) -> str:
    """URL to load. HTML is loaded as is; images and video get a transparent wrapper page."""
    ext = path.suffix.lower()
    if ext in IMAGE_EXT:
        tag = f'<img src="{html.escape(path.as_uri())}">'
    elif ext in VIDEO_EXT:
        tag = f'<video src="{html.escape(path.as_uri())}" autoplay loop muted playsinline></video>'
    else:
        return path.as_uri()
    wrapper = wrap_dir / "wrapper.html"
    wrapper.write_text(
        "<!doctype html><meta charset=utf-8><style>html,body{margin:0;height:100%;background:transparent}"
        "img,video{width:100%;height:100%;object-fit:contain}</style>" + tag
    )
    return wrapper.as_uri()


def configure_native(window: webview.Window, interactive: bool) -> None:
    """Make the window float over everything, appear on every Space, and ignore the mouse."""
    from AppKit import (
        NSWindowCollectionBehaviorCanJoinAllSpaces,
        NSWindowCollectionBehaviorFullScreenAuxiliary,
        NSColor,
    )
    from PyObjCTools import AppHelper

    def apply():
        ns = window.native
        ns.setLevel_(STATUS_WINDOW_LEVEL)
        ns.setCollectionBehavior_(
            NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary
        )
        ns.setOpaque_(False)
        ns.setBackgroundColor_(NSColor.clearColor())
        ns.setHasShadow_(False)
        ns.setIgnoresMouseEvents_(not interactive)

    AppHelper.callAfter(apply)


def supervise(window, path: Path, wrap_dir: Path, app: str | None, interactive: bool) -> None:
    """Background loop: reload on file change, and keep the window glued to the target app's window."""
    configure_native(window, interactive)
    last_mtime = path.stat().st_mtime if path.exists() else 0.0
    last_rect = None
    while True:
        time.sleep(0.4)
        try:
            mtime = path.stat().st_mtime
            if mtime != last_mtime:
                last_mtime = mtime
                window.load_url(page_for(path, wrap_dir))
                print(f"Reloaded {path.name}")
        except FileNotFoundError:
            pass
        if app:
            rect = find_window_rect(app)
            if rect and rect != last_rect:
                x, y, w, h = rect
                window.resize(w, h)
                window.move(x, y)
                last_rect = rect
            if rect is None and last_rect is not None:
                window.hide()  # target closed or minimised
                last_rect = None
            elif rect is not None:
                window.show()


def main() -> None:
    parser = argparse.ArgumentParser(description="LuxOS screen overlay")
    parser.add_argument("file", type=Path, help="html, image, gif or video to display")
    parser.add_argument("--app", default="FaceTime", help="app whose window to cover (default FaceTime)")
    parser.add_argument("--fullscreen", action="store_true", help="cover the whole main display")
    parser.add_argument("--interactive", action="store_true", help="let the mouse reach the page")
    args = parser.parse_args()

    path = args.file.resolve()
    if not path.exists():
        raise SystemExit(f"{path} not found")

    app = None if args.fullscreen else args.app
    rect = None if args.fullscreen else find_window_rect(args.app)
    if app and rect is None:
        print(f"No visible '{args.app}' window yet; covering the screen until it appears.")
    x, y, w, h = rect or main_screen_rect()

    wrap_dir = Path(tempfile.mkdtemp(prefix="luxos_overlay_"))
    window = webview.create_window(
        "LuxOS overlay", page_for(path, wrap_dir), x=x, y=y, width=w, height=h,
        frameless=True, transparent=True, on_top=True, easy_drag=False, focus=False,
    )
    webview.start(supervise, (window, path, wrap_dir, app, args.interactive))


if __name__ == "__main__":
    main()
