"""Select, extract, validate, and checkpoint Pi sessions for Insights."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

DEFAULT_BATCH_SIZE = 30
MAX_BATCH_SIZE = 30


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.replace(temporary, path)


def load_reviewed(state_path: Path) -> set[str]:
    if not state_path.exists():
        write_json_atomic(state_path, [])
        return set()
    value = json.loads(state_path.read_text())
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{state_path} must contain a JSON array of session IDs")
    return set(value)


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        block["text"]
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def active_branch(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {
        entry["id"]: entry for entry in entries if isinstance(entry.get("id"), str)
    }
    if not by_id:
        return []
    current = next(
        entry for entry in reversed(entries) if isinstance(entry.get("id"), str)
    )
    branch = []
    seen = set()
    while current:
        entry_id = current["id"]
        if entry_id in seen:
            raise ValueError(f"cycle at entry {entry_id}")
        seen.add(entry_id)
        branch.append(current)
        parent_id = current.get("parentId")
        if parent_id is None:
            break
        current = by_id.get(parent_id)
        if current is None:
            raise ValueError(f"missing parent entry {parent_id}")
    return list(reversed(branch))


def evidence_record(entry: dict[str, Any]) -> dict[str, Any] | None:
    base = {"record_id": entry["id"], "timestamp": entry.get("timestamp")}
    if entry.get("type") == "model_change":
        return {
            **base,
            "type": "model_change",
            "provider": entry.get("provider"),
            "model_id": entry.get("modelId"),
        }
    if (
        entry.get("type") == "custom_message"
        and entry.get("customType") == "subagent-result"
    ):
        details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
        return {
            **base,
            "type": "subagent_result",
            "status": details.get("status"),
            "title": details.get("title"),
            "text": content_text(entry.get("content")),
        }
    if entry.get("type") != "message" or not isinstance(entry.get("message"), dict):
        return None
    message = entry["message"]
    role = message.get("role")
    text = content_text(message.get("content"))
    if role in ("user", "assistant"):
        return {
            **base,
            "type": "message",
            "role": role,
            "text": text,
            **(
                {"stop_reason": message.get("stopReason")}
                if role == "assistant"
                else {}
            ),
            **(
                {"error": message.get("errorMessage")}
                if message.get("errorMessage")
                else {}
            ),
        }
    if role == "toolResult" and message.get("isError"):
        return {
            **base,
            "type": "tool_error",
            "tool_name": message.get("toolName"),
            "text": text,
        }
    return None


def extract_session(path: Path) -> dict[str, Any] | None:
    header = None
    entries = []
    try:
        for line in path.read_text().splitlines():
            value = json.loads(line)
            if value.get("type") == "session":
                header = value
            else:
                entries.append(value)
        if header is None:
            raise ValueError("missing session header")
        branch = active_branch(entries)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Skipping {path}: {error}", file=sys.stderr)
        return None

    records = [
        record for entry in branch if (record := evidence_record(entry)) is not None
    ]
    if not any(
        record.get("type") == "message" and record.get("role") == "user"
        for record in records
    ):
        return None
    session_id = header.get("id")
    if not isinstance(session_id, str) or not session_id:
        session_id = path.stem.rsplit("_", 1)[-1]
    transcript = [
        {
            key: value
            for key, value in record.items()
            if key not in ("record_id", "timestamp")
        }
        for record in records
    ]
    transcript_hash = hashlib.sha256(
        json.dumps(transcript, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    return {
        "id": session_id,
        "source_ids": [session_id],
        "file": str(path),
        "cwd": header.get("cwd"),
        "ts": header.get("timestamp"),
        "transcript_hash": transcript_hash,
        "records": records,
    }


def discover_sessions(
    session_root: Path, active_file: Path | None = None
) -> list[dict[str, Any]]:
    sessions = []
    active = active_file.resolve() if active_file else None
    for path in session_root.glob("**/*.jsonl"):
        if active and path.resolve() == active:
            continue
        session = extract_session(path)
        if session:
            sessions.append(session)

    groups: dict[str, dict[str, Any]] = {}
    seen_ids = set()
    for session in sorted(
        sessions, key=lambda item: (item.get("ts") or "", item["file"]), reverse=True
    ):
        if session["id"] in seen_ids:
            continue
        seen_ids.add(session["id"])
        existing = groups.get(session["transcript_hash"])
        if existing is None:
            groups[session["transcript_hash"]] = session
            continue
        if session["id"] not in existing["source_ids"]:
            existing["source_ids"].append(session["id"])
    return list(groups.values())


def select_sessions(
    sessions: list[dict[str, Any]],
    reviewed: set[str],
    cwd_filters: list[str],
    session_filters: list[str],
    limit: int | None,
) -> list[dict[str, Any]]:
    selected = [
        session for session in sessions if reviewed.isdisjoint(session["source_ids"])
    ]
    if cwd_filters:
        selected = [
            session
            for session in selected
            if isinstance(session.get("cwd"), str)
            and any(value in session["cwd"] for value in cwd_filters)
        ]
    if session_filters:
        wanted = set(session_filters)
        selected = [
            session
            for session in selected
            if not wanted.isdisjoint(session["source_ids"])
        ]
    selected.sort(key=lambda item: (item.get("ts") or "", item["id"]), reverse=True)
    return selected if limit is None else selected[:limit]


def metadata(session: dict[str, Any]) -> dict[str, Any]:
    records = session["records"]
    return {
        key: session[key]
        for key in ("id", "source_ids", "file", "cwd", "ts", "transcript_hash")
    } | {
        "message_count": sum(record.get("type") == "message" for record in records),
        "model_change_count": sum(
            record.get("type") == "model_change" for record in records
        ),
        "subagent_error_count": sum(
            record.get("type") == "subagent_result" and record.get("status") == "error"
            for record in records
        ),
        "tool_error_count": sum(
            record.get("type") == "tool_error" for record in records
        ),
    }


CITABLE_TYPES = {
    ("message", "user"),
    ("tool_error", None),
    ("subagent_result", None),
}


def citable_records(session: dict[str, Any]) -> dict[str, str]:
    """Return {record_id: text} for all records that may be cited as evidence."""
    out: dict[str, str] = {}
    for record in session["records"]:
        rtype = record.get("type")
        role = record.get("role")
        if (rtype, role) in CITABLE_TYPES or (rtype, None) in CITABLE_TYPES:
            text = record.get("text") or ""
            out[record["record_id"]] = text
    return out


def validate_result(session: dict[str, Any], result: Any) -> None:
    if not isinstance(result, dict):
        raise TypeError("result must be a JSON object")
    pain_points = result.get("pain_points")
    if not isinstance(pain_points, list):
        raise TypeError("pain_points must be an array")
    if not isinstance(result.get("already_addressed_by"), str):
        raise TypeError("already_addressed_by must be a string")
    citable = citable_records(session)
    for index, point in enumerate(pain_points):
        if not isinstance(point, dict):
            raise TypeError(f"pain_points[{index}] must be an object")
        record_id = point.get("record_id")
        quote = point.get("quote")
        severity = point.get("severity")
        if record_id not in citable:
            raise ValueError(
                f"pain_points[{index}].record_id is not a citable record "
                f"(user message, tool_error, or subagent_result)"
            )
        if (
            not isinstance(quote, str)
            or not quote
            or quote not in citable[record_id]
        ):
            raise ValueError(
                f"pain_points[{index}].quote is not exact evidence from its record"
            )
        if not isinstance(point.get("category"), str) or not point["category"]:
            raise ValueError(
                f"pain_points[{index}].category must be a non-empty string"
            )
        if (
            isinstance(severity, bool)
            or not isinstance(severity, int)
            or not 1 <= severity <= 3
        ):
            raise ValueError(f"pain_points[{index}].severity must be 1, 2, or 3")


def checkpoint(state_path: Path, session: dict[str, Any]) -> None:
    reviewed = load_reviewed(state_path)
    reviewed.update(session["source_ids"])
    write_json_atomic(state_path, sorted(reviewed))


def add_selection_arguments(
    parser: argparse.ArgumentParser, default_limit: int | None
) -> None:
    parser.add_argument(
        "--cwd", action="append", default=[], help="Include CWDs containing this value"
    )
    parser.add_argument(
        "--session", action="append", default=[], help="Include this session ID"
    )
    parser.add_argument("--limit", type=int, default=default_limit)
    parser.add_argument(
        "--include-reviewed",
        action="store_true",
        help="Include sessions already in reviewed.json",
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--session-root",
        type=Path,
        default=Path("~/.pi/agent/sessions").expanduser(),
    )
    parser.add_argument(
        "--state",
        type=Path,
        default=Path("~/.pi/agent/skills/insights/reviewed.json").expanduser(),
    )
    commands = parser.add_subparsers(dest="command", required=True)

    list_parser = commands.add_parser("list", help="List unreviewed session metadata")
    add_selection_arguments(list_parser, None)

    extract_parser = commands.add_parser(
        "extract", help="Write a bounded batch to individual JSON files"
    )
    add_selection_arguments(extract_parser, DEFAULT_BATCH_SIZE)
    extract_parser.add_argument("--output-dir", type=Path, required=True)
    extract_parser.add_argument(
        "--file",
        action="append",
        dest="files",
        default=[],
        type=Path,
        help="Extract a specific session file (bypasses discovery and reviewed filter)",
    )

    read_parser = commands.add_parser(
        "read",
        help="Print the formatted transcript of one session (by ID or file path)",
    )
    read_group = read_parser.add_mutually_exclusive_group(required=True)
    read_group.add_argument("--session", dest="read_session", help="Session ID")
    read_group.add_argument(
        "--file", dest="read_file", type=Path, help="Session .jsonl file path"
    )

    validate_parser = commands.add_parser(
        "validate", help="Validate one result and optionally checkpoint it"
    )
    validate_parser.add_argument("--session-file", type=Path, required=True)
    validate_parser.add_argument("--result-file", type=Path, required=True)
    validate_parser.add_argument("--checkpoint", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.command == "validate":
            session = json.loads(args.session_file.read_text())
            result = json.loads(args.result_file.read_text())
            validate_result(session, result)
            if args.checkpoint:
                checkpoint(args.state, session)
            print(json.dumps({"valid": True, "source_ids": session["source_ids"]}))
            return 0

        if args.command == "read":
            if args.read_file:
                session = extract_session(args.read_file)
                if session is None:
                    raise ValueError(f"Could not parse session from {args.read_file}")
            else:
                active_file = (
                    Path(value).expanduser()
                    if (value := os.environ.get("PI_SESSION_FILE"))
                    else None
                )
                all_sessions = discover_sessions(args.session_root, active_file)
                matches = [
                    s for s in all_sessions if args.read_session in s["source_ids"]
                ]
                if not matches:
                    raise ValueError(f"Session {args.read_session!r} not found")
                session = matches[0]
            print(json.dumps(session, indent=2))
            return 0

        if args.limit is not None and args.limit < 1:
            raise ValueError("--limit must be positive")
        if args.command == "extract" and args.limit > MAX_BATCH_SIZE:
            raise ValueError(f"--limit must be at most {MAX_BATCH_SIZE}")
        active_file = (
            Path(value).expanduser()
            if (value := os.environ.get("PI_SESSION_FILE"))
            else None
        )
        reviewed = load_reviewed(args.state)
        effective_reviewed = set() if getattr(args, "include_reviewed", False) else reviewed

        if args.command == "extract" and getattr(args, "files", []):
            # Extract specific files directly, bypassing discovery and reviewed filter
            direct_sessions = []
            for file_path in args.files:
                s = extract_session(file_path)
                if s:
                    direct_sessions.append(s)
            sessions_to_write = direct_sessions
        else:
            sessions = discover_sessions(args.session_root, active_file)
            selected = select_sessions(
                sessions, effective_reviewed, args.cwd, args.session, args.limit
            )
            sessions_to_write = selected

        if args.command == "list":
            sessions = discover_sessions(args.session_root, active_file)
            selected = select_sessions(
                sessions, effective_reviewed, args.cwd, args.session, args.limit
            )
            print(json.dumps([metadata(session) for session in selected], indent=2))
            return 0

        args.output_dir.mkdir(parents=True, exist_ok=True)
        index = []
        for session in sessions_to_write:
            session_path = args.output_dir / f"{session['id']}.json"
            write_json_atomic(session_path, session)
            index.append(metadata(session) | {"path": str(session_path)})
        index_path = args.output_dir / "index.json"
        write_json_atomic(index_path, index)
        print(index_path)
        return 0
    except (OSError, json.JSONDecodeError, TypeError, ValueError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
