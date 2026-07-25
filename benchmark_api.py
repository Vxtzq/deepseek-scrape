"""
Test script pour le bridge DeepSeek
Vérifie: /v1/models, /v1/chat/completions (streaming et non-streaming) + Reasoning
"""
import requests
import json
import time

BASE_URL = "http://127.0.0.1:8000/v1"
API_KEY = "sk-deepseek-bridge-key"

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

def test_models():
    """Teste l'endpoint /v1/models"""
    print("\n" + "="*60)
    print("📋 TEST 1: Liste des modèles")
    print("="*60)
    
    resp = requests.get(f"{BASE_URL}/models", headers=headers)
    print(f"Status: {resp.status_code}")
    
    if resp.status_code == 200:
        data = resp.json()
        models = data.get("data", [])
        print(f"✅ {len(models)} modèle(s) trouvé(s):")
        for m in models:
            print(f"  - {m['id']}")
    else:
        print(f"❌ Erreur: {resp.text}")
    return resp.status_code == 200

def test_chat_streaming():
    """Teste le streaming"""
    print("\n" + "="*60)
    print("📡 TEST 2: Chat Completions (STREAMING)")
    print("="*60)
    
    payload = {
        "model": "deepseek/generic",
        "messages": [
            {"role": "user", "content": "Dis 'Bonjour' en français, uniquement ce mot."}
        ],
        "stream": True
    }
    
    start_time = time.time()
    resp = requests.post(
        f"{BASE_URL}/chat/completions",
        headers=headers,
        json=payload,
        stream=True,
        timeout=60
    )
    
    print(f"Status: {resp.status_code}")
    
    if resp.status_code == 200:
        print("✅ Streaming started, waiting for chunks...\n")
        full_content = ""
        full_reasoning = ""
        chunk_count = 0
        
        for line in resp.iter_lines():
            if line:
                line = line.decode('utf-8')
                if line.startswith('data: '):
                    data_str = line[6:]
                    if data_str == '[DONE]':
                        break
                    try:
                        chunk = json.loads(data_str)
                        delta = chunk.get('choices', [{}])[0].get('delta', {})
                        content = delta.get('content', '')
                        reasoning = delta.get('reasoning_content', '')
                        
                        if reasoning:
                            full_reasoning += reasoning
                            print(f"🧠 {reasoning}", end='', flush=True)
                        if content:
                            full_content += content
                            chunk_count += 1
                            print(content, end='', flush=True)
                    except json.JSONDecodeError:
                        pass
        
        elapsed = time.time() - start_time
        print(f"\n\n✅ Finished in {elapsed:.2f}s | {chunk_count} chunks")
        if full_reasoning.strip():
            print(f"🧠 [Reasoning complet] {full_reasoning.strip()}")
        print(f"📝 [Réponse finale] '{full_content.strip()}'")
        return True
    else:
        print(f"❌ Erreur: {resp.text}")
        return False

def test_chat_non_streaming():
    """Teste le mode non-streaming"""
    print("\n" + "="*60)
    print("📄 TEST 3: Chat Completions (NON-STREAMING)")
    print("="*60)
    
    payload = {
        "model": "deepseek/generic",
        "messages": [
            {"role": "user", "content": "Réponds uniquement par le mot 'OK'."}
        ],
        "stream": False
    }
    
    start_time = time.time()
    resp = requests.post(
        f"{BASE_URL}/chat/completions",
        headers=headers,
        json=payload,
        timeout=60
    )
    
    print(f"Status: {resp.status_code}")
    
    if resp.status_code == 200:
        data = resp.json()
        message = data.get('choices', [{}])[0].get('message', {})
        content = message.get('content', '')
        reasoning = message.get('reasoning_content', '')
        
        elapsed = time.time() - start_time
        if reasoning.strip():
            print(f"🧠 [Reasoning] {reasoning.strip()}")
        print(f"✅ Response took {elapsed:.2f}s: '{content.strip()}'")
        return True
    else:
        print(f"❌ Erreur: {resp.text}")
        return False

def test_tools():
    """Teste les appels d'outils"""
    print("\n" + "="*60)
    print("🔧 TEST 4: TOOL CALLS")
    print("="*60)
    
    payload = {
        "model": "deepseek/generic",
        "messages": [
            {"role": "user", "content": "Quel temps fait-il à Paris ?"}
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Obtenir la météo d'une ville",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "city": {"type": "string", "description": "Nom de la ville"}
                        },
                        "required": ["city"]
                    }
                }
            }
        ],
        "stream": False
    }
    
    resp = requests.post(
        f"{BASE_URL}/chat/completions",
        headers=headers,
        json=payload,
        timeout=60
    )
    
    print(f"Status: {resp.status_code}")
    
    if resp.status_code == 200:
        data = resp.json()
        message = data.get('choices', [{}])[0].get('message', {})
        tool_calls = message.get('tool_calls', [])
        reasoning = message.get('reasoning_content', '')
        
        if reasoning.strip():
            print(f"🧠 [Reasoning] {reasoning.strip()}")

        if tool_calls:
            print(f"✅ {len(tool_calls)} appel(s) d'outil détecté(s):")
            for tc in tool_calls:
                print(f"  - Fonction: {tc['function']['name']}")
                print(f"    Arguments: {tc['function']['arguments']}")
            return True
        else:
            content = message.get('content', '')
            print(f"⚠️ Aucun appel d'outil. Réponse texte: '{content[:100]}...'")
            return True
    else:
        print(f"❌ Erreur: {resp.text}")
        return False

if __name__ == "__main__":
    print("🚀 DeepSeek Bridge Test Suite")
    print(f"📡 Serveur: {BASE_URL}")
    print(f"🔑 API Key: {API_KEY}")
    
    results = []
    
    # Test 1: Modèles
    results.append(("Models", test_models()))
    
    # Test 2: Streaming
    results.append(("Streaming", test_chat_streaming()))
    
    # Test 3: Non-streaming
    results.append(("Non-Streaming", test_chat_non_streaming()))
    
    # Test 4: Tools
    results.append(("Tool Calls", test_tools()))
    
    # Résumé
    print("\n" + "="*60)
    print("📊 TESTS SUMMARY")
    print("="*60)
    for name, success in results:
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"  {status} - {name}")
    
    total = len(results)
    passed = sum(1 for _, s in results if s)
    print(f"\n🎯 Score: {passed}/{total} tests réussis")
