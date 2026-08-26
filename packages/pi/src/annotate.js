/* ideation-review-annotate — client annotation bundle.
 *
 * Framework-free, no build step, injected by review-server.ts before </body>.
 * The on-disk contract.html never carries this file; opening the contract via
 * file:// shows no annotation chrome. Mirrors the discipline of contract-gen's
 * CLIENT_JS: an IIFE under 'use strict', feature-guarded, try/catch around
 * localStorage, and it degrades to a readable document if anything is missing.
 *
 * Pins section-level comments to content-derived [data-block] ids, lists them
 * in a side panel (orphaned ids from earlier revisions collapse into their own
 * group), and drives an approve/deny bar where deny requires a reason. Comment
 * drafts persist to localStorage keyed by slug + revision so a reload loses
 * nothing.
 */
(function () {
  'use strict';

  var cfg = window.__REVIEW__ || {};
  var slug = cfg.slug || 'contract';
  var revision = cfg.revision || 'unknown';
  var DRAFT_KEY = 'ideation-review-draft:' + slug + ':' + revision;

  if (!document.body) return;

  /* ---- styles (the bundle owns annotation chrome) ---------------------- */
  var css =
    '.rv-block-hint{position:absolute;font:600 11px/1 system-ui,sans-serif;' +
    'background:#2b46c7;color:#fff;padding:3px 7px;border-radius:3px;cursor:pointer;' +
    'z-index:9998}' +
    '[data-block]{scroll-margin-top:80px}' +
    '[data-rv-commented]{outline:2px solid #2b46c7;outline-offset:2px}' +
    '.rv-panel{position:fixed;top:0;right:0;width:320px;max-width:85vw;height:100vh;' +
    'background:#fff;color:#111;border-left:1px solid #ccc;box-shadow:-4px 0 16px rgba(0,0,0,.12);' +
    'z-index:9999;display:flex;flex-direction:column;font:14px/1.4 system-ui,sans-serif}' +
    '.rv-panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;margin:0;' +
    'padding:14px 16px;border-bottom:1px solid #eee}' +
    '.rv-list{flex:1;overflow:auto;padding:12px 16px;margin:0;list-style:none}' +
    '.rv-list li{border:1px solid #eee;border-radius:4px;padding:8px 10px;margin-bottom:8px}' +
    '.rv-orphans summary{cursor:pointer;color:#888;margin:8px 0}' +
    '.rv-bar{border-top:1px solid #eee;padding:12px 16px;display:flex;gap:8px}' +
    '.rv-bar button{flex:1;padding:8px;border:1px solid #2b46c7;border-radius:4px;' +
    'background:#fff;color:#2b46c7;cursor:pointer;font:inherit}' +
    '.rv-bar button.rv-approve{background:#187a48;border-color:#187a48;color:#fff}' +
    '.rv-bar button[disabled]{opacity:.5;cursor:default}' +
    '.rv-composer{position:absolute;z-index:10000;background:#fff;border:1px solid #2b46c7;' +
    'border-radius:4px;padding:8px;width:260px;box-shadow:0 4px 16px rgba(0,0,0,.18)}' +
    '.rv-composer textarea{width:100%;box-sizing:border-box;min-height:60px;font:inherit}' +
    '.rv-composer .rv-actions{display:flex;gap:6px;margin-top:6px}' +
    'body.rv-on{margin-right:320px}';
  try {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  } catch (e) {}

  document.body.classList.add('rv-on');

  /* ---- draft persistence ----------------------------------------------- */
  function loadDrafts() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function saveDrafts(d) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch (e) {}
  }
  function clearDraft(id) {
    var d = loadDrafts();
    delete d[id];
    saveDrafts(d);
  }

  /* ---- state ----------------------------------------------------------- */
  var comments = [];
  var knownIds = {};
  Array.prototype.forEach.call(document.querySelectorAll('[data-block]'), function (el) {
    knownIds[el.getAttribute('data-block')] = el;
  });

  /* ---- panel ----------------------------------------------------------- */
  var panel = document.createElement('aside');
  panel.className = 'rv-panel';
  panel.setAttribute('aria-label', 'Contract review');
  var heading = document.createElement('h2');
  heading.textContent = 'Review · ' + slug;
  var list = document.createElement('ul');
  list.className = 'rv-list';
  var bar = document.createElement('div');
  bar.className = 'rv-bar';
  var approveBtn = document.createElement('button');
  approveBtn.className = 'rv-approve';
  approveBtn.type = 'button';
  approveBtn.textContent = 'Approve';
  var denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.textContent = 'Deny…';
  bar.appendChild(approveBtn);
  bar.appendChild(denyBtn);
  panel.appendChild(heading);
  panel.appendChild(list);
  panel.appendChild(bar);
  document.body.appendChild(panel);

  function renderList() {
    while (list.firstChild) list.removeChild(list.firstChild);
    var live = comments.filter(function (c) {
      return c.blockId && knownIds[c.blockId];
    });
    var orphans = comments.filter(function (c) {
      return !c.blockId || !knownIds[c.blockId];
    });
    live.forEach(function (c) {
      var li = document.createElement('li');
      li.textContent = c.text;
      list.appendChild(li);
    });
    if (orphans.length) {
      var det = document.createElement('details');
      det.className = 'rv-orphans';
      var sum = document.createElement('summary');
      sum.textContent = 'From earlier revisions (' + orphans.length + ')';
      det.appendChild(sum);
      orphans.forEach(function (c) {
        var p = document.createElement('p');
        p.textContent = c.text;
        det.appendChild(p);
      });
      var wrap = document.createElement('li');
      wrap.appendChild(det);
      list.appendChild(wrap);
    }
  }
  renderList();

  /* ---- posting --------------------------------------------------------- */
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function submitComment(blockId, text, el) {
    return post('/feedback', { blockId: blockId, kind: 'comment', text: text }).then(function (r) {
      if (!r.ok) return;
      comments.push({ blockId: blockId, text: text });
      if (el) el.setAttribute('data-rv-commented', 'true');
      clearDraft(blockId);
      renderList();
    });
  }

  /* ---- composer -------------------------------------------------------- */
  var openComposer = null;
  function closeComposer() {
    if (openComposer && openComposer.parentNode) openComposer.parentNode.removeChild(openComposer);
    openComposer = null;
  }
  function showComposer(el) {
    closeComposer();
    var blockId = el.getAttribute('data-block');
    var box = document.createElement('div');
    box.className = 'rv-composer';
    var ta = document.createElement('textarea');
    ta.placeholder = 'Comment on this item…';
    var drafts = loadDrafts();
    if (drafts[blockId]) ta.value = drafts[blockId];
    ta.addEventListener('input', function () {
      var d = loadDrafts();
      d[blockId] = ta.value;
      saveDrafts(d);
    });
    var actions = document.createElement('div');
    actions.className = 'rv-actions';
    var save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Comment';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    save.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!text) return;
      submitComment(blockId, text, el);
      closeComposer();
    });
    cancel.addEventListener('click', closeComposer);
    actions.appendChild(save);
    actions.appendChild(cancel);
    box.appendChild(ta);
    box.appendChild(actions);
    var rect = el.getBoundingClientRect();
    box.style.left = (window.scrollX + rect.left) + 'px';
    box.style.top = (window.scrollY + rect.bottom + 6) + 'px';
    document.body.appendChild(box);
    openComposer = box;
    ta.focus();
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-block]'), function (el) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('a,button,code')) return;
      showComposer(el);
    });
  });

  /* ---- decision bar ---------------------------------------------------- */
  function disableBar() {
    approveBtn.setAttribute('disabled', 'true');
    denyBtn.setAttribute('disabled', 'true');
  }
  approveBtn.addEventListener('click', function () {
    if (!window.confirm('Approve this contract?')) return;
    disableBar();
    post('/decision', { decision: 'approve', comments: comments.length }).then(function (r) {
      approveBtn.textContent = r.ok ? 'Approved' : 'Failed';
      if (!r.ok) {
        approveBtn.removeAttribute('disabled');
        denyBtn.removeAttribute('disabled');
      }
    });
  });
  denyBtn.addEventListener('click', function () {
    var reason = window.prompt('Deny — what needs to change?');
    if (reason == null) return;
    reason = reason.trim();
    if (!reason) {
      window.alert('Deny requires a reason.');
      return;
    }
    disableBar();
    post('/decision', {
      decision: 'deny',
      reasons: [reason],
      comments: comments.length,
    }).then(function (r) {
      denyBtn.textContent = r.ok ? 'Denied' : 'Failed';
      if (!r.ok) {
        approveBtn.removeAttribute('disabled');
        denyBtn.removeAttribute('disabled');
      }
    });
  });
})();
