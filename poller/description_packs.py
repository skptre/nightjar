"""Bounded public document bundles. Publish bundles before referring feed shards."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

    from poller.models import Posting

_PACK = re.compile(r"details/(?:descriptions-[0-9a-f]|[0-9a-f]{2}-[0-9a-f]{64})\.json")


def write_description_packs(
    directory: Path,
    postings: dict[str, Posting],
) -> dict[str, dict[str, str]]:
    documents: dict[str, dict[str, str]] = {}
    hashes: dict[str, str] = {}
    for pid, posting in sorted(postings.items()):
        if not posting.description_text:
            continue
        digest = hashlib.sha256(posting.description_text.encode("utf-8")).hexdigest()
        hashes[pid] = digest
        documents.setdefault(digest[:2], {})[digest] = posting.description_text
    refs: dict[str, dict[str, str]] = {}
    for bucket, texts in sorted(documents.items()):
        payload = (
            json.dumps(
                {"version": 1, "documents": dict(sorted(texts.items()))},
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
        digest = hashlib.sha256(payload).hexdigest()
        relative = f"details/{bucket}-{digest}.json"
        path = directory / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists() or path.read_bytes() != payload:
            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(payload)
            temporary.replace(path)
        for text_hash in texts:
            refs[text_hash] = {"sha256": text_hash, "pack": relative, "pack_sha256": digest}
    # Callers prune obsolete generated files only after writing the referring shards.
    return {pid: refs[digest] for pid, digest in hashes.items()}


def read_description_pack(
    directory: Path,
    reference: dict[str, Any],
    *,
    cache: dict[tuple[str, str], dict[str, Any]] | None = None,
) -> str:
    relative = reference.get("pack", "")
    if not isinstance(relative, str) or not _PACK.fullmatch(relative):
        raise ValueError("invalid description pack path")
    key = (relative, str(reference.get("pack_sha256")))
    data = cache.get(key) if cache is not None else None
    if data is None:
        payload = (directory / relative).read_bytes().replace(b"\r\n", b"\n")
        if hashlib.sha256(payload).hexdigest() != reference.get("pack_sha256"):
            raise ValueError("description pack hash mismatch")
        data = json.loads(payload)
        if cache is not None:
            cache[key] = data
    if data.get("version") != 1 or not isinstance(data.get("documents"), dict):
        raise ValueError("invalid description pack schema")
    text = data["documents"].get(reference.get("sha256"))
    if (
        not isinstance(text, str)
        or hashlib.sha256(text.encode()).hexdigest() != reference["sha256"]
    ):
        raise ValueError("description document hash mismatch")
    return text


def prune_description_packs(
    directory: Path,
    references: dict[str, dict[str, str]],
    *,
    now: datetime | None = None,
) -> None:
    """Keep previous published documents for cache races; bound retention to 72h."""
    details = (directory / "details").resolve()
    keep = {ref["pack"] for ref in references.values()}
    history_path = directory / ".pack-retention"
    try:
        history = json.loads(history_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        history = {}
    now = now or datetime.now(UTC)
    cutoff = (now - timedelta(hours=72)).isoformat()
    # Timestamps measure time since retirement, not time since last publication.
    # A document may remain current for months before its replacement arrives.
    for relative in keep:
        history.pop(relative, None)
    for path in details.glob("*.json"):
        relative = "details/" + path.name
        if _PACK.fullmatch(relative) and relative not in keep:
            history.setdefault(relative, now.isoformat())
            if history.get(relative, "") >= cutoff:
                continue
            if path.is_symlink() or path.resolve().parent != details:
                raise ValueError("unsafe description cleanup path")
            path.unlink()
            history.pop(relative, None)
    history_path.write_text(json.dumps(history, sort_keys=True), encoding="utf-8")
