"""Read pushes use synthetic IDs and mocked UI calls; never open Messages."""
import importlib.machinery
import importlib.util
from pathlib import Path
import unittest
import os
import tempfile
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from subprocess import CompletedProcess

loader = importlib.machinery.SourceFileLoader("imsg_read", str(Path(__file__).with_name("imsg-read")))
spec = importlib.util.spec_from_loader(loader.name, loader)
read = importlib.util.module_from_spec(spec)
loader.exec_module(read)


class ReadTests(unittest.TestCase):
    def test_group_and_direct_urls(self):
        for identifier, key in [("chat12345", "groupid"), ("a" * 32, "groupid"),
                                ("+15551234567", "address"), ("12345", "address"),
                                ("person+tag@example.com", "address")]:
            self.assertEqual(parse_qs(urlparse(read.chat_url(identifier)).query), {key: [identifier]})
            self.assertTrue(read.chat_url(identifier).startswith("imessage:open?"))

    def test_private_lock_refuses_symlinks(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(read.os.path, "expanduser", return_value=folder):
            with read.messages_ui_lock():
                self.assertEqual(os.stat(Path(folder) / "messages-ui.lock").st_mode & 0o777, 0o600)
            (Path(folder) / "messages-ui.lock").unlink()
            (Path(folder) / "messages-ui.lock").symlink_to(Path(folder) / "other")
            with self.assertRaises(OSError):
                with read.messages_ui_lock():
                    self.fail("symlink lock accepted")

    def test_no_url_parameter_injection(self):
        handle = "person&body=wrong@example.com"
        self.assertEqual(parse_qs(urlparse(read.chat_url(handle)).query), {"address": [handle]})
        for value in ["", "group name", "chat123?body=bad", "person\x00@example.com", "a" * 255]:
            with self.assertRaises(ValueError):
                read.chat_url(value)

    def run_chat(self, before=1, select_error="", click_error=""):
        with patch.object(read.sys, "argv", ["imsg-read", "--chat", "chat12345"]), \
             patch.object(read, "ensure_messages", return_value=""), \
             patch.object(read, "accessibility", return_value=""), \
             patch.object(read, "unread_on_mac", return_value=before), \
             patch.object(read, "frontmost", return_value="Previous app"), \
             patch.object(read, "select_chat", return_value=select_error) as select, \
             patch.object(read, "click", return_value=(not click_error, click_error)) as click, \
             patch.object(read, "settle", return_value=0) as settle, \
             patch.object(read, "restore_front") as restore:
            try:
                read.main()
            except SystemExit:
                pass
            return select, click, settle, restore

    def test_group_read_and_focus_restored(self):
        select, click, settle, restore = self.run_chat()
        select.assert_called_once_with("chat12345")
        click.assert_called_once_with("Mark as Read")
        settle.assert_called_once_with(1, "chat12345")
        restore.assert_called_once_with("Previous app")

    def test_open_failure_never_clicks_another_conversation(self):
        _, click, _, restore = self.run_chat(select_error="could not open")
        click.assert_not_called()
        restore.assert_called_once()

    def test_menu_failure_restores_focus(self):
        _, _, _, restore = self.run_chat(click_error="not available")
        restore.assert_called_once()

    def test_url_dispatch_without_a_window_is_not_selection_success(self):
        with patch.object(read.subprocess, "run", return_value=CompletedProcess([], 0)), \
             patch.object(read, "osa", return_value=(0, "0")):
            self.assertIn("no accessible window", read.select_chat("chat12345"))

    def test_failed_url_dispatch_does_not_query_or_click_a_window(self):
        with patch.object(read.subprocess, "run", return_value=CompletedProcess([], 1)), \
             patch.object(read, "osa") as osa:
            self.assertIn("could not open", read.select_chat("chat12345"))
            osa.assert_not_called()

    def test_already_read_never_opens_messages(self):
        select, click, settle, restore = self.run_chat(before=0)
        for call in (select, click, settle, restore):
            call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
