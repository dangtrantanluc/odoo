from odoo import models, fields


class ResPartnerExtend(models.Model):
    _inherit = 'res.partner'

    is_bbsw_partner = fields.Boolean(
        string='Đối tác nội bộ Thu Chi',
        default=False,
        help='Đánh dấu để hiển thị trong danh sách đối tác khi tạo phiếu Thu Chi',
    )

    thuchi_record_ids = fields.One2many(
        'bbsw.thuchi.record',
        'partner_id',
        string='Giao dịch Thu Chi',
    )
