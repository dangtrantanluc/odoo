/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { ListController } from "@web/views/list/list_controller";
import { RelationalModel } from "@web/model/relational_model/relational_model";
import { useService } from "@web/core/utils/hooks";
import { useState, onWillStart, onWillUpdateProps, onMounted, onWillUnmount } from "@odoo/owl";

const BBSW_MODEL = "bbsw.thuchi.record";
const BUS_EVENT = "BBSW:THUCHI_RELOADED";

function formatVND(value) {
    if (!value) return "0 ₫";
    return new Intl.NumberFormat("vi-VN", {
        style: "currency",
        currency: "VND",
        maximumFractionDigits: 0,
    }).format(value);
}

function getDateRange(period) {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (period === "this_week") {
        const day = today.getDay() || 7;
        const mon = new Date(today); mon.setDate(today.getDate() - day + 1);
        const sun = new Date(today); sun.setDate(today.getDate() - day + 7);
        return [fmt(mon), fmt(sun)];
    }
    if (period === "this_month") {
        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        return [fmt(first), fmt(last)];
    }
    if (period === "last_month") {
        const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const last = new Date(today.getFullYear(), today.getMonth(), 0);
        return [fmt(first), fmt(last)];
    }
    if (period === "this_quarter") {
        const q = Math.floor(today.getMonth() / 3);
        const first = new Date(today.getFullYear(), q * 3, 1);
        const last = new Date(today.getFullYear(), q * 3 + 3, 0);
        return [fmt(first), fmt(last)];
    }
    if (period === "this_year") {
        return [`${today.getFullYear()}-01-01`, `${today.getFullYear()}-12-31`];
    }
    return null;
}

// Patch RelationalModel: emit event sau mỗi lần load
patch(RelationalModel.prototype, {
    async load(...args) {
        const result = await super.load(...args);
        if (this.config?.resModel === BBSW_MODEL) {
            this.env.bus.trigger(BUS_EVENT);
        }
        return result;
    },
});

// Patch ListController
patch(ListController.prototype, {
    setup() {
        super.setup(...arguments);

        // Ẩn nút New mặc định
        if (this.activeActions && this.props.resModel === BBSW_MODEL) {
            this.activeActions.create = false;
        }

        if (this.props.resModel !== BBSW_MODEL) return;

        const orm = useService("orm");
        const actionService = useService("action");
        const kpi = useState({ thu: 0, chi: 0, con_lai: 0, loaded: false });
        const filterState = useState({
            timeLabel: "Tháng này",
            stateLabel: "Tất cả",
            typeLabel: "Tất cả",
            showTimeDD: false,
            showStateDD: false,
            showTypeDD: false,
            showCustom: false,
            customFrom: "",
            customTo: "",
        });

        // Expose lên template qua this
        this.kpi = kpi;
        this.filterState = filterState;
        this._formatVND = formatVND;

        const filterDomains = { time: [], state: [], type: [] };

        const applyDomain = (key, domain) => {
            filterDomains[key] = domain;
            const extra = [
                ...filterDomains.time,
                ...filterDomains.state,
                ...filterDomains.type,
            ];
            const base = this.props.domain || [];
            // Reload model trực tiếp với domain mới
            this.model.load({ domain: [...base, ...extra] });
        };

        const loadKpi = async () => {
            const domain = this.props.domain || [];
            const res = await orm.call(BBSW_MODEL, "get_kpi_totals", [domain]);
            kpi.thu = res.tong_thu;
            kpi.chi = res.tong_chi;
            kpi.con_lai = res.con_lai;
            kpi.loaded = true;
        };

        onWillStart(loadKpi);
        onWillUpdateProps(loadKpi);

        const handler = () => loadKpi();
        onMounted(() => this.env.bus.addEventListener(BUS_EVENT, handler));
        onWillUnmount(() => this.env.bus.removeEventListener(BUS_EVENT, handler));

        // Tạo phiếu
        this.createWithType = async (type) => {
            await actionService.doAction({
                type: "ir.actions.act_window",
                res_model: BBSW_MODEL,
                views: [[false, "form"]],
                target: "current",
                context: { default_type: type },
            });
        };

        // Toggle dropdown
        this.toggleDropdown = (which) => {
            const keys = ["showTimeDD", "showStateDD", "showTypeDD"];
            keys.forEach((k) => {
                filterState[k] = k === which ? !filterState[k] : false;
            });
        };

        // Lọc thời gian
        this.applyTimeFilter = (period, label) => {
            filterState.showTimeDD = false;
            if (period === "custom") {
                filterState.showCustom = true;
                return;
            }
            filterState.showCustom = false;
            filterState.timeLabel = label;
            if (period === "all") {
                applyDomain("time", []);
                return;
            }
            const [from, to] = getDateRange(period);
            applyDomain("time", [["date", ">=", from], ["date", "<=", to]]);
        };

        this.applyCustomTime = () => {
            if (!filterState.customFrom || !filterState.customTo) return;
            filterState.timeLabel = `${filterState.customFrom} → ${filterState.customTo}`;
            filterState.showCustom = false;
            applyDomain("time", [["date", ">=", filterState.customFrom], ["date", "<=", filterState.customTo]]);
        };

        // Lọc trạng thái
        this.applyStateFilter = (state, label) => {
            filterState.showStateDD = false;
            filterState.stateLabel = label;
            applyDomain("state", state === "all" ? [] : [["state", "=", state]]);
        };

        // Lọc loại phiếu
        this.applyTypeFilter = (type, label) => {
            filterState.showTypeDD = false;
            filterState.typeLabel = label;
            applyDomain("type", type === "all" ? [] : [["type", "=", type]]);
        };

    },
});
