from odoo import models, fields


class BusinessUnit(models.Model):
    _name = 'bbsw.business.unit'
    _description = 'Đơn vị kinh doanh (Business Unit)'
    _order = 'name'

    name = fields.Char(string='Tên đơn vị', required=True)
    code = fields.Char(string='Mã đơn vị')
    leader_name = fields.Char(string='Trưởng đơn vị')
    staff_count = fields.Integer(string='Số nhân viên', default=0)
    start_date = fields.Date(string='Ngày thành lập')
    status = fields.Selection([
        ('active', 'Hoạt động'),
        ('inactive', 'Ngừng hoạt động'),
    ], string='Trạng thái', default='active', required=True)
    active = fields.Boolean(default=True)
