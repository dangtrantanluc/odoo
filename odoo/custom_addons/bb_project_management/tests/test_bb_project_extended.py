# -*- coding: utf-8 -*-
"""
Extended test suite — BB Project Management
TC-21 → TC-60

Coverage areas not addressed by test_bb_project.py (TC-01..TC-20):
  • Milestones (lifecycle, completion_pct, cascade)
  • Financial precision (multi-backlog sums, overspend, pending exclusion)
  • Cost snapshot immutability
  • Task financial aggregation
  • Constraint validation (dates, rate overlap, duplicate tag)
  • Cascade deletions (project→task→backlog, members+rates, milestones)
  • Member rate edge cases (expired, future, no rate)
  • Manager role permissions (implies admin)
  • Scope action_create_task and estimated_cost
  • Task derived fields (company_id, backlog_count, days_remaining)
"""
from datetime import date, timedelta

from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tests.common import TransactionCase


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _today():
    return fields_date_today()


def fields_date_today():
    from odoo import fields
    return fields.Date.today()


def _fmt(d: date) -> str:
    return d.strftime('%Y-%m-%d')


# ─────────────────────────────────────────────────────────────────────────────
# TC-21 → TC-26  Milestones
# ─────────────────────────────────────────────────────────────────────────────

class TestBbProjectMilestone(TransactionCase):
    """TC-21 → TC-26: Milestone model — lifecycle, stats, cascade"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_admin = cls.env.ref('bb_project_management.group_bb_pm_admin')
        cls.env.user.write({'groups_id': [(4, group_admin.id)]})

        cls.project = cls.env['bb.project'].create({
            'name': 'Milestone Test Project',
            'code': 'MTP-001',
        })

    def test_21_milestone_default_status_draft(self):
        """[TC-21] Milestone created with status = 'draft' by default"""
        m = self.env['bb.project.milestone'].create({
            'name': 'M1 – Design',
            'project_id': self.project.id,
        })
        self.assertEqual(m.status, 'draft')
        self.assertEqual(m.project_id, self.project)

    def test_22_milestone_full_workflow(self):
        """[TC-22] Milestone: draft → in_progress → done → reopen (→ draft)"""
        m = self.env['bb.project.milestone'].create({
            'name': 'M2 – Dev',
            'project_id': self.project.id,
        })
        m.action_set_in_progress()
        self.assertEqual(m.status, 'in_progress')
        m.action_set_done()
        self.assertEqual(m.status, 'done')
        m.action_reopen()
        self.assertEqual(m.status, 'draft')

    def test_23_milestone_cancel(self):
        """[TC-23] Milestone can be cancelled from any state"""
        m = self.env['bb.project.milestone'].create({
            'name': 'M3 – QA',
            'project_id': self.project.id,
            'status': 'in_progress',
        })
        m.action_set_cancelled()
        self.assertEqual(m.status, 'cancelled')

    def test_24_milestone_completion_pct(self):
        """[TC-24] completion_pct = 50 when 1 of 2 linked tasks is done"""
        m = self.env['bb.project.milestone'].create({
            'name': 'M4 – Release',
            'project_id': self.project.id,
        })
        t1 = self.env['bb.project.task'].create({
            'name': 'Task A',
            'project_id': self.project.id,
            'milestone_id': m.id,
            'status': 'done',
        })
        t2 = self.env['bb.project.task'].create({
            'name': 'Task B',
            'project_id': self.project.id,
            'milestone_id': m.id,
            'status': 'todo',
        })
        m.invalidate_recordset(['task_count', 'done_count', 'completion_pct'])
        self.assertEqual(m.task_count, 2)
        self.assertEqual(m.done_count, 1)
        self.assertEqual(m.completion_pct, 50)

    def test_25_milestone_count_on_project(self):
        """[TC-25] milestone_count on project increments when milestone added"""
        before = self.project.milestone_count
        self.env['bb.project.milestone'].create({
            'name': 'M5 – Extra',
            'project_id': self.project.id,
        })
        self.project._compute_counts()
        self.assertEqual(self.project.milestone_count, before + 1)

    def test_26_milestone_cascade_delete(self):
        """[TC-26] Milestones deleted when project is deleted (cascade)"""
        p = self.env['bb.project'].create({'name': 'Del MS Project', 'code': 'DMS-001'})
        m = self.env['bb.project.milestone'].create({
            'name': 'To Delete',
            'project_id': p.id,
        })
        m_id = m.id
        p.unlink()
        self.assertFalse(
            self.env['bb.project.milestone'].search([('id', '=', m_id)]),
            "Milestone must be cascade-deleted with project",
        )


# ─────────────────────────────────────────────────────────────────────────────
# TC-27 → TC-33  Financial precision
# ─────────────────────────────────────────────────────────────────────────────

class TestBbProjectFinancials(TransactionCase):
    """TC-27 → TC-33: Cost/hour rollup, overspend, snapshot immutability"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_admin = cls.env.ref('bb_project_management.group_bb_pm_admin')
        cls.env.user.write({'groups_id': [(4, group_admin.id)]})

        cls.project = cls.env['bb.project'].create({
            'name': 'Financial Test Project',
            'code': 'FIN-001',
            'budget': 2_000_000.0,
        })
        cls.task = cls.env['bb.project.task'].create({
            'name': 'Finance Task',
            'project_id': cls.project.id,
        })
        cls.member = cls.env['bb.project.member'].create({
            'project_id': cls.project.id,
            'user_id': cls.env.user.id,
            'role': 'DEV',
        })
        cls.env['bb.project.member.rate'].create({
            'member_id': cls.member.id,
            'cost_per_hour': 100_000.0,
            'effective_from': '2026-01-01',
        })

    def _make_backlog(self, hours, work_date='2026-04-01'):
        return self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': work_date,
            'hours': hours,
        })

    def test_27_pending_backlog_excluded_from_total(self):
        """[TC-27] Pending backlog does NOT add to project total_cost"""
        self._make_backlog(5.0, '2026-04-02')   # pending, not approved
        self.project._compute_financials()
        # only approved contribute — pending must be excluded
        pending_cost = 5.0 * 100_000.0
        self.assertAlmostEqual(
            self.project.total_cost,
            sum(
                b.total_cost_snapshot
                for t in self.project.task_ids
                for b in t.backlog_ids.filtered(lambda b: b.status == 'approved')
            ),
        )

    def test_28_multiple_approved_backlogs_sum(self):
        """[TC-28] total_cost = sum of all approved backlog snapshots"""
        b1 = self._make_backlog(2.0, '2026-04-03')
        b2 = self._make_backlog(3.0, '2026-04-04')
        b1.action_approve()
        b2.action_approve()
        self.project._compute_financials()
        expected = (2.0 + 3.0) * 100_000.0  # 500_000
        self.assertAlmostEqual(self.project.total_cost, expected, delta=1.0)

    def test_29_budget_remaining_negative_when_overspent(self):
        """[TC-29] budget_remaining < 0 when approved costs exceed budget"""
        p = self.env['bb.project'].create({
            'name': 'Tight Budget',
            'code': 'TBG-001',
            'budget': 100_000.0,
        })
        t = self.env['bb.project.task'].create({
            'name': 'Expensive Task',
            'project_id': p.id,
        })
        m = self.env['bb.project.member'].create({
            'project_id': p.id,
            'user_id': self.env.user.id,
        })
        self.env['bb.project.member.rate'].create({
            'member_id': m.id,
            'cost_per_hour': 200_000.0,
            'effective_from': '2026-01-01',
        })
        b = self.env['bb.project.backlog'].create({
            'task_id': t.id,
            'user_id': self.env.user.id,
            'work_date': '2026-04-05',
            'hours': 10.0,    # 10 × 200_000 = 2_000_000 >> budget 100_000
        })
        b.action_approve()
        p._compute_financials()
        self.assertLess(p.budget_remaining, 0,
                        "budget_remaining must be negative when overspent")

    def test_30_total_hours_approved_only(self):
        """[TC-30] project.total_hours sums only approved backlog hours"""
        b_pending = self._make_backlog(10.0, '2026-04-06')
        b_approved = self._make_backlog(4.0, '2026-04-07')
        b_approved.action_approve()
        self.project._compute_financials()
        # total_hours must count only approved
        approved_hours = sum(
            b.hours
            for t in self.project.task_ids
            for b in t.backlog_ids.filtered(lambda b: b.status == 'approved')
        )
        self.assertAlmostEqual(self.project.total_hours, approved_hours, delta=0.01)

    def test_31_reject_previously_approved_reduces_cost(self):
        """[TC-31] Resetting approved backlog to pending removes it from total_cost"""
        b = self._make_backlog(5.0, '2026-04-08')
        b.action_approve()
        self.project._compute_financials()
        cost_before = self.project.total_cost

        b.action_reset_to_pending()
        self.project._compute_financials()
        cost_after = self.project.total_cost
        self.assertLess(cost_after, cost_before,
                        "Resetting to pending must remove contribution from total_cost")

    def test_32_snapshot_immutable_after_rate_change(self):
        """[TC-32] Changing member rate DOES NOT alter existing backlog snapshot"""
        b = self._make_backlog(3.0, '2026-04-09')
        original_snapshot = b.cost_per_hour_snapshot   # 100_000

        # Change rate to 999_999
        self.member.rate_ids[0].write({'cost_per_hour': 999_999.0})
        b.invalidate_recordset(['cost_per_hour_snapshot'])
        self.assertAlmostEqual(
            b.cost_per_hour_snapshot, original_snapshot,
            msg="cost_per_hour_snapshot must be immutable after rate update",
        )

    def test_33_task_financial_aggregation(self):
        """[TC-33] task.total_hours and task.total_cost aggregate from approved backlogs"""
        task = self.env['bb.project.task'].create({
            'name': 'Agg Task',
            'project_id': self.project.id,
        })
        b1 = self.env['bb.project.backlog'].create({
            'task_id': task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-04-10',
            'hours': 2.0,
        })
        b2 = self.env['bb.project.backlog'].create({
            'task_id': task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-04-11',
            'hours': 3.0,
        })
        b1.action_approve()
        b2.action_approve()
        task.invalidate_recordset(['total_hours', 'total_cost'])
        self.assertAlmostEqual(task.total_hours, 5.0, delta=0.01)
        self.assertAlmostEqual(task.total_cost, 5.0 * 100_000.0, delta=1.0)


# ─────────────────────────────────────────────────────────────────────────────
# TC-34 → TC-38  Constraint validation
# ─────────────────────────────────────────────────────────────────────────────

class TestBbProjectConstraints(TransactionCase):
    """TC-34 → TC-38: Field-level and SQL constraints"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_admin = cls.env.ref('bb_project_management.group_bb_pm_admin')
        cls.env.user.write({'groups_id': [(4, group_admin.id)]})

    def test_34_end_date_before_start_date_raises(self):
        """[TC-34] end_date < start_date raises ValidationError"""
        with self.assertRaises(ValidationError):
            self.env['bb.project'].create({
                'name': 'Bad Dates',
                'code': 'BDT-001',
                'start_date': '2026-12-31',
                'end_date': '2026-01-01',
            })

    def test_35_rate_effective_to_before_from_raises(self):
        """[TC-35] Member rate: effective_to < effective_from raises ValidationError"""
        project = self.env['bb.project'].create({
            'name': 'Rate Constraint Project',
            'code': 'RCP-001',
        })
        member = self.env['bb.project.member'].create({
            'project_id': project.id,
            'user_id': self.env.user.id,
        })
        with self.assertRaises(ValidationError):
            self.env['bb.project.member.rate'].create({
                'member_id': member.id,
                'cost_per_hour': 50_000.0,
                'effective_from': '2026-06-01',
                'effective_to': '2026-01-01',   # to < from → invalid
            })

    def test_36_duplicate_tag_name_raises(self):
        """[TC-36] Two tags with the same name raise a DB unique constraint error"""
        self.env['bb.project.tag'].create({'name': 'UniqueTagXYZ_2026'})
        with self.assertRaises(Exception):
            self.env['bb.project.tag'].create({'name': 'UniqueTagXYZ_2026'})

    def test_37_project_null_code_no_constraint(self):
        """[TC-37] Multiple projects with no code (None) do NOT violate unique constraint"""
        p1 = self.env['bb.project'].create({'name': 'No Code 1'})
        p2 = self.env['bb.project'].create({'name': 'No Code 2'})
        self.assertFalse(p1.code)
        self.assertFalse(p2.code)

    def test_38_reject_already_rejected_raises(self):
        """[TC-38] Calling action_reject on an already-rejected backlog raises UserError"""
        project = self.env['bb.project'].create({
            'name': 'Double Reject Project',
            'code': 'DRJ-001',
        })
        task = self.env['bb.project.task'].create({
            'name': 'DR Task',
            'project_id': project.id,
        })
        b = self.env['bb.project.backlog'].create({
            'task_id': task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-04-12',
            'hours': 1.0,
        })
        b.action_reject()
        with self.assertRaises(UserError):
            b.action_reject()


# ─────────────────────────────────────────────────────────────────────────────
# TC-39 → TC-42  Cascade deletes
# ─────────────────────────────────────────────────────────────────────────────

class TestBbProjectCascade(TransactionCase):
    """TC-39 → TC-42: Cascade-delete chains"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_admin = cls.env.ref('bb_project_management.group_bb_pm_admin')
        cls.env.user.write({'groups_id': [(4, group_admin.id)]})

    def test_39_delete_project_removes_tasks(self):
        """[TC-39] Deleting project cascades to all its tasks"""
        p = self.env['bb.project'].create({'name': 'Cascade P', 'code': 'CSC-001'})
        t1 = self.env['bb.project.task'].create({'name': 'CT1', 'project_id': p.id})
        t2 = self.env['bb.project.task'].create({'name': 'CT2', 'project_id': p.id})
        task_ids = [t1.id, t2.id]
        p.unlink()
        remaining = self.env['bb.project.task'].search([('id', 'in', task_ids)])
        self.assertFalse(remaining, "Tasks must be cascade-deleted with project")

    def test_40_delete_task_removes_backlogs(self):
        """[TC-40] Deleting task cascades to its backlogs"""
        p = self.env['bb.project'].create({'name': 'Cascade P2', 'code': 'CSC-002'})
        t = self.env['bb.project.task'].create({'name': 'CT3', 'project_id': p.id})
        b = self.env['bb.project.backlog'].create({
            'task_id': t.id,
            'user_id': self.env.user.id,
            'work_date': '2026-04-13',
            'hours': 1.0,
        })
        b_id = b.id
        t.unlink()
        self.assertFalse(
            self.env['bb.project.backlog'].search([('id', '=', b_id)]),
            "Backlogs must be cascade-deleted with task",
        )

    def test_41_delete_project_removes_members_and_rates(self):
        """[TC-41] Deleting project cascades members and their rate history"""
        p = self.env['bb.project'].create({'name': 'Cascade P3', 'code': 'CSC-003'})
        m = self.env['bb.project.member'].create({
            'project_id': p.id,
            'user_id': self.env.user.id,
        })
        r = self.env['bb.project.member.rate'].create({
            'member_id': m.id,
            'cost_per_hour': 80_000.0,
            'effective_from': '2026-01-01',
        })
        m_id, r_id = m.id, r.id
        p.unlink()
        self.assertFalse(
            self.env['bb.project.member'].search([('id', '=', m_id)]),
            "Members must be cascade-deleted with project",
        )
        self.assertFalse(
            self.env['bb.project.member.rate'].search([('id', '=', r_id)]),
            "Member rates must be cascade-deleted with project (via member)",
        )

    def test_42_delete_project_removes_milestones(self):
        """[TC-42] Deleting project cascades its milestones"""
        p = self.env['bb.project'].create({'name': 'Cascade P4', 'code': 'CSC-004'})
        ms = self.env['bb.project.milestone'].create({
            'name': 'MS to delete',
            'project_id': p.id,
        })
        ms_id = ms.id
        p.unlink()
        self.assertFalse(
            self.env['bb.project.milestone'].search([('id', '=', ms_id)]),
            "Milestones must be cascade-deleted with project",
        )


# ─────────────────────────────────────────────────────────────────────────────
# TC-43 → TC-47  Member rate edge cases
# ─────────────────────────────────────────────────────────────────────────────

class TestBbProjectMemberRateLogic(TransactionCase):
    """TC-43 → TC-47: current_rate computation with date-range edge cases"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_admin = cls.env.ref('bb_project_management.group_bb_pm_admin')
        cls.env.user.write({'groups_id': [(4, group_admin.id)]})

        cls.project = cls.env['bb.project'].create({
            'name': 'Rate Edge Project',
            'code': 'REP-001',
        })

    def _make_member(self):
        return self.env['bb.project.member'].create({
            'project_id': self.project.id,
            'user_id': self.env.user.id,
        })

    def test_43_expired_rate_returns_zero(self):
        """[TC-43] Rate with effective_to in the past → current_rate = 0"""
        m = self._make_member()
        self.env['bb.project.member.rate'].create({
            'member_id': m.id,
            'cost_per_hour': 120_000.0,
            'effective_from': '2020-01-01',
            'effective_to': '2020-12-31',   # fully in the past
        })
        self.assertAlmostEqual(m.current_rate, 0.0,
                               msg="Expired rate must not count as current")

    def test_44_rate_with_future_effective_to_still_active(self):
        """[TC-44] Rate with effective_to far in future is still active today"""
        m = self._make_member()
        self.env['bb.project.member.rate'].create({
            'member_id': m.id,
            'cost_per_hour': 175_000.0,
            'effective_from': '2026-01-01',
            'effective_to': '2099-12-31',
        })
        self.assertAlmostEqual(m.current_rate, 175_000.0)

    def test_45_multiple_rates_latest_from_wins(self):
        """[TC-45] When two rates both cover today, the one with the later effective_from wins"""
        m = self._make_member()
        self.env['bb.project.member.rate'].create({
            'member_id': m.id,
            'cost_per_hour': 100_000.0,
            'effective_from': '2026-01-01',
        })
        self.env['bb.project.member.rate'].create({
            'member_id': m.id,
            'cost_per_hour': 200_000.0,
            'effective_from': '2026-03-01',   # more recent → wins
        })
        m.invalidate_recordset(['current_rate'])
        self.assertAlmostEqual(m.current_rate, 200_000.0)

    def test_46_no_rates_current_rate_is_zero(self):
        """[TC-46] Member with no rate records → current_rate = 0.0"""
        m = self._make_member()
        self.assertAlmostEqual(m.current_rate, 0.0)

    def test_47_future_only_rate_not_yet_active(self):
        """[TC-47] Rate with effective_from in the future is NOT active yet → current_rate = 0"""
        m = self._make_member()
        self.env['bb.project.member.rate'].create({
            'member_id': m.id,
            'cost_per_hour': 999_000.0,
            'effective_from': '2099-01-01',   # far future
        })
        self.assertAlmostEqual(m.current_rate, 0.0,
                               msg="Future rate must not be counted as active today")


# ─────────────────────────────────────────────────────────────────────────────
# TC-48 → TC-52  Manager role
# ─────────────────────────────────────────────────────────────────────────────

class TestBbProjectManagerRole(TransactionCase):
    """TC-48 → TC-52: Manager group permissions and implied admin"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_manager = cls.env.ref('bb_project_management.group_bb_pm_manager')
        group_member  = cls.env.ref('bb_project_management.group_bb_pm_member')
        group_int_usr = cls.env.ref('base.group_user')

        cls.user_manager = cls.env['res.users'].create({
            'name': 'Test Manager',
            'login': 'test.manager@bb.com',
            'groups_id': [(6, 0, [group_manager.id, group_int_usr.id])],
        })
        cls.user_member = cls.env['res.users'].create({
            'name': 'Sec Member',
            'login': 'sec.member2@bb.com',
            'groups_id': [(6, 0, [group_member.id, group_int_usr.id])],
        })
        cls.project = cls.env['bb.project'].create({
            'name': 'Manager Test Project',
            'code': 'MGR-001',
        })
        cls.task = cls.env['bb.project.task'].create({
            'name': 'Manager Task',
            'project_id': cls.project.id,
        })

    def test_48_manager_can_create_project(self):
        """[TC-48] Manager has create permission on bb.project"""
        p = self.env['bb.project'].with_user(self.user_manager).create({
            'name': 'Manager Created Project',
            'code': 'MGR-002',
        })
        self.assertTrue(p.id)

    def test_49_manager_can_create_and_edit_task(self):
        """[TC-49] Manager can create tasks and update them"""
        t = self.env['bb.project.task'].with_user(self.user_manager).create({
            'name': 'Mgr Task',
            'project_id': self.project.id,
        })
        t.with_user(self.user_manager).write({'name': 'Mgr Task Updated'})
        self.assertEqual(t.name, 'Mgr Task Updated')

    def test_50_manager_implies_admin_can_approve(self):
        """[TC-50] Manager implies admin group → can approve backlogs"""
        b = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.user_manager.id,
            'work_date': '2026-04-14',
            'hours': 1.0,
        })
        # Should NOT raise — manager implies admin
        b.with_user(self.user_manager).action_approve()
        self.assertEqual(b.status, 'approved')

    def test_51_manager_sees_all_backlogs(self):
        """[TC-51] Manager record rule grants full visibility (not just own backlogs)"""
        other_user = self.env['res.users'].create({
            'name': 'Other User 2',
            'login': 'other.user2@bb.com',
        })
        self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': other_user.id,
            'work_date': '2026-04-15',
            'hours': 2.0,
        })
        self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.user_manager.id,
            'work_date': '2026-04-15',
            'hours': 1.0,
        })
        visible = self.env['bb.project.backlog'].with_user(self.user_manager).search([
            ('task_id', '=', self.task.id),
        ])
        user_ids = {b.user_id.id for b in visible}
        self.assertIn(other_user.id, user_ids,
                      "Manager must see backlogs logged by other users")

    def test_52_member_cannot_approve_even_own_backlog(self):
        """[TC-52] A plain member cannot approve, even their own backlog"""
        b = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.user_member.id,
            'work_date': '2026-04-16',
            'hours': 1.0,
        })
        with self.assertRaises(UserError):
            b.with_user(self.user_member).action_approve()


# ─────────────────────────────────────────────────────────────────────────────
# TC-53 → TC-56  Scope items
# ─────────────────────────────────────────────────────────────────────────────

class TestBbProjectScopeActions(TransactionCase):
    """TC-53 → TC-56: Scope item computed fields and action_create_task"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_admin = cls.env.ref('bb_project_management.group_bb_pm_admin')
        cls.env.user.write({'groups_id': [(4, group_admin.id)]})

        cls.project = cls.env['bb.project'].create({
            'name': 'Scope Action Project',
            'code': 'SAP-001',
        })

    def test_53_action_create_task_links_scope(self):
        """[TC-53] action_create_task() creates a task and sets scope.task_id"""
        scope = self.env['bb.project.scope'].create({
            'project_id': self.project.id,
            'name': 'Build API endpoint',
            'estimated_hours': 8.0,
        })
        self.assertFalse(scope.task_id)
        scope.action_create_task()
        self.assertTrue(scope.task_id, "scope.task_id must be set after action_create_task")
        self.assertEqual(scope.task_id.name, 'Build API endpoint')
        self.assertEqual(scope.task_id.project_id, self.project)

    def test_54_scope_estimated_cost_computed(self):
        """[TC-54] estimated_cost = estimated_hours × estimated_rate"""
        scope = self.env['bb.project.scope'].create({
            'project_id': self.project.id,
            'name': 'Design screens',
            'estimated_hours': 10.0,
            'estimated_rate': 150_000.0,
        })
        self.assertAlmostEqual(scope.estimated_cost, 1_500_000.0)

    def test_55_project_estimated_total_cost(self):
        """[TC-55] project.estimated_total_cost = sum of all scope items' estimated_cost"""
        p = self.env['bb.project'].create({
            'name': 'Total Scope Project',
            'code': 'TSP-001',
        })
        self.env['bb.project.scope'].create([
            {
                'project_id': p.id,
                'name': 'Scope A',
                'estimated_hours': 5.0,
                'estimated_rate': 100_000.0,
            },
            {
                'project_id': p.id,
                'name': 'Scope B',
                'estimated_hours': 3.0,
                'estimated_rate': 200_000.0,
            },
        ])
        p.invalidate_recordset(['estimated_total_cost'])
        expected = 5.0 * 100_000.0 + 3.0 * 200_000.0  # 1_100_000
        self.assertAlmostEqual(p.estimated_total_cost, expected)

    def test_56_action_create_task_with_assignee(self):
        """[TC-56] action_create_task propagates assignee_id to the created task"""
        scope = self.env['bb.project.scope'].create({
            'project_id': self.project.id,
            'name': 'Assigned Scope',
            'estimated_hours': 4.0,
            'assignee_id': self.env.user.id,
        })
        scope.action_create_task()
        self.assertEqual(scope.task_id.assignee_id.id, self.env.user.id)


# ─────────────────────────────────────────────────────────────────────────────
# TC-57 → TC-60  Task derived fields
# ─────────────────────────────────────────────────────────────────────────────

class TestBbProjectTaskDerived(TransactionCase):
    """TC-57 → TC-60: Task computed / relational fields"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_admin = cls.env.ref('bb_project_management.group_bb_pm_admin')
        cls.env.user.write({'groups_id': [(4, group_admin.id)]})

        cls.project = cls.env['bb.project'].create({
            'name': 'Task Derived Project',
            'code': 'TDP-001',
        })

    def test_57_task_company_id_inherited_from_project(self):
        """[TC-57] task.company_id is automatically taken from project.company_id"""
        task = self.env['bb.project.task'].create({
            'name': 'Company Task',
            'project_id': self.project.id,
        })
        self.assertEqual(task.company_id, self.project.company_id)

    def test_58_task_days_remaining_positive(self):
        """[TC-58] days_remaining is positive when end_at is in the future"""
        future_date = _fmt(date.today() + timedelta(days=10))
        task = self.env['bb.project.task'].create({
            'name': 'Deadline Task',
            'project_id': self.project.id,
            'end_at': future_date,
            'status': 'todo',
        })
        task.invalidate_recordset(['days_remaining'])
        self.assertGreater(task.days_remaining, 0)

    def test_59_task_backlog_count_increments(self):
        """[TC-59] task.backlog_count increments each time a backlog is added"""
        task = self.env['bb.project.task'].create({
            'name': 'Backlog Count Task',
            'project_id': self.project.id,
        })
        self.assertEqual(task.backlog_count, 0)
        self.env['bb.project.backlog'].create({
            'task_id': task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-04-17',
            'hours': 1.0,
        })
        task.invalidate_recordset(['backlog_count'])
        self.assertEqual(task.backlog_count, 1)

    def test_60_task_todo_status_is_default(self):
        """[TC-60] Task default status is 'todo'; can transition directly to 'done'"""
        task = self.env['bb.project.task'].create({
            'name': 'Quick Done Task',
            'project_id': self.project.id,
        })
        self.assertEqual(task.status, 'todo')
        task.action_set_done()
        self.assertEqual(task.status, 'done')
