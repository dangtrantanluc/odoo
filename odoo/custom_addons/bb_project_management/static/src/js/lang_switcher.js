/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, useState } from "@odoo/owl";
import { session } from "@web/session";

const SUPPORTED_LANGS = ["en_US", "vi_VN"];

class LangSwitcher extends Component {
    static template = "bb_project_management.LangSwitcher";

    setup() {
        this.orm = useService("orm");
        this.state = useState({
            currentLang: session.user_context?.lang || "en_US",
            loading: false,
        });
    }

    async switchLang() {
        if (this.state.loading) return;
        const currentIdx = SUPPORTED_LANGS.indexOf(this.state.currentLang);
        const nextLang = SUPPORTED_LANGS[(currentIdx + 1) % SUPPORTED_LANGS.length];
        this.state.loading = true;
        try {
            await this.orm.call("res.users", "write", [[session.uid], { lang: nextLang }]);
            // Reload page to apply new language
            window.location.reload();
        } catch {
            this.state.loading = false;
        }
    }
}

registry.category("systray").add("BbLangSwitcher", { Component: LangSwitcher }, { sequence: 1 });
