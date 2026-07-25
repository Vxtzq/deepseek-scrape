// ==UserScript==
// @name         DeepSeek OpenAI Bridge v3.12 – Fragment Tracker (Architecture Native)
// @namespace    http://tampermonkey.net/
// @version      3.12
// @description  Reproduit la structure native de fragments de DeepSeek pour une séparation parfaite
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  console.log("🌌🧠 [Tampermonkey] DeepSeek Bridge v3.12 ACTIVE - Fragment Tracker");
  const SERVER_URL = "http://127.0.0.1:8000";

  let currentGenerationId = 0;
  let isSending = false;
  let watchdog = null;
  let activeXHR = null;

  function startWatchdog() {
    stopWatchdog();
    watchdog = setInterval(() => {
      if (activeXHR && activeXHR.readyState < 4) return;
      fetch(`${SERVER_URL}/deepseek-stream`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "error", content: "Watchdog timeout" })
      }).catch(() => {});
      stopWatchdog();
    }, 60000);
  }

  function stopWatchdog() {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
  }

  function typeAndSend(text) {
    if (isSending) return;
    isSending = true;
    
    const textarea = document.querySelector('textarea');
    if (!textarea) { isSending = false; return; }
    
    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    
    setTimeout(() => {
      const sendBtn = document.querySelector('.ds-button--primary.ds-button--circle') ||
                      document.querySelector('[class*="bf38813a"]') ||
                      document.querySelector('button[type="submit"]');
      if (sendBtn && !sendBtn.disabled) sendBtn.click();
      else textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }, 300);
  }

  async function toggleDeepThink(enabled) {
    const selectors = [
      '.f79352dc.ds-toggle-button',
      '[class*="ds-toggle-button"]',
      'button[aria-label*="deep think" i]',
      'button[aria-label*="raisonnement" i]',
      '.ds-switch'
    ];
    let toggle = null;
    for (const sel of selectors) {
      toggle = document.querySelector(sel);
      if (toggle) break;
    }
    if (!toggle) return;
    
    const isCurrentlyEnabled = toggle.classList.contains('ds-toggle-button--checked') || 
                               toggle.classList.contains('checked') ||
                               toggle.classList.contains('ds-switch--checked') ||
                               toggle.getAttribute('aria-checked') === 'true';
    
    if (enabled === isCurrentlyEnabled) return;
    toggle.click();
    await new Promise(r => setTimeout(r, 800));
  }

  setInterval(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/pending-command`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.action === "send_prompt") {
        startWatchdog();
        const mode = data.reasoning_mode || "Fast"; 
        await toggleDeepThink(mode === "Think");
        typeAndSend(data.prompt);
      } else if (data.action === "switch_reasoning_mode") {
        await toggleDeepThink(data.mode === "Think");
      }
    } catch (e) {}
  }, 1000);

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._url = url;
    this._method = method;
    return origOpen.call(this, method, url, ...args);
  };

  function isMetadata(path, val) {
    if (path.includes('status') || path.includes('elapsed') || path.includes('usage') || path.includes('quasi')) return true;
    if (val === 'FINISHED' || val === '[DONE]' || val === 'done') return true;
    return false;
  }

  XMLHttpRequest.prototype.send = function(body) {
    if (this._url === '/api/v0/chat/completion' && this._method === 'POST') {
      const myGenId = ++currentGenerationId;
      activeXHR = this;
      
      let lineBuffer = "";
      let lastProcessed = 0;
      
      // 🧠 FRAGMENT TRACKER : Reproduit la structure native de DeepSeek
      let fragments = [];

      const processData = (text) => {
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || "";
        
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.substring(6).trim();
          if (jsonStr === '[DONE]' || jsonStr.startsWith('event:')) continue;
          
          try {
            const obj = JSON.parse(jsonStr);
            const path = obj.p || "";
            const val = obj.v;

            if (isMetadata(path, val)) continue;

            // 1. Synchronisation de la structure des fragments (Initialisation ou Ajout)
            const targetResponse = (val && val.response) ? val.response : (obj.response || null);
            if (targetResponse && targetResponse.fragments) {
              const incomingFrags = Array.isArray(targetResponse.fragments) ? targetResponse.fragments : [targetResponse.fragments];
              
              while (fragments.length < incomingFrags.length) {
                fragments.push({ type: "TEXT", content: "" });
              }
              for (let i = 0; i < incomingFrags.length; i++) {
                if (incomingFrags[i].type) fragments[i].type = incomingFrags[i].type;
                if (i === 0 && fragments[0].content === "" && incomingFrags[i].content) {
                  fragments[0].content = incomingFrags[i].content;
                }
              }
            }

            // 2. Capture des tokens de texte (APPEND sur le fragment actif "-1")
            if (typeof val === 'string') {
              if (fragments.length === 0) fragments.push({ type: "TEXT", content: "" });
              fragments[fragments.length - 1].content += val;
            }

            // 3. Capture si val est un objet fragment (ex: ajout d'un nouveau fragment)
            if (val && typeof val === 'object' && !Array.isArray(val)) {
              if (val.type && typeof val.content === 'string') {
                fragments.push({ type: val.type, content: val.content });
              } else if (val.content && typeof val.content === 'string') {
                if (fragments.length === 0) fragments.push({ type: "TEXT", content: "" });
                fragments[fragments.length - 1].content += val.content;
              }
            }

            // 4. Capture si val est un tableau de fragments (BATCH)
            if (Array.isArray(val)) {
              for (const item of val) {
                if (item && typeof item === 'object' && item.type && typeof item.content === 'string') {
                  if (fragments.length > 0 && fragments[fragments.length - 1].type !== item.type) {
                    fragments.push({ type: item.type, content: item.content });
                  } else if (fragments.length === 0) {
                    fragments.push({ type: item.type, content: item.content });
                  } else {
                    fragments[fragments.length - 1].content += item.content;
                  }
                }
              }
            }

          } catch (e) {
            // Ignore les erreurs de parsing JSON partiel
          }
        }
      };

      this.addEventListener('readystatechange', () => {
        if (myGenId !== currentGenerationId) return;
        
        if (this.readyState === 3 || this.readyState === 4) {
          const currentText = this.responseText;
          const newData = currentText.slice(lastProcessed);
          
          if (newData.length > 0) {
            processData(newData);
            lastProcessed = currentText.length - lineBuffer.length;
          }

          if (this.readyState === 4) {
            if (lineBuffer.length > 0 && lineBuffer.startsWith('data: ')) {
               try {
                 const obj = JSON.parse(lineBuffer.substring(6).trim());
                 processData(`data: ${JSON.stringify(obj)}\n`);
               } catch (e) {}
            }

            // 🎯 CONSOLIDATION FINALE BASÉE SUR LES TYPES DE FRAGMENTS
            let fullReasoning = "";
            let fullContent = "";

            for (const frag of fragments) {
              if (frag.type === "THINK" || frag.type === "REASONING") {
                fullReasoning += frag.content;
              } else {
                fullContent += frag.content;
              }
            }

            console.log(`✅ [XHR] Stream terminé.`);
            console.log(`📝 RAISONNEMENT (${fullReasoning.length} car.) : "${fullReasoning.substring(0, 60)}${fullReasoning.length > 60 ? '...' : ''}"`);
            console.log(`📝 CONTENU FINAL (${fullContent.length} car.) : "${fullContent}"`);

            if (fullContent.length > 0 || fullReasoning.length > 0) {
              fetch(`${SERVER_URL}/deepseek-stream`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "stream", content: "", reasoning: "" })
              }).catch(() => {});
              
              fetch(`${SERVER_URL}/deepseek-stream`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "stream", content: fullContent, reasoning: fullReasoning })
              }).catch(() => {});
            }

            setTimeout(() => {
              fetch(`${SERVER_URL}/deepseek-stream`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "done" })
              }).catch(() => {});
              activeXHR = null;
              stopWatchdog();
              isSending = false;
            }, 200);
          }
        }
      });

      this.addEventListener('error', () => {
        if (myGenId !== currentGenerationId) return;
        activeXHR = null;
        isSending = false;
      });
    }
    return origSend.call(this, body);
  };

  console.log("✅ DeepSeek Bridge v3.12 prêt. Architecture native de fragments active.");
})();
