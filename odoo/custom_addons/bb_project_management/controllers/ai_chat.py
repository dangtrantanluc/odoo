# -*- coding: utf-8 -*-
import os
import requests

from odoo import http
from odoo.http import request

AGENT_URL = os.environ.get("AGENT_URL", "http://agent:8001")


class BbAiChatController(http.Controller):

    @http.route("/web/bb_pm_agent/ask", type="json", auth="user", methods=["POST"])
    def ask(self, question, session_id=None):
        """Proxy /ask to the agent service, injecting Odoo uid + role."""
        user = request.env.user
        uid = int(user.id)
        payload = {
            "question": question,
            "user_id": uid,
            "role": self._get_user_role(user),
            "session_id": session_id or f"odoo_{uid}",
        }
        try:
            resp = requests.post(f"{AGENT_URL}/ask", json=payload, timeout=90)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.ConnectionError:
            return {"answer": "Không thể kết nối tới AI Agent. Vui lòng kiểm tra agent service.", "error": True}
        except Exception as e:
            return {"answer": f"Lỗi AI Agent: {str(e)}", "error": True}

    @staticmethod
    def _get_user_role(user):
        """Map Odoo security groups to agent role strings (highest privilege first)."""
        if user.has_group("bb_project_management.group_bb_pm_admin"):
            return "admin"
        if user.has_group("bb_project_management.group_bb_pm_manager"):
            return "manager"
        if user.has_group("bb_project_management.group_bb_pm_member"):
            return "member"
        return "viewer"
