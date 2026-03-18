from odoo import models, fields


class ResPartnerExtend(models.Model):
    _inherit = 'res.partner'

    thuchi_record_ids = fields.One2many(
        'bbsw.thuchi.record',
        'partner_id',
        string='Giao dịch Thu Chi',
    )
