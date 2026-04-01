from odoo import api, fields, models
from odoo.exceptions import ValidationError


LEGACY_URL_TARGETS = {
    '/project/thuchi': {
        'target_type': 'custom_route',
        'route_path': '/project/thuchi',
    },
    '/attendance/checkin': {
        'target_type': 'custom_route',
        'route_path': '/attendance/checkin',
    },
    '/odoo/settings': {
        'target_type': 'custom_route',
        'route_path': '/odoo/settings',
    },
    '/odoo/discuss': {
        'target_type': 'custom_route',
        'route_path': '/odoo/discuss',
    },
    '/odoo/calendar': {
        'target_type': 'custom_route',
        'route_path': '/odoo/calendar',
    },
    '/odoo/crm': {
        'target_type': 'custom_route',
        'route_path': '/odoo/crm',
    },
    '/odoo/sales': {
        'target_type': 'custom_route',
        'route_path': '/odoo/sales',
    },
    '/web#action=bbsw_thuchi.action_bbsw_employee': {
        'target_type': 'backend_menu',
        'menu_xmlid': 'bbsw_thuchi.menu_nhansu_employee',
    },
    '/odoo/payroll': {
        'target_type': 'backend_menu',
        'menu_xmlid': 'bbsw_thuchi.menu_tinhluong_list',
    },
    '/odoo/project': {
        'target_type': 'backend_menu',
        'menu_xmlid': 'bb_project_management.menu_bb_project_dashboard',
    },
}


class HomeApp(models.Model):
    _name = 'bbsw.home.app'
    _description = 'Ứng dụng trang chủ'
    _order = 'sequence, id'

    name = fields.Char(string='Tên ứng dụng', required=True, translate=True)
    description = fields.Char(string='Mô tả ngắn', translate=True)
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

    @api.depends('target_type', 'route_path', 'menu_xmlid', 'url')
    def _compute_target_info(self):
        for rec in self:
            target = rec._get_effective_target()
            launch_url = False
            target_error = False
            is_target_valid = False

            if target['target_type'] == 'custom_route':
                route_path = (target['route_path'] or '').strip()
                if not route_path:
                    target_error = 'Thiếu route tùy chỉnh.'
                elif not route_path.startswith('/'):
                    target_error = 'Route tùy chỉnh phải bắt đầu bằng "/".'
                else:
                    launch_url = route_path
                    is_target_valid = True
            elif target['target_type'] == 'backend_menu':
                menu_xmlid = (target['menu_xmlid'] or '').strip()
                launch_url, target_error = rec._menu_xmlid_to_launch_url(menu_xmlid)
                is_target_valid = bool(launch_url)
            else:
                target_error = 'Chưa cấu hình kiểu điều hướng.'

            rec.launch_url = launch_url
            rec.is_target_valid = is_target_valid
            rec.target_error = target_error

    @api.constrains('target_type', 'route_path', 'menu_xmlid', 'url')
    def _check_target_configuration(self):
        for rec in self:
            target = rec._get_effective_target()
            if target['target_type'] == 'custom_route' and not (target['route_path'] or '').strip():
                raise ValidationError('Launcher kiểu route tùy chỉnh phải có route_path.')
            if target['target_type'] == 'backend_menu' and not (target['menu_xmlid'] or '').strip():
                raise ValidationError('Launcher kiểu menu backend phải có menu_xmlid.')

    @api.model_create_multi
    def create(self, vals_list):
        vals_list = [self._apply_legacy_target_defaults(dict(vals)) for vals in vals_list]
        return super().create(vals_list)

    def write(self, vals):
        vals = self._apply_legacy_target_defaults(dict(vals))
        return super().write(vals)

    @api.model
    def _get_legacy_target_values(self, url):
        return dict(LEGACY_URL_TARGETS.get((url or '').strip(), {}))

    @api.model
    def _apply_legacy_target_defaults(self, vals):
        url = vals.get('url')
        if url and not vals.get('route_path') and not vals.get('menu_xmlid'):
            legacy_target = self._get_legacy_target_values(url)
            for key, value in legacy_target.items():
                vals.setdefault(key, value)
        return vals

    def _get_effective_target(self):
        self.ensure_one()
        target = {
            'target_type': self.target_type,
            'route_path': self.route_path,
            'menu_xmlid': self.menu_xmlid,
        }
        if (not target['route_path'] and not target['menu_xmlid']) and self.url:
            target.update(self._get_legacy_target_values(self.url))
        return target

    @api.model
    def _menu_xmlid_to_launch_url(self, menu_xmlid):
        menu_xmlid = (menu_xmlid or '').strip()
        if not menu_xmlid:
            return False, 'Thiếu menu XMLID.'

        menu = self.env.ref(menu_xmlid, raise_if_not_found=False)
        if not menu:
            return False, f'Không tìm thấy menu XMLID: {menu_xmlid}'
        if menu._name != 'ir.ui.menu':
            return False, f'XMLID {menu_xmlid} không phải menu.'
        if not menu.action:
            return False, f'Menu {menu.display_name} chưa có action.'
        return f'/odoo/action-{menu.action.id}?menu_id={menu.id}', False
