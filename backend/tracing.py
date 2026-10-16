"""Optional OpenInference spans for Arize AX and credential-free console tracing.

Only explicitly selected function arguments are captured. In particular, executor
environment variables and SDK clients must never become span attributes.
"""
from __future__ import annotations

import inspect
import json
import logging
import os
import sys
from dataclasses import asdict, is_dataclass
from functools import wraps

_provider = None
_tracer = None
_configured = False
_logger = logging.getLogger(__name__)


def configure_tracing(*, provider=None):
    """Configure once, after loading .env; an injected provider supports tests.

    PAPER_TRACE_BACKEND: arize, console, or off. Defaults to arize only when
    both Arize credentials exist. Tracing setup failures leave the demo usable.
    """
    global _provider, _tracer, _configured
    if _configured and provider is None:
        return _provider
    _configured = True
    try:
        if provider is None:
            credentials = os.getenv("ARIZE_API_KEY") and os.getenv("ARIZE_SPACE_ID")
            backend = os.getenv("PAPER_TRACE_BACKEND", "arize" if credentials else "off")
            if backend == "off":
                return None
            if backend == "arize":
                if not credentials:
                    raise ValueError("Arize credentials missing")
                from arize.otel import register

                provider = register(
                    space_id=os.environ["ARIZE_SPACE_ID"],
                    api_key=os.environ["ARIZE_API_KEY"],
                    project_name=os.getenv("ARIZE_PROJECT_NAME", "paper-to-screen"),
                    batch=True,
                    set_global_tracer_provider=False,
                    verbose=False,
                )
            elif backend == "console":
                from opentelemetry.sdk.resources import Resource
                from opentelemetry.sdk.trace import TracerProvider
                from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor

                provider = TracerProvider(resource=Resource.create({
                    "service.name": "paper-to-screen",
                    "openinference.project.name": os.getenv("ARIZE_PROJECT_NAME", "paper-to-screen"),
                }))
                provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter(out=sys.stderr)))
            else:
                raise ValueError("Unknown PAPER_TRACE_BACKEND")
        _tracer = provider.get_tracer("paper-to-screen")
        _provider = provider
    except Exception:
        # Do not log SDK exception text: it can contain authentication headers.
        _logger.warning("Tracing setup failed; continuing without traces. Check tracing configuration and dependencies.")
        _provider = _tracer = None
    return _provider


def flush_traces():
    """Drain batched spans before a short-lived CLI exits."""
    if _provider is not None:
        try:
            return _provider.force_flush(timeout_millis=5000)
        except Exception:
            _logger.warning("Could not flush traces; pipeline results are unaffected.")
    return False


def current_trace_id():
    if _tracer is None:
        return None
    from opentelemetry.trace import get_current_span

    context = get_current_span().get_span_context()
    return format(context.trace_id, "032x") if context.is_valid else None


def _payload(value):
    if hasattr(value, "to_dict"):
        value = value.to_dict()
    elif is_dataclass(value):
        value = asdict(value)
    if isinstance(value, dict):
        output = {}
        for key, item in value.items():
            if key == "trajectory" and isinstance(item, list):
                output["trajectory_summary"] = {
                    "point_count": len(item),
                    "first": _payload(item[0]) if item else None,
                    "last": _payload(item[-1]) if item else None,
                }
            else:
                output[key] = _payload(item)
        return output
    if isinstance(value, (list, tuple)):
        return [_payload(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return type(value).__name__


def _failed(value):
    if isinstance(value, dict):
        return value.get("status") == "error" or any(_failed(v) for v in value.values())
    return False


def _set_output(span, result):
    from opentelemetry.trace import StatusCode

    payload = _payload(result)
    span.set_attribute("output.mime_type", "application/json")
    span.set_attribute("output.value", json.dumps(payload))
    error_result = is_dataclass(result) and type(result).__name__.endswith("Error")
    span.set_status(StatusCode.ERROR if error_result or _failed(payload) else StatusCode.OK)


def traced(name, kind, *, inputs=(), attributes=None):
    """Trace synchronous pipeline work without changing its return contract."""
    def decorate(function):
        signature = inspect.signature(function)

        @wraps(function)
        def wrapper(*args, **kwargs):
            if _tracer is None:
                return function(*args, **kwargs)
            try:
                bound = signature.bind(*args, **kwargs)
                selected = {key: _payload(bound.arguments[key]) for key in inputs if key in bound.arguments}
                attrs = {"openinference.span.kind": kind, **(attributes or {})}
                owner = bound.arguments.get("self")
                if getattr(owner, "session_id", None):
                    attrs["session.id"] = owner.session_id
                attrs.update({"input.mime_type": "application/json", "input.value": json.dumps(selected)})
                context = _tracer.start_as_current_span(
                    name, attributes=attrs, record_exception=False, set_status_on_exception=False,
                )
                span = context.__enter__()
            except Exception:
                return function(*args, **kwargs)
            try:
                result = function(*args, **kwargs)
                try:
                    _set_output(span, result)
                except Exception:
                    pass
                return result
            except Exception as exc:
                try:
                    from opentelemetry.trace import StatusCode

                    span.set_status(StatusCode.ERROR)
                    span.set_attribute("error.type", type(exc).__name__)
                except Exception:
                    pass
                raise
            finally:
                try:
                    context.__exit__(None, None, None)
                except Exception:
                    pass

        return wrapper
    return decorate
