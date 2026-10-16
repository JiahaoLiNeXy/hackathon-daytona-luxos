import argparse
import json

try:
    from dotenv import load_dotenv

    load_dotenv()  # picks up backend/.env if present (DAYTONA_API_KEY etc.), never printed
except ImportError:
    pass

from mock_extraction import mock_loop_scenario, mock_sparse_scenario, mock_uncached_car_scenario
from code_executor import LocalSubprocessExecutor
from orchestrator import Orchestrator
from tracing import flush_traces


def main():
    parser = argparse.ArgumentParser(description="Run the mocked sketch pipeline with optional Arize tracing.")
    parser.add_argument("--local", action="store_true", help="Use local subprocesses even when Daytona is configured")
    args = parser.parse_args()
    orchestrator = Orchestrator(executor=LocalSubprocessExecutor() if args.local else None)

    print("=== Loop scenario (full info: grid+legend, spoken speed/entity) ===")
    capture = orchestrator.process_capture(mock_loop_scenario())
    print(json.dumps(capture.to_dict(), indent=2))

    print("\n=== Same scenario, slider bumped to 30 m/s (fast path, Physics only) ===")
    physics_result = orchestrator.update_speed(30.0)
    print(json.dumps(physics_result.to_dict(), indent=2))

    print("\n=== Sparse scenario (no grid/legend/speed/entity) ===")
    capture = orchestrator.process_capture(mock_sparse_scenario())
    print(json.dumps(capture.to_dict(), indent=2))

    print("\n=== Uncached car (forces the live anchorbrowser lookup, ~30-45s) ===")
    capture = orchestrator.process_capture(mock_uncached_car_scenario())
    print(json.dumps(capture.to_dict(), indent=2))


if __name__ == "__main__":
    try:
        main()
    finally:
        flush_traces()
