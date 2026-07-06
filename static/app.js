const state = { docs: [], selected: new Set(), streaming: false };

// ── Ollama status ─────────────────────────────────────────────────────────
async function checkOllama() {
  try {
    const r = await fetch('/ollama/status');
    const d = await r.json();
    const dot = document.getElementById('ollamaDot');
    const label = document.getElementById('ollamaLabel');
    if (d.running) {
      dot.className = 'dot ok';
      label.textContent = d.models.length
        ? `ollama: ${d.models.slice(0,2).join(', ')}`
        : 'ollama запущена';
    } else {
      dot.className = 'dot err';
      label.textContent = 'ollama не запущена';
    }
  } catch {}
}
checkOllama();
setInterval(checkOllama, 8000);

// ── Upload ────────────────────────────────────────────────────────────────
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const progress = document.getElementById('progressBar');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag');
  uploadFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => uploadFiles([...fileInput.files]));

async function uploadFiles(files) {
  for (const file of files) {
    progress.style.display = 'block';
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch('/upload', { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json();
        alert('Ошибка: ' + (err.detail || 'неизвестная'));
        continue;
      }
      const d = await r.json();
      if (!state.docs.find(x => x.filename === d.filename)) {
        state.docs.push(d);
        state.selected.add(d.filename);
      }
    } catch (e) {
      alert('Ошибка загрузки: ' + e.message);
    }
    progress.style.display = 'none';
  }
  fileInput.value = '';
  renderDocs();
}

// ── Docs list ─────────────────────────────────────────────────────────────
function renderDocs() {
  const list = document.getElementById('docsList');
  const hint = document.getElementById('selectedHint');

  if (!state.docs.length) {
    list.innerHTML = '<div class="no-docs">Файлы ещё не загружены.<br>Загрузи PDF или Markdown выше.</div>';
    hint.textContent = '📋 Нет документов';
    return;
  }

  list.innerHTML = state.docs.map(doc => {
    const sel = state.selected.has(doc.filename);
    const icon = doc.filename.endsWith('.pdf') ? '📕' : '📝';
    return `
      <div class="doc-item ${sel ? 'selected' : ''}" data-name="${doc.filename}">
        <span class="doc-icon">${icon}</span>
        <div class="doc-info">
          <div class="doc-name" title="${doc.filename}">${doc.filename}</div>
          <div class="doc-meta">${(doc.words || 0).toLocaleString('ru')} слов</div>
        </div>
        <button class="doc-del" title="Удалить" onclick="deleteDoc('${doc.filename}',event)">✕</button>
      </div>`;
  }).join('');

  list.querySelectorAll('.doc-item').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.name;
      if (state.selected.has(name)) state.selected.delete(name);
      else state.selected.add(name);
      renderDocs();
    });
  });

  const cnt = state.selected.size;
  hint.textContent = cnt === 0
    ? '⚠️ Ни один документ не выбран'
    : cnt === state.docs.length
      ? `📋 Все документы (${cnt}) в контексте`
      : `📌 ${cnt} из ${state.docs.length} документов`;
}

async function deleteDoc(filename, e) {
  e.stopPropagation();
  await fetch(`/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  state.docs = state.docs.filter(d => d.filename !== filename);
  state.selected.delete(filename);
  renderDocs();
}

// ── Chat ──────────────────────────────────────────────────────────────────
const textarea = document.getElementById('question');
const sendBtn = document.getElementById('sendBtn');
const messages = document.getElementById('messages');

textarea.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

textarea.addEventListener('input', () => {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
});

sendBtn.addEventListener('click', sendMessage);

function addMessage(role, text = '') {
  const welcome = messages.querySelector('.welcome');
  if (welcome) welcome.remove();

  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `
    <div class="avatar">${role === 'user' ? '🧑' : '🤖'}</div>
    <div class="bubble">${escHtml(text)}</div>`;
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
  return wrap.querySelector('.bubble');
}

function escHtml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendMessage() {
  const q = textarea.value.trim();
  if (!q || state.streaming) return;

  addMessage('user', q);
  textarea.value = '';
  textarea.style.height = 'auto';

  const bubble = addMessage('ai', '');
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  bubble.appendChild(cursor);

  state.streaming = true;
  sendBtn.disabled = true;
  let full = '';

  try {
    const resp = await fetch('/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q,
        filenames: [...state.selected],
      }),
    });

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const obj = JSON.parse(line.slice(6));
        if (obj.error) {
          bubble.classList.add('error');
          bubble.textContent = '⚠️ ' + obj.error;
          return;
        }
        if (obj.token) {
          full += obj.token;
          bubble.textContent = full;
          bubble.appendChild(cursor);
          messages.scrollTop = messages.scrollHeight;
        }
      }
    }
  } catch (e) {
    bubble.classList.add('error');
    bubble.textContent = '⚠️ Ошибка соединения: ' + e.message;
  } finally {
    cursor.remove();
    state.streaming = false;
    sendBtn.disabled = false;
    textarea.focus();
  }
}
