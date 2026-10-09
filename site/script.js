const root = document.documentElement;
const themeButton = document.querySelector('.theme-toggle');
const media = window.matchMedia('(prefers-color-scheme: dark)');
let savedTheme;
try { savedTheme = localStorage.getItem('anymodel-theme'); } catch {}
function setTheme(theme) {
  root.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? 'Light' : 'Dark';
  themeButton.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
}
setTheme(savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : media.matches ? 'dark' : 'light');
themeButton.addEventListener('click', () => {
  savedTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(savedTheme);
  try { localStorage.setItem('anymodel-theme', savedTheme); } catch {}
});
media.addEventListener('change', event => { if (!savedTheme) setTheme(event.matches ? 'dark' : 'light'); });
for (const button of document.querySelectorAll('.copy-btn')) {
  button.addEventListener('click', async () => {
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied'; status.textContent = 'Command copied.';
      setTimeout(() => { button.textContent = 'Copy'; }, 1800);
    } catch {
      button.textContent = 'Select';
      const range = document.createRange(); range.selectNodeContents(button.previousElementSibling);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      status.textContent = 'Clipboard unavailable. The command is selected for you to copy.';
    }
  });
}
