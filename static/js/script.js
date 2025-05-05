// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    console.log("[DEBUG] DOMContentLoaded: Finding elements...");
    const assistantOutputArea = document.getElementById('assistant-output-area'); // <--- Changed
    const userInput = document.getElementById('user-input');        // <--- Changed ID
    const sendButton = document.getElementById('send-button');       // <--- Changed ID
    const listenButton = document.getElementById('listen-button');    // <--- Changed ID
    const statusTextElement = document.getElementById('status-text'); // <--- Changed ID
    const statusDotElement = document.querySelector('.status-dot'); // Keep dot reference
    const visualization = document.getElementById('ai-visualization')?.querySelector('.pulse-ring'); // Keep pulse ring
    // Note: Error display uses createNotification now

    console.log(`[DEBUG] Elements: outputArea=${!!assistantOutputArea}, input=${!!userInput}, sendBtn=${!!sendButton}, listenBtn=${!!listenButton}, statusText=${!!statusTextElement}`);

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
    function loadAndSelectVoice() { /* ... Keep existing unchanged ... */ }

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
            recognition.onstart = () => { console.log("[DEBUG] Recognition started."); isListening = true; if(listenButton) listenButton.classList.add('listening'); updateStatus('Listening...'); if (visualization) visualization.style.animationPlayState = 'running'; /* No separate error div clear needed */ };
            recognition.onresult = (event) => { const transcript = event.results[event.results.length - 1][0].transcript.trim(); console.log('[DEBUG] Transcript:', transcript); if (transcript) { userInput.value = transcript; sendMessage(); } };
            recognition.onerror = (event) => { console.error('[DEBUG] Mic Error:', event.error, event.message); let msg=`Mic error: ${event.error}`; if(event.error==='no-speech')msg='No speech detected.'; else if(event.error==='not-allowed'){msg='Mic access denied.'; if(!isSecureContext)msg+=' Needs HTTPS.';} else msg=`Mic error: ${event.message||event.error}`; displayError(msg); updateStatus('Mic Error', true); }; // Display error using notification
            recognition.onend = () => { console.log("[DEBUG] Recognition ended."); isListening = false; if(listenButton) listenButton.classList.remove('listening'); if (!assistantSpeaking && !statusTextElement?.dataset.error) updateStatus('SYSTEMS ONLINE'); if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused'; };
            console.log("[DEBUG] Speech Recognition initialized.");
        } catch (error) { console.error("[DEBUG] Failed to initialize SpeechRecognition:", error); if(listenButton){listenButton.disabled=true; listenButton.title='Mic init failed';} updateStatus('Mic Init Error', true); }
    }

     // --- Notification Function (Moved from HTML) ---
     function createNotification(title, message, type = 'info') { // type can be 'info' or 'error'
        // Remove existing notification to prevent overlap
        const existingNotification = document.querySelector('.notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        // Create new notification
        const notification = document.createElement('div');
        notification.className = 'notification'; // Base class
        if (type === 'error') {
             notification.classList.add('error'); // Add error class for styling
        }

        const notificationTitle = document.createElement('div');
        notificationTitle.className = 'notification-title';
        notificationTitle.textContent = title;

        const notificationMessage = document.createElement('div');
        notificationMessage.textContent = message;

        notification.appendChild(notificationTitle);
        notification.appendChild(notificationMessage);
        document.body.appendChild(notification); // Append to body to overlay

        // Trigger the animation
        requestAnimationFrame(() => {
             notification.classList.add('visible');
        });


        // Auto-remove notification after ~5 seconds
        setTimeout(() => {
            if (notification.parentNode) { // Check if it hasn't been removed already
                 notification.classList.remove('visible'); // Trigger fade out
                 // Remove from DOM after transition
                  notification.addEventListener('transitionend', () => notification.remove(), { once: true });
            }
        }, 5000);
    }

    // --- Event Listeners ---
    console.log("[DEBUG] Attaching event listeners...");
    if(sendButton) {
        sendButton.addEventListener('click', () => {
            console.log("[DEBUG] Execute button clicked!");
            sendMessage();
        });
        console.log("[DEBUG] Execute button listener attached.");
    } else { console.error("[DEBUG] Execute button element NOT found!"); }

    if(userInput) {
        userInput.addEventListener('keypress', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                console.log("[DEBUG] Enter key pressed in command input!");
                event.preventDefault();
                sendMessage();
            }
        });
         console.log("[DEBUG] Command input listener attached.");
    } else { console.error("[DEBUG] Command input element NOT found!"); }

    if(listenButton) {
        listenButton.addEventListener('click', () => {
            console.log("[DEBUG] Listen button clicked!");
            if (!supportsRecognition || !recognition) { createNotification("Mic Error", "Microphone not supported/initialized.", "error"); return; }
            if (isListening) { console.log("[DEBUG] Attempting to stop recognition..."); try { recognition.stop(); } catch (e) { console.error("[DEBUG] Err stop recognition:", e); isListening=false; listenButton.classList.remove('listening'); /*...*/ } }
            else { console.log("[DEBUG] Attempting to start recognition..."); if (!navigator.mediaDevices?.getUserMedia) { createNotification("Mic Error", "Mic access unavailable (needs HTTPS?).", "error"); updateStatus('Mic Access Error', true); return; }
                 navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { console.log("[DEBUG] Mic access granted."); try { /* clearError(); */ if(synth?.speaking) synth.cancel(); recognition.start(); } catch (e) { console.error("[DEBUG] Err start recognition:", e); createNotification("Mic Error",`Mic start error: ${e.message}`, "error"); updateStatus('Mic Start Error', true); isListening = false; } })
                     .catch(err => { console.error("[DEBUG] Mic access err:", err.name, err.message); let msg='Mic access denied.'; if(err.name==='NotFoundError')msg='No mic found.'; else if (err.name==='NotReadableError')msg='Mic busy/hardware error.'; else msg=`Mic access error: ${err.message}`; if (!isSecureContext && err.name==='NotAllowedError') msg+=' Needs HTTPS.'; createNotification("Mic Error", msg, "error"); updateStatus('Mic Access Denied', true); });
            }
        });
         console.log("[DEBUG] Listen button listener attached.");
    } else { console.error("[DEBUG] Listen button element NOT found!"); }

    // --- Integrate Static UI Listeners (Sidebar, Arc Reactor, Progress Bars) ---
    console.log("[DEBUG] Attaching static UI listeners...");
    // Animation for progress bars
    const progressBars = document.querySelectorAll('.progress-value');
    progressBars.forEach(bar => { const width = bar.style.width; bar.style.width = '0%'; setTimeout(() => { bar.style.width = width; }, 500); }); // Slightly longer delay

    // Menu item click (just shows notification for demo)
    const menuItems = document.querySelectorAll('.menu-item');
    menuItems.forEach(item => {
        item.addEventListener('click', function() {
            if (this.classList.contains('active')) return; // Don't do anything if already active
            menuItems.forEach(mi => mi.classList.remove('active'));
            this.classList.add('active');
            const menuText = this.querySelector('.menu-text')?.textContent || 'Section';
            createNotification('Navigation', 'Accessing: ' + menuText);
            // In a real app, you'd load different content into the .dashboard here
        });
    });

    // Arc reactor click (just shows notification)
    const arcReactor = document.getElementById('arc-reactor');
    if(arcReactor) {
        arcReactor.addEventListener('click', function() {
            createNotification('Arc Reactor Status', 'Power levels nominal. Running self-diagnostics...');
        });
        console.log("[DEBUG] Arc Reactor listener attached.");
    } else { console.warn("[DEBUG] Arc Reactor element not found."); }


    // --- Core Functions ---

    /** Clears the assistant output area */
    function clearAssistantOutputArea() {
        console.log("[DEBUG] Clearing assistant output area...");
        if (assistantOutputArea) {
            assistantOutputArea.innerHTML = '';
            if (mapInstance) { try { mapInstance.setTarget(null); } catch(e) {} mapInstance = null; console.log("[DEBUG] Cleared map instance ref."); }
        } else { console.error("[DEBUG] Assistant output area not found in clearAssistantOutputArea!"); }
    }

    /** Displays content (text, chart, map) in the main area */
    function displayContent({ text = null, chartData = null, mapData = null, userQuery = null }) {
        console.log("[DEBUG] Entering displayContent.");
        if (!assistantOutputArea) { console.error("[DEBUG] Assistant output area missing!"); displayError("UI Error: Output area missing."); return; }

        clearAssistantOutputArea(); // Clear previous assistant output

        // No user query display in this version - focus on assistant output

        let contentAdded = false;

        // 1. Display Assistant Text Response
        if (text) {
            console.log("[DEBUG] Preparing text content wrapper...");
            const textWrapper = document.createElement('div'); textWrapper.classList.add('content-wrapper'); textWrapper.id = 'response-text-area';
            let formattedText = text.replace(/</g,"<").replace(/>/g,">").replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>').replace(/\\n/g,'<br>');
            textWrapper.innerHTML = formattedText;
            assistantOutputArea.appendChild(textWrapper); console.log("[DEBUG] Text wrapper appended.");
            speakResponse(text); // Speak the text
            contentAdded = true;
        } else { console.log("[DEBUG] No text content to display."); }

        // 2. Display Chart
        if (chartData && supportsChartJS) {
            console.log("[DEBUG] Preparing chart wrapper...");
            const chartWrapper = document.createElement('div'); chartWrapper.classList.add('content-wrapper'); chartWrapper.id = 'chart-placeholder';
            assistantOutputArea.appendChild(chartWrapper); console.log("[DEBUG] Chart wrapper appended.");
            createDataVisualization(chartData, chartWrapper); // Pass wrapper
            contentAdded = true;
        } else if (chartData) console.warn("[DEBUG] Chart data received, but Chart.js unavailable.");

        // 3. Display Map
        if (mapData && supportsOpenLayers) {
             console.log("[DEBUG] Preparing map wrapper...");
             const mapWrapper = document.createElement('div'); mapWrapper.classList.add('content-wrapper'); mapWrapper.id = 'map-placeholder';
             assistantOutputArea.appendChild(mapWrapper); console.log("[DEBUG] Map wrapper appended.");
             createMapVisualization(mapData, mapWrapper); // Pass wrapper
             contentAdded = true;
        } else if (mapData) console.warn("[DEBUG] Map data received, but OpenLayers unavailable.");

        // Final check and scroll
        requestAnimationFrame(() => {
            if (!contentAdded) { console.warn("[DEBUG] displayContent finished, but no content was added!"); /* Maybe add fallback text */ }
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
        // Don't clear the *entire* dashboard, maybe just indicate loading in status
        updateStatus('Processing...'); // Main feedback is status text
        if (visualization) visualization.style.animationPlayState = 'running';
        if(sendButton) sendButton.disabled = true;
        if(listenButton) listenButton.disabled = true;
        if(userInput) userInput.disabled = true;
        // Optionally add a subtle loading overlay to the output area?
        if (assistantOutputArea) assistantOutputArea.style.opacity = '0.6';
    }

    /** Hides loading state */
    function hideLoadingIndicator() {
        if(assistantOutputArea) assistantOutputArea.style.opacity = '1'; // Restore opacity
        if (!assistantSpeaking && !isListening && !statusTextElement?.dataset.error) updateStatus('SYSTEMS ONLINE'); // Reset to default online status
        if (visualization && !assistantSpeaking && !isListening) visualization.style.animationPlayState = 'paused';
        if(sendButton) sendButton.disabled=false;
        if(listenButton) listenButton.disabled=!supportsRecognition||assistantSpeaking;
        if(userInput){userInput.disabled=false; try{userInput.focus();}catch(e){}}
    }

    /** Displays an error message using the notification system */
    function displayError(message) { // Persistent parameter removed, use notification timeout
        console.log(`[UI ERROR] ${message}`); // Log error clearly
        createNotification("Assistant Error", message, "error");
        updateStatus('Error Detected', true); // Update header status too
    }
    // Remove displayPersistentError and clearError as notification handles timeout

    /** Updates the status indicator text and state */
    function updateStatus(text, isError = false) {
        if(statusTextElement) {
            statusTextElement.textContent = text;
            if (isError) { statusTextElement.style.color = 'var(--error-color)'; statusTextElement.dataset.error = 'true'; if(statusDotElement) statusDotElement.style.backgroundColor = 'var(--error-color)';}
            else { statusTextElement.style.color = 'var(--text-secondary-color)'; delete statusTextElement.dataset.error; if(statusDotElement) statusDotElement.style.backgroundColor = '#4CAF50';}
        }
    }

    /** Sends the user's question to the backend */
    async function sendMessage() {
        const question = userInput?.value.trim(); if (!question || (sendButton && sendButton.disabled)) return;
        // Don't clear error notifications automatically on send, let them time out
        showLoadingIndicator(); // Update status, disable inputs
        console.log(`[DEBUG] sendMessage for question: "${question}"`);
        try {
            const response = await fetch('/ask', { method: 'POST', headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}, body: JSON.stringify({ question: question }) });
            console.log(`[DEBUG] Fetch status: ${response.status}`);
            const data = await response.json().catch(err => ({ error: `Invalid response (Status: ${response.status})` }));
            console.log("[DEBUG] Backend data:", data);

            if (!response.ok || (data && data.error)) { const errorMsg = `Error: ${data.error || response.statusText || 'Unknown'}`; console.error('[DEBUG] Server/App Error:', response.status, data); displayError(errorMsg); displayContent({ text: `Sorry, encountered an processing error.` }); } // Display simple error text
            else if (data && data.response) { console.log("[DEBUG] Valid response, calling displayContent..."); displayContent({ text: data.response, chartData: data.visualization_data, mapData: data.map_data }); } // displayContent handles speaking
            else { console.error('[DEBUG] Invalid success structure:', data); displayError('Unexpected response structure.'); displayContent({ text: 'Sorry, unexpected response.' }); }
        } catch (error) { console.error('[DEBUG] Network/Fetch Error:', error); const errorMsg = 'Network error reaching assistant.'; displayError(errorMsg); displayContent({ text: 'Sorry, trouble connecting.' }); }
        finally { console.log("[DEBUG] sendMessage finally."); if (supportsSynthesis && synth?.pending) setTimeout(hideLoadingIndicator, 200); else if (!assistantSpeaking) hideLoadingIndicator(); }
    } // End sendMessage

    /** Uses Speech Synthesis */
    function speakResponse(textToSpeak) { /* ... Keep existing unchanged ... */ }

    /** Scrolls the ASSISTANT OUTPUT area to the top */
    function scrollToTopOfOutput() {
        if(assistantOutputArea) {
            assistantOutputArea.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused';
    if(userInput) userInput.focus();
    clearAssistantOutputArea(); // Start with a clear output area
    updateStatus('SYSTEMS ONLINE'); // Set initial status
    // Initial greeting removed, user initiates interaction

    console.log("[DEBUG] Initial setup complete.");

}); // End DOMContentLoaded