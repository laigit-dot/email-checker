import json
import tempfile
import unittest
from pathlib import Path

from organizer_core import (
    Classification,
    OrganizerEngine,
    OrganizerSettings,
    ReportWriter,
    SecretStore,
    SlackReporter,
    normalize_classification,
)


class OrganizerSettingsTests(unittest.TestCase):
    def test_round_trip_preserves_safe_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            original = OrganizerSettings(
                ollama_url="http://server:11434",
                model="qwen3:8b",
                selected_accounts=["one@example.com"],
                mark_as_read=True,
                dry_run=False,
            )

            original.save(path)
            restored = OrganizerSettings.load(path)

            self.assertEqual(restored.ollama_url, "http://server:11434")
            self.assertEqual(restored.model, "qwen3:8b")
            self.assertEqual(restored.selected_accounts, ["one@example.com"])
            self.assertTrue(restored.mark_as_read)
            self.assertFalse(restored.dry_run)

    def test_missing_settings_use_non_destructive_defaults(self) -> None:
        settings = OrganizerSettings.load(Path("does-not-exist.json"))

        self.assertTrue(settings.dry_run)
        self.assertFalse(settings.mark_as_read)
        self.assertTrue(settings.unread_only)


class ClassificationTests(unittest.TestCase):
    def test_unknown_folder_falls_back_to_review(self) -> None:
        result = normalize_classification(
            json.dumps(
                {
                    "folder": "Delete Everything",
                    "summary": "Suspicious output",
                    "reason": "Unknown folder",
                    "confidence": 0.9,
                }
            ),
            ["Action Required", "Receipts", "Review"],
            confidence_threshold=0.65,
        )

        self.assertEqual(result.folder, "Review")

    def test_low_confidence_falls_back_to_review(self) -> None:
        result = normalize_classification(
            json.dumps(
                {
                    "folder": "Receipts",
                    "summary": "Maybe a receipt",
                    "reason": "Not enough information",
                    "confidence": 0.3,
                }
            ),
            ["Receipts", "Review"],
            confidence_threshold=0.65,
        )

        self.assertEqual(result.folder, "Review")
        self.assertEqual(result.confidence, 0.3)

    def test_boolean_confidence_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            normalize_classification(
                json.dumps(
                    {
                        "folder": "Receipts",
                        "summary": "Invoice",
                        "reason": "Looks like a receipt",
                        "confidence": True,
                    }
                ),
                ["Receipts", "Review"],
                confidence_threshold=0.65,
            )


class ReportWriterTests(unittest.TestCase):
    def test_report_writes_csv_and_summary_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            writer = ReportWriter(Path(directory))
            writer.add(
                {
                    "account": "one@example.com",
                    "subject": "Invoice",
                    "folder": "Receipts",
                    "status": "moved",
                }
            )

            csv_path, json_path = writer.finish()

            self.assertTrue(csv_path.exists())
            self.assertTrue(json_path.exists())
            self.assertIn("Invoice", csv_path.read_text(encoding="utf-8-sig"))
            summary = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["totals"]["moved"], 1)

    def test_report_escapes_spreadsheet_formulas(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            writer = ReportWriter(Path(directory))
            writer.add({"subject": "=HYPERLINK(\"bad\")", "status": "dry-run"})

            csv_path, _ = writer.finish()

            self.assertIn(
                "'=HYPERLINK",
                csv_path.read_text(encoding="utf-8-sig"),
            )


class IntegrationSettingsTests(unittest.TestCase):
    def test_secret_store_round_trip_uses_persistence(self) -> None:
        class FakePersistence:
            value = ""

            def load(self):
                if not self.value:
                    raise RuntimeError("not found")
                return self.value

            def save(self, value):
                self.value = value

        persistence = FakePersistence()
        store = SecretStore(persistence=persistence)

        store.set("ollama_api_key", "ollama-secret")
        store.set("slack_webhook_url", "https://hooks.slack.com/services/test")

        self.assertEqual(store.get("ollama_api_key"), "ollama-secret")
        self.assertEqual(
            store.get("slack_webhook_url"),
            "https://hooks.slack.com/services/test",
        )
        self.assertNotIn("ollama-secret", repr(store))

    def test_slack_payload_has_fallback_and_status_fields(self) -> None:
        payload = SlackReporter.build_payload(
            {"moved": 4, "dry-run": 2, "failed": 1},
            account_count=3,
            mode="LIVE",
            report_name="email-organization.csv",
        )

        self.assertIn("4 moved", payload["text"])
        self.assertEqual(payload["blocks"][0]["type"], "header")
        fields = payload["blocks"][1]["fields"]
        self.assertTrue(any("*Failed*" in field["text"] for field in fields))


class OrganizerEngineTests(unittest.TestCase):
    def test_marks_new_message_id_read_only_after_move(self) -> None:
        calls: list[tuple[str, str]] = []

        class FakeGraph:
            def list_inbox(self, token, count, unread_only):
                return [
                    {
                        "id": "old-id",
                        "subject": "Invoice",
                        "from": {"emailAddress": {"address": "vendor@example.com"}},
                    }
                ]

            def ensure_destination(self, token, root, folder):
                calls.append(("folder", folder))
                return "receipts-folder"

            def move_message(self, token, message_id, destination_id):
                calls.append(("move", message_id))
                return {"id": "new-id"}

            def mark_read(self, token, message_id):
                calls.append(("read", message_id))

        class FakeClassifier:
            def classify(self, email, settings):
                return Classification("Receipts", "Invoice", "Purchase", 0.98)

        settings = OrganizerSettings(
            model="test",
            folders=["Receipts", "Review"],
            dry_run=False,
            mark_as_read=True,
        )
        with tempfile.TemporaryDirectory() as directory:
            report = ReportWriter(Path(directory))
            engine = OrganizerEngine(lambda _account: "token", graph=FakeGraph())
            totals = engine.organize_account(
                {"username": "one@example.com"},
                "one@example.com",
                settings,
                FakeClassifier(),
                report,
            )

        self.assertEqual(
            calls,
            [
                ("folder", "Receipts"),
                ("move", "old-id"),
                ("read", "new-id"),
            ],
        )
        self.assertEqual(totals["moved"], 1)

    def test_read_failure_keeps_move_success_in_report(self) -> None:
        class FakeGraph:
            def list_inbox(self, token, count, unread_only):
                return [{"id": "old-id", "subject": "Invoice"}]

            def ensure_destination(self, token, root, folder):
                return "receipts-folder"

            def move_message(self, token, message_id, destination_id):
                return {"id": "new-id"}

            def mark_read(self, token, message_id):
                raise RuntimeError("temporary read update failure")

        class FakeClassifier:
            def classify(self, email, settings):
                return Classification("Receipts", "Invoice", "Purchase", 0.98)

        settings = OrganizerSettings(
            model="test",
            folders=["Receipts", "Review"],
            dry_run=False,
            mark_as_read=True,
        )
        with tempfile.TemporaryDirectory() as directory:
            report = ReportWriter(Path(directory))
            engine = OrganizerEngine(lambda _account: "token", graph=FakeGraph())
            totals = engine.organize_account(
                {"username": "one@example.com"},
                "one@example.com",
                settings,
                FakeClassifier(),
                report,
            )

            self.assertEqual(totals["moved"], 1)
            self.assertEqual(totals["failed"], 0)
            self.assertEqual(report.rows[0]["status"], "moved-read-update-failed")


if __name__ == "__main__":
    unittest.main()
