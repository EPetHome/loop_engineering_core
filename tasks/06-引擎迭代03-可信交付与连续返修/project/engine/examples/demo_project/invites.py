"""Example product behavior: resend an expired, pending invitation."""
def can_resend(status: str, expired: bool) -> bool:
    return False  # Known defect for the offline execution demonstration.
