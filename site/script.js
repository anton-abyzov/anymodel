// Terminal typing effect
function typeTerminal() {
  const el = document.getElementById('terminal-typed');
  if (!el) return;
  const lines = [
    '$ ANTHROPIC_BASE_URL=https://anymodel-proxy.anton-abyzov.workers.dev claude',
    '',
    '\u2713 Claude Code connected \u2014 using free models via anymodel proxy',
    '',
    '$ Or run locally:',
    '$ npx anymodel --model google/gemini-2.5-flash:free'
  ];
  const text = lines.join('\n');
  let i = 0;
  el.textContent = '';
  el.style.visibility = 'visible';

  function tick() {
    if (i <= text.length) {
      el.textContent = text.slice(0, i);
      i++;
      setTimeout(tick, i === 1 ? 0 : text[i - 2] === '\n' ? 100 : 22);
    }
  }
  tick();
}

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

document.addEventListener('DOMContentLoaded', () => {
  typeTerminal();
  initPathTabs();
  initScrollAnimations();
  initSmoothScroll();
  initCopyButtons();
  initNavScroll();
});
