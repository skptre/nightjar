import sys


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    if dry_run:
        print("nightjar poller: dry-run mode (no git commit/push)")
    else:
        print("nightjar poller: live mode")
    print("poller not yet implemented — scaffold only")
