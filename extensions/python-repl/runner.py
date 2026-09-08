import ast
import contextlib
import importlib
import json
import os
import sys
import tempfile
import traceback


namespace = {"__name__": "__main__"}
protocol = os.fdopen(3, "w", buffering=1)


def execute(code):
    result = None
    error = None
    saved_stdout = os.dup(1)
    saved_stderr = os.dup(2)

    try:
        importlib.invalidate_caches()
        module = ast.parse(code, mode="exec")
        final_expression = None
        if module.body and isinstance(module.body[-1], ast.Expr):
            final_expression = ast.Expression(module.body.pop().value)

        with tempfile.TemporaryFile() as captured_stdout, tempfile.TemporaryFile() as captured_stderr:
            os.dup2(captured_stdout.fileno(), 1)
            os.dup2(captured_stderr.fileno(), 2)
            stdout = os.fdopen(os.dup(1), "w", buffering=1)
            stderr = os.fdopen(os.dup(2), "w", buffering=1)
            try:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    if module.body:
                        exec(compile(module, "<python_repl>", "exec"), namespace, namespace)
                    if final_expression is not None:
                        value = eval(compile(final_expression, "<python_repl>", "eval"), namespace, namespace)
                        if value is not None:
                            result = repr(value)
            except BaseException:
                error = traceback.format_exc()
            finally:
                try:
                    stdout.flush()
                    stderr.flush()
                finally:
                    try:
                        stdout.close()
                        stderr.close()
                    finally:
                        os.dup2(saved_stdout, 1)
                        os.dup2(saved_stderr, 2)
            captured_stdout.seek(0)
            captured_stderr.seek(0)
            stdout_text = captured_stdout.read().decode(errors="replace")
            stderr_text = captured_stderr.read().decode(errors="replace")
    except BaseException:
        stdout_text = ""
        stderr_text = ""
        error = traceback.format_exc()
    finally:
        os.close(saved_stdout)
        os.close(saved_stderr)

    return {
        "stdout": stdout_text,
        "stderr": stderr_text,
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
    print(json.dumps(response), file=protocol, flush=True)
