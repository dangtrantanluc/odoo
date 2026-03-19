document.addEventListener('DOMContentLoaded', () => {

    const wrap = document.querySelector('.hp-wrap');
    const apps = document.querySelectorAll('.hp-app');

    // ── Entrance animation ──────────────────────────────────────
    // Add 'entering' class for brand/search/user-bar CSS animations
    if (wrap) wrap.classList.add('entering');

    // Stagger app icons entrance
    apps.forEach((item, i) => {
        item.style.opacity = '0';
        item.style.transform = 'scale(0.88) translateY(8px)';
        item.style.transition = 'opacity 0.35s ease, transform 0.4s cubic-bezier(0.34,1.56,0.64,1)';
        setTimeout(() => {
            item.style.opacity = '1';
            item.style.transform = 'scale(1) translateY(0)';
            setTimeout(() => {
                item.style.opacity = '';
                item.style.transform = '';
                item.style.transition = '';
            }, 450);
        }, 40 * i);
    });

    // Remove entering class after animations complete
    setTimeout(() => {
        if (wrap) wrap.classList.remove('entering');
    }, 40 * apps.length + 500);

    // ── Exit animation (click app → circle expand → navigate) ───
    apps.forEach(app => {
        app.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (!href || href === '#') return;

            e.preventDefault();

            // Mark this app as selected, trigger leaving state
            wrap.classList.remove('entering');
            wrap.classList.add('leaving');
            this.classList.add('selected');

            // Get icon center for circle origin
            const icon = this.querySelector('.hp-icon');
            const rect = icon.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            // Create circular reveal overlay
            const overlay = document.createElement('div');
            overlay.className = 'hp-transition';
            overlay.style.setProperty('--tx', cx + 'px');
            overlay.style.setProperty('--ty', cy + 'px');
            document.body.appendChild(overlay);

            // Trigger expansion (double rAF for reliable transition)
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    overlay.classList.add('active');
                });
            });

            // Navigate after animation
            setTimeout(() => {
                window.location.href = href;
            }, 500);
        });
    });

    // ── Search filter ─────────────────────────────────────────
    const input = document.getElementById('appSearch');
    const noResults = document.getElementById('noResults');

    if (input) {
        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            let visible = 0;
            apps.forEach(a => {
                const match = !q || (a.dataset.name || '').toLowerCase().includes(q);
                a.classList.toggle('hidden', !match);
                if (match) visible++;
            });
            if (noResults) noResults.style.display = visible === 0 ? 'flex' : 'none';
        });

        document.addEventListener('keydown', e => {
            if (e.key === '/' && document.activeElement !== input) {
                e.preventDefault();
                input.focus();
            }
            if (e.key === 'Escape' && document.activeElement === input) {
                input.value = '';
                input.dispatchEvent(new Event('input'));
                input.blur();
            }
        });
    }

});
