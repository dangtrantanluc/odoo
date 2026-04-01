# -*- coding: utf-8 -*-
from odoo import models, fields, api


class BbProjectMemberRate(models.Model):
    _name = 'bb.project.member.rate'
    _description = 'BB Project Member Rate'
    _order = 'effective_from desc'

    member_id = fields.Many2one(
        'bb.project.member', string='Member', required=True, ondelete='cascade', index=True,
    )
    project_id = fields.Many2one(
        'bb.project', string='Project', related='member_id.project_id', store=True,
    )
    user_id = fields.Many2one(
        'res.users', string='User', related='member_id.user_id', store=True,
    )
    cost_per_hour = fields.Monetary(string='Cost / Hour', required=True, currency_field='currency_id')
    currency_id = fields.Many2one(
        'res.currency', string='Currency',
        default=lambda self: self.env.company.currency_id,
    )
    effective_from = fields.Date(string='Effective From', required=True)
    effective_to = fields.Date(string='Effective To')

    @api.constrains('effective_from', 'effective_to')
    def _check_dates(self):
        for rec in self:
            if rec.effective_to and rec.effective_from and rec.effective_to < rec.effective_from:
                raise models.ValidationError(
                    "Effective To date must be after Effective From date."
                )
