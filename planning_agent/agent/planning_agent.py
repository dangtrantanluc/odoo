import json
from app.llm.openrouter_client import OpenRouterClient
from app.prompts.planning_prompt import planning_prompt
from app.models.planning import PlanningDraft
from app.validators.planning_validator import PlanningValidator


class PlanningAgent:
    def __init__(self):
        self.llm = OpenRouterClient().get_llm()
        self.validator = PlanningValidator()
        self.chain = planning_prompt | self.llm

    def generate(self, project_description: str) -> dict:
        response = self.chain.invoke({
            "project_description": project_description
        })

        content = self._clean_json(response.content)
        data = json.loads(content)

        plan = PlanningDraft(**data)
        errors = self.validator.validate(plan)

        return {
            "plan": plan,
            "errors": errors,
            "is_valid": len(errors) == 0,
        }

    def _clean_json(self, content: str) -> str:
        content = content.strip()

        if content.startswith("```json"):
            content = content.replace("```json", "").replace("```", "").strip()
        elif content.startswith("```"):
            content = content.replace("```", "").strip()

        return content