# -*- coding: utf-8 -*-
from odoo import models, fields


class BbProjectTag(models.Model):
    _name = 'bb.project.tag'
    _description = 'BB Project Tag'
    _order = 'name'

    name = fields.Char(string='Tag Name', required=True)
    color = fields.Integer(string='Color Index', default=0)

    project_ids = fields.Many2many(
        'bb.project', 'bb_project_tag_rel', 'tag_id', 'project_id',
        string='Projects',
    )
    task_ids = fields.Many2many(
        'bb.project.task', 'bb_project_task_tag_rel', 'tag_id', 'task_id',
        string='Tasks',
    )

    _sql_constraints = [
        ('name_uniq', 'UNIQUE(name)', 'Tag name must be unique.'),
    ]
