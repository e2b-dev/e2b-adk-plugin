"""Unit tests for the result-contract helpers and output truncation."""

from __future__ import annotations

from e2b_adk._results import (
    DEFAULT_MAX_OUTPUT_BYTES,
    failure_result,
    success_result,
    truncate_output,
)


def test_success_shape() -> None:
    result = success_result(stdout="hi", exit_code=0)
    assert result == {"success": True, "stdout": "hi", "exit_code": 0}


def test_failure_shape() -> None:
    result = failure_result(
        "file not found",
        path="/tmp/missing.txt",
        partial_output="some bytes",
    )
    assert result["success"] is False
    assert result["error"] == "file not found"
    # echoed input relevant to the call
    assert result["path"] == "/tmp/missing.txt"
    # partial_output field always present
    assert result["partial_output"] == "some bytes"


def test_failure_echoes_command() -> None:
    result = failure_result("boom", command="ls /nope")
    assert result["command"] == "ls /nope"
    assert result["partial_output"] == ""
    # only the relevant echoed input is present
    assert "path" not in result


def test_truncation_marker() -> None:
    text = "a" * (DEFAULT_MAX_OUTPUT_BYTES + 431)
    out = truncate_output(text)
    omitted = len(text.encode("utf-8")) - DEFAULT_MAX_OUTPUT_BYTES
    assert out.endswith(f"…[truncated {omitted:,} bytes]")
    # retained content is bounded to the limit
    assert out.startswith("a" * DEFAULT_MAX_OUTPUT_BYTES)
    assert omitted == 431


def test_truncation_multibyte_boundary() -> None:
    # 'é' is two bytes in UTF-8; ensure we never split a character.
    text = "é" * 6000  # 12_000 bytes, over the 10_000 limit
    out = truncate_output(text)
    assert "…[truncated" in out
    # the kept prefix must be valid UTF-8 (no partial char) — re-encodes cleanly
    out.encode("utf-8")


def test_no_truncation_when_small() -> None:
    text = "short output"
    assert truncate_output(text) == text
    assert "truncated" not in truncate_output(text)


def test_no_truncation_at_exact_limit() -> None:
    text = "a" * DEFAULT_MAX_OUTPUT_BYTES
    assert truncate_output(text) == text
