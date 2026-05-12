# -*- coding: utf-8 -*-
import os
import requests

from odoo import http
from odoo.http import request

AGENT_URL = os.environ.get("AGENT_URL", "http://agent:8001")


class BbAiChatController(http.Controller):

    @http.route("/web/bb_pm_agent/ask", type="json", auth="user", methods=["POST"])
    def ask(self, question, session_id=None):
        """Proxy /ask request tới agent service, inject uid + role từ session Odoo."""
        user = request.env.user
        uid = int(user.id)

        # Map Odoo security group → agent role
        if user.has_group("bb_project_management.group_bb_pm_admin"):
            role = "admin"
        elif user.has_group("bb_project_management.group_bb_pm_manager"):
            role = "manager"
        elif user.has_group("bb_project_management.group_bb_pm_member"):
            role = "member"
        else:
            role = "viewer"

        payload = {
            "question": question,
            "user_id": uid,
            "role": role,
            "session_id": session_id or f"odoo_{uid}",
        }

        try:
            resp = requests.post(
                f"{AGENT_URL}/ask",
                json=payload,
                timeout=90,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.ConnectionError:
            return {
                "answer": "Không thể kết nối tới AI Agent. Vui lòng kiểm tra agent service.",
                "error": True,
            }
        except Exception as e:
            return {
                "answer": f"Lỗi AI Agent: {str(e)}",
                "error": True,
            }
