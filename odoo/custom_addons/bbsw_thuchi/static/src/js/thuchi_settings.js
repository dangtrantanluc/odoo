/** @odoo-module **/

import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component } from "@odoo/owl";

class ThuChiSettings extends Component {
    static template = "bbsw_thuchi.SettingsPage";

    setup() {
        this.action = useService("action");
    }

    openAction(xmlId) {
        this.action.doAction(xmlId);
    }
}

registry.category("actions").add("bbsw_thuchi_settings_action", ThuChiSettings);
