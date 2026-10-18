#!/usr/bin/env python3
"""Compose the design side-by-sides in docs/design/screens/.

Each image puts a Claude Design frame (left) next to the app's E2E
screenshot of the same state (right), both 1440x900, under a caption.

    python3 docs/design/compose-screens.py \
        --app apps/desktop/e2e-results \
        [--design <folder with populated-dark.png, ...>] \
        [--state populated] [--state empty]

App screenshots come from `xvfb-run -a pnpm e2e`:
  - populated: `m3-populated-<theme>.png` (crossfilter.spec.ts: line, bars
    with a selection, histogram with a brush, on the 1M-row trips fixture);
  - empty: `main-empty-<theme>.png` (count-rows.spec.ts).

Design frames: rendered from the gitignored /design export (each
`[data-screen-label]` frame of Glassgrid.dc.html screenshotted at 1440x900 in
Chromium, saved as `<state>-<theme>.png`) and passed with --design. Without
--design, the left half of the existing side-by-side is reused: the design
frames do not change, only the app side does.

Needs Pillow.
"""

import argparse
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1440, 900
GAP, HEAD = 32, 56
BACKGROUND = (42, 47, 54)
CAPTION = (231, 234, 238)
LETTERS = {"populated": "A", "empty": "B"}
APP_FILES = {"populated": "m3-populated-{theme}.png", "empty": "main-empty-{theme}.png"}
APP_CAPTIONS = {
    "populated": "Glassgrid (Electron, 1M-row trips fixture)",
    "empty": "Glassgrid (Electron)",
}


def design_frame(state, theme, design_dir, screens_dir):
    if design_dir:
        frame = Image.open(os.path.join(design_dir, f"{state}-{theme}.png")).convert("RGB")
    else:
        existing = os.path.join(screens_dir, f"{LETTERS[state]}-{state}-{theme}.png")
        frame = Image.open(existing).convert("RGB").crop((GAP, HEAD, GAP + W, HEAD + H))
    if frame.size != (W, H):
        sys.exit(f"design frame {state}-{theme} is {frame.size}, expected {(W, H)}")
    return frame


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", required=True, help="folder with the E2E screenshots (apps/desktop/e2e-results)")
    parser.add_argument("--design", help="folder with rendered design frames (<state>-<theme>.png)")
    parser.add_argument("--state", action="append", choices=sorted(LETTERS), help="states to compose (default: populated)")
    parser.add_argument("--out", default=os.path.join(here, "screens"))
    args = parser.parse_args()

    font = ImageFont.load_default(size=26)
    for state in args.state or ["populated"]:
        letter = LETTERS[state]
        for theme in ["dark", "light"]:
            left = design_frame(state, theme, args.design, args.out)
            right = Image.open(os.path.join(args.app, APP_FILES[state].format(theme=theme))).convert("RGB")
            if right.size != (W, H):
                sys.exit(f"app screenshot {state}-{theme} is {right.size}, expected {(W, H)}")
            out = Image.new("RGB", (W * 2 + GAP * 3, H + HEAD + GAP), BACKGROUND)
            draw = ImageDraw.Draw(out)
            draw.text((GAP, 14), f"{letter} · {state} · {theme} · Claude Design frame", fill=CAPTION, font=font)
            draw.text((GAP * 2 + W, 14), f"{letter} · {state} · {theme} · {APP_CAPTIONS[state]}", fill=CAPTION, font=font)
            out.paste(left, (GAP, HEAD))
            out.paste(right, (GAP * 2 + W, HEAD))
            path = os.path.join(args.out, f"{letter}-{state}-{theme}.png")
            out.save(path, optimize=True)
            print(path)


if __name__ == "__main__":
    main()
