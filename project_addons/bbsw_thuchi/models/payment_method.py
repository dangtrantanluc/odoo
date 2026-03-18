from odoo import models, fields


class PaymentMethod(models.Model):
    _name = 'bbsw.payment.method'
    _description = 'Phương thức thanh toán'
    _order = 'name'

    name = fields.Char(string='Tên', required=True)
    code = fields.Char(string='Mã')
    type = fields.Selection([
        ('cash', 'Tiền mặt'),
        ('bank', 'Chuyển khoản'),
        ('ewallet', 'Ví điện tử'),
        ('card', 'Thẻ tín dụng / Ghi nợ'),
        ('other', 'Khác'),
    ], string='Loại', default='cash')
    account_info = fields.Char(string='Thông tin tài khoản')
    bu_name = fields.Char(string='Đơn vị')
    owner = fields.Char(string='Chủ tài khoản')
    balance = fields.Float(string='Số dư hiện tại', default=0)
    opening_balance = fields.Float(string='Số dư đầu kỳ', default=0)
    status = fields.Selection([
        ('active', 'Hoạt động'),
        ('inactive', 'Ngừng hoạt động'),
    ], string='Trạng thái', default='active', required=True)
    active = fields.Boolean(default=True)
