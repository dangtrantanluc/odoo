# -*- coding: utf-8 -*-
{
    'name': 'BB Project Management',
    'version': '17.0.1.0.0',
    'category': 'Project',
    'summary': 'End-to-end project management for BlueBolt',
    'description': """
        Complete project management solution:
        - Projects with budget, status, priority tracking
        - Tasks with Kanban workflow (TODO → IN_PROGRESS → REVIEW → DONE)
        - Project members with roles and hourly cost rates
        - Work-log (backlog) entries with PENDING → APPROVED/REJECTED flow
        - Milestones and tags for organisation
        - Security groups: Admin, Manager, Member, Viewer
        - Dashboard overview
    """,
    'author': 'BlueBolt',
    'website': 'https://bluebolt.com',
    'license': 'LGPL-3',
    'images': [],
    'depends': ['base', 'mail', 'hr'],
    'data': [
        'security/bb_project_security.xml',
        'security/ir.model.access.csv',
        'data/bb_project_data.xml',
        'data/bb_project_mock.xml',
        'views/bb_project_homepage_template.xml',
        'views/bb_project_dashboard_views.xml',
        'views/bb_project_tag_views.xml',
        'views/bb_project_member_views.xml',
        'views/bb_project_backlog_views.xml',
        'views/bb_project_scope_views.xml',
        'views/bb_project_task_views.xml',
        'views/bb_project_views.xml',
        'views/bb_user_profile_views.xml',
        'views/bb_project_milestone_views.xml',
        'views/bb_project_menus.xml',
        'views/hide_menus.xml',
    ],
    'demo': [
        'data/bb_project_demo.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'bb_project_management/static/src/scss/dashboard.scss',
            'bb_project_management/static/src/scss/ai_chat.scss',
            'bb_project_management/static/src/xml/dashboard.xml',
            'bb_project_management/static/src/xml/ai_chat.xml',
            'bb_project_management/static/src/js/dashboard.js',
            'bb_project_management/static/src/js/ai_chat.js',
            'bb_project_management/static/src/xml/lang_switcher.xml',
            'bb_project_management/static/src/js/lang_switcher.js',
            'bb_project_management/static/src/xml/avatar_upload.xml',
            'bb_project_management/static/src/js/avatar_upload.js',
            'bb_project_management/static/src/js/workspace_nav.js',
        ],
    },
    'installable': True,
    'application': True,
    'auto_install': False,
}
