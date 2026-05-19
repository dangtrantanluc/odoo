"""Workflow scheduler (APScheduler).

Ports bb-pm-tools/src/workflows/scheduler.ts (node-cron → APScheduler):
 * env-based legacy cron jobs (daily digest, weekly hygiene)
 * check-in reminder crons (noon / eod / missing follow-up)
 * audit-log retention cleanup
 * DB-backed automation poll loop with a dead-man switch
"""

from __future__ import annotations

from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from core.config import settings
from core.logging import log_event
from infrastructure.bbpm_client import BbPmClient
from workflows.registry import WorkflowContext, WorkflowRegistry

_DEAD_MAN_FAILS = 3


class AgentScheduler:
    def __init__(self, registry: WorkflowRegistry, bbpm: BbPmClient) -> None:
        self._registry = registry
        self._bbpm = bbpm
        self._scheduler = AsyncIOScheduler(timezone=settings.cron.timezone)
        self._db_jobs: set[int] = set()  # automation ids currently registered

    def start(self) -> None:
        cron = settings.cron
        # ── legacy env-based jobs ───────────────────────────────────────
        if cron.daily_digest.target:
            self._add_cron("legacy-daily-digest", cron.daily_digest.schedule,
                           "daily_digest", {}, cron.daily_digest.target)
        if cron.weekly_hygiene.target:
            self._add_cron("legacy-weekly-hygiene", cron.weekly_hygiene.schedule,
                           "hygiene_check", {}, cron.weekly_hygiene.target)
        # ── check-in reminders ──────────────────────────────────────────
        if cron.checkin_enabled:
            self._add_cron("noon-checkin", cron.noon_checkin.schedule,
                           "noon_checkin_reminder", {}, None)
            self._add_cron("eod-checkin", cron.eod_checkin.schedule,
                           "eod_checkin_reminder", {}, None)
            self._add_cron("missing-checkin", cron.missing_checkin_followup.schedule,
                           "missing_checkin_followup", {}, None)
        else:
            log_event("scheduler.checkin_disabled")
        # ── audit retention cleanup ─────────────────────────────────────
        if cron.audit_retention_days > 0:
            self._scheduler.add_job(
                self._run_audit_cleanup, CronTrigger.from_crontab(
                    cron.audit_cleanup_schedule, timezone=settings.cron.timezone),
                id="audit-cleanup", replace_existing=True,
            )
        # ── DB-backed automation poll loop ──────────────────────────────
        self._scheduler.add_job(
            self._sync_automations, IntervalTrigger(seconds=cron.automation_poll_sec),
            id="automation-poll", replace_existing=True, next_run_time=None,
        )
        self._scheduler.start()
        log_event("scheduler.started", jobs=[j.id for j in self._scheduler.get_jobs()])

    def shutdown(self) -> None:
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)

    # ── job helpers ─────────────────────────────────────────────────────
    def _add_cron(self, job_id: str, schedule: str, workflow: str,
                  inputs: dict[str, Any], target: str | None) -> None:
        try:
            trigger = CronTrigger.from_crontab(schedule, timezone=settings.cron.timezone)
        except ValueError as err:
            log_event("scheduler.bad_cron", level="error", job=job_id,
                      schedule=schedule, error=str(err))
            return
        self._scheduler.add_job(
            self._run_workflow, trigger, id=job_id, replace_existing=True,
            kwargs={"workflow": workflow, "inputs": inputs, "target": target,
                    "correlation_id": job_id},
        )

    async def _run_workflow(self, workflow: str, inputs: dict[str, Any],
                            target: str | None, correlation_id: str) -> None:
        ctx = WorkflowContext(source="cron", target=target, correlation_id=correlation_id)
        result = await self._registry.run(workflow, inputs, ctx)
        log_event("scheduler.workflow_run", workflow=workflow, ok=result.ok,
                  message=result.message)

    async def _run_audit_cleanup(self) -> None:
        try:
            res = await self._bbpm.cleanup_audit(settings.cron.audit_retention_days)
            log_event("scheduler.audit_cleanup", deleted=res.get("deletedCount"))
        except Exception as err:  # noqa: BLE001
            log_event("scheduler.audit_cleanup_failed", level="warning", error=str(err))

    # ── DB-backed automations ───────────────────────────────────────────
    async def _sync_automations(self) -> None:
        try:
            automations = await self._bbpm.list_automations(active=True)
        except Exception as err:  # noqa: BLE001
            log_event("scheduler.poll_failed", level="warning", error=str(err))
            return
        active_ids: set[int] = set()
        for auto in automations:
            auto_id = auto.get("id")
            if auto_id is None:
                continue
            if (auto.get("consecutiveFails") or 0) >= _DEAD_MAN_FAILS:
                self._remove_db_job(auto_id, "dead-man")
                continue
            active_ids.add(auto_id)
            job_id = f"db-automation-{auto_id}"
            try:
                trigger = CronTrigger.from_crontab(
                    auto["schedule"], timezone=settings.cron.timezone)
            except (ValueError, KeyError):
                continue
            self._scheduler.add_job(
                self._run_db_automation, trigger, id=job_id, replace_existing=True,
                kwargs={"automation_id": auto_id, "workflow": auto.get("workflow"),
                        "inputs": auto.get("inputs") or {}, "target": auto.get("target"),
                        "consecutive_fails": auto.get("consecutiveFails") or 0},
            )
            self._db_jobs.add(auto_id)
        for stale_id in self._db_jobs - active_ids:
            self._remove_db_job(stale_id, "no longer active")

    def _remove_db_job(self, auto_id: int, reason: str) -> None:
        if auto_id not in self._db_jobs:
            return
        try:
            self._scheduler.remove_job(f"db-automation-{auto_id}")
        except Exception:  # noqa: BLE001
            pass
        self._db_jobs.discard(auto_id)
        log_event("scheduler.db_job_removed", automation_id=auto_id, reason=reason)

    async def _run_db_automation(self, automation_id: int, workflow: str,
                                 inputs: dict[str, Any], target: str | None,
                                 consecutive_fails: int = 0) -> None:
        ctx = WorkflowContext(source="cron", target=target,
                              correlation_id=f"auto-{automation_id}")
        result = await self._registry.run(workflow, inputs, ctx)
        try:
            from datetime import datetime, timezone
            await self._bbpm.patch_automation(
                automation_id,
                lastRunAt=datetime.now(timezone.utc).isoformat(),
                lastRunStatus="ok" if result.ok else "error",
                lastRunError=None if result.ok else result.message[:2000],
                consecutiveFails=0 if result.ok else consecutive_fails + 1,
            )
        except Exception:  # noqa: BLE001
            pass
