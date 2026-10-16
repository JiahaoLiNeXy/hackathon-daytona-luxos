"""Data shapes shared across the pipeline, matching docs/modeling-agent-spec.md
and docs/physics-agent-spec.md. Plain dataclasses, no external dependencies.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Literal, Optional


# ---- Extraction Agent output (input to Modeling Agent) ----------------------

@dataclass
class Curve:
    id: str
    points_px: list[list[float]]


@dataclass
class GridDetected:
    present: bool
    spacing_px: Optional[float] = None


@dataclass
class Quantity:
    text: str
    value: float
    unit: str


@dataclass
class Sketch:
    curves: list[Curve]
    grid_detected: Optional[GridDetected]
    labels_text: list[str] = field(default_factory=list)


@dataclass
class ExtractionOutput:
    sketch: Sketch
    voice_transcript: str
    mentioned_entities: list[str] = field(default_factory=list)
    mentioned_quantities: list[Quantity] = field(default_factory=list)


# ---- Modeling Agent output == Physics Agent input ---------------------------

@dataclass
class RampPoint:
    x: float
    y: float


@dataclass
class GroundProfile:
    type: Literal["flat", "gap", "lower_level"]
    landing_level_m: float
    gap_start_x_m: Optional[float] = None
    gap_end_x_m: Optional[float] = None


@dataclass
class ProblemSpec:
    ramp_curve_m: list[RampPoint]
    entry_speed_ms: float
    car_mass_kg: float
    downforce_capability_n: float
    ground_profile: GroundProfile

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ModelingError:
    code: str
    message: str


@dataclass
class ModelingResult:
    status: Literal["ok", "error"]
    problem_spec: Optional[ProblemSpec] = None
    sources: Optional[dict[str, str]] = None
    error: Optional[ModelingError] = None

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "problem_spec": self.problem_spec.to_dict() if self.problem_spec else None,
            "sources": self.sources,
            "error": asdict(self.error) if self.error else None,
        }
