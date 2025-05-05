// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    console.log("[DEBUG] DOMContentLoaded fired. Finding elements...");
    // *** CORRECTED ELEMENT ID LOOKUP ***
    const assistantOutputArea = document.getElementById('assistant-output-area');
    // *** END CORRECTION ***
    const userInput = document.getElementById('user-input');        // Correct ID for new HTML
    const sendButton = document.getElementById('send-button');       // Correct ID for new HTML
    const listenButton = document.getElementById('listen-button');    // Correct ID for new HTML
    const statusTextElement = document.getElementById('status-text'); // Correct ID for new HTML
    const statusDotElement = document.querySelector('.status-dot');
    const visualization = document.getElementById('ai-visualization')?.querySelector('.pulse-ring'); // Keep pulse ring reference if needed, might remove later
    // Note: Error display uses createNotification now

    // *** CORRECTED DEBUG LOG ***
    console.log(`[DEBUG] Elements found: outputArea=${!!assistantOutputArea}, input=${!!userInput}, sendBtn=${!!sendButton}, listenBtn=${!!listenButton}, statusText=${!!statusTextElement}`);


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
            availableVoices = synth.getVoices();
            if (!availableVoices || availableVoices.length === 0) { console.warn("Voice list empty, waiting for 'voiceschanged'."); return; }
            console.log("[DEBUG] Available Voices:", availableVoices.map(v => ({name: v.name, lang: v.lang, default: v.default, local: v.localService })));
            const targetLang = 'en-US'; const preferredNames = ['google us english', 'microsoft zira', 'samantha', 'female'];
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
    if (!isSecureContext && supportsRecognition) createNotification("Security Warning", "Microphone may not work over non-secure (HTTP) connections.", "error");
    if (!supportsRecognition) { if(listenButton){listenButton.disabled = true; listenButton.title = 'Mic not supported';} updateStatus('Mic Offline'); }
    if (!supportsSynthesis) console.warn('Speech Synthesis not supported.');
    else { if (speechSynthesis.onvoiceschanged !== undefined) { speechSynthesis.onvoiceschanged = loadAndSelectVoice; } else { setTimeout(loadAndSelectVoice, 500); } loadAndSelectVoice(); }
    if (!supportsChartJS) console.warn('Chart.js library not loaded. Charts disabled.');
    if (!supportsOpenLayers) console.warn('OpenLayers library (ol) not loaded. Maps disabled.');

    // --- Initialize Speech Recognition ---
    console.log("[DEBUG] Initializing Speech Recognition (if supported)...");
    if (supportsRecognition) {
        try {
            recognition = new SpeechRecognition(); Object.assign(recognition, { continuous: false, lang: 'en-US', interimResults: false, maxAlternatives: 1 });
            recognition.onstart = () => { console.log("[DEBUG] Recognition started."); isListening = true; if(listenButton) listenButton.classList.add('listening'); updateStatus('Listening...'); if (visualization) visualization.style.animationPlayState = 'running'; /* No error div clear needed */ };
            recognition.onresult = (event) => { const transcript = event.results[event.results.length - 1][0].transcript.trim(); console.log('[DEBUG] Transcript:', transcript); if (transcript) { if(userInput) userInput.value = transcript; sendMessage(); } };
            recognition.onerror = (event) => { console.error('[DEBUG] Mic Error:', event.error, event.message); let msg=`Mic error: ${event.error}`; if(event.error==='no-speech')msg='No speech detected.'; else if(event.error==='not-allowed'){msg='Mic access denied.'; if(!isSecureContext)msg+=' Needs HTTPS.';} else msg=`Mic error: ${event.message||event.error}`; createNotification("Mic Error", msg, "error"); updateStatus('Mic Error', true); };
            recognition.onend = () => { console.log("[DEBUG] Recognition ended."); isListening = false; if(listenButton) listenButton.classList.remove('listening'); if (!assistantSpeaking && !statusTextElement?.dataset.error) updateStatus('SYSTEMS ONLINE'); if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused'; };
            console.log("[DEBUG] Speech Recognition initialized.");
        } catch (error) { console.error("[DEBUG] Failed to initialize SpeechRecognition:", error); if(listenButton){listenButton.disabled=true; listenButton.title='Mic init failed';} updateStatus('Mic Init Error', true); }
    }

     // --- Notification Function ---
     function createNotification(title, message, type = 'info') {
        const existingNotification = document.querySelector('.notification'); if (existingNotification) existingNotification.remove();
        const notification = document.createElement('div'); notification.className = `notification ${type}`;
        notification.innerHTML = `<div class="notification-title">${title}</div><div>${message}</div>`;
        document.body.appendChild(notification);
        requestAnimationFrame(() => notification.classList.add('visible'));
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
                 navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { console.log("[DEBUG] Mic access granted."); try { /* No error div clear */; if(synth?.speaking) synth.cancel(); recognition.start(); } catch (e) { console.error("[DEBUG] Err start recognition:", e); createNotification("Mic Error", `Mic start error: ${e.message}`, "error"); updateStatus('Mic Start Error', true); isListening = false; } })
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
        // *** Use the CORRECT variable name ***
        if (assistantOutputArea) {
            assistantOutputArea.innerHTML = '';
            if (mapInstance) { try { mapInstance.setTarget(null); } catch(e) { console.warn("[DEBUG] Minor error detaching map target:", e); } mapInstance = null; console.log("[DEBUG] Cleared map instance ref."); }
        } else { console.error("[DEBUG] Assistant output area not found in clearAssistantOutputArea!"); }
    }

    /** Displays content (text, chart, map) in the main area */
    function displayContent({ text = null, chartData = null, mapData = null, userQuery = null }) {
        console.log("[DEBUG] Entering displayContent function.");
         // *** Use the CORRECT variable name ***
        if (!assistantOutputArea) { console.error("[DEBUG] Assistant output area missing! Cannot display."); createNotification("UI Error", "Output area missing.", "error"); return; }
        clearAssistantOutputArea(); // Clear previous output

        let contentAdded = false; // Flag

        // 2. Display Assistant Text Response
        if (text) {
            console.log("[DEBUG] Preparing text content wrapper...");
            const textWrapper = document.createElement('div'); textWrapper.classList.add('content-wrapper'); textWrapper.id = 'response-text-area';
            let formattedText = text.replace(/</g,"<").replace(/>/g,">").replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>').replace(/\\n/g,'<br>');
            textWrapper.innerHTML = formattedText;
            assistantOutputArea.appendChild(textWrapper); console.log("[DEBUG] Text wrapper appended."); // *** Use CORRECT variable ***
            speakResponse(text);
            contentAdded = true;
        } else { console.log("[DEBUG] No text content received to display."); }

        // 3. Display Chart
        if (chartData && supportsChartJS) {
            console.log("[DEBUG] Preparing chart wrapper...");
            const chartWrapper = document.createElement('div'); chartWrapper.classList.add('content-wrapper'); chartWrapper.id = 'chart-placeholder';
            assistantOutputArea.appendChild(chartWrapper); console.log("[DEBUG] Chart wrapper appended."); // *** Use CORRECT variable ***
            createDataVisualization(chartData, chartWrapper); contentAdded = true;
        } else if (chartData) console.warn("[DEBUG] Chart data received, but Chart.js unavailable.");

        // 4. Display Map
        if (mapData && supportsOpenLayers) {
             console.log("[DEBUG] Preparing map wrapper...");
             const mapWrapper = document.createElement('div'); mapWrapper.classList.add('content-wrapper'); mapWrapper.id = 'map-placeholder';
             assistantOutputArea.appendChild(mapWrapper); console.log("[DEBUG] Map wrapper appended."); // *** Use CORRECT variable ***
             createMapVisualization(mapData, mapWrapper); contentAdded = true;
        } else if (mapData) console.warn("[DEBUG] Map data received, but OpenLayers unavailable.");

        // Final check and scroll
        requestAnimationFrame(() => {
             // *** Use the CORRECT variable name ***
            if (assistantOutputArea && assistantOutputArea.children.length === 0) { console.warn("[DEBUG] displayContent finished, but output area is still empty!"); /* Maybe add fallback text? */ }
            else { console.log("[DEBUG] displayContent finished populating output area."); }
            scrollToTopOfOutput();
        });

    } // End displayContent

    /** Creates a Chart.js chart */
    function createDataVisualization(vizData, containerElement) { /* ... Keep existing unchanged ... */ }

    /** Creates an OpenLayers map */
    function createMapVisualization(mapVizData, containerElement) { /* ... Keep existing unchanged ... */ }

    /** Displays loading state in UI */
    function showLoadingIndicator() {
        clearAssistantOutputArea(); // Clear previous output using CORRECT variable
        updateStatus('Processing...');
        if (visualization) visualization.style.animationPlayState = 'running';
        if(sendButton) sendButton.disabled = true;
        if(listenButton) listenButton.disabled = true;
        if(userInput) userInput.disabled = true;
        if (assistantOutputArea) assistantOutputArea.style.opacity = '0.6'; // Dim output area using CORRECT variable
    }

    /** Hides loading state */
    function hideLoadingIndicator() {
        if(assistantOutputArea) assistantOutputArea.style.opacity = '1'; // Restore opacity using CORRECT variable
        if (!assistantSpeaking && !isListening && !statusTextElement?.dataset.error) updateStatus('SYSTEMS ONLINE');
        if (visualization && !assistantSpeaking && !isListening) visualization.style.animationPlayState = 'paused';
        if(sendButton) sendButton.disabled=false;
        if(listenButton) listenButton.disabled=!supportsRecognition||assistantSpeaking;
        if(userInput){userInput.disabled=false; try{userInput.focus();}catch(e){}}
    }

    /** Displays an error message using the notification system */
    function displayError(message) { /* ... Keep existing unchanged ... */ }

    /** Updates the status indicator text and state */
    function updateStatus(text, isError = false) { /* ... Keep existing unchanged ... */ }

    /** Sends the user's question to the backend */
    async function sendMessage() { /* ... Keep existing unchanged ... */ }

    /** Uses Speech Synthesis */
    function speakResponse(textToSpeak) { /* ... Keep existing unchanged ... */ }

    /** Scrolls the ASSISTANT OUTPUT area to the top */
    function scrollToTopOfOutput() {
         // *** Use the CORRECT variable name ***
        if(assistantOutputArea) {
            assistantOutputArea.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused';
    if(userInput) userInput.focus();
    clearAssistantOutputArea(); // Start clear using CORRECT variable
    updateStatus('SYSTEMS ONLINE'); // Set initial status
    console.log("[DEBUG] Initial setup complete.");

}); // End DOMContentLoaded