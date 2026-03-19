/** @odoo-module */

import { registry } from "@web/core/registry";

/**
 * Workspace Navigation Service
 *
 * - Overrides the navbar hamburger (home menu toggle) to redirect back
 *   to the BBSW Workspace (/project/home) with a smooth fade-out.
 * - Adds a fade-in entrance animation when the Odoo backend first loads.
 */
const workspaceNavService = {
    start() {
        // ── Entrance animation ──────────────────────────────────
        // Fade-in the action manager area on first load
        const style = document.createElement('style');
        style.textContent = `
            @keyframes bbFadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to   { opacity: 1; transform: translateY(0); }
            }
            .o_action_manager.bb-entrance {
                animation: bbFadeIn 0.45s cubic-bezier(0.4, 0, 0.2, 1) both;
                animation-delay: 0.08s;
            }
            .bb-workspace-exit {
                position: fixed;
                inset: 0;
                z-index: 99999;
                background: #fff;
                opacity: 0;
                transition: opacity 0.38s ease;
                pointer-events: none;
            }
            .bb-workspace-exit.active {
                opacity: 1;
                pointer-events: all;
            }
        `;
        document.head.appendChild(style);

        // Apply entrance animation to action manager
        requestAnimationFrame(() => {
            const am = document.querySelector('.o_action_manager');
            if (am) {
                am.classList.add('bb-entrance');
                // Remove after animation completes
                setTimeout(() => am.classList.remove('bb-entrance'), 600);
            }
        });

        // ── Hamburger → Workspace redirect ──────────────────────
        // Use capture-phase listener to intercept before OWL handles it
        document.addEventListener('click', (e) => {
            const toggle = e.target.closest('.o_menu_toggle');
            if (!toggle) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // Create fade-out overlay
            const overlay = document.createElement('div');
            overlay.className = 'bb-workspace-exit';
            document.body.appendChild(overlay);

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    overlay.classList.add('active');
                });
            });

            setTimeout(() => {
                window.location.href = '/project/home';
            }, 400);
        }, true); // capture phase
    },
};

registry.category("services").add("workspace_nav", workspaceNavService);
