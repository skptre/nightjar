from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from poller.http import RateLimitedClient
from poller.registry import load_registry

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT_DIR / "data"

_GREENHOUSE_RE = re.compile(
    r"(?:boards|job-boards)\.greenhouse\.io/([^/]+)",
)
_LEVER_RE = re.compile(r"jobs\.(eu\.)?lever\.co/([^/]+)")
_ASHBY_RE = re.compile(r"jobs\.ashbyhq\.com/([^/]+)")
_WORKDAY_RE = re.compile(
    r"(([a-zA-Z0-9-]+)\.wd\d+\.myworkdayjobs\.com)"
    r"/(?:[a-z]{2}-[A-Z]{2}/)?([^/]+)",
)
_SMARTRECRUITERS_RE = re.compile(r"jobs\.smartrecruiters\.com/([^/]+)")


@dataclass
class ATSInference:
    ats_type: str | None
    board_token: str | None
    eu: bool = False


def infer_ats_detailed(url: str) -> ATSInference:
    m = _GREENHOUSE_RE.search(url)
    if m:
        return ATSInference(ats_type="greenhouse", board_token=m.group(1))

    m = _LEVER_RE.search(url)
    if m:
        eu = m.group(1) is not None
        return ATSInference(ats_type="lever", board_token=m.group(2), eu=eu)

    m = _ASHBY_RE.search(url)
    if m:
        return ATSInference(ats_type="ashby", board_token=m.group(1))

    m = _WORKDAY_RE.search(url)
    if m:
        host = m.group(1)
        site = m.group(3)
        return ATSInference(
            ats_type="workday",
            board_token=f"{host}/{site}",
        )

    m = _SMARTRECRUITERS_RE.search(url)
    if m:
        return ATSInference(
            ats_type="smartrecruiters",
            board_token=m.group(1),
        )

    return ATSInference(ats_type=None, board_token=None)


def load_candidates(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        logger.warning("no candidates file at %s", path)
        return []
    return json.loads(path.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def enrich_with_titles(
    candidates: list[dict[str, Any]],
    feed_path: Path,
) -> None:
    if not feed_path.exists():
        return

    feed_data = json.loads(feed_path.read_text(encoding="utf-8"))
    postings = feed_data.get("postings", {})

    titles_by_slug: dict[str, list[str]] = {}
    for posting in postings.values():
        if posting.get("source") == "simplify":
            slug = posting.get("company_slug", "")
            title = posting.get("title", "")
            if slug and title:
                titles_by_slug.setdefault(slug, []).append(title)

    for candidate in candidates:
        slug = candidate["slug"]
        slug_titles = titles_by_slug.get(slug, [])
        candidate["titles"] = sorted(set(slug_titles))
        candidate["posting_count"] = len(slug_titles)


async def _verify_greenhouse(
    client: RateLimitedClient,
    token: str,
) -> tuple[bool, int]:
    data = await client.get_json(
        f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs",
        source="infer-ats",
        company_slug=token,
    )
    return True, len(data.get("jobs", []))


async def _verify_lever(
    client: RateLimitedClient,
    token: str,
    eu: bool,
) -> tuple[bool, int]:
    domain = "api.eu.lever.co" if eu else "api.lever.co"
    data = await client.get_json(
        f"https://{domain}/v0/postings/{token}?limit=1&mode=json",
        source="infer-ats",
        company_slug=token,
    )
    return isinstance(data, list), len(data) if isinstance(data, list) else 0


async def _verify_ashby(
    client: RateLimitedClient,
    token: str,
) -> tuple[bool, int]:
    data = await client.get_json(
        f"https://api.ashbyhq.com/posting-api/job-board/{token}",
        source="infer-ats",
        company_slug=token,
    )
    return True, len(data.get("jobs", []))


async def _verify_workday(
    client: RateLimitedClient,
    token: str,
) -> tuple[bool, int]:
    parts = token.split("/", 1)
    if len(parts) != 2:
        return False, 0
    host, site = parts
    tenant = host.split(".")[0]
    data = await client.post_json(
        f"https://{host}/wday/cxs/{tenant}/{site}/jobs",
        json_body={
            "appliedFacets": {},
            "limit": 1,
            "offset": 0,
            "searchText": "",
        },
        source="infer-ats",
        company_slug=token,
    )
    return True, data.get("total", 0)


async def _verify_smartrecruiters(
    client: RateLimitedClient,
    token: str,
) -> tuple[bool, int]:
    data = await client.get_json(
        f"https://api.smartrecruiters.com/v1/companies/{token}/postings?limit=1",
        source="infer-ats",
        company_slug=token,
    )
    return True, data.get("totalFound", 0)


_SUPPORTED_ATS = {"greenhouse", "lever", "ashby", "workday", "smartrecruiters"}


async def _verify_single(
    client: RateLimitedClient,
    candidate: dict[str, Any],
) -> None:
    ats = candidate.get("inferred_ats")
    token = candidate.get("inferred_board_token")
    eu: bool = candidate.get("eu", False)

    if not ats or not token or ats not in _SUPPORTED_ATS:
        candidate["verified"] = False
        return

    try:
        if ats == "greenhouse":
            verified, count = await _verify_greenhouse(client, token)
        elif ats == "lever":
            verified, count = await _verify_lever(client, token, eu)
        elif ats == "ashby":
            verified, count = await _verify_ashby(client, token)
        elif ats == "workday":
            verified, count = await _verify_workday(client, token)
        else:
            verified, count = await _verify_smartrecruiters(client, token)

        candidate["verified"] = verified
        candidate["active_postings"] = count
    except Exception as exc:
        logger.warning(
            "[infer-ats] verify failed for %s (%s): %s",
            candidate.get("slug", "?"),
            ats,
            exc,
        )
        candidate["verified"] = False


async def verify_boards(candidates: list[dict[str, Any]]) -> None:
    async with RateLimitedClient() as client:
        for candidate in candidates:
            if candidate.get("inferred_ats"):
                await _verify_single(client, candidate)
                logger.info(
                    "[infer-ats] %s: verified=%s active=%s",
                    candidate.get("slug", "?"),
                    candidate.get("verified", False),
                    candidate.get("active_postings", "?"),
                )


async def run(
    *,
    verify: bool = False,
    data_dir: Path | None = None,
    registry_path: Path | None = None,
) -> list[dict[str, Any]]:
    resolved_data = data_dir or DATA_DIR
    candidates_path = resolved_data / "registry_candidates.json"
    feed_path = resolved_data / "feed.json"

    candidates = load_candidates(candidates_path)
    if not candidates:
        logger.info("[infer-ats] no candidates to process")
        return []

    logger.info("[infer-ats] loaded %d candidates", len(candidates))

    try:
        registry = load_registry(registry_path)
        known_slugs = {c.slug for c in registry}
    except Exception:
        logger.warning("[infer-ats] could not load registry, skipping dedup")
        known_slugs = set()

    original_count = len(candidates)
    candidates = [c for c in candidates if c["slug"] not in known_slugs]
    skipped = original_count - len(candidates)
    if skipped:
        logger.info(
            "[infer-ats] skipped %d already in registry", skipped,
        )

    for candidate in candidates:
        url = candidate.get("apply_url", "")
        if url:
            inference = infer_ats_detailed(url)
            candidate["inferred_ats"] = inference.ats_type
            candidate["inferred_board_token"] = inference.board_token
            if inference.eu:
                candidate["eu"] = True
            elif "eu" in candidate:
                del candidate["eu"]

    enrich_with_titles(candidates, feed_path)

    if verify:
        logger.info("[infer-ats] verifying %d boards...", len(candidates))
        await verify_boards(candidates)

    candidates_path.parent.mkdir(parents=True, exist_ok=True)
    candidates_path.write_text(
        json.dumps(candidates, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    logger.info(
        "[infer-ats] wrote %d enriched candidates to %s",
        len(candidates),
        candidates_path,
    )

    return candidates


def main() -> None:
    verify = "--verify" in sys.argv

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    asyncio.run(run(verify=verify))


if __name__ == "__main__":
    main()
