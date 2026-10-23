"""Regression tests for the database adapter using an isolated temporary SQLite file."""
import tempfile
import unittest
from pathlib import Path

from app import db


class DatabaseAdapterTests(unittest.TestCase):
    def setUp(self):
        self.original_url = db.DATABASE_URL
        self.original_path = db.DB_PATH
        if db._conn is not None:
            db._conn.close()
        db._conn = None
        self.tempdir = tempfile.TemporaryDirectory()
        db.DATABASE_URL = ""
        db.DB_PATH = Path(self.tempdir.name) / "test.db"

    def tearDown(self):
        if db._conn is not None:
            db._conn.close()
        db._conn = None
        db.DATABASE_URL = self.original_url
        db.DB_PATH = self.original_path
        self.tempdir.cleanup()

    def test_insert_update_rows_and_one(self):
        lead_id = db.insert("leads", {"name": "Example Co", "stage": "discovered"})
        self.assertEqual(lead_id, db.one("SELECT id FROM leads WHERE id=?", (lead_id,))["id"])
        db.update("leads", lead_id, {"stage": "qualified", "score": 83})
        row = db.one("SELECT stage, score FROM leads WHERE id=?", (lead_id,))
        self.assertEqual(row, {"stage": "qualified", "score": 83})
        self.assertEqual(len(db.rows("SELECT * FROM leads")), 1)

    def test_transaction_rolls_back_on_exception(self):
        with self.assertRaisesRegex(RuntimeError, "force rollback"):
            with db.tx() as connection:
                connection.execute(
                    "INSERT INTO leads (id, name) VALUES (?, ?)", ("rollback-id", "Rollback Co")
                )
                raise RuntimeError("force rollback")
        self.assertIsNone(db.one("SELECT id FROM leads WHERE id=?", ("rollback-id",)))

    def test_kv_json_and_embedding_bytes_round_trip(self):
        db.kv_set("profile", {"name": "Example", "active": True})
        self.assertEqual(db.kv_get("profile"), {"name": "Example", "active": True})
        payload = bytes([0, 1, 127, 255])
        db.insert("kb_chunks", {"id": "chunk1", "text": "vector bytes", "embedding": payload})
        self.assertEqual(db.one("SELECT embedding FROM kb_chunks WHERE id=?", ("chunk1",))["embedding"], payload)

    def test_event_insert_returns_sequence(self):
        from app import bus
        event = bus.emit("test", "step", "adapter test")
        self.assertIsInstance(event["seq"], int)
        self.assertGreater(event["seq"], 0)

    def test_postgres_placeholder_conversion_ignores_quoted_text_and_comments(self):
        sql = """SELECT '?' AS literal, col FROM t WHERE id=? -- ? ignored
AND name='it''s ?' /* ? */ AND other=?"""
        expected = """SELECT '?' AS literal, col FROM t WHERE id=%s -- ? ignored
AND name='it''s ?' /* ? */ AND other=%s"""
        self.assertEqual(db._convert_placeholders(sql), expected)


if __name__ == "__main__":
    unittest.main()
