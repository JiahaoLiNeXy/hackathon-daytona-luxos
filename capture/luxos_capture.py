"""LuxOS capture: grab one camera frame and one voice clip, wrap them as structured input.

The processor layer imports `capture_once()` and receives a `LuxInput`. The CLI
also writes `input.json` next to the saved image and audio.

Usage:
    python capture/luxos_capture.py --list-devices
    python capture/luxos_capture.py --camera 1 --seconds 5
"""
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import time
import uuid
import wave
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import sounddevice as sd

SAMPLE_RATE = 16000  # 16 kHz mono int16 is what speech-to-text engines expect
CHANNELS = 1
DEFAULT_OUT_DIR = Path(__file__).resolve().parent.parent / "captures"


@dataclass
class ImageInput:
    path: str
    media_type: str
    width: int
    height: int
    base64: str  # ready for a Bedrock Claude image content block


@dataclass
class AudioInput:
    path: str
    sample_rate: int
    duration_s: float
    transcript: str | None  # filled by the speech-to-text step
    segments: list[dict] | None = None  # [{"at": iso time, "text": ...}] per utterance, oldest first


@dataclass
class LuxInput:
    session_id: str
    captured_at: str
    camera_index: int
    mic_device: str
    image: ImageInput
    audio: AudioInput
    extraction: dict | None = None  # backend ExtractionOutput shape, see capture/extraction.py


def camera_names() -> list[str]:
    """Camera names in the same order OpenCV/AVFoundation uses as indexes (macOS)."""
    try:
        out = subprocess.run(
            ["system_profiler", "SPCameraDataType", "-json"], capture_output=True, text=True, timeout=15
        ).stdout
        return [c["_name"] for c in json.loads(out).get("SPCameraDataType", [])]
    except Exception:
        return []


def resolve_camera(spec: int | str) -> int:
    """Accept an index ("1") or a name fragment ("iphone"); return the OpenCV index."""
    if isinstance(spec, int) or str(spec).isdigit():
        return int(spec)
    for i, name in enumerate(camera_names()):
        if str(spec).lower() in name.lower():
            return i
    raise RuntimeError(f"No camera matching '{spec}'. Found: {camera_names() or 'none'}")


def list_devices(max_camera_index: int = 5) -> None:
    print("Cameras (OpenCV / AVFoundation):")
    found = False
    for i in range(max_camera_index):
        cap = cv2.VideoCapture(i, cv2.CAP_AVFOUNDATION)
        if cap.isOpened():
            ok, frame = cap.read()
            if ok:
                h, w = frame.shape[:2]
                names = camera_names()
                label = f"  {names[i]}" if i < len(names) else ""
                print(f"  [{i}] {w}x{h}{label}")
                found = True
        cap.release()
    if not found:
        print("  none found. Check System Settings > Privacy > Camera for your terminal app.")

    print("\nMicrophones (sounddevice):")
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            print(f"  [{idx}] {dev['name']}")
    default_in = sd.query_devices(kind="input")
    print(f"\nDefault input: {default_in['name']}")


def grab_frame(camera_index: int, warmup_frames: int = 15) -> np.ndarray:
    cap = cv2.VideoCapture(camera_index, cv2.CAP_AVFOUNDATION)
    if not cap.isOpened():
        raise RuntimeError(
            f"Camera {camera_index} did not open. Run --list-devices and check camera permission."
        )
    try:
        # The first frames are usually dark while auto-exposure settles.
        frame = None
        for _ in range(warmup_frames):
            ok, frame = cap.read()
        if frame is None or not ok:
            raise RuntimeError(f"Camera {camera_index} opened but returned no frames.")
        return frame
    finally:
        cap.release()


def record_audio(seconds: float, device: int | None) -> np.ndarray:
    frames = int(seconds * SAMPLE_RATE)
    audio = sd.rec(frames, samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="int16", device=device)
    sd.wait()
    return audio.reshape(-1)


def _write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(2)  # int16
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(samples.tobytes())


def capture_once(
    camera_index: int = 0,
    seconds: float = 5.0,
    mic_device: int | None = None,
    out_dir: Path = DEFAULT_OUT_DIR,
) -> LuxInput:
    """Capture one frame and one audio clip, save them, and return the structured input."""
    session_id = uuid.uuid4().hex[:12]
    session_dir = Path(out_dir) / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    captured_at = datetime.now(timezone.utc).isoformat()

    frame = grab_frame(camera_index)
    img_path = session_dir / "frame.jpg"
    cv2.imwrite(str(img_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    img_b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
    h, w = frame.shape[:2]

    mic_name = sd.query_devices(mic_device, kind="input")["name"]
    print(f"Recording {seconds:.1f}s from '{mic_name}'... speak now")
    samples = record_audio(seconds, mic_device)
    audio_path = session_dir / "prompt.wav"
    _write_wav(audio_path, samples)

    lux_input = LuxInput(
        session_id=session_id,
        captured_at=captured_at,
        camera_index=camera_index,
        mic_device=mic_name,
        image=ImageInput(
            path=str(img_path),
            media_type="image/jpeg",
            width=w,
            height=h,
            base64=img_b64,
        ),
        audio=AudioInput(
            path=str(audio_path),
            sample_rate=SAMPLE_RATE,
            duration_s=round(len(samples) / SAMPLE_RATE, 3),
            transcript=None,
        ),
    )

    (session_dir / "input.json").write_text(json.dumps(asdict(lux_input), indent=2))
    return lux_input


def main() -> None:
    parser = argparse.ArgumentParser(description="LuxOS camera + voice capture")
    parser.add_argument("--list-devices", action="store_true", help="list cameras and microphones")
    parser.add_argument("--camera", default="iphone", help='camera index or name fragment (default: "iphone")')
    parser.add_argument("--mic", type=int, default=None, help="sounddevice input index (default: system default)")
    parser.add_argument("--seconds", type=float, default=5.0, help="voice clip length")
    parser.add_argument("--countdown", type=int, default=2, help="seconds to wait before recording")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR, help="output directory")
    args = parser.parse_args()

    if args.list_devices:
        list_devices()
        return

    if args.countdown > 0:
        print(f"Get ready... recording in {args.countdown}s")
        time.sleep(args.countdown)

    lux_input = capture_once(resolve_camera(args.camera), args.seconds, args.mic, args.out)
    summary = asdict(lux_input)
    summary["image"]["base64"] = f"<{len(lux_input.image.base64)} chars>"  # keep stdout readable
    print(json.dumps(summary, indent=2))
    print(f"\nSaved to {Path(lux_input.image.path).parent}")


if __name__ == "__main__":
    main()
