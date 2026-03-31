from odoo import models, fields, api
from odoo.exceptions import UserError


class BbswPayrollGenerateWizard(models.TransientModel):
    _name = 'bbsw.payroll.generate.wizard'
    _description = 'Tạo bảng lương hàng loạt'

    period_month = fields.Integer(
        string='Tháng', required=True,
        default=lambda self: fields.Date.today().month)
    period_year = fields.Integer(
        string='Năm', required=True,
        default=lambda self: fields.Date.today().year)
    overwrite_existing = fields.Boolean(
        string='Tính lại phiếu đã tồn tại', default=False,
        help='Nếu tích: tính lại ngày công cho phiếu đã có. Nếu không: bỏ qua.')

    # Kết quả sau khi tạo
    result_created = fields.Integer(string='Phiếu mới tạo', readonly=True)
    result_skipped = fields.Integer(string='Phiếu đã có (bỏ qua)', readonly=True)
    result_updated = fields.Integer(string='Phiếu đã tính lại', readonly=True)
    result_ids = fields.Many2many('bbsw.payroll', string='Phiếu lương')
    state = fields.Selection([
        ('draft', 'Chưa tạo'),
        ('done', 'Đã tạo'),
    ], default='draft')

    @api.constrains('period_month')
    def _check_month(self):
        for rec in self:
            if not 1 <= rec.period_month <= 12:
                raise UserError('Tháng phải từ 1 đến 12.')

    def action_generate(self):
        self.ensure_one()
        month = self.period_month
        year = self.period_year
        Payroll = self.env['bbsw.payroll']

        # Lấy tất cả nhân viên đang WORKING
        employees = self.env['hr.employee'].search([
            ('work_status', '=', 'WORKING'),
            ('active', '=', True),
        ])
        if not employees:
            raise UserError('Không tìm thấy nhân viên nào đang làm việc.')

        created = 0
        skipped = 0
        updated = 0
        all_payrolls = self.env['bbsw.payroll']

        for emp in employees:
            existing = Payroll.search([
                ('employee_id', '=', emp.id),
                ('period_month', '=', month),
                ('period_year', '=', year),
            ], limit=1)

            if existing:
                if self.overwrite_existing and existing.state == 'draft':
                    existing.action_recompute_days()
                    updated += 1
                    all_payrolls |= existing
                else:
                    skipped += 1
                    all_payrolls |= existing
            else:
                new_payroll = Payroll.create({
                    'employee_id': emp.id,
                    'period_month': month,
                    'period_year': year,
                })
                created += 1
                all_payrolls |= new_payroll

        self.write({
            'result_created': created,
            'result_skipped': skipped,
            'result_updated': updated,
            'result_ids': [(6, 0, all_payrolls.ids)],
            'state': 'done',
        })

        # Reload wizard để hiện kết quả
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'bbsw.payroll.generate.wizard',
            'res_id': self.id,
            'view_mode': 'form',
            'target': 'new',
        }

    def action_open_payrolls(self):
        """Mở danh sách phiếu lương vừa tạo."""
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': f'Bảng lương {self.period_month:02d}/{self.period_year}',
            'res_model': 'bbsw.payroll',
            'view_mode': 'tree,form',
            'domain': [('id', 'in', self.result_ids.ids)],
            'context': {'default_period_month': self.period_month,
                        'default_period_year': self.period_year},
        }
