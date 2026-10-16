"""Minimal V0 orchestrator — see docs/orchestrator-spec.md.

Extraction Agent isn't built yet, so `process_capture` takes a pre-built
ExtractionOutput directly instead of a photo/voice pair. Physics Agent isn't
built yet either, so the chain currently stops after Modeling. Both are
documented gaps, not bugs.
"""
from __future__ import annotations

from typing import Optional

from modeling_agent import ModelingAgent
from schemas import ExtractionOutput, ModelingResult


class Orchestrator:
    def __init__(self):
        self.modeling_agent = ModelingAgent()
        # V0 in-memory state, single session (see docs/orchestrator-spec.md)
        self.problem_spec = None
        self.sources = None

    def process_capture(
        self, extraction: ExtractionOutput, memory: Optional[dict] = None
    ) -> ModelingResult:
        """Full-chain trigger, mocking the Extraction stage for now."""
        modeling_result = self.modeling_agent.run(extraction, memory=memory)
        if modeling_result.status == "ok":
            self.problem_spec = modeling_result.problem_spec
            self.sources = modeling_result.sources
        # TODO once Physics Agent exists: call it with modeling_result.problem_spec
        # here and return its output alongside problem_spec/sources.
        return modeling_result
