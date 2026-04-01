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
        const user = useService("user");

        this.state = useState({
            loading: true,
            isManager: false,
            projects: { total: 0, planned: 0, in_progress: 0, on_hold: 0, completed: 0, cancelled: 0 },
            tasks: { total: 0, todo: 0, in_progress: 0, review: 0, done: 0 },
            backlogs: { pending: 0, approved: 0, rejected: 0 },
            budget: { total: 0, spent: 0, remaining: 0 },
            userHours: { total_approved: 0 }
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

        this.setTimeFilter = (filter) => {
            this.state.timeFilter = filter;
            this.state.loading = true;
            this.loadData();
        };

        this.loadData = async () => {
            try {
                let isManager = await user.hasGroup("bbsw_project_management.group_bb_pm_manager");
                if (!isManager) {
                    isManager = await user.hasGroup("bb_project_management.group_bb_pm_manager");
                }
                
                let projectDomain = [];
                let taskDomain = [];
                let backlogDomain = [];

                // Time Filter Logic
                if (this.state.timeFilter !== 'all') {
                    const now = new Date();
                    let startDate;
                    if (this.state.timeFilter === 'month') {
                        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    } else if (this.state.timeFilter === 'week') {
                        const day = now.getDay() || 7; // Get current day number, converting Sun. to 7
                        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
                    }
                    if (startDate) {
                        const dateStr = startDate.toISOString().split('T')[0];
                        projectDomain.push(['create_date', '>=', dateStr + ' 00:00:00']);
                        taskDomain.push(['create_date', '>=', dateStr + ' 00:00:00']);
                        backlogDomain.push(['work_date', '>=', dateStr]);
                    }
                }

                if (!isManager) {
                    taskDomain.push(['assignee_id', '=', user.userId]);
                    backlogDomain.push(['user_id', '=', user.userId]);
                }

                const [projectGroups, taskGroups, backlogGroups] = await Promise.all([
                    orm.call("bb.project", "read_group", [projectDomain, ["status"], ["status"]]),
                    orm.call("bb.project.task", "read_group", [taskDomain, ["status"], ["status"]]),
                    orm.call("bb.project.backlog", "read_group", [backlogDomain, ["status"], ["status"]]),
                ]);

                let budgetData = [];
                let userApprovedHours = 0;
                let topCustomers = [];

                if (isManager) {
                    budgetData = await orm.call("bb.project", "read_group", [projectDomain, ["budget", "total_cost", "budget_remaining"], []]);
                    
                    // Fetch funding sources (budget by customer)
                    const custData = await orm.call("bb.project", "read_group", [projectDomain, ["budget"], ["customer_id"]]);
                    custData.sort((a,b) => b.budget - a.budget);
                    
                    const totalBudget = budgetData.length ? budgetData[0].budget : 0;
                    topCustomers = custData.slice(0, 5).map(c => ({
                        name: c.customer_id ? c.customer_id[1] : 'Internal / Unknown',
                        budget: c.budget,
                        percent: totalBudget ? Math.round((c.budget / totalBudget) * 100) : 0
                    }));
                } else {
                    const userLogs = await orm.call("bb.project.backlog", "read_group", [
                        [['user_id', '=', user.userId], ['status', '=', 'approved'], ...backlogDomain], 
                        ["hours"], 
                        []
                    ]);
                    if (userLogs.length > 0) {
                        userApprovedHours = userLogs[0].hours || 0;
                    }
                }

                const projects = { total: 0, planned: 0, in_progress: 0, on_hold: 0, completed: 0, cancelled: 0 };
                for (const g of projectGroups) {
                    const key = g.status;
                    if (key in projects) { projects[key] = g.status_count; }
                    projects.total += g.status_count;
                }

                const tasks = { total: 0, todo: 0, in_progress: 0, review: 0, done: 0 };
                for (const g of taskGroups) {
                    const key = g.status;
                    if (key in tasks) { tasks[key] = g.status_count; }
                    tasks.total += g.status_count;
                }

                const backlogs = { pending: 0, approved: 0, rejected: 0 };
                for (const g of backlogGroups) {
                    const key = g.status;
                    if (key in backlogs) { backlogs[key] = g.status_count; }
                }

                const budget = { total: 0, spent: 0, remaining: 0 };
                if (isManager && budgetData.length) {
                    budget.total = budgetData[0].budget || 0;
                    budget.spent = budgetData[0].total_cost || 0;
                    budget.remaining = budgetData[0].budget_remaining || 0;
                }

                const userHours = { total_approved: userApprovedHours };

                Object.assign(this.state, { loading: false, isManager, projects, tasks, backlogs, budget, userHours, topCustomers });
            } catch (e) {
                console.error("Dashboard DB error:", e);
                notification.add("Could not load dashboard data from the server. Check permissions.", {
                    type: "danger",
                    title: "Data Loading Error"
                });
                this.state.loading = false;
            }
        };

        onMounted(() => {
            this.loadData();
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
