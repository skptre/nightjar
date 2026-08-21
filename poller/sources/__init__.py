from __future__ import annotations

from typing import TYPE_CHECKING

from poller.sources.ashby import AshbyAdapter
from poller.sources.greenhouse import GreenhouseAdapter
from poller.sources.lever import LeverAdapter
from poller.sources.simplify import SimplifyAdapter
from poller.sources.smartrecruiters import SmartRecruitersAdapter
from poller.sources.workday import WorkdayAdapter

if TYPE_CHECKING:
    from poller.sources.base import SourceAdapter

ADAPTERS: dict[str, type[SourceAdapter]] = {
    "greenhouse": GreenhouseAdapter,
    "lever": LeverAdapter,
    "ashby": AshbyAdapter,
    "workday": WorkdayAdapter,
    "simplify": SimplifyAdapter,
    "smartrecruiters": SmartRecruitersAdapter,
}


def get_adapter(source_type: str) -> SourceAdapter:
    cls = ADAPTERS.get(source_type)
    if cls is None:
        raise ValueError(f"unknown source type: {source_type!r}")
    return cls()
