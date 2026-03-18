/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, useState, useRef } from "@odoo/owl";
import { session } from "@web/session";

class BbAvatarUpload extends Component {
    static template = "bb_project_management.AvatarUpload";

    setup() {
        this.notification = useService("notification");
        this.fileRef = useRef("fileInput");
        this.state = useState({
            uploading: false,
            avatarUrl: session.user_avatar_url || "",
        });
    }

    triggerPick() {
        this.fileRef.el?.click();
    }

    async onFileChange(ev) {
        const file = ev.target.files?.[0];
        if (!file) return;

        const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
        if (!allowed.includes(file.type)) {
            this.notification.add("Only JPEG, PNG, WEBP or GIF images are allowed.", { type: "warning" });
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            this.notification.add("File too large. Max 5 MB.", { type: "warning" });
            return;
        }

        this.state.uploading = true;
        const form = new FormData();
        form.append("avatar", file);

        try {
            const resp = await fetch("/web/bb_pm/avatar/upload", {
                method: "POST",
                body: form,
                headers: { "X-Requested-With": "XMLHttpRequest" },
            });
            const data = await resp.json();

            if (data.error) {
                this.notification.add(data.error, { type: "danger" });
            } else {
                this.state.avatarUrl = data.url;
                this.notification.add("Avatar updated successfully!", { type: "success" });
                // Refresh page after short delay so Odoo re-reads the field
                setTimeout(() => window.location.reload(), 1200);
            }
        } catch {
            this.notification.add("Upload failed. Check agent service.", { type: "danger" });
        } finally {
            this.state.uploading = false;
        }
    }
}

registry.category("main_components").add("BbAvatarUpload", { Component: BbAvatarUpload });
