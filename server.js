const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const NOTION_API_KEY = process.env.NOTION_API_KEY || '';
const NOTION_VERSION = process.env.NOTION_VERSION || '2022-06-28';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const INTERNAL_API_BASE_URL = process.env.INTERNAL_API_BASE_URL || '';
const INTERNAL_API_BEARER_TOKEN = process.env.INTERNAL_API_BEARER_TOKEN || '';
const INTERNAL_API_DEFAULT_HEADERS_JSON = process.env.INTERNAL_API_DEFAULT_HEADERS_JSON || '{}';
const INTERNAL_API_ALLOWED_PATH_PREFIXES = process.env.INTERNAL_API_ALLOWED_PATH_PREFIXES || '/';
const INTERNAL_API_ENDPOINTS_JSON = process.env.INTERNAL_API_ENDPOINTS_JSON || '{}';
const INTERNAL_API_RESULT_PATH = process.env.INTERNAL_API_RESULT_PATH || '';
const INTERNAL_API_TIMEOUT_MS = Number(process.env.INTERNAL_API_TIMEOUT_MS || 12000);
const DB_API_URL = process.env.DB_API_URL || '';
const DB_API_TOKEN = process.env.DB_API_TOKEN || '';
const DB_API_METHOD = process.env.DB_API_METHOD || 'POST';
const DB_API_SQL_FIELD = process.env.DB_API_SQL_FIELD || 'sql';
const DB_API_PARAMS_FIELD = process.env.DB_API_PARAMS_FIELD || 'params';
const DB_API_EXTRA_BODY_JSON = process.env.DB_API_EXTRA_BODY_JSON || '{}';
const DB_API_RESULT_PATH = process.env.DB_API_RESULT_PATH || '';
const DB_API_ERROR_PATH = process.env.DB_API_ERROR_PATH || '';
const DB_API_TIMEOUT_MS = Number(process.env.DB_API_TIMEOUT_MS || 12000);

const clients = new Set();
const eventLog = [];
const MAX_EVENTS = 8000;
let nextEventId = 1;
let activeRun = null;

function parseJsonEnv(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const INTERNAL_DEFAULT_HEADERS = parseJsonEnv(INTERNAL_API_DEFAULT_HEADERS_JSON, {});
const INTERNAL_ENDPOINTS = parseJsonEnv(INTERNAL_API_ENDPOINTS_JSON, {});
const INTERNAL_ALLOWED_PREFIXES = INTERNAL_API_ALLOWED_PATH_PREFIXES
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const INTERNAL_ENDPOINT_KEYS = Object.keys(INTERNAL_ENDPOINTS || {});
const DB_API_EXTRA_BODY = parseJsonEnv(DB_API_EXTRA_BODY_JSON, {});

const BASE_TOOL_SCHEMAS = [
  {
    type: 'function',
    name: 'time_now',
    description: '현재 시간을 ISO 문자열로 반환합니다.',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone. 예: Asia/Seoul, UTC',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'calculate',
    description: '사칙연산 수식을 계산합니다. 숫자와 + - * / ( ) . 만 허용됩니다.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '예: (12.5+3)*4/2',
        },
      },
      required: ['expression'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'http_get',
    description: '공개 URL의 텍스트를 가져옵니다. 보안상 로컬/사설망 주소는 차단됩니다.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'https:// 로 시작하는 URL 권장',
        },
        max_chars: {
          type: 'integer',
          minimum: 200,
          maximum: 12000,
          description: '본문 최대 길이',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

const OPTIONAL_TOOL_SCHEMAS = [
  {
    enabled: Boolean(NOTION_API_KEY),
    schema: {
      type: 'function',
      name: 'notion_search',
      description: 'Notion 워크스페이스에서 페이지/데이터베이스를 검색합니다.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색어' },
          page_size: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    enabled: Boolean(SLACK_BOT_TOKEN),
    schema: {
      type: 'function',
      name: 'slack_post_message',
      description: 'Slack 채널에 메시지를 전송합니다.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: '예: C0123456789' },
          text: { type: 'string', description: '전송할 메시지' },
        },
        required: ['channel', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    enabled: Boolean(INTERNAL_API_BASE_URL),
    schema: {
      type: 'function',
      name: 'internal_api_call',
      description: `사내 API를 호출합니다. endpoint(권장) 또는 path/method로 요청할 수 있습니다. 사용 가능한 endpoint: ${INTERNAL_ENDPOINT_KEYS.join(', ') || '(없음)'}`,
      parameters: {
        type: 'object',
        properties: {
          endpoint: { type: 'string', description: 'INTERNAL_API_ENDPOINTS_JSON에 정의한 키' },
          path_params: { type: 'object', additionalProperties: { type: 'string' } },
          query: { type: 'object', additionalProperties: { type: 'string' } },
          path: { type: 'string', description: '예: /v1/tasks/123' },
          method: { type: 'string', enum: ['GET', 'POST'] },
          body: { type: 'object', additionalProperties: true },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    enabled: Boolean(DB_API_URL),
    schema: {
      type: 'function',
      name: 'db_query_via_api',
      description: 'HTTP 기반 DB 게이트웨이 API에 SQL 쿼리를 전송합니다. 페이로드 키는 환경변수로 튜닝됩니다.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SELECT ...' },
          params: { type: 'array', items: {} },
        },
        required: ['sql'],
        additionalProperties: false,
      },
    },
  },
];

const TOOL_SCHEMAS = [
  ...BASE_TOOL_SCHEMAS,
  ...OPTIONAL_TOOL_SCHEMAS.filter((x) => x.enabled).map((x) => x.schema),
];

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function emit(type, data) {
  const evt = {
    id: nextEventId++,
    ts: new Date().toISOString(),
    type,
    data,
  };

  eventLog.push(evt);
  if (eventLog.length > MAX_EVENTS) eventLog.shift();

  const frame = `id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const client of clients) client.write(frame);
}

function newAgent(runId, id, name, role, parentId = null) {
  emit('agent.created', { runId, id, name, role, parentId });
  return { runId, id, name, role, parentId };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractOutputText(responseObj) {
  if (!responseObj || typeof responseObj !== 'object') return '';

  if (typeof responseObj.output_text === 'string' && responseObj.output_text) {
    return responseObj.output_text;
  }

  if (Array.isArray(responseObj.output)) {
    const chunks = [];
    for (const item of responseObj.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const c of item.content) {
        if (c && typeof c.text === 'string') chunks.push(c.text);
      }
    }
    if (chunks.length) return chunks.join('');
  }

  return '';
}

async function* parseSSE(stream) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');

    while (true) {
      const idx = buffer.indexOf('\n\n');
      if (idx === -1) break;

      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const lines = block.split('\n');
      const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());

      if (!dataLines.length) continue;

      const data = dataLines.join('\n');
      if (data === '[DONE]') return;

      const parsed = safeJsonParse(data);
      if (parsed) yield parsed;
    }
  }
}

function isBlockedHost(hostname) {
  const host = (hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

function safeEvalExpression(expr) {
  const cleaned = String(expr || '').replace(/\s+/g, '');
  if (!cleaned) throw new Error('빈 수식입니다.');
  if (!/^[0-9+\-*/().]+$/.test(cleaned)) throw new Error('허용되지 않은 문자가 포함되어 있습니다.');
  if (cleaned.length > 200) throw new Error('수식이 너무 깁니다.');

  const fn = new Function(`return (${cleaned});`);
  const result = fn();
  if (!Number.isFinite(result)) throw new Error('유한한 숫자 결과가 아닙니다.');
  return result;
}

function interpolatePathTemplate(template, pathParams) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) =>
    encodeURIComponent(String((pathParams && pathParams[key]) || `{${key}}`)),
  );
}

function isAllowedInternalPath(reqPath) {
  if (!INTERNAL_ALLOWED_PREFIXES.length) return true;
  return INTERNAL_ALLOWED_PREFIXES.some((prefix) => reqPath.startsWith(prefix));
}

function getByPath(obj, dottedPath) {
  if (!dottedPath) return obj;
  return String(dottedPath)
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), obj);
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const text = await resp.text();
    const parsed = safeJsonParse(text);
    return { resp, text, parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function executeTool(name, args) {
  if (name === 'time_now') {
    const timezone = typeof args.timezone === 'string' && args.timezone ? args.timezone : 'UTC';
    const now = new Date();
    let localized;
    try {
      localized = new Intl.DateTimeFormat('ko-KR', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now);
    } catch {
      localized = now.toISOString();
    }

    return { timezone, iso: now.toISOString(), localized };
  }

  if (name === 'calculate') {
    const result = safeEvalExpression(args.expression);
    return { expression: args.expression, result };
  }

  if (name === 'http_get') {
    const maxChars = Number.isInteger(args.max_chars) ? Math.min(Math.max(args.max_chars, 200), 12000) : 5000;
    let target;
    try {
      target = new URL(String(args.url || ''));
    } catch {
      throw new Error('유효한 URL이 아닙니다.');
    }

    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error('http/https URL만 허용됩니다.');
    }
    if (isBlockedHost(target.hostname)) {
      throw new Error('로컬/사설망 주소는 허용되지 않습니다.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);

    try {
      const resp = await fetch(target.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Agent-Theater/1.0' },
      });

      const text = await resp.text();
      return {
        url: target.toString(),
        status: resp.status,
        ok: resp.ok,
        content_type: resp.headers.get('content-type') || '',
        body_preview: text.slice(0, maxChars),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (name === 'notion_search') {
    if (!NOTION_API_KEY) throw new Error('NOTION_API_KEY가 설정되지 않았습니다.');
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query가 비어 있습니다.');
    const pageSize = Number.isInteger(args.page_size) ? Math.min(Math.max(args.page_size, 1), 20) : 8;

    const { resp, text, parsed } = await fetchJsonWithTimeout('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        page_size: pageSize,
      }),
    });

    if (!resp.ok) throw new Error(`Notion API 실패: ${parsed?.message || text || resp.status}`);

    const results = Array.isArray(parsed?.results) ? parsed.results.slice(0, pageSize) : [];
    return {
      query,
      count: results.length,
      results: results.map((r) => ({
        id: r.id,
        object: r.object,
        url: r.url,
        last_edited_time: r.last_edited_time,
      })),
    };
  }

  if (name === 'slack_post_message') {
    if (!SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN이 설정되지 않았습니다.');
    const channel = String(args.channel || '').trim();
    const text = String(args.text || '').trim();
    if (!channel || !text) throw new Error('channel/text가 필요합니다.');

    const { resp, parsed } = await fetchJsonWithTimeout('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, text }),
    });

    if (!resp.ok || !parsed?.ok) throw new Error(`Slack API 실패: ${parsed?.error || resp.status}`);
    return {
      ok: true,
      channel: parsed.channel,
      ts: parsed.ts,
      message_text: parsed.message?.text || text,
    };
  }

  if (name === 'internal_api_call') {
    if (!INTERNAL_API_BASE_URL) throw new Error('INTERNAL_API_BASE_URL이 설정되지 않았습니다.');
    const endpointKey = String(args.endpoint || '').trim();
    const endpointDef = endpointKey ? INTERNAL_ENDPOINTS[endpointKey] : null;
    const pathParams = args.path_params && typeof args.path_params === 'object' ? args.path_params : {};
    const query = args.query && typeof args.query === 'object' ? args.query : {};

    const reqPath = endpointDef
      ? interpolatePathTemplate(endpointDef.path || '', pathParams)
      : String(args.path || '').trim();
    if (!reqPath.startsWith('/')) throw new Error('path는 /로 시작해야 합니다.');
    if (!isAllowedInternalPath(reqPath)) {
      throw new Error(`허용된 path prefix(${INTERNAL_ALLOWED_PREFIXES.join(', ')}) 밖의 요청입니다.`);
    }

    const methodRaw = endpointDef?.method || args.method || 'GET';
    const method = String(methodRaw).toUpperCase() === 'POST' ? 'POST' : 'GET';

    const base = new URL(INTERNAL_API_BASE_URL);
    const target = new URL(reqPath, base);
    if (target.origin !== base.origin) throw new Error('base URL 외부로 벗어나는 path는 허용되지 않습니다.');
    for (const [k, v] of Object.entries(query)) {
      target.searchParams.set(k, String(v));
    }

    const headers = { Accept: 'application/json', ...INTERNAL_DEFAULT_HEADERS };
    if (INTERNAL_API_BEARER_TOKEN) headers.Authorization = `Bearer ${INTERNAL_API_BEARER_TOKEN}`;
    let body;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(args.body || endpointDef?.body || {});
    }

    const { resp, text, parsed } = await fetchJsonWithTimeout(
      target.toString(),
      { method, headers, body },
      Number.isFinite(INTERNAL_API_TIMEOUT_MS) ? INTERNAL_API_TIMEOUT_MS : 12000,
    );
    const dataPath = endpointDef?.resultPath || INTERNAL_API_RESULT_PATH;
    const picked = parsed ? getByPath(parsed, dataPath) : undefined;

    return {
      ok: resp.ok,
      status: resp.status,
      endpoint: endpointKey || null,
      path: reqPath,
      data: picked !== undefined ? picked : parsed || text.slice(0, 5000),
    };
  }

  if (name === 'db_query_via_api') {
    if (!DB_API_URL) throw new Error('DB_API_URL이 설정되지 않았습니다.');
    const sql = String(args.sql || '').trim();
    if (!sql) throw new Error('sql이 비어 있습니다.');
    const params = Array.isArray(args.params) ? args.params : [];

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (DB_API_TOKEN) headers.Authorization = `Bearer ${DB_API_TOKEN}`;
    const payload = { ...DB_API_EXTRA_BODY };
    payload[DB_API_SQL_FIELD] = sql;
    payload[DB_API_PARAMS_FIELD] = params;

    const { resp, text, parsed } = await fetchJsonWithTimeout(DB_API_URL, {
      method: String(DB_API_METHOD || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST',
      headers,
      body: JSON.stringify(payload),
    }, Number.isFinite(DB_API_TIMEOUT_MS) ? DB_API_TIMEOUT_MS : 12000);

    if (!resp.ok) {
      const parsedError = parsed ? getByPath(parsed, DB_API_ERROR_PATH) : undefined;
      throw new Error(`DB API 실패: ${parsedError || parsed?.error || text || resp.status}`);
    }

    const pickedResult = parsed ? getByPath(parsed, DB_API_RESULT_PATH) : undefined;
    const finalData = pickedResult !== undefined ? pickedResult : parsed || { raw: text.slice(0, 8000) };
    return {
      ok: true,
      status: resp.status,
      data: finalData,
      row_count: Array.isArray(finalData) ? finalData.length : undefined,
    };
  }

  throw new Error(`지원하지 않는 도구: ${name}`);
}

async function openAIJson({ input, tools, previousResponseId }) {
  const body = {
    model: OPENAI_MODEL,
    input,
  };

  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (previousResponseId) body.previous_response_id = previousResponseId;

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  const parsed = safeJsonParse(text);

  if (!resp.ok) {
    const detail = parsed?.error?.message || text || `HTTP ${resp.status}`;
    throw new Error(`OpenAI JSON 호출 실패: ${detail}`);
  }

  return parsed;
}

async function openAIStreamRound({ runId, agentId, kind, input, previousResponseId, tools, baseContent }) {
  const payload = {
    model: OPENAI_MODEL,
    stream: true,
    input,
  };
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  if (previousResponseId) payload.previous_response_id = previousResponseId;

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const parsed = safeJsonParse(text);
    const detail = parsed?.error?.message || text || `HTTP ${resp.status}`;
    throw new Error(`OpenAI stream 호출 실패: ${detail}`);
  }

  let content = baseContent || '';
  let roundText = '';
  let completedResponse = null;
  const fnCallsByOutputIndex = new Map();

  for await (const evt of parseSSE(resp.body)) {
    emit('llm.raw_event', { runId, agentId, type: evt.type || 'unknown' });

    if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
      roundText += evt.delta;
      content += evt.delta;
      emit('agent.message.delta', { runId, agentId, kind, delta: evt.delta, content });
    }

    if (evt.type === 'response.output_item.added' && evt.item && evt.item.type === 'function_call') {
      const current = {
        type: 'function_call',
        name: evt.item.name,
        call_id: evt.item.call_id,
        arguments: typeof evt.item.arguments === 'string' ? evt.item.arguments : '',
      };
      fnCallsByOutputIndex.set(evt.output_index, current);
      emit('agent.tool.call.started', {
        runId,
        agentId,
        outputIndex: evt.output_index,
        name: current.name,
        callId: current.call_id,
      });
    }

    if (evt.type === 'response.function_call_arguments.delta' && typeof evt.output_index === 'number') {
      const current = fnCallsByOutputIndex.get(evt.output_index) || {
        type: 'function_call',
        name: evt.name,
        call_id: evt.call_id,
        arguments: '',
      };
      current.arguments += typeof evt.delta === 'string' ? evt.delta : '';
      fnCallsByOutputIndex.set(evt.output_index, current);
      emit('agent.tool.call.delta', {
        runId,
        agentId,
        outputIndex: evt.output_index,
        callId: evt.call_id,
        name: evt.name,
        delta: evt.delta || '',
      });
    }

    if (evt.type === 'response.function_call_arguments.done' && typeof evt.output_index === 'number') {
      const current = fnCallsByOutputIndex.get(evt.output_index) || {
        type: 'function_call',
        name: evt.name,
        call_id: evt.call_id,
        arguments: '',
      };
      if (typeof evt.arguments === 'string') current.arguments = evt.arguments;
      if (evt.name) current.name = evt.name;
      if (evt.call_id) current.call_id = evt.call_id;
      fnCallsByOutputIndex.set(evt.output_index, current);

      emit('agent.tool.call.done', {
        runId,
        agentId,
        outputIndex: evt.output_index,
        callId: current.call_id,
        name: current.name,
        arguments: current.arguments,
      });
    }

    if (evt.type === 'response.completed' && evt.response) {
      completedResponse = evt.response;
      if (!roundText) {
        const fallback = extractOutputText(evt.response);
        if (fallback) {
          roundText = fallback;
          content += fallback;
          emit('agent.message.delta', { runId, agentId, kind, delta: fallback, content });
        }
      }
    }
  }

  if (!completedResponse) {
    throw new Error('스트림 완료 응답을 받지 못했습니다.');
  }

  const responseOutput = Array.isArray(completedResponse.output) ? completedResponse.output : [];
  for (const item of responseOutput) {
    if (item && item.type === 'function_call' && !Array.from(fnCallsByOutputIndex.values()).some((x) => x.call_id === item.call_id)) {
      fnCallsByOutputIndex.set(fnCallsByOutputIndex.size, {
        type: 'function_call',
        name: item.name,
        call_id: item.call_id,
        arguments: item.arguments || '',
      });
    }
  }

  const functionCalls = Array.from(fnCallsByOutputIndex.values()).filter((x) => x && x.name && x.call_id);

  return {
    responseId: completedResponse.id,
    content,
    functionCalls,
  };
}

function normalizePlan(rawText) {
  const parsed = safeJsonParse(rawText);
  if (!parsed || !Array.isArray(parsed.subagents)) {
    return {
      coordinatorPlan: '목표를 분석하고 하위 작업을 분담한 뒤 결과를 통합합니다.',
      subagents: [
        { id: 'researcher', name: 'Researcher', role: '정보 수집', task: '핵심 사실을 수집하고 근거를 정리합니다.' },
        { id: 'builder', name: 'Builder', role: '초안 작성', task: '실행 가능한 초안을 작성합니다.' },
        { id: 'critic', name: 'Critic', role: '검증', task: '논리/누락/리스크를 검토합니다.' },
      ],
    };
  }

  const subagents = parsed.subagents
    .filter((x) => x && x.id && x.name && x.role && x.task)
    .slice(0, 4)
    .map((x) => ({
      id: String(x.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || `agent-${Math.random().toString(36).slice(2, 8)}`,
      name: String(x.name).slice(0, 32),
      role: String(x.role).slice(0, 48),
      task: String(x.task).slice(0, 600),
    }));

  if (!subagents.length) {
    return {
      coordinatorPlan: '목표를 분석하고 하위 작업을 분담한 뒤 결과를 통합합니다.',
      subagents: [{ id: 'researcher', name: 'Researcher', role: '정보 수집', task: '핵심 사실을 수집하고 근거를 정리합니다.' }],
    };
  }

  return {
    coordinatorPlan: String(parsed.coordinatorPlan || '목표를 분석하고 하위 작업을 분담한 뒤 결과를 통합합니다.').slice(0, 800),
    subagents,
  };
}

async function generatePlan(goal) {
  const body = await openAIJson({
    input: [
      {
        role: 'system',
        content:
          '너는 멀티 에이전트 오케스트레이터다. JSON만 출력한다. 스키마: {"coordinatorPlan": string, "subagents": [{"id": string, "name": string, "role": string, "task": string}]}. subagents는 2~4개.',
      },
      {
        role: 'user',
        content: `목표: ${goal}\n현실적으로 실행 가능한 하위 에이전트 분해 계획을 JSON으로 작성해.`,
      },
    ],
  });

  return normalizePlan(extractOutputText(body));
}

async function runAgentWithTools({ runId, agentId, kind, initialInput }) {
  let previousResponseId = null;
  let pendingInput = initialInput;
  let content = '';

  for (let turn = 0; turn < 6; turn += 1) {
    const round = await openAIStreamRound({
      runId,
      agentId,
      kind,
      input: pendingInput,
      previousResponseId,
      tools: TOOL_SCHEMAS,
      baseContent: content,
    });

    content = round.content;
    previousResponseId = round.responseId;

    if (!round.functionCalls.length) {
      emit('agent.message.final', { runId, agentId, kind, content });
      return content;
    }

    const toolOutputs = [];
    for (const fc of round.functionCalls) {
      const args = safeJsonParse(fc.arguments || '{}') || {};

      emit('agent.tool.exec.start', {
        runId,
        agentId,
        callId: fc.call_id,
        name: fc.name,
        arguments: args,
      });

      try {
        const output = await executeTool(fc.name, args);
        emit('agent.tool.exec.result', {
          runId,
          agentId,
          callId: fc.call_id,
          name: fc.name,
          output,
        });

        toolOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: JSON.stringify(output),
        });
      } catch (error) {
        const toolError = { error: error.message };
        emit('agent.tool.exec.error', {
          runId,
          agentId,
          callId: fc.call_id,
          name: fc.name,
          error: error.message,
        });

        toolOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: JSON.stringify(toolError),
        });
      }
    }

    pendingInput = toolOutputs;
  }

  emit('agent.risk', {
    runId,
    agentId,
    severity: 'high',
    text: '도구 호출 루프 한도(6턴)를 초과했습니다.',
  });
  emit('agent.message.final', { runId, agentId, kind, content });
  return content;
}

async function runSubAgent({ runId, coordinatorId, agentDef, goal }) {
  const agentId = `agent-${agentDef.id}`;
  const agent = newAgent(runId, agentId, agentDef.name, agentDef.role, coordinatorId);

  emit('agent.tool', {
    runId,
    agentId,
    tool: 'delegate-task',
    input: { goal, task: agentDef.task },
    output: { started: true, toolsEnabled: TOOL_SCHEMAS.map((t) => t.name) },
  });

  const content = await runAgentWithTools({
    runId,
    agentId: agent.id,
    kind: 'work',
    initialInput: [
      {
        role: 'system',
        content:
          '너는 하위 에이전트다. 필요하면 도구를 호출해 사실을 확인하라. 내부 비공개 추론 원문 대신 관찰 가능한 근거와 결론만 한국어로 출력한다.',
      },
      {
        role: 'user',
        content: [
          `전체 목표: ${goal}`,
          `너의 역할: ${agentDef.role}`,
          `너의 작업: ${agentDef.task}`,
          '출력 형식: 1) 핵심 결과 2) 근거(도구 사용 결과 포함) 3) 불확실성/리스크',
        ].join('\n'),
      },
    ],
  });

  emit('agent.interaction', {
    runId,
    from: agent.id,
    to: coordinatorId,
    text: `작업 완료 보고: ${content.slice(0, 220)}${content.length > 220 ? '...' : ''}`,
  });

  return { agent: agentDef, content };
}

async function startRun(goal) {
  const runId = `run-${Date.now()}`;
  activeRun = { runId, goal, startedAt: Date.now(), status: 'running', model: OPENAI_MODEL };

  emit('run.started', { runId, goal, model: OPENAI_MODEL });
  emit('system.notice', {
    runId,
    level: 'info',
    text: '내부 비공개 추론 원문은 제공할 수 없습니다. 대신 계획/근거/툴 호출/상호작용 로그를 실시간으로 공개합니다.',
  });

  const coordinator = newAgent(runId, 'agent-coordinator', 'Coordinator', '총괄');

  const plan = await generatePlan(goal);
  emit('agent.tool', {
    runId,
    agentId: coordinator.id,
    tool: 'plan-generation',
    input: { goal },
    output: {
      coordinatorPlan: plan.coordinatorPlan,
      subagents: plan.subagents.map((s) => ({ id: s.id, name: s.name, role: s.role })),
    },
  });

  emit('agent.message.final', {
    runId,
    agentId: coordinator.id,
    kind: 'plan',
    content: plan.coordinatorPlan,
  });

  const subResults = await Promise.all(
    plan.subagents.map((agentDef) =>
      runSubAgent({ runId, coordinatorId: coordinator.id, agentDef, goal }).catch((error) => {
        emit('agent.risk', {
          runId,
          agentId: `agent-${agentDef.id}`,
          severity: 'high',
          text: error.message,
        });
        return { agent: agentDef, content: `실패: ${error.message}` };
      }),
    ),
  );

  await runAgentWithTools({
    runId,
    agentId: coordinator.id,
    kind: 'final',
    initialInput: [
      {
        role: 'system',
        content:
          '너는 coordinator다. 하위 에이전트 보고를 통합해 최종 답안을 만든다. 필요하면 도구를 호출해 검증하고, 내부 추론 원문 없이 결론/근거/다음 액션만 한국어로 제시한다.',
      },
      {
        role: 'user',
        content: [
          `목표: ${goal}`,
          ...subResults.map((r, idx) => `하위에이전트${idx + 1}(${r.agent.name}/${r.agent.role}) 보고:\n${r.content}`),
          '형식: 1) 최종 결론 2) 핵심 근거 3) 즉시 실행 액션 3개',
        ].join('\n\n'),
      },
    ],
  });

  emit('run.completed', {
    runId,
    summary: '완료: 하위 에이전트 결과 통합이 끝났습니다.',
  });

  activeRun.status = 'completed';
}

function handleSse(req, res, urlObj) {
  const sinceParam = Number(urlObj.searchParams.get('since') || 0);
  const headerId = Number(req.headers['last-event-id'] || 0);
  const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : headerId;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('retry: 1500\n\n');

  if (since > 0) {
    for (const evt of eventLog) {
      if (evt.id > since) {
        res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      }
    }
  }

  clients.add(res);

  const hb = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 12000);

  req.on('close', () => {
    clearInterval(hb);
    clients.delete(res);
  });
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(safePath));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(full);
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && urlObj.pathname === '/api/stream') {
    handleSse(req, res, urlObj);
    return;
  }

  if (req.method === 'GET' && urlObj.pathname === '/api/state') {
    sendJson(res, 200, {
      activeRun,
      lastEventId: nextEventId - 1,
      bufferedEvents: eventLog.length,
      model: OPENAI_MODEL,
      apiKeyConfigured: Boolean(OPENAI_API_KEY),
      tools: TOOL_SCHEMAS.map((t) => t.name),
      integrations: {
        notion: Boolean(NOTION_API_KEY),
        slack: Boolean(SLACK_BOT_TOKEN),
        internalApi: Boolean(INTERNAL_API_BASE_URL),
        dbApi: Boolean(DB_API_URL),
      },
      tuning: {
        internal: {
          allowedPrefixes: INTERNAL_ALLOWED_PREFIXES,
          endpointKeys: INTERNAL_ENDPOINT_KEYS,
          resultPath: INTERNAL_API_RESULT_PATH || null,
        },
        db: {
          method: String(DB_API_METHOD || 'POST').toUpperCase(),
          sqlField: DB_API_SQL_FIELD,
          paramsField: DB_API_PARAMS_FIELD,
          resultPath: DB_API_RESULT_PATH || null,
          errorPath: DB_API_ERROR_PATH || null,
        },
      },
    });
    return;
  }

  if (req.method === 'POST' && urlObj.pathname === '/api/run') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });

    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const goal = String(parsed.goal || '').trim() || '에이전트 협업 목표';

        if (!OPENAI_API_KEY) {
          sendJson(res, 400, { error: 'OPENAI_API_KEY가 설정되지 않았습니다.' });
          return;
        }

        if (activeRun && activeRun.status === 'running') {
          sendJson(res, 409, { error: '이미 실행 중인 런이 있습니다.' });
          return;
        }

        sendJson(res, 202, { accepted: true, goal, model: OPENAI_MODEL });

        startRun(goal).catch((error) => {
          emit('run.error', { runId: activeRun?.runId, message: error.message });
          if (activeRun) activeRun.status = 'failed';
        });
      } catch {
        sendJson(res, 400, { error: '잘못된 JSON 본문입니다.' });
      }
    });

    return;
  }

  serveStatic(req, res, urlObj.pathname);
});

server.listen(PORT, () => {
  console.log(`Agent theater server running at http://localhost:${PORT}`);
  console.log(`Model: ${OPENAI_MODEL}`);
  console.log(`OPENAI_API_KEY configured: ${Boolean(OPENAI_API_KEY)}`);
  console.log(`NOTION_API_KEY configured: ${Boolean(NOTION_API_KEY)}`);
  console.log(`SLACK_BOT_TOKEN configured: ${Boolean(SLACK_BOT_TOKEN)}`);
  console.log(`INTERNAL_API_BASE_URL configured: ${Boolean(INTERNAL_API_BASE_URL)}`);
  console.log(`INTERNAL endpoint templates: ${INTERNAL_ENDPOINT_KEYS.length}`);
  console.log(`DB_API_URL configured: ${Boolean(DB_API_URL)}`);
});
