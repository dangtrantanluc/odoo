# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an **Odoo 17.0** deployment for BBSW (a Vietnamese company) with a custom module for income/expense management ("Thu Chi"). The project uses Docker Compose to run Odoo + PostgreSQL.

## Running the Stack

```bash
# Start all services
docker compose up -d

# View logs
docker compose logs -f web

# Restart Odoo (e.g., after module changes)
docker compose restart web

# Stop everything
docker compose down
```

- Odoo web UI: http://localhost:8069
- Active database: **`bb_test_db`** (configured via `-d bb_test_db` in docker-compose.yaml `command:`)
- PostgreSQL: localhost:5432 (user: admin, password: admin123)
- Custom homepage route: `/project/home` (requires login, auto-redirects after login)

> **Note:** The `project_management` database exists but has a broken schema — do not use it. The working database is `bb_test_db`.

## Installing / Updating the Custom Module

After making changes to `project_addons/bbsw_thuchi`:

```bash
docker compose exec web odoo -d bb_test_db --db_host db --db_user admin --db_password admin123 \
  --addons-path=/usr/lib/python3/dist-packages/odoo/addons,/mnt/extra-addons \
  -u bbsw_thuchi --stop-after-init
```

Then restart: `docker compose up -d`

For static files (CSS/JS), a plain restart is sufficient — no module update needed.

## Linting

The `odoo/ruff.toml` contains Odoo's official ruff config. To lint the custom module Python files:

```bash
cd /home/bbsw/odoo/odoo
ruff check ../project_addons/bbsw_thuchi
```

## Architecture

### Directory Structure

```
/home/bbsw/odoo/
├── docker-compose.yaml          # Orchestrates db (postgres:16) + web (odoo:17.0)
├── init/                        # SQL scripts run at DB init (postgres entrypoint)
├── odoo/                        # Full Odoo 17 community source (reference + ruff config)
├── project_addons/              # Mounted as /mnt/extra-addons in container
│   └── bbsw_thuchi/             # The custom Odoo module
└── redesign/                    # Static HTML/CSS/JS prototype of the homepage UI
```

### Custom Module: `bbsw_thuchi`

Located in `project_addons/bbsw_thuchi/`. Depends on: `base`, `mail`, `hr`, `hr_attendance`.

> **Important:** `website` and `hr_payroll` are intentionally excluded — `hr_payroll` is Enterprise-only and `website` was broken in the active DB. The homepage template is a **standalone HTML page** (not using `website.layout`), and the controller uses `auth='user'` without `website=True`.

**Models:**
- `bbsw.thuchi.category` — Income/Expense categories with `type` field (`thu`/`chi`)
- `bbsw.thuchi.record` — Individual transaction records with state machine (`draft` ↔ `confirmed` / `cancelled`), inherits `mail.thread` for chatter. `amount` must be > 0.
- `bbsw.home.app` — Configurable launcher tiles on the homepage; each has `name`, `url`, `icon` (selection), `gradient` (selection), `sequence`, `active`, and optional `groups_id` for access control. Default tiles seeded from `data/default_apps.xml`.

**Key constraint:** `category_id` domain is filtered by `type` — a "thu" record can only use "thu" categories. This is enforced via `@api.onchange` and the domain in the view.

**Controller:** `controllers/main.py` — two routes:
- `/project/home` — renders the app-switcher dashboard (`bbsw_thuchi.project_homepage_template`)
- `/` — redirects to `/project/home` (overrides Odoo's default root)
- Also overrides `_login_redirect` so after login users land on `/project/home`

**Frontend assets** (`static/src/`):
- `thuchi_homepage.css` / `thuchi_homepage.js` — referenced directly in the standalone template (not via Odoo asset bundles)
- Bootstrap 5.3 loaded from CDN in the template
- The `redesign/` folder is a standalone HTML prototype (not served by Odoo) used as a design reference

### Odoo Module Conventions (this version)

- Views use `<tree>` (not `<list>`) in arch XML — this build of Odoo 17 does not accept `list` as `ir.ui.view.type`
- `view_mode` in actions uses `tree,form` (not `list,form`) for the same reason
- Views are XML in `views/` — tree, form, search, and menu definitions
- Access rights in `security/ir.model.access.csv` — currently all authenticated users have full CRUD on all models
- `__manifest__.py` declares dependencies and data files loaded in order (no `assets` key — CSS/JS linked directly in template)
- The module version is `17.0.2.0.0`
