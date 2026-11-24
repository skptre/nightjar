"""Safe diagnostics for logs and publicly persisted runtime state."""

from __future__ import annotations

import os
import re


def safe_error(value: object) -> str:
    text = str(value)
    # HTTP libraries include the entire offending header value in these errors.
    if re.search(
        r"illegal header|invalid header|authorization.key\s*[:=]|api.key\s*[:=]", text, re.I
    ):
        return "Invalid credential/header configuration; sensitive details redacted"
    for name, secret in os.environ.items():
        if re.search(r"KEY|TOKEN|SECRET|PASSWORD", name) and len(secret) >= 6:
            text = text.replace(secret, "[redacted]")
    text = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", text)
    text = re.sub(r"(?i)([?&](?:token|key|api_key|access_token)=)[^&\s]+", r"\1[redacted]", text)
    return text[:1000]
