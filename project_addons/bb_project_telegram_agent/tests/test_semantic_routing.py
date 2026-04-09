# -*- coding: utf-8 -*-
import json
from unittest.mock import patch

from odoo.tests.common import TransactionCase

from ..models import bb_project_telegram_service as service_module
from ..utils.intent_parser import parse_message


class TestBbProjectTelegramSemanticRouting(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.project = cls.env["bb.project"].create(
            {
                "name": "Mobile Banking App",
                "code": "MBA-001",
                "status": "in_progress",
                "priority": "high",
                "start_date": "2026-01-01",
                "end_date": "2026-12-31",
                "budget": 120000.0,
            }
        )
        cls.project_alt = cls.env["bb.project"].create(
            {
                "name": "Merchant Core",
                "code": "MCK-LPS",
                "status": "in_progress",
                "priority": "high",
                "start_date": "2026-01-01",
                "end_date": "2026-12-31",
                "budget": 90000.0,
            }
        )
        cls.task = cls.env["bb.project.task"].create(
            {
                "name": "Build semantic router",
                "project_id": cls.project.id,
                "status": "in_progress",
                "priority": "high",
            }
        )
        cls.link = cls.env["bb.project.telegram.link"].create(
            {
                "user_id": cls.env.user.id,
                "telegram_user_id": "1001",
                "telegram_chat_id": "2001",
                "telegram_username": "tester",
                "state": "linked",
            }
        )
        cls.service = cls.env["bb.project.telegram.service"]

    def test_parse_message_keeps_project_progress_query_out_of_today_summary(self):
        parsed = parse_message("Cho toi xem tien do project MBA-001")

        self.assertEqual(parsed["intent"], "project_status")
        self.assertEqual(parsed["project_ref"], "mba-001")
        self.assertEqual(parsed["match_strength"], "low")

    def test_parse_message_extracts_non_fixed_project_code(self):
        parsed = parse_message("Xem du an nay cho toi MCK-LPS")

        self.assertEqual(parsed["intent"], "project_status")
        self.assertEqual(parsed["project_ref"], "mck-lps")

    def test_parse_message_extracts_summary_schedule_from_natural_text(self):
        parsed = parse_message("5h bạn có thể gửi cho tôi tiến độ của các project hiện tại được không")

        self.assertEqual(parsed["intent"], "summary_on")
        self.assertEqual(parsed["summary_time"], "05:00")
        self.assertEqual(parsed["match_strength"], "high")

    def test_parse_message_does_not_treat_plain_project_question_as_schedule(self):
        parsed = parse_message("5h cho toi xem tien do project MCK-LPS")

        self.assertEqual(parsed["intent"], "project_status")
        self.assertEqual(parsed["project_ref"], "mck-lps")

    def test_handle_text_resolves_non_fixed_project_code_without_llm(self):
        with patch.object(type(self.service), "_llm_enabled", autospec=True, return_value=False), patch.object(
            type(self.service),
            "_rewrite_reply_with_llm",
            autospec=True,
            side_effect=lambda _service, parsed, payload, fallback_text: fallback_text,
        ):
            result = self.service.handle_text(self.link, "Xem du an nay cho toi MCK-LPS")

        self.assertEqual(result["parsed"]["intent"], "project_status")
        self.assertEqual(result["parsed"]["project_ref"], "mck-lps")
        self.assertEqual(result["payload"]["project"]["code"], "MCK-LPS")

    def test_handle_text_sets_summary_time_from_natural_text(self):
        with patch.object(type(self.service), "_llm_enabled", autospec=True, return_value=False):
            result = self.service.handle_text(
                self.link,
                "5h bạn có thể gửi cho tôi tiến độ của các project hiện tại được không",
            )

        self.link.invalidate_recordset()
        self.assertEqual(result["parsed"]["intent"], "summary_on")
        self.assertEqual(result["parsed"]["summary_time"], "05:00")
        self.assertTrue(self.link.summary_enabled)
        self.assertEqual(self.link.summary_time, "05:00")
        self.assertIn("05:00", result["reply_text"])

    def test_handle_text_uses_llm_to_route_semantic_project_query(self):
        llm_parsed = {
            "intent": "project_status",
            "project_ref": "Mobile Banking App",
            "period": "current",
            "confidence": "high",
            "classification_source": "llm",
        }

        with patch.object(type(self.service), "_llm_enabled", autospec=True, return_value=True), patch.object(
            type(self.service),
            "_handle_text_agent",
            autospec=True,
            side_effect=RuntimeError("Agent unavailable"),
        ), patch.object(
            type(self.service),
            "_llm_classify",
            autospec=True,
            return_value=llm_parsed,
        ) as llm_mock, patch.object(
            type(self.service),
            "_rewrite_reply_with_llm",
            autospec=True,
            side_effect=lambda _service, parsed, payload, fallback_text: fallback_text,
        ):
            result = self.service.handle_text(self.link, "Cho toi xem tien do mobile banking app")

        self.assertEqual(result["parsed"]["intent"], "project_status")
        self.assertEqual(result["parsed"]["classification_source"], "llm")
        self.assertEqual(result["payload"]["project"]["name"], "Mobile Banking App")
        llm_mock.assert_called_once()

    def test_handle_text_uses_llm_to_fill_missing_project_ref(self):
        llm_parsed = {
            "intent": "project_budget",
            "project_ref": "MBA-001",
            "period": "current",
            "confidence": "high",
            "classification_source": "llm",
        }

        with patch.object(type(self.service), "_llm_enabled", autospec=True, return_value=True), patch.object(
            type(self.service),
            "_handle_text_agent",
            autospec=True,
            side_effect=RuntimeError("Agent unavailable"),
        ), patch.object(
            type(self.service),
            "_llm_classify",
            autospec=True,
            return_value=llm_parsed,
        ), patch.object(
            type(self.service),
            "_rewrite_reply_with_llm",
            autospec=True,
            side_effect=lambda _service, parsed, payload, fallback_text: fallback_text,
        ):
            result = self.service.handle_text(self.link, "Xem ngan sach du an mobile banking app")

        self.assertEqual(result["parsed"]["intent"], "project_budget")
        self.assertEqual(result["parsed"]["classification_source"], "hybrid")
        self.assertEqual(result["parsed"]["project_ref"], "MBA-001")
        self.assertEqual(result["payload"]["project"]["code"], "MBA-001")

    def test_handle_text_skips_llm_for_explicit_commands(self):
        with patch.object(type(self.service), "_llm_enabled", autospec=True, return_value=True), patch.object(
            type(self.service),
            "_handle_text_agent",
            autospec=True,
            side_effect=AssertionError("Agent should not be called for explicit commands"),
        ), patch.object(
            type(self.service),
            "_llm_classify",
            autospec=True,
            side_effect=AssertionError("LLM should not be called for explicit commands"),
        ):
            result = self.service.handle_text(self.link, "/clear")

        self.assertEqual(result["parsed"]["intent"], "clear_context")
        self.assertEqual(result["reply_text"], "Da xoa bo nho hoi thoai gan nhat.")

    def test_handle_text_uses_agent_loop_and_persists_history(self):
        payload = self.service.get_project_status(self.link, project_ref="MCK-LPS")
        updated_messages = [
            {"role": "user", "content": "Tinh hinh project MCK-LPS"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "get_project_status",
                            "arguments": json.dumps({"project_ref": "MCK-LPS"}),
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "name": "get_project_status",
                "content": json.dumps(payload, ensure_ascii=False),
            },
            {"role": "assistant", "content": "Project MCK-LPS dang on dinh."},
        ]

        with patch.object(type(self.service), "_llm_enabled", autospec=True, return_value=True), patch.object(
            type(self.service),
            "_llm_runtime_config",
            autospec=True,
            return_value={
                "base_url": "http://llm.local",
                "model": "mock-model",
                "api_key": None,
                "temperature": 0.0,
                "timeout": 30,
            },
        ), patch.object(
            service_module,
            "run_agent_loop",
            return_value=("Project MCK-LPS dang on dinh.", updated_messages),
        ):
            result = self.service.handle_text(self.link, "Tinh hinh project MCK-LPS")

        session = self.service.load_session(self.link)
        self.link.invalidate_recordset()

        self.assertEqual(result["parsed"]["classification_source"], "agent")
        self.assertEqual(result["parsed"]["intent"], "project_status")
        self.assertEqual(result["parsed"]["project_ref"], "MCK-LPS")
        self.assertEqual(result["reply_text"], "Project MCK-LPS dang on dinh.")
        self.assertTrue(session)
        self.assertEqual(session.turn_count, 1)
        self.assertEqual(session.last_intent, "agent")
        self.assertEqual(session.last_project_id.code, "MCK-LPS")
        self.assertEqual(self.link.lifetime_turn_count, 1)
        self.assertEqual(
            json.loads(session.conversation_history_json),
            [
                {"role": "user", "content": "Tinh hinh project MCK-LPS"},
                {"role": "assistant", "content": "Project MCK-LPS dang on dinh."},
            ],
        )

    def test_maybe_update_long_term_memory_updates_summary_and_resets_turn_count(self):
        session = self.service._session_model().create(
            {
                "link_id": self.link.id,
                "conversation_history_json": json.dumps(
                    [
                        {"role": "user", "content": "Tinh hinh MCK-LPS"},
                        {"role": "assistant", "content": "Dang on dinh"},
                    ],
                    ensure_ascii=False,
                ),
                "turn_count": 8,
                "expires_at": self.service._session_expiry(),
            }
        )

        with patch.object(
            type(self.service),
            "_call_summarise_memory",
            autospec=True,
            return_value="Nguoi dung hay hoi budget va tinh hinh project MCK-LPS.",
        ):
            self.service._maybe_update_long_term_memory(self.link, session)

        self.link.invalidate_recordset()
        session.invalidate_recordset()

        self.assertEqual(self.link.long_term_summary, "Nguoi dung hay hoi budget va tinh hinh project MCK-LPS.")
        self.assertEqual(session.turn_count, 0)
