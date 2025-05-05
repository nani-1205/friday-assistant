// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    console.log("[DEBUG] DOMContentLoaded: Finding elements...");
    // UI Elements
    const statusTextElement = document.getElementById('status-text');
    const statusDotElement = document.querySelector('.status-dot');
    const arcReactor = document.getElementById('arc-reactor');
    const menuItems = document.querySelectorAll('.menu-item');
    const views = document.querySelectorAll('.dashboard, .view-container'); // All main views
    const dashboardView = document.getElementById('dashboard-view'); // Specific dashboard view

    // Chat View Elements
    const chatMessagesContainer = document.getElementById('chat-message-list'); // Where messages go
    const chatUserInput = document.getElementById('user-input'); // Input in chat view
    const chatSendButton = document.getElementById('send-button');   // Send button in chat view
    const chatListenButton = document.getElementById('listen-button'); // Listen button in chat view

    // Verify core elements needed for chat functionality
    if (!chatMessagesContainer) console.error("[CRITICAL] Chat message list area not found!");
    if (!chatUserInput) console.error("[CRITICAL] Chat user input not found!");
    if (!chatSendButton) console.error("[CRITICAL] Chat send button not found!");
    // Listen button is optional depending on speech support

    // --- State Variables ---
    let recognition = null; let isListening = false; let synth = window.speechSynthesis;
    let assistantSpeaking = false; let availableVoices = []; let selectedVoice = null; let mapInstance = null;

    // --- Feature Detection ---
    console.log("[DEBUG] Checking features...");
    const isSecureContext = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecognition = !!SpeechRecognition; const supportsSynthesis = !!synth;
    const supportsChartJS = typeof Chart !== 'undefined'; const supportsOpenLayers = typeof ol !== 'undefined';
    console.log(`[DEBUG] Features: SecureCtx=${isSecureContext}, Reco=${supportsRecognition}, Synth=${supportsSynthesis}, ChartJS=${supportsChartJS}, OL=${supportsOpenLayers}`);

    // --- Function to Load and Select Voices ---
    function loadAndSelectVoice() {
        if (!supportsSynthesis) { console.warn("Speech Synthesis not supported."); return; }
        try {
            setTimeout(() => { // Delay helps ensure voices are ready
                availableVoices = synth.getVoices();
                if (!availableVoices || availableVoices.length === 0) { console.warn("Voice list still empty after delay."); return; }
                console.log("[DEBUG] Available Voices:", availableVoices.map(v => ({ name: v.name, lang: v.lang, default: v.default, local: v.localService })));
                const targetLang = 'en-US'; const preferredNames = ['google us english', 'microsoft zira', 'samantha', 'female'];
                selectedVoice = availableVoices.find(v => v.lang === targetLang && preferredNames.some(n => v.name.toLowerCase().includes(n)) && !v.name.toLowerCase().includes('male'));
                if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && v.name.toLowerCase().includes('female') && !v.name.toLowerCase().includes('male'));
                if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && !v.localService);
                if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang);
                if (!selectedVoice) selectedVoice = availableVoices.find(v => v.default && v.lang.startsWith('en'));
                if (!selectedVoice && availableVoices.length > 0) selectedVoice = availableVoices[0];
                if (selectedVoice) console.log(`[DEBUG] Selected Voice: ${selectedVoice.name}`); else console.warn("[DEBUG] Suitable voice not found.");
            }, 150);
        } catch (error) { console.error("[DEBUG] Error getting voices:", error); }
    }

    // --- Initial Checks & Setup ---
    console.log("[DEBUG] Initial checks...");
    if (!isSecureContext && supportsRecognition) createNotification("Security Warning", "Mic may not work over HTTP.", "error");
    if (!supportsRecognition) { if(chatListenButton){ chatListenButton.disabled = true; chatListenButton.title = 'Mic not supported';} updateStatus('Mic Offline', true); }
    if (!supportsSynthesis) console.warn('Speech Synthesis not supported.');
    else { if (speechSynthesis.onvoiceschanged !== undefined) { speechSynthesis.onvoiceschanged = loadAndSelectVoice; } else { setTimeout(loadAndSelectVoice, 750); } loadAndSelectVoice(); }
    if (!supportsChartJS) console.warn('Chart.js not loaded.');
    if (!supportsOpenLayers) console.warn('OpenLayers (ol) not loaded.');

    // --- Initialize Speech Recognition ---
    console.log("[DEBUG] Initializing Speech Recognition...");
    if (supportsRecognition) {
        try {
            recognition = new SpeechRecognition(); Object.assign(recognition, { continuous: false, lang: 'en-US', interimResults: false, maxAlternatives: 1 });
            recognition.onstart = () => { console.log("[DEBUG] Reco started."); isListening = true; if(chatListenButton) chatListenButton.classList.add('listening'); updateStatus('Listening...'); };
            recognition.onresult = (event) => { const transcript = event.results[event.results.length - 1][0].transcript.trim(); console.log('[DEBUG] Transcript:', transcript); if (transcript) { if(chatUserInput) chatUserInput.value = transcript; sendMessage(); } };
            recognition.onerror = (event) => { console.error('[DEBUG] Mic Error:', event.error, event.message); let msg=`Mic error: ${event.error}`; if(event.error==='no-speech')msg='No speech detected.'; else if(event.error==='not-allowed'){msg='Mic access denied.'; if(!isSecureContext)msg+=' Needs HTTPS.';} else msg=`Mic error: ${event.message||event.error}`; createNotification("Mic Error", msg, "error"); updateStatus('Mic Error', true); };
            recognition.onend = () => { console.log("[DEBUG] Reco ended."); isListening = false; if(chatListenButton) chatListenButton.classList.remove('listening'); if (!assistantSpeaking && !statusTextElement?.dataset.error) updateStatus('SYSTEMS ONLINE'); };
            console.log("[DEBUG] Speech Reco initialized.");
        } catch (error) { console.error("[DEBUG] Failed to initialize Speech Reco:", error); if(chatListenButton){chatListenButton.disabled=true; chatListenButton.title='Mic init failed';} updateStatus('Mic Init Error', true); }
    }

     // --- Notification Function ---
     function createNotification(title, message, type = 'info') {
        const existing = document.querySelector('.notification'); if (existing) existing.remove();
        const notification = document.createElement('div'); notification.className = `notification ${type}`;
        notification.innerHTML = `<div class="notification-title">${title.replace(/</g,"<")}</div><div>${message.replace(/</g,"<")}</div>`;
        document.body.appendChild(notification); requestAnimationFrame(() => notification.classList.add('visible'));
        setTimeout(() => { notification.classList.remove('visible'); notification.addEventListener('transitionend', () => notification.remove(), { once: true }); }, 5000);
    }

    // --- Event Listeners ---
    console.log("[DEBUG] Attaching event listeners...");
    // Chat Input/Send
    if(chatSendButton) { chatSendButton.addEventListener('click', () => { console.log("[DEBUG] Chat Send button clicked!"); sendMessage(); }); console.log("[DEBUG] Chat Send listener attached."); } else { console.error("[DEBUG] Chat Send button NOT found!"); }
    if(chatUserInput) { chatUserInput.addEventListener('keypress', (event) => { if (event.key === 'Enter' && !event.shiftKey) { console.log("[DEBUG] Enter in Chat input!"); event.preventDefault(); sendMessage(); } }); console.log("[DEBUG] Chat Input listener attached."); } else { console.error("[DEBUG] Chat Input element NOT found!"); }
    // Chat Listen Button
    if(chatListenButton) { chatListenButton.addEventListener('click', () => { console.log("[DEBUG] Chat Listen button clicked!"); if (!supportsRecognition || !recognition) { createNotification("Mic Error", "Mic not supported/initialized.", "error"); return; } if (isListening) { console.log("[DEBUG] Stop reco..."); try { recognition.stop(); } catch (e) { console.error("[DEBUG] Err stop reco:", e); isListening=false; chatListenButton.classList.remove('listening'); /*...*/ } } else { console.log("[DEBUG] Start reco..."); if (!navigator.mediaDevices?.getUserMedia) { createNotification("Mic Error", "Mic access unavailable (needs HTTPS?).", "error"); updateStatus('Mic Access Error', true); return; } navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { console.log("[DEBUG] Mic access granted."); try { if(synth?.speaking) synth.cancel(); recognition.start(); } catch (e) { console.error("[DEBUG] Err start reco:", e); createNotification("Mic Error", `Mic start error: ${e.message}`, "error"); updateStatus('Mic Start Error', true); isListening = false; } }).catch(err => { console.error("[DEBUG] Mic access err:", err.name, err.message); let msg='Mic access denied.'; if(err.name==='NotFoundError')msg='No mic found.'; else msg=`Mic access error: ${err.message}`; if (!isSecureContext && err.name==='NotAllowedError') msg+=' Needs HTTPS.'; createNotification("Mic Error", msg, "error"); updateStatus('Mic Access Denied', true); }); } }); console.log("[DEBUG] Chat Listen listener attached."); } else { console.error("[DEBUG] Chat Listen button NOT found!"); }

    // --- Static UI Listeners ---
    console.log("[DEBUG] Attaching static UI listeners...");
    const progressBars = document.querySelectorAll('.progress-value'); progressBars.forEach(bar => { const w = bar.style.width; bar.style.width='0%'; setTimeout(() => { bar.style.width=w; }, 500); });
    // Sidebar View Switching
    menuItems.forEach(item => {
        item.addEventListener('click', function() {
            if (this.classList.contains('active')) return;
            menuItems.forEach(mi => mi.classList.remove('active'));
            this.classList.add('active');
            const targetViewId = this.getAttribute('data-view');
            const menuText = this.querySelector('.menu-text')?.textContent || 'Section';
            createNotification('Navigation', 'Accessing: ' + menuText);
            views.forEach(view => view.style.display = 'none'); // Hide all
            const targetView = document.getElementById(targetViewId);
            if (targetView) {
                 // Use correct display type based on container type
                 targetView.style.display = targetView.classList.contains('chat-container') ? 'flex' : 'block';
                 targetView.classList.add('active-view'); // Maybe use class for fade-in
                 // If switching to chat, focus input
                 if (targetViewId === 'chat-view' && chatUserInput) {
                      chatUserInput.focus();
                 }
            } else { console.error("Target view not found:", targetViewId); document.getElementById('dashboard-view')?.style.display = 'block'; } // Fallback to dashboard
        });
    });
    const arcReactor = document.getElementById('arc-reactor'); if(arcReactor) { arcReactor.addEventListener('click', function() { createNotification('Arc Reactor Status', 'Power levels nominal. Diagnostics running...'); }); console.log("[DEBUG] Arc Reactor listener attached."); } else console.warn("[DEBUG] Arc Reactor element missing.");


    // --- Core Functions ---

    /** Clears the chat message list */
    function clearChatMessages() {
        console.log("[DEBUG] Clearing chat messages...");
        if (chatMessagesContainer) {
            chatMessagesContainer.innerHTML = '';
            if (mapInstance) { try { mapInstance.setTarget(null); } catch(e) {} mapInstance = null; console.log("[DEBUG] Cleared map instance ref."); }
        } else { console.error("[DEBUG] Chat message list area not found!"); }
    }

    /** Adds a message OR visualization to the chat */
    function addOutputToChat(elementType, options = {}) {
        if (!chatMessagesContainer) { console.error("Cannot add output, chat message container not found."); return null; }

        let outputElement = null;

        if (elementType === 'message') {
            const { sender, text } = options;
            if (!text) return null; // Don't add empty messages
            outputElement = document.createElement('div');
            outputElement.classList.add('message', sender.toLowerCase());
            const sanitizedText = text.replace(/</g, "<").replace(/>/g, ">");
            // Add timestamp (simple example)
            const now = new Date();
            const timeString = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            outputElement.innerHTML = `<span>${sanitizedText}</span><div class="message-timestamp">${timeString}</div>`;
        }
        else if (elementType === 'chart' && supportsChartJS) {
            outputElement = document.createElement('div');
            outputElement.classList.add('chart-container'); // Use the specific class
             // Create a canvas *inside* this element
            const canvasId = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const canvas = document.createElement('canvas');
            canvas.id = canvasId;
            outputElement.appendChild(canvas);
             console.log("[DEBUG] Chart container created for chat.");
             // Chart initialization happens separately after appending
        }
         else if (elementType === 'map' && supportsOpenLayers) {
             outputElement = document.createElement('div');
             outputElement.classList.add('map-container'); // Use the specific class
             // Map initialization happens separately after appending
              console.log("[DEBUG] Map container created for chat.");
         }
         // Add other types like 'image' if needed

        if (outputElement) {
            chatMessagesContainer.appendChild(outputElement);
            scrollToChatBottom();
        }
        return outputElement; // Return the created element (or null)
    }

    /** Creates a Chart.js chart IN A GIVEN CONTAINER */
    function createDataVisualization(vizData, chartContainerElement) {
        if (!supportsChartJS || !vizData || !chartContainerElement) { console.error("[DEBUG] Chart.js unavailable or missing data/container."); return; }
        if (vizData.type !== 'bar') { console.warn("[DEBUG] Unhandled viz type:", vizData.type); return; }
        const canvas = chartContainerElement.querySelector('canvas'); // Find canvas inside
        if (!canvas) { console.error("[DEBUG] Canvas element not found within chart container."); return; }
        try {
            const ctx = canvas.getContext('2d'); if (!ctx) throw new Error("No 2D context");
            new Chart(ctx, { type: 'bar', data: { labels: vizData.labels, datasets: vizData.datasets }, options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: vizData.chart_title || 'Summary', color: '#e0e0e0', font: { size: 14, family:'Roboto' } }, tooltip: { backgroundColor: '#000' } }, scales: { y: { ticks: { color: '#e0e0e0', font: {size: 11}}, grid: { display: false } }, x: { beginAtZero: true, ticks: { color: '#e0e0e0' }, grid: { color: 'rgba(255, 87, 34, 0.15)' } } } } }); // Updated colors
            console.log("[DEBUG] Chart initialized in container:", chartContainerElement);
        } catch (error) { console.error("[DEBUG] Error creating chart:", error); chartContainerElement.innerHTML = "<span>[Chart Display Error]</span>"; }
    }

    /** Creates an OpenLayers map IN A GIVEN CONTAINER */
    function createMapVisualization(mapVizData, mapContainerElement) {
         if (!supportsOpenLayers || !mapVizData || !mapContainerElement) { console.error("[DEBUG] OL lib unavailable or missing data/container."); return; }
         const isRouteMap = mapVizData.type === 'route' && mapVizData.origin?.coords?.length === 2 && mapVizData.destination?.coords?.length === 2;
         const isPointMap = mapVizData.type === 'point' && mapVizData.latitude != null && mapVizData.longitude != null && !isRouteMap;
         if (!isRouteMap && !isPointMap) { console.error("[DEBUG] Map data missing required coords.", mapVizData); return; }
         let mapDiv = null; console.log(`[DEBUG] Attempting to create ${isRouteMap ? 'route' : 'point'} map in container:`, mapContainerElement);
         try {
             const mapId = `map-${Date.now()}-${Math.random().toString(16).slice(2)}`;
             mapContainerElement.innerHTML = ''; mapDiv = document.createElement('div'); mapDiv.id = mapId; mapDiv.classList.add('map-inner-container');
             mapContainerElement.appendChild(mapDiv);
             setTimeout(() => { // Delay map init
                 console.log(`[DEBUG] Starting OL map init in target: ${mapId}`);
                 const targetElement = document.getElementById(mapId);
                 if (!targetElement) { console.error(`[DEBUG] Map target #${mapId} not found!`); if(mapContainerElement) mapContainerElement.innerHTML = "<span>[Map Target Error]</span>"; return; }
                 try {
                     const features = []; let viewCenter, viewZoom, extentToFit;
                     const pointStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(255,87,34,.9)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const originStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(76,175,80,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const destStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(33,150,243,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const lineStyle=new ol.style.Style({stroke:new ol.style.Stroke({color:'rgba(255,87,34,.7)',width:3})});
                     if (isRouteMap) { const oC=ol.proj.fromLonLat([mapVizData.origin.coords[1],mapVizData.origin.coords[0]]); const dC=ol.proj.fromLonLat([mapVizData.destination.coords[1],mapVizData.destination.coords[0]]); const oM=new ol.Feature({geometry:new ol.geom.Point(oC),name:`O:${mapVizData.origin.name}`}); oM.setStyle(originStyle); features.push(oM); const dM=new ol.Feature({geometry:new ol.geom.Point(dC),name:`D:${mapVizData.destination.name}`}); dM.setStyle(destStyle); features.push(dM); const l=new ol.Feature({geometry:new ol.geom.LineString([oC,dC])}); l.setStyle(lineStyle); features.push(l); extentToFit=ol.extent.boundingExtent([oC,dC]); console.log("[DEBUG] Route features."); }
                     else if (isPointMap) { const cC=ol.proj.fromLonLat([mapVizData.longitude,mapVizData.latitude]); viewCenter=cC; viewZoom=mapVizData.zoom||11; const m=new ol.Feature({geometry:new ol.geom.Point(cC),name:mapVizData.marker_title||'Loc'}); m.setStyle(pointStyle); features.push(m); console.log("[DEBUG] Point feature."); }
                     const vSrc=new ol.source.Vector({features:features}); const vLayer=new ol.layer.Vector({source:vSrc});
                     console.log(`[DEBUG] Creating OL Map instance: ${mapId}`);
                     mapInstance=new ol.Map({target:mapId, layers:[new ol.layer.Tile({source:new ol.source.OSM()}), vLayer], view:new ol.View({center:viewCenter,zoom:viewZoom,maxZoom:18,minZoom:2}), controls:ol.control.defaults({attributionOptions:{collapsible:true}}).extend([new ol.control.ScaleLine()])});
                     if(extentToFit){ console.log("[DEBUG] Fitting map view..."); setTimeout(() => { try { mapInstance.getView().fit(extentToFit, {padding:[70,70,70,70], maxZoom:14, duration:500}); console.log("[DEBUG] Map fitted."); } catch(fitErr) { console.error("[DEBUG] Error fitting map:", fitErr); } }, 150); }
                     console.log("[DEBUG] OL map instance OK:", mapId);
                     // No scroll needed here, handled by chat scroll
                  } catch(mapInitError) { console.error("[DEBUG] Error initializing OL map instance:", mapInitError); if(mapContainerElement) mapContainerElement.innerHTML = "<span>[Map Init Error]</span>"; }
             }, 150);
         } catch (error) { console.error("[DEBUG] Error setting up map container:", error); if(containerElement) containerElement.innerHTML = "<span>[Map Setup Error]</span>"; }
     } // End createMapVisualization

    /** Displays loading state in UI */
    function showLoadingIndicator() {
        updateStatus('Processing...'); // Main feedback is status text
        if(chatSendButton) chatSendButton.disabled = true;
        if(chatListenButton) chatListenButton.disabled = true;
        if(chatUserInput) chatUserInput.disabled = true;
        // Maybe add a subtle indicator near input? For now, rely on status text.
    }

     /** Hides loading state */
    function hideLoadingIndicator() {
        if (!assistantSpeaking && !isListening && !statusTextElement?.dataset.error) { updateStatus('SYSTEMS ONLINE'); } // Reset status
        if(chatSendButton) chatSendButton.disabled=false;
        if(chatListenButton) chatListenButton.disabled=!supportsRecognition||assistantSpeaking;
        if(chatUserInput){chatUserInput.disabled=false; try{chatUserInput.focus();}catch(e){}}
    }

    /** Updates the status indicator text and state */
    function updateStatus(text, isError = false) {
        if(statusTextElement) { /* ... Keep existing unchanged ... */ }
    }

    /** Sends the user's question to the backend */
    async function sendMessage() {
        const question = chatUserInput?.value.trim(); // Read from chat input
        if (!question || (chatSendButton && chatSendButton.disabled)) return;

        addOutputToChat('message', { sender: 'user', text: question }); // Add user message to chat
        if(chatUserInput) chatUserInput.value = ''; // Clear chat input
        showLoadingIndicator(); // Update status, disable inputs

        console.log(`[DEBUG] sendMessage initiated for question: "${question}"`);
        try {
            const response = await fetch('/ask', { method: 'POST', headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}, body: JSON.stringify({ question: question }) });
            console.log(`[DEBUG] Fetch response status: ${response.status}`);
            let data = null; try { data = await response.json(); console.log("[DEBUG] Received data:", data); } catch (jsonError){ console.error("[DEBUG] JSON Parse Error:", jsonError); data = { error: `Invalid response (Status: ${response.status})` };}

            if (!response.ok || (data && data.error)) {
                const errorMsg = `Error: ${data.error || response.statusText || 'Unknown'}`;
                console.error('[DEBUG] Server/App Error:', response.status, data);
                createNotification("Processing Error", errorMsg, "error"); // Use notification for errors
                addOutputToChat('message', { sender: 'friday', text: `Sorry, encountered an error.` }); // Simple error message in chat
            } else if (data && data.response) {
                console.log("[DEBUG] Received valid response. Adding to chat...");
                // 1. Add Text Response
                const textElement = addOutputToChat('message', { sender: 'friday', text: data.response });
                // 2. Add Chart (if data exists) - Appends *after* text
                if (data.visualization_data && supportsChartJS) {
                    const chartContainer = addOutputToChat('chart'); // Add container
                    if (chartContainer) createDataVisualization(data.visualization_data, chartContainer); // Init chart
                }
                 // 3. Add Map (if data exists) - Appends *after* text/chart
                if (data.map_data && supportsOpenLayers) {
                    const mapContainer = addOutputToChat('map'); // Add container
                    if (mapContainer) createMapVisualization(data.map_data, mapContainer); // Init map
                }
                // 4. Speak (after content added)
                speakResponse(data.response);
            } else {
                 console.error('[DEBUG] Invalid success structure:', data);
                 createNotification("Response Error", "Received unexpected data structure.", "error");
                 addOutputToChat('message', { sender: 'friday', text: 'Sorry, unexpected response structure.' });
            }
        } catch (error) {
             console.error('[DEBUG] Network/Fetch Error:', error);
             const errorMsg = 'Network error reaching assistant server.';
             createNotification("Connection Error", errorMsg, "error");
             addOutputToChat('message', { sender: 'friday', text: 'Sorry, trouble connecting.' });
        } finally {
             console.log("[DEBUG] sendMessage finally.");
             if (!assistantSpeaking && !(supportsSynthesis && synth?.pending)) {
                  console.log("[DEBUG] Hiding loading indicator from finally.");
                  hideLoadingIndicator();
             } else { console.log("[DEBUG] Skipping hideLoadingIndicator (speech active/pending)."); }
        }
    } // End sendMessage

    /** Uses Speech Synthesis */
    function speakResponse(textToSpeak) {
         if (!supportsSynthesis || !synth || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') { console.log("[DEBUG] Speech skipped."); if(assistantSpeaking){ assistantSpeaking=false; /*...*/ } return; }
         if (synth.speaking || synth.pending) { console.log("[DEBUG] Cancelling previous speech."); synth.cancel(); if(assistantSpeaking){ assistantSpeaking=false; /*...*/ } }
         const utterance = new SpeechSynthesisUtterance(textToSpeak);
         if (selectedVoice) { utterance.voice = selectedVoice; utterance.lang = selectedVoice.lang; console.log(`[DEBUG] Using voice: ${selectedVoice.name} (${utterance.lang})`); }
         else { utterance.lang = 'en-US'; console.log(`[DEBUG] Using default voice (Lang: ${utterance.lang}).`); }
         utterance.pitch = 1; utterance.rate = 1;
         utterance.onstart = () => { console.log("[DEBUG] Speech started."); assistantSpeaking = true; updateStatus('Speaking...'); /* No pulse ring */ if (chatListenButton) chatListenButton.disabled = true; };
         utterance.onend = () => { console.log("[DEBUG] Speech finished."); assistantSpeaking = false; hideLoadingIndicator(); if (!isListening && !statusTextElement?.dataset.error) { updateStatus('SYSTEMS ONLINE'); /* No pulse ring */ } if (chatListenButton) chatListenButton.disabled = !supportsRecognition; if(chatUserInput) try{chatUserInput.focus();}catch(e){} };
         utterance.onerror = (event) => { console.error('[DEBUG] Speech error:', event.error, event); assistantSpeaking = false; hideLoadingIndicator(); createNotification("Speech Error", `Playback failed: ${event.error}`, "error"); if (!isListening) { updateStatus('Speech Error', true); /* No pulse ring */ } if (chatListenButton) chatListenButton.disabled = !supportsRecognition; };
         setTimeout(() => { try { if (synth) { console.log("[DEBUG] Attempting synth.speak..."); synth.speak(utterance); console.log(`[DEBUG] synth.speak called. Status: speaking=${synth.speaking}, pending=${synth.pending}`); } else { console.error("[DEBUG] Synth unavailable."); createNotification("Speech Error", "Synthesis engine unavailable.", "error"); } } catch (speakError) { console.error("[DEBUG] Error during synth.speak:", speakError); createNotification("Speech Error", `Playback error: ${speakError.message}`, "error"); assistantSpeaking = false; hideLoadingIndicator(); } }, 100);
    }

    /** Scrolls the chat message list to the bottom */
    function scrollToChatBottom() {
        if(chatMessagesContainer) {
            chatMessagesContainer.scrollTo({ top: chatMessagesContainer.scrollHeight, behavior: 'smooth' });
        }
    }

    // --- Initial Page Load Setup ---
    // Removed visualization pulse control
    updateStatus('SYSTEMS ONLINE'); // Set initial status
    // Initial greeting added to chat when view becomes active (see sidebar listener)
    if(document.getElementById('dashboard-view')) document.getElementById('dashboard-view').style.display = 'block'; // Show dashboard initially
    if(chatUserInput) chatUserInput.focus(); // Focus input initially (might change if chat not default view)
    console.log("[DEBUG] Initial setup complete.");

}); // End DOMContentLoaded