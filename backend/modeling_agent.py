"""Modeling Agent — turns raw Extraction Agent output into the well-posed
problem spec the Physics Agent expects.

See docs/modeling-agent-spec.md for the full contract. An LLM call
(llm_client.py, mirrors capture/respond.py's Anthropic/Bedrock dual path)
now does the two judgment-heavy steps: classifying which curve is the ramp
vs. the ground, and tagging each spoken/written quantity with what it
refers to (entry speed, car mass, downforce, or other) -- this is what lets
a spoken "the car weighs 1500 kg" actually reach the problem spec instead
of being silently dropped. Everything else (unit conversion, pixel->meter
math, the cache/memory/anchorbrowser/default fallback order) stays plain
deterministic code. If the LLM is unavailable or fails, every step falls
back to the original heuristics -- this never blocks on it. No SurrealDB
(abandoned for this hackathon; memory recall still accepts a plain dict for
whatever persistence is added later).
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import asdict
from typing import Optional

from car_spec_lookup import CarSpecLookup
from llm_client import call_text, extract_json
from tracing import traced
from schemas import (
    Curve,
    ExtractionOutput,
    GroundProfile,
    ModelingError,
    ModelingResult,
    ProblemSpec,
    RampPoint,
)

FORMULATE_SYSTEM_PROMPT = """You help formulate a physical problem from a sketch extraction. You get a list of
hand-drawn curves (each a list of pixel points, no semantic label), any detected grid, handwritten labels, the
voice transcript, named entities, and quantities mentioned (value + unit).

Reply with ONE JSON object and nothing else:
{
  "ramp_curve_id": "<id of the curve that is the ramp/road the car travels on, or null if none>",
  "ground_curve_id": "<id of the curve that is the ground/landing surface beyond the ramp, or null if there is none drawn>",
  "quantity_roles": [{"text": "<exact text from mentioned_quantities>", "role": "entry_speed" | "car_mass" | "downforce" | "other"}]
}

Rules:
- ramp_curve_id: the curve the car drives up/along before any jump. Usually the one with the most vertical extent,
  but use the drawing and transcript together -- a loop, ramp, or incline the user describes the car moving on.
- ground_curve_id: a separate curve representing where the car lands (flat ground, far side of a gap, lower
  level). null if no such curve is drawn (assume flat ground at the ramp's base level).
- quantity_roles: label every quantity in mentioned_quantities exactly once. "entry_speed" is how fast the car is
  going. "car_mass" is the car's weight/mass. "downforce" is a stated downforce/traction force in Newtons.
  Anything else (lengths, angles, unrelated numbers) is "other".
- If you are not confident about a curve's role, return null rather than guessing.
"""

# ---- POC defaults (assumed when nothing better is available) ---------------
# These stand in for "assumed_default" sourcing per the spec. They are not
# meant to be realistic in every case — just unblocking.
DEFAULT_SCALE_M_PER_PX = 0.05       # ~20px per meter
DEFAULT_ENTRY_SPEED_MS = 15.0       # ~34 mph
DEFAULT_MASS_KG = 1300.0            # generic sports car
DEFAULT_DOWNFORCE_N = 3000.0

# Pre-cached specs for entities we expect to show up live during the demo,
# so the slow (~30-45s) anchorbrowser lookup never has to run on stage.
# Keyed by lowercase substring match against mentioned_entities. Live
# lookup (car_spec_lookup.py) still runs for anything not listed here.
KNOWN_SPECS: dict[str, dict[str, float]] = {
    "tesla roadster": {"mass_kg": 1300.0, "downforce_capability_n": 9000.0},
    # 992-generation Carrera, approx. DIN curb weight. downforce_capability_n
    # isn't a published spec for this car -- reuses the generic POC default.
    "porsche 911": {"mass_kg": 1430.0, "downforce_capability_n": DEFAULT_DOWNFORCE_N},
}

SPEED_UNIT_TO_MS = {
    "mph": 0.44704,
    "mi/h": 0.44704,
    "km/h": 1 / 3.6,
    "kmh": 1 / 3.6,
    "m/s": 1.0,
    "ms": 1.0,
}

MASS_UNIT_TO_KG = {
    "kg": 1.0,
    "kilogram": 1.0,
    "kilograms": 1.0,
    "lb": 0.453592,
    "lbs": 0.453592,
    "pound": 0.453592,
    "pounds": 0.453592,
}

DOWNFORCE_UNIT_TO_N = {
    "n": 1.0,
    "newton": 1.0,
    "newtons": 1.0,
}

GAP_EPSILON_M = 0.3   # min horizontal separation to call it a "gap"
LEVEL_EPSILON_M = 0.3  # min vertical offset to call it "lower_level"


class ModelingAgent:
    def __init__(self, car_spec_lookup: Optional[CarSpecLookup] = None):
        self.car_spec_lookup = car_spec_lookup or CarSpecLookup()

    @traced("Modeling Agent", "AGENT", inputs=("extraction", "memory"),
            attributes={"implementation": "deterministic_heuristics"})
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

        formulation = self._llm_formulate(extraction)
        scale, scale_source = self._resolve_scale(extraction)
        ramp_px, ground_px = self._apply_formulation_or_classify(
            extraction.sketch.curves, formulation
        )

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
        mass_kg, mass_source = self._resolve_mass_kg(
            extraction.mentioned_entities, memory, formulation, extraction.mentioned_quantities
        )
        downforce_n, downforce_source = self._resolve_downforce_n(
            extraction.mentioned_entities, memory, formulation, extraction.mentioned_quantities
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

    @traced("Resolve scale", "CHAIN", inputs=("extraction",))
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

    # ---- LLM-backed problem formulation ----------------------------------

    @traced("Formulate problem (LLM)", "TOOL", inputs=("extraction",))
    def _llm_formulate(self, extraction: ExtractionOutput) -> Optional[dict]:
        """Classifies ramp vs. ground curve and tags each quantity's role.
        Returns None on any failure -- no credentials, bad response -- and
        every caller below falls back to its own heuristic unchanged."""
        user_text = json.dumps({
            "curves": [{"id": c.id, "points_px": c.points_px} for c in extraction.sketch.curves],
            "grid_detected": asdict(extraction.sketch.grid_detected)
            if extraction.sketch.grid_detected
            else None,
            "labels_text": extraction.sketch.labels_text,
            "voice_transcript": extraction.voice_transcript,
            "mentioned_entities": extraction.mentioned_entities,
            "mentioned_quantities": [
                {"text": q.text, "value": q.value, "unit": q.unit}
                for q in extraction.mentioned_quantities
            ],
        })
        reply = call_text(FORMULATE_SYSTEM_PROMPT, user_text, max_tokens=500)
        return extract_json(reply)

    def _apply_formulation_or_classify(
        self, curves: list[Curve], formulation: Optional[dict]
    ) -> tuple[Optional[Curve], Optional[Curve]]:
        by_id = {c.id: c for c in curves}
        ramp_id = formulation.get("ramp_curve_id") if formulation else None
        if ramp_id in by_id:
            ramp = by_id[ramp_id]
            if formulation is not None and "ground_curve_id" in formulation:
                ground_id = formulation["ground_curve_id"]
                return ramp, by_id.get(ground_id) if ground_id else None
            remaining = [c for c in curves if c.id != ramp.id]
            ground = min(remaining, key=self._vertical_extent) if remaining else None
            return ramp, ground
        return self._classify_curves(curves)

    # ---- curve classification (fallback when the LLM is unavailable) ----

    @staticmethod
    def _vertical_extent(curve: Curve) -> float:
        ys = [p[1] for p in curve.points_px]
        return max(ys) - min(ys)

    @traced("Classify ramp and ground (heuristic)", "CHAIN", inputs=("curves",))
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

    @traced("Build ground profile", "CHAIN", inputs=("ground_px", "ramp_exit_m", "base_px", "scale"))
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

    @staticmethod
    def _spoken_value(
        formulation: Optional[dict], quantities, role: str, unit_table: dict[str, float]
    ) -> Optional[float]:
        """A quantity the LLM tagged with `role`, converted via `unit_table`.
        None if there's no formulation, nothing tagged with that role, or
        the tagged quantity's unit isn't one we know how to convert."""
        if not formulation:
            return None
        tagged_texts = {
            r["text"] for r in (formulation.get("quantity_roles") or []) if r.get("role") == role
        }
        for q in quantities:
            if q.text in tagged_texts:
                unit = q.unit.lower().strip()
                if unit in unit_table:
                    return q.value * unit_table[unit]
        return None

    @staticmethod
    def _first_unit_match(quantities, unit_table: dict[str, float]) -> Optional[float]:
        """Weak fallback used only when the LLM is unavailable: the first
        quantity whose unit matches, with no role disambiguation."""
        for q in quantities:
            unit = q.unit.lower().strip()
            if unit in unit_table:
                return q.value * unit_table[unit]
        return None

    @traced("Resolve car mass", "CHAIN", inputs=("entities", "memory", "formulation"))
    def _resolve_mass_kg(
        self,
        entities: list[str],
        memory: Optional[dict[str, float]],
        formulation: Optional[dict],
        quantities,
    ) -> tuple[float, str]:
        spoken = self._spoken_value(formulation, quantities, "car_mass", MASS_UNIT_TO_KG)
        if spoken is not None:
            return spoken, "spoken"
        if formulation is None:
            # No LLM available to disambiguate -- still don't drop an
            # unambiguous kg/lb value outright.
            weak = self._first_unit_match(quantities, MASS_UNIT_TO_KG)
            if weak is not None:
                return weak, "spoken (unit-matched, no LLM confirmation)"

        for entity in entities:
            key = entity.lower().strip()
            for known_key, spec in KNOWN_SPECS.items():
                if known_key in key:
                    return spec["mass_kg"], "looked_up:local_spec_db"
        if memory and "car_mass_kg" in memory:
            return memory["car_mass_kg"], "memory_recall"

        # Not cached and not recalled from memory: try a live lookup.
        # Gracefully returns (None, None) if unconfigured/unavailable/failed.
        if entities:
            mass_kg, source_url = self.car_spec_lookup.lookup_mass_kg(entities[0])
            if mass_kg:
                source = (
                    f"looked_up:anchorbrowser({source_url})"
                    if source_url
                    else "looked_up:anchorbrowser"
                )
                return mass_kg, source

        return DEFAULT_MASS_KG, "assumed_default"

    @traced("Resolve downforce capability", "CHAIN", inputs=("entities", "memory", "formulation"))
    def _resolve_downforce_n(
        self,
        entities: list[str],
        memory: Optional[dict[str, float]],
        formulation: Optional[dict],
        quantities,
    ) -> tuple[float, str]:
        spoken = self._spoken_value(formulation, quantities, "downforce", DOWNFORCE_UNIT_TO_N)
        if spoken is not None:
            return spoken, "spoken"

        for entity in entities:
            key = entity.lower().strip()
            for known_key, spec in KNOWN_SPECS.items():
                if known_key in key:
                    return spec["downforce_capability_n"], "looked_up:local_spec_db"
        if memory and "downforce_capability_n" in memory:
            return memory["downforce_capability_n"], "memory_recall"

        # downforce_capability_n isn't a standard published spec -- no live
        # lookup for it, see car_spec_lookup.py.
        return DEFAULT_DOWNFORCE_N, "assumed_default"
