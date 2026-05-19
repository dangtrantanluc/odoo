"""Check-in state machine smoke test.

Runs the full IDLE → AWAITING_PROJECT → AWAITING_UPDATE → COMPLETED flow
against an in-memory fake bb-pm API. Run directly: `python tests/test_checkin_sm.py`.
"""

from __future__ import annotations

import asyncio

from checkin.service import CheckinService
from infrastructure.bbpm_client import BbPmApiError
from shared.types import TurnRequest


class FakeBbPm:
    def __init__(self) -> None:
        self.session: dict | None = None
        self._seq = 0
        self.imported: list[dict] = []
        self.completed = False

    async def checkin_projects(self, user_id):
        return [{"id": 10, "name": "AI PM Agent"}, {"id": 20, "name": "Logistics Dashboard"}]

    async def start_checkin_session(self, **kw):
        if self.session is None:
            self._seq += 1
            self.session = {"id": self._seq, "state": "AWAITING_PROJECT",
                            "currentProjectId": None, "expiresAt": "2099-01-01T00:00:00+00:00"}
        return self.session

    async def current_checkin_session(self, user_id):
        if self.session is None:
            raise BbPmApiError(404, "no session")
        return self.session

    async def patch_checkin_session(self, session_id, **fields):
        assert self.session is not None
        self.session.update(fields)
        return self.session

    async def complete_checkin_session(self, session_id):
        self.completed = True
        self.session = None
        return {"id": session_id, "state": "COMPLETED"}

    async def import_checkin(self, **kw):
        self.imported.append(kw)
        return {"id": 555, **kw}

    async def list_tasks(self, **kw):
        return []

    async def post_audit(self, **kw):
        return {"id": 1}


class FakeLlm:
    async def chat(self, *a, **kw):  # force regex fallback
        raise RuntimeError("llm offline in test")


def _ctx(text_meta=None) -> TurnRequest:
    return TurnRequest(text="", source="chat", conversation_id="gapo:999",
                       external_id="u42", correlation_id="c1", caller_user_id=42,
                       metadata=text_meta or {})


async def main() -> None:
    bbpm = FakeBbPm()
    svc = CheckinService(bbpm, FakeLlm())

    r1 = await svc.handle_turn("/checkin", _ctx())
    assert r1 and r1.pattern == "checkin:start", r1
    assert r1.channel_reply and r1.channel_reply.kind == "quick_replies"
    assert bbpm.session["state"] == "AWAITING_PROJECT"
    print("step 1 /checkin -> AWAITING_PROJECT, project picker shown")

    r2 = await svc.handle_turn("1", _ctx())
    assert r2 and r2.pattern == "checkin:project_selected", r2
    assert bbpm.session["state"] == "AWAITING_UPDATE"
    assert bbpm.session["currentProjectId"] == 10
    print("step 2 select project -> AWAITING_UPDATE (project 10)")

    r3 = await svc.handle_turn("fix bug login xong 4h", _ctx())
    assert r3 and r3.pattern == "checkin:completed_project", r3
    assert bbpm.completed is True
    assert bbpm.imported and bbpm.imported[0]["hours"] == "4.0"
    print("step 3 send update -> COMPLETED, backlog imported:", bbpm.imported[0]["description"])

    print("counters:", svc.telemetry_snapshot())
    print("CHECKIN STATE MACHINE: PASS")


if __name__ == "__main__":
    asyncio.run(main())
