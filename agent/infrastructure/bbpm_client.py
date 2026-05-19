from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException
from logging import getLogger

from core.config import Settings
from domain.schemas import BbPmChannel, Blocker, Channel, ParsedCheckin, TaskStatus

logger = getLogger(__name__)

def to_bbpm_channel(channel: Channel) -> BbPmChannel:
    if channel == "gapo-work":
        return "gapo"
    return channel  


class BbPmClient:
    def __init__(self, settings: Settings):
        self.client = httpx.AsyncClient(
            base_url=settings.bb_pm_api_url,
            timeout=httpx.Timeout(30.0),
            headers={"X-Agent-Token": settings.bb_pm_agent_token},
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        res = await self.client.request(method, path, **kwargs)
        if res.status_code >= 400:
            raise HTTPException(res.status_code, res.text)
        return res.json()

    async def resolve_user(self, channel: Channel, external_id: str) -> dict[str, Any]:
        data = await self.request(
            "GET",
            "/agent/user-by-channel",
            params={"channel": to_bbpm_channel(channel), "externalId": external_id},
        )
        logger.info(f"Resolved user for channel {channel} and external_id {external_id}: {data}")
        return data["data"]["user"]

    async def list_open_tasks(
        self,
        assignee_id: int,
        project_id: int | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "assigneeId": assignee_id,
            "pageSize": 100,
            "sort": "-updatedAt",
        }
        if project_id:
            params["projectId"] = project_id
        data = await self.request("GET", "/tasks", params=params)
        logger.info(f"Retrieved open tasks for assignee {assignee_id}: {data['data']}")
        return [task for task in data["data"] if task["status"] != "DONE"]

    async def create_backlog(self, task_id: int, parsed: ParsedCheckin) -> dict[str, Any]:
        data = await self.request(
            "POST",
            f"/backlogs/by-task/{task_id}",
            json={
                "workDate": parsed.work_date.isoformat(),
                "hours": str(parsed.hours),
                "description": build_backlog_description(parsed),
            },
        )
        logger.info(f"Created backlog for task {task_id} with data: {data}")
        return data["data"]

    async def update_task_status(
        self,
        task_id: int,
        status: TaskStatus,
        summary: str,
    ) -> dict[str, Any]:
        data = await self.request(
            "PATCH",
            f"/tasks/{task_id}",
            json={"status": status, "result": summary},
        )
        logger.info(f"Updated task status for task {task_id}: {data['data']}")
        return data["data"]

    async def create_blocker(self, task_id: int, blocker: Blocker) -> dict[str, Any]:
        data = await self.request(
            "POST",
            f"/tasks/{task_id}/blocker",
            json={"description": blocker.description, "severity": blocker.severity},
        )
        logger.info(f"Created blocker for task {task_id}: {data['data']}")
        return data["data"]


def build_backlog_description(parsed: ParsedCheckin) -> str:
    lines = [parsed.summary]
    if parsed.done_items:
        lines.append("Done: " + "; ".join(parsed.done_items))
    if parsed.blocker:
        lines.append(f"Blocker [{parsed.blocker.severity}]: {parsed.blocker.description}")
    logger.info(f"Built backlog description for task {parsed.task_id}: {lines[-1]}")
    return "\n".join(lines)
