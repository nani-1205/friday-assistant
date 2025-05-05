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
    let currentAssistantMessageElement = null; // Track the text element for chart/map anchoring & speaking class
    let availableVoices = [];
    let selectedVoice = null;
    let mapInstance = null;

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
            if (!availableVoices || availableVoices.length === 0) { console.warn("Voice list empty, waiting for 'voiceschanged'."); return; }
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
            console.log("[DEBUG] Send button clicked!"); // <-- ADD DEBUG LINE
            sendMessage();
        });
        console.log("[DEBUG] Send button listener attached."); // <-- CONFIRM ATTACH
    } else {
        console.error("[DEBUG] Send button element NOT found!");
    }

    if(userInput) {
        userInput.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                console.log("[DEBUG] Enter key pressed in input!"); // <-- ADD DEBUG LINE
                event.preventDefault();
                sendMessage();
            }
        });
         console.log("[DEBUG] User input listener attached."); // <-- CONFIRM ATTACH
    } else {
         console.error("[DEBUG] User input element NOT found!");
    }


    if(listenButton) {
        listenButton.addEventListener('click', () => {
            console.log("[DEBUG] Listen button clicked!"); // <-- ADD DEBUG LINE
            if (!supportsRecognition || !recognition) {
                displayError("Mic not supported/initialized.");
                return;
            }
            if (isListening) { // Stop listening
                 console.log("[DEBUG] Attempting to stop recognition...");
                 try { recognition.stop(); } catch (e) { console.error("[DEBUG] Err stop recognition:", e); isListening=false; listenButton.classList.remove('listening'); /*...*/ }
            } else { // Start listening
                 console.log("[DEBUG] Attempting to start recognition...");
                 if (!navigator.mediaDevices?.getUserMedia) { displayError('Mic access unavailable (needs HTTPS?).'); updateStatus('Mic Access Error', true); return; }
                 navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { console.log("[DEBUG] Mic access granted."); try { clearError(); if(synth?.speaking) synth.cancel(); recognition.start(); } catch (e) { console.error("[DEBUG] Err start recognition:", e); displayError(`Mic start error: ${e.message}`); updateStatus('Mic Start Error', true); isListening = false; } })
                     .catch(err => { console.error("[DEBUG] Mic access err:", err.name, err.message); let msg='Mic access denied.'; if(err.name==='NotFoundError')msg='No mic found.'; else if (err.name==='NotReadableError')msg='Mic busy/hardware error.'; else msg=`Mic access error: ${err.message}`; if (!isSecureContext && err.name==='NotAllowedError') msg+=' Needs HTTPS.'; displayError(msg); updateStatus('Mic Access Denied', true); });
            }
        });
         console.log("[DEBUG] Listen button listener attached."); // <-- CONFIRM ATTACH
    } else {
         console.error("[DEBUG] Listen button element NOT found!");
    }

    // --- Core Functions ---
    function clearMainContent() { /* ... Keep existing unchanged ... */ }
    function displayContent({ text = null, chartData = null, mapData = null, userQuery = null }) { /* ... Keep existing unchanged ... */ }
    function createDataVisualization(vizData, containerElement) { /* ... Keep existing unchanged ... */ }
    function createMapVisualization(mapVizData, containerElement) { /* ... Keep existing unchanged ... */ }
    function showLoadingIndicator() { /* ... Keep existing unchanged ... */ }
    function hideLoadingIndicator() { /* ... Keep existing unchanged ... */ }
    function displayError(message, isPersistent = false) { /* ... Keep existing unchanged ... */ }
    function displayPersistentError(message) { /* ... Keep existing unchanged ... */ }
    function clearError() { /* ... Keep existing unchanged ... */ }
    function updateStatus(text, isError = false) { /* ... Keep existing unchanged ... */ }
    async function sendMessage() { /* ... Keep existing unchanged ... */ }
    function speakResponse(textToSpeak) { /* ... Keep existing unchanged ... */ }
    function scrollToTopMainContent() { /* ... Keep existing unchanged ... */ }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused';
    if(userInput) userInput.focus();
    displayContent({ text: 'Hello! How can I assist you today?' }); // Display initial greeting
    console.log("[DEBUG] Initial setup complete."); // <-- CONFIRM END OF SETUP

}); // End DOMContentLoaded