/** @odoo-module **/
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { Component, useState, useRef } from "@odoo/owl";
import { markup } from "@odoo/owl";

const SESSION_KEY = "bb_ai_session_id";

/**
 * Convert simple markdown to safe HTML for chat bubbles.
 * Supports: **bold**, *italic*, `code`, bullet lists, numbered lists, line breaks.
 */
function markdownToHtml(text) {
    if (!text) return "";
    let html = text
        // Escape HTML entities first
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        // Bold **text**
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        // Italic *text*
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        // Inline code `code`
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        // Bullet lists: lines starting with • or - or *
        .replace(/^[•\-\*] (.+)$/gm, "<li>$1</li>")
        // Numbered lists: lines starting with 1. 2. etc
        .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
        // Wrap consecutive <li> in <ul>
        .replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`)
        // Double newline → paragraph break
        .replace(/\n\n/g, "</p><p>")
        // Single newline → <br>
        .replace(/\n/g, "<br/>");
    return `<p>${html}</p>`;
}

function getOrCreateSessionId() {
    let sid = localStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = `odoo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        localStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

class BbAiChat extends Component {
    static template = "bb_project_management.AiChat";

    setup() {
        this.rpc = useService("rpc");
        this._sessionId = getOrCreateSessionId();
        this.messagesRef = useRef("messages");

        this.state = useState({
            open: false,
            messages: [],
            input: "",
            thinking: false,
        });
    }

    toggleChat() {
        this.state.open = !this.state.open;
        if (this.state.open && this.state.messages.length === 0) {
            const greeting =
                "Hello! / Xin chào! I'm **BB AI Assistant**.\n\n" +
                "You can ask me about:\n" +
                "• Project list, tasks, members / Danh sách dự án, task, thành viên\n" +
                "• Upcoming deadlines / Deadline sắp đến hạn\n" +
                "• Budget alerts / Cảnh báo ngân sách\n" +
                "• Scope cost estimates / Ước tính chi phí scope\n\n" +
                "Ask anything to get started! / Hỏi ngay để bắt đầu!";
            this._pushAssistant(greeting);
        }
    }

    async sendMessage() {
        const question = this.state.input.trim();
        if (!question || this.state.thinking) return;

        this.state.messages.push({ role: "user", content: question });
        this.state.input = "";
        this.state.thinking = true;
        this._scrollToBottom();

        try {
            const result = await this.rpc("/web/bb_pm_agent/ask", {
                question,
                session_id: this._sessionId,
            });
            const answer = result.answer || "No answer received. / Không có câu trả lời.";
            this._pushAssistant(answer, !!result.error);
        } catch {
            this._pushAssistant("Connection error. Please check agent service. / Lỗi kết nối.", true);
        } finally {
            this.state.thinking = false;
            this._scrollToBottom();
        }
    }

    onKeyDown(ev) {
        if (ev.key === "Enter" && !ev.shiftKey) {
            ev.preventDefault();
            this.sendMessage();
        }
    }

    clearHistory() {
        const newSid = `odoo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        localStorage.setItem(SESSION_KEY, newSid);
        this._sessionId = newSid;
        this.state.messages = [];
        this._pushAssistant("History cleared. / Đã xóa lịch sử. Ask me anything! / Hỏi tôi bất cứ điều gì về dự án!");
    }

    _pushAssistant(content, error = false) {
        this.state.messages.push({
            role: "assistant",
            content,
            html: markup(markdownToHtml(content)),
            error,
        });
    }

    _scrollToBottom() {
        setTimeout(() => {
            const el = this.messagesRef.el;
            if (el) el.scrollTop = el.scrollHeight;
        }, 50);
    }
}

registry.category("main_components").add("BbAiChat", { Component: BbAiChat });
