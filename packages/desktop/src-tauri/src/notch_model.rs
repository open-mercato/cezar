//! What the notch shows, with no macOS in it (spec `.ai/specs/2026-11-01-desktop-notch.md`).
//! `fixtures/notch-model.json` pins these rules as input/output pairs, so the iOS widgets can
//! replay them without reading Rust.

use serde::{Deserialize, Serialize};

/// Pill 2's capacity; the rest of the active managers read as `overflow`.
pub const MAX_MINIS: usize = 4;
/// Pill 1's text in characters. CSS fits it to the wing; this keeps a long line out of the page.
pub const TEXT_LIMIT: usize = 48;
/// `error` sticks until the manager's next turn, so only a fresh one counts as active.
pub const ERROR_ACTIVE_MINUTES: u64 = 30;

/// The fields of `ManagerSummary` this module reads. Unknown keys, and fields a newer or older
/// sidecar lacks, must not lose the row: every field defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ManagerRow {
    pub id: String,
    pub name: String,
    pub avatar: u8,
    pub status: String,
    pub preview: Option<String>,
    pub pending_actions: u32,
    pub pending_questions: u32,
    pub last_activity_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Face {
    NeedsYou,
    Error,
    Working,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub avatar: u8,
    pub face: Face,
    /// The `preview` line, or a status sentence when there is none.
    pub text: String,
    /// "1 approval · 2 questions"; absent when nothing is pending.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mini {
    pub id: String,
    pub name: String,
    pub avatar: u8,
    pub face: Face,
}

/// `None` from `shape` is the third state: nothing active, the notch is out of the way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchModel {
    /// Pill 1.
    pub primary: Entry,
    /// Pill 2, empty when one manager is active. Never repeats `primary`.
    pub minis: Vec<Mini>,
    /// Active managers beyond `primary` and `minis`.
    pub overflow: usize,
    /// Everyone active in display order, `primary` first: the expanded list.
    pub active: Vec<Entry>,
}

fn pending_count(row: &ManagerRow) -> u32 {
    row.pending_actions.saturating_add(row.pending_questions)
}

/// One face per manager. What the user must act on outranks what the manager is doing.
pub fn face_of(row: &ManagerRow) -> Face {
    if pending_count(row) > 0 {
        Face::NeedsYou
    } else if row.status == "error" {
        Face::Error
    } else if row.status == "working" {
        Face::Working
    } else {
        Face::Idle
    }
}

/// `error_since` is an ISO-8601 UTC instant; the sidecar stamps with `toISOString`, so ordering
/// the strings orders the instants.
pub fn is_active(row: &ManagerRow, error_since: &str) -> bool {
    match face_of(row) {
        Face::NeedsYou | Face::Working => true,
        Face::Error => row.last_activity_at.as_deref().is_some_and(|at| at >= error_since),
        Face::Idle => false,
    }
}

/// Collapse whitespace, drop `[[task:…]]` tokens, cut at a word when one is near.
pub fn truncate_text(raw: &str) -> String {
    let words: Vec<&str> = raw.split_whitespace().filter(|word| !(word.starts_with("[[") && word.ends_with("]]"))).collect();
    let line = words.join(" ");
    if line.chars().count() <= TEXT_LIMIT {
        return line;
    }
    let cut: String = line.chars().take(TEXT_LIMIT - 1).collect();
    let kept = match cut.rfind(' ') {
        Some(at) if cut[..at].chars().count() >= TEXT_LIMIT * 2 / 3 => &cut[..at],
        _ => cut.as_str(),
    };
    format!("{}…", kept.trim_end())
}

fn plural(count: u32, one: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {one}s")
    }
}

fn badge_of(row: &ManagerRow) -> Option<String> {
    let parts: Vec<String> = [(row.pending_actions, "approval"), (row.pending_questions, "question")]
        .into_iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, label)| plural(count, label))
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn text_of(row: &ManagerRow, face: Face) -> String {
    let text = row.preview.as_deref().map(truncate_text).unwrap_or_default();
    if !text.is_empty() {
        return text;
    }
    match face {
        Face::NeedsYou => "Waiting for you",
        Face::Error => "Something went wrong",
        Face::Working => "Working…",
        Face::Idle => "Idle",
    }
    .to_string()
}

/// The display order, decided from `ManagerSummary` alone so a widget gets the same answer: rank
/// by face, then more pending first, then oldest manager. `lastActivityAt` is left out on purpose:
/// it moves on every message, and two working managers would keep swapping pills.
pub fn shape(rows: &[ManagerRow], error_since: &str) -> Option<NotchModel> {
    let mut active: Vec<&ManagerRow> = rows.iter().filter(|row| is_active(row, error_since)).collect();
    active.sort_by(|a, b| {
        face_of(a)
            .cmp(&face_of(b))
            .then_with(|| pending_count(b).cmp(&pending_count(a)))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let entries: Vec<Entry> = active
        .iter()
        .map(|row| {
            let face = face_of(row);
            Entry { id: row.id.clone(), name: row.name.clone(), avatar: row.avatar, face, text: text_of(row, face), badge: badge_of(row) }
        })
        .collect();
    let primary = entries.first()?.clone();
    let others = &entries[1..];
    let minis = others
        .iter()
        .take(MAX_MINIS)
        .map(|entry| Mini { id: entry.id.clone(), name: entry.name.clone(), avatar: entry.avatar, face: entry.face })
        .collect();
    Some(NotchModel { primary, minis, overflow: others.len().saturating_sub(MAX_MINIS), active: entries })
}

/// `GET /api/v1/workspace/managers`'s body. One malformed row is dropped, never the list.
pub fn parse_list(body: &str) -> Option<Vec<ManagerRow>> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let rows = value.get("managers")?.as_array()?;
    Some(rows.iter().filter_map(|row| serde_json::from_value::<ManagerRow>(row.clone()).ok()).filter(|row| !row.id.is_empty()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SINCE: &str = "2026-11-01T11:30:00.000Z";

    fn row(id: &str, status: &str) -> ManagerRow {
        ManagerRow { id: id.into(), name: id.to_uppercase(), status: status.into(), created_at: format!("2026-01-01T00:00:{id}Z"), ..Default::default() }
    }

    /// The portable half: the same file a Swift port replays.
    #[test]
    fn the_fixture_file_holds() {
        let raw = include_str!("../fixtures/notch-model.json");
        let file: serde_json::Value = serde_json::from_str(raw).unwrap();
        let cases = file["cases"].as_array().unwrap();
        assert!(cases.len() >= 8);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let rows = parse_list(&serde_json::json!({ "managers": case["managers"] }).to_string()).unwrap();
            let got = serde_json::to_value(shape(&rows, case["errorSince"].as_str().unwrap())).unwrap();
            assert_eq!(got, case["expected"], "{name}");
        }
    }

    #[test]
    fn idle_with_nothing_pending_is_not_active() {
        assert_eq!(shape(&[row("1", "idle")], SINCE), None);
        assert_eq!(shape(&[], SINCE), None);
    }

    #[test]
    fn a_stale_error_is_not_active_but_a_fresh_one_is() {
        let mut fresh = row("1", "error");
        fresh.last_activity_at = Some("2026-11-01T11:45:00.000Z".into());
        let mut stale = fresh.clone();
        stale.last_activity_at = Some("2026-11-01T09:00:00.000Z".into());
        let mut unknown = fresh.clone();
        unknown.last_activity_at = None;
        assert!(is_active(&fresh, SINCE));
        assert!(!is_active(&stale, SINCE));
        assert!(!is_active(&unknown, SINCE));
    }

    #[test]
    fn needs_you_outranks_every_status() {
        for status in ["working", "error", "idle"] {
            let mut waiting = row("1", status);
            waiting.pending_questions = 1;
            assert_eq!(face_of(&waiting), Face::NeedsYou, "{status}");
        }
    }

    #[test]
    fn needs_you_takes_pill_one_from_an_older_working_manager() {
        let working = row("1", "working");
        let mut waiting = row("2", "idle");
        waiting.pending_actions = 1;
        let model = shape(&[working, waiting], SINCE).unwrap();
        assert_eq!(model.primary.id, "2");
        assert_eq!(model.minis.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["1"]);
    }

    #[test]
    fn activity_never_reorders_two_working_managers() {
        let older = row("1", "working");
        let mut newer = row("2", "working");
        newer.last_activity_at = Some("2026-11-01T12:00:00.000Z".into());
        assert_eq!(shape(&[newer.clone(), older.clone()], SINCE).unwrap().primary.id, "1");
        assert_eq!(shape(&[older, newer], SINCE).unwrap().primary.id, "1");
    }

    #[test]
    fn pill_two_counts_what_it_cannot_show() {
        let rows = |count: u32| (1..=count).map(|n| row(&format!("{n}"), "working")).collect::<Vec<_>>();
        assert!(shape(&rows(1), SINCE).unwrap().minis.is_empty());
        let five = shape(&rows(5), SINCE).unwrap();
        assert_eq!((five.minis.len(), five.overflow), (4, 0));
        let seven = shape(&rows(7), SINCE).unwrap();
        assert_eq!((seven.minis.len(), seven.overflow, seven.active.len()), (4, 2, 7));
    }

    #[test]
    fn text_is_one_short_line() {
        assert_eq!(truncate_text("  two\n\nlines  "), "two lines");
        assert_eq!(truncate_text("Started [[task:cezar/abc]] for you"), "Started for you");
        let long = truncate_text(&"word ".repeat(40));
        assert!(long.chars().count() <= TEXT_LIMIT, "{long}");
        assert!(long.ends_with("word…"), "{long}");
        // No space to cut at, and multibyte text must not split a character.
        assert_eq!(truncate_text(&"ż".repeat(100)).chars().count(), TEXT_LIMIT);
    }

    #[test]
    fn a_missing_preview_still_says_something() {
        let model = shape(&[row("1", "working")], SINCE).unwrap();
        assert_eq!(model.primary.text, "Working…");
        let mut blank = row("1", "working");
        blank.preview = Some("[[task:a/b]]".into());
        assert_eq!(shape(&[blank], SINCE).unwrap().primary.text, "Working…");
    }

    #[test]
    fn the_badge_names_what_is_pending() {
        let mut waiting = row("1", "idle");
        waiting.pending_actions = 2;
        waiting.pending_questions = 1;
        assert_eq!(badge_of(&waiting).as_deref(), Some("2 approvals · 1 question"));
        assert_eq!(badge_of(&row("1", "idle")), None);
    }

    #[test]
    fn a_bad_row_costs_that_row_only() {
        let parsed = parse_list(r#"{"managers":[{"id":"ok","status":"working","extra":true},{"id":"x","avatar":"nope"},{"name":"no id"}]}"#).unwrap();
        assert_eq!(parsed.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["ok"]);
        assert_eq!(parse_list("<html>"), None);
        assert_eq!(parse_list("{}"), None);
    }
}
