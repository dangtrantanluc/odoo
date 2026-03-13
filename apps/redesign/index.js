document.addEventListener('DOMContentLoaded', () => {
    // Add a simple animation effect when clicking the menu toggle
    const menuToggle = document.getElementById('menuToggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', () => {
            menuToggle.style.transform = 'scale(0.9)';
            setTimeout(() => {
                menuToggle.style.transform = 'scale(1)';
            }, 150);
        });
    }

    // Add subtle entrance animation to app items
    const appItems = document.querySelectorAll('.app-item');
    appItems.forEach((item, index) => {
        item.style.opacity = '0';
        item.style.transform = 'translateY(15px)';
        item.style.transition = 'opacity 0.4s ease, transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
        
        // Stagger the animation
        setTimeout(() => {
            item.style.opacity = '1';
            item.style.transform = 'translateY(0)';
            
            // Revert inline styles to allow hover effects to work after entrance
            setTimeout(() => {
                item.style.opacity = '';
                item.style.transform = '';
            }, 400);
        }, 50 * index);
    });
});
