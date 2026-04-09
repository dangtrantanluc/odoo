import secrets

from odoo import fields, models

class BBProjectTelegramLink(models.Model):
    _name = 'bb.project.telegram.link'
    _description = 'BB Telegram Link'
    _rec_name = 'user_id'
    _order = 'id desc'

    user_id = fields.Many2one('res.users', ondelete='cascade', index=True, required=True)
    telegram_user_id = fields.Char(index=True, copy=False)
    telegram_chat_id = fields.Char(index=True, copy=False)
    telegram_username = fields.Char(copy=False)

    state = fields.Selection([
        ("draft", "Draft"),
        ("pending_link", "Pending Link"),
        ("linked", "Linked"),
        ("revoked", "Revoked"),
    ], default="draft", required=True)

    link_token = fields.Char(copy=False)
    link_token_expires_at = fields.Datetime(copy=False)

    summary_enabled = fields.Boolean(default=False)
    summary_time = fields.Char(default="08:00")
    timezone = fields.Char(default=lambda self: self.env.user.tz or "Asia/Ho_Chi_Minh")
    next_summary_at = fields.Datetime(copy=False)
    last_seen_at = fields.Datetime(readonly=True)

    long_term_summary = fields.Text()
    lifetime_turn_count = fields.Integer(default=0)
    _sql_constraints = [
        ("user_id_unique", "unique(user_id)", "Each Odoo user can only have one Telegram link."),
        ("telegram_user_id_unique", "unique(telegram_user_id)", "This Telegram account is already linked."),
    ]


    def action_generate_link_token(self):
        for rec in self:
            rec.link_token = secrets.token_urlsafe(24)
            rec.link_token_expires_at = fields.Datetime.add(fields.Datetime.now(), hours=1)
            rec.state = "pending_link"
