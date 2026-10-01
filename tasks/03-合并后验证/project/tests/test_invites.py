import unittest
from invites import can_resend

class InvitationTests(unittest.TestCase):
    def test_expired_pending_can_resend(self):
        self.assertTrue(can_resend('pending', True))

    def test_live_pending_cannot_resend(self):
        self.assertFalse(can_resend('pending', False))

    def test_accepted_cannot_resend(self):
        self.assertFalse(can_resend('accepted', True))

    def test_revoked_cannot_resend(self):
        self.assertFalse(can_resend('revoked', True))
