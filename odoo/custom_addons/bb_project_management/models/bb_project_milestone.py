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
    company_id = fields.Many2one('res.company', related='project_id.company_id', store=True)
    description = fields.Text(string='Description')
    due_date = fields.Date(string='Due Date', tracking=True)

    status = fields.Selection([
        ('draft',       'Draft'),
        ('in_progress', 'In Progress'),
        ('done',        'Done'),
        ('cancelled',   'Cancelled'),
    ], string='Status', default='draft', tracking=True, index=True)

    task_ids = fields.One2many('bb.project.task', 'milestone_id', string='Tasks')
    scope_ids = fields.One2many('bb.project.scope', 'milestone_id', string='Scope Items')

    task_count = fields.Integer(string='Tasks', compute='_compute_task_stats', store=True)
    done_count = fields.Integer(string='Done', compute='_compute_task_stats', store=True)
    completion_pct = fields.Integer(string='Completion %', compute='_compute_task_stats', store=True)

    currency_id = fields.Many2one('res.currency', related='project_id.currency_id', store=True)
    estimated_hours = fields.Float(
        string='Est. Hours', compute='_compute_estimation', store=True,
    )
    estimated_cost = fields.Monetary(
        string='Est. Cost', currency_field='currency_id',
        compute='_compute_estimation', store=True,
    )

    # ── Computed fields ───────────────────────────────────────────────────────

    @api.depends('scope_ids.estimated_hours', 'scope_ids.estimated_cost')
    def _compute_estimation(self):
        for rec in self:
            rec.estimated_hours = sum(rec.scope_ids.mapped('estimated_hours'))
            rec.estimated_cost = sum(rec.scope_ids.mapped('estimated_cost'))

    @api.depends('task_ids', 'task_ids.status')
    def _compute_task_stats(self):
        for rec in self:
            total = len(rec.task_ids)
            done = len(rec.task_ids.filtered(lambda t: t.status == 'done'))
            rec.task_count = total
            rec.done_count = done
            rec.completion_pct = round(done / total * 100) if total else 0

    # ── Status transitions ────────────────────────────────────────────────────

    def _write_status(self, status):
        self.write({'status': status})

    def action_set_in_progress(self):
        self._write_status('in_progress')

    def action_set_done(self):
        self._write_status('done')

    def action_set_cancelled(self):
        self._write_status('cancelled')

    def action_reopen(self):
        self._write_status('draft')

    # ── Navigation ────────────────────────────────────────────────────────────

    def action_view_tasks(self):
        self.ensure_one()
        return {
            'type': 'ir.actions.act_window',
            'name': f'Tasks — {self.name}',
            'res_model': 'bb.project.task',
            'view_mode': 'tree,kanban,form',
            'domain': [('milestone_id', '=', self.id)],
            'context': {
                'default_milestone_id': self.id,
                'default_project_id': self.project_id.id,
            },
        }
