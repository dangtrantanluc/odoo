from odoo import models, fields


class HomeApp(models.Model):
    _name = 'bbsw.home.app'
    _description = 'Ứng dụng trang chủ'
    _order = 'sequence, id'

    name = fields.Char(string='Tên ứng dụng', required=True, translate=True)
    url = fields.Char(string='Đường dẫn URL', required=True)
    icon = fields.Selection([
        ('money', 'Tài chính / Thu Chi'),
        ('users', 'Nhân sự'),
        ('clock', 'Chấm công'),
        ('payroll', 'Tính lương'),
        ('chat', 'Thảo luận'),
        ('calendar', 'Lịch'),
        ('crm', 'CRM'),
        ('sales', 'Bán hàng'),
        ('project', 'Dự án'),
        ('inventory', 'Kho hàng'),
        ('report', 'Báo cáo'),
        ('settings', 'Cài đặt'),
    ], string='Icon', required=True, default='settings')
    gradient = fields.Selection([
        ('grad-emerald', 'Xanh lá (Emerald)'),
        ('grad-indigo', 'Chàm (Indigo)'),
        ('grad-orange', 'Cam (Orange)'),
        ('grad-pink', 'Hồng (Pink)'),
        ('grad-purple', 'Tím (Purple)'),
        ('grad-blue', 'Xanh dương (Blue)'),
        ('grad-cyan', 'Xanh lơ (Cyan)'),
        ('grad-rose', 'Đỏ hồng (Rose)'),
        ('grad-teal', 'Ngọc lam (Teal)'),
        ('grad-slate', 'Xám (Slate)'),
        ('grad-amber', 'Vàng (Amber)'),
        ('grad-green', 'Xanh lá đậm (Green)'),
    ], string='Màu sắc', required=True, default='grad-blue')
    sequence = fields.Integer(string='Thứ tự', default=10)
    active = fields.Boolean(string='Hiển thị', default=True)
    groups_id = fields.Many2many(
        'res.groups',
        string='Nhóm người dùng',
        help='Để trống = hiển thị cho tất cả người dùng',
    )
