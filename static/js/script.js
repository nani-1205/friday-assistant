// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    const mainContentArea = document.getElementById('main-content'); // NEW: Main display area
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
    // Remove currentAssistantMessageElement - we replace content now
    let availableVoices = [];
    let selectedVoice = null;
    let mapInstance = null; // Keep map instance reference if needed for cleanup

    // --- Feature Detection ---
    const isSecureContext = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecognition = !!SpeechRecognition;
    const supportsSynthesis = !!synth;
    const supportsChartJS = typeof Chart !== 'undefined';
    const supportsOpenLayers = typeof ol !== 'undefined';

    // --- Function to Load and Select Voices ---
    function loadAndSelectVoice() { /* ... Keep existing unchanged ... */ }

    // --- Initial Checks & Setup ---
    /* ... Keep existing unchanged ... */

    // --- Initialize Speech Recognition ---
    /* ... Keep existing unchanged ... */

    // --- Event Listeners ---
    /* ... Keep existing unchanged ... */


    // --- Core Functions ---

    /** Clears the main content area */
    function clearMainContent() {
        if (mainContentArea) {
            // Optional: Add fade-out animation before clearing
            mainContentArea.innerHTML = ''; // Clear previous content
            // If map instance exists, ensure it's disposed? (OL specific cleanup)
            if (mapInstance) {
                // mapInstance.setTarget(null); // Detach from DOM element
                // mapInstance = null;
                // Proper cleanup might be more involved depending on OL version/needs
            }
        } else {
            console.error("Main content area not found!");
        }
    }

    /** Displays content (text, chart, map) in the main area */
    function displayContent({ text = null, chartData = null, mapData = null, userQuery = null }) {
        clearMainContent(); // Clear previous content first

        if (!mainContentArea) return;

        // 1. Display User Query Briefly (Optional but good UX)
        if (userQuery) {
             const queryWrapper = document.createElement('div');
             queryWrapper.classList.add('content-wrapper', 'user-query-display'); // Add specific class
             queryWrapper.innerHTML = `<span>You asked: "${userQuery.replace(/</g, "<").replace(/>/g, ">")}"</span>`;
             // Style this differently in CSS if needed
             queryWrapper.style.backgroundColor = 'var(--user-message-bg)'; // Example style
             queryWrapper.style.textAlign = 'center';
             queryWrapper.style.fontStyle = 'italic';
             mainContentArea.appendChild(queryWrapper);
              // Remove it after a short delay before showing assistant response
              setTimeout(() => {
                 if (queryWrapper.parentNode === mainContentArea) { // Check if it wasn't cleared already
                    queryWrapper.style.transition = 'opacity 0.3s ease-out';
                    queryWrapper.style.opacity = '0';
                     setTimeout(() => queryWrapper.remove(), 300); // Remove after fade
                 }
              }, 1500); // Display for 1.5 seconds
        }


        // 2. Display Assistant Text Response
        if (text) {
            const textWrapper = document.createElement('div');
            textWrapper.classList.add('content-wrapper');
            textWrapper.id = 'response-text-area'; // Use ID for potential targeting
            // Basic Markdown support (bold, italic) - needs more robust library for full MD
            let formattedText = text.replace(/</g, "<").replace(/>/g, ">"); // Sanitize first
            formattedText = formattedText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); // Bold
            formattedText = formattedText.replace(/\*(.*?)\*/g, '<em>$1</em>');       // Italic
            // Handle newlines potentially represented as \n
            formattedText = formattedText.replace(/\\n/g, '<br>');
            textWrapper.innerHTML = formattedText; // Use innerHTML for formatting tags
            mainContentArea.appendChild(textWrapper);
            speakResponse(text); // Speak the original text
        }

        // 3. Display Chart
        if (chartData && supportsChartJS) {
            const chartWrapper = document.createElement('div');
            chartWrapper.classList.add('content-wrapper');
            chartWrapper.id = 'chart-placeholder'; // Use placeholder ID
            mainContentArea.appendChild(chartWrapper); // Add wrapper first
            createDataVisualization(chartData, chartWrapper); // Pass wrapper as anchor
        }

        // 4. Display Map
        if (mapData && supportsOpenLayers) {
             const mapWrapper = document.createElement('div');
             mapWrapper.classList.add('content-wrapper');
             mapWrapper.id = 'map-placeholder'; // Use placeholder ID
             mainContentArea.appendChild(mapWrapper); // Add wrapper first
             createMapVisualization(mapData, mapWrapper); // Pass wrapper as anchor
        }

        scrollToTopMainContent(); // Scroll to top of content area
    }


    /** Creates a Chart.js chart inside the provided container element */
    function createDataVisualization(vizData, containerElement) {
        // Note: anchorElement parameter removed, we now pass the direct container
        if (!vizData || !containerElement || !Chart) { console.error("Chart.js unavailable, or missing vizData/containerElement."); return; }
        if (vizData.type !== 'bar') { console.warn("Unhandled viz type:", vizData.type); return; }
        try {
            const canvasId = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            // No need to create chartContainer, we are given the wrapper (containerElement)
            containerElement.innerHTML = ''; // Clear the placeholder
            const canvas = document.createElement('canvas'); canvas.id = canvasId;
            containerElement.appendChild(canvas); // Append canvas to the wrapper
            const ctx = canvas.getContext('2d');
            new Chart(ctx, { type: 'bar', data: { labels: vizData.labels, datasets: vizData.datasets }, options: { /* ... keep options ... */ } });
            console.log("Chart created:", canvasId);
        } catch (error) { console.error("Error creating chart:", error); if(containerElement) containerElement.innerHTML = "<span>[Chart Display Error]</span>"; }
    }

    /** Creates an OpenLayers map inside the provided container element */
    function createMapVisualization(mapVizData, containerElement) {
         // Note: anchorElement parameter removed, we now pass the direct container
        if (!supportsOpenLayers || !mapVizData || !containerElement) { console.error("OL lib unavailable or missing mapVizData/containerElement."); return; }
        const isRouteMap = mapVizData.type === 'route' && mapVizData.origin?.coords?.length === 2 && mapVizData.destination?.coords?.length === 2;
        const isPointMap = mapVizData.type === 'point' && mapVizData.latitude != null && mapVizData.longitude != null && !isRouteMap;
        if (!isRouteMap && !isPointMap) { console.error("Map data missing coords.", mapVizData); return; }
        console.log(`Attempting to create ${isRouteMap ? 'route' : 'point'} map:`, mapVizData);
        try {
            const mapId = `map-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            // No need to create mapContainer, use the provided wrapper (containerElement)
            containerElement.innerHTML = ''; // Clear the placeholder
            const mapDiv = document.createElement('div'); // Create the div OL targets
            mapDiv.id = mapId;
            mapDiv.classList.add('map-inner-container'); // New class for potential inner styling if needed
            mapDiv.style.height = '100%'; // Make inner div fill wrapper height
            mapDiv.style.width = '100%';
            containerElement.appendChild(mapDiv); // Append target div to the wrapper

            // Delay map initialization slightly
            setTimeout(() => {
                try {
                    const features = []; let viewCenter, viewZoom, extentToFit;
                    // ... (Keep marker style definitions) ...
                     const pointStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(100,255,218,.9)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const originStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(0,255,0,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const destStyle=new ol.style.Style({image:new ol.style.Circle({radius:7,fill:new ol.style.Fill({color:'rgba(255,0,0,.8)'}),stroke:new ol.style.Stroke({color:'#fff',width:2})})});
                     const lineStyle=new ol.style.Style({stroke:new ol.style.Stroke({color:'rgba(100,255,218,.7)',width:3})});

                    if (isRouteMap) { // ... (Keep route map logic: fromLonLat, markers, line, extentToFit) ...
                        const oCoords=ol.proj.fromLonLat([mapVizData.origin.coords[1],mapVizData.origin.coords[0]]); const dCoords=ol.proj.fromLonLat([mapVizData.destination.coords[1],mapVizData.destination.coords[0]]); const oMarker=new ol.Feature({geometry:new ol.geom.Point(oCoords),name:`Origin:${mapVizData.origin.name}`}); oMarker.setStyle(originStyle); features.push(oMarker); const dMarker=new ol.Feature({geometry:new ol.geom.Point(dCoords),name:`Dest:${mapVizData.destination.name}`}); dMarker.setStyle(destStyle); features.push(dMarker); const line=new ol.Feature({geometry:new ol.geom.LineString([oCoords,dCoords])}); line.setStyle(lineStyle); features.push(line); extentToFit=ol.extent.boundingExtent([oCoords,dCoords]);
                    } else if (isPointMap) { // ... (Keep point map logic: fromLonLat, marker) ...
                        const cCoords=ol.proj.fromLonLat([mapVizData.longitude,mapVizData.latitude]); viewCenter=cCoords; viewZoom=mapVizData.zoom||11; const marker=new ol.Feature({geometry:new ol.geom.Point(cCoords),name:mapVizData.marker_title||'Location'}); marker.setStyle(pointStyle); features.push(marker);
                    }
                    const vecSource=new ol.source.Vector({features:features}); const vecLayer=new ol.layer.Vector({source:vecSource});
                    mapInstance=new ol.Map({ target: mapId, layers:[new ol.layer.Tile({source:new ol.source.OSM()}), vecLayer], view:new ol.View({center:viewCenter,zoom:viewZoom,maxZoom:18,minZoom:2}), controls:ol.control.defaults({attributionOptions:{collapsible:true}}).extend([new ol.control.ScaleLine()]) });
                    if(extentToFit){ setTimeout(() => { mapInstance.getView().fit(extentToFit, {padding:[70,70,70,70], maxZoom:14, duration:500}); console.log("Map view fitted."); }, 100); }
                    console.log("OL map created:", mapId);
                 } catch(mapInitError) { console.error("Error initializing OL map:", mapInitError); if(mapDiv.parentNode) mapDiv.parentNode.innerHTML = "<span>[Map Init Error]</span>"; } // Show error in wrapper
            }, 50);
        } catch (error) { console.error("Error setting up map container:", error); if(containerElement) containerElement.innerHTML = "<span>[Map Setup Error]</span>"; }
    } // End createMapVisualization

    /** Displays loading state in UI - Update status, clear content? */
    function showLoadingIndicator() {
        clearMainContent(); // Clear content area when starting to process
        updateStatus('Processing...');
        if (visualization) visualization.style.animationPlayState = 'running';
        if(sendButton) sendButton.disabled = true;
        if(listenButton) listenButton.disabled = true;
        if(userInput) userInput.disabled = true;
    }

    /** Hides loading state and re-enables controls */
    function hideLoadingIndicator() {
        // Status reset happens naturally based on speaking/listening state changes
        if (!assistantSpeaking && !isListening && !statusIndicator?.dataset.error) updateStatus('Idle');
        if (visualization && !assistantSpeaking && !isListening) visualization.style.animationPlayState = 'paused';
        if(sendButton) sendButton.disabled=false;
        if(listenButton) listenButton.disabled=!supportsRecognition||assistantSpeaking;
        if(userInput){userInput.disabled=false; try{userInput.focus();}catch(e){}}
    }

    /** Displays an error message in the dedicated div */
    function displayError(message, isPersistent = false) {
        if(errorMessageDiv) {
            errorMessageDiv.textContent = message;
            errorMessageDiv.classList.add('visible'); // Use class to trigger visibility/animation
            errorMessageDiv.dataset.persistent = String(isPersistent);
            if (!isPersistent) {
                setTimeout(clearError, 7000);
            }
        } else console.error("Error display DOM element missing.");
    }
    /** Displays a persistent error */
    function displayPersistentError(message) { displayError(message, true); }
    /** Clears non-persistent error messages */
    function clearError() {
        if (errorMessageDiv && errorMessageDiv.dataset.persistent !== 'true') {
             errorMessageDiv.classList.remove('visible'); // Hide via class
             // Clear text after transition (match CSS transition duration)
             setTimeout(() => { errorMessageDiv.textContent = ''; }, 300);
        }
    }
    /** Updates the status indicator text and state */
    function updateStatus(text, isError = false) { /* ... Keep existing unchanged ... */ }

    /** Sends the user's question to the backend */
    async function sendMessage() {
        const question = userInput?.value.trim(); if (!question || (sendButton && sendButton.disabled)) return;
        clearError(); // Clear previous errors
        // Don't add user message to main content, show briefly instead
        showLoadingIndicator(); // Clear main content and show processing state
        displayContent({ userQuery: question }); // Show user query briefly

        try {
            const response = await fetch('/ask', { method: 'POST', headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}, body: JSON.stringify({ question: question }) });
            const data = await response.json().catch(err => ({ error: `Invalid response (Status: ${response.status})` }));

            // --- Display Response ---
            if (!response.ok || (data && data.error)) {
                const errorMsg = `Error: ${data.error || response.statusText || 'Unknown'}`; console.error('Server/App Error:', response.status, data);
                displayError(errorMsg); // Show error in dedicated div
                // Display a simple error message in main content
                displayContent({ text: `Sorry, I encountered an error processing that.` });
            } else if (data && data.response) {
                 // Display combined content: text, chart (optional), map (optional)
                 displayContent({
                     text: data.response,
                     chartData: data.visualization_data,
                     mapData: data.map_data
                 });
                 // Note: speakResponse is called within displayContent now
            } else {
                 console.error('Invalid success structure:', data); displayError('Unexpected response structure.');
                 displayContent({ text: 'Sorry, I received an unexpected response.' });
            }
        } catch (error) {
             console.error('Network/Fetch Error:', error); const errorMsg = 'Network error reaching assistant.';
             displayError(errorMsg);
             displayContent({ text: 'Sorry, I seem to be having trouble connecting.' });
        } finally {
             // Don't hide indicator immediately if speaking starts
             if (!assistantSpeaking) {
                 hideLoadingIndicator();
             }
             // If speaking did start, hideLoadingIndicator will be called in speakResponse's onend/onerror
        }
    } // End sendMessage

    /** Uses Speech Synthesis to speak the assistant's response */
    function speakResponse(textToSpeak) {
        if (!supportsSynthesis || !synth || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') { console.log("Speech skipped."); if(assistantSpeaking){ /* reset state */ } return; }
        if (synth.speaking || synth.pending) { console.log("Cancelling previous speech."); synth.cancel(); /* reset state */ }
        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        if (selectedVoice) { utterance.voice = selectedVoice; utterance.lang = selectedVoice.lang; console.log(`Using voice: ${selectedVoice.name} (${utterance.lang})`); }
        else { utterance.lang = 'en-US'; console.log(`Using default voice (Lang: ${utterance.lang}).`); }
        utterance.pitch = 1; utterance.rate = 1;
        utterance.onstart = () => { console.log("Speech started."); assistantSpeaking = true; updateStatus('Speaking...'); if (visualization) visualization.style.animationPlayState = 'running'; if (listenButton) listenButton.disabled = true; /* No message element to style now */ };
        utterance.onend = () => { console.log("Speech finished."); assistantSpeaking = false; if (!isListening && !statusIndicator?.dataset.error) { updateStatus('Idle'); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; if(userInput) try{userInput.focus();}catch(e){} };
        utterance.onerror = (event) => { console.error('Speech error:', event.error, event); assistantSpeaking = false; displayError(`Speech error: ${event.error}`); if (!isListening) { updateStatus('Speech Error', true); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; };
        setTimeout(() => { if (synth) { console.log("Attempting synth.speak..."); synth.speak(utterance); } else console.error("Synth unavailable before speak."); }, 100);
    }

    /** Scrolls the main content area to the top */
    function scrollToTopMainContent() {
        if(mainContentArea) {
             mainContentArea.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused';
    if(userInput) userInput.focus();
    // Display initial greeting in the main content area
    displayContent({ text: 'Hello! How can I assist you today?' });

}); // End DOMContentLoaded