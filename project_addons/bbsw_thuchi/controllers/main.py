# -*- coding: utf-8 -*-
import json
import base64
import datetime
from markupsafe import Markup

from odoo import http
from odoo.http import request
from odoo.addons.web.controllers.home import Home


class ProjectHomepage(http.Controller):

    @http.route(['/project/home'], type='http', auth='user')
    def project_homepage(self, **kw):
        user = request.env.user
        user_group_ids = user.groups_id.ids
        apps = request.env['bbsw.home.app'].search([
            '|',
            ('groups_id', '=', False),
            ('groups_id', 'in', user_group_ids),
        ])
        return request.render('bbsw_thuchi.project_homepage_template', {
            'apps': apps,
            'current_user': user,
        })


class CustomHome(Home):
    @http.route('/', auth='user')
    def index(self, **kw):
        return request.redirect('/project/home')

    @http.route('/odoo', auth='user')
    def odoo_home(self, **kw):
        return request.redirect('/project/home')

    def _login_redirect(self, uid, redirect=None):
        if not redirect:
            redirect = '/project/home'
        return super()._login_redirect(uid, redirect=redirect)


class ThuChiPage(http.Controller):

    @http.route('/project/thuchi', type='http', auth='user')
    def thuchi_page(self, month=None, **kw):
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
        rec = request.env['bbsw.thuchi.record'].browse(int(record_id))
        if not rec.exists():
            return {'error': 'Không tìm thấy bản ghi'}
        rec.unlink()
        return {'success': True}

    @http.route('/project/thuchi/api/attachments', type='json', auth='user')
    def api_attachments(self, record_id, **kw):
        attachments = request.env['ir.attachment'].search([
            ('res_model', '=', 'bbsw.thuchi.record'),
            ('res_id', '=', int(record_id)),
        ])
        return {'attachments': [{'id': a.id, 'name': a.name} for a in attachments]}

    @http.route('/project/thuchi/api/attachment/upload', type='json', auth='user')
    def api_attachment_upload(self, record_id, filename, mimetype, data, **kw):
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
        att = request.env['ir.attachment'].browse(int(attachment_id))
        if not att.exists():
            return {'error': 'Không tìm thấy tệp đính kèm'}
        att.unlink()
        return {'success': True}
