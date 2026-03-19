# -*- coding: utf-8 -*-
from odoo import models, fields, api


class BbProjectMember(models.Model):
    _name = 'bb.project.member'
    _description = 'BB Project Member'
    _order = 'project_id, user_id'

    project_id = fields.Many2one(
        'bb.project', string='Project', required=True, ondelete='cascade', index=True,
    )
    user_id = fields.Many2one('res.users', string='User', required=True, index=True)
    role = fields.Char(string='Role', default='MEMBER')
    joined_at = fields.Datetime(string='Joined At', default=fields.Datetime.now)

    rate_ids = fields.One2many('bb.project.member.rate', 'member_id', string='Rate History')
    current_rate = fields.Monetary(
        string='Current Rate ($/hr)', compute='_compute_current_rate',
        currency_field='currency_id',
    )
    currency_id = fields.Many2one('res.currency', related='project_id.currency_id')

    @api.depends('rate_ids', 'rate_ids.cost_per_hour', 'rate_ids.effective_from', 'rate_ids.effective_to')
    def _compute_current_rate(self):
        today = fields.Date.today()
        for rec in self:
            active = rec.rate_ids.filtered(
                lambda r: r.effective_from <= today and (not r.effective_to or r.effective_to >= today)
            ).sorted('effective_from', reverse=True)
            rec.current_rate = active[:1].cost_per_hour if active else 0.0
