from __future__ import annotations

from typing import TYPE_CHECKING

from poller.sources.ashby import AshbyAdapter
from poller.sources.bamboohr import BambooHRAdapter
from poller.sources.breezy import BreezyAdapter
from poller.sources.comeet import ComeetAdapter
from poller.sources.generic import GenericAdapter
from poller.sources.google_careers import GoogleCareersAdapter
from poller.sources.greenhouse import GreenhouseAdapter
from poller.sources.icims import ICIMSAdapter
from poller.sources.jazzhr import JazzHRAdapter
from poller.sources.lever import LeverAdapter
from poller.sources.microsoft_careers import MicrosoftCareersAdapter
from poller.sources.pinpoint import PinpointAdapter
from poller.sources.recruitee import RecruiteeAdapter
from poller.sources.simplify import SimplifyAdapter
from poller.sources.smartrecruiters import SmartRecruitersAdapter
from poller.sources.teamtailor import TeamtailorAdapter
from poller.sources.usajobs import USAJobsAdapter
from poller.sources.workable import WorkableAdapter
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
    "google_careers": GoogleCareersAdapter,
    "microsoft_careers": MicrosoftCareersAdapter,
    "generic": GenericAdapter,
    "recruitee": RecruiteeAdapter,
    "bamboohr": BambooHRAdapter,
    "workable": WorkableAdapter,
    "breezy": BreezyAdapter,
    "jazzhr": JazzHRAdapter,
    "teamtailor": TeamtailorAdapter,
    "pinpoint": PinpointAdapter,
    "comeet": ComeetAdapter,
    "usajobs": USAJobsAdapter,
    "icims": ICIMSAdapter,
}


def get_adapter(source_type: str) -> SourceAdapter:
    cls = ADAPTERS.get(source_type)
    if cls is None:
        raise ValueError(f"unknown source type: {source_type!r}")
    return cls()
