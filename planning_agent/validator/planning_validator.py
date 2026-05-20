from typing import List
from app.models.planning import PlanningDraft


class PlanningValidator:
    VALID_PRIORITIES = {"P0", "P1", "P2"}

    def validate(self, plan: PlanningDraft) -> List[str]:
        errors = []
        task_titles = set()

        for epic in plan.epics:
            if not epic.tasks:
                errors.append(f"Epic '{epic.name}' has no tasks.")

            for task in epic.tasks:
                task_titles.add(task.title)

                if task.estimate_days > 2:
                    errors.append(f"Task too large: {task.title}")

                if not task.output.strip():
                    errors.append(f"Task has no output: {task.title}")

                if task.priority not in self.VALID_PRIORITIES:
                    errors.append(f"Invalid priority in task: {task.title}")

        for dep in plan.dependencies:
            if dep.before not in task_titles:
                errors.append(f"Dependency before not found: {dep.before}")

            if dep.after not in task_titles:
                errors.append(f"Dependency after not found: {dep.after}")

            if dep.before == dep.after:
                errors.append(f"Self dependency: {dep.before}")

        return errors