import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const secret = { id: 's1', environmentId: 'e1', name: '<img src=x onerror=alert(1)>', kind: 'file', currentVersionId: 'v1', createdAt: 0, updatedAt: 0 };
type Request = { path: string; method: string; body: any };
type Reply = (request: Request) => unknown | Promise<unknown>;
async function setup(reply?: Reply) {
  const dom = new JSDOM(html, { url: 'https://vault.example', runScripts: 'outside-only' });
  const { window } = dom;
  const requests: Request[] = [];
  const downloads: Blob[] = [];
  const copied: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied.push(value); } } });
  window.TextDecoder = TextDecoder as any;
  window.Blob = Blob as any;
  window.URL.createObjectURL = (blob: Blob) => { downloads.push(blob); return 'blob:fixture'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    // Native close events are queued, including when another modal opens immediately.
    setTimeout(() => this.dispatchEvent(new window.Event('close')), 0);
  };
  window.fetch = (async (path: string, init?: RequestInit) => {
    const req = { path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    requests.push(req);
    const response = await reply?.(req);
    if (response instanceof Response) return response;
    if (response !== undefined) return Response.json(response);
    if (path === '/api/projects') return Response.json({ projects: [{ id: 'p1', name: 'App', slug: 'app' }] });
    if (path.startsWith('/api/environments')) return Response.json({ environments: [{ id: 'e1', projectId: 'p1', name: 'dev' }, { id: 'e2', projectId: 'p1', name: 'prod' }] });
    if (path.startsWith('/api/secrets?')) return Response.json({ secrets: [secret] });
    if (path.endsWith('/reveal')) return Response.json({ name: secret.name, kind: secret.kind, value: 'PRIVATE\r\nVALUE' });
    if (path.startsWith('/api/trash?')) return Response.json({ secrets: [secret] });
    if (path.endsWith('/versions')) return Response.json({ versions: [{ id: 'old', secretId: 's1', keyId: 'k1', createdAt: 0 }] });
    if (path.startsWith('/api/ci-policies?')) return Response.json({ policies: [] });
    if (path.startsWith('/api/audit-events')) return Response.json({ events: [] });
    return Response.json({ ok: true });
  }) as any;
  window.eval(script);
  await settle();
  const doc = window.document;
  const click = async (label: string) => {
    const node = [...doc.querySelectorAll('button')].find((button) => button.textContent === label);
    assert.ok(node, `button ${label} exists`);
    node.click();
    await settle();
  };
  const input = (name: string, value: string) => {
    const node = doc.querySelector(`#dialog [name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    assert.ok(node, `input ${name} exists`);
    node.value = value;
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
    node.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const submit = async () => {
    const form = doc.querySelector('#dialog form');
    assert.ok(form, 'form exists');
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };
  return { dom, window, doc, requests, copied, downloads, click, input, submit };
}
async function settle() { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); }

test('metadata uses safe text and reveals only explicitly, then clears on dismissal', async () => {
  const h = await setup();
  try {
    assert.match(h.doc.querySelector('#view')!.textContent!, /<img src=x onerror=alert\(1\)>/);
    assert.equal(h.doc.querySelector('#view img'), null);
    assert.equal(h.requests.some((r) => r.path.endsWith('/reveal')), false);
    await h.click('보기');
    assert.equal(h.doc.querySelector('#dialog pre')!.textContent, 'PRIVATE\r\nVALUE');
    assert.equal(h.requests.filter((r) => r.path.endsWith('/reveal'))[0]!.method, 'POST');
    await h.click('닫기');
    assert.equal(h.doc.querySelector('#dialog')!.textContent, '');
    await h.click('복사');
    assert.deepEqual(h.copied, ['PRIVATE\r\nVALUE']);
    assert.equal(h.doc.body.textContent!.includes('PRIVATE'), false);
  } finally { h.dom.window.close(); }
});

test('late reveal response cannot show a previous environment value', async () => {
  let resolve!: (value: unknown) => void;
  const h = await setup((r) => r.path.endsWith('/reveal') ? new Promise((done) => { resolve = done; }) : undefined);
  try {
    const button = [...h.doc.querySelectorAll('button')].find((b) => b.textContent === '보기')!;
    assert.ok(button, 'reveal button exists');
    button.click();
    await settle();
    const environment = h.doc.querySelector('#environment-select') as unknown as HTMLSelectElement;
    environment.value = 'e2';
    environment.dispatchEvent(new h.window.Event('change'));
    resolve({ name: 'old', kind: 'env', value: 'STALE_PRIVATE' });
    await settle();
    assert.equal(h.doc.body.textContent!.includes('STALE_PRIVATE'), false);
    assert.equal(h.doc.querySelector<HTMLDialogElement>('#dialog')!.open, false);
  } finally { h.dom.window.close(); }
});

test('dotenv preview hides plaintext and applies only chosen available entries with conflict versions', async () => {
  const h = await setup((r) => r.path === '/api/imports/preview' ? { entries: [
    { name: 'NEW', value: 'new-private', exists: false, deleted: false },
    { name: 'OLD', value: 'old-private', exists: true, deleted: false, expectedVersionId: 'v1' },
    { name: 'TRASH', value: 'trash-private', exists: true, deleted: true, expectedVersionId: 'v2' },
  ] } : undefined);
  try {
    await h.click('.env 가져오기');
    h.input('source', 'NEW=new-private\nOLD=old-private');
    await h.submit();
    assert.equal(h.doc.querySelector('textarea'), null);
    assert.equal(h.doc.querySelector('#dialog')!.textContent!.includes('old-private'), false);
    const choices = h.doc.querySelectorAll<HTMLInputElement>('#dialog input[type=checkbox]');
    assert.equal(choices.length, 3);
    assert.equal(choices[0]!.checked, true);
    assert.equal(choices[1]!.checked, false);
    assert.equal(choices[2]!.disabled, true);
    choices[0]!.checked = false;
    choices[1]!.checked = true;
    await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/imports/apply')!.body, { environmentId: 'e1', entries: [{ name: 'OLD', value: 'old-private', expectedVersionId: 'v1' }] });
    assert.equal(h.doc.querySelector('#dialog')!.textContent, '');
  } finally { h.dom.window.close(); }
});

test('safe Korean errors keep conflict input and never render an error body', async () => {
  const h = await setup((r) => r.method === 'POST' && r.path === '/api/secrets' ? new Response('PRIVATE_SERVER_EXCEPTION<script>x</script>', { status: 409 }) : undefined);
  try {
    await h.click('시크릿 추가');
    h.input('name', 'TOKEN'); h.input('value', 'private-input');
    await h.submit();
    assert.match(h.doc.querySelector('#dialog')!.textContent!, /다른 변경.*새로고침/);
    assert.equal(h.doc.body.textContent!.includes('PRIVATE_SERVER_EXCEPTION'), false);
    assert.equal(h.doc.querySelector<HTMLTextAreaElement>('[name=value]')!.value, 'private-input');
    assert.equal(h.doc.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled, false);
  } finally { h.dom.window.close(); }
});

test('file upload and explicit download preserve BOM and CRLF; metadata edit omits replacement', async () => {
  const raw = '\ufeff-----BEGIN PRIVATE KEY-----\r\nexample\r\n-----END PRIVATE KEY-----\r\n';
  const h = await setup((r) => r.path.endsWith('/reveal') ? { name: 'PEM', kind: 'file', value: raw } : undefined);
  try {
    await h.click('시크릿 추가');
    h.input('name', 'PEM');
    const upload = h.doc.querySelector<HTMLInputElement>('[name=file]')!;
    assert.ok(upload, 'upload exists');
    const bytes = new TextEncoder().encode(raw);
    Object.defineProperty(upload, 'files', { value: [{ size: bytes.length, arrayBuffer: async () => bytes.buffer }] });
    upload.dispatchEvent(new h.window.Event('change'));
    await settle();
    await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/secrets' && r.method === 'POST')!.body, { environmentId: 'e1', name: 'PEM', kind: 'file', value: raw });
    await h.click('다운로드');
    assert.deepEqual(new Uint8Array(await h.downloads[0]!.arrayBuffer()), new TextEncoder().encode(raw));
    const revealsBefore = h.requests.filter((r) => r.path.endsWith('/reveal')).length;
    await h.click('편집');
    assert.equal(h.requests.filter((r) => r.path.endsWith('/reveal')).length, revealsBefore);
    h.input('name', 'RENAMED');
    await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/secrets/s1' && r.method === 'PATCH')!.body, { name: 'RENAMED', kind: 'file', expectedVersionId: 'v1' });
  } finally { h.dom.window.close(); }
});

test('workspace forms send project/environment create update and confirmed delete contracts', async () => {
  const h = await setup();
  try {
    await h.click('프로젝트·환경 관리');
    await h.click('프로젝트 추가');
    h.input('name', 'New App'); h.input('slug', 'new-app');
    await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/projects' && r.method === 'POST')!.body, { name: 'New App', slug: 'new-app' });
    await h.click('프로젝트·환경 관리');
    await h.click('프로젝트 편집');
    h.input('name', 'Renamed'); h.input('slug', 'renamed'); await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/projects/p1' && r.method === 'PATCH')!.body, { name: 'Renamed', slug: 'renamed' });
    await h.click('프로젝트·환경 관리'); await h.click('환경 추가');
    h.input('name', 'staging'); await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/environments' && r.method === 'POST')!.body, { projectId: 'p1', name: 'staging' });
    await h.click('프로젝트·환경 관리'); await h.click('환경 편집');
    h.input('name', 'production'); await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/environments/e1' && r.method === 'PATCH')!.body, { name: 'production' });
    await h.click('프로젝트·환경 관리'); await h.click('환경 삭제');
    assert.equal(h.requests.some((r) => r.method === 'DELETE'), false);
    await h.click('삭제 확인');
    assert.deepEqual(h.requests.find((r) => r.path === '/api/environments/e1' && r.method === 'DELETE')!.body, {});
    await h.click('프로젝트·환경 관리'); await h.click('프로젝트 삭제'); await h.click('삭제 확인');
    assert.deepEqual(h.requests.find((r) => r.path === '/api/projects/p1' && r.method === 'DELETE')!.body, {});
  } finally { h.dom.window.close(); }
});

test('secret deletion, version restore and trash restore include current version and need confirmation', async () => {
  const h = await setup();
  try {
    await h.click('삭제');
    assert.equal(h.requests.some((r) => r.method === 'DELETE'), false);
    await h.click('삭제 확인');
    assert.deepEqual(h.requests.find((r) => r.method === 'DELETE')!.body, { expectedVersionId: 'v1' });
    await h.click('버전');
    assert.equal(h.requests.some((r) => r.path.endsWith('/reveal')), false);
    await h.click('이 버전 복원');
    assert.equal(h.requests.some((r) => r.path.endsWith('/old/restore')), false);
    await h.click('복원 확인');
    assert.deepEqual(h.requests.find((r) => r.path === '/api/secrets/s1/versions/old/restore')!.body, { expectedVersionId: 'v1' });
    await h.click('휴지통'); await h.click('복원'); await h.click('복원 확인');
    assert.deepEqual(h.requests.find((r) => r.path === '/api/trash/s1/restore')!.body, { expectedVersionId: 'v1' });
  } finally { h.dom.window.close(); }
});

test('CI policy form creates exact constraints then edits disables and deletes', async () => {
  const policy = { id: 'policy1', environmentId: 'e1', repositoryId: '123', repositoryOwnerId: '456', branch: 'refs/heads/main', workflow: '.github/workflows/deploy.yml', events: ['workflow_dispatch'], githubEnvironment: null, active: true };
  let policies: unknown[] = [];
  const h = await setup((r) => {
    if (r.path.startsWith('/api/ci-policies?')) return { policies };
    if (r.path === '/api/ci-policies' && r.method === 'POST') { policies = [policy]; return policy; }
    return undefined;
  });
  try {
    await h.click('CI 정책'); await h.click('정책 추가');
    h.input('repositoryId', '123'); h.input('repositoryOwnerId', '456');
    h.input('branch', 'refs/heads/main'); h.input('workflow', '.github/workflows/deploy.yml');
    await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/ci-policies' && r.method === 'POST')!.body, { environmentId: 'e1', repositoryId: '123', repositoryOwnerId: '456', branch: 'refs/heads/main', workflow: '.github/workflows/deploy.yml', events: ['workflow_dispatch'], githubEnvironment: null, active: true });
    await h.click('정책 편집'); h.input('repositoryId', '789'); await h.submit();
    assert.deepEqual(h.requests.find((r) => r.path === '/api/ci-policies/policy1' && r.method === 'PATCH')!.body, { repositoryId: '789' });
    await h.click('비활성화');
    assert.ok(h.requests.some((r) => r.path === '/api/ci-policies/policy1' && r.method === 'PATCH' && r.body.active === false));
    await h.click('정책 삭제'); await h.click('삭제 확인');
    assert.deepEqual(h.requests.find((r) => r.path === '/api/ci-policies/policy1' && r.method === 'DELETE')!.body, {});
  } finally { h.dom.window.close(); }
});

test('audit renders hostile metadata safely; encrypted backup downloads and bounded restore needs confirmation', async () => {
  const backup = { schemaVersion: 1, exportedAt: 0, tables: { projects: [], environments: [], secrets: [], secret_versions: [], ci_policies: [] } };
  const h = await setup((r) => {
    if (r.path.startsWith('/api/audit-events')) return { events: [{ id: 'a1', actor: '<script>alert(1)</script>', action: 'admin.reveal', targetId: 's1', result: 'success', createdAt: 0 }] };
    if (r.path === '/api/backup') return backup;
    return undefined;
  });
  try {
    await h.click('감사 기록');
    assert.match(h.doc.querySelector('#view')!.textContent!, /<script>alert\(1\)<\/script>/);
    assert.equal(h.doc.querySelector('#view script'), null);
    await h.click('백업·복구'); await h.click('암호화 백업 다운로드');
    assert.deepEqual(JSON.parse(await h.downloads[0]!.text()), backup);
    const compact = '{"schemaVersion":1,"exportedAt":0,"tables":{"projects":[],"environments":[],"secrets":[],"secret_versions":[],"ci_policies":[]}}';
    assert.equal(h.downloads[0]!.size, Buffer.byteLength(compact), 'backup formatting must not exceed the compact server size cap');
    await h.click('백업 복구');
    const file = h.doc.querySelector<HTMLInputElement>('[name=backup]')!;
    assert.ok(file, 'restore file exists');
    Object.defineProperty(file, 'files', { configurable: true, value: [{ size: 1048577, text: async () => { throw new Error('must not read oversized file'); } }] });
    file.dispatchEvent(new h.window.Event('change')); await settle(); await h.submit();
    assert.equal(h.requests.some((r) => r.path === '/api/backup/restore'), false);
    Object.defineProperty(file, 'files', { value: [{ size: 150, text: async () => JSON.stringify(backup) }] });
    file.dispatchEvent(new h.window.Event('change')); await settle(); await h.submit();
    assert.equal(h.requests.some((r) => r.path === '/api/backup/restore'), false);
    await h.click('복구 확인');
    assert.deepEqual(h.requests.find((r) => r.path === '/api/backup/restore')!.body, backup);
  } finally { h.dom.window.close(); }
});

test('metadata refresh completes even when a dialog opens while the list request is pending', async () => {
  let resolve!: (value: unknown) => void;
  let lists = 0;
  const h = await setup((r) => r.path.startsWith('/api/secrets?') && ++lists === 2 ? new Promise((done) => { resolve = done; }) : undefined);
  try {
    [...h.doc.querySelectorAll('button')].find((b) => b.textContent === '새로고침')!.click();
    await settle();
    await h.click('프로젝트·환경 관리');
    resolve({ secrets: [secret] });
    await settle();
    assert.match(h.doc.querySelector('#view')!.textContent!, /<img src=x onerror=alert\(1\)>/);
  } finally { h.dom.window.close(); }
});

test('save waits for a pending file read and discards an upload after dismissal', async () => {
  const h = await setup();
  let resolve!: (bytes: ArrayBuffer) => void;
  try {
    await h.click('시크릿 추가'); h.input('name', 'PEM');
    const file = h.doc.querySelector<HTMLInputElement>('[name=file]')!;
    Object.defineProperty(file, 'files', { value: [{ size: 3, arrayBuffer: () => new Promise((done) => { resolve = done; }) }] });
    file.dispatchEvent(new h.window.Event('change'));
    await settle(); await h.submit();
    assert.equal(h.requests.some((r) => r.path === '/api/secrets' && r.method === 'POST'), false);
    await h.click('닫기');
    resolve(new TextEncoder().encode('PRIVATE_LATE_UPLOAD').buffer);
    await settle();
    assert.equal(h.doc.querySelector('#dialog')!.textContent, '');
    assert.equal(h.requests.some((r) => r.path === '/api/secrets' && r.method === 'POST'), false);
  } finally { h.dom.window.close(); }
});

test('trash copy reflects the seven day storage retention', async () => {
  const h = await setup();
  try {
    await h.click('삭제');
    assert.match(h.doc.querySelector('#dialog')!.textContent!, /7일/);
    await h.click('닫기'); await h.click('휴지통');
    assert.match(h.doc.querySelector('#view-description')!.textContent!, /7일/);
  } finally { h.dom.window.close(); }
});

test('reveal failures are visible without server response text', async () => {
  const h = await setup((r) => r.path.endsWith('/reveal') ? new Response('PRIVATE_EXCEPTION', { status: 401 }) : undefined);
  try {
    await h.click('보기');
    assert.match(h.doc.querySelector('#dialog-status')!.textContent!, /로그인.*만료/);
    assert.equal(h.doc.body.textContent!.includes('PRIVATE_EXCEPTION'), false);
    assert.equal(h.doc.querySelector('#dialog pre'), null);
  } finally { h.dom.window.close(); }
});

test('editing waits for explicit current value and an earlier reveal cannot unlock a newer file read', async () => {
  let revealDone!: (value: unknown) => void;
  let fileDone!: (value: ArrayBuffer) => void;
  const h = await setup((r) => r.path.endsWith('/reveal') ? new Promise((done) => { revealDone = done; }) : undefined);
  try {
    await h.click('편집');
    const replace = h.doc.querySelector<HTMLInputElement>('[name=replace]')!;
    replace.checked = true; replace.dispatchEvent(new h.window.Event('change'));
    await h.click('현재 값 불러오기');
    await h.submit();
    assert.equal(h.requests.some((r) => r.method === 'PATCH'), false);
    const file = h.doc.querySelector<HTMLInputElement>('[name=file]')!;
    Object.defineProperty(file, 'files', { value: [{ size: 3, arrayBuffer: () => new Promise((done) => { fileDone = done; }) }] });
    file.dispatchEvent(new h.window.Event('change')); await settle();
    revealDone({ name: 'PEM', kind: 'file', value: 'OLD' }); await settle();
    await h.submit();
    assert.equal(h.requests.some((r) => r.method === 'PATCH'), false);
    fileDone(new TextEncoder().encode('NEW\r\n').buffer); await settle();
    await h.submit();
    assert.equal(h.requests.find((r) => r.method === 'PATCH')!.body.value, 'NEW\r\n');
  } finally { h.dom.window.close(); }
});

test('intentional typing invalidates a pending current reveal and allows saving the typed replacement', async () => {
  let revealDone!: (value: unknown) => void;
  const h = await setup((r) => r.path.endsWith('/reveal') ? new Promise((done) => { revealDone = done; }) : undefined);
  try {
    await h.click('편집');
    const replace = h.doc.querySelector<HTMLInputElement>('[name=replace]')!;
    replace.checked = true; replace.dispatchEvent(new h.window.Event('change'));
    await h.click('현재 값 불러오기');
    h.input('value', 'TYPED');
    await h.submit();
    const update = h.requests.find((r) => r.method === 'PATCH');
    assert.ok(update, 'typing enables replacement submit');
    assert.equal(update.body.value, 'TYPED');
    revealDone({ name: 'PEM', kind: 'file', value: 'OLD_PRIVATE' }); await settle();
    assert.equal(h.doc.body.textContent!.includes('OLD_PRIVATE'), false);
  } finally { h.dom.window.close(); }
});

test('initial project loading survives audit navigation and enables the workspace before returning to secrets', async () => {
  let projectsDone!: (value: unknown) => void;
  const h = await setup((r) => r.path === '/api/projects' ? new Promise((done) => { projectsDone = done; }) : undefined);
  try {
    await h.click('감사 기록');
    projectsDone({ projects: [{ id: 'p1', name: 'App', slug: 'app' }] }); await settle();
    const project = h.doc.querySelector('#project-select') as unknown as HTMLSelectElement;
    const environment = h.doc.querySelector('#environment-select') as unknown as HTMLSelectElement;
    assert.equal(project.disabled, false, 'loaded projects enable the selector across menu navigation');
    assert.equal(environment.disabled, false);
    assert.equal(environment.value, 'e1');
    assert.ok(h.requests.some((r) => r.path === '/api/environments?projectId=p1'));
    await h.click('시크릿');
    assert.match(h.doc.querySelector('#view')!.textContent!, /<img src=x onerror=alert\(1\)>/);
  } finally { h.dom.window.close(); }
});

test('a project environment request survives menu navigation while old environment values stay unavailable', async () => {
  let environmentsDone!: (value: unknown) => void;
  const h = await setup((r) => {
    if (r.path === '/api/projects') return { projects: [{ id: 'p1', name: 'App', slug: 'app' }, { id: 'p2', name: 'Second', slug: 'second' }] };
    if (r.path === '/api/environments?projectId=p2') return new Promise((done) => { environmentsDone = done; });
    if (r.path === '/api/secrets?environmentId=e3') return { secrets: [{ ...secret, id: 's3', environmentId: 'e3', name: 'SECOND_PROJECT' }] };
    return undefined;
  });
  try {
    const project = h.doc.querySelector('#project-select') as unknown as HTMLSelectElement;
    project.value = 'p2'; project.dispatchEvent(new h.window.Event('change')); await settle();
    await h.click('감사 기록');
    environmentsDone({ environments: [{ id: 'e3', projectId: 'p2', name: 'staging' }] }); await settle();
    const environment = h.doc.querySelector('#environment-select') as unknown as HTMLSelectElement;
    assert.equal(environment.disabled, false, 'environment loading survives unrelated menu navigation');
    assert.equal(environment.value, 'e3');
    assert.equal(project.disabled, false);
    await h.click('시크릿');
    assert.match(h.doc.querySelector('#view')!.textContent!, /SECOND_PROJECT/);
    assert.equal(h.doc.querySelector('#view')!.textContent!.includes(secret.name), false);
  } finally { h.dom.window.close(); }
});

for (const failure of ['invalid UTF-8', 'oversized', 'read failure']) {
  test(`${failure} upload clears prior file plaintext and blocks save until an intentional recovery`, async () => {
    const h = await setup();
    try {
      await h.click('편집');
      const replace = h.doc.querySelector<HTMLInputElement>('[name=replace]')!;
      replace.checked = true; replace.dispatchEvent(new h.window.Event('change'));
      const file = h.doc.querySelector<HTMLInputElement>('[name=file]')!;
      const good = new TextEncoder().encode('PREVIOUS_PRIVATE\r\n');
      Object.defineProperty(file, 'files', { configurable: true, value: [{ size: good.length, arrayBuffer: async () => good.buffer }] });
      file.dispatchEvent(new h.window.Event('change')); await settle();
      const value = h.doc.querySelector<HTMLTextAreaElement>('[name=value]')!;
      assert.match(value.value, /PREVIOUS_PRIVATE/);
      const broken = failure === 'invalid UTF-8'
        ? { size: 1, arrayBuffer: async () => new Uint8Array([0xff]).buffer }
        : failure === 'oversized' ? { size: 65537, arrayBuffer: async () => { throw new Error('oversized file must not be read'); } }
          : { size: 1, arrayBuffer: async () => { throw new Error('PRIVATE_READ_ERROR'); } };
      Object.defineProperty(file, 'files', { configurable: true, value: [broken] });
      file.dispatchEvent(new h.window.Event('change')); await settle();
      assert.equal(value.value, '', 'failed file selection clears the previous displayed plaintext');
      await h.submit();
      assert.equal(h.requests.some((r) => r.method === 'PATCH'), false, 'failed replacement cannot save old plaintext or an empty value');
      assert.equal(h.doc.querySelector('#dialog')!.textContent!.includes('PRIVATE_READ_ERROR'), false);
      if (failure === 'invalid UTF-8') {
        const recovered = new TextEncoder().encode('\ufeffRECOVERED\r\n');
        Object.defineProperty(file, 'files', { value: [{ size: recovered.length, arrayBuffer: async () => recovered.buffer }] });
        file.dispatchEvent(new h.window.Event('change')); await settle(); await h.submit();
        assert.equal(h.requests.find((r) => r.method === 'PATCH')!.body.value, '\ufeffRECOVERED\r\n');
      } else if (failure === 'oversized') {
        await h.click('현재 값 불러오기'); await h.submit();
        assert.equal(h.requests.find((r) => r.method === 'PATCH')!.body.value, 'PRIVATE\r\nVALUE');
      } else {
        replace.checked = false; replace.dispatchEvent(new h.window.Event('change')); await h.submit();
        assert.equal(Object.hasOwn(h.requests.find((r) => r.method === 'PATCH')!.body, 'value'), false);
      }
    } finally { h.dom.window.close(); }
  });
}

test('an old project environment response cannot replace the workspace after another project is selected', async () => {
  let oldEnvironmentsDone!: (value: unknown) => void;
  const h = await setup((r) => {
    if (r.path === '/api/projects') return { projects: [{ id: 'p1', name: 'App', slug: 'app' }, { id: 'p2', name: 'Second', slug: 'second' }] };
    if (r.path === '/api/environments?projectId=p1') return new Promise((done) => { oldEnvironmentsDone = done; });
    if (r.path === '/api/environments?projectId=p2') return { environments: [{ id: 'e3', projectId: 'p2', name: 'staging' }] };
    if (r.path === '/api/secrets?environmentId=e3') return { secrets: [{ ...secret, id: 's3', environmentId: 'e3', name: 'SECOND_PROJECT' }] };
    return undefined;
  });
  try {
    const project = h.doc.querySelector('#project-select') as unknown as HTMLSelectElement;
    assert.equal(project.disabled, false);
    project.value = 'p2'; project.dispatchEvent(new h.window.Event('change')); await settle();
    oldEnvironmentsDone({ environments: [{ id: 'e1', projectId: 'p1', name: 'dev' }] }); await settle();
    const environment = h.doc.querySelector('#environment-select') as unknown as HTMLSelectElement;
    assert.equal(project.value, 'p2');
    assert.equal(environment.value, 'e3');
    assert.match(h.doc.querySelector('#view')!.textContent!, /SECOND_PROJECT/);
    assert.equal(h.requests.some((r) => r.path === '/api/secrets?environmentId=e1'), false);
  } finally { h.dom.window.close(); }
});


test('policy edit no-op avoids PATCH and an explicit checkbox change activates the policy',async()=>{
  const policy={id:'policy1',environmentId:'e1',repositoryId:'123',repositoryOwnerId:'456',branch:'refs/heads/main',workflow:'.github/workflows/deploy.yml',events:['workflow_dispatch'],githubEnvironment:null,active:false};
  const h=await setup(r=>r.path.startsWith('/api/ci-policies?')?{policies:[policy]}:undefined);
  try {
    await h.click('CI 정책');await h.click('정책 편집');await h.submit();
    assert.equal(h.requests.filter(r=>r.method==='PATCH').length,0);assert.equal((h.doc.querySelector('#dialog') as HTMLDialogElement).open,false);
    await h.click('정책 편집');(h.doc.querySelector('[name="active"]') as HTMLInputElement).checked=true;await h.submit();
    assert.deepEqual(h.requests.find(r=>r.method==='PATCH')!.body,{active:true});
  }finally{h.dom.window.close();}
});
