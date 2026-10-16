"""Mocked Extraction Agent output, standing in for the real Extraction Agent
until it's built. Matches the input contract in docs/modeling-agent-spec.md.
"""
from schemas import Curve, ExtractionOutput, GridDetected, Quantity, Sketch


def mock_loop_scenario() -> ExtractionOutput:
    """A looping ramp with a gap to clear, speed and car spoken, scale drawn."""
    return ExtractionOutput(
        sketch=Sketch(
            curves=[
                Curve(
                    id="c1",  # the ramp: climbs steeply (loop-like), drawn base→exit
                    points_px=[
                        [40, 320],
                        [90, 300],
                        [130, 250],
                        [160, 180],
                        [170, 120],
                        [150, 70],
                        [100, 40],
                    ],
                ),
                Curve(
                    id="c2",  # ground beyond a gap, roughly flat
                    points_px=[[400, 330], [520, 330], [640, 330]],
                ),
            ],
            grid_detected=GridDetected(present=True, spacing_px=42),
            labels_text=["each square is 2 meters"],
        ),
        voice_transcript=(
            "the car races up this loop and flies over the trucks "
            "at about 60 miles an hour"
        ),
        mentioned_entities=["Tesla Roadster", "trucks"],
        mentioned_quantities=[Quantity(text="60 miles an hour", value=60, unit="mph")],
    )


def mock_sparse_scenario() -> ExtractionOutput:
    """Minimal sketch with nothing spoken — exercises the assumed-default paths."""
    return ExtractionOutput(
        sketch=Sketch(
            curves=[
                Curve(id="c1", points_px=[[0, 200], [50, 150], [100, 80]]),
            ],
            grid_detected=None,
            labels_text=[],
        ),
        voice_transcript="here's a ramp",
        mentioned_entities=[],
        mentioned_quantities=[],
    )
