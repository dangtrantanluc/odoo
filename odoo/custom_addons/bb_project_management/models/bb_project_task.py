# -*- coding: utf-8 -*-
from odoo import models, fields, api


class BbProjectTask(models.Model):
    _name = 'bb.project.task'
    _description = 'BB Project Task'
    _order = 'project_id, status, priority desc, id'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    name = fields.Char(string='Title', required=True, tracking=True)
    project_id = fields.Many2one(
        'bb.project', string='Project', required=True, ondelete='cascade', index=True,
    )
    company_id = fields.Many2one(
        'res.company', related='project_id.company_id', store=True, index=True,
    )
    assignee_id = fields.Many2one('res.users', string='Assignee', tracking=True, index=True)

    status = fields.Selection([
        ('todo',        'To Do'),
        ('in_progress', 'In Progress'),
        ('review',      'Review'),
        ('done',        'Done'),
    ], string='Status', default='todo', tracking=True, index=True)

    priority = fields.Selection([
        ('low',      'Low'),
        ('medium',   'Medium'),
        ('high',     'High'),
        ('critical', 'Critical'),
    ], string='Priority', default='medium', tracking=True)

    deadline = fields.Date(string='Deadline')
    end_at = fields.Date(string='End At', tracking=True, help='Planned completion date for this task')
    days_remaining = fields.Integer(string='Days Left', compute='_compute_days_remaining', store=False)

    milestone_id = fields.Many2one(
        'bb.project.milestone', string='Milestone', ondelete='set null', index=True,
        domain="[('project_id', '=', project_id)]",
    )
    description = fields.Html(string='Description')
    result = fields.Text(string='Result / Output', tracking=True)
    issues = fields.Text(string='Issues / Blockers', tracking=True)

    tag_ids = fields.Many2many(
        'bb.project.tag', 'bb_project_task_tag_rel', 'task_id', 'tag_id', string='Tags',
    )
    backlog_ids = fields.One2many('bb.project.backlog', 'task_id', string='Work Logs')

    total_hours = fields.Float(
        string='Total Hours (Approved)', compute='_compute_totals', store=True,
    )
    total_cost = fields.Monetary(
        string='Total Cost (Approved)', compute='_compute_totals', store=True,
        currency_field='currency_id',
    )
    currency_id = fields.Many2one('res.currency', related='project_id.currency_id', store=True)
    backlog_count = fields.Integer(string='Work Logs', compute='_compute_totals', store=True)

    # ── Computed fields ───────────────────────────────────────────────────────

    @api.depends('end_at', 'status')
    def _compute_days_remaining(self):
        today = fields.Date.today()
        for rec in self:
            if rec.end_at and rec.status != 'done':
                rec.days_remaining = (rec.end_at - today).days
            else:
                rec.days_remaining = 0

    @api.depends('backlog_ids', 'backlog_ids.status', 'backlog_ids.hours', 'backlog_ids.total_cost_snapshot')
    def _compute_totals(self):
        for rec in self:
            approved = rec.backlog_ids.filtered(lambda b: b.status == 'approved')
            rec.total_hours = sum(approved.mapped('hours'))
            rec.total_cost = sum(approved.mapped('total_cost_snapshot'))
            rec.backlog_count = len(rec.backlog_ids)

    # ── Status transitions ────────────────────────────────────────────────────

    def _write_status(self, status):
        self.write({'status': status})

    def action_set_todo(self):
        self._write_status('todo')

    def action_set_in_progress(self):
        self._write_status('in_progress')

    def action_set_review(self):
        self._write_status('review')

    def action_set_done(self):
        self._write_status('done')
