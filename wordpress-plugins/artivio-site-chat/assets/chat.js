/* Artivio Website Assistant — chat panel (vanilla JS, no build step). */
(function () {
  'use strict';

  var cfg = window.ArtivioSiteChat || {};
  var root = document.getElementById('artivio-site-chat');
  if (!root) {
    return;
  }

  var api = function (path, opts) {
    opts = opts || {};
    return window.wp.apiFetch({
      url: cfg.restBase + path,
      method: opts.method || 'GET',
      data: opts.data,
      headers: { 'X-WP-Nonce': cfg.nonce },
    });
  };

  // ── Markdown-lite renderer. HTML is escaped FIRST; only our own tags are added.
  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  var inline = function (s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  };
  var STATUS_RE = /^\s*\[(tool|approval|artivio|system|platform|budget|stopped|error)\]\s*(.*)$/;
  var render = function (text) {
    var lines = esc(text).split('\n');
    var html = '';
    var list = null;
    var flush = function () {
      if (list) {
        html += '</' + list + '>';
        list = null;
      }
    };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = STATUS_RE.exec(line);
      if (m) {
        flush();
        html += '<div class="asc-status asc-status-' + m[1] + '">' + inline(m[2]) + '</div>';
        continue;
      }
      var h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) {
        flush();
        html += '<p class="asc-h">' + inline(h[2]) + '</p>';
        continue;
      }
      var ul = /^\s*[-*]\s+(.*)$/.exec(line);
      var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        var tag = ul ? 'ul' : 'ol';
        if (list !== tag) {
          flush();
          html += '<' + tag + '>';
          list = tag;
        }
        html += '<li>' + inline((ul || ol)[1]) + '</li>';
        continue;
      }
      flush();
      if (line.trim() === '') {
        continue;
      }
      html += '<p>' + inline(line) + '</p>';
    }
    flush();
    return html;
  };

  // ── State
  var state = { agent: null, messages: [], live: null, sending: false, stopping: false, pollTimer: null, lastCount: 0 };

  var el = {};
  var build = function () {
    root.removeAttribute('data-loading');
    root.innerHTML =
      '<div class="asc-head">' +
      '  <div class="asc-avatar" id="asc-avatar"></div>' +
      '  <div class="asc-title"><strong id="asc-name">Assistant</strong><span id="asc-tag"></span></div>' +
      '  <div class="asc-state" id="asc-state"></div>' +
      '</div>' +
      '<div class="asc-log" id="asc-log"></div>' +
      '<div class="asc-suggest" id="asc-suggest"></div>' +
      '<form class="asc-compose" id="asc-form">' +
      '  <textarea id="asc-input" rows="2" placeholder="What would you like changed on your website?"></textarea>' +
      '  <div class="asc-actions"><button type="button" class="button" id="asc-stop" hidden>Stop</button><button type="submit" class="button button-primary" id="asc-send">Send</button></div>' +
      '</form>' +
      '<p class="asc-foot">Changes are made on ' + esc(cfg.siteUrl || 'this site') + '. Check the page after each change.</p>';
    ['avatar', 'name', 'tag', 'state', 'log', 'suggest', 'form', 'input', 'stop', 'send'].forEach(function (k) {
      el[k] = document.getElementById('asc-' + k);
    });
    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      send(el.input.value);
    });
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send(el.input.value);
      }
    });
    el.stop.addEventListener('click', function () {
      // Immediate feedback: the platform aborts the in-flight step, but the
      // panel would otherwise look ignored until the next poll.
      state.stopping = true;
      paint();
      api('/stop', { method: 'POST' })
        .then(function (r) {
          if (r && r.stopped === false) {
            state.stopping = false;
            state.live = null;
            paint();
          }
          clearTimeout(state.pollTimer);
          state.pollTimer = setTimeout(refresh, 800);
        })
        .catch(function (e) {
          state.stopping = false;
          paint();
          showError(e);
        });
    });
    (cfg.suggestions || []).forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'asc-chip';
      b.textContent = s;
      b.addEventListener('click', function () {
        el.input.value = s;
        el.input.focus();
      });
      el.suggest.appendChild(b);
    });
  };

  var paint = function () {
    var log = el.log;
    var html = '';
    if (state.messages.length === 0 && !state.live) {
      html += '<div class="asc-msg asc-assistant"><div class="asc-bubble">' + render(cfg.welcome || '') + '</div></div>';
    }
    state.messages.forEach(function (m) {
      html += '<div class="asc-msg asc-' + (m.role === 'user' ? 'user' : 'assistant') + '"><div class="asc-bubble">' + render(m.content) + '</div></div>';
    });
    if (state.live) {
      var working = (state.stopping || state.live.stopRequested ? 'Stopping…' : 'Working') + (state.live.iteration ? ' — ' + state.live.iteration + ' step' + (state.live.iteration === 1 ? '' : 's') : '') +
        (state.live.lastTool ? ' · ' + esc(state.live.lastTool.replace(/^mcp__[a-z0-9-]+__/, '')) : '');
      html += '<div class="asc-msg asc-assistant asc-live"><div class="asc-bubble">' + (state.live.text ? render(state.live.text) : '') +
        '<div class="asc-working"><span class="asc-dots"><i></i><i></i><i></i></span> ' + working + '</div></div></div>';
    }
    log.innerHTML = html;
    log.scrollTop = log.scrollHeight;
    if (!state.live) {
      state.stopping = false;
    }
    el.state.textContent = state.live ? (state.stopping ? 'stopping' : 'working') : 'online';
    el.state.className = 'asc-state ' + (state.live ? 'is-working' : 'is-online');
    el.stop.hidden = !state.live;
    el.stop.disabled = state.stopping;
    el.stop.textContent = state.stopping ? 'Stopping…' : 'Stop';
    el.send.disabled = Boolean(state.live) || state.sending;
    el.suggest.hidden = state.messages.length > 0;
  };

  var refresh = function () {
    return api('/messages').then(function (r) {
      state.messages = r.messages || [];
      state.live = r.live || null;
      paint();
      schedule();
    }).catch(function (e) {
      showError(e);
    });
  };

  var schedule = function () {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(refresh, state.live ? 2000 : 15000);
  };

  var showError = function (e) {
    var msg = (e && e.message) ? e.message : 'Something went wrong talking to the assistant.';
    var div = document.createElement('div');
    div.className = 'asc-msg asc-assistant';
    div.innerHTML = '<div class="asc-bubble asc-error">' + esc(msg) + '</div>';
    el.log.appendChild(div);
    el.log.scrollTop = el.log.scrollHeight;
  };

  var send = function (text) {
    text = (text || '').trim();
    if (!text || state.sending || state.live) {
      return;
    }
    state.sending = true;
    el.input.value = '';
    state.messages.push({ role: 'user', content: text, createdAt: new Date().toISOString() });
    state.live = { iteration: 0, lastTool: null, text: '' };
    paint();
    api('/send', { method: 'POST', data: { message: text } })
      .then(function () {
        state.sending = false;
        clearTimeout(state.pollTimer);
        state.pollTimer = setTimeout(refresh, 1500);
      })
      .catch(function (e) {
        state.sending = false;
        state.live = null;
        paint();
        showError(e);
      });
  };

  var init = function () {
    build();
    if (!cfg.connected) {
      el.send.disabled = true;
      el.input.disabled = true;
      return;
    }
    api('/config').then(function (c) {
      state.agent = c.agent || {};
      el.name.textContent = state.agent.name || 'Assistant';
      el.tag.textContent = (state.agent.tagline ? state.agent.tagline + ' · ' : '') + 'by ' + (c.provider || 'Artivio');
      if (state.agent.avatarUrl) {
        el.avatar.style.backgroundImage = 'url("' + state.agent.avatarUrl + '")';
      } else {
        el.avatar.textContent = (state.agent.name || 'A').charAt(0);
      }
      if (state.agent.accent) {
        root.style.setProperty('--asc-accent', state.agent.accent);
      }
      if (c.site && c.site.layoutEditing === false) {
        el.tag.textContent += ' · content edits only';
      }
      el.input.placeholder = 'Ask ' + (state.agent.name || 'the assistant') + ' to change something on your website…';
    }).catch(showError).then(refresh);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
