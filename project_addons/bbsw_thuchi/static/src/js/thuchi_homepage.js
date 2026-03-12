document.addEventListener('DOMContentLoaded', () => {

    // ── App entrance animation ────────────────────────────────
    const apps = document.querySelectorAll('.hp-app');
    apps.forEach((item, i) => {
        item.style.opacity = '0';
        item.style.transform = 'scale(0.92)';
        item.style.transition = 'opacity 0.3s ease, transform 0.3s cubic-bezier(0.34,1.56,0.64,1)';
        setTimeout(() => {
            item.style.opacity = '1';
            item.style.transform = 'scale(1)';
            setTimeout(() => {
                item.style.opacity = '';
                item.style.transform = '';
                item.style.transition = '';
            }, 350);
        }, 30 * i);
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
