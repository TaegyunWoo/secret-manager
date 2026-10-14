(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const view = $('#view');
  const dialog = $('#dialog');
  const dialogContent = $('#dialog-content');
  const state = { projects: [], environments: [], projectId: '', environmentId: '', view: 'secrets', revision: 0 };
  let dialogRevision = 0;
  let loadRevision = 0;
  let workspaceRevision = 0;
  let releaseDialog = () => {};
  const views = {
    secrets: ['시크릿', '프로젝트에서 사용할 환경변수와 파일을 관리하세요.'],
    trash: ['휴지통', '삭제된 시크릿은 7일 동안 복원할 수 있습니다.'],
    policies: ['CI 정책', '환경별로 GitHub Actions 접근 조건을 관리하세요.'],
    audit: ['감사 기록', '최근 접근과 변경 기록을 확인하세요.'],
    backup: ['백업·복구', '암호화된 데이터와 정책을 보관하고 빈 데이터베이스에 복구하세요.'],
  };
  function element(tag, text, attrs = {}) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === undefined || value === null) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
    return node;
  }
  function group(className, ...children) {
    const node = element('div', null, { class: className });
    node.append(...children);
    return node;
  }
  function button(label, action, className = '') {
    const node = element('button', label, { type: 'button', class: className });
    node.addEventListener('click', () => run(node, action));
    return node;
  }
  function message(text, error = false) {
    const status = $('#status');
    status.textContent = text;
    status.classList.toggle('error', error);
    const local = $('#dialog-status');
    if (local) { local.textContent = text; local.classList.toggle('error', error); }
  }
  const errors = {
    400: '입력 내용을 확인하세요.', 401: '로그인이 만료되었습니다. 새로고침 후 다시 로그인하세요.',
    403: '이 작업에 접근할 권한이 없습니다.', 404: '항목을 찾을 수 없습니다. 새로고침하세요.',
    409: '다른 변경과 충돌하거나 이름이 사용 중입니다. 새로고침 후 다시 확인하세요.',
    413: '파일이나 입력 내용이 너무 큽니다.', 415: '지원하지 않는 요청 형식입니다.',
  };
  async function api(path, method = 'GET', body) {
    const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body ?? {}); }
    const response = await fetch(`/api${path}`, init);
    if (!response.ok) {
      const error = new Error(errors[response.status] ?? '요청을 처리하지 못했습니다. 잠시 후 새로고침하세요.');
      error.chunkRequired = response.status === 413 && response.headers.get('x-psm-chunk-required') === '1';
      throw error;
    }
    return response.json();
  }
  const backupTables = ['projects', 'environments', 'secrets', 'secret_versions', 'ci_policies', 'audit_events'];
  const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
  function splitRows(rows, limit, imports = false) {
    const chunks = []; let chunk = [], valueBytes = 0;
    for (const row of rows) {
      const bytes = imports ? new TextEncoder().encode(row.value).length : 0;
      if (chunk.length && (chunk.length >= limit || jsonBytes([...chunk, row]) > 90000 || valueBytes + bytes > 65536)) {
        chunks.push(chunk); chunk = []; valueBytes = 0;
      }
      chunk.push(row); valueBytes += bytes;
    }
    if (chunk.length) chunks.push(chunk);
    return chunks;
  }
  async function preparedOperation(input, groups, current) {
    if (!current()) return false;
    const operation = await api('/operations', 'POST', input);
    let committed = false;
    try {
      let index = 0;
      for (const [table, rows] of groups) {
        if (!current()) return false;
        message(`내용을 준비하는 중입니다. (${index + 1} / ${groups.length})`);
        await api(`/operations/${encodeURIComponent(operation.id)}/chunks`, 'POST', { index: index++, table, rows });
      }
      if (!current()) return false;
      await api(`/operations/${encodeURIComponent(operation.id)}/commit`, 'POST', {});
      committed = true; return true;
    } finally {
      if (!committed) await api(`/operations/${encodeURIComponent(operation.id)}`, 'DELETE', {}).catch(() => {});
    }
  }
  async function importEntries(environmentId, entries, current) {
    const large = entries.length > 10 || jsonBytes(entries) > 90000 || entries.reduce((bytes, entry) => bytes + new TextEncoder().encode(entry.value).length, 0) > 65536;
    try {
      if (large) throw Object.assign(new Error(errors[413]), { chunkRequired: true });
      await api('/imports/apply', 'POST', { environmentId, entries });
    }
    catch (error) {
      if (!error.chunkRequired) throw error;
      if (jsonBytes(entries) > 131072) throw new Error(errors[413]);
      const groups = splitRows(entries, 10, true).map((rows) => ['imports', rows]);
      if (!await preparedOperation({ kind: 'import', environmentId, counts: { imports: entries.length } }, groups, current)) return;
    }
    if (!current()) return;
    closeDialog(); await loadView(); message('저장되었습니다.');
  }
  async function encryptedBackup(current) {
    try { return await api('/backup'); }
    catch (error) { if (!error.chunkRequired) throw error; }
    if (!current()) return null;
    const operation = await api('/operations', 'POST', { kind: 'export' });
    try {
      const backup = { schemaVersion: 1, createdAt: operation.createdAt, tables: {} };
      for (const table of backupTables) {
        const count = operation.counts?.[table];
        if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error(errors[400]);
        const rows = []; let index = 0;
        do {
          if (!current()) return null;
          message('암호화 백업을 준비하는 중입니다.');
          const page = await api(`/operations/${encodeURIComponent(operation.id)}/chunks?table=${table}&index=${index}`);
          if (!Array.isArray(page.rows) || page.rows.length > 100) throw new Error(errors[400]);
          rows.push(...page.rows);
          if (page.nextIndex === null) break;
          if (!Number.isInteger(page.nextIndex) || page.nextIndex <= index || page.nextIndex > count) throw new Error(errors[400]);
          index = page.nextIndex;
        } while (true);
        if (rows.length !== count) throw new Error(errors[400]);
        backup.tables[table] = rows;
        if (jsonBytes(backup) > 1048576) throw new Error(errors[413]);
      }
      return backup;
    } finally { await api(`/operations/${encodeURIComponent(operation.id)}`, 'DELETE', {}).catch(() => {}); }
  }
  async function restoreEncryptedBackup(backup, current) {
    try {
      if (jsonBytes(backup) > 90000 || (Array.isArray(backup.tables?.secret_versions) && backup.tables.secret_versions.length > 10)) throw Object.assign(new Error(errors[413]), { chunkRequired: true });
      await api('/backup/restore', 'POST', backup); return true;
    }
    catch (error) { if (!error.chunkRequired) throw error; }
    if (backup.schemaVersion !== 1 || !Number.isSafeInteger(backup.createdAt) || backup.createdAt < 0 || !backup.tables || Object.keys(backup).sort().join(',') !== 'createdAt,schemaVersion,tables' || Object.keys(backup.tables).sort().join(',') !== [...backupTables].sort().join(',') || jsonBytes(backup) > 1048576) throw new Error(errors[400]);
    const counts = {}, groups = [];
    for (const table of backupTables) {
      if (!Array.isArray(backup.tables[table])) throw new Error(errors[400]);
      counts[table] = backup.tables[table].length;
      groups.push(...splitRows(backup.tables[table], table === 'secret_versions' ? 10 : 100).map((rows) => [table, rows]));
    }
    return preparedOperation({ kind: 'restore', counts, createdAt: backup.createdAt }, groups, current);
  }
  function contextScope() {
    const revision = state.revision;
    return () => revision === state.revision;
  }
  function workspaceScope() {
    const revision = workspaceRevision;
    return () => revision === workspaceRevision;
  }
  function scope() {
    const current = contextScope();
    const modal = dialogRevision;
    return () => current() && modal === dialogRevision;
  }
  async function run(node, task) {
    if (node.disabled) return;
    node.disabled = true;
    let current = scope();
    try { const pending = task(); current = scope(); await pending; }
    catch (error) {
      if (current()) message(error instanceof Error && Object.values(errors).includes(error.message) ? error.message : '요청을 처리하지 못했습니다. 입력과 연결 상태를 확인하세요.', true);
    } finally { if (node.isConnected) node.disabled = false; }
  }
  function clearDialog() {
    dialogRevision++;
    releaseDialog();
    releaseDialog = () => {};
    // Clear detached inputs too: event handlers may still retain their nodes.
    dialogContent.querySelectorAll('input, textarea').forEach((input) => { input.value = ''; });
    dialogContent.replaceChildren();
  }
  function closeDialog() {
    if (dialog.open) dialog.close();
    clearDialog();
  }
  dialog.addEventListener('close', () => { if (!dialog.open) clearDialog(); });
  dialog.addEventListener('cancel', clearDialog);
  function openDialog(title) {
    clearDialog();
    const heading = element('h2', title, { id: 'dialog-title', tabindex: '-1' });
    const content = group('stack');
    const status = element('p', '', { id: 'dialog-status', class: 'status', role: 'status', 'aria-live': 'polite' });
    dialogContent.append(heading, content, status, group('dialog-actions', button('닫기', closeDialog)));
    if (!dialog.open) dialog.showModal();
    heading.focus();
    return content;
  }
  function field(form, label, name, type = 'text', value = '', attrs = {}) {
    const input = element(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', null, { id: `field-${name}`, name, ...(type === 'textarea' || type === 'select' ? {} : { type }), ...attrs });
    input.value = value;
    form.append(group('field', element('label', label, { for: `field-${name}` }), input));
    return input;
  }
  function form(content, label, action) {
    const node = element('form');
    const submit = element('button', label, { type: 'submit', class: 'primary' });
    node.addEventListener('submit', (event) => { event.preventDefault(); run(submit, action); });
    content.append(node);
    return { node, submit, finish: () => node.append(group('dialog-actions', submit)) };
  }
  function selectOptions(select, entries, current, placeholder) {
    select.replaceChildren();
    if (!entries.length) select.append(element('option', placeholder, { value: '' }));
    for (const entry of entries) select.append(element('option', entry.name, { value: entry.id }));
    select.value = current;
    select.disabled = !entries.length;
  }
  function date(timestamp) { return new Date(timestamp).toLocaleString('ko-KR'); }
  function table(headers, rows, caption) {
    const node = element('table');
    node.append(element('caption', caption));
    const head = element('thead');
    const titles = element('tr');
    headers.forEach((label) => titles.append(element('th', label, { scope: 'col' })));
    head.append(titles);
    const body = element('tbody');
    for (const cells of rows) {
      const row = element('tr');
      for (const value of cells) {
        const cell = element('td');
        cell.append(typeof value === 'object' ? value : document.createTextNode(String(value)));
        row.append(cell);
      }
      body.append(row);
    }
    node.append(head, body);
    return group('table-wrap', node);
  }
  function empty(text) { return group('empty-state', element('p', text)); }
  async function refreshWorkspace() {
    workspaceRevision++;
    const current = workspaceScope();
    const { projects } = await api('/projects');
    if (!current()) return;
    state.projects = projects;
    state.projectId = projects.some((p) => p.id === state.projectId) ? state.projectId : projects[0]?.id ?? '';
    selectOptions($('#project-select'), projects, state.projectId, '프로젝트 없음');
    await refreshEnvironments();
  }
  async function refreshEnvironments() {
    const current = workspaceScope();
    const projectId = state.projectId;
    const environments = projectId ? (await api(`/environments?projectId=${encodeURIComponent(projectId)}`)).environments : [];
    if (!current() || projectId !== state.projectId) return;
    state.environments = environments;
    state.environmentId = environments.some((e) => e.id === state.environmentId) ? state.environmentId : environments[0]?.id ?? '';
    selectOptions($('#environment-select'), environments, state.environmentId, '환경 없음');
    await loadView();
  }
  function navigate() {
    state.revision++;
    loadRevision++;
    closeDialog();
    view.replaceChildren();
    message('불러오는 중입니다.');
  }
  async function loadView() {
    const revision = ++loadRevision;
    const current = contextScope();
    const selected = state.view;
    $('#view-title').textContent = views[selected][0];
    $('#view-description').textContent = views[selected][1];
    const project = state.projects.find((p) => p.id === state.projectId);
    const environment = state.environments.find((e) => e.id === state.environmentId);
    $('#context-label').textContent = [project?.name, environment?.name].filter(Boolean).join(' / ') || '나의 작업 공간';
    document.querySelectorAll('[data-view]').forEach((node) => {
      if (node.dataset.view === selected) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    });
    view.replaceChildren();
    if (!state.environmentId && ['secrets', 'trash', 'policies'].includes(selected)) {
      view.append(empty('프로젝트·환경 관리에서 프로젝트와 환경을 추가하세요.'));
      message('작업 공간을 선택하세요.');
      return;
    }
    try {
      let data;
      if (selected === 'secrets') data = await api(`/secrets?environmentId=${encodeURIComponent(state.environmentId)}`);
      else if (selected === 'trash') data = await api(`/trash?environmentId=${encodeURIComponent(state.environmentId)}`);
      else if (selected === 'policies') data = await api(`/ci-policies?environmentId=${encodeURIComponent(state.environmentId)}`);
      else if (selected === 'audit') data = await api('/audit-events?limit=100');
      if (!current() || revision !== loadRevision) return;
      if (selected === 'secrets') renderSecrets(data.secrets);
      else if (selected === 'trash') renderTrash(data.secrets);
      else if (selected === 'policies') renderPolicies(data.policies);
      else if (selected === 'audit') renderAudit(data.events);
      else renderBackup();
      message('준비되었습니다.');
    } catch (error) {
      if (current() && revision === loadRevision) {
        view.append(group('panel', button('새로고침', loadView)));
        message(Object.values(errors).includes(error.message) ? error.message : '목록을 불러오지 못했습니다. 새로고침하세요.', true);
      }
    }
  }
  async function saved(path, method, body, current) {
    await api(path, method, body);
    if (!current()) return;
    closeDialog();
    await loadView();
    message('저장되었습니다.');
  }
  function renderSecrets(secrets) {
    const search = element('input', null, { type: 'search', placeholder: '시크릿 이름 검색', 'aria-label': '시크릿 이름 검색' });
    const list = group('stack');
    const render = () => {
      const visible = secrets.filter((s) => s.name.toLowerCase().includes(search.value.toLowerCase()));
      list.replaceChildren(visible.length ? table(['이름', '유형', '최근 변경', '작업'], visible.map((secret) => [
        element('code', secret.name), element('span', secret.kind === 'file' ? '파일' : '환경변수', { class: 'badge' }), date(secret.updatedAt),
        group('actions', button('보기', () => reveal(secret, 'view')), button('복사', () => reveal(secret, 'copy')), button('다운로드', () => reveal(secret, 'download')), button('편집', () => secretForm(secret)), button('버전', () => versions(secret)), button('삭제', () => deleteSecret(secret), 'danger')),
      ]), '시크릿 목록') : empty('시크릿이 없습니다. 새 시크릿을 추가하세요.'));
    };
    search.addEventListener('input', render);
    view.append(group('toolbar', search, group('actions', button('.env 가져오기', importForm), button('시크릿 추가', () => secretForm(), 'primary'), button('새로고침', loadView))), list);
    render();
  }
  async function reveal(secret, mode) {
    const content = mode === 'view' ? openDialog(`${secret.name} · 원문`) : null;
    const current = scope();
    if (content) content.append(element('p', '원문을 불러오는 중입니다.', { class: 'muted' }));
    const revealed = await api(`/secrets/${encodeURIComponent(secret.id)}/reveal`, 'POST', {});
    if (!current()) return;
    if (mode === 'view') content.replaceChildren(element('pre', revealed.value, { tabindex: '0', 'aria-label': '시크릿 원문' }));
    else if (mode === 'copy') {
      await navigator.clipboard.writeText(revealed.value);
      if (current()) message('원문을 클립보드에 복사했습니다.');
    } else { download(revealed.value, `${secret.name}.${secret.kind === 'file' ? 'pem' : 'txt'}`, 'text/plain;charset=utf-8'); message('다운로드를 시작했습니다.'); }
  }
  function download(value, filename, type) {
    const url = URL.createObjectURL(new Blob([value], { type }));
    const anchor = element('a', null, { href: url, download: filename.replace(/[^\p{L}\p{N}_.-]/gu, '_') });
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function secretForm(secret) {
    const content = openDialog(secret ? '시크릿 편집' : '시크릿 추가');
    const environmentId = state.environmentId;
    let rawValue = null;
    let fileRevision = 0;
    let valueReady = true;
    const f = form(content, '저장', async () => {
      if ((!secret || replace.checked) && !valueReady) { message('새 파일을 선택하거나 원문을 직접 입력하세요.', true); return; }
      const current = scope();
      const body = { name: name.value, kind: kind.value };
      if (!secret || replace.checked) body.value = rawValue ?? value.value;
      if (secret) body.expectedVersionId = secret.currentVersionId;
      else body.environmentId = environmentId;
      await saved(secret ? `/secrets/${encodeURIComponent(secret.id)}` : '/secrets', secret ? 'PATCH' : 'POST', body, current);
    });
    const name = field(f.node, '이름', 'name', 'text', secret?.name ?? '', { required: true, maxlength: 128 });
    const kind = field(f.node, '유형', 'kind', 'select');
    kind.append(element('option', '환경변수', { value: 'env' }), element('option', '파일 (PEM 등)', { value: 'file' }));
    kind.value = secret?.kind ?? 'env';
    const replace = element('input', null, { type: 'checkbox', name: 'replace', id: 'replace-value' });
    replace.checked = !secret;
    if (secret) {
      const label = element('label', null, { for: 'replace-value' }); label.append(replace, document.createTextNode('원문 변경'));
      f.node.append(label, element('p', '원문 변경을 선택하지 않으면 현재 값이 유지됩니다.', { class: 'help' }));
    }
    const valueGroup = group('stack');
    f.node.append(valueGroup);
    const value = field(valueGroup, '원문', 'value', 'textarea', '', { spellcheck: false, autocomplete: 'off' });
    value.addEventListener('input', () => { rawValue = null; fileRevision++; valueReady = true; f.submit.disabled = false; });
    const file = field(valueGroup, '텍스트 파일 업로드', 'file', 'file');
    const fileInfo = element('p', '업로드한 UTF-8 파일은 줄바꿈과 BOM을 그대로 저장합니다.', { class: 'help' });
    valueGroup.append(fileInfo);
    function beginValueRead() {
      rawValue = null; value.value = ''; valueReady = false; f.submit.disabled = true;
      return ++fileRevision;
    }
    file.addEventListener('change', () => run(file, async () => {
      const current = scope();
      const revision = beginValueRead();
      const uploaded = file.files?.[0];
      if (!uploaded) { fileInfo.textContent = '파일을 선택하거나 원문을 직접 입력하세요.'; return; }
      if (uploaded.size > 65536) {
        fileInfo.textContent = '64 KiB 이하의 파일을 선택하거나 원문을 직접 입력하세요.';
        message('파일이나 입력 내용이 너무 큽니다.', true); return;
      }
      fileInfo.textContent = '파일을 읽는 중입니다.';
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await uploaded.arrayBuffer());
        if (!current() || revision !== fileRevision) return;
        rawValue = decoded; value.value = decoded; kind.value = 'file'; valueReady = true;
        fileInfo.textContent = '파일을 읽었습니다. 원문을 수정하지 않으면 원래 줄바꿈과 BOM이 유지됩니다.';
      } catch {
        if (current() && revision === fileRevision) {
          fileInfo.textContent = '파일 읽기에 실패했습니다. 새 UTF-8 파일을 선택하거나 원문을 직접 입력하세요.';
          message('파일을 읽지 못했습니다. UTF-8 형식과 파일 상태를 확인하세요.', true);
        }
      } finally { if (current() && revision === fileRevision) f.submit.disabled = !valueReady; }
    }));
    if (secret) valueGroup.prepend(button('현재 값 불러오기', async () => {
      const current = scope();
      const revision = beginValueRead();
      fileInfo.textContent = '현재 원문을 불러오는 중입니다.';
      try {
        const revealed = await api(`/secrets/${encodeURIComponent(secret.id)}/reveal`, 'POST', {});
        if (!current() || revision !== fileRevision) return;
        rawValue = revealed.value; value.value = revealed.value; valueReady = true;
        fileInfo.textContent = '현재 원문을 불러왔습니다. 수정하지 않으면 원래 줄바꿈과 BOM이 유지됩니다.';
      } catch (error) {
        if (current() && revision === fileRevision) fileInfo.textContent = '원문을 불러오지 못했습니다. 다시 요청하거나 원문을 직접 입력하세요.';
        throw error;
      } finally { if (current() && revision === fileRevision) f.submit.disabled = !valueReady; }
    }));
    replace.addEventListener('change', () => {
      valueGroup.hidden = !replace.checked;
      if (!replace.checked) { rawValue = null; value.value = ''; file.value = ''; fileRevision++; valueReady = true; f.submit.disabled = false; }
    });
    valueGroup.hidden = !replace.checked;
    releaseDialog = () => { rawValue = null; value.value = ''; valueReady = false; fileRevision++; };
    f.finish();
  }
  function importForm() {
    const content = openDialog('.env 가져오기');
    const environmentId = state.environmentId;
    let entries = [];
    let source;
    releaseDialog = () => { entries = []; if (source) source.value = ''; };
    const f = form(content, '미리보기', async () => {
      const current = scope();
      const preview = await api('/imports/preview', 'POST', { environmentId, source: source.value });
      if (!current()) return;
      entries = preview.entries;
      source.value = '';
      content.replaceChildren();
      content.append(element('p', '새 항목은 기본 선택됩니다. 기존 항목을 덮어쓰려면 직접 선택하세요. 휴지통 이름은 복원하거나 보존 기간이 끝날 때까지 사용할 수 없습니다.', { class: 'notice' }));
      const choices = [];
      const apply = form(content, '선택 항목 적용', async () => {
        const current = scope();
        const selected = entries.filter((entry, index) => choices[index].checked && !entry.deleted).map((entry) => ({ name: entry.name, value: entry.value, ...(entry.exists ? { expectedVersionId: entry.expectedVersionId } : {}) }));
        if (!selected.length) { message('적용할 항목을 선택하세요.', true); return; }
        await importEntries(environmentId, selected, current);
      });
      for (const entry of entries) {
        const checkbox = element('input', null, { type: 'checkbox', disabled: entry.deleted });
        checkbox.checked = !entry.exists && !entry.deleted;
        choices.push(checkbox);
        const label = element('label');
        label.append(checkbox, document.createTextNode(`${entry.name} · ${entry.deleted ? '휴지통 (선택 불가)' : entry.exists ? '덮어쓰기' : '새 항목'}`));
        apply.node.append(label);
      }
      apply.finish();
    });
    source = field(f.node, '.env 내용', 'source', 'textarea', '', { required: true, spellcheck: false, autocomplete: 'off' });
    f.finish();
  }
  function confirmAction(title, description, label, action) {
    const content = openDialog(title);
    content.append(element('p', description, { class: 'notice' }), group('dialog-actions', button(label, action, label === '삭제 확인' ? 'danger' : 'primary')));
  }
  function deleteSecret(secret) {
    confirmAction('시크릿 삭제', `${secret.name} 항목을 휴지통으로 이동합니다. 7일 안에 복원할 수 있습니다.`, '삭제 확인', () => saved(`/secrets/${encodeURIComponent(secret.id)}`, 'DELETE', { expectedVersionId: secret.currentVersionId }, scope()));
  }
  async function versions(secret) {
    const content = openDialog(`${secret.name} · 버전`);
    const current = scope();
    const { versions } = await api(`/secrets/${encodeURIComponent(secret.id)}/versions`);
    if (!current()) return;
    content.append(element('p', '원문 없이 버전 정보를 표시합니다. 복원하면 새 버전이 만들어집니다.', { class: 'help' }));
    content.append(versions.length ? table(['생성 시각', '암호화 키', '작업'], versions.map((version) => [
      date(version.createdAt), version.keyId, version.id === secret.currentVersionId ? '현재 버전' : button('이 버전 복원', () => confirmAction('시크릿 버전 복원', `${secret.name}의 선택한 버전으로 원문을 복원합니다. 현재 버전도 이력에 남습니다.`, '복원 확인', () => saved(`/secrets/${encodeURIComponent(secret.id)}/versions/${encodeURIComponent(version.id)}/restore`, 'POST', { expectedVersionId: secret.currentVersionId }, scope()))),
    ]), '버전 이력') : empty('버전 이력이 없습니다.'));
  }
  function renderTrash(secrets) {
    view.append(group('toolbar', element('p', '보존 기간이 끝난 항목은 자동 삭제됩니다.', { class: 'help' }), button('새로고침', loadView)));
    view.append(secrets.length ? table(['이름', '유형', '삭제 시각', '작업'], secrets.map((secret) => [
      secret.name, secret.kind === 'file' ? '파일' : '환경변수', date(secret.deletedAt),
      button('복원', () => confirmAction('휴지통에서 복원', `${secret.name} 항목을 원래 환경으로 복원합니다.`, '복원 확인', () => saved(`/trash/${encodeURIComponent(secret.id)}/restore`, 'POST', { expectedVersionId: secret.currentVersionId }, scope()))),
    ]), '휴지통 목록') : empty('휴지통이 비어 있습니다.'));
  }
  function manageWorkspace() {
    const content = openDialog('프로젝트·환경 관리');
    const project = state.projects.find((p) => p.id === state.projectId);
    const environment = state.environments.find((e) => e.id === state.environmentId);
    content.append(element('p', '왼쪽 작업 공간에서 관리할 프로젝트와 환경을 선택하세요. 하위 항목이 있는 프로젝트나 환경은 삭제할 수 없습니다.', { class: 'notice' }));
    const projectActions = group('actions', button('프로젝트 추가', () => workspaceForm('project')));
    if (project) projectActions.append(button('프로젝트 편집', () => workspaceForm('project', project)), button('프로젝트 삭제', () => deleteWorkspace('project', project), 'danger'));
    const environmentActions = group('actions');
    if (project) environmentActions.append(button('환경 추가', () => workspaceForm('environment')));
    if (environment) environmentActions.append(button('환경 편집', () => workspaceForm('environment', environment)), button('환경 삭제', () => deleteWorkspace('environment', environment), 'danger'));
    content.append(group('panel', element('h3', project?.name ?? '프로젝트 없음'), projectActions), group('panel', element('h3', environment?.name ?? '환경 없음'), environmentActions));
  }
  async function savedWorkspace(path, method, body, current) {
    await api(path, method, body);
    if (!current()) return;
    navigate();
    await refreshWorkspace();
    message('작업 공간이 저장되었습니다.');
  }
  function workspaceForm(kind, existing) {
    const project = kind === 'project';
    const content = openDialog(`${project ? '프로젝트' : '환경'} ${existing ? '편집' : '추가'}`);
    const projectId = state.projectId;
    const f = form(content, '저장', () => {
      const body = { name: name.value };
      if (project) body.slug = slug.value;
      else if (!existing) body.projectId = projectId;
      return savedWorkspace(`/${project ? 'projects' : 'environments'}${existing ? `/${encodeURIComponent(existing.id)}` : ''}`, existing ? 'PATCH' : 'POST', body, scope());
    });
    const name = field(f.node, '이름', 'name', 'text', existing?.name ?? '', { required: true, maxlength: 128 });
    const slug = project ? field(f.node, '슬러그 (CLI·CI에서 사용할 이름)', 'slug', 'text', existing?.slug ?? '', { required: true, maxlength: 128, pattern: '[a-z0-9]+(-[a-z0-9]+)*' }) : null;
    if (project) f.node.append(element('p', '소문자 영문, 숫자, 하이픈으로 입력하세요.', { class: 'help' }));
    f.finish();
  }
  function deleteWorkspace(kind, existing) {
    confirmAction(`${kind === 'project' ? '프로젝트' : '환경'} 삭제`, `${existing.name} 항목을 삭제합니다. 하위 항목이 비어 있어야 삭제할 수 있습니다.`, '삭제 확인', () => savedWorkspace(`/${kind === 'project' ? 'projects' : 'environments'}/${encodeURIComponent(existing.id)}`, 'DELETE', {}, scope()));
  }
  function checkbox(formNode, labelText, name, checked) {
    const node = element('input', null, { type: 'checkbox', name, id: `field-${name}` });
    node.checked = checked;
    const label = element('label', null, { for: `field-${name}` });
    label.append(node, document.createTextNode(labelText)); formNode.append(label);
    return node;
  }
  function renderPolicies(policies) {
    view.append(group('toolbar', element('p', 'repository ID와 owner ID는 GitHub의 숫자 ID입니다.', { class: 'help' }), group('actions', button('정책 추가', () => policyForm(), 'primary'), button('새로고침', loadView))));
    view.append(policies.length ? table(['저장소 / 소유자', '허용 조건', '상태', '작업'], policies.map((policy) => [
      `${policy.repositoryId} / ${policy.repositoryOwnerId}`,
      group('stack', element('code', policy.branch), element('code', policy.workflow), element('span', policy.events.join(', ')), element('span', `GitHub 환경: ${policy.githubEnvironment ?? '지정 없음'}`)),
      policy.active ? '활성' : '비활성',
      group('actions', button('정책 편집', () => policyForm(policy)), button(policy.active ? '비활성화' : '활성화', () => saved(`/ci-policies/${encodeURIComponent(policy.id)}`, 'PATCH', { active: !policy.active }, scope())), button('정책 삭제', () => confirmAction('CI 정책 삭제', '이 정책으로 허용하던 GitHub Actions 접근이 중단됩니다.', '삭제 확인', () => saved(`/ci-policies/${encodeURIComponent(policy.id)}`, 'DELETE', {}, scope())), 'danger')),
    ]), 'CI 정책 목록') : empty('CI 정책이 없습니다. 필요한 저장소의 접근 조건을 추가하세요.'));
  }
  function policyForm(policy) {
    const content = openDialog(policy ? 'CI 정책 편집' : 'CI 정책 추가');
    const environmentId = state.environmentId;
    const f = form(content, '저장', () => {
      const events = [push.checked ? 'push' : null, dispatch.checked ? 'workflow_dispatch' : null].filter(Boolean);
      if (!events.length) { message('허용할 이벤트를 하나 이상 선택하세요.', true); return; }
      const input = {
        environmentId, repositoryId: repositoryId.value, repositoryOwnerId: repositoryOwnerId.value,
        branch: branch.value, workflow: workflow.value, events, githubEnvironment: githubEnvironment.value || null, active: active.checked,
      };
      if (policy) {
        for (const key of Object.keys(input)) if (JSON.stringify(input[key]) === JSON.stringify(policy[key])) delete input[key];
        if (!Object.keys(input).length) { closeDialog(); return loadView(); }
      }
      return saved(policy ? `/ci-policies/${encodeURIComponent(policy.id)}` : '/ci-policies', policy ? 'PATCH' : 'POST', input, scope());
    });
    const repositoryId = field(f.node, 'Repository ID', 'repositoryId', 'text', policy?.repositoryId ?? '', { required: true, inputmode: 'numeric', pattern: '[0-9]+' });
    const repositoryOwnerId = field(f.node, 'Repository owner ID', 'repositoryOwnerId', 'text', policy?.repositoryOwnerId ?? '', { required: true, inputmode: 'numeric', pattern: '[0-9]+' });
    const branch = field(f.node, '브랜치 ref', 'branch', 'text', policy?.branch ?? 'refs/heads/main', { required: true });
    const workflow = field(f.node, '워크플로 파일 경로', 'workflow', 'text', policy?.workflow ?? '.github/workflows/deploy.yml', { required: true });
    const githubEnvironment = field(f.node, 'GitHub Environment (선택)', 'githubEnvironment', 'text', policy?.githubEnvironment ?? '');
    const events = element('fieldset'); events.append(element('legend', '허용 이벤트'));
    const push = checkbox(events, 'push', 'push', policy?.events.includes('push') ?? false);
    const dispatch = checkbox(events, 'workflow_dispatch', 'workflow_dispatch', policy?.events.includes('workflow_dispatch') ?? true);
    f.node.append(events);
    const active = checkbox(f.node, '정책 활성화', 'active', policy?.active ?? true);
    f.node.append(element('p', '정책은 저장 즉시 적용됩니다. pull_request 이벤트는 허용하지 않습니다.', { class: 'help' }));
    f.finish();
  }
  function renderAudit(events) {
    view.append(group('toolbar', element('p', '최근 100건 · 시크릿 원문은 기록하지 않습니다.', { class: 'help' }), button('새로고침', loadView)));
    view.append(events.length ? table(['시각', '행위자', '작업', '대상', '결과'], events.map((event) => [date(event.createdAt), event.actor, event.action, event.targetId ?? '—', ({ success: '성공', denied: '거부', error: '오류' })[event.result] ?? '알 수 없음']), '감사 기록') : empty('감사 기록이 없습니다.'));
  }
  function renderBackup() {
    view.append(group('panel', element('h2', '암호화 백업'), element('p', '프로젝트·환경·시크릿 버전·CI 정책을 JSON으로 다운로드합니다. 암호화 키는 포함되지 않습니다. 복구에 필요한 키를 별도로 안전하게 보관하세요.', { class: 'notice' }), button('암호화 백업 다운로드', async () => {
      const current = scope();
      const backup = await encryptedBackup(current);
      if (!current() || !backup) return;
      download(JSON.stringify(backup), `psm-${new Date().toISOString().slice(0, 10)}.backup.json`, 'application/json');
      message('암호화 백업 다운로드를 시작했습니다.');
    }, 'primary')),
    group('panel', element('h2', '빈 데이터베이스에 복구'), element('p', '프로젝트·환경·시크릿·CI 정책이 없는 데이터베이스에만 복구할 수 있습니다. 감사 기록은 유지되고 복구된 CI 정책은 비활성화됩니다. 파일은 최대 1 MiB입니다.', { class: 'notice' }), button('백업 복구', backupForm)));
  }
  function backupForm() {
    const content = openDialog('암호화 백업 복구');
    let backup = null;
    let fileRevision = 0;
    const f = form(content, '복구 내용 확인', () => {
      if (!backup) { message('유효한 백업 파일을 먼저 선택하세요.', true); return; }
      let restore = backup;
      confirmAction('백업 복구 확인', '빈 데이터베이스에 업로드한 백업을 복구합니다. 복구된 CI 정책은 비활성화되며 암호화 키를 별도로 구성해야 합니다.', '복구 확인', async () => {
        const current = scope();
        if (!await restoreEncryptedBackup(restore, current)) return;
        if (!current()) return;
        navigate(); await refreshWorkspace();
        message('백업을 복구했습니다. 암호화 키와 비활성 CI 정책을 확인하세요.');
      });
      releaseDialog = () => { restore = null; };
    });
    const file = field(f.node, '백업 JSON 파일 (최대 1 MiB)', 'backup', 'file', '', { accept: '.json,application/json', required: true });
    const info = element('p', '백업 파일을 선택하세요.', { class: 'help' }); f.node.append(info);
    file.addEventListener('change', () => run(file, async () => {
      backup = null;
      const uploaded = file.files?.[0];
      const revision = ++fileRevision;
      if (!uploaded) return;
      if (uploaded.size > 1048576) { message('파일이나 입력 내용이 너무 큽니다.', true); return; }
      const current = scope();
      const parsed = JSON.parse(await uploaded.text());
      if (!current() || revision !== fileRevision) return;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { message('입력 내용을 확인하세요.', true); return; }
      backup = parsed;
      info.textContent = '백업 파일을 읽었습니다. 서버에서 형식과 빈 데이터베이스 조건을 검증합니다.';
    }));
    releaseDialog = () => { backup = null; fileRevision++; };
    f.finish();
  }
  $('#manage-workspace').addEventListener('click', () => run($('#manage-workspace'), manageWorkspace));
  $('#project-select').addEventListener('change', () => {
    workspaceRevision++;
    navigate(); state.projectId = $('#project-select').value; state.environmentId = '';
    $('#environment-select').disabled = true;
    run($('#project-select'), refreshEnvironments);
  });
  $('#environment-select').addEventListener('change', () => {
    navigate(); state.environmentId = $('#environment-select').value;
    run($('#environment-select'), loadView);
  });
  document.querySelectorAll('[data-view]').forEach((node) => node.addEventListener('click', () => {
    navigate(); state.view = node.dataset.view; run(node, loadView);
  }));
  run($('#manage-workspace'), refreshWorkspace);
})();
