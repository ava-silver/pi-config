import {
  CustomMessageComponent,
  type ExtensionAPI,
  ToolExecutionComponent,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text } from "@earendil-works/pi-tui";

import { COMPACT_ROW, type CompactRowMarker } from "./shared/compact-row.ts";

const COMPACT_CALL_LINES = 3;
const STATE_KEY = "outputCompaction";

type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type Theme = Parameters<CallRenderer>[1];
type RenderContext = Parameters<CallRenderer>[2];

type RowState = {
  call?: Component;
  result?: Component;
  hasResult?: boolean;
  compact?: boolean;
};

const rowState = (context: RenderContext): RowState => (context.state[STATE_KEY] ??= {});

const lines = (render: (width: number) => string[]): Component => ({
  render,
  invalidate() {},
});

const blank = lines(() => [""]);

const ANSI_SGR = /\x1b\[[0-9;]*m/g;
const isBlankLine = (line: string) => line.replace(ANSI_SGR, "").trim() === "";

// Some renderers (edit) wrap the call in a padded box and append a diff after a blank row. The compact
// row keeps only the first block of text.
const firstBlock = (rows: readonly string[]): string[] => {
  const start = rows.findIndex((row) => !isBlankLine(row));
  if (start === -1) return [];
  const rest = rows.slice(start);
  const end = rest.findIndex(isBlankLine);
  return rest.slice(0, end === -1 ? undefined : end);
};

const background = (context: RenderContext, theme: Theme) => {
  const color = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
  return (text: string) => theme.bg(color, text);
};

const shell = (context: RenderContext, theme: Theme, children: Component[]): Component => {
  const box = new Box(context.outputPad, 0, background(context, theme));
  children.forEach((child) => box.addChild(child));
  return box;
};

const isCompact = (context: RenderContext) => !context.expanded && !context.isPartial && !context.isError;

const textOutput = (result: Parameters<ResultRenderer>[0]) =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

// Pi puts a blank line above every tool row and custom message, and no public API removes it. These
// patches drop it between adjacent compact rows. They read the private `rendererState`, which is the
// `context.state` object passed to the renderers above.
type RowInternals = {
  rendererState?: Record<string, RowState | undefined>;
  joinsPrevious?: boolean;
};

const internals = (row: unknown) => row as RowInternals;

const isRow = (component: Component) =>
  component instanceof ToolExecutionComponent || component instanceof CustomMessageComponent;

const isCompactRow = (component: Component | undefined) =>
  (component instanceof ToolExecutionComponent && internals(component).rendererState?.[STATE_KEY]?.compact === true) ||
  (component instanceof CustomMessageComponent &&
    component.children.some((child) => (child as CompactRowMarker)[COMPACT_ROW]?.() === true));

function patchRowSpacing(): () => void {
  const container = Container.prototype;
  const originalRender = container.render;
  const unpatchRows = [ToolExecutionComponent.prototype, CustomMessageComponent.prototype].map(patchRow);

  container.render = function (this: Container, width: number) {
    this.children.forEach((child, index) => {
      if (!isRow(child)) return;
      internals(child).joinsPrevious =
        isCompactRow(child) &&
        isCompactRow(this.children.slice(0, index).findLast((previous) => previous.render(width).length > 0));
    });
    return originalRender.call(this, width);
  };

  return () => {
    container.render = originalRender;
    unpatchRows.forEach((unpatch) => unpatch());
  };
}

function patchRow(row: Container): () => void {
  const own = { render: Object.hasOwn(row, "render"), handleMouse: Object.hasOwn(row, "handleMouse") };
  const original = { render: row.render, handleMouse: row.handleMouse };

  row.render = function (this: Container, width: number) {
    const rendered = original.render.call(this, width);
    return internals(this).joinsPrevious && rendered[0] === "" ? rendered.slice(1) : rendered;
  };
  row.handleMouse = function (this: Container, event) {
    const shifted = internals(this).joinsPrevious ? { ...event, y: event.y + 1, height: event.height + 1 } : event;
    return original.handleMouse.call(this, shifted);
  };

  return () => {
    if (own.render) row.render = original.render;
    else delete (row as Partial<Container>).render;
    if (own.handleMouse) row.handleMouse = original.handleMouse;
    else delete (row as Partial<Container>).handleMouse;
  };
}

export default function (pi: ExtensionAPI) {
  const unpatchRowSpacing = patchRowSpacing();
  pi.on("session_shutdown", unpatchRowSpacing);

  pi.registerToolRenderer((toolName, next) => {
    const base = next();
    if (!base) return undefined;

    const renderCall: CallRenderer = (args, theme, context) => {
      const state = rowState(context);
      state.compact = isCompact(context);
      // Some renderers (edit) paint their own padded background. The compact shell supplies it instead.
      const callTheme = state.compact
        ? Object.create(theme, { bg: { value: (_color: string, text: string) => text } })
        : theme;
      const callContext = state.compact ? { ...context, outputPad: 0 } : context;
      state.call = base.renderCall
        ? base.renderCall(args, callTheme, { ...callContext, lastComponent: state.call })
        : new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
      const call = state.call;

      if (state.compact) {
        return shell(context, theme, [lines((width) => firstBlock(call.render(width)).slice(0, COMPACT_CALL_LINES))]);
      }
      return shell(context, theme, [blank, call, lines(() => (state.hasResult ? [] : [""]))]);
    };

    const renderResult: ResultRenderer = (result, options, theme, context) => {
      const state = rowState(context);
      state.hasResult = true;
      if (isCompact(context)) return new Container();

      state.result = base.renderResult
        ? base.renderResult(result, options, theme, { ...context, lastComponent: state.result })
        : new Text(theme.fg("toolOutput", textOutput(result)), 0, 0);
      return shell(context, theme, [state.result, blank]);
    };

    return { renderShell: "self", renderCall, renderResult };
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setToolsExpanded(false);
    ctx.ui.setHiddenThinkingLabel("");
  });
}
