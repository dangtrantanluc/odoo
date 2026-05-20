from langchain_core.prompts import ChatPromptTemplate


planning_prompt = ChatPromptTemplate.from_messages([
    ("system", "You are a strict startup project planning agent. Output JSON only."),
    ("human", """
Create a simple project planning draft.

Rules:
- Create MVP-first epics.
- Each task must be 0.5 to 2 days.
- If task is bigger than 2 days, split it.
- Each task must have clear output.
- Add dependencies only when necessary.
- Output valid JSON only.

Project description:
{project_description}

JSON schema:
{{
  "project_name": "string",
  "summary": "string",
  "epics": [
    {{
      "name": "string",
      "description": "string",
      "tasks": [
        {{
          "title": "string",
          "description": "string",
          "estimate_days": 1,
          "priority": "P0",
          "role": "backend",
          "output": "string"
        }}
      ]
    }}
  ],
  "dependencies": [
    {{
      "before": "string",
      "after": "string",
      "reason": "string"
    }}
  ],
  "risks": ["string"],
  "questions": ["string"]
}}
""")
])