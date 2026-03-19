/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, onMounted, useState } from "@odoo/owl";

// SVG donut chart radius & circumference
const R = 42, CIRC = 2 * Math.PI * R;

const CURRENCY = "VND";

function computeDonut(values, colors) {
    const total = values.reduce((s, v) => s + (v || 0), 0) || 1;
    let prior = 0;
    return values.map((count, i) => {
        const len = ((count || 0) / total) * CIRC;
        const seg = {
            count: count || 0,
            pct: Math.round(((count || 0) / total) * 100),
            color: colors[i],
            dasharray: `${len} ${CIRC}`,
            dashoffset: CIRC - prior,
        };
        prior += len;
        return seg;
    });
}

function fmtDate(d) {
    return d ? d.toISOString().split("T")[0] : null;
}

function getWeekRange() {
    const today = new Date();
    const day = today.getDay() || 7;
    const mon = new Date(today); mon.setDate(today.getDate() - day + 1);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { from: mon, to: sun };
}

function getMonthRange() {
    const t = new Date();
    return {
        from: new Date(t.getFullYear(), t.getMonth(), 1),
        to: new Date(t.getFullYear(), t.getMonth() + 1, 0),
    };
}

class BbProjectDashboard extends Component {
    static template = "bb_project_management.Dashboard";

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");

        this.state = useState({
            loading: true,
            filter: "month",   // week | month | custom | all
            dateFrom: "",
            dateTo: "",
            projects: { total: 0, planned: 0, in_progress: 0, on_hold: 0, completed: 0, cancelled: 0 },
            tasks: { total: 0, todo: 0, in_progress: 0, review: 0, done: 0 },
            backlogs: { pending: 0, approved: 0, rejected: 0, total_hours: 0 },
            budget: { total: 0, spent: 0, remaining: 0 },
            topProjects: [],
            tasksByPriority: { low: 0, medium: 0, high: 0, critical: 0 },
        });

        onMounted(() => this._load());
    }

    // ── date helpers ──────────────────────────────────────
    _getRange() {
        const f = this.state.filter;
        if (f === "week") return getWeekRange();
        if (f === "month") return getMonthRange();
        if (f === "custom") {
            return {
                from: this.state.dateFrom ? new Date(this.state.dateFrom) : null,
                to: this.state.dateTo ? new Date(this.state.dateTo) : null,
            };
        }
        return { from: null, to: null };
    }

    _buildDomain(dateField) {
        const { from, to } = this._getRange();
        const d = [];
        if (from) d.push([dateField, ">=", fmtDate(from)]);
        if (to)   d.push([dateField, "<=", fmtDate(to)]);
        return d;
    }

    // ── data loading ──────────────────────────────────────
    async _load() {
        this.state.loading = true;
        try {
            const backlogDomain = this._buildDomain("work_date");
            const projectDomain = this._buildDomain("start_date");

            const [pGroups, tGroups, tPrioGroups, bGroups, budgetData, topProjects] =
                await Promise.all([
                    this.orm.call("bb.project", "read_group",
                        [projectDomain, ["status"], ["status"]]),
                    this.orm.call("bb.project.task", "read_group",
                        [[], ["status"], ["status"]]),
                    this.orm.call("bb.project.task", "read_group",
                        [[], ["priority"], ["priority"]]),
                    this.orm.call("bb.project.backlog", "read_group",
                        [backlogDomain, ["status", "hours"], ["status"]]),
                    this.orm.call("bb.project", "read_group",
                        [[], ["budget", "total_cost", "budget_remaining"], []]),
                    this.orm.call("bb.project", "search_read",
                        [[["budget", ">", 0]],
                         ["name", "budget", "total_cost", "status"],
                         0, 6, "total_cost desc"]),
                ]);

            // projects
            const projects = { total: 0, planned: 0, in_progress: 0, on_hold: 0, completed: 0, cancelled: 0 };
            for (const g of pGroups) {
                if (g.status in projects) projects[g.status] = g.status_count;
                projects.total += g.status_count;
            }

            // tasks
            const tasks = { total: 0, todo: 0, in_progress: 0, review: 0, done: 0 };
            for (const g of tGroups) {
                if (g.status in tasks) tasks[g.status] = g.status_count;
                tasks.total += g.status_count;
            }

            // tasks by priority
            const tasksByPriority = { low: 0, medium: 0, high: 0, critical: 0 };
            for (const g of tPrioGroups) {
                if (g.priority in tasksByPriority) tasksByPriority[g.priority] = g.priority_count;
            }

            // backlogs
            const backlogs = { pending: 0, approved: 0, rejected: 0, total_hours: 0 };
            for (const g of bGroups) {
                if (g.status in backlogs) backlogs[g.status] = g.status_count;
                backlogs.total_hours += g.hours || 0;
            }

            // budget
            const budget = { total: 0, spent: 0, remaining: 0 };
            if (budgetData.length) {
                budget.total     = budgetData[0].budget || 0;
                budget.spent     = budgetData[0].total_cost || 0;
                budget.remaining = budgetData[0].budget_remaining || 0;
            }

            Object.assign(this.state, { loading: false, projects, tasks, backlogs, budget, topProjects, tasksByPriority });
        } catch (e) {
            console.error("Dashboard load error:", e);
            this.notification.add("Could not load dashboard data.", { type: "danger" });
            this.state.loading = false;
        }
    }

    // ── filter controls ───────────────────────────────────
    setFilter(f) {
        this.state.filter = f;
        if (f !== "custom") this._load();
    }

    applyCustom() {
        if (this.state.dateFrom && this.state.dateTo) this._load();
    }

    // ── chart data ────────────────────────────────────────
    get projectSegments() {
        const p = this.state.projects;
        return computeDonut(
            [p.planned, p.in_progress, p.on_hold, p.completed, p.cancelled],
            ["#adb5bd", "#4facfe", "#fee140", "#43e97b", "#f5576c"]
        );
    }

    get taskSegments() {
        const t = this.state.tasks;
        return computeDonut(
            [t.todo, t.in_progress, t.review, t.done],
            ["#adb5bd", "#4facfe", "#a18cd1", "#43e97b"]
        );
    }

    get backlogSegments() {
        const b = this.state.backlogs;
        return computeDonut(
            [b.pending, b.approved, b.rejected],
            ["#fee140", "#43e97b", "#f5576c"]
        );
    }

    get taskPriorityBars() {
        const tp = this.state.tasksByPriority;
        const max = Math.max(tp.critical, tp.high, tp.medium, tp.low, 1);
        return [
            { label: "Critical", count: tp.critical, color: "#f5576c", pct: Math.round((tp.critical / max) * 100) },
            { label: "High",     count: tp.high,     color: "#fa709a", pct: Math.round((tp.high / max) * 100) },
            { label: "Medium",   count: tp.medium,   color: "#4facfe", pct: Math.round((tp.medium / max) * 100) },
            { label: "Low",      count: tp.low,      color: "#adb5bd", pct: Math.round((tp.low / max) * 100) },
        ];
    }

    get budgetBars() {
        const max = Math.max(...(this.state.topProjects.map(p => p.budget || 0)), 1);
        return this.state.topProjects.map(p => ({
            name: p.name,
            budget: p.budget || 0,
            spent: p.total_cost || 0,
            status: p.status,
            spentPct: Math.round(Math.min(100, ((p.total_cost || 0) / (p.budget || 1)) * 100)),
            budgetPct: Math.round(((p.budget || 0) / max) * 100),
        }));
    }

    // ── computed ──────────────────────────────────────────
    get budgetPercent() {
        if (!this.state.budget.total) return 0;
        return Math.min(100, Math.round((this.state.budget.spent / this.state.budget.total) * 100));
    }

    get taskDonePercent() {
        if (!this.state.tasks.total) return 0;
        return Math.round((this.state.tasks.done / this.state.tasks.total) * 100);
    }

    // ── navigation ────────────────────────────────────────
    openProjects(domain) {
        this.action.doAction({ type: "ir.actions.act_window", name: "Projects",
            res_model: "bb.project", views: [[false, "list"], [false, "form"]], domain: domain || [] });
    }

    openTasks(domain) {
        this.action.doAction({ type: "ir.actions.act_window", name: "Tasks",
            res_model: "bb.project.task", views: [[false, "list"], [false, "form"]], domain: domain || [] });
    }

    openBacklogs(domain) {
        this.action.doAction({ type: "ir.actions.act_window", name: "Work Logs",
            res_model: "bb.project.backlog", views: [[false, "list"], [false, "form"]], domain: domain || [] });
    }

    // ── formatting ────────────────────────────────────────
    fmt(v) {
        return new Intl.NumberFormat(undefined, {
            style: "currency", currency: CURRENCY,
            minimumFractionDigits: 0, maximumFractionDigits: 0,
        }).format(v || 0);
    }
}

registry.category("actions").add("bb_project_dashboard", BbProjectDashboard);
