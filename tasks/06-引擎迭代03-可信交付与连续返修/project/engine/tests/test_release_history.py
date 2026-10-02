"""Bind the 0.2.0 changelog preservation proof to U5's frozen input fingerprint."""
import hashlib
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PROOF = ROOT / 'docs' / '12-0.2.0变更保留证据.md'
# Copied from this unit's read-only input.json, not derived from the candidate.
INPUT_CHANGELOG_SHA256 = '109f8febc30cc617c89b852ffab23adcefa4f3ba76a95f01de639a8ad886f3fd'
INPUT_CHANGELOG_BYTES = 2531
OLD_HEADER = '# 更新记录\n\n## 未发布\n\n'.encode('utf-8')
RELEASE_HEADING = b'## 0.2.0\n\n'


class ReleaseHistoryTests(unittest.TestCase):
    def old_changelog(self):
        document = PROOF.read_bytes()
        opening = b'\n```text\n'
        closing = b'\n```\n'
        self.assertEqual(document.count(opening), 1)
        _, _, rest = document.partition(opening)
        body, separator, _ = rest.partition(closing)
        self.assertEqual(separator, closing)
        return body + b'\n'

    def test_reconstructed_body_matches_frozen_input(self):
        original = self.old_changelog()
        self.assertEqual(len(original), INPUT_CHANGELOG_BYTES)
        self.assertEqual(hashlib.sha256(original).hexdigest(), INPUT_CHANGELOG_SHA256)
        self.assertTrue(original.startswith(OLD_HEADER))
        self.assertEqual(original.count(b'\n- '), 7)

    def test_release_preserves_all_existing_entries_and_010_bytes(self):
        original = self.old_changelog()
        current = (ROOT / 'CHANGELOG.md').read_bytes()
        self.assertTrue(current.startswith('# 更新记录\n\n'.encode('utf-8')))
        self.assertEqual(current.count(RELEASE_HEADING), 1)
        _, _, released = current.partition(RELEASE_HEADING)
        note, separator, preserved = released.partition(b'\n\n')
        self.assertEqual(separator, b'\n\n')
        self.assertTrue(note.startswith(b'- '))
        self.assertIn(b'checksums', note)
        self.assertEqual(released.count(b'\n- ') + int(released.startswith(b'- ')), 8)
        # The inverse promotion must reproduce the entire frozen file, including
        # the 0.1.0 section's exact whitespace and final LF, not just its bullets.
        self.assertEqual(OLD_HEADER + preserved, original)


if __name__ == '__main__':
    unittest.main()
