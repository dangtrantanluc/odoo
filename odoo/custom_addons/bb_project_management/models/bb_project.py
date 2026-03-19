# -*- coding: utf-8 -*-
from odoo import models, fields, api
from odoo.exceptions import ValidationError


class BbProject(models.Model):
    _name = 'bb.project'
    _description = 'BB Project'
    _order = 'status, priority desc, name'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    _sql_constraints = [
        ('code_uniq', 'UNIQUE(code)', 'Project code must be unique across all projects.'),
    ]

    name = fields.Char(string='Project Name', required=True, tracking=True)
    code = fields.Char(string='Project Code', copy=False)
    owner_id = fields.Many2one(
        'res.users', string='Project Owner', required=True,
        default=lambda self: self.env.user, tracking=True,
    )
    company_id = fields.Many2one(
        'res.company', string='Company',
        required=True, default=lambda self: self.env.company,
    )
    customer_id = fields.Many2one('res.partner', string='Customer')
    account_manager_id = fields.Many2one('res.users', string='Account Manager')

    status = fields.Selection([
        ('planned',     'Planned'),
        ('in_progress', 'In Progress'),
        ('on_hold',     'On Hold'),
        ('completed',   'Completed'),
        ('cancelled',   'Cancelled'),
    ], string='Status', default='planned', tracking=True, index=True)

    priority = fields.Selection([
        ('low',      'Low'),
        ('medium',   'Medium'),
        ('high',     'High'),
        ('critical', 'Critical'),
    ], string='Priority', default='medium', tracking=True)

    start_date = fields.Date(string='Start Date', tracking=True)
    end_date = fields.Date(string='End Date', tracking=True)

    budget = fields.Monetary(string='Budget', currency_field='currency_id', tracking=True)
    currency_id = fields.Many2one(
        'res.currency', string='Currency',
        default=lambda self: (
            self.env['res.currency'].search([('name', '=', 'VND')], limit=1)
            or self.env.company.currency_id
        ),
    )
    description = fields.Html(string='Description')

    # Relations
    member_ids = fields.One2many('bb.project.member', 'project_id', string='Team Members')
    task_ids = fields.One2many('bb.project.task', 'project_id', string='Tasks')
    tag_ids = fields.Many2many(
        'bb.project.tag', 'bb_project_tag_rel', 'project_id', 'tag_id', string='Tags',
    )
    worklog_ids = fields.One2many('bb.project.backlog', 'project_id', string='Work Logs')
    scope_ids = fields.One2many('bb.project.scope', 'project_id', string='Backlog')
    milestone_ids = fields.One2many('bb.project.milestone', 'project_id', string='Milestones')

    # Estimated totals from scope items
    estimated_total_hours = fields.Float(
        string='Estimated Hours', compute='_compute_estimated', store=True,
    )
    estimated_total_cost = fields.Monetary(
        string='Estimated Cost', currency_field='currency_id',
        compute='_compute_estimated', store=True,
    )

    # Smart button counters
    task_count = fields.Integer(string='Tasks', compute='_compute_counts', store=True)
    member_count = fields.Integer(string='Members', compute='_compute_counts', store=True)
    backlog_count = fields.Integer(string='Backlogs', compute='_compute_counts', store=True)
    scope_count = fields.Integer(string='Scope Items', compute='_compute_counts', store=True)
    milestone_count = fields.Integer(string='Milestones', compute='_compute_counts', store=True)

    # Financial summaries
    total_hours = fields.Float(
        string='Total Hours (Approved)', compute='_compute_financials', store=True,
    )
    total_cost = fields.Monetary(
        string='Total Cost (Approved)', currency_field='currency_id',
        compute='_compute_financials', store=True,
    )
    budget_remaining = fields.Monetary(
        string='Budget Remaining', currency_field='currency_id',
        compute='_compute_financials', store=True,
    )
    estimation_progress = fields.Integer(
        string='Estimation Progress',
        compute='_compute_estimation_progress',
    )

    # ── Computed fields ───────────────────────────────────────────────────────

    @api.depends('scope_ids.estimated_hours', 'scope_ids.estimated_cost')
    def _compute_estimated(self):
        for rec in self:
            rec.estimated_total_hours = sum(rec.scope_ids.mapped('estimated_hours'))
            rec.estimated_total_cost = sum(rec.scope_ids.mapped('estimated_cost'))

    @api.depends('scope_ids.task_id')
    def _compute_estimation_progress(self):
        for rec in self:
            total = len(rec.scope_ids)
            linked = len(rec.scope_ids.filtered(lambda s: s.task_id))
            rec.estimation_progress = round(linked / total * 100) if total else 0

    @api.depends('task_ids', 'member_ids', 'scope_ids', 'milestone_ids', 'task_ids.backlog_ids')
    def _compute_counts(self):
        # Batch-fetch backlog counts to avoid N+1 queries
        backlog_data = {
            row['project_id'][0]: row['project_id_count']
            for row in self.env['bb.project.backlog'].read_group(
                [('project_id', 'in', self.ids)],
                ['project_id'],
                ['project_id'],
            )
        }
        for rec in self:
            rec.task_count = len(rec.task_ids)
            rec.member_count = len(rec.member_ids)
            rec.scope_count = len(rec.scope_ids)
            rec.milestone_count = len(rec.milestone_ids)
            rec.backlog_count = backlog_data.get(rec.id, 0)

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

    # ── Constraints ───────────────────────────────────────────────────────────

    @api.constrains('start_date', 'end_date')
    def _check_dates(self):
        for rec in self:
            if rec.start_date and rec.end_date and rec.end_date < rec.start_date:
                raise ValidationError("End Date must be after Start Date.")

    # ── Status transitions ────────────────────────────────────────────────────

    def _write_status(self, status):
        self.write({'status': status})

    def action_set_in_progress(self):
        self._write_status('in_progress')

    def action_set_on_hold(self):
        self._write_status('on_hold')

    def action_set_completed(self):
        self._write_status('completed')

    def action_set_cancelled(self):
        self._write_status('cancelled')

    def action_reopen(self):
        self._write_status('in_progress')

    # ── Navigation actions ────────────────────────────────────────────────────

    def _open_related(self, model, name, domain_field, view_mode='tree,kanban,form'):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': f'{name} — {self.name}',
            'res_model': model,
            'view_mode': view_mode,
            'domain': [(domain_field, '=', self.id)],
            'context': {f'default_{domain_field}': self.id},
        }

    def action_view_tasks(self):
        return self._open_related('bb.project.task', 'Tasks', 'project_id')

    def action_view_backlogs(self):
        return self._open_related('bb.project.backlog', 'Work Logs', 'project_id', 'tree,form')

    def action_view_milestones(self):
        return self._open_related('bb.project.milestone', 'Milestones', 'project_id', 'tree,form')

    def action_view_scope(self):
        return self._open_related('bb.project.scope', 'Backlog', 'project_id', 'tree,form')

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
