"""Spoken feedback after the trigger: a quick acknowledgement, then a line about what the camera sees.

Sequence on trigger:
    1. "Got it, let me take a look." plays at once (pre-rendered, so no latency).
    2. In parallel, Claude (Anthropic API if ANTHROPIC_API_KEY is set, else Bedrock) looks at the captured frame plus what was said and writes one short
       spoken line ("I see you drew a flying car, ready to play with it!").
    3. That line is synthesized by ElevenLabs TTS and played.

Without ELEVENLABS_API_KEY it falls back to the macOS `say` voice.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

ACK_TEXT = "Got it, let me take a look."
VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"      # ElevenLabs premade voice "George"
TTS_MODEL = "eleven_flash_v2_5"         # low-latency TTS
VISION_MODEL = "us.anthropic.claude-sonnet-5-5"  # Bedrock inference profile
ANTHROPIC_MODEL = "claude-haiku-5-5"   # used instead of Bedrock when ANTHROPIC_API_KEY is set
BEDROCK_REGION = "us-west-2"
ECHO_GUARD_SECONDS = 1.0                # ignore the mic briefly after playback so we don't hear ourselves

SYSTEM_PROMPT = (
    "You are LuxOS, a playful voice assistant. The user has just sketched something on paper and asked you "
    "to build it. Reply with ONE short spoken sentence (under 25 words): say what you see drawn, then say "
    "you're ready to play with it. Plain words only, no markdown, no emojis. Never say the trigger phrase."
)


class Responder:
    def __init__(self, cache_dir: Path, on_text: Callable[[str], None] | None = None):
        self.cache_dir = Path(cache_dir)
        self._on_text = on_text  # mirrors each spoken line to the screen (e.g. the overlay)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._speaking = threading.Event()
        self._quiet_until = 0.0
        self._tts = None
        self._bedrock = None
        if os.environ.get("ELEVENLABS_API_KEY"):
            from elevenlabs.client import ElevenLabs

            self._tts = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
        self._ack_path = self.cache_dir / "ack.mp3"

    def warmup(self) -> None:
        """Pre-render the acknowledgement so it plays instantly on trigger."""
        muted = subprocess.run(
            ["osascript", "-e", "output muted of (get volume settings)"], capture_output=True, text=True
        ).stdout.strip()
        if muted == "true":
            print("WARNING: Mac output is muted, so spoken replies will be silent. Unmute and check the output device.")
        if self._tts and not self._ack_path.exists():
            self._ack_path.write_bytes(self._synthesize(ACK_TEXT))

    def is_muted(self) -> bool:
        """True while speaking and just after, so the mic ignores our own voice."""
        return self._speaking.is_set() or time.time() < self._quiet_until

    def trigger(self, frame: np.ndarray, transcript: str) -> None:
        threading.Thread(target=self._run, args=(frame, transcript), daemon=True).start()

    def _run(self, frame: np.ndarray, transcript: str) -> None:
        self._speaking.set()
        try:
            self._show(ACK_TEXT)
            ack = threading.Thread(target=self._play_ack)
            ack.start()
            try:
                line = self._describe(frame, transcript)
            except Exception as e:
                print(f"  (vision reply failed: {e})")
                line = "I've got your sketch and I'm ready to play with it."
            ack.join()
            print(f"  LuxOS: {line}")
            self._show(line)
            self._speak(line)
        finally:
            self._quiet_until = time.time() + ECHO_GUARD_SECONDS
            self._speaking.clear()

    def _show(self, text: str) -> None:
        """Mirror text to the screen. A display error must never stop the spoken reply."""
        if not self._on_text:
            return
        try:
            self._on_text(text)
        except Exception as e:
            print(f"  (screen text failed: {e})")

    def _describe(self, frame: np.ndarray, transcript: str) -> str:
        h, w = frame.shape[:2]
        scale = 1024 / max(h, w)
        small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale < 1 else frame
        jpeg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
        said = transcript.strip() or "(nothing)"
        prompt = f"What the user said before asking to build: {said}"

        if os.environ.get("ANTHROPIC_API_KEY"):
            import anthropic
            import base64

            msg = anthropic.Anthropic().messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=80,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                  "data": base64.b64encode(jpeg).decode()}},
                    {"type": "text", "text": prompt},
                ]}],
            )
            return msg.content[0].text.strip()

        import boto3

        if self._bedrock is None:
            self._bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
        resp = self._bedrock.converse(
            modelId=VISION_MODEL,
            system=[{"text": SYSTEM_PROMPT}],
            messages=[{
                "role": "user",
                "content": [
                    {"image": {"format": "jpeg", "source": {"bytes": jpeg}}},
                    {"text": prompt},
                ],
            }],
            inferenceConfig={"maxTokens": 600},  # headroom: Sonnet 5.5 spends tokens thinking first
        )
        # Newer models may lead with a non-text (reasoning) block, so take the text blocks only.
        return " ".join(b["text"] for b in resp["output"]["message"]["content"] if "text" in b).strip()

    def _synthesize(self, text: str) -> bytes:
        audio = self._tts.text_to_speech.convert(
            voice_id=VOICE_ID, text=text, model_id=TTS_MODEL, output_format="mp3_44100_128"
        )
        return b"".join(audio)

    def _play_ack(self) -> None:
        if self._tts and self._ack_path.exists():
            subprocess.run(["afplay", str(self._ack_path)], check=False)
        else:
            subprocess.run(["say", ACK_TEXT], check=False)

    def _speak(self, text: str) -> None:
        if not self._tts:
            subprocess.run(["say", text], check=False)
            return
        try:
            data = self._synthesize(text)
        except Exception as e:
            print(f"  (ElevenLabs TTS failed, using system voice: {e})")
            subprocess.run(["say", text], check=False)
            return
        with tempfile.NamedTemporaryFile(suffix=".mp3", dir=self.cache_dir, delete=False) as f:
            f.write(data)
        try:
            subprocess.run(["afplay", f.name], check=False)
        finally:
            os.unlink(f.name)
