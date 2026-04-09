import json
import logging
import time

import requests

from .intent_parser import extract_summary_time


_logger = logging.getLogger(__name__)
_ALLOWED_INTENTS = {
    "help",
    "today_summary",
    "all_tasks",
    "my_tasks",
    "overdue_tasks",
    "project_status",
    "project_tasks",
    "project_budget",
    "project_blockers",
    "projects_at_risk",
    "portfolio_summary",
    "summary_on",
    "summary_off",
    "clear_context",
}
_ALLOWED_PERIODS = {"today", "yesterday", "this_week", "this_month", "current", None}
_ALLOWED_CONFIDENCE = {"high", "medium", "low"}


class AgentLoopExhausted(RuntimeError):
    pass


def _clean_json_text(raw_text):
    text = (raw_text or "").strip()
    if text.startswith("```"):
        parts = text.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("{") and part.endswith("}"):
                return part
            if "\n" in part:
                candidate = part.split("\n", 1)[1].strip()
                if candidate.startswith("{") and candidate.endswith("}"):
                    return candidate
    return text


def _post_chat_completion(base_url, model, api_key, temperature, timeout, messages, tools=None):
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    response = requests.post(
        url,
        json={
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": 500,
        },
        headers=headers,
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"].strip()


def _post_chat_completion_raw(base_url, model, api_key, temperature, timeout, messages, tools=None):
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 700,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    response = requests.post(
        url,
        json=payload,
        headers=headers,
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    choice = (data.get("choices") or [{}])[0]
    message = dict(choice.get("message") or {})
    message["_finish_reason"] = choice.get("finish_reason")
    return message


def run_agent_loop(
    base_url,
    model,
    api_key,
    temperature,
    timeout,
    messages,
    tools,
    tool_executor,
    max_iterations=5,
):
    started_at = time.monotonic()
    time_budget = max(float(timeout or 0), 1.0) * 0.9
    working_messages = list(messages or [])
    last_assistant_content = None

    for _iteration in range(max_iterations):
        elapsed = time.monotonic() - started_at
        remaining = max(time_budget - elapsed, 0.0)
        if remaining <= 0:
            break

        assistant_message = _post_chat_completion_raw(
            base_url=base_url,
            model=model,
            api_key=api_key,
            temperature=temperature,
            timeout=max(1, int(remaining)),
            messages=working_messages,
            tools=tools,
        )
        assistant_entry = {
            "role": "assistant",
            "content": assistant_message.get("content") or "",
        }
        tool_calls = assistant_message.get("tool_calls") or []
        if tool_calls:
            assistant_entry["tool_calls"] = tool_calls
        working_messages.append(assistant_entry)

        if assistant_entry["content"]:
            last_assistant_content = assistant_entry["content"]

        if not tool_calls:
            reply_text = (assistant_entry["content"] or "").strip()
            if reply_text:
                return reply_text, working_messages[1:] if working_messages and working_messages[0].get("role") == "system" else working_messages
            break

        for tool_call in tool_calls:
            function_data = tool_call.get("function") or {}
            tool_name = function_data.get("name")
            raw_arguments = function_data.get("arguments") or "{}"
            try:
                tool_args = json.loads(raw_arguments)
                if not isinstance(tool_args, dict):
                    tool_args = {}
            except Exception:
                tool_args = {}
                tool_result = {"error": "Invalid tool arguments"}
            else:
                tool_result = tool_executor(tool_name, tool_args)

            working_messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.get("id"),
                    "name": tool_name,
                    "content": json.dumps(tool_result, ensure_ascii=False),
                }
            )

    if last_assistant_content:
        return last_assistant_content, working_messages[1:] if working_messages and working_messages[0].get("role") == "system" else working_messages
    raise AgentLoopExhausted("Agent loop exhausted before producing a final reply")


def _normalize_classifier_payload(parsed):
    if not isinstance(parsed, dict):
        return None

    intent = parsed.get("intent")
    if intent not in _ALLOWED_INTENTS:
        return None

    project_ref = parsed.get("project_ref")
    if project_ref is not None:
        project_ref = str(project_ref).strip() or None

    period = parsed.get("period")
    if period not in _ALLOWED_PERIODS:
        period = None

    confidence = parsed.get("confidence")
    if confidence not in _ALLOWED_CONFIDENCE:
        confidence = "medium"

    return {
        "intent": intent,
        "project_ref": project_ref,
        "period": period,
        "confidence": confidence,
        "summary_time": extract_summary_time(parsed.get("summary_time")) if parsed.get("summary_time") is not None else None,
        "classification_source": "llm",
    }


def classify_intent(
    base_url,
    model,
    api_key,
    temperature,
    timeout,
    text,
    session_context=None,
    rule_based_guess=None,
    project_candidates=None,
):
    session_context = session_context or {}
    rule_based_guess = rule_based_guess or {}
    project_candidates = project_candidates or []
    prompt = (
        "Phan loai cau hoi Telegram cho tro ly quan ly du an.\n"
        "Muc tieu la hieu dung nghia cua cau noi tu nhien, khong chi dua vao tu khoa.\n"
        "Chi tra ve JSON hop le, khong giai thich them.\n"
        "Schema:\n"
        '{"intent":"help|today_summary|all_tasks|my_tasks|overdue_tasks|project_status|project_tasks|project_budget|project_blockers|projects_at_risk|portfolio_summary|summary_on|summary_off|clear_context","project_ref":"project code hoac project name|null","period":"today|yesterday|this_week|this_month|current|null","summary_time":"HH:MM|null","confidence":"high|medium|low"}\n'
        "Quy tac:\n"
        "- Neu nguoi dung nhac den mot du an cu the, uu tien tra ve intent lien quan den du an do.\n"
        "- Neu nguoi dung noi 'du an do', 'no', 'cai do', co the dung session context de suy ra.\n"
        "- Neu project khop voi danh sach candidate, tra ve ma hoac ten dung voi candidate do.\n"
        "- Neu nguoi dung muon hen gio gui tong hop/bao cao tien do, dat intent='summary_on' va summary_time theo dinh dang HH:MM.\n"
        "- Neu cau hoi mo ho, khong du thong tin, hoac nam ngoai cac intent ho tro, tra ve intent='help'.\n"
        f"Rule-based guess: {json.dumps(rule_based_guess, ensure_ascii=True)}\n"
        f"Session context: {json.dumps(session_context, ensure_ascii=True)}\n"
        f"Project candidates: {json.dumps(project_candidates, ensure_ascii=True)}\n"
        f"User text: {text}\n"
    )

    try:
        raw_text = _post_chat_completion(
            base_url=base_url,
            model=model,
            api_key=api_key,
            temperature=temperature,
            timeout=timeout,
            messages=[
                {
                    "role": "system",
                    "content": "Ban la bo phan route intent cho tro ly PM. Chi duoc tra ve JSON hop le.",
                },
                {"role": "user", "content": prompt},
            ],
        )
        parsed = json.loads(_clean_json_text(raw_text))
        return _normalize_classifier_payload(parsed)
    except Exception:
        _logger.exception("Failed to classify Telegram intent with self-hosted LLM")
        return None


def rewrite_reply(base_url, model, api_key, temperature, timeout, parsed, payload, fallback_text):
    prompt = (
        "Viet lai cau tra loi Telegram bang tieng Viet, ngan gon, ro rang, khong bịa them du lieu.\n"
        f"Intent: {json.dumps(parsed, ensure_ascii=True)}\n"
        f"Payload: {json.dumps(payload, ensure_ascii=True)}\n"
        f"Fallback: {fallback_text}\n"
    )

    try:
        return _post_chat_completion(
            base_url=base_url,
            model=model,
            api_key=api_key,
            temperature=temperature,
            timeout=timeout,
            messages=[
                {
                    "role": "system",
                    "content": "Ban la tro ly PM noi bo. Tra loi bang tieng Viet, ngan gon, dung du lieu duoc cung cap.",
                },
                {"role": "user", "content": prompt},
            ],
        )
    except Exception:
        _logger.exception("Failed to rewrite Telegram reply with self-hosted LLM")
        return fallback_text
