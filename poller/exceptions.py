from poller.redaction import safe_error


class SourceFetchError(Exception):
    def __init__(self, source: str, company_slug: str, message: str) -> None:
        self.source = source
        self.company_slug = company_slug
        self.message = safe_error(message)
        super().__init__(f"[{source}:{company_slug}] fetch failed: {self.message}")


class SourceParseError(Exception):
    def __init__(self, source: str, company_slug: str, message: str) -> None:
        self.source = source
        self.company_slug = company_slug
        self.message = safe_error(message)
        super().__init__(f"[{source}:{company_slug}] parse failed: {self.message}")
