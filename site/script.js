// Terminal content is now static HTML — no typing animation needed
function typeTerminal() {}

// Path tabs
function initPathTabs() {
  document.querySelectorAll('.path-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const group = tab.closest('.paths-container');
      if (!group) return;
      const id = tab.getAttribute('data-path');
      group.querySelectorAll('.path-tab').forEach((t) => t.classList.remove('active'));
      group.querySelectorAll('.path-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = group.querySelector('.path-panel[data-path="' + id + '"]');
      if (panel) panel.classList.add('active');
    });
  });
}

// Fade-in on scroll
function initScrollAnimations() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -60px 0px' }
  );
  document.querySelectorAll('.fade-in').forEach((el) => observer.observe(el));
}

// Smooth scroll for anchor links
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (target) {
        e.preventDefault();
        const navH = document.querySelector('.nav')?.offsetHeight || 0;
        const y = target.getBoundingClientRect().top + window.pageYOffset - navH - 16;
        window.scrollTo({ top: y, behavior: 'smooth' });
      }
    });
  });
}

// Copy to clipboard for code blocks
function initCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-copy');
      navigator.clipboard.writeText(code).then(() => {
        const prev = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  });
}

// Nav scroll effect
function initNavScroll() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        nav.style.borderBottomColor = window.scrollY > 50
          ? 'rgba(255,255,255,0.06)'
          : 'transparent';
        ticking = false;
      });
      ticking = true;
    }
  });
}

// Theme toggle
function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  // Check saved preference or system preference
  const saved = localStorage.getItem('anymodel-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');

  document.documentElement.setAttribute('data-theme', theme);
  updateIcon(btn, theme);

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('anymodel-theme', next);
    updateIcon(btn, next);
  });

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('anymodel-theme')) {
      const t = e.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', t);
      updateIcon(btn, t);
    }
  });
}

function updateIcon(btn, theme) {
  btn.innerHTML = theme === 'dark'
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
}

document.addEventListener('DOMContentLoaded', () => {
  typeTerminal();
  initPathTabs();
  initScrollAnimations();
  initSmoothScroll();
  initCopyButtons();
  initNavScroll();
  initThemeToggle();
});
