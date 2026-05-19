"""Vietnamese text helpers shared across routing / check-in / tools.

Ports `normalize` from bb-pm-tools/src/checkin/service.ts and
`stripMarkdownForGapo` from channel-out.ts.
"""

from __future__ import annotations

import re
import unicodedata

_COMBINING = re.compile(r"[̀-ͯ]")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")

_FENCED = re.compile(r"```[\w-]*\s*[\s\S]*?```")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_UNDER = re.compile(r"__(.+?)__")
_STRIKE = re.compile(r"~~(.+?)~~")
_CODE = re.compile(r"`([^`\n]+?)`")
_HEADER = re.compile(r"^#{1,6}\s+", re.MULTILINE)
_HASH_NUM = re.compile(r"(^|[\s(])#\d+\s*")
_BLANK_LINES = re.compile(r"\n{3,}")


def normalize(text: str) -> str:
    """Lowercase, strip Vietnamese diacritics, collapse to ascii words.

    Used for fuzzy command/name matching. NFD splits accents into combining
    marks; `đ` is a distinct letter so it is replaced explicitly.
    """
    lowered = (text or "").lower()
    decomposed = unicodedata.normalize("NFD", lowered)
    stripped = _COMBINING.sub("", decomposed)
    stripped = stripped.replace("đ", "d")
    return _NON_ALNUM.sub(" ", stripped).strip()


def nfc(text: str) -> str:
    """Normalize to NFC — Gapo may deliver decomposed (NFD) Vietnamese text."""
    return unicodedata.normalize("NFC", text or "")


def strip_markdown_for_gapo(text: str) -> str:
    """Remove markdown markers Gapo Work cannot render. Keeps inner text.

    Single `*italic*` is intentionally NOT stripped (conflicts with bullets).
    """
    if not text:
        return text
    out = _FENCED.sub("", text)
    out = _BOLD.sub(r"\1", out)
    out = _UNDER.sub(r"\1", out)
    out = _STRIKE.sub(r"\1", out)
    out = _CODE.sub(r"\1", out)
    out = _HEADER.sub("", out)
    out = _HASH_NUM.sub(r"\1", out)
    out = _BLANK_LINES.sub("\n\n", out)
    return out.strip()
