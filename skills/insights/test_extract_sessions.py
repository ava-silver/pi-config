import json
import tempfile
import unittest
from pathlib import Path

from extract_sessions import (
    checkpoint,
    discover_sessions,
    extract_session,
    load_reviewed,
    main,
    select_sessions,
    validate_result,
)


class InsightsExtractionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.sessions = self.root / "sessions"
        self.state = self.root / "reviewed.json"

    def tearDown(self):
        self.temporary.cleanup()

    def write_session(
        self, directory, session_id, timestamp="2026-01-01T00:00:00.000Z", text=None
    ):
        directory = self.sessions / directory
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{timestamp.replace(':', '-')}_{session_id}.jsonl"
        long_text = text or ("x" * 600)
        entries = [
            {
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": timestamp,
                "cwd": f"/repo/{directory.name}",
            },
            {
                "type": "model_change",
                "id": "model001",
                "parentId": None,
                "timestamp": timestamp,
                "provider": "test",
                "modelId": "one",
            },
            {
                "type": "message",
                "id": "user0001",
                "parentId": "model001",
                "timestamp": timestamp,
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": long_text}],
                },
            },
            {
                "type": "message",
                "id": "abandon1",
                "parentId": "user0001",
                "timestamp": timestamp,
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "abandoned branch"}],
                },
            },
            {
                "type": "message",
                "id": "assist01",
                "parentId": "user0001",
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "reply"}],
                    "stopReason": "stop",
                },
            },
            {
                "type": "custom_message",
                "id": "custom01",
                "parentId": "assist01",
                "timestamp": timestamp,
                "customType": "subagent-result",
                "content": "failed child",
                "details": {"status": "error", "title": "child"},
            },
            {
                "type": "message",
                "id": "tool0001",
                "parentId": "custom01",
                "timestamp": timestamp,
                "message": {
                    "role": "toolResult",
                    "toolName": "bash",
                    "isError": True,
                    "content": [{"type": "text", "text": "boom"}],
                },
            },
        ]
        path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
        return path

    def test_missing_state_and_header_id_with_underscore_parent(self):
        self.assertEqual(load_reviewed(self.state), set())
        self.assertEqual(json.loads(self.state.read_text()), [])
        path = self.write_session("repo_with_underscore", "session-id")
        self.assertEqual(extract_session(path)["id"], "session-id")

    def test_extracts_active_branch_full_text_and_failure_records(self):
        path = self.write_session("repo", "session-id")
        session = extract_session(path)
        records = session["records"]
        self.assertNotIn("abandoned branch", [record.get("text") for record in records])
        self.assertEqual(
            next(record for record in records if record["record_id"] == "user0001")[
                "text"
            ],
            "x" * 600,
        )
        self.assertEqual(
            next(record for record in records if record["type"] == "model_change")[
                "model_id"
            ],
            "one",
        )
        self.assertEqual(
            next(record for record in records if record["type"] == "subagent_result")[
                "status"
            ],
            "error",
        )
        self.assertEqual(
            next(record for record in records if record["type"] == "tool_error")[
                "text"
            ],
            "boom",
        )

    def test_excludes_active_file_and_deduplicates_transcripts(self):
        self.write_session("one", "older", "2026-01-01T00:00:00.000Z", "same")
        newer = self.write_session("two", "newer", "2026-01-02T00:00:00.000Z", "same")
        grouped = discover_sessions(self.sessions)
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]["id"], "newer")
        self.assertEqual(set(grouped[0]["source_ids"]), {"older", "newer"})
        self.assertEqual(discover_sessions(self.sessions, newer)[0]["id"], "older")

    def test_duplicate_header_id_keeps_newest_session(self):
        self.write_session("one", "same-id", "2026-01-01T00:00:00.000Z", "old")
        self.write_session("two", "same-id", "2026-01-02T00:00:00.000Z", "new")
        sessions = discover_sessions(self.sessions)
        self.assertEqual(len(sessions), 1)
        user = next(
            record for record in sessions[0]["records"] if record.get("role") == "user"
        )
        self.assertEqual(user["text"], "new")

    def test_filters_compose_and_reviewed_duplicates_stay_excluded(self):
        self.write_session("alpha", "alpha-id", "2026-01-01T00:00:00.000Z", "alpha")
        self.write_session("beta", "beta-id", "2026-01-02T00:00:00.000Z", "beta")
        sessions = discover_sessions(self.sessions)
        selected = select_sessions(sessions, set(), ["beta"], ["beta-id"], 30)
        self.assertEqual([session["id"] for session in selected], ["beta-id"])
        self.assertEqual(
            select_sessions(sessions, {"beta-id"}, [], [], 30)[0]["id"], "alpha-id"
        )

    def test_validation_and_checkpoint_require_exact_user_evidence(self):
        session = extract_session(
            self.write_session("repo", "session-id", text="exact user evidence")
        )
        result = {
            "pain_points": [
                {
                    "record_id": "user0001",
                    "quote": "user evidence",
                    "category": "retry",
                    "severity": 2,
                }
            ],
            "already_addressed_by": "none",
        }
        validate_result(session, result)
        checkpoint(self.state, session)
        self.assertEqual(json.loads(self.state.read_text()), ["session-id"])

        for invalid in (
            {
                **result,
                "pain_points": [{**result["pain_points"][0], "record_id": "assist01"}],
            },
            {
                **result,
                "pain_points": [
                    {**result["pain_points"][0], "quote": "normalized evidence"}
                ],
            },
            {**result, "pain_points": [{**result["pain_points"][0], "severity": 4}]},
        ):
            with self.assertRaises(ValueError):
                validate_result(session, invalid)

    def test_cli_validation_checkpoints_only_valid_results(self):
        session = extract_session(
            self.write_session("repo", "session-id", text="exact evidence")
        )
        session_file = self.root / "session.json"
        result_file = self.root / "result.json"
        session_file.write_text(json.dumps(session))
        result = {
            "pain_points": [
                {
                    "record_id": "user0001",
                    "quote": "evidence",
                    "category": "retry",
                    "severity": 2,
                }
            ],
            "already_addressed_by": "none",
        }
        result_file.write_text(json.dumps(result))
        args = [
            "--state",
            str(self.state),
            "validate",
            "--session-file",
            str(session_file),
            "--result-file",
            str(result_file),
            "--checkpoint",
        ]
        self.assertEqual(main(args), 0)
        self.assertEqual(json.loads(self.state.read_text()), ["session-id"])

        self.state.unlink()
        result["pain_points"][0]["quote"] = "not exact"
        result_file.write_text(json.dumps(result))
        self.assertEqual(main(args), 1)
        self.assertFalse(self.state.exists())

    def test_cli_extract_is_bounded_and_writes_index(self):
        for index in range(31):
            self.write_session(
                f"repo-{index}",
                f"session-{index}",
                f"2026-01-{index + 1:02}T00:00:00.000Z",
                f"text-{index}",
            )
        output = self.root / "output"
        code = main(
            [
                "--session-root",
                str(self.sessions),
                "--state",
                str(self.state),
                "extract",
                "--output-dir",
                str(output),
            ]
        )
        self.assertEqual(code, 0)
        self.assertEqual(len(json.loads((output / "index.json").read_text())), 30)
        self.assertEqual(
            main(
                [
                    "--session-root",
                    str(self.sessions),
                    "--state",
                    str(self.state),
                    "extract",
                    "--output-dir",
                    str(output),
                    "--limit",
                    "31",
                ]
            ),
            1,
        )


if __name__ == "__main__":
    unittest.main()
