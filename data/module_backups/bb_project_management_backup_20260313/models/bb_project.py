# -*- coding: utf-8 -*-
from odoo import models, fields, api


class BbProject(models.Model):
    _name = 'bb.project'
    _description = 'BB Project'
    _order = 'status, priority desc, name'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    name = fields.Char(string='Project Name', required=True, tracking=True)
    code = fields.Char(string='Project Code', copy=False)
    owner_id = fields.Many2one(
        'res.users', string='Project Owner', required=True,
        default=lambda self: self.env.user, tracking=True,
    )
    company_id = fields.Many2one(
        'res.company', string='Company', 
        required=True, default=lambda self: self.env.company
    )
    customer_id = fields.Many2one('res.partner', string='Customer')

    status = fields.Selection([
        ('planned', 'Planned'),
        ('in_progress', 'In Progress'),
        ('on_hold', 'On Hold'),
        ('completed', 'Completed'),
        ('cancelled', 'Cancelled'),
    ], string='Status', default='planned', tracking=True, index=True)
    priority = fields.Selection([
        ('low', 'Low'),
        ('medium', 'Medium'),
        ('high', 'High'),
        ('critical', 'Critical'),
    ], string='Priority', default='medium', tracking=True)

    start_date = fields.Date(string='Start Date', tracking=True)
    end_date = fields.Date(string='End Date', tracking=True)

    budget = fields.Monetary(string='Budget', currency_field='currency_id', tracking=True)
    currency_id = fields.Many2one(
        'res.currency', string='Currency',
        default=lambda self: self.env.company.currency_id,
    )
    description = fields.Html(string='Description')

    # Relations
    member_ids = fields.One2many(
        'bb.project.member', 'project_id', string='Team Members',
    )
    task_ids = fields.One2many(
        'bb.project.task', 'project_id', string='Tasks',
    )
    tag_ids = fields.Many2many(
        'bb.project.tag', 'bb_project_tag_rel', 'project_id', 'tag_id', string='Tags',
    )

    # Smart button counters
    task_count = fields.Integer(string='Tasks', compute='_compute_counts', store=True)
    member_count = fields.Integer(string='Members', compute='_compute_counts', store=True)
    backlog_count = fields.Integer(string='Backlogs', compute='_compute_counts', store=True)

    # Financial summaries
    total_hours = fields.Float(
        string='Total Hours (Approved)',
        compute='_compute_financials',
        store=True,
    )
    total_cost = fields.Monetary(
        string='Total Cost (Approved)',
        currency_field='currency_id',
        compute='_compute_financials',
        store=True,
    )
    budget_remaining = fields.Monetary(
        string='Budget Remaining',
        currency_field='currency_id',
        compute='_compute_financials',
        store=True,
    )

    @api.depends('task_ids', 'member_ids')
    def _compute_counts(self):
        for rec in self:
            rec.task_count = len(rec.task_ids)
            rec.member_count = len(rec.member_ids)
            # backlog count from all tasks
            rec.backlog_count = sum(len(t.backlog_ids) for t in rec.task_ids)

    @api.depends(
        'task_ids.backlog_ids.status',
        'task_ids.backlog_ids.hours',
        'task_ids.backlog_ids.total_cost_snapshot',
        'budget',
    )
    def _compute_financials(self):
        for rec in self:
            approved = rec.task_ids.mapped('backlog_ids').filtered(
                lambda b: b.status == 'approved'
            )
            rec.total_hours = sum(approved.mapped('hours'))
            rec.total_cost = sum(approved.mapped('total_cost_snapshot'))
            rec.budget_remaining = (rec.budget or 0.0) - rec.total_cost

    @api.constrains('start_date', 'end_date')
    def _check_dates(self):
        for rec in self:
            if rec.start_date and rec.end_date and rec.end_date < rec.start_date:
                raise models.ValidationError("End Date must be after Start Date.")

    # Status transition actions
    def action_set_in_progress(self):
        self.write({'status': 'in_progress'})

    def action_set_on_hold(self):
        self.write({'status': 'on_hold'})

    def action_set_completed(self):
        self.write({'status': 'completed'})

    def action_set_cancelled(self):
        self.write({'status': 'cancelled'})

    def action_reopen(self):
        self.write({'status': 'in_progress'})

    # Smart button actions
    def action_view_tasks(self):
        return {
            'type': 'ir.actions.act_window',
            'name': f'Tasks — {self.name}',
            'res_model': 'bb.project.task',
            'view_mode': 'tree,kanban,form',
            'domain': [('project_id', '=', self.id)],
            'context': {'default_project_id': self.id},
        }

    def action_open_customer(self):
        """Open the customer profile from the project kanban view."""
        self.ensure_one()
        if not self.customer_id:
            return
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'res.partner',
            'res_id': self.customer_id.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def action_view_backlogs(self):
        return {
            'type': 'ir.actions.act_window',
            'name': f'Work Logs — {self.name}',
            'res_model': 'bb.project.backlog',
            'view_mode': 'tree,form',
            'domain': [('project_id', '=', self.id)],
            'context': {'default_project_id': self.id},
        }
