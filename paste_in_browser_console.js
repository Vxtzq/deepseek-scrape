// ==UserScript==
// @name         DeepSeek OpenAI Bridge v3.13.8 – Anti-Débordement + Wait for Dot (FIX)
// @namespace    http://tampermonkey.net/
// @version      3.13.8
// @description  FIX: Attend explicitement le prochain '.' après </think> avant de basculer en TEXT
// @match        https://chat.deepseek.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
  console.log("🌌🧠 [Tampermonkey] DeepSeek Bridge v3.13.8 ACTIVE - Wait for Dot FIX");
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

  setInterval(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/pending-command`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.action === "send_prompt") {
        startWatchdog();
        typeAndSend(data.prompt);
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
      console.log(`🆕 [XHR] Stream intercepté, genId=${myGenId}`);
      activeXHR = this;
      
      let lineBuffer = "";
      let totalResponseTextLength = 0;
      let fragments = [];
      
      let lastSentContent = "";
      let lastSentReasoning = "";
      let reasoningTail = ""; 
      let inThinking = false;

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

            // 1. Synchronisation de la structure des fragments
            const targetResponse = (val && val.response) ? val.response : (obj.response || null);
            if (targetResponse && targetResponse.fragments) {
              const incomingFrags = Array.isArray(targetResponse.fragments) ? targetResponse.fragments : [targetResponse.fragments];
              
              while (fragments.length < incomingFrags.length) {
                fragments.push({ type: inThinking ? "REASONING" : "TEXT", content: "" });
              }
              for (let i = 0; i < incomingFrags.length; i++) {
                if (incomingFrags[i].type) {
                  const currentFragType = fragments[i].type;
                  const isThinkingFrag = (currentFragType === "THINK" || currentFragType === "REASONING");
                  const wantsToBeText = (incomingFrags[i].type === "TEXT");
                  
                  // 🛡️ PROTECTION : On refuse le passage en TEXT si on est en attente de point ou en thinking
                  if ((inThinking || fragments[i]._waitingForPeriod) && wantsToBeText) {
                    const hasCloseTag = fragments[i].content.includes('</think>') || fragments[i].content.includes('<tool_call>');
                    if (!hasCloseTag && !fragments[i]._waitingForPeriod) {
                      if (incomingFrags[i].content) fragments[i].content += incomingFrags[i].content;
                      continue;
                    }
                  }
                  
                  fragments[i].type = incomingFrags[i].type;
                  if (fragments[i].type === 'THINK' || fragments[i].type === 'REASONING') inThinking = true;
                  
                  if (i === 0 && fragments[0].content === "" && incomingFrags[i].content) {
                    fragments[0].content = incomingFrags[i].content;
                  }
                }
              }
            }

            // 2. Capture des tokens de texte
            if (typeof val === 'string') {
              if (fragments.length === 0) {
                fragments.push({ type: inThinking ? "REASONING" : "TEXT", content: "" });
              }
              
              const activeFrag = fragments[fragments.length - 1];
              if (activeFrag.type === "THINK" || activeFrag.type === "REASONING") inThinking = true;

              if (inThinking) {
                const checkStr = reasoningTail + val;
                
                // 🛡️ NOUVEAU : Si on attend le point, on continue d'accumuler dans le raisonnement
                if (activeFrag._waitingForPeriod) {
                  if (val.includes('.')) {
                    const dotIdx = val.indexOf('.');
                    const extraReason = val.substring(0, dotIdx + 1); // On inclut le point dans le raisonnement
                    const realText = val.substring(dotIdx + 1);
                    
                    activeFrag.content += extraReason;
                    activeFrag._waitingForPeriod = false;
                    inThinking = false;
                    fragments.push({ type: "TEXT", content: realText });
                    reasoningTail = "";
                  } else {
                    activeFrag.content += val;
                    reasoningTail = (reasoningTail + val).slice(-20);
                  }
                } 
                // Détection de la fin du think
                else if (checkStr.includes('</think>') || checkStr.includes('<tool_call>')) {
                  const marker1 = checkStr.indexOf('</think>');
                  const marker2 = checkStr.indexOf('<tool_call>');
                  let splitIdx = -1;
                  
                  if (marker1 !== -1 && marker2 !== -1) splitIdx = Math.min(marker1, marker2);
                  else if (marker1 !== -1) splitIdx = marker1;
                  else splitIdx = marker2;

                  const reasonPart = checkStr.substring(0, splitIdx);
                  let textPart = checkStr.substring(splitIdx);

                  activeFrag.content += reasonPart;
                  
                  // 🛡️ Vérifie si le point est déjà dans ce même chunk
                  const dotIdx = textPart.indexOf('.');
                  if (dotIdx !== -1) {
                    const extraReason = textPart.substring(0, dotIdx + 1);
                    const realText = textPart.substring(dotIdx + 1);
                    
                    activeFrag.content += extraReason;
                    inThinking = false;
                    fragments.push({ type: "TEXT", content: realText });
                    reasoningTail = "";
                  } else {
                    // Pas de point encore, on active le mode d'attente
                    activeFrag.content += textPart;
                    activeFrag._waitingForPeriod = true;
                    reasoningTail = (reasoningTail + textPart).slice(-20);
                  }
                } else {
                  // Accumulation normale du thinking
                  activeFrag.content += val;
                  reasoningTail = (reasoningTail + val).slice(-20);
                }
              } else if (activeFrag._waitingForPeriod) {
                // Nous sommes en mode "attente de point" (le type du fragment est peut-être déjà TEXT à cause de l'API, mais on force)
                const dotIdx = val.indexOf('.');
                if (dotIdx !== -1) {
                  const extraReason = val.substring(0, dotIdx + 1);
                  const realText = val.substring(dotIdx + 1);
                  
                  activeFrag.content += extraReason;
                  activeFrag._waitingForPeriod = false;
                  inThinking = false;
                  fragments.push({ type: "TEXT", content: realText });
                } else {
                  // Toujours pas de point, on continue d'accumuler dans le raisonnement
                  activeFrag.content += val;
                }
              } else {
                // Accumulation normale du texte final
                activeFrag.content += val;
              }
            }
            // 3. Capture si val est un objet fragment
            else if (val && typeof val === 'object' && !Array.isArray(val)) {
              if (val.type && typeof val.content === 'string') {
                if ((inThinking || (fragments.length > 0 && fragments[fragments.length-1]._waitingForPeriod)) && val.type === 'TEXT') {
                   const contentToProcess = val.content;
                   const dotIdx = contentToProcess.indexOf('.');
                   if (dotIdx !== -1) {
                     const extraReason = contentToProcess.substring(0, dotIdx + 1);
                     const realText = contentToProcess.substring(dotIdx + 1);
                     
                     if (fragments.length > 0) {
                       fragments[fragments.length - 1].content += extraReason;
                       fragments[fragments.length - 1]._waitingForPeriod = false;
                     }
                     inThinking = false;
                     fragments.push({ type: "TEXT", content: realText });
                   } else {
                     if (fragments.length > 0) {
                       fragments[fragments.length - 1].content += contentToProcess;
                       // On garde _waitingForPeriod = true
                     }
                   }
                } else {
                  fragments.push({ type: val.type, content: val.content });
                  if (val.type === 'THINK' || val.type === 'REASONING') {
                    inThinking = true;
                    if (fragments.length > 1) fragments[fragments.length - 2]._waitingForPeriod = false;
                  }
                }
              } else if (val.content && typeof val.content === 'string') {
                if (fragments.length === 0) fragments.push({ type: inThinking ? "REASONING" : "TEXT", content: "" });
                fragments[fragments.length - 1].content += val.content;
              }
            }
            // 4. Capture si val est un tableau de fragments (BATCH)
            else if (Array.isArray(val)) {
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
            // JSON partiel, on attend la suite
          }
        }
      };

      const sendDeltasToServer = () => {
        let currentReasoning = "";
        let currentContent = "";
        for (const frag of fragments) {
          if (frag.type === "THINK" || frag.type === "REASONING") {
            currentReasoning += frag.content;
          } else {
            currentContent += frag.content;
          }
        }

        const deltaContent = currentContent.slice(lastSentContent.length);
        const deltaReasoning = currentReasoning.slice(lastSentReasoning.length);

        if (deltaContent || deltaReasoning) {
          fetch(`${SERVER_URL}/deepseek-stream`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "stream", content: deltaContent, reasoning: deltaReasoning })
          }).catch(() => {});
          
          lastSentContent = currentContent;
          lastSentReasoning = currentReasoning;
        }
      };

      this.addEventListener('readystatechange', () => {
        if (myGenId !== currentGenerationId) return;
        
        if (this.readyState === 3 || this.readyState === 4) {
          const currentText = this.responseText;
          const newData = currentText.slice(totalResponseTextLength - lineBuffer.length);
          
          if (newData.length > 0) {
            processData(newData);
            totalResponseTextLength = currentText.length;
            sendDeltasToServer();
          }

          if (this.readyState === 4) {
            console.log(`✅ [XHR] Stream terminé, genId=${myGenId}`);
            
            // 🛡️ TRAITEMENT FINAL : Récupère les tokens même si le JSON est coupé sans saut de ligne
            if (lineBuffer.length > 0) {
              if (lineBuffer.startsWith('data: ')) {
                try {
                  const obj = JSON.parse(lineBuffer.substring(6).trim());
                  processData(`data: ${JSON.stringify(obj)}\n`);
                } catch (e) {
                  const rawTextMatch = lineBuffer.match(/"(?:content|v|text)"\s*:\s*"([^"]*)"/);
                  if (rawTextMatch) {
                    if (fragments.length === 0) fragments.push({ type: inThinking ? "REASONING" : "TEXT", content: "" });
                    fragments[fragments.length - 1].content += rawTextMatch[1];
                  }
                }
              } else {
                const rawTextMatch = lineBuffer.match(/"(?:content|v|text)"\s*:\s*"([^"]*)"/);
                if (rawTextMatch) {
                  if (fragments.length === 0) fragments.push({ type: inThinking ? "REASONING" : "TEXT", content: "" });
                  fragments[fragments.length - 1].content += rawTextMatch[1];
                }
              }
            }

            // 🛡️ FORCE LA CLÔTURE : Si on attendait encore un point à la toute fin du flux, on coupe proprement
            if (fragments.length > 0 && fragments[fragments.length - 1]._waitingForPeriod) {
              fragments[fragments.length - 1]._waitingForPeriod = false;
              inThinking = false;
              fragments.push({ type: "TEXT", content: "" });
            }

            sendDeltasToServer(); // Garantit l'envoi du dernier fragment

            setTimeout(() => {
              fetch(`${SERVER_URL}/deepseek-stream`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ type: "done" })
              }).catch(() => {});
              activeXHR = null;
              stopWatchdog();
              isSending = false;
              console.log("🔓 [Bridge] Prêt pour la prochaine commande.");
            }, 200);
          }
        }
      });

      this.addEventListener('error', () => {
        if (myGenId !== currentGenerationId) return;
        fetch(`${SERVER_URL}/deepseek-stream`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "error", content: "XHR error" })
        }).catch(() => {});
        activeXHR = null;
        isSending = false;
      });
    }
    return origSend.call(this, body);
  };

  console.log("✅ DeepSeek Bridge v3.13.8 prêt. Logique 'Wait for Dot' active et robuste.");
})();
