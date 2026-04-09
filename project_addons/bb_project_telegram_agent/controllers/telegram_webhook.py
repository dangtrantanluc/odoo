from odoo import http
from odoo.http import request


class BBProjectTelegramWebHook(http.Controller):

    @http.route("/bb_pm/telegram/webhook", type="json", auth="public", methods=["POST"], csrf=False)
    def telegram_webhook(self, **kwargs):
        secret = request.httprequest.headers.get("X-Telegram-Bot-Api-Secret-Token")
        expected = request.env["ir.config_parameter"].sudo().get_param("bb_pm.telegram.webhook_secret")

        if not expected or secret != expected:
            return {"ok": False, "error": "invalid_secret"}

        payload = request.get_json_data() or {}
        request.env["bb.project.telegram.service"].sudo().handle_update(payload)
        return {"ok": True}
