Enum Role { ADMIN MANAGER MEMBER VIEWER }
Enum ProjectStatus { PLANNED IN_PROGRESS ON_HOLD COMPLETED CANCELLED }
Enum TaskStatus { TODO IN_PROGRESS REVIEW DONE }
Enum Priority { LOW MEDIUM HIGH URGENT }
Enum BacklogStatus { PENDING APPROVED REJECTED }
Enum BlockerSeverity { LOW MED HIGH }
Enum ChannelKind { gapo slack zalo zalouser telegram email sms }
Enum FollowUpStatus { PENDING REPLIED EXPIRED CANCELLED }
Enum MeetingItemStatus { DRAFT APPROVED REJECTED }
Enum AgentAuditSource { chat cron cli other }

Table _prisma_migrations {
  id varchar(36) [pk]
  checksum varchar(64) [not null]
  finished_at timestamptz
  migration_name varchar(255) [not null]
  logs text
  rolled_back_at timestamptz
  started_at timestamptz [not null]
  applied_steps_count int [not null]
}

Table currencies {
  id int [pk, increment]
  code text [not null, unique]
  symbol text [not null]
  rate decimal(20,6) [not null]
}

Table companies {
  id int [pk, increment]
  name text [not null]
  code text [unique]
  currency_id int [not null]
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table users {
  id int [pk, increment]
  email text [not null, unique]
  password_hash text [not null]
  full_name text [not null]
  avatar_url text
  lang text [not null]
  timezone text [not null]
  role Role [not null]
  company_id int [not null]
  active boolean [not null]
  is_super_admin boolean [not null]
  last_login_at timestamp
  created_at timestamp [not null]
  updated_at timestamp [not null]
  department text
  position text
}

Table refresh_tokens {
  id int [pk, increment]
  user_id int [not null]
  token_hash text [not null, unique]
  expires_at timestamp [not null]
  revoked_at timestamp
  created_at timestamp [not null]
}

Table notifications {
  id int [pk, increment]
  user_id int [not null]
  type text [not null]
  title text [not null]
  message text
  link text
  read_at timestamp
  created_at timestamp [not null]
}

Table customers {
  id int [pk, increment]
  name text [not null]
  email text
  phone text
  address text
  tax_code text
  notes text
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table projects {
  id int [pk, increment]
  name text [not null]
  code text [unique]
  status ProjectStatus [not null]
  priority Priority [not null]
  start_date date
  end_date date
  description text
  budget decimal(18,2)
  estimated_total_cost decimal(18,2)
  estimated_total_hours double
  total_cost decimal(18,2) [not null]
  total_hours double [not null]
  budget_remaining decimal(18,2)
  task_count int [not null]
  member_count int [not null]
  backlog_count int [not null]
  scope_count int [not null]
  milestone_count int [not null]
  owner_id int [not null]
  company_id int [not null]
  customer_id int
  account_manager_id int
  currency_id int
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table tasks {
  id int [pk, increment]
  name text [not null]
  status TaskStatus [not null]
  priority Priority [not null]
  deadline date
  end_at date
  description text
  result text
  issues text
  total_cost decimal(18,2) [not null]
  total_hours double [not null]
  project_id int [not null]
  company_id int
  assignee_id int
  milestone_id int
  currency_id int
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table members {
  id int [pk, increment]
  project_id int [not null]
  user_id int [not null]
  role text
  joined_at timestamp [not null]
  created_at timestamp [not null]
  updated_at timestamp [not null]

  indexes {
    (project_id, user_id) [unique]
  }
}

Table member_rates {
  id int [pk, increment]
  member_id int [not null]
  project_id int
  user_id int
  currency_id int
  effective_from date [not null]
  effective_to date
  cost_per_hour decimal(18,2) [not null]
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table milestones {
  id int [pk, increment]
  name text [not null]
  status text
  due_date date
  description text
  task_count int [not null]
  done_count int [not null]
  completion_pct int [not null]
  project_id int [not null]
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table scopes {
  id int [pk, increment]
  sequence int [not null]
  name text [not null]
  notes text
  estimated_hours decimal(8,2)
  estimated_rate decimal(18,2)
  estimated_cost decimal(18,2)
  project_id int [not null]
  task_id int
  assignee_id int
  currency_id int
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table backlogs {
  id int [pk, increment]
  status BacklogStatus [not null]
  work_date date [not null]
  description text
  hours decimal(6,2) [not null]
  cost_per_hour_snapshot decimal(18,2)
  total_cost_snapshot decimal(18,2)
  task_id int [not null]
  project_id int
  company_id int
  user_id int [not null]
  currency_id int
  approver_id int
  approved_at timestamp
  rejected_reason text
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table tags {
  id int [pk, increment]
  name text [not null, unique]
  color int
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table project_tags {
  project_id int [pk]
  tag_id int [pk]
}

Table task_tags {
  task_id int [pk]
  tag_id int [pk]
}

Table gapo_user_maps {
  id int [pk, increment]
  user_id int [not null, unique]
  gapo_user_id bigint [not null]
  gapo_thread_id bigint [not null]
  gapo_full_name text
  last_seen_at timestamp [not null]
  created_at timestamp [not null]
}

Table channel_identities {
  id int [pk, increment]
  user_id int [not null]
  channel ChannelKind [not null]
  external_id text [not null]
  external_name text
  thread_id text
  preferred boolean [not null]
  last_seen_at timestamp [not null]
  created_at timestamp [not null]
  updated_at timestamp [not null]

  indexes {
    (channel, external_id) [unique]
  }
}

Table agent_audit_log {
  id int [pk, increment]
  tool text [not null]
  args_json jsonb [not null]
  result_json jsonb
  error_message text
  duration_ms int
  correlation_id text
  source AgentAuditSource [not null]
  created_at timestamp [not null]
}

Table agent_memory {
  id int [pk, increment]
  company_id int [not null]
  conversation_id text
  source AgentAuditSource [not null]
  user_text text [not null]
  reply_text text [not null]
  summary text [not null]
  tools_used jsonb [not null]
  project_ids int[]
  task_ids int[]
  correlation_id text
  created_at timestamp [not null]
}

Table task_blockers {
  id int [pk, increment]
  task_id int [not null]
  severity BlockerSeverity [not null]
  description text [not null]
  resolved_at timestamp
  created_at timestamp [not null]
}

Table agent_follow_ups {
  id int [pk, increment]
  task_id int [not null]
  user_id int [not null]
  channel ChannelKind [not null]
  thread_id text
  question text [not null]
  status FollowUpStatus [not null]
  asked_at timestamp [not null]
  replied_at timestamp
  reply_text text
  correlation_id text
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table meetings {
  id int [pk, increment]
  company_id int [not null]
  project_id int
  title text
  held_at timestamp [not null]
  transcript text [not null]
  summary text
  decisions jsonb [not null]
  participants text[]
  created_by_id int
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table meeting_action_items {
  id int [pk, increment]
  meeting_id int [not null]
  title text [not null]
  description text
  owner_name text
  owner_user_id int
  due_date date
  priority Priority [not null]
  status MeetingItemStatus [not null]
  created_task_id int
  created_at timestamp [not null]
  updated_at timestamp [not null]
}

Table automations {
  id int [pk, increment]
  name text [not null]
  workflow text [not null]
  schedule text [not null]
  inputs jsonb [not null]
  target text
  active boolean [not null]
  owner_id int [not null]
  company_id int [not null]
  created_at timestamp [not null]
  updated_at timestamp [not null]
  last_run_at timestamp
  last_run_status text
  last_run_error text
  consecutive_fails int [not null]
}

Ref: companies.currency_id > currencies.id
Ref: users.company_id > companies.id
Ref: refresh_tokens.user_id > users.id
Ref: notifications.user_id > users.id

Ref: projects.owner_id > users.id
Ref: projects.account_manager_id > users.id
Ref: projects.company_id > companies.id
Ref: projects.customer_id > customers.id
Ref: projects.currency_id > currencies.id

Ref: tasks.project_id > projects.id
Ref: tasks.company_id > companies.id
Ref: tasks.assignee_id > users.id
Ref: tasks.milestone_id > milestones.id
Ref: tasks.currency_id > currencies.id

Ref: members.project_id > projects.id
Ref: members.user_id > users.id
Ref: member_rates.member_id > members.id
Ref: member_rates.project_id > projects.id
Ref: member_rates.currency_id > currencies.id

Ref: milestones.project_id > projects.id
Ref: scopes.project_id > projects.id
Ref: scopes.task_id > tasks.id
Ref: scopes.assignee_id > users.id
Ref: scopes.currency_id > currencies.id

Ref: backlogs.task_id > tasks.id
Ref: backlogs.project_id > projects.id
Ref: backlogs.company_id > companies.id
Ref: backlogs.user_id > users.id
Ref: backlogs.approver_id > users.id
Ref: backlogs.currency_id > currencies.id

Ref: project_tags.project_id > projects.id
Ref: project_tags.tag_id > tags.id
Ref: task_tags.task_id > tasks.id
Ref: task_tags.tag_id > tags.id

Ref: gapo_user_maps.user_id > users.id
Ref: channel_identities.user_id > users.id

Ref: task_blockers.task_id > tasks.id
Ref: agent_follow_ups.task_id > tasks.id
Ref: agent_follow_ups.user_id > users.id

Ref: meetings.project_id > projects.id
Ref: meeting_action_items.meeting_id > meetings.id

Ref: automations.owner_id > users.id
Ref: automations.company_id > companies.id
