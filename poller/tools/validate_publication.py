"""Validate every public listing/document reference before publication."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from poller.description_packs import read_description_pack


def validate_publication(directory: Path) -> dict[str, int]:
    meta = json.loads((directory / "meta.json").read_bytes())
    feed_bytes = (directory / "feed.json").read_bytes().replace(b"\r\n", b"\n")
    if hashlib.sha256(feed_bytes).hexdigest() != meta["sha256"]:
        raise ValueError("monolithic feed checksum mismatch")
    feed = json.loads(feed_bytes)
    postings = feed["postings"]
    if len(postings) != meta["count"]:
        raise ValueError("monolithic feed count mismatch")
    collected: dict[str, Any] = {}
    documents: dict[tuple[str, str], str] = {}
    packs: dict[tuple[str, str], dict[str, Any]] = {}
    if meta.get("sharded"):
        for shard_id, info in meta["shards"].items():
            relative = info.get("path", f"{shard_id}.json")
            if info.get("path") and relative != f"snapshots/{info['sha256']}.json":
                raise ValueError("immutable shard path does not match checksum")
            if not re.fullmatch(r"(?:[a-z_]+|snapshots/[a-f0-9]{64})\.json", relative):
                raise ValueError("invalid shard path")
            path = directory / "feed" / relative
            payload = path.read_bytes().replace(b"\r\n", b"\n")
            if hashlib.sha256(payload).hexdigest() != info["sha256"]:
                raise ValueError(f"shard checksum mismatch: {shard_id}")
            shard_data = json.loads(payload)
            shard = shard_data["postings"]
            if shard_data["shard_id"] != shard_id or shard_data["count"] != info["count"]:
                raise ValueError("shard header differs from manifest")
            if len(shard) != info["count"] or collected.keys() & shard.keys():
                raise ValueError("invalid shard count or duplicate posting identity")
            for pid, posting in shard.items():
                if posting["id"] != pid:
                    raise ValueError("posting identity mismatch")
                if "description_ref" in posting:
                    ref = posting["description_ref"]
                    key = (ref["pack"], ref["sha256"])
                    if key not in documents:
                        documents[key] = read_description_pack(directory / "feed", ref, cache=packs)
                    if documents[key] != postings.get(pid, {}).get("description_text", ""):
                        raise ValueError("shard description differs from monolithic feed")
            collected.update(shard)
        if collected.keys() != postings.keys():
            raise ValueError("sharded feed identity set differs from monolithic feed")
    return {
        "postings": len(postings),
        "shards": len(meta.get("shards", {})),
        "documents": len(documents),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    print(json.dumps(validate_publication(parser.parse_args().data_dir), sort_keys=True))


if __name__ == "__main__":
    main()
