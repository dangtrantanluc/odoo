from odoo import models, fields, api
from odoo.exceptions import ValidationError


class ThuChiRecord(models.Model):
    _name = 'bbsw.thuchi.record'
    _description = 'Bản ghi Thu Chi'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'date desc, id desc'

    # ── Mã giao dịch (tự động) ──
    transaction_code = fields.Char(
        string='Mã giao dịch',
        readonly=True,
        copy=False,
        default='New',
    )

    # ── Thông tin cơ bản ──
    name = fields.Char(string='Mô tả', required=True, tracking=True)
    date = fields.Date(
        string='Ngày giao dịch',
        required=True,
        default=fields.Date.context_today,
        tracking=True,
    )
    type = fields.Selection([
        ('thu', 'Thu (Income)'),
        ('chi', 'Chi (Expense)'),
        ('vay', 'Vay (Loan)'),
        ('hoan_ung', 'Hoàn ứng'),
    ], string='Loại', required=True, default='chi', tracking=True)

    category_id = fields.Many2one(
        'bbsw.thuchi.category',
        string='Danh mục',
        required=True,
        tracking=True,
    )
    amount = fields.Float(string='Số tiền', required=True, tracking=True)

    # ── Đơn vị & Dự án ──
    business_unit_id = fields.Many2one(
        'bbsw.business.unit',
        string='Đơn vị kinh doanh',
        tracking=True,
    )
    project_id = fields.Many2one(
        'bbsw.thuchi.project',
        string='Dự án',
        tracking=True,
    )

    # ── Đối tượng liên quan ──
    object_type = fields.Selection([
        ('partner', 'Đối tác / Khách hàng'),
        ('employee', 'Nhân viên'),
        ('student', 'Học sinh / Sinh viên'),
        ('other', 'Khác'),
    ], string='Loại đối tượng', default='partner', tracking=True)
    partner_id = fields.Many2one(
        'res.partner',
        string='Đối tác',
        tracking=True,
    )
    employee_id = fields.Many2one(
        'hr.employee',
        string='Nhân viên',
        tracking=True,
    )
    student_name = fields.Char(string='Tên học sinh/sinh viên')
    other_name = fields.Char(string='Tên đối tượng khác')

    # ── Thanh toán ──
    payment_method_id = fields.Many2one(
        'bbsw.payment.method',
        string='Phương thức thanh toán',
        tracking=True,
    )
    payment_status = fields.Selection([
        ('unpaid', 'Chưa thanh toán'),
        ('paid', 'Đã thanh toán'),
    ], string='Trạng thái thanh toán', default='unpaid', tracking=True)
    is_advance = fields.Boolean(string='Tạm ứng', default=False, tracking=True)

    # ── Phân bổ chi phí ──
    cost_allocation = fields.Selection([
        ('direct', 'Chi phí trực tiếp'),
        ('indirect', 'Chi phí gián tiếp'),
    ], string='Phân bổ chi phí', tracking=True)

    # ── Trạng thái duyệt ──
    state = fields.Selection([
        ('draft', 'Nháp'),
        ('pending', 'Chờ duyệt'),
        ('approved', 'Đã duyệt'),
        ('rejected', 'Từ chối'),
        ('cancelled', 'Đã hủy'),
    ], string='Trạng thái', default='draft', tracking=True)
    rejection_reason = fields.Text(string='Lý do từ chối')

    # ── Người tạo ──
    user_id = fields.Many2one(
        'res.users',
        string='Người tạo',
        default=lambda self: self.env.user,
        tracking=True,
    )

    note = fields.Html(string='Ghi chú')

    attachment_ids = fields.Many2many(
        comodel_name='ir.attachment',
        relation='bbsw_thuchi_record_attach_rel',
        column1='record_id',
        column2='attachment_id',
        string='Chứng từ đính kèm',
    )

    # ── Sequence ──
    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('transaction_code', 'New') == 'New':
                vals['transaction_code'] = self.env['ir.sequence'].next_by_code('bbsw.thuchi.record') or 'New'
        return super().create(vals_list)

    # ── Domain filter: category type matches record type ──
    @api.onchange('type')
    def _onchange_type(self):
        self.category_id = False
        return {
            'domain': {
                'category_id': [('type', '=', self.type)]
            }
        }

    @api.onchange('object_type')
    def _onchange_object_type(self):
        self.partner_id = False
        self.employee_id = False
        self.student_name = False
        self.other_name = False

    @api.constrains('amount')
    def _check_amount(self):
        for rec in self:
            if rec.amount <= 0:
                raise ValidationError('Số tiền phải lớn hơn 0!')

    # ── Actions ──
    def action_submit(self):
        self.write({'state': 'pending'})

    def action_approve(self):
        self.write({'state': 'approved', 'rejection_reason': False})

    def action_reject(self):
        self.write({'state': 'rejected'})

    def action_cancel(self):
        self.write({'state': 'cancelled'})

    def action_draft(self):
        self.write({'state': 'draft', 'rejection_reason': False})

    # ── Kept for backward compatibility ──
    def action_confirm(self):
        self.action_approve()
