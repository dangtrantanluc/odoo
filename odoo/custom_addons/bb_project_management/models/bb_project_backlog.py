# -*- coding: utf-8 -*-
from odoo import models, fields, api
from odoo.exceptions import UserError

_ADMIN_GROUP = 'bb_project_management.group_bb_pm_admin'


class BbProjectBacklog(models.Model):
    _name = 'bb.project.backlog'
    _description = 'BB Project Backlog / Work Log'
    _order = 'work_date desc, id desc'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    task_id = fields.Many2one(
        'bb.project.task', string='Task', required=True, ondelete='cascade', index=True,
    )
    project_id = fields.Many2one(
        'bb.project', related='task_id.project_id', store=True, index=True,
    )
    company_id = fields.Many2one(
        'res.company', related='project_id.company_id', store=True, index=True,
    )
    user_id = fields.Many2one(
        'res.users', string='Logged By', required=True, default=lambda self: self.env.user,
    )
    work_date = fields.Date(string='Work Date', required=True, default=fields.Date.today)
    hours = fields.Float(string='Hours', required=True, digits=(6, 2))
    description = fields.Html(string='Description')

    cost_per_hour_snapshot = fields.Monetary(
        string='Cost / Hour (Snapshot)', currency_field='currency_id', readonly=True,
        help='Rate captured at the time of logging — immune to future rate changes.',
    )
    total_cost_snapshot = fields.Monetary(
        string='Total Cost', currency_field='currency_id',
        compute='_compute_total_cost', store=True,
    )
    currency_id = fields.Many2one(
        'res.currency', related='project_id.currency_id', store=True,
    )

    status = fields.Selection([
        ('pending',  'Pending'),
        ('approved', 'Approved'),
        ('rejected', 'Rejected'),
    ], string='Status', default='pending', tracking=True, index=True)

    approver_id = fields.Many2one('res.users', string='Approved / Rejected By', readonly=True)

    # ── Computed fields ───────────────────────────────────────────────────────

    @api.depends('hours', 'cost_per_hour_snapshot')
    def _compute_total_cost(self):
        for rec in self:
            rec.total_cost_snapshot = rec.hours * (rec.cost_per_hour_snapshot or 0.0)

    # ── ORM overrides ─────────────────────────────────────────────────────────

    @api.model_create_multi
    def create(self, vals_list):
        """Capture the member's current rate as an immutable snapshot on creation."""
        for vals in vals_list:
            if not vals.get('cost_per_hour_snapshot') and vals.get('task_id') and vals.get('user_id'):
                task = self.env['bb.project.task'].browse(vals['task_id'])
                member = self.env['bb.project.member'].search([
                    ('project_id', '=', task.project_id.id),
                    ('user_id', '=', vals['user_id']),
                ], limit=1)
                vals['cost_per_hour_snapshot'] = member.current_rate if member else 0.0
        return super().create(vals_list)

    # ── Approval actions ──────────────────────────────────────────────────────

    def _require_admin(self):
        if not self.env.user.has_group(_ADMIN_GROUP):
            raise UserError("Only administrators can approve or reject work logs.")

    def _set_reviewed(self, status):
        self._require_admin()
        non_pending = self.filtered(lambda r: r.status != 'pending')
        if non_pending:
            ids = ', '.join(str(r.id) for r in non_pending)
            raise UserError(f"Work log(s) {ids} are not in Pending status.")
        self.write({'status': status, 'approver_id': self.env.user.id})

    def action_approve(self):
        self._set_reviewed('approved')

    def action_reject(self):
        self._set_reviewed('rejected')

    def action_reset_to_pending(self):
        self._require_admin()
        self.write({'status': 'pending', 'approver_id': False})
