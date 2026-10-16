"""Integration checks for trace structure using real local solver execution."""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

import tracing
from car_spec_lookup import CarSpecLookup
from code_executor import CodeExecutionError, LocalSubprocessExecutor
from mock_extraction import mock_loop_scenario, mock_sparse_scenario
from orchestrator import Orchestrator


class TracingTests(unittest.TestCase):
    def setUp(self):
        self.exporter = InMemorySpanExporter()
        self.provider = TracerProvider()
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        tracing.configure_tracing(provider=self.provider)
        self.orchestrator = Orchestrator(executor=LocalSubprocessExecutor())

    def tearDown(self):
        self.provider.shutdown()
        tracing._provider = tracing._tracer = None
        tracing._configured = False

    def spans(self):
        return {span.name: span for span in self.exporter.get_finished_spans()}

    def test_capture_tree_payloads_and_valid_failed_maneuver(self):
        capture = self.orchestrator.process_capture(mock_loop_scenario())
        self.assertEqual(capture.physics.status, "ok")
        self.assertEqual(capture.physics.metrics.outcome, "lost_traction")
        spans = self.spans()
        root = spans["Process capture"]
        self.assertEqual(capture.trace_id, format(root.context.trace_id, "032x"))
        self.assertEqual(root.attributes["session.id"], self.orchestrator.session_id)
        for name in ("Extraction (precomputed input)", "Modeling Agent", "Physics Agent"):
            self.assertEqual(spans[name].parent.span_id, root.context.span_id)
            self.assertEqual(spans[name].context.trace_id, root.context.trace_id)
        self.assertEqual(spans["Resolve vehicle specs"].parent.span_id, spans["Modeling Agent"].context.span_id)
        tool = spans["Local subprocess execution"]
        self.assertEqual(tool.parent.span_id, spans["Physics Agent"].context.span_id)
        self.assertEqual(tool.attributes["openinference.span.kind"], "TOOL")
        self.assertEqual(spans["Physics Agent"].status.status_code, StatusCode.OK)
        payload = json.loads(spans["Physics Agent"].attributes["output.value"])
        self.assertEqual(payload["trajectory_summary"]["point_count"], len(capture.physics.trajectory))
        self.assertNotIn("trajectory", payload)
        self.assertIn("sources", json.loads(spans["Modeling Agent"].attributes["output.value"]))

    def test_speed_only_runs_physics_and_shares_session(self):
        self.orchestrator.process_capture(mock_sparse_scenario())
        self.exporter.clear()
        result = self.orchestrator.update_speed(30)
        self.assertEqual(result.status, "ok")
        spans = self.spans()
        self.assertNotIn("Modeling Agent", spans)
        self.assertNotIn("Extraction (precomputed input)", spans)
        self.assertEqual(spans["Physics Agent"].parent.span_id, spans["Update speed"].context.span_id)
        self.assertEqual(spans["Update speed"].attributes["session.id"], self.orchestrator.session_id)

    def test_returned_errors_mark_root_and_stop_pipeline(self):
        extraction = mock_sparse_scenario()
        extraction.sketch.curves = []
        capture = self.orchestrator.process_capture(extraction)
        self.assertIsNone(capture.physics)
        spans = self.spans()
        self.assertEqual(spans["Process capture"].status.status_code, StatusCode.ERROR)
        self.assertEqual(spans["Modeling Agent"].status.status_code, StatusCode.ERROR)
        self.assertNotIn("Physics Agent", spans)

    def test_lookup_executor_nesting_does_not_capture_credentials(self):
        # Exercise the real executor boundary without contacting a paid service.
        secret = "test-secret-must-not-appear"
        executor = LocalSubprocessExecutor()
        lookup = CarSpecLookup(executor=executor)
        code = 'import json; print(json.dumps({"status": "ok", "mass_kg": 1500, "source_url": "https://example.com/spec"}))'
        with patch.dict(os.environ, {"ANCHORBROWSER_API_KEY": secret}), patch("car_spec_lookup.LOOKUP_CODE", code):
            self.assertEqual(lookup.lookup_mass_kg("Example car")[0], 1500)
        spans = self.spans()
        self.assertEqual(spans["Local subprocess execution"].parent.span_id,
                         spans["Anchor Browser car mass lookup"].context.span_id)
        serialized = json.dumps([dict(span.attributes) for span in spans.values()])
        self.assertNotIn(secret, serialized)
        self.assertNotIn("env_vars", serialized)

    def test_execution_failure_is_visible_even_when_caught_by_agent(self):
        with patch("code_executor.subprocess.run", side_effect=CodeExecutionError("test failure")):
            capture = self.orchestrator.process_capture(mock_sparse_scenario())
        self.assertEqual(capture.physics.error.code, "sandbox_execution_failed")
        spans = self.spans()
        for name in ("Process capture", "Physics Agent", "Local subprocess execution"):
            self.assertEqual(spans[name].status.status_code, StatusCode.ERROR)

    def test_tracing_failure_does_not_change_pipeline_result(self):
        with patch.object(tracing, "_set_output", side_effect=RuntimeError("telemetry failed")):
            capture = self.orchestrator.process_capture(mock_sparse_scenario())
        self.assertEqual(capture.physics.status, "ok")
        self.assertEqual(capture.physics.metrics.outcome, "landed_normal")

    def test_arize_configuration_uses_batched_export_and_quiet_credentials(self):
        with patch.dict(os.environ, {
            "PAPER_TRACE_BACKEND": "arize", "ARIZE_API_KEY": "test-key",
            "ARIZE_SPACE_ID": "test-space", "ARIZE_PROJECT_NAME": "test-project",
        }), patch("arize.otel.register", return_value=self.provider) as register:
            tracing._configured = False
            tracing.configure_tracing()
        register.assert_called_once_with(
            space_id="test-space", api_key="test-key", project_name="test-project",
            batch=True, set_global_tracer_provider=False, verbose=False,
        )

    def test_real_arize_sdk_with_in_memory_export(self):
        # Use the actual Arize/OpenInference tracer; replace only its exporter.
        with patch.dict(os.environ, {
            "PAPER_TRACE_BACKEND": "arize", "ARIZE_API_KEY": "test-key",
            "ARIZE_SPACE_ID": "test-space", "ARIZE_PROJECT_NAME": "test-project",
        }), patch("arize.otel.otel.TracerProvider._tracing_details", return_value=""), \
                patch("arize.otel.otel.BatchSpanProcessor",
                  return_value=SimpleSpanProcessor(self.exporter)):
            tracing._configured = False
            provider = tracing.configure_tracing()
        self.assertIsNotNone(provider)
        try:
            capture = self.orchestrator.process_capture(mock_sparse_scenario())
            self.assertEqual(capture.physics.status, "ok")
            spans = self.spans()
            self.assertEqual(spans["Physics Agent"].parent.span_id, spans["Process capture"].context.span_id)
            self.assertEqual(spans["Process capture"].resource.attributes["openinference.project.name"], "test-project")
        finally:
            provider.shutdown()

    def test_configuration_failure_keeps_pipeline_working(self):
        tracing._configured = False
        with patch.dict(os.environ, {"PAPER_TRACE_BACKEND": "arize"}), \
                patch("arize.otel.register", side_effect=RuntimeError("setup failed")), \
                self.assertLogs("tracing", level="WARNING"):
            tracing.configure_tracing()
        capture = self.orchestrator.process_capture(mock_sparse_scenario())
        self.assertEqual(capture.physics.status, "ok")
        self.assertIsNone(capture.trace_id)

    def test_unconfigured_mode_needs_no_telemetry(self):
        tracing._provider = tracing._tracer = None
        tracing._configured = False
        with patch.dict(os.environ, {"PAPER_TRACE_BACKEND": "off"}):
            orchestrator = Orchestrator(executor=LocalSubprocessExecutor())
            capture = orchestrator.process_capture(mock_sparse_scenario())
        self.assertEqual(capture.physics.status, "ok")
        self.assertIsNone(capture.trace_id)
        self.assertFalse(self.exporter.get_finished_spans())


if __name__ == "__main__":
    unittest.main()
