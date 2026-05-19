from __future__ import annotations

from typing import Any

from infrastructure.bbpm_client import BbPmClient
from infrastructure.gapo_client import GapoClient
from domain.schemas import ReminderRunRequest


class ReminderService:
    def __init__(self, bbpm: BbPmClient, gapo: GapoClient):
        self.bbpm = bbpm
        self.gapo = gapo

    async def run(self, request: ReminderRunRequest) -> dict[str, Any]:
        # Placeholder for the next step:
        # 1. query bb-pm users/members/tasks
        # 2. send project/task choices through GapoClient
        # 3. create follow-up/audit rows in bb-pm
        return {
            "status": "accepted",
            "checkinType": request.checkin_type,
            "dryRun": request.dry_run,
            "message": "Reminder service is wired. Add user/task query + Gapo send in the next step.",
        }
