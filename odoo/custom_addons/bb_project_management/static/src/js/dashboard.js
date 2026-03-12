/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, onMounted, useState } from "@odoo/owl";

class BbProjectDashboard extends Component {
    static template = "bb_project_management.Dashboard";

    setup() {
        const orm = useService("orm");
        const action = useService("action");
        const notification = useService("notification");

        this.state = useState({
            loading: true,
            projects: { total: 0, planned: 0, in_progress: 0, on_hold: 0, completed: 0, cancelled: 0 },
            tasks: { total: 0, todo: 0, in_progress: 0, review: 0, done: 0 },
            backlogs: { pending: 0, approved: 0, rejected: 0 },
            budget: { total: 0, spent: 0, remaining: 0 },
        });

        this.openProjects = (domain) => {
            action.doAction({
                type: "ir.actions.act_window",
                name: "Projects",
                res_model: "bb.project",
                view_mode: "tree,form",
                domain: domain || [],
            });
        };

        this.openTasks = (domain) => {
            action.doAction({
                type: "ir.actions.act_window",
                name: "Tasks",
                res_model: "bb.project.task",
                view_mode: "tree,form",
                domain: domain || [],
            });
        };

        this.openBacklogs = (domain) => {
            action.doAction({
                type: "ir.actions.act_window",
                name: "Work Logs",
                res_model: "bb.project.backlog",
                view_mode: "tree,form",
                domain: domain || [],
            });
        };

        onMounted(async () => {
            try {
                // Modern Odoo 17/18/19 'orm' service instead of legacy raw RPC
                const [projectGroups, taskGroups, backlogGroups, budgetData] = await Promise.all([
                    orm.call("bb.project", "read_group", [[], ["status"], ["status"]]),
                    orm.call("bb.project.task", "read_group", [[], ["status"], ["status"]]),
                    orm.call("bb.project.backlog", "read_group", [[], ["status"], ["status"]]),
                    orm.call("bb.project", "read_group", [[], ["budget", "total_cost", "budget_remaining"], []]),
                ]);

                // Process projects
                const projects = { total: 0, planned: 0, in_progress: 0, on_hold: 0, completed: 0, cancelled: 0 };
                for (const g of projectGroups) {
                    const key = g.status;
                    if (key in projects) { projects[key] = g.status_count; }
                    projects.total += g.status_count;
                }

                // Process tasks
                const tasks = { total: 0, todo: 0, in_progress: 0, review: 0, done: 0 };
                for (const g of taskGroups) {
                    const key = g.status;
                    if (key in tasks) { tasks[key] = g.status_count; }
                    tasks.total += g.status_count;
                }

                // Process backlogs
                const backlogs = { pending: 0, approved: 0, rejected: 0 };
                for (const g of backlogGroups) {
                    const key = g.status;
                    if (key in backlogs) { backlogs[key] = g.status_count; }
                }

                // Process budget totals
                const budget = { total: 0, spent: 0, remaining: 0 };
                if (budgetData.length) {
                    budget.total = budgetData[0].budget || 0;
                    budget.spent = budgetData[0].total_cost || 0;
                    budget.remaining = budgetData[0].budget_remaining || 0;
                }

                Object.assign(this.state, { loading: false, projects, tasks, backlogs, budget });
            } catch (e) {
                console.error("Dashboard DB error:", e);
                notification.add("Could not load dashboard data from the server. Check permissions.", {
                    type: "danger",
                    title: "Data Loading Error"
                });
                this.state.loading = false;
            }
        });
    }

    _formatCurrency(value) {
        return new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: "VND",
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
        }).format(value || 0);
    }

    get budgetPercent() {
        if (!this.state.budget.total) return 0;
        return Math.min(100, Math.round((this.state.budget.spent / this.state.budget.total) * 100));
    }

    get taskDonePercent() {
        if (!this.state.tasks.total) return 0;
        return Math.round((this.state.tasks.done / this.state.tasks.total) * 100);
    }
}

registry.category("actions").add("bb_project_dashboard", BbProjectDashboard);
