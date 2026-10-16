"""Shared LLM call for the Modeling Agent's problem-formulation step.

Mirrors capture/respond.py's dual-path pattern for consistency: prefers the
direct Anthropic API (ANTHROPIC_API_KEY) and falls back to Bedrock's
Converse API via boto3 (same model ids, same region) when it isn't set.

Returns None on any failure -- missing credentials, network error, bad
response. Callers must treat that as "no LLM available" and fall back to
their own deterministic heuristics; this never raises.
"""
from __future__ import annotations

import json
import os
import re
from typing import Optional

ANTHROPIC_MODEL = "claude-haiku-5-5"
BEDROCK_MODEL = "us.anthropic.claude-sonnet-5-5"  # Bedrock inference profile
BEDROCK_REGION = "us-west-2"

_bedrock_client = None


def call_text(system_prompt: str, user_text: str, max_tokens: int = 500) -> Optional[str]:
    """Returns the model's text reply, or None if no credentials / the call failed."""
    try:
        if os.environ.get("ANTHROPIC_API_KEY"):
            import anthropic

            msg = anthropic.Anthropic().messages.create(
                model=ANTHROPIC_MODEL,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_text}],
            )
            return msg.content[0].text.strip()

        global _bedrock_client
        import boto3

        if _bedrock_client is None:
            _bedrock_client = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)
        resp = _bedrock_client.converse(
            modelId=BEDROCK_MODEL,
            system=[{"text": system_prompt}],
            messages=[{"role": "user", "content": [{"text": user_text}]}],
            inferenceConfig={"maxTokens": max_tokens},
        )
        return " ".join(
            b["text"] for b in resp["output"]["message"]["content"] if "text" in b
        ).strip()
    except Exception:
        return None


def extract_json(text: Optional[str]) -> Optional[dict]:
    if not text:
        return None
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
