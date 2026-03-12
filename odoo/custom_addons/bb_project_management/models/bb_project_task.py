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
        'res.company', string='Company', related='project_id.company_id', store=True, index=True,
    )
    assignee_id = fields.Many2one(
        'res.users', string='Assignee', tracking=True, index=True,
    )
    status = fields.Selection([
        ('todo', 'To Do'),
        ('in_progress', 'In Progress'),
        ('review', 'Review'),
        ('done', 'Done'),
    ], string='Status', default='todo', tracking=True, index=True)
    priority = fields.Selection([
        ('low', 'Low'),
        ('medium', 'Medium'),
        ('high', 'High'),
        ('critical', 'Critical'),
    ], string='Priority', default='medium', tracking=True)

    deadline = fields.Date(string='Deadline')
    description = fields.Html(string='Description')
    result = fields.Text(string='Result / Output', tracking=True)
    issues = fields.Text(string='Issues / Blockers', tracking=True)

    milestone_id = fields.Many2one(
        'bb.project.milestone', string='Milestone',
        domain="[('project_id', '=', project_id)]",
    )
    tag_ids = fields.Many2many(
        'bb.project.tag', 'bb_project_task_tag_rel', 'task_id', 'tag_id', string='Tags',
    )
    backlog_ids = fields.One2many(
        'bb.project.backlog', 'task_id', string='Work Logs',
    )

    total_hours = fields.Float(
        string='Total Hours (Approved)',
        compute='_compute_total_hours',
        store=True,
    )
    total_cost = fields.Monetary(
        string='Total Cost (Approved)',
        compute='_compute_total_hours',
        store=True,
        currency_field='currency_id',
    )
    currency_id = fields.Many2one(
        'res.currency', related='project_id.currency_id', store=True,
    )
    backlog_count = fields.Integer(
        string='Work Logs',
        compute='_compute_backlog_count',
    )

    @api.depends('backlog_ids', 'backlog_ids.status', 'backlog_ids.hours', 'backlog_ids.total_cost_snapshot')
    def _compute_total_hours(self):
        for rec in self:
            approved = rec.backlog_ids.filtered(lambda b: b.status == 'approved')
            rec.total_hours = sum(approved.mapped('hours'))
            rec.total_cost = sum(approved.mapped('total_cost_snapshot'))

    def _compute_backlog_count(self):
        for rec in self:
            rec.backlog_count = len(rec.backlog_ids)

    # Kanban state transitions
    def action_set_todo(self):
        self.write({'status': 'todo'})

    def action_set_in_progress(self):
        self.write({'status': 'in_progress'})

    def action_set_review(self):
        self.write({'status': 'review'})

    def action_set_done(self):
        self.write({'status': 'done'})
