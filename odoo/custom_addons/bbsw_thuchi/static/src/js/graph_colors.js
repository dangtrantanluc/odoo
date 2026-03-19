/** @odoo-module */
import { GraphRenderer } from "@web/views/graph/graph_renderer";
import { patch } from "@web/core/utils/patch";

patch(GraphRenderer.prototype, {
    getChartConfig() {
        const config = super.getChartConfig();
        if (config.data && config.data.datasets) {
            for (const dataset of config.data.datasets) {
                const label = (dataset.label || "").toLowerCase();
                if (label.includes("thu")) {
                    dataset.backgroundColor = "#22c55e";
                    dataset.borderColor = "#16a34a";
                } else if (label.includes("chi") || label.includes("vay") || label.includes("hoàn")) {
                    dataset.backgroundColor = "#ef4444";
                    dataset.borderColor = "#dc2626";
                }
            }
        }
        return config;
    },
});
