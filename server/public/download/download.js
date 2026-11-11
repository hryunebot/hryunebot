// Хрюнебот, страница «завантажити»: только переключатель языка (CSP: script-src 'self', без инлайна).
// Версия и SHA-256 вписаны в HTML при сборке (build-installer.ps1) — видны и без JavaScript.
(function () {
  var html = document.documentElement;
  var bu = document.getElementById('bu'), br = document.getElementById('br');
  function set(l) {
    html.lang = l;
    bu.className = l === 'uk' ? 'on' : '';
    br.className = l === 'ru' ? 'on' : '';
    try { localStorage.setItem('hryu-lang', l); } catch (e) {}
  }
  bu.addEventListener('click', function () { set('uk'); });
  br.addEventListener('click', function () { set('ru'); });
  try { var s = localStorage.getItem('hryu-lang'); if (s === 'ru' || s === 'uk') set(s); } catch (e) {}
})();
