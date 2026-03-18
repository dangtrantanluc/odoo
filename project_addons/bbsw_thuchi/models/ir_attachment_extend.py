from odoo import models


class IrAttachmentExtend(models.Model):
    _inherit = 'ir.attachment'

    def action_preview(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_url',
            'url': f'/web/content/{self.id}?filename={self.name}',
            'target': 'new',
        }
