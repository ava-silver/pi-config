import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";

import { refreshCredentials, withDeadline } from "./auth.ts";
import { readCredentials } from "./credentials.ts";

const MCP_URL = "https://mcp.slack.com/mcp";
const REQUEST_TIMEOUT_MS = 60_000;
const AUTH_REQUIRED = "Slack authentication required. Call slack_auth, then retry the Slack operation.";

interface JsonRpcError {
  message?: string;
}

interface JsonRpcResponse {
  error?: JsonRpcError;
  result?: {
    content?: unknown;
    isError?: boolean;
  };
}

let requestId = 0;

async function forward(body: string, accessToken: string, signal?: AbortSignal): Promise<Response> {
  return fetch(MCP_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body,
    signal: withDeadline(signal, REQUEST_TIMEOUT_MS),
  });
}

async function request(body: string, signal?: AbortSignal): Promise<Response> {
  const credentials = await readCredentials(signal);
  if (!credentials?.accessToken) throw new Error(AUTH_REQUIRED);

  const response = await forward(body, credentials.accessToken, signal);
  if (response.status !== 401) return response;
  if (!credentials.refreshToken) throw new Error(AUTH_REQUIRED);

  try {
    const refreshed = await refreshCredentials(credentials.refreshToken, signal);
    return await forward(body, refreshed.accessToken, signal);
  } catch {
    throw new Error(AUTH_REQUIRED);
  }
}

function parseResponse(body: string): JsonRpcResponse {
  try {
    return JSON.parse(body) as JsonRpcResponse;
  } catch {
    const data = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .at(-1);
    if (!data) throw new Error("Slack returned an invalid response.");
    return JSON.parse(data) as JsonRpcResponse;
  }
}

function formatContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((item) => {
      if (typeof item === "object" && item !== null && "text" in item && typeof item.text === "string") {
        return item.text;
      }
      return JSON.stringify(item);
    })
    .join("\n");
}

function truncate(content: string): string {
  const result = truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return result.truncated ? `${result.content}\n\n[Slack output truncated.]` : result.content;
}

export async function callSlackTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: ++requestId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const response = await request(body, signal);
  if (response.status === 401) throw new Error(AUTH_REQUIRED);
  if (!response.ok) throw new Error(`Slack request failed: ${response.status} ${response.statusText}`);

  const payload = parseResponse(await response.text());
  if (payload.error?.message) throw new Error(payload.error.message);
  if (payload.result?.isError) throw new Error(formatContent(payload.result.content));
  return truncate(formatContent(payload.result?.content));
}

export async function resolveChannel(channel: string, signal?: AbortSignal): Promise<string> {
  const value = channel.trim();
  if (/^[CGDU][A-Z0-9]+$/.test(value)) return value;

  const result = await callSlackTool("slack_search_channels", { query: value.replace(/^#/, ""), limit: 1 }, signal);
  const match = result.match(/"(?:channel_)?id"\s*:\s*"([CG][A-Z0-9]+)"/);
  if (!match?.[1]) throw new Error(`Could not find Slack channel ${channel}. Use a channel ID instead.`);
  return match[1];
}
