from odoo import models, fields


class HrAttendanceExtend(models.Model):
    _inherit = 'hr.attendance'

    attendance_code = fields.Char(string='Mã chấm công', readonly=True)
    # Địa chỉ reverse-geocode (tên đường/khu vực) từ GPS mobile
    checkin_address = fields.Char(string='Địa chỉ vào ca')
    checkout_address = fields.Char(string='Địa chỉ ra ca')
    checkin_photo = fields.Binary(string='Ảnh vào ca', attachment=True)
    checkout_photo = fields.Binary(string='Ảnh ra ca', attachment=True)
    checkin_photo_filename = fields.Char(string='Tên file ảnh vào ca')
    checkout_photo_filename = fields.Char(string='Tên file ảnh ra ca')


class HrEmployeeExtend(models.Model):
    _inherit = 'hr.employee'

    employee_code = fields.Char(string='Mã nhân viên', copy=False)
    work_status = fields.Selection([
        ('WORKING', 'Đang làm việc'),
        ('PROBATION', 'Thử việc'),
        ('RESIGNED', 'Đã nghỉ'),
    ], string='Trạng thái', default='WORKING', tracking=True)
    level_id = fields.Many2one(
        'bbsw.employee.level',
        string='Cấp bậc',
    )
    vnd_currency_id = fields.Many2one(
        'res.currency', string='Tiền tệ',
        default=lambda self: self.env['res.currency'].search([('name', '=', 'VND')], limit=1),
    )
    actual_salary = fields.Monetary(string='Lương thực nhận', currency_field='vnd_currency_id')
    contract_type = fields.Selection([
        ('chinh-thuc', 'Chính thức'),
        ('thuc-tap', 'Thực tập'),
        ('thu-viec', 'Thử việc'),
    ], string='Loại hợp đồng')
    contract_start_date = fields.Date(string='Ngày bắt đầu HĐ')
    contract_end_date = fields.Date(string='Ngày kết thúc HĐ')
    business_unit_id = fields.Many2one(
        'bbsw.business.unit',
        string='Đơn vị kinh doanh',
    )
