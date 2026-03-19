from odoo import models, fields, api


class ThuChiCategory(models.Model):
    _name = 'bbsw.thuchi.category'
    _description = 'Danh mục Thu Chi'
    _order = 'name'

    code = fields.Char(string='Mã danh mục', required=True)
    name = fields.Char(string='Tên danh mục', required=True)
    type = fields.Selection([
        ('thu', 'Thu (Income)'),
        ('chi', 'Chi (Expense)'),
        ('vay', 'Vay (Loan)'),
        ('hoan_ung', 'Hoàn ứng'),
    ], string='Loại', required=True, default='chi')
    description = fields.Text(string='Mô tả')
    active = fields.Boolean(string='Active', default=True)
    record_ids = fields.One2many('bbsw.thuchi.record', 'category_id', string='Các bản ghi')
    record_count = fields.Integer(string='Số bản ghi', compute='_compute_record_count')

    @api.depends('record_ids')
    def _compute_record_count(self):
        for rec in self:
            rec.record_count = len(rec.record_ids)
