# -*- coding: utf-8 -*-
from odoo import models, fields, api


class BbProjectMilestone(models.Model):
    _name = 'bb.project.milestone'
    _description = 'BB Project Milestone'
    _order = 'deadline, name'

    name = fields.Char(string='Milestone Name', required=True)
    project_id = fields.Many2one(
        'bb.project', string='Project', required=True, ondelete='cascade', index=True,
    )
    deadline = fields.Date(string='Deadline')
    is_done = fields.Boolean(string='Completed', default=False)
    description = fields.Text(string='Description')

    task_ids = fields.One2many(
        'bb.project.task', 'milestone_id', string='Tasks',
    )
    task_count = fields.Integer(
        string='Task Count', compute='_compute_task_count', store=True,
    )

    @api.depends('task_ids')
    def _compute_task_count(self):
        for rec in self:
            rec.task_count = len(rec.task_ids)

    def action_mark_done(self):
        self.write({'is_done': True})

    def action_reset(self):
        self.write({'is_done': False})
