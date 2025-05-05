// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    const chatbox = document.getElementById('chatbox');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const listenButton = document.getElementById('listen-button');
    const statusIndicator = document.getElementById('status-indicator');
    const visualization = document.getElementById('ai-visualization')?.querySelector('.pulse-ring');
    const errorMessageDiv = document.getElementById('error-message');

    // --- State Variables ---
    let recognition = null;
    let isListening = false;
    let synth = window.speechSynthesis;
    let assistantSpeaking = false;
    let currentAssistantMessageElement = null;
    let availableVoices = [];
    let selectedVoice = null;
    let mapInstance = null;

    // --- Feature Detection ---
    const isSecureContext = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecognition = !!SpeechRecognition;
    const supportsSynthesis = !!synth;
    const supportsChartJS = typeof Chart !== 'undefined';
    const supportsOpenLayers = typeof ol !== 'undefined';

    // --- Function to Load and Select Voices ---
    function loadAndSelectVoice() {
        if (!supportsSynthesis) { console.warn("Speech Synthesis not supported."); return; }
        try {
            availableVoices = synth.getVoices();
            if (!availableVoices || availableVoices.length === 0) { console.warn("Voice list empty, waiting for 'voiceschanged'."); return; }
            console.log("Available Voices:", availableVoices.map(v => ({name: v.name, lang: v.lang, default: v.default, local: v.localService })));
            const targetLang = 'en-US'; const preferredNames = ['google us english', 'microsoft zira', 'samantha', 'female'];
            selectedVoice = availableVoices.find(v => v.lang === targetLang && preferredNames.some(n => v.name.toLowerCase().includes(n)) && !v.name.toLowerCase().includes('male'));
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && v.name.toLowerCase().includes('female') && !v.name.toLowerCase().includes('male'));
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && !v.localService);
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang);
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.default && v.lang.startsWith('en'));
            if (!selectedVoice && availableVoices.length > 0) selectedVoice = availableVoices[0];
            if (selectedVoice) console.log(`Selected Voice: ${selectedVoice.name} (Lang: ${selectedVoice.lang}, Local: ${selectedVoice.localService})`);
            else console.warn("Could not find a suitable voice. Using browser default.");
        } catch (error) { console.error("Error getting/processing voices:", error); }
    }

    // --- Initial Checks & Setup ---
    if (!isSecureContext && supportsRecognition) displayPersistentError("Warning: Mic may not work over HTTP.");
    if (!supportsRecognition) { if(listenButton){listenButton.disabled = true; listenButton.title = 'Mic not supported';} updateStatus('Mic not supported'); }
    if (!supportsSynthesis) console.warn('Speech Synthesis not supported.');
    else { if (speechSynthesis.onvoiceschanged !== undefined) { speechSynthesis.onvoiceschanged = loadAndSelectVoice; } else { setTimeout(loadAndSelectVoice, 500); } loadAndSelectVoice(); }
    if (!supportsChartJS) console.warn('Chart.js library not loaded. Charts disabled.');
    if (!supportsOpenLayers) console.warn('OpenLayers library (ol) not loaded. Maps disabled.');

    // --- Initialize Speech Recognition ---
    if (supportsRecognition) {
        try {
            recognition = new SpeechRecognition(); Object.assign(recognition, { continuous: false, lang: 'en-US', interimResults: false, maxAlternatives: 1 });
            recognition.onstart = () => { isListening = true; if(listenButton) listenButton.classList.add('listening'); updateStatus('Listening...'); if (visualization) visualization.style.animationPlayState = 'running'; clearError(); };
            recognition.onresult = (event) => { const transcript = event.results[event.results.length - 1][0].transcript.trim(); console.log('Transcript:', transcript); if (transcript) { userInput.value = transcript; sendMessage(); } };
            recognition.onerror = (event) => { console.error('Mic Error:', event.error, event.message); let msg=`Mic error: ${event.error}`; if(event.error==='no-speech')msg='No speech.'; else if(event.error==='not-allowed'){msg='Mic access denied.'; if(!isSecureContext)msg+=' Needs HTTPS.';} else msg=`Mic error: ${event.message||event.error}`; displayError(msg); updateStatus('Mic Error', true); };
            recognition.onend = () => { isListening = false; if(listenButton) listenButton.classList.remove('listening'); if (!assistantSpeaking && !statusIndicator?.dataset.error) updateStatus('Idle'); if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused'; };
        } catch (error) { console.error("Failed to initialize SpeechRecognition:", error); if(listenButton){listenButton.disabled=true; listenButton.title='Mic init failed';} updateStatus('Mic Init Error', true); }
    }

    // --- Event Listeners ---
    if(sendButton) sendButton.addEventListener('click', sendMessage);
    if(userInput) userInput.addEventListener('keypress', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
    if(listenButton) listenButton.addEventListener('click', () => {
        if (!supportsRecognition || !recognition) { displayError("Mic not supported/initialized."); return; }
        if (isListening) { try { recognition.stop(); } catch (e) { console.error("Err stop recognition:", e); isListening=false; listenButton.classList.remove('listening'); /*...*/ } }
        else {
            if (!navigator.mediaDevices?.getUserMedia) { displayError('Mic access unavailable (needs HTTPS?).'); updateStatus('Mic Access Error', true); return; }
            navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { console.log("Mic access granted."); try { clearError(); if(synth?.speaking) synth.cancel(); recognition.start(); } catch (e) { console.error("Err start recognition:", e); displayError(`Mic start error: ${e.message}`); updateStatus('Mic Start Error', true); isListening = false; } })
                .catch(err => { console.error("Mic access err:", err.name, err.message); let msg='Mic access denied.'; if(err.name==='NotFoundError')msg='No mic found.'; else if (err.name==='NotReadableError')msg='Mic busy/hardware error.'; else msg=`Mic access error: ${err.message}`; if (!isSecureContext && err.name==='NotAllowedError') msg+=' Needs HTTPS.'; displayError(msg); updateStatus('Mic Access Denied', true); });
        }
    });

    // --- Core Functions ---
    /** Adds a message bubble to the chat interface with animation */
    function addMessageToChat(sender, message, { isLoading = false, imageUrl = null } = {}) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender.toLowerCase());

        // Add class to trigger animation (CSS handles the animation)
        // Removed briefly after adding to allow animation replay if needed, though typically not necessary here.
        // requestAnimationFrame(() => { messageElement.classList.add('message-appear'); });

        const sanitizedMessage = message.replace(/</g, "<").replace(/>/g, ">");
        messageElement.innerHTML = `<span>${sanitizedMessage}</span>`;
        if (isLoading) messageElement.classList.add('loading');

        let imgContainer = null;
        if (imageUrl) { /* ... image handling ... */ }

        const existingLoading = chatbox?.querySelector('.message.loading');
        if (existingLoading) existingLoading.remove();

        if(chatbox) chatbox.appendChild(messageElement);
        if (imgContainer && chatbox) chatbox.appendChild(imgContainer);

        scrollToBottom();
        return messageElement;
    }

    /** Creates a Chart.js chart */
    function createDataVisualization(vizData, anchorElement) {
        if (!supportsChartJS || !vizData || !anchorElement) { console.error("Chart.js unavailable or missing data/anchor."); return; }
        if (vizData.type !== 'bar') { console.warn("Unhandled viz type:", vizData.type); return; }
        let chartContainer = null;
        try {
            const canvasId = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            chartContainer = document.createElement('div'); chartContainer.classList.add('chart-container');
            const canvas = document.createElement('canvas'); canvas.id = canvasId; chartContainer.appendChild(canvas);
            anchorElement.parentNode.insertBefore(chartContainer, anchorElement.nextSibling || null);
            const ctx = canvas.getContext('2d');
            new Chart(ctx, { type: 'bar', data: { labels: vizData.labels, datasets: vizData.datasets }, options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: vizData.chart_title || 'Summary', color: '#ccd6f6', font: { size: 14, family:'Roboto' } }, tooltip: { backgroundColor: '#000' } }, scales: { y: { ticks: { color: '#ccd6f6', font: {size: 11}}, grid: { display: false } }, x: { beginAtZero: true, ticks: { color: '#ccd6f6' }, grid: { color: 'rgba(100, 255, 218, 0.15)' } } } } });
            console.log("Chart created:", canvasId); scrollToBottom();
        } catch (error) { console.error("Error creating chart:", error); if(chartContainer) chartContainer.innerHTML = "<span>[Viz Error]</span>"; }
    }

    /** Creates an OpenLayers map visualization */
    function createMapVisualization(mapVizData, anchorElement) {
        if (!supportsOpenLayers || !mapVizData || !anchorElement) { console.error("OL lib unavailable or missing data/anchor."); return; }
        const isRouteMap = mapVizData.type === 'route' && mapVizData.origin?.coords?.length === 2 && mapVizData.destination?.coords?.length === 2;
        const isPointMap = mapVizData.type === 'point' && mapVizData.latitude != null && mapVizData.longitude != null && !isRouteMap;
        if (!isRouteMap && !isPointMap) { console.error("Map data missing coords.", mapVizData); return; }
        let mapContainer = null;
        console.log(`Attempting to create ${isRouteMap ? 'route' : 'point'} map:`, mapVizData);
        try {
            const mapId = `map-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            mapContainer = document.createElement('div'); mapContainer.id = mapId; mapContainer.classList.add('map-container');
            anchorElement.parentNode.insertBefore(mapContainer, anchorElement.nextSibling || null);
            setTimeout(() => { // Delay map init
                try {
                    const features = []; let viewCenter, viewZoom, extentToFit;
                    const pointStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(100,255,218,.9)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                    const originStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(0,255,0,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                    const destStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(255,0,0,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                    const lineStyle=new ol.style.Style({stroke:new ol.style.Stroke({color:'rgba(100,255,218,.7)',width:3})});
                    if(isRouteMap){ const oCoords=ol.proj.fromLonLat([mapVizData.origin.coords[1],mapVizData.origin.coords[0]]); const dCoords=ol.proj.fromLonLat([mapVizData.destination.coords[1],mapVizData.destination.coords[0]]); const oMarker=new ol.Feature({geometry:new ol.geom.Point(oCoords),name:`Origin:${mapVizData.origin.name}`}); oMarker.setStyle(originStyle); features.push(oMarker); const dMarker=new ol.Feature({geometry:new ol.geom.Point(dCoords),name:`Dest:${mapVizData.destination.name}`}); dMarker.setStyle(destStyle); features.push(dMarker); const line=new ol.Feature({geometry:new ol.geom.LineString([oCoords,dCoords])}); line.setStyle(lineStyle); features.push(line); extentToFit=ol.extent.boundingExtent([oCoords,dCoords]);
                    } else if(isPointMap){ const cCoords=ol.proj.fromLonLat([mapVizData.longitude,mapVizData.latitude]); viewCenter=cCoords; viewZoom=mapVizData.zoom||11; const marker=new ol.Feature({geometry:new ol.geom.Point(cCoords),name:mapVizData.marker_title||'Location'}); marker.setStyle(pointStyle); features.push(marker); }
                    const vecSource=new ol.source.Vector({features:features}); const vecLayer=new ol.layer.Vector({source:vecSource});
                    mapInstance=new ol.Map({target:mapId, layers:[new ol.layer.Tile({source:new ol.source.OSM()}), vecLayer], view:new ol.View({center:viewCenter,zoom:viewZoom,maxZoom:18,minZoom:2}), controls:ol.control.defaults({attributionOptions:{collapsible:true}}).extend([new ol.control.ScaleLine()])});
                    if(extentToFit){ setTimeout(() => { mapInstance.getView().fit(extentToFit, {padding:[70,70,70,70], maxZoom:14, duration:500}); console.log("Map view fitted."); }, 100); }
                    console.log("OL map created:", mapId); scrollToBottom();
                 } catch(mapInitError) { console.error("Error initializing OL map:", mapInitError); if(mapContainer) mapContainer.innerHTML = "<span>[Map Init Error]</span>"; }
            }, 50);
        } catch (error) { console.error("Error setting up map container:", error); if(mapContainer) mapContainer.innerHTML = "<span>[Map Setup Error]</span>"; else { addMessageToChat('Assistant', '[Error preparing map]'); } }
    } // End createMapVisualization

    function showLoadingIndicator() { addMessageToChat('Assistant', 'Processing', { isLoading: true }); updateStatus('Processing...'); if (visualization) visualization.style.animationPlayState = 'running'; if(sendButton) sendButton.disabled = true; if(listenButton) listenButton.disabled = true; if(userInput) userInput.disabled = true; }
    function hideLoadingIndicator() { const li = chatbox?.querySelector('.message.loading'); if(li) li.remove(); if(!assistantSpeaking && !isListening && !statusIndicator?.dataset.error) updateStatus('Idle'); if(visualization && !assistantSpeaking && !isListening) visualization.style.animationPlayState = 'paused'; if(sendButton) sendButton.disabled=false; if(listenButton) listenButton.disabled=!supportsRecognition||assistantSpeaking; if(userInput){userInput.disabled=false; try{userInput.focus();}catch(e){}} }
    function displayError(message, isPersistent = false) { if(errorMessageDiv){errorMessageDiv.textContent=message; errorMessageDiv.style.display='block'; errorMessageDiv.dataset.persistent=String(isPersistent); if(!isPersistent) setTimeout(clearError,7000);} else console.error("Err display DOM missing.");}
    function displayPersistentError(message) { displayError(message, true); }
    function clearError() { if (errorMessageDiv && errorMessageDiv.dataset.persistent !== 'true') { errorMessageDiv.textContent = ''; errorMessageDiv.style.display = 'none'; }}
    function updateStatus(text, isError = false) { if(statusIndicator){statusIndicator.textContent=text; if(isError){statusIndicator.style.color='var(--error-color)'; statusIndicator.dataset.error='true';} else {statusIndicator.style.color='var(--text-secondary-color)'; delete statusIndicator.dataset.error;}}}

    async function sendMessage() {
        const question = userInput?.value.trim(); if (!question || (sendButton && sendButton.disabled)) return;
        clearError(); addMessageToChat('User', question); if(userInput) userInput.value = ''; showLoadingIndicator();
        try {
            const response = await fetch('/ask', { method: 'POST', headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}, body: JSON.stringify({ question: question }) });
            const data = await response.json().catch(err => ({ error: `Invalid response (Status: ${response.status})` }));
            if (!response.ok || (data && data.error)) { const errorMsg = `Error: ${data.error || response.statusText || 'Unknown'}`; console.error('Server/App Error:', response.status, data); displayError(errorMsg); addMessageToChat('Assistant', `Sorry, error processing.`); }
            else if (data && data.response) {
                currentAssistantMessageElement = addMessageToChat('Assistant', data.response, { imageUrl: data.image_url });
                // Render visualizations *after* the text bubble they relate to
                if (data.visualization_data && supportsChartJS) createDataVisualization(data.visualization_data, currentAssistantMessageElement);
                if (data.map_data && supportsOpenLayers) createMapVisualization(data.map_data, currentAssistantMessageElement);
                speakResponse(data.response); // Speak after content is added
            } else { console.error('Invalid success structure:', data); displayError('Unexpected response structure.'); addMessageToChat('Assistant', 'Sorry, unexpected response.'); }
        } catch (error) { console.error('Network/Fetch Error:', error); const errorMsg = 'Network error reaching assistant.'; displayError(errorMsg); addMessageToChat('Assistant', 'Sorry, trouble connecting.'); }
        finally { if (supportsSynthesis && synth?.pending) setTimeout(hideLoadingIndicator, 200); else hideLoadingIndicator(); }
    }

    function speakResponse(textToSpeak) {
        if (!supportsSynthesis || !synth || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') { console.log("Speech skipped."); if(assistantSpeaking){ assistantSpeaking=false; if(currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking'); /*...*/ } return; }
        if (synth.speaking || synth.pending) { console.log("Cancelling previous speech."); synth.cancel(); if(assistantSpeaking){ assistantSpeaking=false; if(currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking');} }
        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        if (selectedVoice) { utterance.voice = selectedVoice; utterance.lang = selectedVoice.lang; console.log(`Using voice: ${selectedVoice.name} (${utterance.lang})`); }
        else { utterance.lang = 'en-US'; console.log(`Using default voice (Lang: ${utterance.lang}).`); }
        utterance.pitch = 1; utterance.rate = 1;
        utterance.onstart = () => { console.log("Speech started."); assistantSpeaking = true; updateStatus('Speaking...'); if (visualization) visualization.style.animationPlayState = 'running'; if (listenButton) listenButton.disabled = true; if (currentAssistantMessageElement) currentAssistantMessageElement.classList.add('speaking'); };
        utterance.onend = () => { console.log("Speech finished."); assistantSpeaking = false; if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking'); if (!isListening && !statusIndicator?.dataset.error) { updateStatus('Idle'); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; if(userInput) try{userInput.focus();}catch(e){} currentAssistantMessageElement = null; };
        utterance.onerror = (event) => { console.error('Speech error:', event.error, event); assistantSpeaking = false; if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking'); displayError(`Speech error: ${event.error}`); if (!isListening) { updateStatus('Speech Error', true); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; currentAssistantMessageElement = null; };
        setTimeout(() => { if (synth) { console.log("Attempting synth.speak..."); synth.speak(utterance); } else console.error("Synth unavailable before speak."); }, 100);
    }

    function scrollToBottom() { if(chatbox) chatbox.scrollTo({ top: chatbox.scrollHeight, behavior: 'smooth' }); }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused';
    if(userInput) userInput.focus();

}); // End DOMContentLoaded