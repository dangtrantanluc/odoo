from odoo import fields, models


class BbProjectTelegramMessageLog(models.Model):
    _name = "bb.project.telegram.message.log"
    _description = "BB Project Telegram Message Log"
    _order = "id desc"

    link_id = fields.Many2one("bb.project.telegram.link", ondelete="set null", index=True)
    telegram_update_id = fields.Char(index=True)
    direction = fields.Selection([
        ("in", "Inbound"),
        ("out", "Outbound"),
    ], required=True)
    raw_text = fields.Text()
    normalized_text = fields.Text()
    parsed_intent = fields.Char()
    parsed_params_json = fields.Text()
    resolved_project_id = fields.Many2one("bb.project")
    response_text = fields.Text()
    used_llm = fields.Boolean(default=False)
    state = fields.Selection([
        ("done", "Done"),
        ("ignored", "Ignored"),
        ("error", "Error"),
    ], default="done", required=True)
    error_message = fields.Text()

    def init(self):
        self.env.cr.execute("""
            ALTER TABLE bb_project_telegram_message_log
            DROP CONSTRAINT IF EXISTS telegram_update_id_unique
        """)
        self.env.cr.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS bb_project_tg_msg_log_inbound_uidx
            ON bb_project_telegram_message_log (telegram_update_id)
            WHERE direction = 'in' AND telegram_update_id IS NOT NULL
        """)