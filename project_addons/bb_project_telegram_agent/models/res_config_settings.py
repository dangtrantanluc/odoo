from odoo import fields, models


class ResConfigSettings(models.TransientModel):
    _inherit = "res.config.settings"

    bb_pm_telegram_bot_token = fields.Char(config_parameter="bb_pm.telegram.bot_token")
    bb_pm_telegram_bot_username = fields.Char(config_parameter="bb_pm.telegram.bot_username")
    bb_pm_telegram_webhook_secret = fields.Char(config_parameter="bb_pm.telegram.webhook_secret")
    bb_pm_telegram_base_url = fields.Char(config_parameter="bb_pm.telegram.base_url")

    bb_pm_enable_llm = fields.Boolean(config_parameter="bb_pm.telegram.enable_llm")
    bb_pm_llm_api_key = fields.Char(config_parameter="bb_pm.llm.api_key")
    bb_pm_llm_model = fields.Char(config_parameter="bb_pm.llm.model", default="gpt-4.1-mini")
    bb_pm_llm_base_url = fields.Char(
        config_parameter="bb_pm.llm.base_url",
        default="https://apimodel.berp.vn/v1",
    )
    bb_pm_llm_temperature = fields.Float(
        config_parameter="bb_pm.llm.temperature",
        default=0.0,
    )
    bb_pm_llm_timeout = fields.Integer(
        config_parameter="bb_pm.llm.timeout",
        default=30,
    )
