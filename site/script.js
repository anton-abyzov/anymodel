// Terminal typing effect
function typeTerminal() {
  const el = document.getElementById('terminal-typed');
  if (!el) return;
  const lines = [
    '$ npx anymodel --model google/gemini-2.5-flash',
    '',
    '\u2194 anymodel v1.0.0 proxy on :9090',
    '  /v1/messages \u2192 OpenRouter (google/gemini-2.5-flash)',
    '  /health      \u2192 status endpoint',
    '  everything else \u2192 passthrough',
    '',
    'Ready. Point your AI tool at localhost:9090'
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
  initScrollAnimations();
  initSmoothScroll();
  initCopyButtons();
  initNavScroll();
});
