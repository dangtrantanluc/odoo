"""Planning Agent — đa lượt hội thoại sinh kế hoạch dự án.

Flow: /plan → COLLECTING_BRIEF → LLM sinh PlanDraft → DRAFT_REVIEW (sửa lặp)
→ "ok" → materialize Project + Milestone + Task + Scope.
"""
