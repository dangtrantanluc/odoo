# -*- coding: utf-8 -*-
import os
import requests

from odoo import http
from odoo.http import request

AGENT_URL = os.environ.get("AGENT_URL", "http://agent:8001")

_ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


class BbAvatarController(http.Controller):

    @http.route("/web/bb_pm/avatar/upload", type="http", auth="user", methods=["POST"], csrf=False)
    def upload_avatar(self):
        """Receive file upload → proxy to agent MinIO upload → save URL on res.users."""
        file_storage = request.httprequest.files.get("avatar")

        if not file_storage:
            return request.make_json_response({"error": "No file provided."}, status=400)
        if file_storage.content_type not in _ALLOWED_TYPES:
            return request.make_json_response({"error": "Only image files allowed."}, status=400)

        uid = request.env.user.id
        try:
            resp = requests.post(
                f"{AGENT_URL}/upload-avatar",
                files={"file": (file_storage.filename, file_storage.stream, file_storage.content_type)},
                data={"user_id": uid},
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
        except requests.exceptions.ConnectionError:
            return request.make_json_response({"error": "Agent service unavailable."}, status=502)
        except Exception as e:
            return request.make_json_response({"error": str(e)}, status=500)

        avatar_url = data.get("url", "")
        if avatar_url:
            request.env.user.sudo().write({"bb_avatar_url": avatar_url})

        return request.make_json_response({"url": avatar_url})
