from __future__ import annotations

import asyncio
import json
import sys

from core.config import settings
from infrastructure.llm_client import LlmClient


async def main() -> None:
    text = " ".join(sys.argv[1:]).strip() or "hôm nay tôi fix bug ở gapo"
    llm = LlmClient(settings)
    try:
        parsed = await llm.parse_checkin(text)
        print(json.dumps(parsed.model_dump(mode="json"), ensure_ascii=False, indent=2))
    finally:
        await llm.close()


if __name__ == "__main__":
    asyncio.run(main())
