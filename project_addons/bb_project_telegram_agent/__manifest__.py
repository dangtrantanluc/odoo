# -*- coding: utf-8 -*-
{
    "name": "BB Project Telegram Agent",
    "version": "17.0.1.0.0",
    "category": "Project",
    "summary": "Telegram bot for BB Project Management",
    "author": "BlueBolt Software",
    "license": "LGPL-3",
    "depends": ["base", "mail", "bb_project_management"],
    "data": [
        "security/bb_project_telegram_security.xml",
        "security/ir.model.access.csv",
        "data/ir_cron.xml",
    ],
    "installable": True,
    "application": False,
    "auto_install": False,
}
