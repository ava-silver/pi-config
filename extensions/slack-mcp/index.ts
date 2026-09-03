import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { authenticate } from "./auth.ts";
import { callSlackTool, resolveChannel } from "./client.ts";

const AUTH_REQUIRED_MESSAGE = "This opens Slack in your browser. Approve the connection to let Pi use Slack.";
const SEARCH_LIMIT = 10;
const READ_CHANNEL_LIMIT = 50;

const SearchParams = Type.Object({
  query: Type.String({
    description: "Slack search query. Supports filters such as in:#channel, from:name, and after:YYYY-MM-DD.",
  }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: SEARCH_LIMIT, description: `Results to return, up to ${SEARCH_LIMIT}.` }),
  ),
});

const ReadChannelParams = Type.Object({
  channel: Type.String({ description: "A Slack channel name, such as #team-platform, or a channel ID." }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: READ_CHANNEL_LIMIT,
      description: `Messages to return, up to ${READ_CHANNEL_LIMIT}.`,
    }),
  ),
});

const ReadThreadParams = Type.Object({
  channel: Type.String({ description: "A Slack channel name or ID." }),
  message_ts: Type.String({ description: "Parent message timestamp from a Slack search or channel result." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Replies to return, up to 100." })),
});

const ReadFileParams = Type.Object({
  file_id: Type.String({ description: "File ID from a Slack search, channel, or thread result." }),
});

const CreateDraftParams = Type.Object({
  channel: Type.String({ description: "A Slack channel name or ID." }),
  message: Type.String({ description: "Draft message in Slack Markdown." }),
  thread_ts: Type.Optional(Type.String({ description: "Parent message timestamp for a thread reply draft." })),
});

async function connectSlack(ctx: ExtensionContext, signal?: AbortSignal): Promise<{ team: string } | undefined> {
  if (!ctx.hasUI) throw new Error("Slack authentication requires Pi's interactive UI. Run /slack-auth in Pi.");

  const approved = await ctx.ui.confirm(
    "Connect Slack?",
    AUTH_REQUIRED_MESSAGE,
    signal === undefined ? {} : { signal },
  );
  if (!approved) return undefined;

  ctx.ui.notify("Opening Slack authorization in your browser…", "info");
  const result = await authenticate({
    ...(signal === undefined ? {} : { signal }),
    onAuthorizationUrl: (url) => ctx.ui.notify(`If no browser opened, open: ${url}`, "info"),
  });
  ctx.ui.notify(`Connected to ${result.team}.`, "info");
  return result;
}

function text(content: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: content }], details };
}

export default function slackExtension(pi: ExtensionAPI): void {
  pi.registerCommand("slack-auth", {
    description: "Connect or reconnect Slack",
    handler: async (_args, ctx) => {
      await connectSlack(ctx);
    },
  });

  pi.registerTool({
    name: "slack_auth",
    label: "Authenticate Slack",
    description: "Connect Slack. Opens a browser for the user to approve access.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      onUpdate?.(text("Waiting for Slack authorization…"));
      const result = await connectSlack(ctx, signal);
      return result
        ? text(`Connected to ${result.team}. Retry the Slack operation.`, { connected: true, team: result.team })
        : text("Slack authentication was cancelled. Ask the user to run /slack-auth when ready.", { connected: false });
    },
  });

  pi.registerTool({
    name: "slack_search",
    label: "Search Slack",
    description:
      "Search messages and files across every Slack conversation the user can access. Returns at most 10 results.",
    parameters: SearchParams,
    async execute(_toolCallId, params, signal) {
      return text(
        await callSlackTool(
          "slack_search_public_and_private",
          { query: params.query, limit: params.limit ?? SEARCH_LIMIT },
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: "slack_read_channel",
    label: "Read Slack channel",
    description: "Read recent messages from a Slack channel. Returns at most 50 messages.",
    parameters: ReadChannelParams,
    async execute(_toolCallId, params, signal) {
      const channelId = await resolveChannel(params.channel, signal);
      return text(
        await callSlackTool(
          "slack_read_channel",
          { channel_id: channelId, limit: params.limit ?? READ_CHANNEL_LIMIT },
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: "slack_read_thread",
    label: "Read Slack thread",
    description: "Read a Slack message and its replies.",
    parameters: ReadThreadParams,
    async execute(_toolCallId, params, signal) {
      const channelId = await resolveChannel(params.channel, signal);
      return text(
        await callSlackTool(
          "slack_read_thread",
          { channel_id: channelId, message_ts: params.message_ts, limit: params.limit ?? 100 },
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: "slack_read_file",
    label: "Read Slack file",
    description:
      "Read a file referenced by a Slack search, channel, or thread result. Output is truncated to 50 KB or 2,000 lines.",
    parameters: ReadFileParams,
    async execute(_toolCallId, params, signal) {
      return text(await callSlackTool("slack_read_file", { file_id: params.file_id }, signal));
    },
  });

  pi.registerTool({
    name: "slack_create_draft",
    label: "Create Slack draft",
    description: "Create an unsent Slack message draft. Never sends a message.",
    parameters: CreateDraftParams,
    async execute(_toolCallId, params, signal) {
      const channelId = await resolveChannel(params.channel, signal);
      return text(
        await callSlackTool(
          "slack_send_message_draft",
          {
            channel_id: channelId,
            message: params.message,
            ...(params.thread_ts ? { thread_ts: params.thread_ts } : {}),
          },
          signal,
        ),
      );
    },
  });
}
