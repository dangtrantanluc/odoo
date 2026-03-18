# -*- coding: utf-8 -*-
from odoo import models, fields, api
from odoo.exceptions import UserError


class BbProjectBacklog(models.Model):
    _name = 'bb.project.backlog'
    _description = 'BB Project Backlog / Work Log'
    _order = 'work_date desc, id desc'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    task_id = fields.Many2one(
        'bb.project.task', string='Task', required=True, ondelete='cascade', index=True,
    )
    project_id = fields.Many2one(
        'bb.project', string='Project', related='task_id.project_id', store=True, index=True,
    )
    company_id = fields.Many2one(
        'res.company', string='Company', related='project_id.company_id', store=True, index=True,
    )
    user_id = fields.Many2one(
        'res.users', string='Logged By', required=True,
        default=lambda self: self.env.user,
    )
    work_date = fields.Date(string='Work Date', required=True, default=fields.Date.today)
    hours = fields.Float(string='Hours', required=True, digits=(6, 2))
    description = fields.Text(string='Description')

    cost_per_hour_snapshot = fields.Monetary(
        string='Cost / Hour (Snapshot)',
        currency_field='currency_id',
        readonly=True,
        help='Rate at the time of logging (auto-filled on save)',
    )
    
    total_cost_snapshot = fields.Monetary(
        string='Total Cost',
        currency_field='currency_id',
        compute='_compute_total_cost',
        store=True,
    )
    currency_id = fields.Many2one(
        'res.currency', related='project_id.currency_id', string='Currency', store=True,
    )

    status = fields.Selection([
        ('pending', 'Pending'),
        ('approved', 'Approved'),
        ('rejected', 'Rejected'),
    ], string='Status', default='pending', tracking=True, index=True)

    approver_id = fields.Many2one('res.users', string='Approved / Rejected By', readonly=True)

    @api.depends('hours', 'cost_per_hour_snapshot')
    def _compute_total_cost(self):
        for rec in self:
            rec.total_cost_snapshot = rec.hours * (rec.cost_per_hour_snapshot or 0.0)

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            # Auto-capture the member's current rate if not already set
            if not vals.get('cost_per_hour_snapshot') and vals.get('task_id') and vals.get('user_id'):
                task = self.env['bb.project.task'].browse(vals['task_id'])
                member = self.env['bb.project.member'].search([
                    ('project_id', '=', task.project_id.id),
                    ('user_id', '=', vals['user_id']),
                ], limit=1)
                vals['cost_per_hour_snapshot'] = member.current_rate if member else 0.0
        return super().create(vals_list)

    def action_approve(self):
        if not self.env.user.has_group('bb_project_management.group_bb_pm_admin'):
            raise UserError("Only administrators can approve work logs.")
        for rec in self:
            if rec.status != 'pending':
                raise UserError(f"Backlog '{rec.id}' is not in Pending status.")
            rec.write({'status': 'approved', 'approver_id': self.env.user.id})

    def action_reject(self):
        if not self.env.user.has_group('bb_project_management.group_bb_pm_admin'):
            raise UserError("Only administrators can reject work logs.")
        for rec in self:
            if rec.status != 'pending':
                raise UserError(f"Backlog '{rec.id}' is not in Pending status.")
            rec.write({'status': 'rejected', 'approver_id': self.env.user.id})

    def action_reset_to_pending(self):
        self.write({'status': 'pending', 'approver_id': False})
