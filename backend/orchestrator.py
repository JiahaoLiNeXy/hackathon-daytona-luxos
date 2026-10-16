"""Minimal V0 orchestrator — see docs/orchestrator-spec.md.

Extraction Agent isn't built yet, so `process_capture` takes a pre-built
ExtractionOutput directly instead of a photo/voice pair. That's the one
documented gap left in the chain; Modeling and Physics are both real now.
"""
from __future__ import annotations

from typing import Optional

from modeling_agent import ModelingAgent
from physics_agent import PhysicsAgent
from schemas import ExtractionOutput, ModelingResult, PhysicsError, PhysicsResult, ProblemSpec


class CaptureResult:
    def __init__(self, modeling: ModelingResult, physics: Optional[PhysicsResult]):
        self.modeling = modeling
        self.physics = physics

    def to_dict(self) -> dict:
        return {
            "modeling": self.modeling.to_dict(),
            "physics": self.physics.to_dict() if self.physics else None,
        }


class Orchestrator:
    def __init__(self):
        self.modeling_agent = ModelingAgent()
        self.physics_agent = PhysicsAgent()
        # V0 in-memory state, single session (see docs/orchestrator-spec.md)
        self.problem_spec = None
        self.sources = None
        self.last_result = None

    def process_capture(
        self, extraction: ExtractionOutput, memory: Optional[dict] = None
    ) -> CaptureResult:
        """Full-chain trigger, mocking the Extraction stage for now."""
        modeling_result = self.modeling_agent.run(extraction, memory=memory)
        if modeling_result.status != "ok":
            return CaptureResult(modeling=modeling_result, physics=None)

        self.problem_spec = modeling_result.problem_spec
        self.sources = modeling_result.sources

        physics_result = self.physics_agent.run(modeling_result.problem_spec)
        self.last_result = physics_result
        return CaptureResult(modeling=modeling_result, physics=physics_result)

    def update_speed(self, new_speed_ms: float) -> PhysicsResult:
        """Fast path: re-run only the Physics Agent (see orchestrator-spec.md
        for why Extraction/Modeling are never re-triggered here)."""
        if self.problem_spec is None:
            return PhysicsResult(
                status="error",
                error=PhysicsError(code="invalid_input", message="no scenario loaded yet"),
            )
        patched_spec = ProblemSpec(
            ramp_curve_m=self.problem_spec.ramp_curve_m,
            entry_speed_ms=new_speed_ms,
            car_mass_kg=self.problem_spec.car_mass_kg,
            downforce_capability_n=self.problem_spec.downforce_capability_n,
            ground_profile=self.problem_spec.ground_profile,
        )
        physics_result = self.physics_agent.run(patched_spec)
        self.last_result = physics_result
        return physics_result
