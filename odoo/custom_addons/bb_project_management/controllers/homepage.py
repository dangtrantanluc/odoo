# -*- coding: utf-8 -*-
import werkzeug

from odoo import http
from odoo.http import request


class BbProjectHomepage(http.Controller):

    @http.route('/project/bb-project', type='http', auth='user')
    def bb_project_home(self, **kw):
        """Redirect straight to the Odoo backend project list."""
        action = request.env.ref('bb_project_management.action_bb_project')
        return werkzeug.utils.redirect(f'/web#action={action.id}&cids=1')
