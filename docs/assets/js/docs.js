// Behaviour for every docs page. No framework, no build: loaded with `defer`.
(function () {
    'use strict';

    var body = document.body;
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var store = {
        get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
    };

    /* ---------- Icons & highlighting ---------- */

    function drawIcons() {
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    }

    function highlight() {
        if (!window.hljs) return;
        document.querySelectorAll('.code-block pre code').forEach(function (el) {
            if (el.dataset.highlighted) return;
            if (!/language-/.test(el.className)) el.classList.add('nohighlight');
            window.hljs.highlightElement(el);
        });
    }

    /* ---------- Theme ---------- */

    var themeBtn = document.getElementById('theme-toggle');
    if (themeBtn) {
        themeBtn.addEventListener('click', function () {
            var next = body.classList.contains('dark') ? 'light' : 'dark';
            body.classList.remove('dark', 'light');
            body.classList.add(next);
            store.set('controllersets-theme', next);
        });
    }

    /* ---------- Mobile navigation ---------- */

    var sidenav = document.getElementById('sidenav');
    function openNav() { body.classList.add('nav-open'); }
    function closeNav() { body.classList.remove('nav-open'); }

    var menuBtn = document.getElementById('menu-open');
    var overlay = document.getElementById('nav-overlay');
    if (menuBtn) menuBtn.addEventListener('click', openNav);
    if (overlay) overlay.addEventListener('click', closeNav);

    /* ---------- Nested sidebar ---------- */

    // Groups remember being collapsed; the current page's group never is.
    var collapsed = {};
    try { collapsed = JSON.parse(store.get('controllersets-nav') || '{}'); } catch (e) { }

    document.querySelectorAll('.nav-group').forEach(function (group) {
        var key = group.dataset.group;
        var btn = group.querySelector('.nav-group-toggle');
        if (!btn) return;                       // single-page groups are plain links
        var hasCurrent = !!group.querySelector('[aria-current="page"]');

        function apply(isCollapsed) {
            group.classList.toggle('is-collapsed', isCollapsed);
            btn.setAttribute('aria-expanded', String(!isCollapsed));
        }
        apply(!hasCurrent && !!collapsed[key]);

        btn.addEventListener('click', function () {
            var next = !group.classList.contains('is-collapsed');
            apply(next);
            collapsed[key] = next;
            store.set('controllersets-nav', JSON.stringify(collapsed));
        });
    });

    document.querySelectorAll('.nav-expand').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var item = btn.closest('.nav-page-item');
            var open = !item.classList.contains('is-open');
            item.classList.toggle('is-open', open);
            btn.setAttribute('aria-expanded', String(open));
        });
    });

    // Keep the current page in view inside a long sidebar.
    var current = document.querySelector('.nav-page[aria-current="page"]');
    if (current && sidenav) {
        var r = current.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 40) sidenav.scrollTop = r.top - 120;
    }

    document.querySelectorAll('.nav-section, .nav-page').forEach(function (a) {
        a.addEventListener('click', closeNav);
    });

    /* ---------- Scrollspy: sidebar sections and "On this page" ---------- */

    var spyLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-page-item.is-open .nav-section, .toc a[data-target]'));
    var targets = [];
    spyLinks.forEach(function (a) {
        var el = document.getElementById(a.dataset.target);
        if (el && targets.indexOf(el) === -1) targets.push(el);
    });

    function setActive(id) {
        spyLinks.forEach(function (a) {
            var on = a.dataset.target === id;
            a.classList.toggle('is-active', on);
            if (on) a.setAttribute('aria-current', 'location');
            else a.removeAttribute('aria-current');
        });
        // A section link is also lit while one of its h3s is current.
        var el = document.getElementById(id);
        var section = el && el.closest('section[id]');
        if (section && section.id !== id) {
            document.querySelectorAll('.nav-section[data-target="' + section.id + '"]').forEach(function (a) {
                a.classList.add('is-active');
            });
        }
    }

    var spyTicking = false;
    function spy() {
        spyTicking = false;
        var line = 200;
        var active = null;
        for (var i = 0; i < targets.length; i++) {
            if (targets[i].getBoundingClientRect().top - line <= 0) active = targets[i];
            else break;
        }
        if (!active && targets.length) active = targets[0];
        // At the very bottom the last heading may never reach the line.
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4 && targets.length) {
            active = targets[targets.length - 1];
        }
        if (active) setActive(active.id);
    }

    /* ---------- Back to top ---------- */

    var toTop = document.getElementById('back-to-top');
    if (toTop) {
        toTop.addEventListener('click', function () {
            window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
        });
    }

    window.addEventListener('scroll', function () {
        if (toTop) toTop.classList.toggle('is-visible', window.scrollY > 700);
        if (!spyTicking) { spyTicking = true; requestAnimationFrame(spy); }
    }, { passive: true });
    spy();

    /* ---------- Copy ---------- */

    function copyText(text, done) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { });
            return;
        }
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { }
        document.body.removeChild(ta);
    }

    function flash(btn, label) {
        var original = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = '<i data-lucide="check"></i> ' + label;
        drawIcons();
        setTimeout(function () {
            btn.classList.remove('copied');
            btn.innerHTML = original;
            drawIcons();
        }, 1600);
    }

    // Every code block gets a copy button, whether or not the source wrote one.
    document.querySelectorAll('.code-block').forEach(function (block) {
        if (!block.querySelector('.copy-btn')) {
            var b = document.createElement('button');
            b.className = 'copy-btn';
            b.type = 'button';
            b.innerHTML = '<i data-lucide="copy"></i> Copy';
            block.appendChild(b);
        }
    });

    document.addEventListener('click', function (e) {
        var btn = e.target.closest('.copy-btn');
        if (btn) {
            var code = btn.closest('.code-block').querySelector('code');
            if (code) copyText(code.innerText, function () { flash(btn, 'Copied'); });
            return;
        }
        var pageBtn = e.target.closest('[data-copy-page]');
        if (pageBtn) {
            var article = document.querySelector('.doc-inner').cloneNode(true);
            article.querySelectorAll('.pager, .doc-footer, .page-actions, .copy-btn, .anchor').forEach(function (n) { n.remove(); });
            var text = article.innerText.replace(/\n{3,}/g, '\n\n').trim() + '\n\nSource: ' + location.href;
            copyText(text, function () { flash(pageBtn, 'Copied'); });
        }
    });

    /* ---------- Tabs ---------- */

    document.querySelectorAll('.tabs').forEach(function (group) {
        var buttons = group.querySelectorAll('.tab-btn');
        var panels = group.querySelectorAll('.tab-panel');
        function select(id) {
            buttons.forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === id)); });
            panels.forEach(function (p) { p.classList.toggle('is-active', p.id === id); });
        }
        buttons.forEach(function (b) { b.addEventListener('click', function () { select(b.dataset.tab); }); });
        if (buttons.length) select(buttons[0].dataset.tab);
    });

    /* ---------- Search ---------- */

    var dialog = document.getElementById('search-dialog');
    var input = document.getElementById('search-input');
    var results = document.getElementById('search-results');
    var selected = 0;
    var hits = [];

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function mark(text, terms) {
        var out = escapeHtml(text);
        terms.forEach(function (t) {
            if (!t) return;
            var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
            out = out.replace(re, '<mark>$1</mark>');
        });
        return out;
    }

    function snippet(text, term) {
        var i = text.toLowerCase().indexOf(term);
        if (i < 0) return text.slice(0, 120);
        var start = Math.max(0, i - 40);
        return (start ? '…' : '') + text.slice(start, start + 140);
    }

    function search(q) {
        var index = window.__DOCS_INDEX__ || [];
        // Light stemming, so "rotate" finds "rotation" and "tokens" finds "token".
        var terms = q.toLowerCase().split(/\s+/).filter(Boolean).map(function (t) {
            return t.length > 4 ? t.replace(/(ations?|ation|ing|ions?|es|ed|e|s)$/, '') : t;
        });
        if (!terms.length) {
            hits = index.filter(function (e) { return e.u.indexOf('#') === -1; }).slice(0, 8);
            return render(hits, []);
        }
        var scored = [];
        index.forEach(function (e) {
            var title = e.t.toLowerCase();
            var page = e.p.toLowerCase();
            var text = e.x.toLowerCase();
            var score = 0;
            for (var i = 0; i < terms.length; i++) {
                var t = terms[i];
                var s = 0;
                if (title === t) s += 40;
                if (title.indexOf(t) === 0) s += 20;
                else if (title.indexOf(t) > -1) s += 12;
                if (page.indexOf(t) > -1) s += 5;
                if (text.indexOf(t) > -1) s += 3;
                if (!s) return;
                score += s;
            }
            if (e.u.indexOf('#') === -1) score += 2;
            scored.push({ e: e, s: score });
        });
        scored.sort(function (a, b) { return b.s - a.s; });
        hits = scored.slice(0, 12).map(function (x) { return x.e; });
        render(hits, terms);
    }

    function render(list, terms) {
        selected = 0;
        if (!list.length) {
            results.innerHTML = '<li class="search-empty">No results. Try another word — or ask an LLM with the <a href="llm.html">prompt</a>.</li>';
            return;
        }
        results.innerHTML = list.map(function (e, i) {
            var path = e.t === e.p ? e.g : e.g + ' › ' + e.p;
            return '<li><a href="' + e.u + '" role="option" aria-selected="' + (i === 0) + '">' +
                '<span class="r-path">' + escapeHtml(path) + '</span>' +
                '<span class="r-title">' + mark(e.t, terms) + '</span>' +
                (e.x ? '<span class="r-text">' + mark(snippet(e.x, terms[0] || ''), terms) + '</span>' : '') +
                '</a></li>';
        }).join('');
    }

    function move(delta) {
        var links = results.querySelectorAll('a');
        if (!links.length) return;
        selected = (selected + delta + links.length) % links.length;
        links.forEach(function (a, i) { a.setAttribute('aria-selected', String(i === selected)); });
        links[selected].scrollIntoView({ block: 'nearest' });
    }

    function openSearch() {
        if (!dialog) return;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        input.value = '';
        search('');
        input.focus();
    }

    var searchBtn = document.getElementById('search-open');
    if (searchBtn) searchBtn.addEventListener('click', openSearch);

    if (input) {
        input.addEventListener('input', function () { search(input.value); });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') {
                var a = results.querySelectorAll('a')[selected];
                if (a) { e.preventDefault(); location.href = a.href; dialog.close(); }
            }
        });
    }
    if (dialog) {
        dialog.addEventListener('click', function (e) {
            if (e.target === dialog) dialog.close();
            if (e.target.closest('a')) dialog.close();
        });
    }

    document.addEventListener('keydown', function (e) {
        var typing = /input|textarea|select/i.test(document.activeElement.tagName);
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openSearch();
        } else if (e.key === '/' && !typing) {
            e.preventDefault();
            openSearch();
        } else if (e.key === 'Escape') {
            closeNav();
        }
    });

    /* ---------- Open collapsed blocks that a link points into ---------- */

    function revealHash() {
        if (!location.hash) return;
        var el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
        if (!el) return;
        var d = el.closest('details');
        var opened = false;
        while (d) {
            if (!d.open) { d.open = true; opened = true; }
            d = d.parentElement && d.parentElement.closest('details');
        }
        if (opened) el.scrollIntoView();
    }
    window.addEventListener('hashchange', revealHash);
    revealHash();

    /* ---------- Start ---------- */

    drawIcons();
    highlight();
    window.addEventListener('load', function () { drawIcons(); highlight(); });
})();
