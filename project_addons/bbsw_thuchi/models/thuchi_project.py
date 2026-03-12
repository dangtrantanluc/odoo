from odoo import models, fields


class ThuChiProject(models.Model):
    _name = 'bbsw.thuchi.project'
    _description = 'Dự án'
    _order = 'name'

    name = fields.Char(string='Tên dự án', required=True)
    code = fields.Char(string='Mã dự án', required=True)
    description = fields.Text(string='Mô tả')
    start_date = fields.Date(string='Ngày bắt đầu', required=True)
    end_date = fields.Date(string='Ngày kết thúc')
    bu_owner = fields.Char(string='Đơn vị phụ trách')
    pm = fields.Char(string='Quản lý dự án')
    budget = fields.Float(string='Ngân sách', default=0)
    spent = fields.Float(string='Đã chi', compute='_compute_spent', store=True)
    status = fields.Selection([
        ('active', 'Đang hoạt động'),
        ('closed', 'Đã đóng'),
        ('cancelled', 'Đã hủy'),
    ], string='Trạng thái', default='active', required=True)
    active = fields.Boolean(default=True)

    transaction_ids = fields.One2many('bbsw.thuchi.record', 'project_id', string='Giao dịch')

    def _compute_spent(self):
        for rec in self:
            rec.spent = sum(
                t.amount for t in rec.transaction_ids
                if t.type in ('chi', 'hoan_ung') and t.state == 'approved'
            )
