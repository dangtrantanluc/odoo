/** @odoo-module **/

import { Many2ManyBinaryField } from "@web/views/fields/many2many_binary/many2many_binary_field";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { onMounted, onWillUnmount } from "@odoo/owl";

patch(Many2ManyBinaryField.prototype, {
    setup() {
        super.setup(...arguments);

        const orm = useService("orm");
        const notification = useService("notification");

        const fileToBase64 = (file) =>
            new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(",")[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

        const doUpload = async (file) => {
            try {
                const b64 = await fileToBase64(file);
                const result = await orm.create("ir.attachment", [{
                    name: file.name || ("paste_" + Date.now()),
                    datas: b64,
                    res_model: this.props.record.resModel,
                    res_id: this.props.record.resId || 0,
                    mimetype: file.type || "application/octet-stream",
                }]);
                // orm.create trả về array [id] hoặc scalar id
                const attachId = Array.isArray(result) ? result[0] : result;
                await this.operations.saveRecord([attachId]);
            } catch (err) {
                console.error("Paste upload error:", err.message || err);
                notification.add("Lỗi: " + (err.message || "Không thể tải file lên"), { type: "danger" });
            }
        };

        const handlePaste = async (e) => {
            if (!e.clipboardData) return;
            const items = Array.from(e.clipboardData.items || []);
            const fileItems = items.filter((i) => i.kind === "file");
            if (!fileItems.length) return;
            e.preventDefault();
            for (const item of fileItems) {
                const file = item.getAsFile();
                if (file) await doUpload(file);
            }
        };

        const docPasteHandler = async (e) => {
            const tag = document.activeElement && document.activeElement.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            await handlePaste(e);
        };

        let pasteZone = null;

        onMounted(() => {
            document.addEventListener("paste", docPasteHandler);
            pasteZone = document.querySelector(".bbsw-paste-zone");
            if (pasteZone) {
                pasteZone.addEventListener("paste", handlePaste);
            }
        });

        onWillUnmount(() => {
            document.removeEventListener("paste", docPasteHandler);
            if (pasteZone) pasteZone.removeEventListener("paste", handlePaste);
        });
    },
});
