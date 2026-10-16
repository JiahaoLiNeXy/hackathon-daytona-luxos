"""Extraction stage: turn a LuxInput (camera frame + conversation) into the Extraction Agent output
that backend/modeling_agent.py takes as input (see docs/modeling-agent-spec.md, "Input contract").

Perception only, no physics: Claude (Bedrock) looks at the frame and traces the strokes in pixel
coordinates, reads any grid and handwriting, and pulls entities and numbers out of the transcript.
The result is saved next to the capture as `extraction.json`, and `overlay.jpg` draws the traced
curves on the frame so you can check the tracing by eye.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import boto3
import cv2
import numpy as np

try:
    from .respond import BEDROCK_REGION, VISION_MODEL
except ImportError:  # run as a script
    from respond import BEDROCK_REGION, VISION_MODEL

MAX_SIDE_PX = 1280  # frame is downscaled to this for the model; coordinates are scaled back

SYSTEM_PROMPT = """You are the Extraction stage of a sketch-to-simulation pipeline. You do perception only:
no physics, no interpretation of what the shapes mean. You get a photo of a hand-drawn sketch on paper and
the transcript of what the user said. Reply with ONE JSON object and nothing else:

{
  "curves": [{"id": "c1", "points_px": [[x, y], ...]}],
  "grid_detected": {"present": true, "spacing_px": 42} or null,
  "labels_text": ["handwritten text, verbatim"],
  "mentioned_entities": ["named things the user mentions, e.g. Tesla Roadster, trucks"],
  "mentioned_quantities": [{"text": "60 miles an hour", "value": 60, "unit": "mph"}],
  "user_goal": "the question the user wants answered, in one sentence, e.g. will the car clear the trucks"
}

The drawing and the user's spoken description carry equal weight, and together they frame the problem. Read them
jointly, not separately:
- Use speech to resolve the drawing: which strokes matter ("ignore the scribble in the corner" -> leave it out),
  what a stroke is when the user names it, and which side things are on.
- Use the drawing to resolve speech: "this part" or "over there" points at a stroke or label on the paper.
- Capture every number the user says or writes, not only speeds: lengths, heights, gaps, masses, angles,
  scale legends. Keep the user's words in "text" so a later stage knows what each number refers to.
- If speech and drawing disagree, include both as given and do not pick a winner; add a label noting the conflict.

Rules:
- Coordinates are pixels in the image you were given: origin top-left, x to the right, y downward.
- curves: every distinct hand-drawn stroke (ramps, loops, ground lines, gaps' far side). Ignore grid lines, paper
  edges, shadows, hands, desk. Trace each with 6-14 points that follow its shape, including bends, in the
  direction it was most plausibly drawn (default: left to right, starting at its lower-left end).
  Ids are c1, c2, ... Do not label what a curve is.
- grid_detected: if the paper has a printed grid, the pixel distance between adjacent grid lines; otherwise null.
- labels_text: any handwritten words or numbers on the paper, verbatim, one entry per label. Include scale notes
  such as "each square is 2 meters" if written. Also include a scale legend if the user speaks one.
- mentioned_entities / mentioned_quantities: from the transcript and labels only. Quantities use value + a
  short unit (mph, km/h, m/s, m, kg, deg).
- user_goal: the question or outcome the user is after, from both speech and drawing; "" if none is stated.
- If the paper has no sketch, return "curves": [].
"""


def _json_from_text(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"no JSON in model reply: {text[:200]!r}")
    return json.loads(match.group(0))


def extract(frame: np.ndarray, transcript: str) -> dict:
    """Run the extraction call. Returns a dict shaped like backend ExtractionOutput."""
    h, w = frame.shape[:2]
    scale = min(1.0, MAX_SIDE_PX / max(h, w))
    small = cv2.resize(frame, (round(w * scale), round(h * scale))) if scale < 1 else frame
    jpeg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()
    sh, sw = small.shape[:2]

    client = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
    resp = client.converse(
        modelId=VISION_MODEL,
        system=[{"text": SYSTEM_PROMPT}],
        messages=[{"role": "user", "content": [
            {"image": {"format": "jpeg", "source": {"bytes": jpeg}}},
            {"text": f"Image size: {sw}x{sh} px.\nTranscript: {transcript or '(nothing said)'}"},
        ]}],
        inferenceConfig={"maxTokens": 4000},  # headroom: the model thinks before answering
    )
    text = " ".join(b["text"] for b in resp["output"]["message"]["content"] if "text" in b)
    raw = _json_from_text(text)
    return _clean(raw, transcript, sw, sh, 1 / scale)


def _clean(raw: dict, transcript: str, width: int, height: int, back: float) -> dict:
    """Validate the model's JSON and map coordinates back to the original frame."""
    curves = []
    for i, c in enumerate(raw.get("curves") or [], 1):
        pts = [
            [round(min(max(float(x), 0), width) * back, 1), round(min(max(float(y), 0), height) * back, 1)]
            for x, y in (c.get("points_px") or [])
        ]
        if len(pts) >= 2:
            curves.append({"id": c.get("id") or f"c{i}", "points_px": pts})

    grid = raw.get("grid_detected")
    if grid and grid.get("present") and grid.get("spacing_px"):
        grid = {"present": True, "spacing_px": round(float(grid["spacing_px"]) * back, 1)}
    else:
        grid = None

    quantities = []
    for q in raw.get("mentioned_quantities") or []:
        try:
            quantities.append({"text": str(q["text"]), "value": float(q["value"]), "unit": str(q["unit"])})
        except (KeyError, TypeError, ValueError):
            continue

    return {
        "sketch": {
            "curves": curves,
            "grid_detected": grid,
            "labels_text": [str(t) for t in raw.get("labels_text") or []],
        },
        "voice_transcript": transcript,
        "mentioned_entities": [str(e) for e in raw.get("mentioned_entities") or []],
        "mentioned_quantities": quantities,
        "user_goal": str(raw.get("user_goal") or ""),  # extra field, not part of the backend dataclass yet
    }


def save_overlay(frame: np.ndarray, extraction: dict, path: Path) -> None:
    """Draw the traced curves on the frame so the tracing can be checked by eye."""
    img = frame.copy()
    for i, c in enumerate(extraction["sketch"]["curves"]):
        pts = np.array(c["points_px"], dtype=np.int32)
        color = [(0, 0, 255), (0, 160, 0), (255, 0, 0), (0, 140, 255)][i % 4]
        cv2.polylines(img, [pts], False, color, 3)
        cv2.circle(img, tuple(pts[0]), 8, color, -1)  # start of the curve
        cv2.putText(img, c["id"], tuple(pts[0] + [10, -10]), cv2.FONT_HERSHEY_SIMPLEX, 1, color, 2)
    cv2.imwrite(str(path), img)


def extract_capture(session_dir: Path, frame: np.ndarray, transcript: str) -> dict:
    """Extract, then save `extraction.json` and `overlay.jpg` in the capture folder."""
    extraction = extract(frame, transcript)
    (session_dir / "extraction.json").write_text(json.dumps(extraction, indent=2))
    save_overlay(frame, extraction, session_dir / "overlay.jpg")
    return extraction
