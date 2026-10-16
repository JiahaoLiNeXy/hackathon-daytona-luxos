"""Show a line of text on the overlay, over the FaceTime window.

Writes overlay/response.html. Run the overlay on that file once, and it reloads each time this
script updates the text:

    python overlay/overlay.py overlay/response.html

Usage:
    python overlay/show_text.py "I see you drew a flying car, ready to play!"
    python overlay/show_text.py --clear
"""
from __future__ import annotations

import argparse
import html
import os
from pathlib import Path

RESPONSE_PAGE = Path(__file__).resolve().parent / "response.html"

PAGE = """<!doctype html>
<meta charset="utf-8">
<title>LuxOS response</title>
<style>
  html, body {{ margin: 0; height: 100%; background: transparent; overflow: hidden; }}
  .wrap {{ position: absolute; left: 0; right: 0; bottom: 8%; display: flex; justify-content: center; padding: 0 5%; }}
  .line {{
    max-width: 90%; padding: .6em 1em; border-radius: 16px;
    background: rgba(0, 0, 0, .6); color: #fff;
    font: 600 clamp(20px, 3.2vw, 44px)/1.25 -apple-system, BlinkMacSystemFont, sans-serif;
    text-align: center; text-shadow: 0 2px 6px rgba(0, 0, 0, .5);
  }}
</style>
<div class="wrap"><div class="line">{text}</div></div>
"""


def write_text(text: str) -> None:
    body = html.escape(text.strip())
    # Write to a temp file, then swap it in, so the overlay never reads a half-written page.
    tmp = RESPONSE_PAGE.with_suffix(".tmp")
    tmp.write_text(PAGE.format(text=body))
    os.replace(tmp, RESPONSE_PAGE)


def main() -> None:
    parser = argparse.ArgumentParser(description="Show response text on the LuxOS overlay")
    parser.add_argument("text", nargs="?", help="text to show")
    parser.add_argument("--clear", action="store_true", help="show an empty page")
    args = parser.parse_args()

    if args.clear:
        write_text("")
    elif args.text:
        write_text(args.text)
    else:
        parser.error("give text to show, or --clear")
    print(f"Updated {RESPONSE_PAGE}")


if __name__ == "__main__":
    main()
