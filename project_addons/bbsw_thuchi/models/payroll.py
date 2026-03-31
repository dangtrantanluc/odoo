from datetime import date, timedelta

from odoo import models, fields, api
from odoo.exceptions import UserError

# ── Ngày lễ Việt Nam (các năm đã biết)
# Format: {(month, day): 'tên lễ'}  — áp dụng mọi năm
_ANNUAL_HOLIDAYS = {
    (1, 1): 'Tết Dương lịch',
    (4, 30): 'Giải phóng miền Nam',
    (5, 1): 'Quốc tế Lao động',
    (9, 2): 'Quốc khánh',
}

# Ngày lễ âm lịch — cần xác định theo từng năm dương lịch
# Key: (year, month, day)
_FIXED_HOLIDAYS = {
    # Tết Nguyên Đán 2025 (Ất Tỵ): 28/1 → 2/2/2025
    (2025, 1, 27), (2025, 1, 28), (2025, 1, 29), (2025, 1, 30),
    (2025, 1, 31), (2025, 2, 1), (2025, 2, 2),
    # Giỗ Tổ 2025: 18/4/2025 (10/3 âm)
    (2025, 4, 18),
    # Tết Nguyên Đán 2026 (Bính Ngọ): 16/2 → 21/2/2026
    (2026, 2, 16), (2026, 2, 17), (2026, 2, 18), (2026, 2, 19),
    (2026, 2, 20), (2026, 2, 21),
    # Giỗ Tổ 2026: 28/4/2026 (10/3 âm Bính Ngọ)
    (2026, 4, 28),
}


def _is_holiday(d: date) -> bool:
    """Kiểm tra ngày d có phải ngày lễ không."""
    if (d.month, d.day) in _ANNUAL_HOLIDAYS:
        return True
    if (d.year, d.month, d.day) in _FIXED_HOLIDAYS:
        return True
    return False


def _count_workdays(start_date: date, end_date: date) -> int:
    """Đếm ngày làm việc (Thứ 2–6, không phải lễ) trong khoảng [start, end] inclusive."""
    count = 0
    d = start_date
    while d <= end_date:
        if d.weekday() < 5 and not _is_holiday(d):  # 0=Mon … 4=Fri
            count += 1
        d += timedelta(days=1)
    return count


class BbswPayroll(models.Model):
    _name = 'bbsw.payroll'
    _description = 'Bảng lương'
    _order = 'period_year desc, period_month desc, employee_id'
    _rec_name = 'display_name'

    name = fields.Char(string='Mã phiếu', readonly=True, copy=False, default='/')
    employee_id = fields.Many2one('hr.employee', string='Nhân viên', required=True)
    department_id = fields.Many2one(
        'hr.department', string='Phòng ban',
        related='employee_id.department_id', store=True)
    contract_type = fields.Selection(
        related='employee_id.contract_type', store=True, string='Loại HĐ')
    period_month = fields.Integer(string='Tháng', required=True,
                                  default=lambda self: fields.Date.today().month)
    period_year = fields.Integer(string='Năm', required=True,
                                 default=lambda self: fields.Date.today().year)
    period_display = fields.Char(string='Kỳ lương', compute='_compute_period_display', store=True)
    display_name = fields.Char(compute='_compute_display_name', store=True)

    vnd_currency_id = fields.Many2one(
        'res.currency',
        default=lambda self: self.env['res.currency'].search([('name', '=', 'VND')], limit=1))

    # ── L1: Lương tháng (cơ bản)
    base_salary = fields.Monetary(
        string='L1 - Lương tháng', currency_field='vnd_currency_id',
        related='employee_id.actual_salary', store=True)

    # ── L2: Ngày công chuẩn (tự tính theo lịch: T2-T6, trừ lễ)
    standard_days = fields.Float(
        string='L2 - Ngày công chuẩn',
        compute='_compute_standard_days', store=True, readonly=False)

    # ── L3: Đơn giá/ngày (computed)
    daily_rate = fields.Monetary(
        string='L3 - Đơn giá/ngày', currency_field='vnd_currency_id',
        compute='_compute_salary', store=True)

    # ── L4: Ngày công thực tế (X - chính thức)
    worked_days = fields.Float(
        string='L4 - Ngày công thực tế (X)', compute='_compute_worked_days', store=True)

    # ── L5: Lương thời gian 100%
    time_salary = fields.Monetary(
        string='L5 - Lương thời gian', currency_field='vnd_currency_id',
        compute='_compute_salary', store=True)

    # ── L6: Ngày thử việc (TV)
    trial_days = fields.Float(
        string='L6 - Ngày thử việc (TV)', compute='_compute_worked_days', store=True)
    trial_salary = fields.Monetary(
        string='L7 - Lương thử việc', currency_field='vnd_currency_id',
        compute='_compute_salary', store=True)

    # ── L8: Ngày phép/lễ/chính đáng (P, NL, BH, CĐ, CT, X/P, X/NB)
    leave_days = fields.Float(
        string='L8 - Ngày phép/lễ/chính đáng', compute='_compute_worked_days', store=True)
    leave_salary = fields.Monetary(
        string='L9 - Lương phép/lễ/chính đáng', currency_field='vnd_currency_id',
        compute='_compute_salary', store=True)

    # ── L10: Ngày nghỉ bù hưởng lương (NB)
    compensatory_days = fields.Float(
        string='L10 - Ngày nghỉ bù hưởng lương (NB)', compute='_compute_worked_days', store=True)
    compensatory_salary = fields.Monetary(
        string='L11 - Lương nghỉ bù', currency_field='vnd_currency_id',
        compute='_compute_salary', store=True)

    # ── L12: Ngày tăng ca (nhập tay)
    overtime_days = fields.Float(string='L12 - Ngày tăng ca', default=0.0)

    # ── L13: Lương tăng ca (1.5×)
    overtime_salary = fields.Monetary(
        string='L13 - Lương tăng ca', currency_field='vnd_currency_id',
        compute='_compute_salary', store=True)

    # ── L14: Thưởng doanh số (nhập tay)
    bonus_sales = fields.Monetary(
        string='L14 - Thưởng doanh số', currency_field='vnd_currency_id', default=0.0)

    # ── L15: Phụ cấp khác (nhập tay)
    allowance = fields.Monetary(
        string='L15 - Phụ cấp khác', currency_field='vnd_currency_id', default=0.0)

    # ── L17: Trừ lương khác (nhập tay)
    salary_deduction = fields.Monetary(
        string='L17 - Trừ lương khác', currency_field='vnd_currency_id', default=0.0)

    # ── L18: Tổng lương tháng = L5 + L13
    total_monthly_salary = fields.Monetary(
        string='L18 - Tổng lương tháng', currency_field='vnd_currency_id',
        compute='_compute_salary', store=True)

    # ── L19: Tổng lương thưởng = L18 + L14 + L15
    total_gross = fields.Monetary(
        string='L19 - Tổng lương thưởng', currency_field='vnd_currency_id',
        compute='_compute_salary', store=True)

    # ── L20: Công ty giữ lại (nhập tay)
    company_hold = fields.Monetary(
        string='L20 - Công ty giữ lại', currency_field='vnd_currency_id', default=0.0)

    # ── L21: Tạm ứng (nhập tay)
    advance_payment = fields.Monetary(
        string='L21 - Tạm ứng', currency_field='vnd_currency_id', default=0.0)

    # ── L22: Lương đóng bảo hiểm = L1
    insurance_base = fields.Monetary(
        string='L22 - Lương đóng BH', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)

    # ── Bảo hiểm nhân viên đóng (chỉ chinh-thuc)
    bhxh_employee = fields.Monetary(
        string='L24 - BHXH NV (8%)', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)
    bhyt_employee = fields.Monetary(
        string='L25 - BHYT NV (1.5%)', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)
    bhtn_employee = fields.Monetary(
        string='L26 - BHTN NV (1%)', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)
    total_insurance_employee = fields.Monetary(
        string='L23 - Tổng khấu trừ BH NV', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)

    # ── Bảo hiểm công ty đóng
    bhxh_company = fields.Monetary(
        string='L34 - BHXH CT (17.5%)', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)
    bhyt_company = fields.Monetary(
        string='L35 - BHYT CT (3%)', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)
    bhtn_company = fields.Monetary(
        string='L36 - BHTN CT (1%)', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)
    total_insurance_company = fields.Monetary(
        string='L33 - BH công ty đóng', currency_field='vnd_currency_id',
        compute='_compute_insurance', store=True)

    # ── Thuế TNCN
    dependents = fields.Integer(string='Số người phụ thuộc', default=0)
    personal_deduction = fields.Monetary(
        string='L29 - Giảm trừ bản thân', currency_field='vnd_currency_id',
        default=15_500_000.0)
    dependent_deduction = fields.Monetary(
        string='L30 - Giảm trừ người phụ thuộc', currency_field='vnd_currency_id',
        compute='_compute_tax', store=True)
    taxable_income = fields.Monetary(
        string='L31 - Thu nhập tính thuế', currency_field='vnd_currency_id',
        compute='_compute_tax', store=True)
    personal_income_tax = fields.Monetary(
        string='L28 - Thuế TNCN', currency_field='vnd_currency_id',
        compute='_compute_tax', store=True)

    # ── Kết quả
    net_salary = fields.Monetary(
        string='L32 - Nhân viên thực nhận', currency_field='vnd_currency_id',
        compute='_compute_result', store=True)
    company_cost = fields.Monetary(
        string='L38 - CP lương doanh nghiệp', currency_field='vnd_currency_id',
        compute='_compute_result', store=True)

    note = fields.Text(string='Ghi chú')
    state = fields.Selection([
        ('draft', 'Nháp'),
        ('confirmed', 'Đã xác nhận'),
        ('paid', 'Đã thanh toán'),
    ], string='Trạng thái', default='draft')

    period_id = fields.Many2one(
        'bbsw.payroll.period', string='Kỳ lương',
        ondelete='restrict', index=True)
    is_locked = fields.Boolean(
        string='Đã chốt công', default=False,
        help='Khi chốt công, dữ liệu ngày công bị đóng băng và không tự tính lại từ chấm công.')
    lock_date = fields.Datetime(string='Thời gian chốt', readonly=True)

    _sql_constraints = [
        ('unique_employee_period', 'unique(employee_id, period_month, period_year)',
         'Nhân viên này đã có phiếu lương cho tháng/năm này!'),
    ]

    @api.depends('employee_id', 'period_month', 'period_year')
    def _compute_display_name(self):
        for rec in self:
            if rec.employee_id and rec.period_month and rec.period_year:
                rec.display_name = f"{rec.employee_id.name} - {rec.period_month:02d}/{rec.period_year}"
            else:
                rec.display_name = rec.name or '/'

    @api.depends('period_month', 'period_year')
    def _compute_standard_days(self):
        for rec in self:
            if not rec.period_month or not rec.period_year:
                rec.standard_days = 22.0
                continue
            start_str, _ = rec._period_date_range(rec.period_year, rec.period_month)
            y, m, d = map(int, start_str.split('-'))
            start_date = date(y, m, d)
            # end = ngày 27 của tháng kỳ lương
            end_date = date(rec.period_year, rec.period_month, 27)
            rec.standard_days = float(_count_workdays(start_date, end_date))

    def _period_date_range(self, year, month):
        """Kỳ lương tháng M: từ 26/(M-1) đến 27/M.
        Ví dụ: kỳ lương tháng 2 = 26/01 → 27/02."""
        if month == 1:
            start = f'{year - 1}-12-26'
        else:
            start = f'{year}-{month - 1:02d}-26'
        end = f'{year}-{month:02d}-28'  # exclusive upper bound (> ngày 27)
        return start, end

    @api.depends('period_month', 'period_year')
    def _compute_period_display(self):
        for rec in self:
            if rec.period_month and rec.period_year:
                start, _ = rec._period_date_range(rec.period_year, rec.period_month)
                sm = int(start.split('-')[1])
                rec.period_display = (
                    f"26/{sm:02d} - 27/{rec.period_month:02d}/{rec.period_year}"
                )
            else:
                rec.period_display = ''

    # Mã thuộc nhóm nào
    _TRIAL_CODES = {'TV'}
    _LEAVE_CODES = {'P', 'NL', 'BH', 'CĐ', 'CT', 'X/P', 'X/NB', 'P/KL'}
    _COMPENSATORY_CODES = {'NB'}
    # Mã chính thức: X, X/KL và mọi mã không thuộc nhóm trên

    @api.depends('employee_id', 'period_month', 'period_year', 'is_locked')
    def _compute_worked_days(self):
        for rec in self:
            if rec.is_locked:
                # Dữ liệu đã chốt - giữ nguyên giá trị đóng băng
                continue
            if not rec.employee_id or not rec.period_month or not rec.period_year:
                rec.worked_days = 0.0
                rec.trial_days = 0.0
                rec.leave_days = 0.0
                rec.compensatory_days = 0.0
                continue
            start, end = rec._period_date_range(rec.period_year, rec.period_month)
            domain = [
                ('employee_id', '=', rec.employee_id.id),
                ('check_in', '>=', start),
                ('check_in', '<', end),
                ('check_out', '!=', False),
            ]
            attendances = self.env['hr.attendance'].search(domain)

            official_h = trial_h = leave_h = comp_h = 0.0
            for att in attendances:
                code = (att.attendance_code or '').upper().strip()
                h = att.worked_hours or 0.0
                if code in rec._TRIAL_CODES:
                    trial_h += h
                elif code in rec._LEAVE_CODES:
                    leave_h += h
                elif code in rec._COMPENSATORY_CODES:
                    comp_h += h
                else:
                    official_h += h

            rec.worked_days = round(official_h / 9.0, 2)
            rec.trial_days = round(trial_h / 9.0, 2)
            rec.leave_days = round(leave_h / 9.0, 2)
            rec.compensatory_days = round(comp_h / 9.0, 2)

    @api.depends('base_salary', 'standard_days', 'worked_days', 'trial_days',
                 'leave_days', 'compensatory_days', 'overtime_days',
                 'bonus_sales', 'allowance')
    def _compute_salary(self):
        for rec in self:
            daily = rec.base_salary / rec.standard_days if rec.standard_days else 0.0
            rec.daily_rate = daily
            rec.time_salary = daily * rec.worked_days          # L5
            rec.trial_salary = daily * rec.trial_days          # L7
            rec.leave_salary = daily * rec.leave_days          # L9
            rec.compensatory_salary = daily * rec.compensatory_days  # L11
            rec.overtime_salary = daily * rec.overtime_days * 1.5    # L13
            rec.total_monthly_salary = (rec.time_salary + rec.trial_salary
                                        + rec.leave_salary + rec.compensatory_salary
                                        + rec.overtime_salary)       # L18
            rec.total_gross = rec.total_monthly_salary + rec.bonus_sales + rec.allowance  # L19

    @api.depends('base_salary', 'employee_id.contract_type')
    def _compute_insurance(self):
        for rec in self:
            is_insured = rec.employee_id.contract_type == 'chinh-thuc'
            base = rec.base_salary if is_insured else 0.0
            rec.insurance_base = base
            rec.bhxh_employee = round(base * 0.08, 0)
            rec.bhyt_employee = round(base * 0.015, 0)
            rec.bhtn_employee = round(base * 0.01, 0)
            rec.total_insurance_employee = (rec.bhxh_employee
                                            + rec.bhyt_employee
                                            + rec.bhtn_employee)
            rec.bhxh_company = round(base * 0.175, 0)
            rec.bhyt_company = round(base * 0.03, 0)
            rec.bhtn_company = round(base * 0.01, 0)
            rec.total_insurance_company = (rec.bhxh_company
                                           + rec.bhyt_company
                                           + rec.bhtn_company)

    @api.depends('total_gross', 'total_insurance_employee',
                 'personal_deduction', 'dependents')
    def _compute_tax(self):
        for rec in self:
            dep_deduction = rec.dependents * 6_200_000.0
            rec.dependent_deduction = dep_deduction
            taxable = (rec.total_gross
                       - rec.total_insurance_employee
                       - rec.personal_deduction
                       - dep_deduction)
            rec.taxable_income = max(taxable, 0.0)
            rec.personal_income_tax = self._calc_pit(rec.taxable_income)

    @staticmethod
    def _calc_pit(taxable):
        """Tính thuế TNCN lũy tiến 5 bậc."""
        if taxable <= 0:
            return 0.0
        brackets = [
            (10_000_000, 0.05),
            (20_000_000, 0.10),
            (30_000_000, 0.20),
            (40_000_000, 0.30),
            (float('inf'), 0.35),
        ]
        tax = 0.0
        remaining = taxable
        for limit, rate in brackets:
            if remaining <= 0:
                break
            tax += min(remaining, limit) * rate
            remaining -= limit
        return round(tax, 0)

    @api.depends('total_gross', 'total_insurance_employee', 'personal_income_tax',
                 'salary_deduction', 'advance_payment', 'company_hold',
                 'total_insurance_company')
    def _compute_result(self):
        for rec in self:
            rec.net_salary = (rec.total_gross
                              - rec.total_insurance_employee
                              - rec.personal_income_tax
                              - rec.salary_deduction
                              - rec.advance_payment
                              - rec.company_hold)
            rec.company_cost = rec.total_gross + rec.total_insurance_company

    def _snapshot_attendance(self):
        """Đọc dữ liệu chấm công thực tế và đóng băng vào phiếu lương."""
        for rec in self:
            if not rec.employee_id or not rec.period_month or not rec.period_year:
                continue
            start, end = rec._period_date_range(rec.period_year, rec.period_month)
            domain = [
                ('employee_id', '=', rec.employee_id.id),
                ('check_in', '>=', start),
                ('check_in', '<', end),
                ('check_out', '!=', False),
            ]
            attendances = self.env['hr.attendance'].search(domain)

            official_h = trial_h = leave_h = comp_h = 0.0
            for att in attendances:
                code = (att.attendance_code or '').upper().strip()
                h = att.worked_hours or 0.0
                if code in rec._TRIAL_CODES:
                    trial_h += h
                elif code in rec._LEAVE_CODES:
                    leave_h += h
                elif code in rec._COMPENSATORY_CODES:
                    comp_h += h
                else:
                    official_h += h

            rec.write({
                'worked_days': round(official_h / 9.0, 2),
                'trial_days': round(trial_h / 9.0, 2),
                'leave_days': round(leave_h / 9.0, 2),
                'compensatory_days': round(comp_h / 9.0, 2),
                'is_locked': True,
                'lock_date': fields.Datetime.now(),
            })

    def action_recompute_days(self):
        """Tính lại ngày công từ dữ liệu chấm công (chỉ khi chưa chốt)."""
        locked = self.filtered('is_locked')
        if locked:
            raise UserError(
                f'Không thể tính lại: {len(locked)} phiếu đã chốt công. '
                f'Vui lòng hoàn tác kỳ lương trước.'
            )
        self._compute_worked_days()
        self._compute_salary()
        self._compute_insurance()
        self._compute_tax()
        self._compute_result()

    def action_confirm(self):
        for rec in self:
            if rec.state != 'draft':
                raise UserError('Chỉ có thể xác nhận phiếu lương ở trạng thái Nháp.')
            if rec.name == '/':
                rec.name = self.env['ir.sequence'].next_by_code('bbsw.payroll') or '/'
            rec.state = 'confirmed'

    def action_pay(self):
        for rec in self:
            if rec.state != 'confirmed':
                raise UserError('Chỉ có thể thanh toán phiếu lương đã xác nhận.')
            rec.state = 'paid'

    def action_reset_draft(self):
        for rec in self:
            if rec.state == 'paid':
                raise UserError('Không thể đặt lại phiếu lương đã thanh toán.')
            rec.state = 'draft'

    def action_print_payslip(self):
        return self.env.ref('bbsw_thuchi.action_report_payroll').report_action(self)

    def action_preview_payslip(self):
        return {
            'type': 'ir.actions.act_window',
            'name': 'Xem trước phiếu lương',
            'res_model': 'bbsw.payroll',
            'res_id': self.id,
            'view_mode': 'form',
            'view_id': self.env.ref('bbsw_thuchi.view_payroll_preview_form').id,
            'target': 'new',
        }
