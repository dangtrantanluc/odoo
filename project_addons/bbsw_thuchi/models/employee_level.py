from odoo import models, fields


class BbswEmployeeLevel(models.Model):
    _name = 'bbsw.employee.level'
    _description = 'Cấp bậc nhân viên'
    _order = 'sequence, id'

    name = fields.Char(string='Tên cấp bậc', required=True)
    code = fields.Char(string='Mã')
    sequence = fields.Integer(default=10)

    _sql_constraints = [
        ('code_uniq', 'unique(code)', 'Mã cấp bậc phải là duy nhất!'),
    ]
