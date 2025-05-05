// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    console.log("[DEBUG] DOMContentLoaded fired. Finding elements...");
    const mainContentArea = document.getElementById('main-content');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const listenButton = document.getElementById('listen-button');
    const statusTextElement = document.getElementById('status-text'); // Changed ID
    const statusDotElement = document.querySelector('.status-dot');
    const visualization = document.getElementById('ai-visualization')?.querySelector('.pulse-ring');
    const errorMessageDiv = document.getElementById('error-message'); // Although we use notifications now
    console.log(`[DEBUG] Elements found: outputArea=${!!mainContentArea}, input=${!!userInput}, sendBtn=${!!sendButton}, listenBtn=${!!listenButton}, statusText=${!!statusTextElement}`);


    // --- State Variables ---
    let recognition = null;
    let isListening = false;
    let synth = window.speechSynthesis; // Ensure synth is assigned early
    let assistantSpeaking = false;
    // Remove currentAssistantMessageElement reference
    let availableVoices = [];
    let selectedVoice = null;
    let mapInstance = null; // Keep map instance reference if needed for cleanup

    // --- Feature Detection ---
    console.log("[DEBUG] Checking features...");
    const isSecureContext = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecognition = !!SpeechRecognition;
    const supportsSynthesis = !!synth; // Check based on synth object
    const supportsChartJS = typeof Chart !== 'undefined';
    const supportsOpenLayers = typeof ol !== 'undefined';
    console.log(`[DEBUG] Features: SecureCtx=${isSecureContext}, Reco=${supportsRecognition}, Synth=${supportsSynthesis}, ChartJS=${supportsChartJS}, OL=${supportsOpenLayers}`);


    // --- Function to Load and Select Voices ---
    function loadAndSelectVoice() {
        if (!supportsSynthesis) { console.warn("Speech Synthesis not supported."); return; }
        try {
            availableVoices = synth.getVoices();
            if (!availableVoices || availableVoices.length === 0) {
                 // Some browsers need the event to fire first, even if onvoiceschanged is supported
                 console.warn("Voice list empty or unavailable initially, waiting for 'voiceschanged'.");
                 return;
             }
            console.log("[DEBUG] Available Voices:", availableVoices.map(v => ({name: v.name, lang: v.lang, default: v.default, local: v.localService })));
            const targetLang = 'en-US'; const preferredNames = ['google us english', 'microsoft zira', 'samantha', 'female'];
            // Prioritize finding a suitable voice
            selectedVoice = availableVoices.find(v => v.lang === targetLang && preferredNames.some(n => v.name.toLowerCase().includes(n)) && !v.name.toLowerCase().includes('male')); // 1. Preferred Female
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && v.name.toLowerCase().includes('female') && !v.name.toLowerCase().includes('male')); // 2. Any Female
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && !v.localService); // 3. Cloud (might be male)
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang); // 4. First US
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.default && v.lang.startsWith('en')); // 5. Default (any English)
            if (!selectedVoice && availableVoices.length > 0) selectedVoice = availableVoices[0]; // 6. Absolute first
            // Log the outcome
            if (selectedVoice) console.log(`[DEBUG] Selected Voice: ${selectedVoice.name} (Lang: ${selectedVoice.lang}, Local: ${selectedVoice.localService})`);
            else console.warn("[DEBUG] Could not find a suitable voice. Using browser default.");
        } catch (error) { console.error("[DEBUG] Error getting/processing voices:", error); }
    }

    // --- Initial Checks & Setup ---
    console.log("[DEBUG] Performing initial checks...");
    if (!isSecureContext && supportsRecognition) createNotification("Security Warning", "Microphone may not work over non-secure (HTTP) connections.", "error"); // Use notification
    if (!supportsRecognition) { if(listenButton){listenButton.disabled = true; listenButton.title = 'Mic not supported';} updateStatus('Mic Offline'); }
    if (!supportsSynthesis) console.warn('Speech Synthesis not supported.');
    else {
        // Use the 'voiceschanged' event listener for reliability
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = loadAndSelectVoice;
        } else {
             // Fallback timeout might be needed for very old browsers, but 'voiceschanged' is standard
             console.warn("'onvoiceschanged' event not supported. Voice selection might be delayed or use defaults.");
             setTimeout(loadAndSelectVoice, 750); // Give a bit more time if event is missing
        }
        loadAndSelectVoice(); // Attempt initial load anyway (might be empty)
    }
    if (!supportsChartJS) console.warn('Chart.js library not loaded. Charts disabled.');
    if (!supportsOpenLayers) console.warn('OpenLayers library (ol) not loaded. Maps disabled.');

    // --- Initialize Speech Recognition ---
    console.log("[DEBUG] Initializing Speech Recognition (if supported)...");
    if (supportsRecognition) {
        try {
            recognition = new SpeechRecognition(); Object.assign(recognition, { continuous: false, lang: 'en-US', interimResults: false, maxAlternatives: 1 });
            recognition.onstart = () => { console.log("[DEBUG] Recognition started."); isListening = true; if(listenButton) listenButton.classList.add('listening'); updateStatus('Listening...'); if (visualization) visualization.style.animationPlayState = 'running'; /* No error div clear needed */ };
            recognition.onresult = (event) => { const transcript = event.results[event.results.length - 1][0].transcript.trim(); console.log('[DEBUG] Transcript:', transcript); if (transcript) { if(userInput) userInput.value = transcript; sendMessage(); } }; // Populate input field as well
            recognition.onerror = (event) => { console.error('[DEBUG] Mic Error:', event.error, event.message); let msg=`Mic error: ${event.error}`; if(event.error==='no-speech')msg='No speech detected.'; else if(event.error==='not-allowed'){msg='Mic access denied.'; if(!isSecureContext)msg+=' Needs HTTPS.';} else msg=`Mic error: ${event.message||event.error}`; createNotification("Mic Error", msg, "error"); updateStatus('Mic Error', true); };
            recognition.onend = () => { console.log("[DEBUG] Recognition ended."); isListening = false; if(listenButton) listenButton.classList.remove('listening'); if (!assistantSpeaking && !statusTextElement?.dataset.error) updateStatus('SYSTEMS ONLINE'); if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused'; };
            console.log("[DEBUG] Speech Recognition initialized.");
        } catch (error) { console.error("[DEBUG] Failed to initialize SpeechRecognition:", error); if(listenButton){listenButton.disabled=true; listenButton.title='Mic init failed';} updateStatus('Mic Init Error', true); }
    }

     // --- Notification Function (Moved from HTML) ---
     function createNotification(title, message, type = 'info') {
        const existingNotification = document.querySelector('.notification');
        if (existingNotification) existingNotification.remove();
        const notification = document.createElement('div');
        notification.className = `notification ${type}`; // Base + type class
        notification.innerHTML = `<div class="notification-title">${title}</div><div>${message}</div>`;
        document.body.appendChild(notification);
        requestAnimationFrame(() => notification.classList.add('visible')); // Trigger fade-in
        setTimeout(() => { notification.classList.remove('visible'); notification.addEventListener('transitionend', () => notification.remove(), { once: true }); }, 5000);
    }

    // --- Event Listeners ---
    console.log("[DEBUG] Attaching event listeners...");
    if(sendButton) {
        sendButton.addEventListener('click', () => { console.log("[DEBUG] Execute button clicked!"); sendMessage(); });
        console.log("[DEBUG] Execute button listener attached.");
    } else { console.error("[DEBUG] Execute button element NOT found!"); }

    if(userInput) {
        userInput.addEventListener('keypress', (event) => { if (event.key === 'Enter' && !event.shiftKey) { console.log("[DEBUG] Enter key pressed in command input!"); event.preventDefault(); sendMessage(); } });
         console.log("[DEBUG] Command input listener attached.");
    } else { console.error("[DEBUG] Command input element NOT found!"); }

    if(listenButton) {
        listenButton.addEventListener('click', () => {
            console.log("[DEBUG] Listen button clicked!");
            if (!supportsRecognition || !recognition) { createNotification("Mic Error", "Mic not supported/initialized.", "error"); return; }
            if (isListening) { console.log("[DEBUG] Attempting to stop recognition..."); try { recognition.stop(); } catch (e) { console.error("[DEBUG] Err stop recognition:", e); isListening=false; listenButton.classList.remove('listening'); /*...*/ } }
            else { console.log("[DEBUG] Attempting to start recognition..."); if (!navigator.mediaDevices?.getUserMedia) { createNotification("Mic Error", "Mic access unavailable (needs HTTPS?).", "error"); updateStatus('Mic Access Error', true); return; }
                 navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { console.log("[DEBUG] Mic access granted."); try { /* clearError() not needed */; if(synth?.speaking) synth.cancel(); recognition.start(); } catch (e) { console.error("[DEBUG] Err start recognition:", e); createNotification("Mic Error", `Mic start error: ${e.message}`, "error"); updateStatus('Mic Start Error', true); isListening = false; } })
                     .catch(err => { console.error("[DEBUG] Mic access err:", err.name, err.message); let msg='Mic access denied.'; if(err.name==='NotFoundError')msg='No mic found.'; else if (err.name==='NotReadableError')msg='Mic busy/hardware error.'; else msg=`Mic access error: ${err.message}`; if (!isSecureContext && err.name==='NotAllowedError') msg+=' Needs HTTPS.'; createNotification("Mic Error", msg, "error"); updateStatus('Mic Access Denied', true); });
            }
        });
         console.log("[DEBUG] Listen button listener attached.");
    } else { console.error("[DEBUG] Listen button element NOT found!"); }

    // --- Static UI Listeners ---
    console.log("[DEBUG] Attaching static UI listeners...");
    const progressBars = document.querySelectorAll('.progress-value'); progressBars.forEach(bar => { const w = bar.style.width; bar.style.width='0%'; setTimeout(() => { bar.style.width=w; }, 500); });
    const menuItems = document.querySelectorAll('.menu-item'); menuItems.forEach(item => { item.addEventListener('click', function() { if(this.classList.contains('active')) return; menuItems.forEach(mi => mi.classList.remove('active')); this.classList.add('active'); const txt=this.querySelector('.menu-text')?.textContent||'Section'; createNotification('Navigation', 'Accessing: '+txt); }); });
    const arcReactor = document.getElementById('arc-reactor'); if(arcReactor) { arcReactor.addEventListener('click', function() { createNotification('Arc Reactor Status', 'Power levels nominal. Diagnostics running...'); }); console.log("[DEBUG] Arc Reactor listener attached."); } else console.warn("[DEBUG] Arc Reactor element missing.");


    // --- Core Functions ---

    /** Clears the assistant output area */
    function clearAssistantOutputArea() {
        console.log("[DEBUG] Clearing assistant output area...");
        if (assistantOutputArea) {
            assistantOutputArea.innerHTML = '';
            if (mapInstance) { try { mapInstance.setTarget(null); } catch(e) { console.warn("[DEBUG] Minor error detaching map target:", e); } mapInstance = null; console.log("[DEBUG] Cleared map instance ref."); }
        } else { console.error("[DEBUG] Assistant output area not found in clearAssistantOutputArea!"); }
    }

    /** Displays content (text, chart, map) in the main area */
    function displayContent({ text = null, chartData = null, mapData = null, userQuery = null }) {
        console.log("[DEBUG] Entering displayContent function.");
        if (!assistantOutputArea) { console.error("[DEBUG] Assistant output area missing! Cannot display."); createNotification("UI Error", "Output area missing.", "error"); return; }
        clearAssistantOutputArea(); // Clear previous output

        // 1. User Query (Optional Display - Removed for this version to focus on output)
        // if (userQuery) { ... }

        let contentAdded = false; // Flag to track if anything was actually added

        // 2. Display Assistant Text Response
        if (text) {
            console.log("[DEBUG] Preparing text content wrapper...");
            const textWrapper = document.createElement('div'); textWrapper.classList.add('content-wrapper'); textWrapper.id = 'response-text-area';
            let formattedText = text.replace(/</g,"<").replace(/>/g,">").replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>').replace(/\\n/g,'<br>');
            textWrapper.innerHTML = formattedText;
            assistantOutputArea.appendChild(textWrapper); console.log("[DEBUG] Text wrapper appended.");
            speakResponse(text); // Speak the text
            contentAdded = true;
        } else { console.log("[DEBUG] No text content received to display."); }

        // 3. Display Chart
        if (chartData && supportsChartJS) {
            console.log("[DEBUG] Preparing chart wrapper...");
            const chartWrapper = document.createElement('div'); chartWrapper.classList.add('content-wrapper'); chartWrapper.id = 'chart-placeholder';
            assistantOutputArea.appendChild(chartWrapper); console.log("[DEBUG] Chart wrapper appended.");
            createDataVisualization(chartData, chartWrapper); contentAdded = true;
        } else if (chartData) console.warn("[DEBUG] Chart data received, but Chart.js unavailable.");

        // 4. Display Map
        if (mapData && supportsOpenLayers) {
             console.log("[DEBUG] Preparing map wrapper...");
             const mapWrapper = document.createElement('div'); mapWrapper.classList.add('content-wrapper'); mapWrapper.id = 'map-placeholder';
             assistantOutputArea.appendChild(mapWrapper); console.log("[DEBUG] Map wrapper appended.");
             createMapVisualization(mapData, mapWrapper); contentAdded = true;
        } else if (mapData) console.warn("[DEBUG] Map data received, but OpenLayers unavailable.");

        // Final check and scroll
        requestAnimationFrame(() => {
            if (!contentAdded) { console.warn("[DEBUG] displayContent finished, but nothing seems to have been added!"); /* Maybe add fallback text? */ }
            else { console.log("[DEBUG] displayContent finished populating output area."); }
            scrollToTopOfOutput(); // Scroll to top of output area
        });

    } // End displayContent

    /** Creates a Chart.js chart */
    function createDataVisualization(vizData, containerElement) {
        if (!supportsChartJS || !vizData || !containerElement) { console.error("[DEBUG] Chart.js unavailable or missing data/container."); return; }
        if (vizData.type !== 'bar') { console.warn("[DEBUG] Unhandled viz type:", vizData.type); return; }
        let chartCanvas = null;
        try {
            const canvasId = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            containerElement.innerHTML = ''; chartCanvas = document.createElement('canvas'); chartCanvas.id = canvasId;
            containerElement.appendChild(chartCanvas); const ctx = chartCanvas.getContext('2d');
            if (!ctx) { throw new Error("Could not get 2D context"); }
            new Chart(ctx, { type: 'bar', data: { labels: vizData.labels, datasets: vizData.datasets }, options: { responsive: true, maintainAspectRatio: true, indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: vizData.chart_title || 'Summary', color: '#ccd6f6', font: { size: 14, family:'Roboto' } }, tooltip: { backgroundColor: '#000' } }, scales: { y: { ticks: { color: '#ccd6f6', font: {size: 11}}, grid: { display: false } }, x: { beginAtZero: true, ticks: { color: '#ccd6f6' }, grid: { color: 'rgba(100, 255, 218, 0.15)' } } } } });
            console.log("[DEBUG] Chart created:", canvasId);
        } catch (error) { console.error("[DEBUG] Error creating chart:", error); if(containerElement) containerElement.innerHTML = "<span>[Chart Display Error]</span>"; }
    }

    /** Creates an OpenLayers map visualization */
    function createMapVisualization(mapVizData, containerElement) {
         if (!supportsOpenLayers || !mapVizData || !containerElement) { console.error("[DEBUG] OL lib unavailable or missing data/container."); return; }
         const isRouteMap = mapVizData.type === 'route' && mapVizData.origin?.coords?.length === 2 && mapVizData.destination?.coords?.length === 2;
         const isPointMap = mapVizData.type === 'point' && mapVizData.latitude != null && mapVizData.longitude != null && !isRouteMap;
         if (!isRouteMap && !isPointMap) { console.error("[DEBUG] Map data missing required coords.", mapVizData); return; }
         let mapDiv = null;
         console.log(`[DEBUG] Attempting to create ${isRouteMap ? 'route' : 'point'} map:`, mapVizData);
         try {
             const mapId = `map-${Date.now()}-${Math.random().toString(16).slice(2)}`;
             containerElement.innerHTML = ''; mapDiv = document.createElement('div'); mapDiv.id = mapId; mapDiv.classList.add('map-inner-container'); mapDiv.style.height = '100%'; mapDiv.style.width = '100%';
             containerElement.appendChild(mapDiv);

             setTimeout(() => { // Delay map init
                 console.log(`[DEBUG] Starting OL map init in target: ${mapId}`);
                 const targetElement = document.getElementById(mapId);
                 if (!targetElement) { console.error(`[DEBUG] Map target element #${mapId} not found!`); if(containerElement) containerElement.innerHTML = "<span>[Map Target Error]</span>"; return; }
                 try {
                     const features = []; let viewCenter, viewZoom, extentToFit;
                     const pointStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(100,255,218,.9)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const originStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(0,255,0,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const destStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(255,0,0,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const lineStyle=new ol.style.Style({stroke:new ol.style.Stroke({color:'rgba(100,255,218,.7)',width:3})});
                     if (isRouteMap) { const oCoords=ol.proj.fromLonLat([mapVizData.origin.coords[1],mapVizData.origin.coords[0]]); const dCoords=ol.proj.fromLonLat([mapVizData.destination.coords[1],mapVizData.destination.coords[0]]); const oMarker=new ol.Feature({geometry:new ol.geom.Point(oCoords),name:`Origin:${mapVizData.origin.name}`}); oMarker.setStyle(originStyle); features.push(oMarker); const dMarker=new ol.Feature({geometry:new ol.geom.Point(dCoords),name:`Dest:${mapVizData.destination.name}`}); dMarker.setStyle(destStyle); features.push(dMarker); const line=new ol.Feature({geometry:new ol.geom.LineString([oCoords,dCoords])}); line.setStyle(lineStyle); features.push(line); extentToFit=ol.extent.boundingExtent([oCoords,dCoords]); console.log("[DEBUG] Route features created.");
                     } else if (isPointMap) { const cCoords=ol.proj.fromLonLat([mapVizData.longitude,mapVizData.latitude]); viewCenter=cCoords; viewZoom=mapVizData.zoom||11; const marker=new ol.Feature({geometry:new ol.geom.Point(cCoords),name:mapVizData.marker_title||'Location'}); marker.setStyle(pointStyle); features.push(marker); console.log("[DEBUG] Point feature created."); }
                     const vecSource=new ol.source.Vector({features:features}); const vecLayer=new ol.layer.Vector({source:vecSource});
                     console.log(`[DEBUG] Creating OL Map instance for target: ${mapId}`);
                     mapInstance=new ol.Map({target:mapId, layers:[new ol.layer.Tile({source:new ol.source.OSM()}), vecLayer], view:new ol.View({center:viewCenter,zoom:viewZoom,maxZoom:18,minZoom:2}), controls:ol.control.defaults({attributionOptions:{collapsible:true}}).extend([new ol.control.ScaleLine()])});
                     if(extentToFit){ console.log("[DEBUG] Fitting map view to extent..."); setTimeout(() => { try { mapInstance.getView().fit(extentToFit, {padding:[70,70,70,70], maxZoom:14, duration:500}); console.log("[DEBUG] Map view fitted."); } catch(fitError) { console.error("[DEBUG] Error fitting map view:", fitError); } }, 150); }
                     console.log("[DEBUG] OL map instance created successfully:", mapId);
                     scrollToTopOfOutput();
                  } catch(mapInitError) { console.error("[DEBUG] Error initializing OpenLayers map instance:", mapInitError); if(containerElement) containerElement.innerHTML = "<span>[Map Init Error]</span>"; }
             }, 150);
         } catch (error) { console.error("[DEBUG] Error setting up map container:", error); if(containerElement) containerElement.innerHTML = "<span>[Map Setup Error]</span>"; else { displayContent({ text: '[Error preparing map display]' }); } }
     } // End createMapVisualization

    /** Displays loading state in UI */
    function showLoadingIndicator() {
        clearAssistantOutputArea(); // Clear previous output
        updateStatus('Processing...'); // Main feedback is status text
        if (visualization) visualization.style.animationPlayState = 'running';
        if(sendButton) sendButton.disabled = true;
        if(listenButton) listenButton.disabled = true;
        if(userInput) userInput.disabled = true;
        if (assistantOutputArea) assistantOutputArea.style.opacity = '0.6'; // Dim output area
    }

     /** Hides loading state */
    function hideLoadingIndicator() {
        if(assistantOutputArea) assistantOutputArea.style.opacity = '1'; // Restore opacity
        if (!assistantSpeaking && !isListening && !statusTextElement?.dataset.error) updateStatus('SYSTEMS ONLINE'); // Reset status
        if (visualization && !assistantSpeaking && !isListening) visualization.style.animationPlayState = 'paused';
        if(sendButton) sendButton.disabled=false;
        if(listenButton) listenButton.disabled=!supportsRecognition||assistantSpeaking;
        if(userInput){userInput.disabled=false; try{userInput.focus();}catch(e){}}
    }

    /** Displays an error message using the notification system */
    function displayError(message) {
        console.log(`[UI ERROR] ${message}`); // Log error clearly
        createNotification("Assistant Error", message, "error");
        updateStatus('Error Detected', true); // Update header status too
    }

    /** Updates the status indicator text and state */
    function updateStatus(text, isError = false) {
        if(statusTextElement) {
            statusTextElement.textContent = text;
            const dotColor = isError ? 'var(--error-color)' : '#4CAF50';
            const dotShadow = isError ? 'var(--error-color)' : '#4CAF50';
            statusTextElement.style.color = isError ? 'var(--error-color)' : 'var(--text-secondary-color)';
            if(isError) statusTextElement.dataset.error = 'true'; else delete statusTextElement.dataset.error;
            if(statusDotElement) { statusDotElement.style.backgroundColor = dotColor; statusDotElement.style.boxShadow = `0 0 8px ${dotShadow}`; }
        }
    }

    /** Sends the user's question to the backend */
    async function sendMessage() {
        const question = userInput?.value.trim(); if (!question || (sendButton && sendButton.disabled)) return;
        // clearError() removed - rely on notification timeouts
        showLoadingIndicator(); // Update status, disable inputs, clear output
        // displayContent({ userQuery: question }); // Removed brief query display for cleaner look
        console.log(`[DEBUG] sendMessage initiated for question: "${question}"`);
        try {
            const response = await fetch('/ask', { method: 'POST', headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}, body: JSON.stringify({ question: question }) });
            console.log(`[DEBUG] Fetch response status: ${response.status}`);
            const data = await response.json().catch(err => { console.error("[DEBUG] JSON Parse Error:", err); return ({ error: `Invalid response (Status: ${response.status})` });});
            console.log("[DEBUG] Received data from backend:", data);

            if (!response.ok || (data && data.error)) { const errorMsg = `Error: ${data.error || response.statusText || 'Unknown'}`; console.error('[DEBUG] Server/App Error:', response.status, data); displayError(errorMsg); displayContent({ text: `Sorry, encountered an error processing.` }); }
            else if (data && data.response) { console.log("[DEBUG] Received valid response, calling displayContent..."); displayContent({ text: data.response, chartData: data.visualization_data, mapData: data.map_data }); } // displayContent handles speaking
            else { console.error('[DEBUG] Invalid success structure:', data); displayError('Unexpected response structure.'); displayContent({ text: 'Sorry, unexpected response.' }); }
        } catch (error) { console.error('[DEBUG] Network/Fetch Error:', error); const errorMsg = 'Network error reaching assistant.'; displayError(errorMsg); displayContent({ text: 'Sorry, trouble connecting.' }); }
        finally { console.log("[DEBUG] sendMessage finally block."); if (supportsSynthesis && synth?.pending) setTimeout(hideLoadingIndicator, 200); else if (!assistantSpeaking) hideLoadingIndicator(); }
    } // End sendMessage

    /** Uses Speech Synthesis to speak the assistant's response */
    function speakResponse(textToSpeak) {
        if (!supportsSynthesis || !synth || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') { console.log("[DEBUG] Speech skipped."); if(assistantSpeaking){ assistantSpeaking=false; /*...*/ } return; }
        if (synth.speaking || synth.pending) { console.log("[DEBUG] Cancelling previous speech."); synth.cancel(); if(assistantSpeaking){ assistantSpeaking=false; /*...*/ } }
        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        if (selectedVoice) { utterance.voice = selectedVoice; utterance.lang = selectedVoice.lang; console.log(`[DEBUG] Using voice: ${selectedVoice.name} (${utterance.lang})`); }
        else { utterance.lang = 'en-US'; console.log(`[DEBUG] Using default voice (Lang: ${utterance.lang}).`); }
        utterance.pitch = 1; utterance.rate = 1;
        utterance.onstart = () => { console.log("[DEBUG] Speech started."); assistantSpeaking = true; updateStatus('Speaking...'); if (visualization) visualization.style.animationPlayState = 'running'; if (listenButton) listenButton.disabled = true; };
        utterance.onend = () => { console.log("[DEBUG] Speech finished."); assistantSpeaking = false; hideLoadingIndicator(); if (!isListening && !statusTextElement?.dataset.error) { updateStatus('SYSTEMS ONLINE'); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; if(userInput) try{userInput.focus();}catch(e){} };
        utterance.onerror = (event) => { console.error('[DEBUG] Speech error:', event.error, event); assistantSpeaking = false; hideLoadingIndicator(); createNotification("Speech Error", `Speech playback failed: ${event.error}`, "error"); if (!isListening) { updateStatus('Speech Error', true); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; };
        setTimeout(() => { if (synth) { console.log("[DEBUG] Attempting synth.speak..."); synth.speak(utterance); } else console.error("[DEBUG] Synth unavailable before speak."); }, 100);
    }

    /** Scrolls the ASSISTANT OUTPUT area to the top */
    function scrollToTopOfOutput() {
        if(assistantOutputArea) {
            assistantOutputArea.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused';
    if(userInput) userInput.focus();
    clearAssistantOutputArea(); // Start clear
    updateStatus('SYSTEMS ONLINE'); // Set initial status

    console.log("[DEBUG] Initial setup complete.");

}); // End DOMContentLoaded