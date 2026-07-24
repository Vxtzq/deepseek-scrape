from fastapi import FastAPI, Request, HTTPException, Header
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import queue
import asyncio
import uuid
import json
import re
import ast
from collections import deque

# Cache pour éviter les appels en double
recent_prompts = deque(maxlen=5)

app = FastAPI(title="DeepSeek God-Mode Bridge", version="5.7")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_KEY = "sk-deepseek-bridge-key"

# Mapping des modèles (ajustez selon vos besoins)
MODEL_MAP = {
    "deepseek/deepseek-v4-pro": "DeepSeek-V4-Pro",
    "deepseek/deepseek-v4-flash": "DeepSeek-V4-Flash",
    "deepseek/generic": "DeepSeek-V4-Pro",  # fallback
}

# Pas de mode raisonnement séparé pour DeepSeek (cf. limitations README)
# On garde une variable pour compatibilité, mais elle ne changera pas.
current_reasoning_mode = None

command_queue = queue.Queue()
response_queue: asyncio.Queue | None = None
response_lock = asyncio.Lock()
is_processing = False
current_ui_model = "DeepSeek-V4-Pro"

# Prompt système pour les appels d'outils (identique à Qwen, car basé sur des blocs <tool_call>)
TOOL_SYSTEM_PROMPT = """
You are a precise tool-calling engine.
When you need to use a tool, you MUST respond with one or more <tool_call> blocks.

STRICT FORMAT RULES:
1. The content inside <tool_call> MUST be a strictly valid JSON object.
2. DO NOT use XML tags (like <tool_name> or <content>) inside the block.
3. DO NOT wrap the JSON in markdown code blocks (no ```json ... ```).
4. The JSON object must have exactly two keys: "name" (string) and "arguments" (object).

Correct Example:
<tool_call>{"name": "write_file", "arguments": {"file_path": "/home/user/test.py", "content": "print('hello')\n"}}</tool_call>

Incorrect Example (FORBIDDEN - DO NOT DO THIS):
<tool_call>
    <tool_name>write_file</tool_name>
    <content>print('hello')</content>
</tool_call>
""".strip()


def _parse_json_robust(s: str):
    s = s.strip()
    if not s:
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        try:
            parsed = ast.literal_eval(s)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return None


def _process_candidate(candidate, allowed_tools, result_list, seen_names):
    name = str(candidate.get("name") or candidate.get("tool") or "").strip()
    args = candidate.get("arguments") or candidate.get("args") or {}
    if not name or (allowed_tools and name not in allowed_tools) or name in seen_names:
        return
    try:
        if isinstance(args, str):
            parsed_args = _parse_json_robust(args)
            args_str = json.dumps(parsed_args if parsed_args else {"raw": args}, ensure_ascii=False)
        else:
            args_str = json.dumps(args, ensure_ascii=False)
    except Exception:
        args_str = "{}"
    result_list.append({
        "index": len(result_list),
        "id": f"call_{uuid.uuid4().hex[:8]}",
        "type": "function",
        "function": {"name": name, "arguments": args_str}
    })
    seen_names.add(name)


def convert_llm_output_to_openai_tool_calls(text: str, allowed_tools: list = None):
    openai_tool_calls, seen_names = [], set()
    for pattern in [r"<tool_call>\s*(.*?)\s*</tool_call>", r"<tool_use>\s*(.*?)\s*</tool_use>"]:
        for match in re.finditer(pattern, text, re.DOTALL | re.IGNORECASE):
            parsed = _parse_json_robust(match.group(1))
            if parsed:
                _process_candidate(parsed, allowed_tools, openai_tool_calls, seen_names)
    return openai_tool_calls


def clean_text_from_tool_calls(text: str) -> str:
    text = re.sub(r"<tool_call>.*?</tool_call>", "", text, flags=re.DOTALL | re.IGNORECASE)
    return re.sub(r"<tool_use>.*?</tool_use>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()


@app.get("/v1/models")
async def list_models():
    models = [{"id": k, "object": "model", "created": 1677652288, "owned_by": "deepseek-bridge"} for k in MODEL_MAP.keys()]
    return {"object": "list", "data": models}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: str = Header(None)):
    global is_processing, response_queue, current_ui_model

    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid API Key")

    data = await request.json()
    messages = data.get("messages", [])
    stream = data.get("stream", True)
    requested_model = data.get("model", "deepseek/generic")
    tools = data.get("tools", [])

    has_tools = bool(tools)
    allowed_tool_names = [t["function"]["name"] for t in tools] if has_tools else []

    # Injection du prompt système pour les outils si nécessaire
    if has_tools:
        tool_prompt = TOOL_SYSTEM_PROMPT + "\n\nAvailable tools:\n"
        for t in tools:
            fn = t.get("function", {})
            tool_prompt += f"- {fn.get('name')}: {fn.get('description')}\n"
        if messages and messages[0].get("role") == "system":
            messages[0]["content"] += "\n\n" + tool_prompt
        else:
            messages.insert(0, {"role": "system", "content": tool_prompt.strip()})

    # Construction du prompt textuel
    prompt = "\n".join([f"{m['role']}: {m['content']}" for m in messages])

    target_ui_model = MODEL_MAP.get(requested_model, "DeepSeek-V4-Pro")
    task_id = str(uuid.uuid4())

    # Vérification du cache pour éviter les doublons
    for cached_prompt, cached_response in recent_prompts:
        if cached_prompt == prompt:
            print(f"♻️ [API] Duplicate prompt detected, returning cached response ({len(cached_response)} chars)", flush=True)
            if stream:
                async def cached_generator():
                    yield f"data: {json.dumps({'id': f'chatcmpl-{task_id}', 'object': 'chat.completion.chunk', 'created': 1677652288, 'model': requested_model, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': cached_response}, 'finish_reason': None}]})}\n\n"
                    yield f"data: {json.dumps({'id': f'chatcmpl-{task_id}', 'object': 'chat.completion.chunk', 'created': 1677652288, 'model': requested_model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
                    yield "data: [DONE]\n\n"
                return StreamingResponse(cached_generator(), media_type="text/event-stream")
            else:
                return {
                    "id": f"chatcmpl-{task_id}", "object": "chat.completion", "created": 1677652288, "model": requested_model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": cached_response}, "finish_reason": "stop"}]
                }

    # Verrou pour éviter les appels simultanés
    async with response_lock:
        if is_processing:
            raise HTTPException(status_code=429, detail="Bridge is busy.")
        is_processing = True
        response_queue = asyncio.Queue()

    # Changement de modèle si nécessaire
    if target_ui_model != current_ui_model:
        print(f"\n🔄 [API] Switching UI model to: {target_ui_model}...", flush=True)
        current_ui_model = target_ui_model
        command_queue.put({"action": "switch_model", "model": target_ui_model})
        await asyncio.sleep(2.0)

    # DeepSeek n'a pas de basculement Think/Fast, on ignore le mode raisonnement
    # (le paramètre reasoning_effort est simplement ignoré)

    command_queue.put({"action": "send_prompt", "prompt": prompt})
    print(f"\n📡 [API] Forwarding to browser (Model: {target_ui_model}, Stream: {stream}, HasTools: {has_tools})...", flush=True)

    # 🎯 MODE STREAMING
    if stream:
        async def event_generator():
            global response_queue, is_processing

            content_buffer = ""
            has_function_call = False
            current_tool_call_id = None

            try:
                # Pas de contenu de raisonnement séparé, on envoie juste du contenu standard
                # On peut éventuellement envoyer un delta vide pour le rôle assistant
                yield f"data: {json.dumps({'id': f'chatcmpl-{task_id}', 'object': 'chat.completion.chunk', 'created': 1677652288, 'model': requested_model, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}, 'finish_reason': None}]})}\n\n"

                while True:
                    token_data = await asyncio.wait_for(response_queue.get(), timeout=120.0)
                    if token_data.get("type") == "done":
                        break

                    # On ignore le type "reasoning" car DeepSeek ne le supporte pas
                    if token_data.get("type") == "content":
                        text = token_data["text"]
                        content_buffer += text
                        yield f"data: {json.dumps({'id': f'chatcmpl-{task_id}', 'object': 'chat.completion.chunk', 'created': 1677652288, 'model': requested_model, 'choices': [{'index': 0, 'delta': {'content': text}, 'finish_reason': None}]})}\n\n"

                    elif token_data.get("type") == "function_call":
                        has_function_call = True
                        name = token_data.get("name", "")
                        args = token_data.get("arguments", "")

                        if name and not current_tool_call_id:
                            current_tool_call_id = f"call_{uuid.uuid4().hex[:24]}"
                            tool_call_chunk = {
                                "index": 0,
                                "id": current_tool_call_id,
                                "type": "function",
                                "function": {"name": name, "arguments": args or ""}
                            }
                        else:
                            tool_call_chunk = {
                                "index": 0,
                                "function": {"arguments": args}
                            }

                        yield f"data: {json.dumps({'id': f'chatcmpl-{task_id}', 'object': 'chat.completion.chunk', 'created': 1677652288, 'model': requested_model, 'choices': [{'index': 0, 'delta': {'content': None, 'tool_calls': [tool_call_chunk]}, 'finish_reason': None}]})}\n\n"

                if has_function_call:
                    yield f"data: {json.dumps({'id': f'chatcmpl-{task_id}', 'object': 'chat.completion.chunk', 'created': 1677652288, 'model': requested_model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]})}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                # Détection des appels d'outils dans le texte (fallback)
                if has_tools:
                    openai_tool_calls = convert_llm_output_to_openai_tool_calls(content_buffer, allowed_tools=allowed_tool_names)
                    if openai_tool_calls:
                        print(f"✅ [API] {len(openai_tool_calls)} tool call(s) detected (text fallback).", flush=True)
                        yield f"data: {json.dumps({'id': f'chatcmpl-{task_id}', 'object': 'chat.completion.chunk', 'created': 1677652288, 'model': requested_model, 'choices': [{'index': 0, 'delta': {'content': None, 'tool_calls': openai_tool_calls}, 'finish_reason': 'tool_calls'}]})}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                # Mise en cache de la réponse propre
                clean_text = clean_text_from_tool_calls(content_buffer)
                recent_prompts.append((prompt, clean_text))

                yield f"data: {json.dumps({'id': f'chatcmpl-{task_id}', 'object': 'chat.completion.chunk', 'created': 1677652288, 'model': requested_model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
                yield "data: [DONE]\n\n"

            except asyncio.TimeoutError:
                print("⚠️ [API] Timeout 120s", flush=True)
                yield "data: [DONE]\n\n"
            finally:
                async with response_lock:
                    is_processing = False
                    response_queue = None

        return StreamingResponse(event_generator(), media_type="text/event-stream")

    # 🎯 MODE NON-STREAMING
    else:
        full_response = ""
        try:
            while True:
                token_data = await asyncio.wait_for(response_queue.get(), timeout=120.0)
                if token_data.get("type") == "done":
                    break
                if token_data.get("type") == "content":
                    full_response += token_data["text"]
                # On ignore le type reasoning
        except asyncio.TimeoutError:
            print("⚠️ [API] Timeout 120s", flush=True)
        finally:
            async with response_lock:
                is_processing = False
                response_queue = None

        if has_tools:
            openai_tool_calls = convert_llm_output_to_openai_tool_calls(full_response, allowed_tools=allowed_tool_names)
            if openai_tool_calls:
                return {
                    "id": f"chatcmpl-{task_id}", "object": "chat.completion", "created": 1677652288, "model": requested_model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": openai_tool_calls}, "finish_reason": "tool_calls"}]
                }

        clean_text = clean_text_from_tool_calls(full_response)
        recent_prompts.append((prompt, clean_text))
        return {
            "id": f"chatcmpl-{task_id}", "object": "chat.completion", "created": 1677652288, "model": requested_model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": clean_text}, "finish_reason": "stop"}]
        }


@app.post("/deepseek-stream")
async def receive_stream(request: Request):
    global response_queue
    data = await request.json()

    if data.get("type") == "stream":
        content = data.get("content", "")
        # On ignore le champ reasoning (s'il est envoyé par le script)
        if response_queue is not None:
            if content:
                print(f"📝 [Server] Received content ({len(content)} chars)", flush=True)
                await response_queue.put({"type": "content", "text": content})

    elif data.get("type") == "function_call":
        name = data.get("name", "")
        args = data.get("arguments", "")
        if response_queue is not None:
            print(f"🔧 [Server] Received function_call: {name}", flush=True)
            await response_queue.put({"type": "function_call", "name": name, "arguments": args})

    elif data.get("type") == "done":
        print("\n" + "="*60, flush=True)
        print("✅ DEEPSEEK FINISHED!", flush=True)
        print("="*60 + "\n", flush=True)
        if response_queue is not None:
            await response_queue.put({"type": "done"})

    elif data.get("type") == "error":
        print(f"\n❌ [API] BROWSER ERROR: {data.get('content')}", flush=True)
        if response_queue is not None:
            await response_queue.put({"type": "done"})

    return {"status": "ok"}


@app.get("/pending-command")
async def get_command():
    try:
        return command_queue.get_nowait()
    except queue.Empty:
        return {"action": None}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
