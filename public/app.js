const runForm = document.getElementById('runForm');
const goalEl = document.getElementById('goal');
const connStatusEl = document.getElementById('connStatus');
const lastEventEl = document.getElementById('lastEvent');
const modelNameEl = document.getElementById('modelName');
const keyStateEl = document.getElementById('keyState');
const toolListEl = document.getElementById('toolList');
const integrationListEl = document.getElementById('integrationList');
const treeEl = document.getElementById('agentTree');
const timelineEl = document.getElementById('timeline');
const eventsEl = document.getElementById('events');

const agents = new Map();
const childMap = new Map();
const messageDrafts = new Map();
let eventSource = null;
let lastEventId = Number(localStorage.getItem('lastEventId') || 0);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function upsertAgent(agent) {
  agents.set(agent.id, agent);
  if (!childMap.has(agent.parentId || 'root')) childMap.set(agent.parentId || 'root', []);
  const siblings = childMap.get(agent.parentId || 'root');
  if (!siblings.includes(agent.id)) siblings.push(agent.id);
  renderTree();
}

function renderTree() {
  treeEl.innerHTML = '';

  function renderNode(agentId, parentUl) {
    const agent = agents.get(agentId);
    if (!agent) return;

    const li = el('li');
    li.appendChild(el('span', 'agentName', agent.name));
    li.appendChild(el('span', 'agentRole', `(${agent.role})`));
    parentUl.appendChild(li);

    const kids = childMap.get(agentId) || [];
    if (kids.length) {
      const ul = el('ul');
      li.appendChild(ul);
      kids.forEach((id) => renderNode(id, ul));
    }
  }

  const roots = childMap.get('root') || [];
  roots.forEach((id) => renderNode(id, treeEl));
}

function appendTimeline({ agentName, kind, content, stream = false }) {
  const key = `${agentName}:${kind}`;
  let row = messageDrafts.get(key);

  if (!row || !stream) {
    row = el('div', `timelineItem ${kind}`);
    const meta = el('div', 'meta', `${agentName} • ${kind}`);
    const body = el('div', 'body', content);
    row.append(meta, body);
    timelineEl.appendChild(row);
    messageDrafts.set(key, row);
  } else {
    row.querySelector('.body').textContent = content;
  }

  if (!stream) messageDrafts.delete(key);
  timelineEl.scrollTop = timelineEl.scrollHeight;
}

function appendEvent(evt) {
  const item = el('div', 'eventItem');
  const head = el('div', 'meta');
  head.appendChild(el('span', 'eventType', evt.type));
  head.appendChild(document.createTextNode(`#${evt.id} • ${new Date(evt.ts).toLocaleTimeString()}`));

  const body = el('pre', null, JSON.stringify(evt.data, null, 2));
  body.style.margin = '6px 0 0';
  body.style.whiteSpace = 'pre-wrap';
  body.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  body.style.fontSize = '12px';

  item.append(head, body);
  eventsEl.appendChild(item);

  if (eventsEl.children.length > 180) eventsEl.removeChild(eventsEl.firstChild);
  eventsEl.scrollTop = eventsEl.scrollHeight;
}

function updateEventMeta(id) {
  lastEventId = id;
  localStorage.setItem('lastEventId', String(lastEventId));
  lastEventEl.textContent = String(lastEventId);
}

async function loadState() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const state = await res.json();
    modelNameEl.textContent = state.model || '-';
    keyStateEl.textContent = state.apiKeyConfigured ? '설정됨' : '없음';
    toolListEl.textContent = Array.isArray(state.tools) && state.tools.length ? state.tools.join(', ') : '-';
    const integrations = state.integrations || {};
    const tuning = state.tuning || {};
    const labels = Object.entries(integrations)
      .map(([k, v]) => `${k}:${v ? 'on' : 'off'}`)
      .join(', ');
    const endpointCount = Array.isArray(tuning.internal?.endpointKeys) ? tuning.internal.endpointKeys.length : 0;
    const dbSqlField = tuning.db?.sqlField || 'sql';
    integrationListEl.textContent = `${labels || '-'} | endpoints:${endpointCount} | dbSqlField:${dbSqlField}`;
  } catch {
    modelNameEl.textContent = '-';
    keyStateEl.textContent = '-';
    toolListEl.textContent = '-';
    integrationListEl.textContent = '-';
  }
}

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`/api/stream?since=${lastEventId}`);
  connStatusEl.textContent = '연결 중';

  eventSource.onopen = () => {
    connStatusEl.textContent = '연결됨';
  };

  eventSource.onerror = () => {
    connStatusEl.textContent = '재연결 중';
  };

  eventSource.onmessage = (msg) => {
    const evt = JSON.parse(msg.data);
    routeEvent(evt);
  };

  [
    'run.started',
    'run.completed',
    'run.error',
    'system.notice',
    'agent.created',
    'agent.message.delta',
    'agent.message.final',
    'agent.tool',
    'agent.risk',
    'agent.interaction',
    'llm.raw_event',
    'agent.tool.call.started',
    'agent.tool.call.delta',
    'agent.tool.call.done',
    'agent.tool.exec.start',
    'agent.tool.exec.result',
    'agent.tool.exec.error',
  ].forEach((type) => {
    eventSource.addEventListener(type, (msg) => {
      const evt = JSON.parse(msg.data);
      routeEvent(evt);
    });
  });
}

function routeEvent(evt) {
  updateEventMeta(evt.id);
  appendEvent(evt);

  if (evt.type === 'agent.created') {
    upsertAgent(evt.data);
    return;
  }

  if (evt.type === 'agent.message.delta') {
    const agentName = agents.get(evt.data.agentId)?.name || evt.data.agentId;
    appendTimeline({ agentName, kind: evt.data.kind, content: evt.data.content, stream: true });
    return;
  }

  if (evt.type === 'agent.message.final') {
    const agentName = agents.get(evt.data.agentId)?.name || evt.data.agentId;
    appendTimeline({ agentName, kind: evt.data.kind, content: evt.data.content, stream: false });
    return;
  }

  if (evt.type === 'agent.interaction') {
    const from = agents.get(evt.data.from)?.name || evt.data.from;
    const to = agents.get(evt.data.to)?.name || evt.data.to;
    appendTimeline({ agentName: `${from} -> ${to}`, kind: 'handoff', content: evt.data.text, stream: false });
    return;
  }

  if (evt.type === 'agent.tool.exec.start') {
    const agentName = agents.get(evt.data.agentId)?.name || evt.data.agentId;
    appendTimeline({
      agentName,
      kind: 'tool',
      content: `도구 실행 시작: ${evt.data.name}(${JSON.stringify(evt.data.arguments)})`,
      stream: false,
    });
    return;
  }

  if (evt.type === 'agent.tool.exec.result') {
    const agentName = agents.get(evt.data.agentId)?.name || evt.data.agentId;
    appendTimeline({
      agentName,
      kind: 'tool',
      content: `도구 실행 결과: ${evt.data.name} -> ${JSON.stringify(evt.data.output).slice(0, 260)}`,
      stream: false,
    });
    return;
  }

  if (evt.type === 'agent.tool.exec.error') {
    const agentName = agents.get(evt.data.agentId)?.name || evt.data.agentId;
    appendTimeline({
      agentName,
      kind: 'tool',
      content: `도구 실행 실패: ${evt.data.name} -> ${evt.data.error}`,
      stream: false,
    });
  }
}

runForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const goal = goalEl.value.trim();
  const resp = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    alert(err.error || '런 시작 실패');
  }
});

loadState();
connectSSE();
