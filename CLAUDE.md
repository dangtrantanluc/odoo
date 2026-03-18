# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Odoo 17 Community custom module — **BB Project Management** (`bb_project_management`) — a standalone project management application for BlueBolt. Deployed via Docker Compose.

---

## Module Locations (Important)

There are **two copies** of the module:

| Path | Version | Status |
|---|---|---|
| `odoo/custom_addons/bb_project_management/` | v1.0 — standalone models (`bb.project`, `bb.project.task`) | **Active** — mounted by docker-compose |
| `custom_addons/bb_project_management/` | v2.0 — inheriting `project.project`/`project.task` | In progress / incomplete |

`docker-compose.yaml` mounts **`./odoo/custom_addons`** → `/mnt/extra-addons`. To switch to the v2 path, change that volume line.

---

## Docker Commands

# Start all services
docker compose up -d

# Stop web only (required before manual odoo-bin commands)
docker compose stop web

# Install module on a fresh DB
docker compose run --rm web odoo -d odoo -i bb_project_management --stop-after-init

# Upgrade module after code changes
docker compose run --rm web odoo -d odoo -u bb_project_management --stop-after-init

# Run module tests
docker compose run --rm web odoo -d odoo --test-tags bb_project_management --stop-after-init

# Restart web after config/view changes
docker compose restart web

# View live logs
docker compose logs -f web
```

> **Always `docker compose stop web` before running `docker compose run --rm web odoo ...`** — concurrent access causes DB deadlocks.

---

## Database

PostgreSQL is in container `project_management_db`. Credentials: user `admin`, password `admin123`.

| Database | Purpose |
|---|---|
| `odoo` | Active Odoo instance |
| `bb_test_db` | Legacy standalone-model version (v1 reference) |
| `project_management` | Default postgres container DB |

To drop and recreate `odoo` for a clean install:
```bash
docker exec project_management_db psql -U admin -d project_management -c "DROP DATABASE odoo"
docker exec project_management_db psql -U admin -d project_management -c "CREATE DATABASE odoo OWNER admin"
```

Odoo connects using `config/odoo.conf`. Set `db_name = odoo` there to lock to one DB; `db_name = False` allows selecting via URL (`?db=odoo`).

---

## Module Architecture (v1 — active)

### Model Graph

```
bb.project  ──── bb.project.member  ──── bb.project.member.rate
    │                                         (hourly rate history)
    ├── bb.project.task ──── bb.project.backlog
    │                             (work logs, pending→approved/rejected)
    ├── bb.project.milestone
    └── bb.project.tag  (M2M)
```

All models live in `odoo/custom_addons/bb_project_management/models/`.

### Key Data Flows

**Cost snapshot on backlog creation** (`bb_project_backlog.py` → `create()`):
When a work log is saved, `cost_per_hour_snapshot` is auto-populated from the member's current rate (`bb.project.member.current_rate`), which reads the most-recent `bb.project.member.rate` record for that user/project combination.

**Financial rollup** (`bb_project.py` → `_compute_financials()`):
`total_cost` and `total_hours` on `bb.project` are computed from all *approved* backlogs across all tasks, stored on the project for fast display.

**Status machines:**
- Project: `planned → in_progress → on_hold / completed / cancelled`, reopens to `in_progress`
- Task: `todo → in_progress → review → done`, reversible
- Backlog: `pending → approved / rejected`, admin-only, resettable to `pending`

### Security Groups

Defined in `security/bb_project_security.xml`:

| Group | Key permissions |
|---|---|
| `group_bb_pm_admin` | Full access + approve/reject backlogs |
| `group_bb_pm_manager` | Create/edit projects, tasks, members (implies admin) |
| `group_bb_pm_member` | Log own backlogs, update task status (own backlogs only via record rule) |
| `group_bb_pm_viewer` | Read-only |

### Dashboard

`static/src/js/dashboard.js` — OWL component registered as action `bb_project_dashboard`. Uses `orm.call()` with `read_group` (4 parallel calls on mount) to populate KPI cards. Template: `static/src/xml/dashboard.xml`. Styles: `static/src/scss/dashboard.scss`. Currency hardcoded to VND in `_formatCurrency()`.

---

## View Strategy

Views are **standalone** (not inheriting standard Odoo views) to keep the BB Project app isolated. Each model has: search, list/tree, kanban, form views, all declared in `views/`. Actions use `view_ids` to pin specific view records.

---

## Known Issues / Gotchas

- `raise models.ValidationError(...)` in `bb_project.py` should be `from odoo.exceptions import ValidationError` — currently works but is non-standard.
- `_compute_counts()` in `bb_project.py` uses `sum(len(t.backlog_ids) for t in rec.task_ids)` — N+1 pattern for large datasets.
- When adding new fields with `domain` referencing `company_id` on a view, Odoo 17 requires `<field name="company_id" column_invisible="1"/>` (or `invisible="1"` in forms) to be present in that view — even if company_id isn't displayed.
- `demo data` tags (in `bb_project_demo.xml`) must not use names already created by the `project` module's own demo data (e.g. "Bug" conflicts with `project.tags` unique constraint).

---

## i18n

Vietnamese translation file: `i18n/vi_VN.po`. Update with:
```bash
docker compose run --rm web odoo -d odoo --i18n-export=vi_VN --modules=bb_project_management --stop-after-init
```
