// ==UserScript==
// @name         DeepSeek OpenAI Bridge
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Bridge for DeepSeek Studio - streaming + deep think toggle
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
  let flushInterval = null;
  let isSending = false;
  let watchdog = null;

  // ============ WATCHDOG ============
  function startWatchdog() {
    stopWatchdog();
    watchdog = setInterval(() => {
      if (isProcessingStream) return;
      fetch(`${SERVER_URL}/deepseek-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "error", content: "Watchdog timeout" })
      }).catch(() => {});
      stopWatchdog();
    }, 25000);
  }

  function stopWatchdog() {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
  }

  // ============ ENVOI DU PROMPT ============
  function typeAndSend(text) {
    if (isSending) return;
    isSending = true;
    
    const textarea = document.querySelector('textarea');
    if (!textarea) {
      console.error("❌ Textarea not found!");
      isSending = false;
      return;
    }
    
    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    
    setTimeout(() => {
      // Cherche le bouton d'envoi (cercle avec flèche)
      const sendBtn = document.querySelector('.ds-button--primary.ds-button--filled.ds-button--circle') ||
                      document.querySelector('[class*="bf38813a"]') ||
                      document.querySelector('.ds-button--circle');
      
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        console.log("🚀 Sent via button click");
      } else {
        // Fallback: Enter
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
        }));
        console.log("🚀 Sent via Enter key");
      }
      
      setTimeout(() => { isSending = false; }, 1500);
    }, 100);
  }

  // ============ TOGGLE PENSÉE PROFONDE ============
  async function toggleDeepThink(enabled) {
    const toggle = document.querySelector('.f79352dc.ds-toggle-button');
    if (!toggle) {
      console.error("❌ Deep think toggle not found!");
      return;
    }
    
    const isCurrentlyEnabled = toggle.classList.contains('ds-toggle-button--checked') ||
                               toggle.getAttribute('aria-checked') === 'true';
    
    if (enabled === isCurrentlyEnabled) {
      console.log(`✅ Deep think already ${enabled ? 'ON' : 'OFF'}`);
      return;
    }
    
    toggle.click();
    console.log(`🧠 Deep think toggled ${enabled ? 'ON' : 'OFF'}`);
    await new Promise(r => setTimeout(r, 500));
  }

  // ============ POLLING DES COMMANDES ============
  setInterval(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/pending-command`);
      const data = await res.json();

      if (data.action === "send_prompt") {
        startWatchdog();
        // Active/désactive la pensée profonde selon le mode
        if (data.reasoning_mode === "Think") {
          await toggleDeepThink(true);
        } else if (data.reasoning_mode === "Fast") {
          await toggleDeepThink(false);
        }
        typeAndSend(data.prompt);
      } else if (data.action === "switch_reasoning_mode") {
        await toggleDeepThink(data.mode === "Think");
      }
    } catch (e) {}
  }, 1000);

  // ============ FLUSH DU BUFFER ============
  function startFlushing() {
    if (flushInterval) return;
    flushInterval = setInterval(() => {
      if (contentBuffer.length > 0) {
        const pc = contentBuffer;
        contentBuffer = "";
        fetch(`${SERVER_URL}/deepseek-stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "stream", content: pc, reasoning: "" })
        }).catch(() => {});
      }
    }, 100);
  }

  function stopFlushing() {
    if (flushInterval) { clearInterval(flushInterval); flushInterval = null; }
    if (contentBuffer.length > 0) {
      fetch(`${SERVER_URL}/deepseek-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stream", content: contentBuffer, reasoning: "" })
      }).catch(() => {});
      contentBuffer = "";
    }
    fetch(`${SERVER_URL}/deepseek-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "done" })
    }).catch(() => {});
  }

  // ============ INTERCEPTION XHR ============
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._url = url;
    this._method = method;
    return originalXHROpen.call(this, method, url, ...args);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._url && this._url.includes('/chat')) {
      const myGenId = ++currentGenerationId;
      console.log(`🆕 [XHR] Stream intercepted, genId=${myGenId}`);

      // Envoie un signal de début
      fetch(`${SERVER_URL}/deepseek-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stream", content: "", reasoning: "" })
      }).catch(() => {});

      isProcessingStream = true;
      contentBuffer = "";
      startFlushing();

      let buffer = "";

      this.addEventListener('readystatechange', () => {
        if (myGenId !== currentGenerationId) return;

        if (this.readyState === 3 || this.readyState === 4) {
          const newData = this.responseText.slice(buffer.length);
          buffer = this.responseText;

          // Parse les lignes SSE
          const lines = newData.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.substring(6).trim();

            try {
              const parsed = JSON.parse(jsonStr);

              // Format: {"v":" texte"} pour les tokens
              if (parsed.v && typeof parsed.v === 'string') {
                contentBuffer += parsed.v;
              }
              // Format: {"v":{"response":{...}}} pour les réponses structurées
              if (parsed.v && parsed.v.response && parsed.v.response.fragments) {
                for (const fragment of parsed.v.response.fragments) {
                  if (fragment.type === 'RESPONSE' && fragment.content) {
                    // Le contenu complet est dans fragment.content
                    // On ne l'ajoute pas car on reçoit déjà les tokens un par un
                  }
                }
              }
            } catch (e) {}
          }
        }

        if (this.readyState === 4) {
          // Stream terminé
          if (myGenId === currentGenerationId) {
            isProcessingStream = false;
            stopFlushing();
          }
        }
      });

      // Progress event pour le streaming
      this.addEventListener('progress', () => {
        if (myGenId !== currentGenerationId) return;
        // Déjà géré par readystatechange
      });
    }

    return originalXHRSend.call(this, body);
  };

  console.log("✅ DeepSeek Bridge v1.0 ready.");
})();
