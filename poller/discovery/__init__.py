"""Public career-board discovery pipeline.

Discovery identifies boards. It does not fetch postings into the public feed,
classify roles for a user, or mutate the hand-curated company registry.
"""

from poller.discovery.models import BoardCandidate

__all__ = ["BoardCandidate"]
