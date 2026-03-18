# -*- coding: utf-8 -*-
from odoo.tests.common import TransactionCase
from odoo.exceptions import AccessError, UserError


class TestBbProjectCore(TransactionCase):
    """TC-01 → TC-10: Core model logic"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Ensure test user is in bb_pm_admin so approve/reject work
        group_admin = cls.env.ref('bb_project_management.group_bb_pm_admin')
        cls.env.user.write({'groups_id': [(4, group_admin.id)]})

        cls.project = cls.env['bb.project'].create({
            'name': 'Test Project Alpha',
            'code': 'TST-001',
            'status': 'planned',
            'priority': 'medium',
            'start_date': '2026-01-01',
            'end_date': '2026-12-31',
            'budget': 10_000_000.0,
        })
        cls.task = cls.env['bb.project.task'].create({
            'name': 'Test Task',
            'project_id': cls.project.id,
            'status': 'todo',
            'priority': 'high',
        })
        cls.member = cls.env['bb.project.member'].create({
            'project_id': cls.project.id,
            'user_id': cls.env.user.id,
            'role': 'DEV',
        })
        cls.rate = cls.env['bb.project.member.rate'].create({
            'member_id': cls.member.id,
            'cost_per_hour': 150_000.0,
            'effective_from': '2026-01-01',
        })

    # ── TC-01: Project defaults ──────────────────────────────────────────────
    def test_01_project_defaults(self):
        """[TC-01] Project created with correct field defaults"""
        self.assertEqual(self.project.status, 'planned')
        self.assertEqual(self.project.priority, 'medium')
        self.assertEqual(self.project.budget, 10_000_000.0)
        self.assertEqual(self.project.task_count, 1)
        self.assertEqual(self.project.member_count, 1)

    # ── TC-02: Member current rate ───────────────────────────────────────────
    def test_02_member_current_rate(self):
        """[TC-02] Member.current_rate returns most recent effective rate"""
        self.assertAlmostEqual(self.member.current_rate, 150_000.0)

    def test_02b_member_rate_latest_wins(self):
        """[TC-02b] When multiple rates exist, latest effective_from (past date) wins"""
        self.env['bb.project.member.rate'].create({
            'member_id': self.member.id,
            'cost_per_hour': 200_000.0,
            'effective_from': '2026-02-01',  # past date, more recent than 2026-01-01
        })
        self.member.invalidate_recordset(['current_rate'])
        self.assertAlmostEqual(self.member.current_rate, 200_000.0)

    # ── TC-03: Backlog cost snapshot ─────────────────────────────────────────
    def test_03_backlog_auto_snapshot(self):
        """[TC-03] Creating backlog auto-captures cost_per_hour from member rate"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-03-01',
            'hours': 4.0,
        })
        self.assertAlmostEqual(backlog.cost_per_hour_snapshot, 150_000.0)
        self.assertAlmostEqual(backlog.total_cost_snapshot, 600_000.0)
        self.assertEqual(backlog.status, 'pending')

    def test_03b_backlog_no_member_snapshot_zero(self):
        """[TC-03b] Backlog for user with no member record → snapshot = 0"""
        other_user = self.env['res.users'].create({
            'name': 'No Rate User',
            'login': 'norate@test.com',
        })
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': other_user.id,
            'work_date': '2026-03-01',
            'hours': 2.0,
        })
        self.assertAlmostEqual(backlog.cost_per_hour_snapshot, 0.0)

    # ── TC-04: Backlog approval flow ─────────────────────────────────────────
    def test_04_approve_backlog_updates_project(self):
        """[TC-04] Approving backlog rolls total_cost up to project"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-03-02',
            'hours': 2.0,
        })
        backlog.action_approve()
        self.assertEqual(backlog.status, 'approved')
        self.assertEqual(backlog.approver_id, self.env.user)
        self.project._compute_financials()
        self.assertGreater(self.project.total_cost, 0)

    def test_04b_reject_backlog(self):
        """[TC-04b] Rejecting backlog sets status = rejected"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-03-03',
            'hours': 1.0,
        })
        backlog.action_reject()
        self.assertEqual(backlog.status, 'rejected')

    def test_04c_approve_already_approved_raises(self):
        """[TC-04c] Approving an already-approved backlog raises UserError"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-03-04',
            'hours': 1.0,
        })
        backlog.action_approve()
        with self.assertRaises(UserError):
            backlog.action_approve()

    def test_04d_reset_to_pending(self):
        """[TC-04d] Resetting approved backlog → pending, clears approver"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-03-05',
            'hours': 1.0,
        })
        backlog.action_approve()
        backlog.action_reset_to_pending()
        self.assertEqual(backlog.status, 'pending')
        self.assertFalse(backlog.approver_id)

    # ── TC-05: Task status transitions ───────────────────────────────────────
    def test_05_task_full_workflow(self):
        """[TC-05] Task flows: todo → in_progress → review → done"""
        task = self.env['bb.project.task'].create({
            'name': 'Workflow Task',
            'project_id': self.project.id,
            'status': 'todo',
        })
        task.action_set_in_progress()
        self.assertEqual(task.status, 'in_progress')
        task.action_set_review()
        self.assertEqual(task.status, 'review')
        task.action_set_done()
        self.assertEqual(task.status, 'done')

    # ── TC-06: Project status transitions ────────────────────────────────────
    def test_06_project_full_workflow(self):
        """[TC-06] Project flows: planned → in_progress → on_hold → reopen → completed"""
        p = self.env['bb.project'].create({
            'name': 'Lifecycle Project',
            'code': 'LCP-001',
            'status': 'planned',
        })
        p.action_set_in_progress()
        self.assertEqual(p.status, 'in_progress')
        p.action_set_on_hold()
        self.assertEqual(p.status, 'on_hold')
        p.action_reopen()
        self.assertEqual(p.status, 'in_progress')
        p.action_set_completed()
        self.assertEqual(p.status, 'completed')

    def test_06b_project_cancel(self):
        """[TC-06b] Project can be cancelled"""
        p = self.env['bb.project'].create({
            'name': 'Cancel Project',
            'code': 'CXL-001',
            'status': 'in_progress',
        })
        p.action_set_cancelled()
        self.assertEqual(p.status, 'cancelled')

    # ── TC-07: Budget remaining ──────────────────────────────────────────────
    def test_07_budget_remaining_no_cost(self):
        """[TC-07] budget_remaining = budget when no approved backlogs"""
        p = self.env['bb.project'].create({
            'name': 'Budget Project',
            'code': 'BGT-001',
            'budget': 5_000_000.0,
        })
        self.assertAlmostEqual(p.budget_remaining, 5_000_000.0)

    # ── TC-08: Duplicate project code ────────────────────────────────────────
    def test_08_duplicate_code_raises(self):
        """[TC-08] Two projects with same code raises an error"""
        with self.assertRaises(Exception):
            self.env['bb.project'].create({
                'name': 'Duplicate Code',
                'code': 'TST-001',
            })

    # ── TC-09: Task count computed ───────────────────────────────────────────
    def test_09_task_count_updates(self):
        """[TC-09] task_count increments when new task added"""
        before = self.project.task_count
        self.env['bb.project.task'].create({
            'name': 'Extra Task',
            'project_id': self.project.id,
        })
        self.project._compute_counts()
        self.assertEqual(self.project.task_count, before + 1)

    # ── TC-10: Zero-hour backlog ─────────────────────────────────────────────
    def test_10_backlog_zero_hours_total_zero(self):
        """[TC-10] Backlog with 0 hours → total_cost_snapshot = 0"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-03-10',
            'hours': 0.0,
        })
        self.assertAlmostEqual(backlog.total_cost_snapshot, 0.0)


class TestBbProjectSecurity(TransactionCase):
    """TC-11 → TC-16: Role-based access control"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        group_member  = cls.env.ref('bb_project_management.group_bb_pm_member')
        group_viewer  = cls.env.ref('bb_project_management.group_bb_pm_viewer')
        group_int_usr = cls.env.ref('base.group_user')   # Internal User — needed for mail

        cls.user_member = cls.env['res.users'].create({
            'name': 'Test Member',
            'login': 'test.member@bb.com',
            'groups_id': [(6, 0, [group_member.id, group_int_usr.id])],
        })
        cls.user_viewer = cls.env['res.users'].create({
            'name': 'Test Viewer',
            'login': 'test.viewer@bb.com',
            'groups_id': [(6, 0, [group_viewer.id, group_int_usr.id])],
        })
        cls.project = cls.env['bb.project'].create({
            'name': 'Security Test Project',
            'code': 'SEC-001',
            'owner_id': cls.user_member.id,
        })
        cls.task = cls.env['bb.project.task'].create({
            'name': 'Security Task',
            'project_id': cls.project.id,
        })

    def test_11_member_can_create_own_backlog(self):
        """[TC-11] Member can create backlog logged under themselves"""
        backlog = self.env['bb.project.backlog'].with_user(self.user_member).create({
            'task_id': self.task.id,
            'user_id': self.user_member.id,
            'work_date': '2026-03-01',
            'hours': 3.0,
        })
        self.assertEqual(backlog.status, 'pending')

    def test_12_member_cannot_approve_backlog(self):
        """[TC-12] Member role cannot approve backlogs (admin-only action)"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.user_member.id,
            'work_date': '2026-03-06',
            'hours': 1.0,
        })
        with self.assertRaises(UserError):
            backlog.with_user(self.user_member).action_approve()

    def test_13_viewer_cannot_create_project(self):
        """[TC-13] Viewer has no create permission on bb.project"""
        with self.assertRaises(AccessError):
            self.env['bb.project'].with_user(self.user_viewer).create({
                'name': 'Viewer Created Project',
                'code': 'VWR-001',
            })

    def test_14_viewer_can_read_project(self):
        """[TC-14] Viewer can search and read projects"""
        projects = self.env['bb.project'].with_user(self.user_viewer).search([])
        self.assertGreater(len(projects), 0)

    def test_15_member_sees_only_own_backlogs(self):
        """[TC-15] Member record rule: member only sees backlogs where user_id = self"""
        other_user = self.env['res.users'].create({
            'name': 'Other User',
            'login': 'other.user@bb.com',
        })
        self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': other_user.id,
            'work_date': '2026-03-01',
            'hours': 2.0,
        })
        self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.user_member.id,
            'work_date': '2026-03-01',
            'hours': 1.0,
        })
        visible = self.env['bb.project.backlog'].with_user(self.user_member).search([])
        for b in visible:
            self.assertEqual(b.user_id.id, self.user_member.id,
                             "Member must only see their own backlogs")

    def test_16_viewer_cannot_delete_project(self):
        """[TC-16] Viewer cannot unlink projects"""
        with self.assertRaises(AccessError):
            self.project.with_user(self.user_viewer).unlink()


class TestBbProjectScope(TransactionCase):
    """TC-17 → TC-19: Scope items"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.project = cls.env['bb.project'].create({
            'name': 'Scope Project',
            'code': 'SCP-001',
        })

    def test_17_scope_item_create(self):
        """[TC-17] Scope item created and linked to project"""
        scope = self.env['bb.project.scope'].create({
            'project_id': self.project.id,
            'name': 'Design UI',
            'estimated_hours': 40.0,
        })
        self.assertEqual(scope.project_id.id, self.project.id)
        self.assertAlmostEqual(scope.estimated_hours, 40.0)

    def test_18_scope_count_on_project(self):
        """[TC-18] scope_count on project reflects number of scope items"""
        before = self.project.scope_count
        self.env['bb.project.scope'].create({
            'project_id': self.project.id,
            'name': 'Backend API',
            'estimated_hours': 80.0,
        })
        self.project._compute_counts()
        self.assertEqual(self.project.scope_count, before + 1)

    def test_19_scope_cascade_delete(self):
        """[TC-19] Scope items are cascade-deleted when project is deleted"""
        p = self.env['bb.project'].create({'name': 'Del Project', 'code': 'DEL-002'})
        scope = self.env['bb.project.scope'].create({
            'project_id': p.id,
            'name': 'To Delete',
        })
        scope_id = scope.id
        p.unlink()
        remaining = self.env['bb.project.scope'].search([('id', '=', scope_id)])
        self.assertEqual(len(remaining), 0)


class TestBbProjectTag(TransactionCase):
    """TC-20: Tags"""

    def test_20_tag_m2m_add_remove(self):
        """[TC-20] Tags can be added and removed from a project"""
        tag = self.env['bb.project.tag'].create({'name': 'TestTag_Unique_2026'})
        project = self.env['bb.project'].create({
            'name': 'Tagged Project',
            'code': 'TAG-001',
            'tag_ids': [(4, tag.id)],
        })
        self.assertIn(tag, project.tag_ids)
        project.write({'tag_ids': [(3, tag.id)]})
        self.assertNotIn(tag, project.tag_ids)
