from typing import List
from pydantic import BaseModel, Field


class Task(BaseModel):
    title: str
    description: str
    estimate_days: float = Field(..., ge=0.5, le=2)
    priority: str
    role: str
    output: str


class Epic(BaseModel):
    name: str
    description: str
    tasks: List[Task]


class Dependency(BaseModel):
    before: str
    after: str
    reason: str


class PlanningDraft(BaseModel):
    project_name: str
    summary: str
    epics: List[Epic]
    dependencies: List[Dependency]
    risks: List[str]
    questions: List[str]