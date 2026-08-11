class SourceFetchError(Exception):
    def __init__(self, source: str, company_slug: str, message: str) -> None:
        self.source = source
        self.company_slug = company_slug
        self.message = message
        super().__init__(f"[{source}:{company_slug}] fetch failed: {message}")


class SourceParseError(Exception):
    def __init__(self, source: str, company_slug: str, message: str) -> None:
        self.source = source
        self.company_slug = company_slug
        self.message = message
        super().__init__(f"[{source}:{company_slug}] parse failed: {message}")
