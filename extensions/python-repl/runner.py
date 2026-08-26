import ast
import contextlib
import importlib
import io
import json
import sys
import traceback


namespace = {"__name__": "__main__"}


def execute(code):
    stdout = io.StringIO()
    stderr = io.StringIO()
    result = None
    error = None

    try:
        importlib.invalidate_caches()
        module = ast.parse(code, mode="exec")
        final_expression = None
        if module.body and isinstance(module.body[-1], ast.Expr):
            final_expression = ast.Expression(module.body.pop().value)

        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if module.body:
                exec(compile(module, "<python_repl>", "exec"), namespace, namespace)
            if final_expression is not None:
                value = eval(compile(final_expression, "<python_repl>", "eval"), namespace, namespace)
                if value is not None:
                    result = repr(value)
    except BaseException:
        error = traceback.format_exc()

    return {
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "result": result,
        "error": error,
    }


def handle(request):
    global namespace
    action = request.get("action")
    if action == "execute":
        return execute(request["code"])
    if action == "clear":
        namespace = {"__name__": "__main__"}
        return {"cleared": True}
    raise ValueError(f"Unknown action: {action}")


for line in sys.stdin:
    request = json.loads(line)
    try:
        response = {"id": request["id"], "ok": True, "value": handle(request)}
    except BaseException:
        response = {"id": request.get("id"), "ok": False, "error": traceback.format_exc()}
    print(json.dumps(response), flush=True)
