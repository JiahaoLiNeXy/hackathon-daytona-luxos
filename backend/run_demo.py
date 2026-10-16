import json

try:
    from dotenv import load_dotenv

    load_dotenv()  # picks up backend/.env if present (DAYTONA_API_KEY etc.), never printed
except ImportError:
    pass

from mock_extraction import mock_loop_scenario, mock_sparse_scenario
from orchestrator import Orchestrator


def main():
    orchestrator = Orchestrator()

    print("=== Loop scenario (full info: grid+legend, spoken speed/entity) ===")
    capture = orchestrator.process_capture(mock_loop_scenario())
    print(json.dumps(capture.to_dict(), indent=2))

    print("\n=== Same scenario, slider bumped to 30 m/s (fast path, Physics only) ===")
    physics_result = orchestrator.update_speed(30.0)
    print(json.dumps(physics_result.to_dict(), indent=2))

    print("\n=== Sparse scenario (no grid/legend/speed/entity) ===")
    capture = orchestrator.process_capture(mock_sparse_scenario())
    print(json.dumps(capture.to_dict(), indent=2))


if __name__ == "__main__":
    main()
