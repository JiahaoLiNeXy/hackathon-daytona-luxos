import json

from mock_extraction import mock_loop_scenario, mock_sparse_scenario
from orchestrator import Orchestrator


def main():
    orchestrator = Orchestrator()

    print("=== Loop scenario (full info: grid+legend, spoken speed/entity) ===")
    result = orchestrator.process_capture(mock_loop_scenario())
    print(json.dumps(result.to_dict(), indent=2))

    print("\n=== Sparse scenario (no grid/legend/speed/entity) ===")
    result = orchestrator.process_capture(mock_sparse_scenario())
    print(json.dumps(result.to_dict(), indent=2))


if __name__ == "__main__":
    main()
