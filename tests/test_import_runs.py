import json
from pathlib import Path

from app.engine.import_runs import events_near, runs_from_document


def test_a_typescript_run_record_is_kept_and_a_broken_one_is_skipped():
    raw = [
        {
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "title": "Old task",
            "task": "do the old thing",
            "status": "done",
            "workflow": "quick-task",
            "runner": "claude",
            "createdAt": "2026-01-01T00:00:00Z",
            "branch": "cez/aaaaaaaa",
            "archived": True,
        },
        {"id": "not-an-id", "task": "nope", "status": "done", "createdAt": "2026-01-01T00:00:00Z"},
        "nope",
    ]
    runs, skipped = runs_from_document(raw, "proj")
    assert skipped == 2
    assert runs[0].id == "aaaaaaaabbbbccccddddeeeeeeeeeeee"
    assert runs[0].status == "done"
    assert runs[0].archived is True
    assert runs[0].task == "do the old thing"


def test_event_ndjson_beside_runs_json_is_imported(tmp_path: Path):
    runs_json = tmp_path / "runs.json"
    runs_json.write_text("[]", encoding="utf-8")
    run_id = "a" * 32
    folder = tmp_path / "runs"
    folder.mkdir()
    (folder / f"{run_id}.ndjson").write_text(
        "\n".join(
            [
                json.dumps({"type": "note", "message": "hello", "stepId": "s", "ts": "t"}),
                "not json",
                json.dumps({"type": "text", "text": "body"}),
            ]
        ),
        encoding="utf-8",
    )
    rows = events_near(runs_json, run_id)
    assert rows[0] == {"type": "note", "text": "hello", "step_id": "s", "at": "t"}
    assert rows[1]["text"] == "body"
