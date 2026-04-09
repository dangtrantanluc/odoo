from odoo import fields, models


class BBProjectTelegramSession(models.Model):
    _name = 'bb.project.telegram.session'
    _description = 'BB Telegram Session'
    _order = 'id desc'

    link_id = fields.Many2one('bb.project.telegram.link', ondelete='cascade', index=True, required=True)
    last_intent = fields.Char()
    last_project_id = fields.Many2one('bb.project', ondelete='set null')
    last_period_key = fields.Char()
    context_json = fields.Text()
    expires_at = fields.Datetime(index=True)
    conversation_history_json = fields.Text(default="[]")
    turn_count = fields.Integer(default=0)
