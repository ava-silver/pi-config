import { type ExtensionAPI, ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Text } from "@earendil-works/pi-tui";

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

// Pi puts a blank line above every tool row, and no public API removes it. These patches drop it
// between adjacent compact rows. They read the private `rendererState`, which is the `context.state`
// object passed to the renderers above.
type RowInternals = {
  rendererState?: Record<string, RowState | undefined>;
  joinsPrevious?: boolean;
};

const internals = (row: unknown) => row as RowInternals;

const isCompactRow = (component: Component | undefined) =>
  component instanceof ToolExecutionComponent && internals(component).rendererState?.[STATE_KEY]?.compact === true;

function patchRowSpacing(): () => void {
  const container = Container.prototype;
  const row = ToolExecutionComponent.prototype;
  const original = { render: container.render, rowRender: row.render, rowMouse: row.handleMouse };

  container.render = function (this: Container, width: number) {
    this.children.forEach((child, index) => {
      if (!(child instanceof ToolExecutionComponent)) return;
      internals(child).joinsPrevious =
        isCompactRow(child) &&
        isCompactRow(this.children.slice(0, index).findLast((previous) => previous.render(width).length > 0));
    });
    return original.render.call(this, width);
  };
  row.render = function (this: ToolExecutionComponent, width: number) {
    const rendered = original.rowRender.call(this, width);
    return internals(this).joinsPrevious && rendered[0] === "" ? rendered.slice(1) : rendered;
  };
  row.handleMouse = function (this: ToolExecutionComponent, event) {
    const shifted = internals(this).joinsPrevious ? { ...event, y: event.y + 1, height: event.height + 1 } : event;
    return original.rowMouse.call(this, shifted);
  };

  return () => {
    container.render = original.render;
    row.render = original.rowRender;
    row.handleMouse = original.rowMouse;
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
      state.call = base.renderCall
        ? base.renderCall(args, theme, { ...context, lastComponent: state.call })
        : new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
      const call = state.call;
      state.compact = isCompact(context);

      if (state.compact) {
        return shell(context, theme, [lines((width) => call.render(width).slice(0, COMPACT_CALL_LINES))]);
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
