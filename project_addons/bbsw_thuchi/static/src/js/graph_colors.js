/** @odoo-module */
import { GraphRenderer } from "@web/views/graph/graph_renderer";
import { patch } from "@web/core/utils/patch";

function colorForLabel(label) {
    const l = (label || "").toLowerCase();
    if (l.includes("thu")) return { bg: "#22c55e", border: "#16a34a" };
    if (l.includes("vay")) return { bg: "#3b82f6", border: "#1d4ed8" };
    if (l.includes("chi") || l.includes("hoàn")) return { bg: "#ef4444", border: "#dc2626" };
    return null;
}

patch(GraphRenderer.prototype, {
    getChartConfig() {
        const config = super.getChartConfig();
        if (!config.data) return config;

        const chartType = config.type; // "bar", "line", "pie", "doughnut"

        if (chartType === "pie" || chartType === "doughnut") {
            // Pie: một dataset, màu theo từng segment dựa vào labels
            const labels = config.data.labels || [];
            for (const dataset of config.data.datasets || []) {
                const bgColors = [];
                const bdColors = [];
                labels.forEach((lbl) => {
                    const c = colorForLabel(lbl);
                    bgColors.push(c ? c.bg : null);
                    bdColors.push(c ? c.border : null);
                });
                // Chỉ ghi đè nếu có ít nhất 1 màu tùy chỉnh
                if (bgColors.some(Boolean)) {
                    // Giữ màu gốc Odoo cho segment không match
                    const origBg = Array.isArray(dataset.backgroundColor)
                        ? dataset.backgroundColor
                        : [];
                    dataset.backgroundColor = bgColors.map((c, i) => c || origBg[i] || "#94a3b8");
                    dataset.borderColor = bdColors.map((c, i) => c || origBg[i] || "#64748b");
                }
            }
        } else {
            // Bar / Line: mỗi dataset có label riêng
            for (const dataset of config.data.datasets || []) {
                const c = colorForLabel(dataset.label);
                if (c) {
                    dataset.backgroundColor = c.bg;
                    dataset.borderColor = c.border;
                }
            }
        }

        return config;
    },
});
