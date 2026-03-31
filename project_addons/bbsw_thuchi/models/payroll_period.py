from datetime import date, timedelta
from odoo import models, fields, api
from odoo.exceptions import UserError


class BbswPayrollPeriod(models.Model):
    _name = 'bbsw.payroll.period'
    _description = 'Kỳ lương'
    _order = 'period_year desc, period_month desc'
    _rec_name = 'name'

    name = fields.Char(string='Tên kỳ lương', compute='_compute_name', store=True)
    period_month = fields.Integer(string='Tháng', required=True,
                                  default=lambda self: fields.Date.today().month)
    period_year = fields.Integer(string='Năm', required=True,
                                 default=lambda self: fields.Date.today().year)
    date_from = fields.Date(string='Từ ngày', compute='_compute_dates', store=True)
    date_to = fields.Date(string='Đến ngày', compute='_compute_dates', store=True)

    state = fields.Selection([
        ('draft', 'Nháp'),
        ('locked', 'Đã chốt công'),
        ('confirmed', 'Đã xác nhận'),
        ('paid', 'Đã thanh toán'),
    ], string='Trạng thái', default='draft')

    payroll_ids = fields.One2many('bbsw.payroll', 'period_id', string='Phiếu lương')
    payroll_count = fields.Integer(string='Số phiếu', compute='_compute_stats')
    total_net = fields.Monetary(string='Tổng thực nhận', compute='_compute_stats',
                                currency_field='vnd_currency_id')
    total_company_cost = fields.Monetary(string='Tổng CP doanh nghiệp',
                                         compute='_compute_stats',
                                         currency_field='vnd_currency_id')
    vnd_currency_id = fields.Many2one(
        'res.currency',
        default=lambda self: self.env['res.currency'].search([('name', '=', 'VND')], limit=1))

    note = fields.Text(string='Ghi chú')

    _sql_constraints = [
        ('unique_period', 'unique(period_month, period_year)',
         'Kỳ lương cho tháng/năm này đã tồn tại!'),
    ]

    @api.depends('period_month', 'period_year')
    def _compute_name(self):
        for rec in self:
            if rec.period_month and rec.period_year:
                rec.name = f'Lương tháng {rec.period_month:02d}/{rec.period_year}'
            else:
                rec.name = '/'

    @api.depends('period_month', 'period_year')
    def _compute_dates(self):
        for rec in self:
            if not rec.period_month or not rec.period_year:
                rec.date_from = False
                rec.date_to = False
                continue
            m, y = rec.period_month, rec.period_year
            # Kỳ lương: 26 tháng trước → 27 tháng này
            if m == 1:
                rec.date_from = date(y - 1, 12, 26)
            else:
                rec.date_from = date(y, m - 1, 26)
            rec.date_to = date(y, m, 27)

    @api.depends('payroll_ids', 'payroll_ids.net_salary', 'payroll_ids.company_cost')
    def _compute_stats(self):
        for rec in self:
            rec.payroll_count = len(rec.payroll_ids)
            rec.total_net = sum(rec.payroll_ids.mapped('net_salary'))
            rec.total_company_cost = sum(rec.payroll_ids.mapped('company_cost'))

    def action_lock_attendance(self):
        """Chốt công: tạo/cập nhật phiếu lương và đóng băng dữ liệu chấm công."""
        self.ensure_one()
        if self.state != 'draft':
            raise UserError('Chỉ có thể chốt công khi kỳ lương đang ở trạng thái Nháp.')

        Payroll = self.env['bbsw.payroll']
        employees = self.env['hr.employee'].search([
            ('work_status', '=', 'WORKING'),
            ('active', '=', True),
        ])
        if not employees:
            raise UserError('Không tìm thấy nhân viên nào đang làm việc.')

        created = updated = 0
        for emp in employees:
            existing = Payroll.search([
                ('employee_id', '=', emp.id),
                ('period_id', '=', self.id),
            ], limit=1)
            if existing:
                if not existing.is_locked:
                    existing._snapshot_attendance()
                    updated += 1
            else:
                payroll = Payroll.create({
                    'employee_id': emp.id,
                    'period_month': self.period_month,
                    'period_year': self.period_year,
                    'period_id': self.id,
                })
                payroll._snapshot_attendance()
                created += 1

        self.state = 'locked'
        return {
            'type': 'ir.actions.client',
            'tag': 'display_notification',
            'params': {
                'title': 'Đã chốt công!',
                'message': f'Tạo mới: {created} phiếu. Cập nhật: {updated} phiếu. Dữ liệu đã được đóng băng.',
                'type': 'success',
                'sticky': False,
            }
        }

    def action_confirm(self):
        self.ensure_one()
        if self.state != 'locked':
            raise UserError('Kỳ lương phải được chốt công trước khi xác nhận.')
        unconfirmed = self.payroll_ids.filtered(lambda p: p.state == 'draft')
        unconfirmed.action_confirm()
        self.state = 'confirmed'

    def action_pay(self):
        self.ensure_one()
        if self.state != 'confirmed':
            raise UserError('Kỳ lương phải được xác nhận trước khi thanh toán.')
        self.payroll_ids.filtered(lambda p: p.state == 'confirmed').action_pay()
        self.state = 'paid'

    def action_reset_draft(self):
        self.ensure_one()
        if self.state == 'paid':
            raise UserError('Không thể hoàn tác kỳ lương đã thanh toán.')
        self.payroll_ids.filtered(lambda p: p.state != 'paid').write({'is_locked': False})
        self.state = 'draft'

    def action_view_payrolls(self):
        return {
            'type': 'ir.actions.act_window',
            'name': self.name,
            'res_model': 'bbsw.payroll',
            'view_mode': 'tree,form',
            'domain': [('period_id', '=', self.id)],
            'context': {
                'default_period_id': self.id,
                'default_period_month': self.period_month,
                'default_period_year': self.period_year,
            },
        }
