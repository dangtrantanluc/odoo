# -*- coding: utf-8 -*-
import json
import base64
import datetime
from markupsafe import Markup

import pytz

from odoo import http, fields
from odoo.http import request
from odoo.addons.web.controllers.home import Home

_VN_TZ = pytz.timezone('Asia/Ho_Chi_Minh')


class ProjectHomepage(http.Controller):

    @http.route(['/project/home'], type='http', auth='user')
    def project_homepage(self, msg=None, **kw):
        user = request.env.user
        user_group_ids = user.groups_id.ids
        apps = request.env['bbsw.home.app'].search([
            ('active', '=', True),
            '|',
            ('groups_id', '=', False),
            ('groups_id', 'in', user_group_ids),
        ])
        apps = apps.filtered(lambda app: app.is_target_valid and app.launch_url)
        return request.render('bbsw_thuchi.project_homepage_template', {
            'apps': apps,
            'current_user': user,
            'show_no_access': msg == 'no_access',
        })


class CustomHome(Home):
    def _redirect_backend_menu(self, menu_xmlid, fallback='/web'):
        launch_url, _error = request.env['bbsw.home.app']._menu_xmlid_to_launch_url(menu_xmlid)
        if launch_url:
            return request.redirect(launch_url)
        return request.redirect(fallback)

    @http.route('/', auth='user')
    def index(self, **kw):
        return request.redirect('/project/home')

    @http.route('/odoo', auth='user')
    def odoo_home(self, **kw):
        return request.redirect('/project/home')

    @http.route('/odoo/settings', auth='user')
    def odoo_settings(self, **kw):
        return self._redirect_backend_menu('base_setup.menu_config')

    def _login_redirect(self, uid, redirect=None):
        if not redirect:
            redirect = '/project/home'
        return super()._login_redirect(uid, redirect=redirect)


class ThuChiPage(http.Controller):

    def _require_admin(self):
        """Trả về True nếu user có quyền admin, False nếu không."""
        return request.env.user.has_group('base.group_system')

    def _redirect_no_access(self):
        return request.redirect('/project/home?msg=no_access')

    @http.route('/project/thuchi', type='http', auth='user')
    def thuchi_page(self, month=None, **kw):
        if not self._require_admin():
            return self._redirect_no_access()
        user = request.env.user
        today = datetime.date.today()
        if not month:
            month = today.strftime('%Y-%m')

        def _cats(type_val):
            recs = request.env['bbsw.thuchi.category'].search([
                ('type', '=', type_val), ('active', '=', True)
            ])
            return [{'id': c.id, 'name': c.name} for c in recs]

        bus = request.env['bbsw.business.unit'].search([('status', '=', 'active')])
        pms = request.env['bbsw.payment.method'].search([('status', '=', 'active')])
        projs = request.env['bbsw.thuchi.project'].search([('status', '=', 'active')])
        employees = request.env['hr.employee'].search([('active', '=', True)])
        partners = request.env['res.partner'].search([('active', '=', True)], limit=200)

        return request.render('bbsw_thuchi.thuchi_page_template', {
            'current_user': user,
            'is_admin': user.has_group('base.group_system'),
            'current_month_json': Markup(json.dumps(month)),
            'categories_thu_json':     Markup(json.dumps(_cats('thu'))),
            'categories_chi_json':     Markup(json.dumps(_cats('chi'))),
            'categories_vay_json':     Markup(json.dumps(_cats('vay'))),
            'categories_hoan_ung_json':Markup(json.dumps(_cats('hoan_ung'))),
            'business_units_json': Markup(json.dumps([
                {'id': b.id, 'name': b.name} for b in bus
            ])),
            'payment_methods_json': Markup(json.dumps([
                {'id': p.id, 'name': p.name, 'type': p.type or ''} for p in pms
            ])),
            'projects_json': Markup(json.dumps([
                {'id': p.id, 'name': p.name, 'code': p.code or ''} for p in projs
            ])),
            'employees_json': Markup(json.dumps([
                {'id': e.id, 'name': e.name} for e in employees
            ])),
            'partners_json': Markup(json.dumps([
                {'id': p.id, 'name': p.name} for p in partners
            ])),
        })

    @http.route('/project/thuchi/api/records', type='json', auth='user')
    def api_records(self, month=None, type_filter='all', search='', **kw):
        if not self._require_admin():
            return {'error': 'Không có quyền truy cập', 'records': [], 'thu_total': 0, 'chi_total': 0, 'balance': 0}
        today = datetime.date.today()
        if not month:
            month = today.strftime('%Y-%m')
        try:
            year, m = map(int, month.split('-'))
            date_from = datetime.date(year, m, 1)
            date_to = datetime.date(year + 1, 1, 1) if m == 12 else datetime.date(year, m + 1, 1)
        except Exception:
            date_from = datetime.date(today.year, today.month, 1)
            date_to = datetime.date(today.year + 1, 1, 1) if today.month == 12 else datetime.date(today.year, today.month + 1, 1)

        domain = [
            ('date', '>=', date_from.strftime('%Y-%m-%d')),
            ('date', '<', date_to.strftime('%Y-%m-%d')),
        ]
        if type_filter in ('thu', 'chi', 'vay', 'hoan_ung'):
            domain.append(('type', '=', type_filter))
        if search:
            domain += ['|', ('name', 'ilike', search), ('transaction_code', 'ilike', search)]

        records = request.env['bbsw.thuchi.record'].search(domain)
        thu_total = sum(r.amount for r in records if r.type == 'thu' and r.state not in ('cancelled', 'rejected'))
        chi_total = sum(r.amount for r in records if r.type == 'chi' and r.state not in ('cancelled', 'rejected'))

        def _obj_name(r):
            if r.object_type == 'partner':   return r.partner_id.name or ''
            if r.object_type == 'employee':  return r.employee_id.name or ''
            if r.object_type == 'student':   return r.student_name or ''
            return r.other_name or ''

        return {
            'records': [{
                'id': r.id,
                'transaction_code':   r.transaction_code or '',
                'name':               r.name,
                'date':               r.date.strftime('%d/%m/%Y') if r.date else '',
                'date_raw':           r.date.strftime('%Y-%m-%d') if r.date else '',
                'type':               r.type,
                'category_id':        r.category_id.id,
                'category_name':      r.category_id.name or '',
                'amount':             r.amount,
                'state':              r.state,
                'payment_status':     r.payment_status or 'unpaid',
                'business_unit_id':   r.business_unit_id.id or False,
                'business_unit_name': r.business_unit_id.name or '',
                'project_id':         r.project_id.id or False,
                'project_name':       r.project_id.name or '',
                'object_type':        r.object_type or 'partner',
                'partner_id':         r.partner_id.id or False,
                'employee_id':        r.employee_id.id or False,
                'student_name':       r.student_name or '',
                'other_name':         r.other_name or '',
                'object_name':        _obj_name(r),
                'payment_method_id':  r.payment_method_id.id or False,
                'payment_method_name':r.payment_method_id.name or '',
                'cost_allocation':    r.cost_allocation or '',
                'is_advance':         r.is_advance,
                'rejection_reason':   r.rejection_reason or '',
                'note':               r.note or '',
                'user_name':          r.user_id.name or '',
                'attachment_count':   request.env['ir.attachment'].search_count([
                    ('res_model', '=', 'bbsw.thuchi.record'), ('res_id', '=', r.id)
                ]),
            } for r in records],
            'thu_total': thu_total,
            'chi_total': chi_total,
            'balance': thu_total - chi_total,
        }

    @http.route('/project/thuchi/api/save', type='json', auth='user')
    def api_save(self, record_id=None, name='', type='chi', category_id=None,
                 amount=0, date=None, note='', auto_confirm=False,
                 business_unit_id=None, project_id=None,
                 object_type='partner', partner_id=None, employee_id=None,
                 student_name='', other_name='',
                 payment_method_id=None, payment_status='unpaid',
                 cost_allocation=None, is_advance=False, **kw):
        if not self._require_admin():
            return {'error': 'Không có quyền truy cập'}
        vals = {
            'name':              name,
            'type':              type,
            'category_id':       int(category_id) if category_id else False,
            'amount':            float(amount),
            'date':              date or datetime.date.today().strftime('%Y-%m-%d'),
            'note':              note or '',
            'business_unit_id':  int(business_unit_id) if business_unit_id else False,
            'project_id':        int(project_id) if project_id else False,
            'object_type':       object_type or 'partner',
            'partner_id':        int(partner_id) if partner_id else False,
            'employee_id':       int(employee_id) if employee_id else False,
            'student_name':      student_name or '',
            'other_name':        other_name or '',
            'payment_method_id': int(payment_method_id) if payment_method_id else False,
            'payment_status':    payment_status or 'unpaid',
            'cost_allocation':   cost_allocation or False,
            'is_advance':        bool(is_advance),
        }
        if record_id:
            rec = request.env['bbsw.thuchi.record'].browse(int(record_id))
            if not rec.exists():
                return {'error': 'Không tìm thấy bản ghi'}
            rec.write(vals)
        else:
            rec = request.env['bbsw.thuchi.record'].create(vals)

        if auto_confirm and rec.state == 'draft':
            rec.action_submit()

        return {'id': rec.id, 'state': rec.state, 'transaction_code': rec.transaction_code, 'success': True}

    @http.route('/project/thuchi/api/action', type='json', auth='user')
    def api_action(self, record_id, action, rejection_reason='', **kw):
        if not self._require_admin():
            return {'error': 'Không có quyền truy cập'}
        rec = request.env['bbsw.thuchi.record'].browse(int(record_id))
        if not rec.exists():
            return {'error': 'Không tìm thấy bản ghi'}
        if action == 'reject':
            if rejection_reason:
                rec.write({'rejection_reason': rejection_reason})
            rec.action_reject()
        else:
            fn = {
                'submit':  rec.action_submit,
                'approve': rec.action_approve,
                'cancel':  rec.action_cancel,
                'draft':   rec.action_draft,
                'confirm': rec.action_submit,
            }.get(action)
            if fn:
                fn()
        return {'id': rec.id, 'state': rec.state, 'success': True}

    @http.route('/project/thuchi/api/delete', type='json', auth='user')
    def api_delete(self, record_id, **kw):
        if not self._require_admin():
            return {'error': 'Không có quyền truy cập'}
        rec = request.env['bbsw.thuchi.record'].browse(int(record_id))
        if not rec.exists():
            return {'error': 'Không tìm thấy bản ghi'}
        rec.unlink()
        return {'success': True}

    @http.route('/project/thuchi/api/attachments', type='json', auth='user')
    def api_attachments(self, record_id, **kw):
        if not self._require_admin():
            return {'attachments': []}
        attachments = request.env['ir.attachment'].search([
            ('res_model', '=', 'bbsw.thuchi.record'),
            ('res_id', '=', int(record_id)),
        ])
        return {'attachments': [{'id': a.id, 'name': a.name} for a in attachments]}

    @http.route('/project/thuchi/api/attachment/upload', type='json', auth='user')
    def api_attachment_upload(self, record_id, filename, mimetype, data, **kw):
        if not self._require_admin():
            return {'error': 'Không có quyền truy cập'}
        request.env['ir.attachment'].create({
            'name': filename,
            'res_model': 'bbsw.thuchi.record',
            'res_id': int(record_id),
            'mimetype': mimetype,
            'datas': data,
        })
        return {'success': True}

    @http.route('/project/thuchi/api/attachment/delete', type='json', auth='user')
    def api_attachment_delete(self, attachment_id, **kw):
        if not self._require_admin():
            return {'error': 'Không có quyền truy cập'}
        att = request.env['ir.attachment'].browse(int(attachment_id))
        if not att.exists():
            return {'error': 'Không tìm thấy tệp đính kèm'}
        att.unlink()
        return {'success': True}


class AttendanceCheckin(http.Controller):

    def _get_employee(self):
        return request.env['hr.employee'].search(
            [('user_id', '=', request.env.user.id)], limit=1)

    def _fmt_vn(self, dt_utc):
        """Chuyển datetime UTC (naive) → chuỗi HH:MM giờ VN."""
        if not dt_utc:
            return ''
        dt = pytz.utc.localize(dt_utc).astimezone(_VN_TZ)
        return dt.strftime('%H:%M')

    def _today_range_utc(self):
        """Trả về (start_utc, end_utc) của ngày hôm nay theo giờ VN."""
        now_vn = datetime.datetime.now(_VN_TZ)
        start_vn = now_vn.replace(hour=0, minute=0, second=0, microsecond=0)
        end_vn = now_vn.replace(hour=23, minute=59, second=59, microsecond=999999)
        start_utc = start_vn.astimezone(pytz.utc).replace(tzinfo=None)
        end_utc = end_vn.astimezone(pytz.utc).replace(tzinfo=None)
        return start_utc, end_utc

    @http.route('/attendance/checkin', type='http', auth='user', website=True, multilang=False)
    def checkin_page(self, **kw):
        user = request.env.user
        employee = self._get_employee()

        open_att = None
        today_records = []
        checkin_str = ''

        if employee:
            Attendance = request.env['hr.attendance'].sudo()
            open_att = Attendance.search([
                ('employee_id', '=', employee.id),
                ('check_out', '=', False),
            ], limit=1)

            start_utc, end_utc = self._today_range_utc()
            today_records_raw = Attendance.search([
                ('employee_id', '=', employee.id),
                ('check_in', '>=', fields.Datetime.to_string(start_utc)),
                ('check_in', '<=', fields.Datetime.to_string(end_utc)),
            ], order='check_in asc')

            today_records = [{
                'check_in': self._fmt_vn(r.check_in),
                'check_out': self._fmt_vn(r.check_out) if r.check_out else '',
                'worked_hours': round(r.worked_hours, 1) if r.check_out else '',
                'open': not r.check_out,
            } for r in today_records_raw]

            if open_att:
                checkin_str = self._fmt_vn(open_att.check_in)

        now_vn = datetime.datetime.now(_VN_TZ)
        weekdays_vn = ['Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật']
        date_str = f"{weekdays_vn[now_vn.weekday()]}, {now_vn.strftime('%d/%m/%Y')}"

        return request.render('bbsw_thuchi.attendance_checkin_template', {
            'current_user': user,
            'employee': employee,
            'is_checked_in': bool(open_att),
            'checkin_str': checkin_str,
            'today_records_json': Markup(json.dumps(today_records)),
            'date_str': date_str,
        })

    # Tọa độ văn phòng & bán kính cho phép (mét)
    # 90 Trần Thị Nghỉ, Phường Hạnh Thông, TP.HCM
    _OFFICE_LAT = 10.828814884905915
    _OFFICE_LNG = 106.68254276692944
    _MAX_RADIUS = 500

    def _haversine(self, lat1, lng1, lat2, lng2):
        import math
        R = 6371000
        d_lat = math.radians(lat2 - lat1)
        d_lng = math.radians(lng2 - lng1)
        a = (math.sin(d_lat/2)**2 +
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
             math.sin(d_lng/2)**2)
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    @http.route('/attendance/api/checkin', type='json', auth='user')
    def api_checkin(self, action='in', latitude=None, longitude=None, address=None, photo=None, **kw):
        employee = self._get_employee()
        if not employee:
            return {'error': 'Tài khoản chưa được liên kết với nhân viên nào.'}

        now_utc = datetime.datetime.utcnow()
        is_out_of_range = False

        # Kiểm tra geofencing nếu có GPS
        if latitude is not None and longitude is not None:
            dist = self._haversine(
                float(latitude), float(longitude),
                self._OFFICE_LAT, self._OFFICE_LNG,
            )
            if dist > self._MAX_RADIUS:
                is_out_of_range = True
                # Nếu ngoài bán kính mà chưa có ảnh → yêu cầu chụp ảnh
                if not photo:
                    return {
                        'need_photo': True,
                        'distance': round(dist),
                        'max_radius': self._MAX_RADIUS,
                        'error': 'Bạn đang cách văn phòng %dm. Vui lòng chụp ảnh để xác nhận.' % round(dist),
                    }

        Attendance = request.env['hr.attendance'].sudo()

        if action == 'in':
            open_att = Attendance.search([
                ('employee_id', '=', employee.id),
                ('check_out', '=', False),
            ], limit=1)
            if open_att:
                return {'error': 'Bạn đã vào ca rồi.', 'already_in': True}
            vals = {
                'employee_id': employee.id,
                'check_in': fields.Datetime.to_string(now_utc),
                'attendance_code': 'X',
                'in_mode': 'manual',
            }
            if latitude is not None:
                vals['in_latitude'] = float(latitude)
            if longitude is not None:
                vals['in_longitude'] = float(longitude)
            if address:
                vals['checkin_address'] = address
            if photo:
                vals['checkin_photo'] = photo
                vals['checkin_photo_filename'] = 'checkin_%s_%s.jpg' % (employee.id, now_utc.strftime('%Y%m%d_%H%M%S'))
            Attendance.create(vals)
            return {
                'success': True,
                'action': 'in',
                'time': self._fmt_vn(now_utc),
                'address': address or '',
                'out_of_range': is_out_of_range,
            }

        elif action == 'out':
            open_att = Attendance.search([
                ('employee_id', '=', employee.id),
                ('check_out', '=', False),
            ], limit=1)
            if not open_att:
                return {'error': 'Bạn chưa vào ca.', 'not_in': True}
            vals = {
                'check_out': fields.Datetime.to_string(now_utc),
                'out_mode': 'manual',
            }
            if latitude is not None:
                vals['out_latitude'] = float(latitude)
            if longitude is not None:
                vals['out_longitude'] = float(longitude)
            if address:
                vals['checkout_address'] = address
            if photo:
                vals['checkout_photo'] = photo
                vals['checkout_photo_filename'] = 'checkout_%s_%s.jpg' % (employee.id, now_utc.strftime('%Y%m%d_%H%M%S'))
            open_att.write(vals)
            worked = round(open_att.worked_hours, 1)
            return {
                'success': True,
                'action': 'out',
                'time': self._fmt_vn(now_utc),
                'checkin_time': self._fmt_vn(open_att.check_in),
                'worked_hours': worked,
                'address': address or '',
                'out_of_range': is_out_of_range,
            }

        return {'error': 'Action không hợp lệ.'}

    @http.route('/attendance/history', type='http', auth='user', website=True, multilang=False)
    def attendance_history(self, month=None, **kw):
        import calendar as cal_mod
        user = request.env.user
        employee = self._get_employee()

        now_vn = datetime.datetime.now(_VN_TZ)
        if not month:
            month = now_vn.strftime('%Y-%m')

        try:
            year, m = map(int, month.split('-'))
        except Exception:
            year, m = now_vn.year, now_vn.month

        # Giới hạn tháng hợp lệ
        year = max(2020, min(year, now_vn.year + 1))
        m = max(1, min(m, 12))

        # Điều hướng tháng trước / sau
        if m == 1:
            prev_month = f'{year - 1}-12'
        else:
            prev_month = f'{year}-{m - 1:02d}'
        if m == 12:
            next_month = f'{year + 1}-01'
        else:
            next_month = f'{year}-{m + 1:02d}'

        records = []
        total_days = 0.0
        total_hours = 0.0

        if employee:
            date_from = datetime.date(year, m, 1)
            last_day = cal_mod.monthrange(year, m)[1]
            date_to = datetime.date(year, m, last_day)

            start_utc = _VN_TZ.localize(
                datetime.datetime(year, m, 1, 0, 0, 0)
            ).astimezone(pytz.utc).replace(tzinfo=None)
            end_utc = _VN_TZ.localize(
                datetime.datetime(year, m, last_day, 23, 59, 59)
            ).astimezone(pytz.utc).replace(tzinfo=None)

            atts = request.env['hr.attendance'].sudo().search([
                ('employee_id', '=', employee.id),
                ('check_in', '>=', fields.Datetime.to_string(start_utc)),
                ('check_in', '<=', fields.Datetime.to_string(end_utc)),
            ], order='check_in asc')

            seen_days = set()
            for att in atts:
                vn_date = pytz.utc.localize(att.check_in).astimezone(_VN_TZ).date()
                records.append({
                    'date': vn_date.strftime('%d/%m/%Y'),
                    'weekday': ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'][vn_date.weekday()],
                    'check_in': self._fmt_vn(att.check_in),
                    'check_out': self._fmt_vn(att.check_out) if att.check_out else '—',
                    'worked_hours': round(att.worked_hours, 1) if att.check_out else '—',
                    'code': att.attendance_code or 'X',
                    'open': not att.check_out,
                })
                total_hours += att.worked_hours or 0.0
                if vn_date not in seen_days:
                    seen_days.add(vn_date)
                    total_days += 1

        return request.render('bbsw_thuchi.attendance_history_template', {
            'current_user': user,
            'employee': employee,
            'month_label': f'Tháng {m:02d}/{year}',
            'prev_month': prev_month,
            'next_month': next_month,
            'records': records,
            'total_days': int(total_days),
            'total_hours': round(total_hours, 1),
        })

    @http.route('/attendance/api/status', type='json', auth='user')
    def api_status(self, **kw):
        employee = self._get_employee()
        if not employee:
            return {'has_employee': False}

        Attendance = request.env['hr.attendance'].sudo()
        open_att = Attendance.search([
            ('employee_id', '=', employee.id),
            ('check_out', '=', False),
        ], limit=1)

        start_utc, end_utc = self._today_range_utc()
        today_records_raw = Attendance.search([
            ('employee_id', '=', employee.id),
            ('check_in', '>=', fields.Datetime.to_string(start_utc)),
            ('check_in', '<=', fields.Datetime.to_string(end_utc)),
        ], order='check_in asc')

        today_records = [{
            'check_in': self._fmt_vn(r.check_in),
            'check_out': self._fmt_vn(r.check_out) if r.check_out else '',
            'worked_hours': round(r.worked_hours, 1) if r.check_out else '',
            'open': not r.check_out,
        } for r in today_records_raw]

        return {
            'has_employee': True,
            'is_checked_in': bool(open_att),
            'checkin_time': self._fmt_vn(open_att.check_in) if open_att else '',
            'today_records': today_records,
        }
