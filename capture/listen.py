"""LuxOS continuous context capture with a voice trigger.

While running, the mic is listened to and the camera keeps its newest frame ready. Saying
START_PHRASE ("hey lighty") starts a capture; everything said after it is transcribed locally and
collected. Saying END_PHRASE ("lighty build") snapshots the latest frame and emits a `LuxInput` with
the whole capture (up to MAX_CONTEXT_SECONDS). Speech outside a capture is ignored.

Usage:
    python capture/listen.py --list-devices
    python capture/listen.py --camera 1 --mic 0
    python capture/listen.py --camera 1 --mic 0 --stt elevenlabs   # needs ELEVENLABS_API_KEY
"""
from __future__ import annotations

import argparse
import base64
import difflib
import json
import os
import queue
import re
import sys
import threading
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

import cv2
import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel

try:
    from .extraction import extract_capture
    from .respond import Responder
    from .luxos_capture import (
        CHANNELS,
        DEFAULT_OUT_DIR,
        SAMPLE_RATE,
        AudioInput,
        ImageInput,
        LuxInput,
        _write_wav,
        camera_names,
        list_devices,
        resolve_camera,
    )
except ImportError:  # run as a script: python capture/listen.py
    from extraction import extract_capture
    from respond import Responder
    from luxos_capture import (
        CHANNELS,
        DEFAULT_OUT_DIR,
        SAMPLE_RATE,
        AudioInput,
        ImageInput,
        LuxInput,
        _write_wav,
        camera_names,
        list_devices,
        resolve_camera,
    )

def _load_dotenv(path: Path = Path(__file__).resolve().parent.parent / ".env") -> None:
    """Minimal .env loader so ELEVENLABS_API_KEY works without exporting it."""
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and not key.strip().startswith("#"):
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_load_dotenv()

START_PHRASE = "hey lighty"   # starts capturing the conversation
END_PHRASE = "lighty build"   # ends the capture and builds from it
TRIGGER_MIN_SCORE = 0.8       # fuzzy match, so "hey lightly" still passes
BLOCK_SECONDS = 0.1         # audio block size for the voice-activity check
SILENCE_END_SECONDS = 0.8   # this much quiet ends an utterance
MAX_UTTERANCE_SECONDS = 20.0
MIN_UTTERANCE_SECONDS = 0.4
PREROLL_SECONDS = 0.3       # keep audio just before speech starts so first words aren't clipped
MAX_CONTEXT_SECONDS = 300.0  # oldest conversation is dropped beyond this
WHISPER_HINT = "Hey Lighty. Lighty build."  # biases the model toward the phrase spellings


class LatestFrame:
    """Reads the camera on a background thread and keeps only the newest frame."""

    def __init__(self, camera_index: int):
        self.cap = cv2.VideoCapture(camera_index, cv2.CAP_AVFOUNDATION)
        if not self.cap.isOpened():
            raise RuntimeError(
                f"Camera {camera_index} did not open. Run --list-devices, and quit FaceTime "
                "if it is holding the iPhone camera."
            )
        self._lock = threading.Lock()
        self._frame: np.ndarray | None = None
        self._ts: float = 0.0
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self, timeout: float = 5.0) -> None:
        self._thread.start()
        deadline = time.time() + timeout
        while self.snapshot() is None:
            if time.time() > deadline:
                raise RuntimeError("Camera opened but returned no frames.")
            time.sleep(0.05)

    def _run(self) -> None:
        while self._running:
            ok, frame = self.cap.read()
            if ok:
                with self._lock:
                    self._frame = frame
                    self._ts = time.time()

    def snapshot(self) -> tuple[np.ndarray, float] | None:
        with self._lock:
            if self._frame is None:
                return None
            return self._frame.copy(), self._ts

    def stop(self) -> None:
        self._running = False
        self._thread.join(timeout=2)
        self.cap.release()


def normalize(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", text.lower()).split())


def find_phrase(text: str, phrase: str) -> tuple[int, int] | None:
    """Word range [start, end) in normalize(text) that fuzzy-matches phrase, else None."""
    words = normalize(text).split()
    n = len(phrase.split())
    for i in range(len(words) - n + 1):
        candidate = " ".join(words[i : i + n])
        if difflib.SequenceMatcher(None, candidate, phrase).ratio() >= TRIGGER_MIN_SCORE:
            return i, i + n
    return None


def contains_phrase(text: str, phrase: str) -> bool:
    return find_phrase(text, phrase) is not None


def strip_phrase(text: str, phrase: str) -> str:
    """Remove the phrase's words from a transcript, keeping everything else."""
    hit = find_phrase(text, phrase)
    if hit is None:
        return text.strip()
    words = normalize(text).split()
    return " ".join(words[: hit[0]] + words[hit[1] :])


def transcribe(model: WhisperModel, audio: np.ndarray) -> str:
    segments, _ = model.transcribe(
        audio, language="en", beam_size=1, vad_filter=True, initial_prompt=WHISPER_HINT
    )
    return " ".join(seg.text.strip() for seg in segments)


def transcribe_elevenlabs(wav_path: Path) -> str:
    """Higher-quality transcript of the saved conversation via ElevenLabs Scribe."""
    from elevenlabs.client import ElevenLabs

    client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
    with open(wav_path, "rb") as f:
        result = client.speech_to_text.convert(file=f, model_id="scribe_v1", language_code="en")
    return result.text.strip()


def utterances(mic_device: int | None, vad_threshold: float) -> Iterator[np.ndarray]:
    """Yield float32 mono utterances, split on silence. Audio keeps flowing while callers work."""
    blocks: queue.Queue[np.ndarray] = queue.Queue()
    block_samples = int(BLOCK_SECONDS * SAMPLE_RATE)
    preroll_blocks = int(PREROLL_SECONDS / BLOCK_SECONDS)
    silence_end_blocks = int(SILENCE_END_SECONDS / BLOCK_SECONDS)
    max_blocks = int(MAX_UTTERANCE_SECONDS / BLOCK_SECONDS)

    def on_audio(indata, frames, time_info, status):
        blocks.put(indata[:, 0].copy())

    recent: list[np.ndarray] = []
    current: list[np.ndarray] = []
    quiet = 0
    with sd.InputStream(
        samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="float32",
        device=mic_device, blocksize=block_samples, callback=on_audio,
    ):
        while True:
            block = blocks.get()
            loud = float(np.sqrt(np.mean(block**2))) >= vad_threshold
            if not current:
                recent = (recent + [block])[-preroll_blocks:]
                if loud:
                    current = list(recent)
                    quiet = 0
                continue
            current.append(block)
            quiet = 0 if loud else quiet + 1
            if quiet >= silence_end_blocks or len(current) >= max_blocks:
                audio = np.concatenate(current)
                current, recent = [], []
                if len(audio) / SAMPLE_RATE >= MIN_UTTERANCE_SECONDS:
                    yield audio


def listen(
    camera_index: int = 0,
    mic_device: int | None = None,
    model_name: str = "base.en",
    out_dir: Path = DEFAULT_OUT_DIR,
    vad_threshold: float = 0.015,
    stt: str = "local",
    speak: bool = True,
    extract: bool = True,
    on_text: Callable[[str], None] | None = None,
) -> Iterator[LuxInput]:
    """Collect conversation context continuously; yield one LuxInput per trigger."""
    print(f"Loading speech model '{model_name}'...")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    camera = LatestFrame(camera_index)
    camera.start()
    names = camera_names()
    print(f"Using camera [{camera_index}] {names[camera_index] if camera_index < len(names) else ''}")
    mic_name = sd.query_devices(mic_device, kind="input")["name"]
    print(f"Say \"{START_PHRASE}\" to start capturing, \"{END_PHRASE}\" to build (Ctrl+C to quit)")

    # Idle until START_PHRASE; then collect utterances until END_PHRASE builds the input.
    capturing = False
    context: list[dict] = []  # {"at": iso, "text": str, "audio": ndarray}

    responder = None
    if speak:
        responder = Responder(Path(out_dir) / ".cache", on_text=on_text)
        responder.warmup()

    try:
        for audio in utterances(mic_device, vad_threshold):
            if responder and responder.is_muted():
                continue  # that was LuxOS talking, not the user
            text = transcribe(model, audio)
            if not text:
                continue
            now = datetime.now(timezone.utc)

            if not capturing:
                if not contains_phrase(text, START_PHRASE):
                    print(f"  (idle) {text}")
                    continue
                capturing = True
                context = []
                print(f"Capture started. Say \"{END_PHRASE}\" when you're done.")
                # Words in the same breath as the start phrase still count, and may hold the end phrase too.
                text = strip_phrase(text, START_PHRASE)
                if not text:
                    continue

            if not contains_phrase(text, END_PHRASE):
                context.append({"at": now.isoformat(), "text": text, "audio": audio})
                total = lambda: sum(len(c["audio"]) for c in context) / SAMPLE_RATE
                while total() > MAX_CONTEXT_SECONDS:
                    context.pop(0)
                print(f"  heard: {text}")
                continue

            # Snapshot the newest frame as close to the end phrase as possible.
            frame, frame_ts = camera.snapshot()
            remainder = strip_phrase(text, END_PHRASE)
            if remainder:  # words spoken in the same breath as the end phrase still count
                context.append({"at": now.isoformat(), "text": remainder, "audio": audio})
            capturing = False
            print(f"Build requested. Building from {len(context)} utterances...")
            if responder:
                responder.trigger(frame, " ".join(c["text"] for c in context))

            lux = _build_input(frame, frame_ts, context, camera_index, mic_name, out_dir, stt)
            context = []
            if extract:
                print("Extracting sketch + entities...")
                try:
                    lux.extraction = extract_capture(
                        Path(lux.image.path).parent, frame, lux.audio.transcript or ""
                    )
                    (Path(lux.image.path).parent / "input.json").write_text(json.dumps(asdict(lux), indent=2))
                except Exception as e:  # the capture itself is still valid without extraction
                    print(f"  (extraction failed: {e})")
            yield lux
    finally:
        camera.stop()


def _build_input(
    frame: np.ndarray,
    frame_ts: float,
    context: list[dict],
    camera_index: int,
    mic_name: str,
    out_dir: Path,
    stt: str,
) -> LuxInput:
    session_id = uuid.uuid4().hex[:12]
    session_dir = Path(out_dir) / session_id
    session_dir.mkdir(parents=True, exist_ok=True)

    img_path = session_dir / "frame.jpg"
    cv2.imwrite(str(img_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    h, w = frame.shape[:2]

    audio = np.concatenate([c["audio"] for c in context]) if context else np.zeros(0, np.float32)
    pcm = np.clip(audio * 32767, -32768, 32767).astype(np.int16)
    audio_path = session_dir / "prompt.wav"
    _write_wav(audio_path, pcm)

    transcript = " ".join(c["text"] for c in context)
    if stt == "elevenlabs" and len(pcm):
        try:
            transcript = transcribe_elevenlabs(audio_path)
        except Exception as e:  # keep the local transcript if the API call fails
            print(f"ElevenLabs transcription failed, using local transcript: {e}")

    lux = LuxInput(
        session_id=session_id,
        captured_at=datetime.fromtimestamp(frame_ts, tz=timezone.utc).isoformat(),
        camera_index=camera_index,
        mic_device=mic_name,
        image=ImageInput(
            path=str(img_path),
            media_type="image/jpeg",
            width=w,
            height=h,
            base64=base64.b64encode(img_path.read_bytes()).decode("ascii"),
        ),
        audio=AudioInput(
            path=str(audio_path),
            sample_rate=SAMPLE_RATE,
            duration_s=round(len(pcm) / SAMPLE_RATE, 3),
            transcript=transcript or None,
            segments=[{"at": c["at"], "text": c["text"]} for c in context],
        ),
    )
    (session_dir / "input.json").write_text(json.dumps(asdict(lux), indent=2))
    return lux


def main() -> None:
    parser = argparse.ArgumentParser(description="LuxOS continuous capture with voice trigger")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--camera", default="iphone", help='camera index or name fragment (default: "iphone")')
    parser.add_argument("--mic", type=int, default=None, help="sounddevice input index")
    parser.add_argument("--model", default="base.en", help="faster-whisper model size")
    parser.add_argument("--stt", choices=["local", "elevenlabs"], default="local",
                        help="final transcript engine (trigger detection is always local)")
    parser.add_argument("--vad-threshold", type=float, default=0.015,
                        help="mic RMS level that counts as speech; raise it in noisy rooms")
    parser.add_argument("--no-extract", action="store_true", help="skip sketch extraction")
    parser.add_argument("--backend", action="store_true", help="run each extraction through backend Modeling -> Physics")
    parser.add_argument("--no-voice", action="store_true", help="skip the spoken replies")
    parser.add_argument("--overlay", action="store_true",
                        help="also show the reply text on the overlay (run overlay/overlay.py overlay/response.html)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    args = parser.parse_args()

    if args.list_devices:
        list_devices()
        return

    on_text = None
    if args.overlay:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "overlay"))
        from show_text import write_text as on_text

    orchestrator = None
    try:
        for lux in listen(resolve_camera(args.camera), args.mic, args.model, args.out, args.vad_threshold, args.stt,
                         not args.no_voice, not args.no_extract, on_text=on_text):
            print(f"\nInput {lux.session_id}")
            print(f"  conversation: {lux.audio.transcript!r}")
            print(f"  frame:        {lux.image.path}")
            print(f"  audio:        {lux.audio.path} ({lux.audio.duration_s}s)")
            if args.backend and lux.extraction:
                from bridge import run_backend

                orchestrator, result = run_backend(lux.extraction, orchestrator)
                d = result.to_dict()
                (Path(lux.image.path).parent / "backend_result.json").write_text(json.dumps(d, indent=2))
                print(f"  modeling: {d['modeling']['status']}  physics: {d['physics']['status'] if d['physics'] else '-'}")
                if d["physics"] and d["physics"]["metrics"]:
                    print(f"  outcome:  {d['physics']['metrics']['outcome']}")
            print("Capturing context again...")
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
