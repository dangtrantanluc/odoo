/** @odoo-module **/

import { Many2ManyBinaryField } from "@web/views/fields/many2many_binary/many2many_binary_field";
import { registry } from "@web/core/registry";

class Many2ManyBinaryPreviewField extends Many2ManyBinaryField {}

Many2ManyBinaryPreviewField.template = "bbsw_thuchi.Many2ManyBinaryPreviewField";

registry.category("fields").add("many2many_binary_preview", Many2ManyBinaryPreviewField);
