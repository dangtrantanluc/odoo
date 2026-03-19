# -*- coding: utf-8 -*-
from odoo import models, fields, api


class BbProjectScope(models.Model):
    _name = 'bb.project.scope'
    _description = 'BB Project Backlog Item'
    _order = 'sequence, id'

    sequence = fields.Integer(default=10)
    project_id = fields.Many2one(
        'bb.project', string='Project', required=True, ondelete='cascade', index=True,
    )
    company_id = fields.Many2one(
        'res.company', related='project_id.company_id', store=True,
    )
    currency_id = fields.Many2one(
        'res.currency', related='project_id.currency_id', store=True,
    )

    name = fields.Char(string='Task Description', required=True)
    assignee_id = fields.Many2one('res.users', string='Planned Assignee')
    estimated_hours = fields.Float(string='Est. Hours', digits=(6, 2))
    estimated_rate = fields.Monetary(
        string='Rate/Hour', currency_field='currency_id',
        help='Cost per hour — auto-filled from member rate when assignee is selected',
    )
    estimated_cost = fields.Monetary(
        string='Est. Cost', currency_field='currency_id',
        compute='_compute_cost', store=True,
    )
    milestone_id = fields.Many2one(
        'bb.project.milestone', string='Milestone', ondelete='set null', index=True,
        domain="[('project_id', '=', project_id)]",
    )
    description = fields.Html(string='Description')
    task_id = fields.Many2one(
        'bb.project.task', string='Linked Task', readonly=True,
        help='Task created from this scope item',
    )

    @api.depends('estimated_hours', 'estimated_rate')
    def _compute_cost(self):
        for rec in self:
            rec.estimated_cost = rec.estimated_hours * (rec.estimated_rate or 0.0)

    @api.onchange('assignee_id')
    def _onchange_assignee(self):
        """Auto-fill rate from the member's current hourly rate."""
        if self.assignee_id and self.project_id:
            member = self.env['bb.project.member'].search([
                ('project_id', '=', self.project_id._origin.id),
                ('user_id', '=', self.assignee_id.id),
            ], limit=1)
            if member and member.current_rate:
                self.estimated_rate = member.current_rate

    def action_create_task(self):
        """Convert this scope item into an actual bb.project.task."""
        self.ensure_one()
        task = self.env['bb.project.task'].create({
            'name': self.name,
            'project_id': self.project_id.id,
            'assignee_id': self.assignee_id.id if self.assignee_id else False,
            'milestone_id': self.milestone_id.id if self.milestone_id else False,
        })
        self.task_id = task
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'bb.project.task',
            'res_id': task.id,
            'view_mode': 'form',
            'target': 'current',
        }
