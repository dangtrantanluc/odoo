from odoo import SUPERUSER_ID


def post_init_hook(env):
    apps = env['bbsw.home.app'].with_user(SUPERUSER_ID).search([
        ('url', '!=', False),
    ])
    for app in apps:
        legacy_target = app._get_legacy_target_values(app.url)
        if not legacy_target:
            continue

        vals = {}
        if not app.route_path and legacy_target.get('route_path'):
            vals['route_path'] = legacy_target['route_path']
        if not app.menu_xmlid and legacy_target.get('menu_xmlid'):
            vals['menu_xmlid'] = legacy_target['menu_xmlid']
        if (not app.target_type or not app.is_target_valid) and legacy_target.get('target_type'):
            vals['target_type'] = legacy_target['target_type']
        if vals:
            app.write(vals)
