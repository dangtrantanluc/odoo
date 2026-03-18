# -*- coding: utf-8 -*-
from odoo import models, fields


class BbResUsers(models.Model):
    _inherit = 'res.users'

    bb_avatar_url = fields.Char(
        string='Avatar URL (MinIO)',
        help='Public URL of the user avatar stored in MinIO.',
    )
