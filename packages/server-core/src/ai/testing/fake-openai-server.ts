import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { extractJsonObject, SCHEMA_INSTRUCTION_LEAD } from '../output.js';

import type { AddressInfo, Socket } from 'node:net';

/** A forced answer to one chat call. */
export interface FakeOpenAiReply {
  /** HTTP status (default `200`). */
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Body sent as is, instead of a Chat Completions answer. */
  readonly raw?: string;
  /** `choices[0].message.content` (default: the deterministic answer). */
  readonly content?: string | null;
  readonly refusal?: string | null;
  /** Default `stop`. */
  readonly finishReason?: string;
  /** Answer after this long. */
  readonly delayMs?: number;
}

/** What the fake provider supports; tests change it between calls. */
export interface FakeOpenAiCapabilities {
  /** `false`: `400` to `response_format.type = json_schema`. */
  jsonSchema: boolean;
  /** `false`: `400` to `response_format.type = json_object`. */
  jsonObject: boolean;
  /** `false`: answers without `usage`. */
  usage: boolean;
  /** Every chat call answers this status (`400`, `429`, `500`…); `null`: none. */
  failWith: number | null;
  /** Every answer waits this long. */
  delayMs: number;
  /** Key required as `Authorization: Bearer`; `null`: none (a local provider). */
  apiKey: string | null;
}

export interface FakeOpenAiRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  /** The JSON body, `null` without one. */
  readonly body: Record<string, unknown> | null;
}

export interface FakeOpenAiServer {
  readonly port: number;
  /**
   * `http://localhost:<port>/v1`: the client needs the allowlist entry
   * `localhost:<port>` (a loopback host opens with an exact entry only) and a
   * lookup answering `127.0.0.1`.
   */
  readonly baseUrl: string;
  readonly capabilities: FakeOpenAiCapabilities;
  /** Every request received, in order (`/__script` excluded). */
  readonly requests: FakeOpenAiRequest[];
  /** The `POST /v1/chat/completions` requests. */
  chatRequests(): FakeOpenAiRequest[];
  /** TCP connections accepted so far. */
  connections(): number;
  /** Answers of the next chat calls, in order (also `POST /__script` with one reply or a list). */
  script(...replies: FakeOpenAiReply[]): void;
  /** Answers every chat call whose last message contains `marker`. */
  whenLastMessageContains(marker: string, reply: FakeOpenAiReply): void;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The smallest value a JSON Schema accepts: `null` when allowed, the first enum member, no array items. */
function minimal(node: Json): unknown {
  if (Array.isArray(node['enum'])) return node['enum'][0];
  if ('const' in node) return node['const'];
  const branches = node['anyOf'] ?? node['oneOf'];
  if (Array.isArray(branches)) {
    const objects = branches.filter(isJson);
    if (objects.some((branch) => branch['type'] === 'null')) return null;
    return objects[0] === undefined ? null : minimal(objects[0]);
  }
  const types = Array.isArray(node['type']) ? node['type'] : [node['type']];
  if (types.includes('null')) return null;
  switch (types[0]) {
    case 'object': {
      const properties = isJson(node['properties']) ? node['properties'] : {};
      return Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [
          key,
          isJson(child) ? minimal(child) : null,
        ]),
      );
    }
    case 'array': {
      const items = isJson(node['items']) ? node['items'] : {};
      const count = typeof node['minItems'] === 'number' ? node['minItems'] : 0;
      return Array.from({ length: count }, () => minimal(items));
    }
    case 'string':
      return 'fake';
    case 'integer':
    case 'number':
      return typeof node['minimum'] === 'number' ? node['minimum'] : 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

function contentOf(message: unknown): string {
  return isJson(message) && typeof message['content'] === 'string' ? message['content'] : '';
}

/**
 * The JSON Schema a call asks for: `response_format.json_schema.schema`, or
 * the one the lower rungs quote in the system prompt; `null` for text.
 */
function requestedSchema(body: Json): Json | null {
  const format = body['response_format'];
  if (isJson(format) && isJson(format['json_schema']) && isJson(format['json_schema']['schema'])) {
    return format['json_schema']['schema'];
  }
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  for (const message of messages) {
    const text = contentOf(message);
    const at = text.indexOf(SCHEMA_INSTRUCTION_LEAD);
    if (isJson(message) && message['role'] === 'system' && at !== -1) {
      return extractJsonObject(text.slice(at + SCHEMA_INSTRUCTION_LEAD.length)) ?? null;
    }
  }
  return null;
}

/** Deterministic answer: JSON = minimal instance of the schema; text = prefix + hash of the last message. */
function deterministicContent(body: Json): string {
  const schema = requestedSchema(body);
  if (schema !== null) return JSON.stringify(minimal(schema));
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const last = contentOf(messages[messages.length - 1]);
  return `fake: ${createHash('sha256').update(last).digest('hex').slice(0, 12)}`;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function errorBody(message: string, param: string | null = null) {
  return { error: { message, type: 'invalid_request_error', param, code: null } };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An OpenAI-compatible provider on a free loopback port (research §4.7,
 * ADR-39) — `node:http`, no dependency: `GET /v1/models`,
 * `POST /v1/chat/completions` (non-streaming). Answers come from the script
 * queue, then from markers in the last message, then deterministically.
 * Capabilities (`json_schema`, `json_object`, `usage`, forced errors, delay)
 * can be switched off to walk the structured-output ladder. Every request is
 * recorded (tests assert what was — and was not — sent). Test code only.
 */
export async function startFakeOpenAiServer(
  options: { readonly capabilities?: Partial<FakeOpenAiCapabilities> } = {},
): Promise<FakeOpenAiServer> {
  const capabilities: FakeOpenAiCapabilities = {
    jsonSchema: true,
    jsonObject: true,
    usage: true,
    failWith: null,
    delayMs: 0,
    apiKey: null,
    ...options.capabilities,
  };
  const requests: FakeOpenAiRequest[] = [];
  const queue: FakeOpenAiReply[] = [];
  const markers: { marker: string; reply: FakeOpenAiReply }[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  let served = 0;

  const chat = async (body: Json, response: ServerResponse): Promise<void> => {
    const format = body['response_format'];
    const formatType = isJson(format) ? format['type'] : undefined;
    if (capabilities.failWith !== null) {
      await delay(capabilities.delayMs);
      sendJson(response, capabilities.failWith, errorBody('Forced failure.'));
      return;
    }
    if (
      (formatType === 'json_schema' && !capabilities.jsonSchema) ||
      (formatType === 'json_object' && !capabilities.jsonObject)
    ) {
      sendJson(response, 400, errorBody('response_format is not supported.', 'response_format'));
      return;
    }
    const messages = Array.isArray(body['messages']) ? body['messages'] : [];
    const last = contentOf(messages[messages.length - 1]);
    const reply =
      queue.shift() ?? markers.find((entry) => last.includes(entry.marker))?.reply ?? {};
    await delay(capabilities.delayMs + (reply.delayMs ?? 0));
    if (reply.raw !== undefined) {
      response.writeHead(reply.status ?? 200, { ...reply.headers });
      response.end(reply.raw);
      return;
    }
    if (reply.status !== undefined && (reply.status < 200 || reply.status > 299)) {
      sendJson(response, reply.status, errorBody('Scripted failure.'), reply.headers);
      return;
    }
    const content = reply.content === undefined ? deterministicContent(body) : reply.content;
    served += 1;
    const promptChars = messages.map(contentOf).join('').length;
    sendJson(
      response,
      reply.status ?? 200,
      {
        id: `chatcmpl-fake-${String(served)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: typeof body['model'] === 'string' ? body['model'] : 'fake-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content, refusal: reply.refusal ?? null },
            finish_reason: reply.finishReason ?? 'stop',
          },
        ],
        ...(capabilities.usage
          ? {
              usage: {
                prompt_tokens: Math.ceil(promptChars / 4),
                completion_tokens: Math.ceil((content ?? '').length / 4),
                total_tokens: Math.ceil(promptChars / 4) + Math.ceil((content ?? '').length / 4),
              },
            }
          : {}),
      },
      reply.headers,
    );
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // Not JSON: recorded with a `null` body.
    }
    const body = isJson(parsed) ? parsed : null;
    const path = (request.url ?? '').split('?')[0] ?? '';
    const method = request.method ?? '';
    if (method === 'POST' && path === '/__script') {
      const replies = Array.isArray(parsed) ? parsed : [parsed];
      queue.push(...(replies.filter(isJson) as FakeOpenAiReply[]));
      response.writeHead(204).end();
      return;
    }
    requests.push({ method, path, headers: request.headers, body });
    if (
      capabilities.apiKey !== null &&
      request.headers.authorization !== `Bearer ${capabilities.apiKey}`
    ) {
      sendJson(response, 401, errorBody('Incorrect API key provided.'));
      return;
    }
    if (method === 'GET' && path === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: 'fake-model', object: 'model', created: 0, owned_by: 'cellhive-test' }],
      });
      return;
    }
    if (method === 'POST' && path === '/v1/chat/completions') {
      if (body === null) {
        sendJson(response, 400, errorBody('The body is not JSON.'));
        return;
      }
      await chat(body, response);
      return;
    }
    sendJson(response, 404, errorBody('Not found.'));
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('connection', (socket: Socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    baseUrl: `http://localhost:${String(port)}/v1`,
    capabilities,
    requests,
    chatRequests: () =>
      requests.filter((entry) => entry.method === 'POST' && entry.path === '/v1/chat/completions'),
    connections: () => connections,
    script: (...replies) => {
      queue.push(...replies);
    },
    whenLastMessageContains: (marker, reply) => {
      markers.push({ marker, reply });
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
