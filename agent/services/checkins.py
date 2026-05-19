from __future__ import annotations

from typing import Any
from logging import getLogger
from infrastructure.bbpm_client import BbPmClient
from infrastructure.llm_client import LlmClient
from domain.schemas import ChatWebhook, ParsedCheckin

logger = getLogger(__name__)


class CheckinService:
    def __init__(self, bbpm: BbPmClient, llm: LlmClient):
        self.bbpm = bbpm
        self.llm = llm

    async def handle_checkin(self, event: ChatWebhook) -> dict[str, Any]:
        user = await self.bbpm.resolve_user(event.channel, event.external_id)
        user_name = user.get("name") or user.get("fullName") or user.get("email") or user["id"]
        logger.info(f"Handling check-in for user {user['id']} ({user_name}) in channel {event.channel}")

        task_id = event.task_id
        if not task_id:
            tasks = await self.bbpm.list_open_tasks(user["id"], event.project_id)
            if not tasks:
                logger.info("checkin_no_open_tasks user_id=%s project_id=%s", user["id"], event.project_id)
                return {
                    "reply": "Mình chưa thấy task open nào assign cho bạn. Bạn chọn/tạo task trước rồi gửi lại update nhé.",
                    "data": {"user": user, "tasks": []},
                }
            if len(tasks) > 1:
                logger.info(
                    "checkin_multiple_open_tasks user_id=%s project_id=%s task_count=%s",
                    user["id"],
                    event.project_id,
                    len(tasks),
                )
                return {
                    "reply": "Bạn đang muốn update task nào?",
                    "data": {
                        "user": user,
                        "tasks": [
                            {
                                "id": task["id"],
                                "name": task["name"],
                                "project": task.get("project", {}).get("name"),
                                "status": task["status"],
                            }
                            for task in tasks[:10]
                        ],
                    },
                }
            task_id = tasks[0]["id"]

        parsed = await self.llm.parse_checkin(event.text)
        if parsed.needs_clarification:
            logger.info("checkin_needs_clarification user_id=%s task_id=%s", user["id"], task_id)
            return {
                "reply": parsed.clarification_question or "Bạn nói rõ thêm giúp mình phần update hôm nay nhé.",
                "data": {"status": "NEEDS_CLARIFICATION", "parsed": parsed.model_dump(mode="json")},
            }

        backlog = await self.bbpm.create_backlog(task_id, parsed)
        task = None
        blocker = None
        if parsed.task_status:
            task = await self.bbpm.update_task_status(task_id, parsed.task_status, parsed.summary)
        if parsed.blocker:
            blocker = await self.bbpm.create_blocker(task_id, parsed.blocker)

        logger.info(
            "checkin_imported user_id=%s task_id=%s backlog_id=%s blocker_id=%s",
            user["id"],
            task_id,
            backlog["id"],
            blocker["blockerId"] if blocker else None,
        )
        return {
            "reply": build_success_reply(parsed, backlog_id=backlog["id"], blocker=blocker),
            "data": {
                "status": "IMPORTED",
                "user": user,
                "taskId": task_id,
                "backlog": backlog,
                "task": task,
                "blocker": blocker,
                "parsed": parsed.model_dump(mode="json"),
            },
        }


def build_success_reply(parsed: ParsedCheckin, backlog_id: int, blocker: dict[str, Any] | None) -> str:
    parts = [f"Đã ghi nhận update hôm nay: {parsed.summary}", f"Backlog #{backlog_id}, {parsed.hours}h."]
    if parsed.task_status:
        parts.append(f"Task status: {parsed.task_status}.")
    if blocker:
        parts.append(f"Mình cũng đã ghi blocker #{blocker['blockerId']}.")
    return " ".join(parts)
