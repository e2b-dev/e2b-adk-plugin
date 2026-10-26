"""Shared helpers for the E2B tool classes.

Small, pure helpers used by more than one tool (or that derive a constant from
the SDK). Each tool class lives in its own module and imports what it needs
from here; the package ``__init__`` re-exports the public surface.
"""

from __future__ import annotations

from typing import Any, get_args

from e2b_code_interpreter import FileType, RunCodeLanguage


def _supported_languages() -> list[str]:
    """Derive the known languages from E2B's ``RunCodeLanguage`` type alias.

    E2B declares it as ``Union[Literal["python", ...], str]`` — an *open* union
    (any string is accepted; the literals are the known set). We unpack those
    literal members so the enum we advertise stays in lockstep with the pinned
    SDK and is never maintained in two places. Falls back to ``["python"]`` if
    the alias shape ever changes (``run_code`` still accepts any string).
    """
    args = get_args(RunCodeLanguage)
    for arg in args:
        members = get_args(arg)
        if members and all(isinstance(m, str) for m in members):
            return list(members)
    return ["python"]


#: Languages E2B's ``run_code`` supports natively, sourced from the SDK's own
#: ``RunCodeLanguage``. E2B runs all of them through a single ``run_code`` call,
#: so this tool needs no per-language branching.
SUPPORTED_LANGUAGES = _supported_languages()


def _join(chunks: list[str] | None) -> str:
    """Join a list of E2B log chunks into a single text blob.

    E2B ``Logs.stdout`` / ``Logs.stderr`` are lists of chunks whose entries
    already carry their own newlines, so they are concatenated with no
    separator to avoid doubling line breaks. ``None`` collapses to ``""``.
    """
    if not chunks:
        return ""
    return "".join(chunks)


def _normalize_type(file_type: FileType | None) -> str:
    """Normalize an E2B ``FileType`` entry to a plain string.

    ``FileType.FILE`` / ``FileType.DIR`` map to their ``.value`` (``"file"`` /
    ``"dir"``). A ``None`` type (E2B may omit it for an entry it cannot classify)
    collapses to ``"unknown"`` so every entry carries a JSON-friendly string
    ``type`` and callers never have to handle ``None``.
    """
    if file_type is None:
        return "unknown"
    return str(file_type.value)


def _require_str(args: dict[str, Any], key: str, *, allow_empty: bool = False) -> str | None:
    """Return ``args[key]`` when it is a valid string, else ``None``.

    Guards a *required* argument so a malformed tool call (a missing or
    non-string value) is turned into a returned failure rather than a ``KeyError``
    raised out of ``run_async`` — the tools must never raise. ``allow_empty=True``
    permits ``""`` (e.g. writing an empty file); otherwise an empty string is
    rejected like a missing value.
    """
    value = args.get(key)
    if not isinstance(value, str):
        return None
    if not value and not allow_empty:
        return None
    return value
