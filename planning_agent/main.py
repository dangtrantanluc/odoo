from app.agents.planning_agent import PlanningAgent


def main():
    project_description = """
    Build internal PM chatbot for company.

    Features:
    - Users check in daily through GAPO
    - Save worklog by project
    - Generate daily report
    - Remind users who have not updated
    - Detect blockers from worklog
    """

    agent = PlanningAgent()
    result = agent.generate(project_description)

    print("=== PLAN ===")
    print(result["plan"].model_dump_json(indent=2, ensure_ascii=False))

    print("\n=== VALIDATION ===")
    if result["is_valid"]:
        print("Valid plan")
    else:
        for error in result["errors"]:
            print("-", error)


if __name__ == "__main__":
    main()