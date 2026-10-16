"""Hand a capture's extraction to the backend pipeline (Modeling -> Physics) in backend/."""
from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent / "backend"


def run_backend(extraction: dict, orchestrator=None):
    """Convert extraction dict -> backend ExtractionOutput and run Orchestrator.process_capture.

    Pass the same `orchestrator` on later calls to keep its session state (needed for update_speed).
    """
    if str(_BACKEND) not in sys.path:
        sys.path.insert(0, str(_BACKEND))
    from orchestrator import Orchestrator
    from schemas import Curve, ExtractionOutput, GridDetected, Quantity, Sketch

    sketch = extraction["sketch"]
    grid = sketch.get("grid_detected")
    output = ExtractionOutput(
        sketch=Sketch(
            curves=[Curve(id=c["id"], points_px=c["points_px"]) for c in sketch["curves"]],
            grid_detected=GridDetected(**grid) if grid else None,
            labels_text=sketch.get("labels_text", []),
        ),
        voice_transcript=extraction["voice_transcript"],
        mentioned_entities=extraction.get("mentioned_entities", []),
        mentioned_quantities=[Quantity(**q) for q in extraction.get("mentioned_quantities", [])],
    )
    orchestrator = orchestrator or Orchestrator()
    return orchestrator, orchestrator.process_capture(output)
