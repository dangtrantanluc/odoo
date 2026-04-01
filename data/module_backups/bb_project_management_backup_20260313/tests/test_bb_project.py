# -*- coding: utf-8 -*-
from odoo.tests.common import TransactionCase
from odoo.exceptions import AccessError


class TestBbProject(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Create a project
        cls.project = cls.env['bb.project'].create({
            'name': 'Test Project',
            'code': 'TST-001',
            'status': 'planned',
            'priority': 'medium',
            'start_date': '2026-01-01',
            'end_date': '2026-12-31',
            'budget': 10000.0,
        })
        # Create a task
        cls.task = cls.env['bb.project.task'].create({
            'name': 'Test Task',
            'project_id': cls.project.id,
            'status': 'todo',
            'priority': 'high',
        })
        # Create a member
        cls.member = cls.env['bb.project.member'].create({
            'project_id': cls.project.id,
            'user_id': cls.env.user.id,
            'role': 'DEV',
        })
        # Create a rate for the member
        cls.rate = cls.env['bb.project.member.rate'].create({
            'member_id': cls.member.id,
            'cost_per_hour': 50.0,
            'effective_from': '2026-01-01',
        })

    def test_01_project_defaults(self):
        """Project is created with correct defaults"""
        self.assertEqual(self.project.status, 'planned')
        self.assertEqual(self.project.priority, 'medium')
        self.assertEqual(self.project.budget, 10000.0)
        self.assertEqual(self.project.task_count, 1)
        self.assertEqual(self.project.member_count, 1)

    def test_02_member_current_rate(self):
        """Current rate is computed from the active date-range rate"""
        self.assertAlmostEqual(self.member.current_rate, 50.0)

    def test_03_backlog_cost_snapshot(self):
        """Creating a backlog auto-captures cost_per_hour from member rate"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-03-01',
            'hours': 4.0,
        })
        self.assertAlmostEqual(backlog.cost_per_hour_snapshot, 50.0)
        self.assertAlmostEqual(backlog.total_cost_snapshot, 200.0)
        self.assertEqual(backlog.status, 'pending')

    def test_04_approve_backlog_updates_project_totals(self):
        """Approving a backlog rolls costs up to the project"""
        backlog = self.env['bb.project.backlog'].create({
            'task_id': self.task.id,
            'user_id': self.env.user.id,
            'work_date': '2026-03-02',
            'hours': 2.0,
            'cost_per_hour_snapshot': 50.0,
        })
        self.assertAlmostEqual(self.project.total_cost, 0.0)
        backlog.action_approve()
        self.assertEqual(backlog.status, 'approved')
        # Force re-compute
        self.project._compute_financials()
        self.assertAlmostEqual(self.project.total_cost, 100.0)

    def test_05_task_status_transitions(self):
        """Task status transitions work correctly"""
        self.task.action_set_in_progress()
        self.assertEqual(self.task.status, 'in_progress')
        self.task.action_set_review()
        self.assertEqual(self.task.status, 'review')
        self.task.action_set_done()
        self.assertEqual(self.task.status, 'done')

    def test_06_project_status_transitions(self):
        """Project status transitions work correctly"""
        self.project.action_set_in_progress()
        self.assertEqual(self.project.status, 'in_progress')
        self.project.action_set_on_hold()
        self.assertEqual(self.project.status, 'on_hold')
        self.project.action_reopen()
        self.assertEqual(self.project.status, 'in_progress')
        self.project.action_set_completed()
        self.assertEqual(self.project.status, 'completed')
