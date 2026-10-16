# hackathon-daytona-luxos

[Bedrock integration handoff](docs/bedrock-integration.md)

## Capture (Phase 1, step 1)

Grabs one camera frame and one voice clip from the Mac and wraps them as `LuxInput` JSON for the processor layer.

```bash
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r capture/requirements.txt

python capture/luxos_capture.py --list-devices            # find camera + mic indexes
python capture/luxos_capture.py --camera 1 --mic 0 --seconds 5
```

Output lands in `captures/<session_id>/` as `frame.jpg`, `prompt.wav`, and `input.json`.
The processor layer can call it directly:

```python
from capture.luxos_capture import capture_once
lux = capture_once(camera_index=1, seconds=5, mic_device=0)
```

`audio.transcript` is `null` until the speech-to-text step fills it.

macOS: grant camera and microphone access to your terminal app under System Settings > Privacy & Security.

### Voice trigger

`capture/listen.py` runs continuously: it transcribes everything said (utterance by utterance, locally with
faster-whisper) into a rolling conversation log and keeps the newest camera frame ready.
Say **"hey lighty"** to start a capture, describe your drawing, then say **"lighty build"**. That snapshots
the latest frame, bundles everything said since the start phrase (up to 5 min), saves
`frame.jpg` / `prompt.wav` / `input.json`, and yields a `LuxInput`. Speech outside a capture is ignored.
`audio.transcript` is the full conversation; `audio.segments` has it per utterance with timestamps.

```bash
python capture/listen.py --camera 0 --mic 0                       # indexes from --list-devices
python capture/listen.py --camera 0 --mic 0 --stt elevenlabs      # final transcript via ElevenLabs Scribe
```

`--stt elevenlabs` needs `ELEVENLABS_API_KEY` in the environment. Trigger detection always stays local (fast, free);
ElevenLabs only re-transcribes the saved conversation at trigger time and falls back to the local text on error.
Raise `--vad-threshold` (default 0.015) in noisy rooms.

```python
from capture.listen import listen
for lux in listen(camera_index=0, mic_device=0):
    ...  # lux.audio.transcript holds the conversation
```

**Spoken replies** (`capture/respond.py`): on trigger it instantly says "Got it, let me take a look.", then Claude looks at the
captured frame and says one line about what you drew ("I see a flying car, ready to play with it"), voiced by ElevenLabs TTS.
It needs `ANTHROPIC_API_KEY` (preferred) or Bedrock access; without either it says a generic line. It mutes its own
mic input while talking. Disable with `--no-voice`.

**Hand-off to the backend** (`capture/extraction.py`, `capture/bridge.py`): after each trigger, Claude on Bedrock traces the
sketch strokes in pixel coordinates, reads the grid and handwriting, and pulls entities and quantities from the
conversation. That produces the Extraction Agent output defined in `docs/modeling-agent-spec.md`. It is saved as
`captures/<id>/extraction.json` (also under `lux.extraction`), with `overlay.jpg` showing the traced curves on the frame.
Speech and drawing are read jointly: speech picks which strokes matter and what they are, the drawing resolves "this part", and every spoken number (mass, gap width, scale) is kept in `mentioned_quantities`. `user_goal` holds the question being asked.
`--backend` runs it straight through `backend/` (Modeling -> Physics) and saves `backend_result.json`;
from code, `capture.bridge.run_backend(lux.extraction)` does the same. `--no-extract` skips this step.

Quit FaceTime if the camera fails to open.
