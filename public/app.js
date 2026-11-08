const $ = id => document.getElementById(id);
const messages = $('messages');
let state, pendingFiles = [], running = false, reconnectTimer;
let selected = { openai: 'gpt-5.4', ollama: '' };

function notice(text = '') {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'X-Haas-Request': '1', ...options.headers } });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return response;
}

function fileUrl(value) {
  let file = value;
  if (state?.scope.id === 'imported-workspace' && state.legacyWorkspace && file.startsWith(`${state.legacyWorkspace}/`)) file = file.slice(state.legacyWorkspace.length + 1);
  if (state?.workspace && file.startsWith(`${state.workspace}/`)) file = file.slice(state.workspace.length + 1);
  if (file.startsWith('/') || file.startsWith('..') || /^(?:javascript|data|file):/i.test(file)) return null;
  return `/files/${file.split('/').map(encodeURIComponent).join('/')}`;
}

// Sanitise generated HTML before insertion; external images/iframes never load.
function richText(element, text) {
  element.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }), {
    ALLOWED_TAGS: ['p', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'br', 'h1', 'h2', 'h3', 'h4', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
    ALLOWED_ATTR: ['href', 'title'],
  });
  for (const link of element.querySelectorAll('a')) {
    const target = link.getAttribute('href') || '';
    const url = /^https?:\/\//i.test(target) || /^\/documents\/[a-zA-Z0-9_-]+\/download(?:#page=\d+)?$/.test(target) ? target : fileUrl(target);
    if (url) {
      link.href = url;
      if (/^https?:/.test(url)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    } else link.replaceWith(document.createTextNode(link.textContent));
  }
}

function scrollDown() { $('scroll-area').scrollTop = $('scroll-area').scrollHeight; }

function bubble(role, text = '', error) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'YOU' : 'HAAS';
  const content = document.createElement('div');
  content.className = 'message-body';
  richText(content, text);
  article.append(label, content);
  if (error) {
    const failure = document.createElement('p');
    failure.className = 'error'; failure.textContent = error; article.append(failure);
  }
  messages.append(article);
  $('welcome').hidden = true;
  scrollDown();
  return content;
}

function tool(name, args, output, isError = false) {
  const details = document.createElement('details');
  details.className = `tool ${isError ? 'failed' : ''}`;
  const summary = document.createElement('summary');
  summary.textContent = `${output === undefined ? '◌' : isError ? '!' : '✓'} ${name.replace(/^mcp__/, '').replaceAll('__', ' › ')}`;
  const body = document.createElement('div');
  body.className = 'tool-body';
  richText(body, [args ? JSON.stringify(args, null, 2) : '', output || 'Running…'].filter(Boolean).join('\n\n'));
  details.append(summary, body);
  messages.append(details);
  $('welcome').hidden = true;
  scrollDown();
  return { details, summary, body };
}

function setRunning(value) {
  running = value;
  for (const id of ['send', 'provider', 'model', 'new-chat', 'new-project', 'new-project-conversation', 'git-tracking', 'save-snapshot', 'attach']) $(id).disabled = value;
  document.querySelectorAll('.history-list button').forEach(button => { button.disabled = value; });
  $('stop').hidden = !value;
  $('status').textContent = value ? 'Working…' : 'Ready';
  $('message').disabled = value;
}

function renderFiles(files) {
  $('files').replaceChildren();
  $('no-files').hidden = files.length > 0;
  for (const file of files) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.textContent = file.path;
    link.href = fileUrl(file.path);
    link.title = `Download ${file.path}`;
    li.append(link); $('files').append(li);
  }
}

function showSidebar(open) {
  $('workspace-sidebar').classList.toggle('is-open', open);
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
}

async function navigate(url, input) {
  if (running) return;
  setRunning(true);
  try {
    await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input || {}) });
    pendingFiles = []; $('attachments').replaceChildren();
    await refresh({ history: true });
    showSidebar(false);
  } catch (error) { notice(error.message); }
  finally { setRunning(false); }
}

function renderConversations(conversations, container) {
  container.replaceChildren();
  for (const conversation of conversations) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.title = conversation.title;
    button.disabled = running;
    if (conversation.active) button.setAttribute('aria-current', 'page');
    const title = document.createElement('span');
    title.textContent = conversation.title;
    const date = document.createElement('time');
    date.dateTime = conversation.updatedAt;
    date.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(conversation.updatedAt));
    button.append(title, date);
    button.addEventListener('click', async () => {
      if (running) return;
      if (conversation.active) { showSidebar(false); return; }
      await navigate('/api/conversations/open', { id: conversation.id });
    });
    item.append(button); container.append(item);
  }
}

function renderOrganization() {
  renderConversations(state.conversations.filter(item => item.kind === 'chat'), $('chats'));
  renderConversations(state.conversations.filter(item => item.kind === 'project' && item.scopeId === state.scope.id), $('conversations'));
  $('projects').replaceChildren();
  for (const project of state.projects) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button'; button.disabled = running;
    const title = document.createElement('span'); title.textContent = project.name;
    button.append(title);
    if (project.id === state.scope.id) button.setAttribute('aria-current', 'page');
    button.title = project.description || project.name;
    button.addEventListener('click', () => navigate('/api/projects/open', { id: project.id }));
    item.append(button); $('projects').append(item);
  }
  $('project-conversations').hidden = state.scope.kind !== 'project';
  $('scope-kind').textContent = state.scope.kind.toUpperCase();
  const active = state.conversations.find(item => item.active);
  $('scope-name').textContent = state.scope.kind === 'project' ? state.scope.name : active?.title || 'New chat';
  $('git-tracking').checked = state.scope.gitTracked;
  $('save-snapshot').hidden = !state.scope.gitTracked;
  $('tracking-status').textContent = state.scope.gitTracked ? 'Local Git history · saves after each run' : 'Git tracking off';
}

function modelOptions() {
  $('models').replaceChildren();
  for (const model of state.models[$('provider').value] || []) {
    const option = document.createElement('option'); option.value = model; $('models').append(option);
  }
}

async function refresh({ history = false } = {}) {
  state = await (await api('/api/state')).json();
  $('provider').querySelector('option[value="openai"]').disabled = state.localOnly;
  $('provider').title = state.localOnly ? 'This chat or project is restricted to local models.' : '';
  renderFiles(state.files);
  renderOrganization();
  if (history) {
    selected[state.selection.provider] = state.selection.model;
    $('provider').value = state.selection.provider;
    $('model').value = state.selection.model;
    if (state.localOnly && state.selection.provider !== 'ollama') {
      $('provider').value = 'ollama';
      $('model').value = selected.ollama || state.models.ollama[0] || '';
    }
    messages.replaceChildren();
    $('welcome').hidden = false;
    for (const entry of state.messages) {
      if (entry.role === 'tool') tool(entry.name, null, entry.text, entry.isError);
      else bubble(entry.role, entry.text, entry.error);
    }
    if (state.busy) {
      notice('A task is still running. Its saved results will appear when it finishes.');
      setRunning(true);
      reconnectTimer ||= setInterval(async () => {
        try {
          await refresh({ history: true });
          if (!state.busy) { clearInterval(reconnectTimer); reconnectTimer = null; setRunning(false); notice(); }
        } catch (error) { clearInterval(reconnectTimer); reconnectTimer = null; setRunning(false); notice(error.message); }
      }, 4000);
    } else if (state.localOnly) notice('This chat or project uses local models only. Web search and MCP tools are disabled.');
    else if (!state.openaiConfigured) notice('OpenAI chat and web research need OPENAI_API_KEY on the backend. You can still use a tool-capable Ollama model for local design work.');
    else notice(state.warnings.join(' · '));
  }
  if (!history && state.warnings.length) notice(state.warnings.join(' · '));
  modelOptions();
}

$('provider').addEventListener('change', () => {
  $('model').value = selected[$('provider').value] || state.models[$('provider').value]?.[0] || '';
  modelOptions();
  notice(state.localOnly ? 'This chat or project uses local models only. Web search and MCP tools are disabled.' : $('provider').value === 'ollama' ? (state.ollamaError || 'Choose an Ollama model with tool support. Web research still uses OpenAI.') : (!state.openaiConfigured ? 'Set OPENAI_API_KEY on the backend and restart.' : ''));
});
$('model').addEventListener('change', () => { selected[$('provider').value] = $('model').value; });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { $('message').value = button.dataset.prompt; $('message').focus(); }));
$('refresh').addEventListener('click', () => refresh().catch(error => notice(error.message)));
$('toggle-sidebar').addEventListener('click', () => showSidebar(!$('workspace-sidebar').classList.contains('is-open')));
$('close-sidebar').addEventListener('click', () => { showSidebar(false); $('toggle-sidebar').focus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') showSidebar(false); });
$('stop').addEventListener('click', () => api('/api/abort', { method: 'POST' }).catch(error => notice(error.message)));
$('new-chat').addEventListener('click', () => navigate('/api/new'));
$('new-project-conversation').addEventListener('click', () => navigate('/api/projects/conversations/new'));
$('new-project').addEventListener('click', () => {
  $('project-error').textContent = '';
  $('project-dialog').showModal();
  $('project-name').focus();
});
$('close-project').addEventListener('click', () => $('project-dialog').close());
$('project-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (running) return;
  setRunning(true); $('create-project').disabled = true;
  try {
    await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('project-name').value, description: $('project-description').value }) });
    pendingFiles = []; $('attachments').replaceChildren();
    await refresh({ history: true });
    $('project-dialog').close(); $('project-form').reset(); showSidebar(false);
  } catch (error) { $('project-error').textContent = error.message; }
  finally { setRunning(false); $('create-project').disabled = false; }
});
$('git-tracking').addEventListener('change', async () => {
  const enabled = $('git-tracking').checked;
  setRunning(true);
  try {
    await api('/api/git', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    notice(enabled ? 'Git tracking enabled. Conversations and artefacts are saved locally.' : 'Git tracking off. Previous history is retained.');
  } catch (error) { notice(error.message); }
  finally { await refresh().catch(error => notice(error.message)); setRunning(false); }
});
$('save-snapshot').addEventListener('click', async () => {
  setRunning(true);
  try { await api('/api/snapshot', { method: 'POST' }); notice('Snapshot saved.'); }
  catch (error) { notice(error.message); }
  finally { setRunning(false); }
});
$('attach').addEventListener('click', () => $('upload').click());
$('upload').addEventListener('change', async () => {
  const batch = crypto.randomUUID();
  setRunning(true); notice('Importing working copies…');
  try {
    for (const file of $('upload').files) {
      const result = await (await api(`/api/upload?batch=${batch}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })).json();
      pendingFiles.push(result.path);
      const chip = document.createElement('span'); chip.className = 'attachment'; chip.textContent = `↳ ${result.name}`; $('attachments').append(chip);
    }
    await refresh(); notice();
  } catch (error) { notice(error.message); }
  finally { setRunning(false); $('upload').value = ''; $('message').focus(); }
});
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
});
$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (running || !$('message').value.trim()) return;
  const draft = $('message').value.trim();
  const attachmentPaths = [...pendingFiles];
  const message = draft + (attachmentPaths.length ? `\n\nImported working copies (workspace-relative paths):\n${attachmentPaths.map(file => `- ${file}`).join('\n')}` : '');
  setRunning(true); notice();
  let current, currentText = '', accepted = false;
  const tools = new Map();
  try {
    const response = await api('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, provider: $('provider').value, model: $('model').value }) });
    accepted = true;
    bubble('user', message);
    $('message').value = ''; pendingFiles = []; $('attachments').replaceChildren();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', finished = false;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const update = JSON.parse(line);
        if (update.type === 'assistant_start') { current = bubble('assistant'); currentText = ''; }
        if (update.type === 'delta') { current ||= bubble('assistant'); currentText += update.text; richText(current, currentText); }
        if (update.type === 'assistant_end') {
          current ||= bubble('assistant');
          if (update.text || currentText || update.error) richText(current, update.text || currentText || update.error);
          else current.closest('.message').remove();
          if (update.error) notice(update.error);
          current = null;
        }
        if (update.type === 'tool_start') tools.set(update.id, tool(update.name, update.args));
        if (update.type === 'tool_end') {
          const entry = tools.get(update.id) || tool(update.name);
          entry.summary.textContent = `${update.isError ? '!' : '✓'} ${update.name.replace(/^mcp__/, '').replaceAll('__', ' › ')}`;
          entry.details.classList.toggle('failed', update.isError);
          richText(entry.body, update.text || 'Completed.');
        }
        if (update.type === 'error' || update.type === 'status') notice(update.text);
        if (update.type === 'done') finished = true;
        scrollDown();
      }
      if (done) { if (!finished) throw new Error('Connection interrupted. Refresh to see saved progress; retry only after checking the result.'); break; }
    }
  } catch (error) { notice(error.message); if (!accepted) $('message').value = draft; }
  finally {
    setRunning(false);
    try { await refresh(); } catch (error) { notice(error.message); }
    $('message').focus();
  }
});

refresh({ history: true }).catch(error => notice(`Could not connect: ${error.message}`));

let editingDocument = null, documentBusy = false;
const documentUrlHint = $('document-url-help').textContent;

function setDocumentBusy(value) {
  documentBusy = value;
  $('document-fields').disabled = value;
  document.querySelectorAll('[data-document-action]').forEach(button => { button.disabled = value; });
}

function setDocumentEditor(doc) {
  editingDocument = doc;
  $('document-form').reset();
  $('document-upload-fields').hidden = !!doc;
  $('document-title-optional').hidden = !!doc;
  $('document-title').required = !!doc;
  $('document-url').required = !!doc && !doc.source.path;
  $('document-form-heading').textContent = doc ? 'Edit document' : 'Add document';
  $('document-editing-id').hidden = !doc;
  $('document-editing-id').textContent = doc ? `ID: ${doc.id}` : '';
  $('document-submit').textContent = doc ? 'Save changes' : 'Add to collection';
  $('document-cancel').hidden = !doc;
  $('document-url-help').textContent = doc ? (doc.source.path ? 'Leave the URL blank to use this document’s local source file.' : 'This document needs a source URL.') : documentUrlHint;
  if (doc) {
    $('document-title').value = doc.title;
    $('document-url').value = doc.source.url || '';
    for (const option of $('document-existing-themes').options) option.selected = doc.themes.includes(option.value);
  }
}

async function runDocumentIngestion(endpoint, options, { start, complete, resetEditor = false }) {
  if (documentBusy) return;
  setDocumentBusy(true);
  const progress = $('document-progress');
  progress.textContent = start;
  progress.scrollIntoView({ block: 'nearest' });
  try {
    const response = await api(endpoint, options);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', finished = false;
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const update = JSON.parse(line);
        if (update.type === 'error') throw new Error(`${update.catalogueSaved ? (update.documentStatus === 'stale' ? 'Catalogue entry saved; the previous indexed version is retained as stale. ' : 'The document is saved in the catalogue but not indexed. ') : ''}${update.error}`);
        if (update.type === 'done') {
          finished = true;
          progress.textContent = update.unchanged ? 'No changes to save.' : update.metadataOnly ? 'Theme memberships updated.' : update.skipped ? 'Already indexed; document is unchanged.' : `${complete}: ${update.chunks} searchable passage${update.chunks === 1 ? '' : 's'}.`;
          if (resetEditor) setDocumentEditor(null);
        } else if (update.stage === 'embedding') progress.textContent = `Indexing passages: ${update.completed} of ${update.total}…`;
        else progress.textContent = ({ reading: 'Reading document…', extracting: 'Extracting text…', saving: 'Saving to your collection…' })[update.stage] || 'Ingesting document…';
      }
      if (done) { if (!finished) throw new Error('Connection interrupted. Reopen Documents to check the ingestion result.'); break; }
    }
  } catch (error) { progress.textContent = error.message; }
  finally { setDocumentBusy(false); await refreshDocuments().catch(error => { progress.textContent = error.message; }); }
}

async function refreshDocuments() {
  const collection = await (await api('/api/documents')).json();
  const selection = new Set([...$('document-existing-themes').selectedOptions].map(option => option.value));
  $('document-existing-themes').replaceChildren();
  for (const theme of [...new Set(collection.documents.flatMap(doc => doc.themes))].sort()) {
    const option = document.createElement('option'); option.value = theme; option.textContent = theme; option.selected = selection.has(theme);
    $('document-existing-themes').append(option);
  }
  $('document-list').replaceChildren();
  if (!collection.documents.length) $('document-list').textContent = 'Your collection is empty.';
  for (const doc of collection.documents) {
    const item = document.createElement('li');
    const title = document.createElement('strong'); title.textContent = doc.title;
    const identifier = document.createElement('p'); identifier.className = 'document-id'; identifier.textContent = `ID: ${doc.id}`;
    const meta = document.createElement('p');
    meta.textContent = `${doc.themes.join(' · ')} — ${doc.status.status}${doc.status.chunks ? ` · ${doc.status.chunks} passage${doc.status.chunks === 1 ? '' : 's'}` : ''}`;
    const source = document.createElement('p');
    source.className = 'small muted';
    source.textContent = doc.source.url || `Local source: ${doc.source.path}`;
    item.append(title, identifier, meta, source);
    if (doc.status.error) { const error = document.createElement('p'); error.className = 'error'; error.textContent = doc.status.error; item.append(error); }
    const actions = document.createElement('div'); actions.className = 'document-actions';
    if (['failed', 'stale'].includes(doc.status.status)) {
      const hint = document.createElement('p'); hint.className = 'small muted';
      hint.textContent = 'Check the source and local Ollama service, then retry. You can edit an incorrect source URL.';
      item.append(hint);
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.dataset.documentAction = 'retry';
      retry.disabled = documentBusy; retry.setAttribute('aria-label', `Retry ${doc.title}`);
      retry.addEventListener('click', () => runDocumentIngestion('/api/documents/retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: doc.id }),
      }, { start: `Retrying ${doc.title}…`, complete: 'Document retried' }));
      actions.append(retry);
      if (doc.source.path) {
        const replacement = document.createElement('input'); replacement.type = 'file'; replacement.hidden = true;
        replacement.accept = $('document-file').accept; replacement.dataset.documentAction = 'replacement-input'; replacement.disabled = documentBusy;
        const replace = document.createElement('button'); replace.type = 'button'; replace.textContent = 'Replace file'; replace.dataset.documentAction = 'replace';
        replace.disabled = documentBusy; replace.setAttribute('aria-label', `Choose replacement file for ${doc.title}`);
        replace.addEventListener('click', () => replacement.click());
        replacement.addEventListener('change', async () => {
          const file = replacement.files[0];
          if (!file) return;
          if (!file.size || file.size > 25 * 1024 * 1024) {
            $('document-progress').textContent = 'Choose a nonempty replacement file no larger than 25 MiB.';
            replacement.value = ''; return;
          }
          const parameters = new URLSearchParams({ id: doc.id, name: file.name });
          await runDocumentIngestion(`/api/documents/retry?${parameters}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file },
            { start: `Uploading replacement for ${doc.title}…`, complete: 'Source file replaced' });
          replacement.value = '';
        });
        const replacementHint = document.createElement('p'); replacementHint.className = 'small muted';
        replacementHint.textContent = 'If the local source is missing, choose a replacement file. Its ID, title and themes are kept.';
        if (doc.source.url) replacementHint.textContent += ' The source URL is kept for future rebuilds.';
        item.append(replacementHint); actions.append(replace, replacement);
      }
    }
    const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit'; edit.dataset.documentAction = 'edit';
    edit.disabled = documentBusy; edit.setAttribute('aria-label', `Edit ${doc.title}`);
    edit.addEventListener('click', () => {
      setDocumentEditor(doc); $('document-progress').textContent = '';
      $('document-form-heading').scrollIntoView({ block: 'start' }); $('document-title').focus();
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.className = 'document-remove';
    remove.dataset.documentAction = 'remove'; remove.disabled = documentBusy; remove.setAttribute('aria-label', `Remove ${doc.title}`);
    const removalNote = document.createElement('p'); removalNote.className = 'small muted'; removalNote.hidden = true;
    removalNote.textContent = 'Remove this document from every theme? Original source files will be kept.';
    const cancelRemoval = document.createElement('button'); cancelRemoval.type = 'button'; cancelRemoval.textContent = 'Cancel'; cancelRemoval.hidden = true;
    cancelRemoval.dataset.documentAction = 'cancel-remove'; cancelRemoval.setAttribute('aria-label', `Cancel removal of ${doc.title}`);
    cancelRemoval.addEventListener('click', () => {
      cancelRemoval.hidden = true; removalNote.hidden = true;
      remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${doc.title}`);
    });
    remove.addEventListener('click', async () => {
      if (cancelRemoval.hidden) {
        cancelRemoval.hidden = false; removalNote.hidden = false;
        remove.textContent = 'Confirm removal'; remove.setAttribute('aria-label', `Confirm removal of ${doc.title}`);
        return;
      }
      setDocumentBusy(true);
      const progress = $('document-progress'); progress.textContent = 'Removing document…';
      try {
        await api('/api/documents/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: doc.id }) });
        if (editingDocument?.id === doc.id) setDocumentEditor(null);
        progress.textContent = 'Removed from the collection. Source files are kept.';
      } catch (error) { progress.textContent = error.message; }
      finally { setDocumentBusy(false); await refreshDocuments().catch(error => { progress.textContent = error.message; }); progress.scrollIntoView({ block: 'nearest' }); }
    });
    actions.append(edit, remove, cancelRemoval); item.append(removalNote, actions);
    $('document-list').append(item);
  }
  if (collection.progress) $('document-progress').textContent = `Ingesting ${collection.progress.title || 'a document'}…`;
}

$('open-documents').addEventListener('click', () => {
  $('documents-dialog').showModal();
  refreshDocuments().catch(error => { $('document-progress').textContent = error.message; });
});
$('close-documents').addEventListener('click', () => $('documents-dialog').close());
$('document-cancel').addEventListener('click', () => { setDocumentEditor(null); $('document-progress').textContent = ''; });
$('document-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (documentBusy) return;
  const editing = editingDocument;
  const file = $('document-file').files[0];
  const url = $('document-url').value.trim();
  const title = $('document-title').value.trim();
  const themes = [...$('document-existing-themes').selectedOptions].map(option => option.value)
    .concat($('document-new-themes').value.split(',').map(value => value.trim()).filter(Boolean));
  const progress = $('document-progress');
  if ((!editing && !file && !url) || !themes.length) { progress.textContent = 'Choose a source and at least one theme.'; return; }
  if (editing && !title) { progress.textContent = 'Enter a document title.'; return; }
  if (file?.size > 25 * 1024 * 1024) { progress.textContent = 'Documents must be no larger than 25 MiB.'; return; }
  const parameters = new URLSearchParams({ title, url, themes: JSON.stringify(themes), ...(file ? { name: file.name } : {}) });
  await runDocumentIngestion(editing ? '/api/documents/update' : `/api/documents/ingest${file ? `?${parameters}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': !editing && file ? 'application/octet-stream' : 'application/json' },
    body: editing ? JSON.stringify({ id: editing.id, title, url, themes }) : file || JSON.stringify({ title, url, themes }),
  }, { start: editing ? 'Saving document…' : file ? 'Uploading document…' : 'Downloading document…',
    complete: editing ? 'Document updated' : 'Added to collection', resetEditor: true });
});
