"""Result-contract helpers and output truncation shared by all tools.

Pure, dependency-free functions (no E2B/ADK imports). Every tool returns a
JSON-serializable ``dict`` following a single shape:

* Success results carry ``success: True`` plus tool-specific fields.
* Failure results carry ``success: False``, a human-readable ``error``, the
  echoed input relevant to the call (``path`` / ``command``), and any
  ``partial_output`` captured before the failure.

Oversized text output is trimmed to a byte bound with an explicit marker so a
single tool call cannot exhaust the agent's context window.
"""

from __future__ import annotations

from typing import Any

#: Default upper bound (in bytes) for a single truncatable text field.
DEFAULT_MAX_OUTPUT_BYTES = 10_000


def truncate_output(text: str, limit: int = DEFAULT_MAX_OUTPUT_BYTES) -> str:
    """Trim ``text`` to at most ``limit`` *payload* bytes (UTF-8), plus a marker.

    ``limit`` bounds the retained payload, not the final string: when truncation
    occurs a short ``…[truncated N bytes]`` marker is appended *beyond* the
    ``limit`` bytes, so the returned string may exceed ``limit`` by the marker's
    length. This keeps a single tool call from exhausting the agent's context
    while still reporting the exact omitted-byte count.

    Text is first normalized to valid Unicode: well-formed surrogate pairs are
    combined and lone surrogates are replaced with ``U+FFFD``. Text whose UTF-8
    encoding is then within ``limit`` is returned without a marker. Otherwise
    the first ``limit`` bytes are kept (decoded back at a valid character
    boundary, dropping any partial trailing char).
    """
    if limit < 0:
        raise ValueError(f"limit must be non-negative, got {limit}")
    try:
        encoded = text.encode("utf-8")
        normalized = text
    except UnicodeEncodeError:
        # E2B builds streamed log text with json.loads(), which can produce
        # Python strings containing UTF-16 surrogate code points. A UTF-16
        # round-trip combines valid pairs and replaces only malformed lone
        # surrogates, yielding text that is safe to encode and serialize.
        normalized = text.encode("utf-16", errors="surrogatepass").decode(
            "utf-16", errors="replace"
        )
        encoded = normalized.encode("utf-8")
    total = len(encoded)
    if total <= limit:
        return normalized

    # Decode the retained prefix, dropping any partial trailing char.
    kept = encoded[:limit].decode("utf-8", errors="ignore")
    omitted = total - len(kept.encode("utf-8"))
    return f"{kept}…[truncated {omitted:,} bytes]"


def success_result(**fields: Any) -> dict[str, Any]:
    """Build a success result: ``{**fields, "success": True}``.

    Callers pass the tool-specific fields (e.g. ``stdout``, ``path``,
    ``exit_code``) as keyword arguments. The reserved ``success`` key is set
    last so a caller-supplied ``success`` field can never override the contract.
    """
    return {**fields, "success": True}


def failure_result(
    error: str,
    *,
    path: str | None = None,
    command: str | None = None,
    partial_output: str = "",
    **extra: Any,
) -> dict[str, Any]:
    """Build a failure result following the single failure contract.

    Always includes ``success: False``, the ``error`` message, and
    ``partial_output``. The echoed input (``path`` and/or ``command``) is
    included only when supplied. Extra tool-specific fields may be passed via
    ``**extra``. Reserved contract keys are applied *after* ``**extra`` so an
    ``extra`` field can never override them.
    """
    result: dict[str, Any] = dict(extra)
    result["success"] = False
    result["error"] = error
    result["partial_output"] = partial_output
    if path is not None:
        result["path"] = path
    if command is not None:
        result["command"] = command
    return result
