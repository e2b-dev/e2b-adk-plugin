"""Result-contract helpers and output truncation shared by all tools.

Pure, dependency-free functions (no E2B/ADK imports). Every tool returns a
JSON-serializable ``dict`` following a single shape (FEATURE_TECHNICAL_SPEC §5):

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
    """Trim ``text`` to at most ``limit`` bytes (UTF-8), appending a marker.

    Text whose UTF-8 encoding is within ``limit`` is returned unchanged (no
    marker). Otherwise the first ``limit`` bytes are kept (decoded back at a
    valid character boundary) and a ``…[truncated N bytes]`` marker reporting
    the exact number of omitted bytes is appended.
    """
    encoded = text.encode("utf-8")
    total = len(encoded)
    if total <= limit:
        return text

    # Decode the retained prefix, dropping any partial trailing char.
    kept = encoded[:limit].decode("utf-8", errors="ignore")
    omitted = total - len(kept.encode("utf-8"))
    return f"{kept}…[truncated {omitted:,} bytes]"


def success_result(**fields: Any) -> dict[str, Any]:
    """Build a success result: ``{"success": True, **fields}``.

    Callers pass the tool-specific fields (e.g. ``stdout``, ``path``,
    ``exit_code``) as keyword arguments.
    """
    return {"success": True, **fields}


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
    ``**extra``.
    """
    result: dict[str, Any] = {
        "success": False,
        "error": error,
        "partial_output": partial_output,
    }
    if path is not None:
        result["path"] = path
    if command is not None:
        result["command"] = command
    result.update(extra)
    return result
