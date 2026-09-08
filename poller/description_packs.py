"""Immutable public document packs. Publish packs before referring feed shards."""

from __future__ import annotations

import hashlib
import json
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

    from poller.models import Posting

_PACK = re.compile(r"details/[0-9a-f]{2}-[0-9a-f]{64}\.json")


def write_description_packs(
    directory: Path, postings: dict[str, Posting],
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
        payload = (json.dumps({"version": 1, "documents": dict(sorted(texts.items()))},
                              ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
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
    # Old content-addressed files remain readable by clients holding older manifests.
    return {pid: refs[digest] for pid, digest in hashes.items()}


def read_description_pack(directory: Path, reference: dict[str, Any]) -> str:
    relative = reference.get("pack", "")
    if not isinstance(relative, str) or not _PACK.fullmatch(relative):
        raise ValueError("invalid description pack path")
    payload = (directory / relative).read_bytes()
    if hashlib.sha256(payload).hexdigest() != reference.get("pack_sha256"):
        raise ValueError("description pack hash mismatch")
    data = json.loads(payload)
    if data.get("version") != 1 or not isinstance(data.get("documents"), dict):
        raise ValueError("invalid description pack schema")
    text = data["documents"].get(reference.get("sha256"))
    if (not isinstance(text, str)
            or hashlib.sha256(text.encode()).hexdigest() != reference["sha256"]):
        raise ValueError("description document hash mismatch")
    return text
