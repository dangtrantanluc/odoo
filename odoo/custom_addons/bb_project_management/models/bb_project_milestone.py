# -*- coding: utf-8 -*-
from odoo import models, fields, api


class BbProjectMilestone(models.Model):
    _name = 'bb.project.milestone'
    _description = 'BB Project Milestone'
    _order = 'due_date, name'
    _inherit = ['mail.thread']

    name = fields.Char(string='Milestone', required=True, tracking=True)
    project_id = fields.Many2one(
        'bb.project', string='Project', required=True, ondelete='cascade', index=True,
    )
    company_id = fields.Many2one(
        'res.company', related='project_id.company_id', store=True,
    )
    description = fields.Text(string='Description')
    due_date = fields.Date(string='Due Date', tracking=True)
    status = fields.Selection([
        ('draft',       'Draft'),
        ('in_progress', 'In Progress'),
        ('done',        'Done'),
        ('cancelled',   'Cancelled'),
    ], string='Status', default='draft', tracking=True, index=True)

    task_ids = fields.One2many(
        'bb.project.task', 'milestone_id', string='Tasks',
    )
    task_count = fields.Integer(
        string='Tasks', compute='_compute_task_stats', store=True,
    )
    done_count = fields.Integer(
        string='Done', compute='_compute_task_stats', store=True,
    )
    completion_pct = fields.Integer(
        string='Completion %', compute='_compute_task_stats', store=True,
    )

    @api.depends('task_ids', 'task_ids.status')
    def _compute_task_stats(self):
        for rec in self:
            total = len(rec.task_ids)
            done = len(rec.task_ids.filtered(lambda t: t.status == 'done'))
            rec.task_count = total
            rec.done_count = done
            rec.completion_pct = round((done / total * 100)) if total else 0

    def action_set_in_progress(self):
        self.write({'status': 'in_progress'})

    def action_set_done(self):
        self.write({'status': 'done'})

    def action_set_cancelled(self):
        self.write({'status': 'cancelled'})

    def action_reopen(self):
        self.write({'status': 'draft'})

    def action_view_tasks(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': f'Tasks — {self.name}',
            'res_model': 'bb.project.task',
            'view_mode': 'tree,kanban,form',
            'domain': [('milestone_id', '=', self.id)],
            'context': {'default_milestone_id': self.id, 'default_project_id': self.project_id.id},
        }
