// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    console.log("[DEBUG] DOMContentLoaded fired. Finding elements...");
    const mainContentArea = document.getElementById('main-content');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const listenButton = document.getElementById('listen-button');
    const statusIndicator = document.getElementById('status-indicator');
    const visualization = document.getElementById('ai-visualization')?.querySelector('.pulse-ring');
    const errorMessageDiv = document.getElementById('error-message');
    console.log(`[DEBUG] Elements found: mainContentArea=${!!mainContentArea}, userInput=${!!userInput}, sendButton=${!!sendButton}, listenButton=${!!listenButton}`);


    // --- State Variables ---
    let recognition = null;
    let isListening = false;
    let synth = window.speechSynthesis;
    let assistantSpeaking = false;
    // Remove currentAssistantMessageElement - we replace content now
    let availableVoices = [];
    let selectedVoice = null;
    let mapInstance = null; // Keep map instance reference if needed for cleanup

    // --- Feature Detection ---
    console.log("[DEBUG] Checking features...");
    const isSecureContext = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecognition = !!SpeechRecognition;
    const supportsSynthesis = !!synth;
    const supportsChartJS = typeof Chart !== 'undefined';
    const supportsOpenLayers = typeof ol !== 'undefined';
    console.log(`[DEBUG] Features: SecureCtx=${isSecureContext}, Recognition=${supportsRecognition}, Synthesis=${supportsSynthesis}, ChartJS=${supportsChartJS}, OpenLayers=${supportsOpenLayers}`);


    // --- Function to Load and Select Voices ---
    function loadAndSelectVoice() {
        if (!supportsSynthesis) { console.warn("Speech Synthesis not supported."); return; }
        try {
            availableVoices = synth.getVoices();
            if (!availableVoices || availableVoices.length === 0) { console.warn("Voice list empty or unavailable, waiting for 'voiceschanged'."); return; }
            console.log("[DEBUG] Available Voices:", availableVoices.map(v => ({name: v.name, lang: v.lang, default: v.default, local: v.localService })));
            const targetLang = 'en-US'; const preferredNames = ['google us english', 'microsoft zira', 'samantha', 'female']; // Lowercase names to check against
            selectedVoice = availableVoices.find(v => v.lang === targetLang && preferredNames.some(n => v.name.toLowerCase().includes(n)) && !v.name.toLowerCase().includes('male'));
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && v.name.toLowerCase().includes('female') && !v.name.toLowerCase().includes('male'));
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && !v.localService);
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang);
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.default && v.lang.startsWith('en'));
            if (!selectedVoice && availableVoices.length > 0) selectedVoice = availableVoices[0];
            if (selectedVoice) console.log(`[DEBUG] Selected Voice: ${selectedVoice.name} (Lang: ${selectedVoice.lang}, Local: ${selectedVoice.localService})`);
            else console.warn("[DEBUG] Could not find a suitable voice. Using browser default.");
        } catch (error) { console.error("[DEBUG] Error getting/processing voices:", error); }
    }

    // --- Initial Checks & Setup ---
    console.log("[DEBUG] Performing initial checks...");
    if (!isSecureContext && supportsRecognition) displayPersistentError("Warning: Mic may not work over HTTP.");
    if (!supportsRecognition) { if(listenButton){listenButton.disabled = true; listenButton.title = 'Mic not supported';} updateStatus('Mic not supported'); }
    if (!supportsSynthesis) console.warn('Speech Synthesis not supported.');
    else { if (speechSynthesis.onvoiceschanged !== undefined) { speechSynthesis.onvoiceschanged = loadAndSelectVoice; } else { setTimeout(loadAndSelectVoice, 500); } loadAndSelectVoice(); }
    if (!supportsChartJS) console.warn('Chart.js library not loaded. Charts disabled.');
    if (!supportsOpenLayers) console.warn('OpenLayers library (ol) not loaded. Maps disabled.');

    // --- Initialize Speech Recognition ---
    console.log("[DEBUG] Initializing Speech Recognition (if supported)...");
    if (supportsRecognition) {
        try {
            recognition = new SpeechRecognition(); Object.assign(recognition, { continuous: false, lang: 'en-US', interimResults: false, maxAlternatives: 1 });
            recognition.onstart = () => { console.log("[DEBUG] Recognition started."); isListening = true; if(listenButton) listenButton.classList.add('listening'); updateStatus('Listening...'); if (visualization) visualization.style.animationPlayState = 'running'; clearError(); };
            recognition.onresult = (event) => { const transcript = event.results[event.results.length - 1][0].transcript.trim(); console.log('[DEBUG] Transcript:', transcript); if (transcript) { userInput.value = transcript; sendMessage(); } };
            recognition.onerror = (event) => { console.error('[DEBUG] Mic Error:', event.error, event.message); let msg=`Mic error: ${event.error}`; if(event.error==='no-speech')msg='No speech.'; else if(event.error==='not-allowed'){msg='Mic access denied.'; if(!isSecureContext)msg+=' Needs HTTPS.';} else msg=`Mic error: ${event.message||event.error}`; displayError(msg); updateStatus('Mic Error', true); };
            recognition.onend = () => { console.log("[DEBUG] Recognition ended."); isListening = false; if(listenButton) listenButton.classList.remove('listening'); if (!assistantSpeaking && !statusIndicator?.dataset.error) updateStatus('Idle'); if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused'; };
            console.log("[DEBUG] Speech Recognition initialized.");
        } catch (error) { console.error("[DEBUG] Failed to initialize SpeechRecognition:", error); if(listenButton){listenButton.disabled=true; listenButton.title='Mic init failed';} updateStatus('Mic Init Error', true); }
    }

    // --- Event Listeners ---
    console.log("[DEBUG] Attaching event listeners...");
    if(sendButton) {
        sendButton.addEventListener('click', () => {
            console.log("[DEBUG] Send button clicked!");
            sendMessage();
        });
        console.log("[DEBUG] Send button listener attached.");
    } else { console.error("[DEBUG] Send button element NOT found!"); }

    if(userInput) {
        userInput.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                console.log("[DEBUG] Enter key pressed in input!");
                event.preventDefault();
                sendMessage();
            }
        });
         console.log("[DEBUG] User input listener attached.");
    } else { console.error("[DEBUG] User input element NOT found!"); }

    if(listenButton) {
        listenButton.addEventListener('click', () => {
            console.log("[DEBUG] Listen button clicked!");
            if (!supportsRecognition || !recognition) { displayError("Mic not supported/initialized."); return; }
            if (isListening) { console.log("[DEBUG] Attempting to stop recognition..."); try { recognition.stop(); } catch (e) { console.error("[DEBUG] Err stop recognition:", e); isListening=false; listenButton.classList.remove('listening'); /*...*/ } }
            else { console.log("[DEBUG] Attempting to start recognition..."); if (!navigator.mediaDevices?.getUserMedia) { displayError('Mic access unavailable (needs HTTPS?).'); updateStatus('Mic Access Error', true); return; }
                 navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { console.log("[DEBUG] Mic access granted."); try { clearError(); if(synth?.speaking) synth.cancel(); recognition.start(); } catch (e) { console.error("[DEBUG] Err start recognition:", e); displayError(`Mic start error: ${e.message}`); updateStatus('Mic Start Error', true); isListening = false; } })
                     .catch(err => { console.error("[DEBUG] Mic access err:", err.name, err.message); let msg='Mic access denied.'; if(err.name==='NotFoundError')msg='No mic found.'; else if (err.name==='NotReadableError')msg='Mic busy/hardware error.'; else msg=`Mic access error: ${err.message}`; if (!isSecureContext && err.name==='NotAllowedError') msg+=' Needs HTTPS.'; displayError(msg); updateStatus('Mic Access Denied', true); });
            }
        });
         console.log("[DEBUG] Listen button listener attached.");
    } else { console.error("[DEBUG] Listen button element NOT found!"); }

    // --- Core Functions ---

    /** Clears the main content area */
    function clearMainContent() {
        console.log("[DEBUG] Clearing main content area...");
        if (mainContentArea) {
            mainContentArea.innerHTML = '';
            if (mapInstance) {
                try { mapInstance.setTarget(null); } catch(e) { console.warn("[DEBUG] Minor error detaching map target:", e); }
                mapInstance = null; console.log("[DEBUG] Cleared previous map instance reference.");
            }
        } else { console.error("[DEBUG] Main content area not found in clearMainContent!"); }
    }

    /** Displays content (text, chart, map) in the main area */
    function displayContent({ text = null, chartData = null, mapData = null, userQuery = null }) {
        console.log("[DEBUG] Entering displayContent function.");
        if (!mainContentArea) { console.error("[DEBUG] Main content area not found in displayContent! Cannot display."); displayError("Internal UI Error: Cannot find content display area."); return; }
        clearMainContent(); // Clear previous content first

        // 1. Display User Query Briefly
        if (userQuery) {
            console.log("[DEBUG] Displaying temporary user query:", userQuery);
            const queryWrapper = document.createElement('div'); queryWrapper.classList.add('content-wrapper', 'user-query-display');
            queryWrapper.innerHTML = `<span>You asked: "${userQuery.replace(/</g, "<").replace(/>/g, ">")}"</span>`;
            queryWrapper.style.cssText = "background-color: var(--user-message-bg); text-align: center; font-style: italic; margin-bottom: 10px;"; // Inline styles for simplicity
            mainContentArea.appendChild(queryWrapper); console.log("[DEBUG] User query wrapper appended.");
            setTimeout(() => { if (queryWrapper.parentNode === mainContentArea) { queryWrapper.style.transition = 'opacity 0.3s ease-out'; queryWrapper.style.opacity = '0'; setTimeout(() => queryWrapper.remove(), 300); } }, 1500);
        }

        // 2. Display Assistant Text Response
        if (text) {
            console.log("[DEBUG] Preparing text content wrapper...");
            const textWrapper = document.createElement('div'); textWrapper.classList.add('content-wrapper'); textWrapper.id = 'response-text-area';
            let formattedText = text.replace(/</g, "<").replace(/>/g, ">"); formattedText = formattedText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); formattedText = formattedText.replace(/\*(.*?)\*/g, '<em>$1</em>'); formattedText = formattedText.replace(/\\n/g, '<br>');
            textWrapper.innerHTML = formattedText;
            mainContentArea.appendChild(textWrapper); console.log("[DEBUG] Text content wrapper appended.");
            speakResponse(text); // Speak the original text
        } else { console.log("[DEBUG] No text content to display."); }

        // 3. Display Chart
        if (chartData && supportsChartJS) {
            console.log("[DEBUG] Preparing chart content wrapper...");
            const chartWrapper = document.createElement('div'); chartWrapper.classList.add('content-wrapper'); chartWrapper.id = 'chart-placeholder';
            mainContentArea.appendChild(chartWrapper); console.log("[DEBUG] Chart wrapper appended. Calling createDataVisualization...");
            createDataVisualization(chartData, chartWrapper); // Pass wrapper
        } else if (chartData && !supportsChartJS) { console.warn("[DEBUG] Chart data received, but Chart.js not supported/loaded."); }

        // 4. Display Map
        if (mapData && supportsOpenLayers) {
             console.log("[DEBUG] Preparing map content wrapper...");
             const mapWrapper = document.createElement('div'); mapWrapper.classList.add('content-wrapper'); mapWrapper.id = 'map-placeholder';
             mainContentArea.appendChild(mapWrapper); console.log("[DEBUG] Map wrapper appended. Calling createMapVisualization...");
             createMapVisualization(mapData, mapWrapper); // Pass wrapper
        } else if (mapData && !supportsOpenLayers) { console.warn("[DEBUG] Map data received, but OpenLayers (ol) not supported/loaded."); }

        // Final check after potentially async operations
        requestAnimationFrame(() => {
            if (mainContentArea.children.length === 0 && !userQuery) { console.warn("[DEBUG] displayContent finished, but main content area is still empty!"); const fw = document.createElement('div'); fw.classList.add('content-wrapper'); fw.innerHTML = '<span>Received response, but failed to display content.</span>'; mainContentArea.appendChild(fw); }
            else { console.log("[DEBUG] displayContent finished populating content area (final check)."); }
        });
        scrollToTopMainContent();
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
             containerElement.innerHTML = ''; // Clear placeholder
             mapDiv = document.createElement('div'); mapDiv.id = mapId; mapDiv.classList.add('map-inner-container'); mapDiv.style.height = '100%'; mapDiv.style.width = '100%';
             containerElement.appendChild(mapDiv); // Append target div to the wrapper

             // Delay map initialization slightly longer & check target
             setTimeout(() => {
                 console.log(`[DEBUG] Starting OL map init in target: ${mapId}`);
                 const targetElement = document.getElementById(mapId);
                 if (!targetElement) { console.error(`[DEBUG] Map target element #${mapId} not found!`); if(containerElement) containerElement.innerHTML = "<span>[Map Target Error]</span>"; return; }

                 try { // Nested try for map instance creation
                     const features = []; let viewCenter, viewZoom, extentToFit;
                     const pointStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(100,255,218,.9)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const originStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(0,255,0,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const destStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(255,0,0,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const lineStyle=new ol.style.Style({stroke:new ol.style.Stroke({color:'rgba(100,255,218,.7)',width:3})});

                     if (isRouteMap) {
                         const originCoordsOL = ol.proj.fromLonLat([mapVizData.origin.coords[1], mapVizData.origin.coords[0]]);
                         const destCoordsOL = ol.proj.fromLonLat([mapVizData.destination.coords[1], mapVizData.destination.coords[0]]);
                         const oMarker=new ol.Feature({geometry:new ol.geom.Point(originCoordsOL),name:`Origin:${mapVizData.origin.name}`}); oMarker.setStyle(originStyle); features.push(oMarker);
                         const dMarker=new ol.Feature({geometry:new ol.geom.Point(destCoordsOL),name:`Dest:${mapVizData.destination.name}`}); dMarker.setStyle(destStyle); features.push(dMarker);
                         const line=new ol.Feature({geometry:new ol.geom.LineString([originCoordsOL, destCoordsOL])}); line.setStyle(lineStyle); features.push(line);
                         extentToFit=ol.extent.boundingExtent([originCoordsOL, destCoordsOL]);
                         console.log("[DEBUG] Route features created.");
                     } else if (isPointMap) {
                         const centerCoordsOL = ol.proj.fromLonLat([mapVizData.longitude, mapVizData.latitude]);
                         viewCenter = centerCoordsOL; viewZoom = mapVizData.zoom || 11;
                         const marker = new ol.Feature({ geometry: new ol.geom.Point(centerCoordsOL), name: mapVizData.marker_title || 'Location' }); marker.setStyle(pointStyle); features.push(marker);
                         console.log("[DEBUG] Point feature created.");
                     }

                     const vectorSource = new ol.source.Vector({ features: features });
                     const vectorLayer = new ol.layer.Vector({ source: vectorSource });

                     console.log(`[DEBUG] Creating OL Map instance for target: ${mapId}`);
                     mapInstance = new ol.Map({ target: mapId, layers: [ new ol.layer.Tile({ source: new ol.source.OSM() }), vectorLayer ], view: new ol.View({ center: viewCenter, zoom: viewZoom, maxZoom: 18, minZoom: 2 }), controls: ol.control.defaults({ attributionOptions: { collapsible: true } }).extend([ new ol.control.ScaleLine() ]) });

                     if (extentToFit) {
                          console.log("[DEBUG] Fitting map view to extent...");
                          setTimeout(() => { try { mapInstance.getView().fit(extentToFit, { padding: [70, 70, 70, 70], maxZoom: 14, duration: 500 }); console.log("[DEBUG] Map view fitted."); } catch(fitError) { console.error("[DEBUG] Error fitting map view:", fitError); } }, 150);
                     }
                     console.log("[DEBUG] OL map instance created successfully:", mapId);
                     scrollToTopMainContent(); // Scroll after map rendered

                  } catch(mapInitError) { console.error("[DEBUG] Error initializing OpenLayers map instance:", mapInitError); if(containerElement) containerElement.innerHTML = "<span>[Map Init Error]</span>"; } // Show error in container
             }, 150); // Increased delay
         } catch (error) { console.error("[DEBUG] Error setting up map container:", error); if(containerElement) containerElement.innerHTML = "<span>[Map Setup Error]</span>"; else { displayContent({ text: '[Error preparing map display]' }); } }
     } // End createMapVisualization

    function showLoadingIndicator() { clearMainContent(); updateStatus('Processing...'); if (visualization) visualization.style.animationPlayState = 'running'; if(sendButton) sendButton.disabled = true; if(listenButton) listenButton.disabled = true; if(userInput) userInput.disabled = true; }
    function hideLoadingIndicator() { if(!assistantSpeaking && !isListening && !statusIndicator?.dataset.error) updateStatus('Idle'); if(visualization && !assistantSpeaking && !isListening) visualization.style.animationPlayState = 'paused'; if(sendButton) sendButton.disabled=false; if(listenButton) listenButton.disabled=!supportsRecognition||assistantSpeaking; if(userInput){userInput.disabled=false; try{userInput.focus();}catch(e){}} }
    function displayError(message, isPersistent = false) { if(errorMessageDiv){errorMessageDiv.textContent=message; errorMessageDiv.classList.add('visible'); errorMessageDiv.dataset.persistent=String(isPersistent); if(!isPersistent) setTimeout(clearError,7000);} else console.error("Error display DOM missing.");}
    function displayPersistentError(message) { displayError(message, true); }
    function clearError() { if (errorMessageDiv && errorMessageDiv.dataset.persistent !== 'true') { errorMessageDiv.classList.remove('visible'); setTimeout(() => { errorMessageDiv.textContent = ''; }, 300); }}
    function updateStatus(text, isError = false) { if(statusIndicator){statusIndicator.textContent=text; if(isError){statusIndicator.style.color='var(--error-color)'; statusIndicator.dataset.error='true';} else {statusIndicator.style.color='var(--text-secondary-color)'; delete statusIndicator.dataset.error;}}}

    async function sendMessage() {
        const question = userInput?.value.trim(); if (!question || (sendButton && sendButton.disabled)) return;
        clearError(); showLoadingIndicator(); displayContent({ userQuery: question }); // Show query briefly
        console.log(`[DEBUG] sendMessage initiated for question: "${question}"`);
        try {
            const response = await fetch('/ask', { method: 'POST', headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}, body: JSON.stringify({ question: question }) });
            console.log(`[DEBUG] Fetch response status: ${response.status}`);
            const data = await response.json().catch(err => { console.error("[DEBUG] JSON Parse Error:", err); return ({ error: `Invalid response (Status: ${response.status})` });});
            console.log("[DEBUG] Received data from backend:", data); // Log received data

            if (!response.ok || (data && data.error)) { const errorMsg = `Error: ${data.error || response.statusText || 'Unknown'}`; console.error('[DEBUG] Server/App Error:', response.status, data); displayError(errorMsg); displayContent({ text: `Sorry, error processing.` }); }
            else if (data && data.response) {
                console.log("[DEBUG] Received valid response, calling displayContent...");
                displayContent({ text: data.response, chartData: data.visualization_data, mapData: data.map_data });
            } else { console.error('[DEBUG] Invalid success structure:', data); displayError('Unexpected response structure.'); displayContent({ text: 'Sorry, unexpected response.' }); }
        } catch (error) { console.error('[DEBUG] Network/Fetch Error:', error); const errorMsg = 'Network error reaching assistant.'; displayError(errorMsg); displayContent({ text: 'Sorry, trouble connecting.' }); }
        finally { console.log("[DEBUG] sendMessage finally block."); if (supportsSynthesis && synth?.pending) setTimeout(hideLoadingIndicator, 200); else if (!assistantSpeaking) hideLoadingIndicator(); /* Only hide if not about to speak */ }
    } // End sendMessage

    function speakResponse(textToSpeak) {
        if (!supportsSynthesis || !synth || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') { console.log("[DEBUG] Speech skipped."); if(assistantSpeaking){ /* reset state */ } return; }
        if (synth.speaking || synth.pending) { console.log("[DEBUG] Cancelling previous speech."); synth.cancel(); if(assistantSpeaking){ /* reset state */ } }
        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        if (selectedVoice) { utterance.voice = selectedVoice; utterance.lang = selectedVoice.lang; console.log(`[DEBUG] Using voice: ${selectedVoice.name} (${utterance.lang})`); }
        else { utterance.lang = 'en-US'; console.log(`[DEBUG] Using default voice (Lang: ${utterance.lang}).`); }
        utterance.pitch = 1; utterance.rate = 1; // Reset pitch/rate
        utterance.onstart = () => { console.log("[DEBUG] Speech started."); assistantSpeaking = true; updateStatus('Speaking...'); if (visualization) visualization.style.animationPlayState = 'running'; if (listenButton) listenButton.disabled = true; };
        utterance.onend = () => { console.log("[DEBUG] Speech finished."); assistantSpeaking = false; hideLoadingIndicator(); /* Hide loading *after* speech finishes */ if (!isListening && !statusIndicator?.dataset.error) { updateStatus('Idle'); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; if(userInput) try{userInput.focus();}catch(e){} };
        utterance.onerror = (event) => { console.error('[DEBUG] Speech error:', event.error, event); assistantSpeaking = false; hideLoadingIndicator(); /* Hide loading on error too */ displayError(`Speech error: ${event.error}`); if (!isListening) { updateStatus('Speech Error', true); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; };
        setTimeout(() => { if (synth) { console.log("[DEBUG] Attempting synth.speak..."); synth.speak(utterance); } else console.error("[DEBUG] Synth unavailable before speak."); }, 100);
    }

    function scrollToTopMainContent() { if(mainContentArea) mainContentArea.scrollTo({ top: 0, behavior: 'smooth' }); }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused';
    if(userInput) userInput.focus();
    displayContent({ text: 'Hello! How can I assist you today?' }); // Display initial greeting
    console.log("[DEBUG] Initial setup complete.");

}); // End DOMContentLoaded