// ==UserScript==
// @name         DeepSeek OpenAI Bridge + DeepThink
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Envoie les prompts, bascule DeepThink, intercepte les streams thinking/output
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  console.log("🌌🧠 [Tampermonkey] DeepSeek Bridge v1.0 Active");
  const SERVER_URL = "http://127.0.0.1:8000";

  let isProcessingStream = false;
  let currentGenerationId = 0;
  let contentBuffer = "";
  let reasoningBuffer = "";
  let flushInterval = null;
  let isSending = false;
  let watchdog = null;

  // 🛡️ Watchdog
  function startWatchdog() {
    stopWatchdog();
    watchdog = setInterval(() => {
      if (isProcessingStream) return;
      fetch(`${SERVER_URL}/deepseek-stream`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "error", content: "Watchdog timeout" })
      }).catch(() => {});
      stopWatchdog();
    }, 25000);
  }

  function stopWatchdog() {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
  }

  // 🔍 Trouver la zone de saisie (adaptatif)
  function findChatInput() {
    // Sélecteurs possibles (classes dynamiques, on teste plusieurs patterns)
    const selectors = [
      'div[contenteditable="true"]:not([aria-label])', // souvent utilisé
      'textarea[placeholder]',
      '.aaff8b8f', // mentionné comme possible
      '._77cefa5._3d616d3', // autre possibilité
      '#chat-input',
      '[role="textbox"]'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return el; // visible
      } catch (e) {}
    }
    // Fallback : premier contenteditable visible
    const allEditables = document.querySelectorAll('div[contenteditable="true"]');
    for (const el of allEditables) {
      if (el.offsetParent !== null) return el;
    }
    return null;
  }

  // ✍️ Envoyer un prompt
  function typeAndSend(text) {
    if (isSending) return;
    const input = findChatInput();
    if (!input) { isSending = false; console.warn("❌ Zone de saisie introuvable"); return; }

    isSending = true;
    input.focus();

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (input.isContentEditable) {
      input.textContent = ''; // clear
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      // Alternative: input.innerText = text; input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Déclencher l'envoi
    setTimeout(() => {
      // Chercher le bouton d'envoi (souvent une icône)
      const sendBtn = document.querySelector('button[aria-label="Send"], button.send-btn, button[type="submit"]') ||
        Array.from(document.querySelectorAll('button')).find(b => b.offsetParent && b.querySelector('svg'));
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
      } else {
        // Simuler Entrée
        const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
        input.dispatchEvent(event);
      }
      setTimeout(() => { isSending = false; }, 1500);
    }, 100);
  }

  // 🧠 Bascule DeepThink (bouton "Pensée profonde")
  async function switchDeepThinkMode(targetMode) {
    // targetMode = "Think" (activé) ou "Fast" (désactivé)
    const button = document.querySelector('.f79352dc.ds-toggle-button.ds-toggle-button--m');
    if (!button) {
      console.warn("❌ Bouton DeepThink introuvable");
      return;
    }

    const isActive = button.classList.contains('ds-toggle-button--active') ||
                     button.getAttribute('aria-checked') === 'true' ||
                     button.style.backgroundColor === 'rgb(59, 130, 246)' || // bleu
                     getComputedStyle(button).backgroundColor === 'rgb(59, 130, 246)';

    const shouldBeActive = (targetMode.toLowerCase() === 'think');

    if (isActive !== shouldBeActive) {
      button.click();
      console.log(`✅ DeepThink ${shouldBeActive ? 'activé' : 'désactivé'}`);
    } else {
      console.log(`✅ DeepThink déjà ${shouldBeActive ? 'activé' : 'désactivé'}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // 🔁 Boucle de commandes
  setInterval(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/pending-command`);
      const data = await res.json();

      if (data.action === "send_prompt") {
        startWatchdog();
        typeAndSend(data.prompt);
      } else if (data.action === "switch_reasoning_mode") {
        await switchDeepThinkMode(data.mode);
      }
    } catch (e) {}
  }, 1000);

  // 🔄 Fonctions de flush vers le serveur
  function startFlushing() {
    if (flushInterval) return;
    flushInterval = setInterval(() => {
      if (contentBuffer.length > 0 || reasoningBuffer.length > 0) {
        const pc = contentBuffer; contentBuffer = "";
        const pr = reasoningBuffer; reasoningBuffer = "";
        fetch(`${SERVER_URL}/deepseek-stream`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "stream", content: pc, reasoning: pr })
        }).catch(() => {});
      }
    }, 100);
  }

  function stopFlushing() {
    if (flushInterval) { clearInterval(flushInterval); flushInterval = null; }
    if (contentBuffer.length > 0 || reasoningBuffer.length > 0) {
      fetch(`${SERVER_URL}/deepseek-stream`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stream", content: contentBuffer, reasoning: reasoningBuffer })
      }).catch(() => {});
      contentBuffer = ""; reasoningBuffer = "";
    }
    fetch(`${SERVER_URL}/deepseek-stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "done" })
    }).catch(() => {});
  }

  // 🕵️‍♂️ Interception des réponses streaming
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = (typeof args[0] === 'string') ? args[0] : args[0]?.url || '';
    if (url.includes('/chat/completions') || url.includes('/api/chat') || url.includes('/v1/chat') || url.includes('/completion')) {
      const clone = response.clone();
      const myGenId = ++currentGenerationId;
      console.log(`🆕 [JS] Stream intercepté, genId=${myGenId}`);

      // Envoi d'une impulsion pour signaler le début du thinking
      fetch(`${SERVER_URL}/deepseek-stream`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stream", reasoning: "⏳", content: "" })
      }).catch(() => {});

      processAndForwardStream(clone, myGenId);
    }
    return response;
  };

  async function processAndForwardStream(response, genId) {
    if (genId !== currentGenerationId) return;
    isProcessingStream = true;
    contentBuffer = ""; reasoningBuffer = "";

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let isActive = true;
    let lockedChoiceIndex = null;

    startFlushing();

    try {
      while (isActive) {
        if (genId !== currentGenerationId) break;
        const { done, value } = await reader.read();
        if (done) { isActive = false; break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (genId !== currentGenerationId) { isActive = false; break; }
          if (!line.startsWith('data: ')) continue;

          const jsonData = line.substring(6).trim();
          if (jsonData === '[DONE]') { isActive = false; break; }

          try {
            const parsed = JSON.parse(jsonData);
            const choices = parsed.choices;
            if (!choices || choices.length === 0) continue;

            // Verrouiller sur le premier choix (ignore les réponses multiples)
            if (lockedChoiceIndex === null) {
              lockedChoiceIndex = choices[0].index ?? 0;
              console.log(`🔒 [JS] Locked onto choice index=${lockedChoiceIndex}`);
            }
            const choice = choices.find(c => (c.index ?? 0) === lockedChoiceIndex);
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            // --- Raisonnement (thinking) ---
            // DeepSeek peut utiliser delta.reasoning_content (format OpenAI)
            if (delta.reasoning_content) {
              reasoningBuffer += delta.reasoning_content;
            }

            // --- Tool calls ---
            const toolCalls = delta.tool_calls;
            if (toolCalls && Array.isArray(toolCalls)) {
              // Vider les buffers avant l'appel d'outil
              if (contentBuffer.length > 0) {
                fetch(`${SERVER_URL}/deepseek-stream`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ type: "stream", content: contentBuffer, reasoning: "" })
                }).catch(() => {});
                contentBuffer = "";
              }
              // Envoyer chaque tool call
              for (const tc of toolCalls) {
                fetch(`${SERVER_URL}/deepseek-stream`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ type: "function_call", name: tc.function?.name || "", arguments: tc.function?.arguments || "" })
                }).catch(() => {});
              }
              continue; // on passe au chunk suivant
            }

            // --- Contenu final (après thinking) ---
            if (delta.content) {
              contentBuffer += delta.content;
            }

          } catch (e) {}
        }
      }
    } catch (e) {
      console.error("💥 [JS] Stream error:", e);
    } finally {
      if (genId === currentGenerationId) { isProcessingStream = false; stopFlushing(); }
    }
  }

  console.log("✅ DeepSeek Bridge prêt. DeepThink bouton :", !!document.querySelector('.f79352dc.ds-toggle-button'));
})();
