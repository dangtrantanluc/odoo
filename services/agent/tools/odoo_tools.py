from langchain.tools import tool
from pydantic import BaseModel, Field
from typing import Optional

class ProjectInfoInput(BaseModel):
    project_ref: str = Field(description="Name of project or ID of project. For example: 'PM', 'PRJ-001;")
    query_type: str = Field(description="Type of infomation to be retrieved: 'status', 'budget', 'tasks', 'members', 'all'" )
    limit_days: Optional[int] = Field(default=30, description="The most recent time period (number of days) to filter data is set to 30 days by default.")

    @tool(args_schema=ProjectInfoInput)
    def get_hybrid_project_report(project_ref: str, query_type: str, limit_days: int):        
        """
        Retrieved directly into Postgress to get report of the project
        """
        find_id_sql = "SELECT id, name FROM bb.project WHERE name ILIKE %s LIMIT 1"
        if query_type == 'status':
            data_sql="""
            SELECT t.name, t.date_deadline, s.name as stage 
            FROM bb.task t
            JOIN bb.task_stage s ON t.stage_id = s.id
            WHERE t.project_id = %s AND t.date_deadline < NOW() + interval '%s days'
            """
        return result_data