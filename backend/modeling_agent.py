"""Modeling Agent — turns raw Extraction Agent output into the well-posed
problem spec the Physics Agent expects.

See docs/modeling-agent-spec.md for the full contract. This is the POC
implementation: deterministic heuristics for every step (scale resolution,
curve classification, ground-profile derivation, speed/mass/downforce
resolution). No LLM call yet and no anchorbrowser/SurrealDB — those are
extension points, called out explicitly below, not silently skipped.
"""
from __future__ import annotations

import math
import re
from typing import Optional

from schemas import (
    Curve,
    ExtractionOutput,
    GroundProfile,
    ModelingError,
    ModelingResult,
    ProblemSpec,
    RampPoint,
)

# ---- POC defaults (assumed when nothing better is available) ---------------
# These stand in for "assumed_default" sourcing per the spec. They are not
# meant to be realistic in every case — just unblocking.
DEFAULT_SCALE_M_PER_PX = 0.05       # ~20px per meter
DEFAULT_ENTRY_SPEED_MS = 15.0       # ~34 mph
DEFAULT_MASS_KG = 1300.0            # generic sports car
DEFAULT_DOWNFORCE_N = 3000.0

# Stand-in for an anchorbrowser lookup / real spec DB. Keyed by lowercase
# substring match against mentioned_entities.
KNOWN_SPECS: dict[str, dict[str, float]] = {
    "tesla roadster": {"mass_kg": 1300.0, "downforce_capability_n": 9000.0},
}

SPEED_UNIT_TO_MS = {
    "mph": 0.44704,
    "mi/h": 0.44704,
    "km/h": 1 / 3.6,
    "kmh": 1 / 3.6,
    "m/s": 1.0,
    "ms": 1.0,
}

GAP_EPSILON_M = 0.3   # min horizontal separation to call it a "gap"
LEVEL_EPSILON_M = 0.3  # min vertical offset to call it "lower_level"


class ModelingAgent:
    def run(
        self,
        extraction: ExtractionOutput,
        memory: Optional[dict[str, float]] = None,
    ) -> ModelingResult:
        if not extraction.sketch.curves:
            return ModelingResult(
                status="error",
                error=ModelingError(
                    code="insufficient_input",
                    message="No curves detected in the sketch.",
                ),
            )

        scale, scale_source = self._resolve_scale(extraction)
        ramp_px, ground_px = self._classify_curves(extraction.sketch.curves)

        if ramp_px is None or len(ramp_px.points_px) < 2:
            return ModelingResult(
                status="error",
                error=ModelingError(
                    code="insufficient_input",
                    message="No ramp-like curve with at least 2 points detected.",
                ),
            )

        base_px = ramp_px.points_px[0]
        ramp_curve_m = [
            self._to_meters(p, base_px, scale) for p in ramp_px.points_px
        ]
        ground_profile, ground_source = self._build_ground_profile(
            ground_px, ramp_curve_m[-1], base_px, scale
        )

        entry_speed_ms, speed_source = self._resolve_entry_speed(
            extraction.mentioned_quantities
        )
        mass_kg, mass_source, downforce_n, downforce_source = self._resolve_car_specs(
            extraction.mentioned_entities, memory
        )

        problem_spec = ProblemSpec(
            ramp_curve_m=[RampPoint(x=p[0], y=p[1]) for p in ramp_curve_m],
            entry_speed_ms=entry_speed_ms,
            car_mass_kg=mass_kg,
            downforce_capability_n=downforce_n,
            ground_profile=ground_profile,
        )
        sources = {
            "ramp_curve_m": f"drawn (scale: {scale_source})",
            "entry_speed_ms": speed_source,
            "car_mass_kg": mass_source,
            "downforce_capability_n": downforce_source,
            "ground_profile": ground_source,
        }
        return ModelingResult(status="ok", problem_spec=problem_spec, sources=sources)

    # ---- scale resolution ----------------------------------------------

    def _resolve_scale(self, extraction: ExtractionOutput) -> tuple[float, str]:
        grid = extraction.sketch.grid_detected
        legend_m = self._parse_legend_meters(
            extraction.sketch.labels_text + [extraction.voice_transcript]
        )
        if grid and grid.present and grid.spacing_px and legend_m:
            return legend_m / grid.spacing_px, "drawn+spoken legend"
        return DEFAULT_SCALE_M_PER_PX, "assumed_default"

    @staticmethod
    def _parse_legend_meters(texts: list[str]) -> Optional[float]:
        pattern = re.compile(
            r"square[^0-9]{0,10}(\d+(?:\.\d+)?)\s*(m|meter|meters)\b", re.IGNORECASE
        )
        for text in texts:
            match = pattern.search(text)
            if match:
                return float(match.group(1))
        return None

    # ---- curve classification -------------------------------------------

    @staticmethod
    def _vertical_extent(curve: Curve) -> float:
        ys = [p[1] for p in curve.points_px]
        return max(ys) - min(ys)

    def _classify_curves(
        self, curves: list[Curve]
    ) -> tuple[Optional[Curve], Optional[Curve]]:
        if not curves:
            return None, None
        ramp = max(curves, key=self._vertical_extent)
        remaining = [c for c in curves if c.id != ramp.id]
        if not remaining:
            return ramp, None
        ground = min(remaining, key=self._vertical_extent)
        return ramp, ground

    # ---- coordinate conversion -------------------------------------------

    @staticmethod
    def _to_meters(
        point_px: list[float], base_px: list[float], scale: float
    ) -> tuple[float, float]:
        x_m = (point_px[0] - base_px[0]) * scale
        y_m = (base_px[1] - point_px[1]) * scale  # image y grows downward
        return (x_m, y_m)

    # ---- ground profile ---------------------------------------------------

    def _build_ground_profile(
        self,
        ground_px: Optional[Curve],
        ramp_exit_m: tuple[float, float],
        base_px: list[float],
        scale: float,
    ) -> tuple[GroundProfile, str]:
        if ground_px is None:
            return (
                GroundProfile(type="flat", landing_level_m=0.0),
                "assumed_default",
            )

        ground_points_m = [self._to_meters(p, base_px, scale) for p in ground_px.points_px]
        ground_start_m = ground_points_m[0]
        landing_level_m = sum(p[1] for p in ground_points_m) / len(ground_points_m)

        horizontal_gap = ground_start_m[0] - ramp_exit_m[0]
        if horizontal_gap > GAP_EPSILON_M:
            return (
                GroundProfile(
                    type="gap",
                    landing_level_m=landing_level_m,
                    gap_start_x_m=ramp_exit_m[0],
                    gap_end_x_m=ground_start_m[0],
                ),
                "drawn",
            )
        if abs(landing_level_m) > LEVEL_EPSILON_M:
            return (
                GroundProfile(type="lower_level", landing_level_m=landing_level_m),
                "drawn",
            )
        return GroundProfile(type="flat", landing_level_m=landing_level_m), "drawn"

    # ---- speed / mass / downforce -----------------------------------------

    def _resolve_entry_speed(self, quantities) -> tuple[float, str]:
        for q in quantities:
            unit = q.unit.lower().replace(" ", "")
            if unit in SPEED_UNIT_TO_MS:
                return q.value * SPEED_UNIT_TO_MS[unit], "spoken"
        return DEFAULT_ENTRY_SPEED_MS, "assumed_default"

    def _resolve_car_specs(
        self, entities: list[str], memory: Optional[dict[str, float]]
    ) -> tuple[float, str, float, str]:
        for entity in entities:
            key = entity.lower().strip()
            for known_key, spec in KNOWN_SPECS.items():
                if known_key in key:
                    return (
                        spec["mass_kg"],
                        "looked_up:local_spec_db",
                        spec["downforce_capability_n"],
                        "looked_up:local_spec_db",
                    )
        if memory:
            if "car_mass_kg" in memory and "downforce_capability_n" in memory:
                return (
                    memory["car_mass_kg"],
                    "memory_recall",
                    memory["downforce_capability_n"],
                    "memory_recall",
                )
        return DEFAULT_MASS_KG, "assumed_default", DEFAULT_DOWNFORCE_N, "assumed_default"
