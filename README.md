### ⚠️ DISCLAIMER - This might be against DeepSeek ToS, Use at your own risk ⚠️
![Deepseek-Scrape](https://github.com/Vxtzq/Deepseek-scrape/blob/main/title.png)
# Deepseek-Scrape

A local OpenAI-compatible API bridge that allows AI coding agents (Cline, Roo Code, Continue.dev, Cursor, and custom Python agents) to use Deepseek Studio models through a local network endpoint.

The bridge exposes an OpenAI-style API (`/v1/chat/completions`, `/v1/models`) and forwards requests to Deepseek Studio by controlling an authenticated browser session through lightweight DOM and network automation.

## Features

* ✅ Fully OpenAI-compatible API endpoint
* ✅ Works seamlessly with coding agents supporting custom OpenAI providers
* ✅ Supports dynamic Deepseek Studio web model switching (e.g., Deepseek3.7-Max, Deepseek3.7-Plus)
* ✅ Real-time streaming response support
* ✅ Localhost (accessible from `127.0.0.1`)
* ✅ No local model hosting or GPU required
* ✅ Compatible with OpenAI SDK / LangChain style clients

## Architecture

```text
Coding Agent (VS Code, Python, etc.)
     |
     | OpenAI API format (HTTP)
     v
Bridge Server (http://127.0.0.1:8000/v1)
     |
     | Command Queue & Stream Relay
     v
Browser Automation Script (Console Injection)
     |
     | Native DOM Injection & Network Interception
     v
Deepseek Studio Web Interface (Authenticated Session)
```

## Requirements

* Python 3.10+
* A valid, logged-in Deepseek Studio session in a Chromium-based browser (Chrome, Edge, Brave)
* Tampermonkey extension (Recommended) or manual Console access

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Vxtzq/Deepseek-scrape.git
   cd Deepseek-openai-bridge
   ```

2. Install Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```

## Usage

### 1. Start the Bridge Server

```bash
python server.py
```
You should see:
```text
🟢 BRIDGE ACTIVE.
🔑 API Key: sk-Deepseek-bridge-key
```

### 2. Connect the Browser Session

Paste the content inside paste_in_chrome.js in the browser's console. That's all.

### 3. Test everything works

```bash
python benchmark_api.py
```

## API Configuration

The bridge exposes its API on your local network. Find your local IP (e.g., `192.168.1.38`) and configure your agents as follows:

| Setting  | Value                                |
| -------- | ------------------------------------ |
| Base URL | `http://127.0.0.1:8000/v1`           |
| API Key  | `sk-deepseek-bridge-key`                 |
| Model    | `deepseek/deepseek-v4-pro` or `deepseek/deepseek-v4-flash`|

## Supported Clients

### Claude code / Deepseek code
1. Type /auth
2. Select "Custom provider"
3. Select "OpenAI-Compatible"
4. Enter `http://127.0.0.1:8000/v1`
5. Enter `sk-deepseek-bridge-key`
6. Add models (`deepseek/deepseek-v4-pro` and/or `deepseek/deepseek-v4-flash`)
7. Press enter (you can enable thinking...)
8. Enjoy!


### Cline / Roo Code (VS Code)
1. Open Cline Settings → **API Provider**.
2. Select **OpenAI Compatible**.
3. Enter the Base URL, API Key, and Model ID from the table above.
4. Click **Verify Connection**.

### Continue.dev
Add to your `config.json`:
```json
{
  "models": [
    {
      "title": "Deepseek Bridge (Max)",
      "provider": "openai",
      "model": "deepseek/deepseek-v4-pro",
      "apiBase": "http://192.168.1.38:8000/v1",
      "apiKey": "sk-deepseek-bridge-key"
    }
  ]
}
```

### Cursor
1. Go to **Cursor Settings** → **Models**.
2. Click **Add OpenAI Compatible Model**.
3. Fill in the Name, Base URL, API Key, and Model Name.

## Python Example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://192.168.1.38:8000/v1",
    api_key="sk-deepseek-bridge-key"
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-pro",
    messages=[{"role": "user", "content": "Write a Python script to parse JSON."}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

## Troubleshooting

### Connection Failed
* Ensure `server.py` is running.
* Ensure the Deepseek browser tab is open and the Tampermonkey script is active.
* Verify your Base URL includes `/v1` (e.g., `http://192.168.1.38:8000/v1`).

### Model Not Found
* Test the discovery endpoint in your browser: `http://192.168.1.38:8000/v1/models`
* Ensure the `model` string in your agent exactly matches one of the returned `id` values (e.g., `deepseek/deepseek-v4-pro`).

## Limitations
- Based on a web interface, might not be as reliable as a standard paid API
- Reasonning content is not available to this day
- Might be slower than a standard LLM API

## Security Notes

⚠️ **This project is intended for local, trusted network use only.** 
Do not expose port `8000` to the public internet. Your browser session contains authenticated access to your Deepseek account. 

## Disclaimer

This project interacts with a third-party web interface through browser automation and network interception. Use responsibly and respect the Terms of Service of the platforms you connect to. This is an unofficial community tool.

## License

MIT License
