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
    let currentAssistantMessageElement = null; // Track the text element for chart anchoring/speaking class
    let availableVoices = []; // Store loaded voices
    let selectedVoice = null; // Store the chosen voice object

    // --- Feature Detection ---
    const isSecureContext = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecognition = !!SpeechRecognition;
    const supportsSynthesis = !!synth;

    // --- Function to Load and Select Voices ---
    function loadAndSelectVoice() {
        if (!supportsSynthesis) { console.warn("Speech Synthesis not supported."); return; }
        availableVoices = synth.getVoices();
        console.log("Available Voices:", availableVoices.map(v => ({name: v.name, lang: v.lang, default: v.default, local: v.localService })));
        if (availableVoices.length > 0) {
            const targetLang = 'en-US'; const preferredNames = ['google us english', 'microsoft zira', 'samantha', 'female'];
            selectedVoice = availableVoices.find(v => v.lang === targetLang && preferredNames.some(n => v.name.toLowerCase().includes(n)) && !v.name.toLowerCase().includes('male')); // 1. Preferred Female
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && v.name.toLowerCase().includes('female') && !v.name.toLowerCase().includes('male')); // 2. Any Female
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang && !v.localService); // 3. Cloud (might be male)
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.lang === targetLang); // 4. First US
            if (!selectedVoice) selectedVoice = availableVoices.find(v => v.default); // 5. Default
            if (!selectedVoice && availableVoices.length > 0) selectedVoice = availableVoices[0]; // 6. Absolute first
            if (selectedVoice) console.log(`Selected Voice: ${selectedVoice.name} (Lang: ${selectedVoice.lang}, Local: ${selectedVoice.localService})`);
            else console.warn("Could not find a suitable voice. Using browser default.");
        } else console.warn("Voice list empty. Waiting for 'voiceschanged' event.");
    }

    // --- Initial Checks & Setup ---
    if (!isSecureContext && supportsRecognition) displayPersistentError("Warning: Mic may not work over HTTP.");
    if (!supportsRecognition) { if(listenButton){listenButton.disabled = true; listenButton.title = 'Mic not supported';} updateStatus('Mic not supported'); }
    if (!supportsSynthesis) console.warn('Speech Synthesis not supported.');
    else { loadAndSelectVoice(); if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = loadAndSelectVoice; }

    // --- Initialize Speech Recognition ---
    if (supportsRecognition) {
        recognition = new SpeechRecognition(); Object.assign(recognition, { continuous: false, lang: 'en-US', interimResults: false, maxAlternatives: 1 });
        recognition.onstart = () => { isListening = true; if(listenButton) listenButton.classList.add('listening'); updateStatus('Listening...'); if (visualization) visualization.style.animationPlayState = 'running'; clearError(); };
        recognition.onresult = (event) => { const transcript = event.results[event.results.length - 1][0].transcript.trim(); console.log('Transcript:', transcript); if (transcript) { userInput.value = transcript; sendMessage(); } };
        recognition.onerror = (event) => { console.error('Mic Error:', event.error, event.message); let msg = `Mic error: ${event.error}`; if (event.error === 'no-speech') msg = 'No speech detected.'; else if (event.error === 'audio-capture') msg = 'Mic capture failed.'; else if (event.error === 'not-allowed') {msg = 'Mic access denied.'; if (!isSecureContext) msg += ' Needs HTTPS.';} else msg = `Mic error: ${event.message || event.error}`; displayError(msg); updateStatus('Mic Error', true); };
        recognition.onend = () => { isListening = false; if(listenButton) listenButton.classList.remove('listening'); if (!assistantSpeaking && !statusIndicator.dataset.error) updateStatus('Idle'); if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused'; };
    }

    // --- Event Listeners ---
    if(sendButton) sendButton.addEventListener('click', sendMessage);
    if(userInput) userInput.addEventListener('keypress', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
    if(listenButton) listenButton.addEventListener('click', () => {
        if (!supportsRecognition) { displayError("Mic not supported."); return; }
        if (isListening) { try { recognition.stop(); } catch (e) { console.error("Err stop recognition:", e); isListening = false; listenButton.classList.remove('listening'); if (!assistantSpeaking && !statusIndicator.dataset.error) updateStatus('Idle'); if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused'; } }
        else {
            if (!navigator.mediaDevices?.getUserMedia) { displayError('Mic access unavailable (needs HTTPS?).'); updateStatus('Mic Access Error', true); return; }
            navigator.mediaDevices.getUserMedia({ audio: true }).then(() => { console.log("Mic access granted."); try { clearError(); if(synth?.speaking) synth.cancel(); recognition.start(); } catch (e) { console.error("Err start recognition:", e); displayError(`Mic start error: ${e.message}`); updateStatus('Mic Start Error', true); isListening = false; } })
                .catch(err => { console.error("Mic access err:", err.name, err.message); let msg = 'Mic access denied.'; if(err.name === 'NotFoundError') msg = 'No mic found.'; else if (err.name === 'NotReadableError') msg = 'Mic busy/hardware error.'; else msg = `Mic access error: ${err.message}`; if (!isSecureContext && err.name === 'NotAllowedError') msg += ' Needs HTTPS.'; displayError(msg); updateStatus('Mic Access Denied', true); });
        }
    });

    // --- Core Functions ---
    function addMessageToChat(sender, message, { isLoading = false, imageUrl = null } = {}) {
        const messageElement = document.createElement('div'); messageElement.classList.add('message', sender.toLowerCase());
        const sanitizedMessage = message.replace(/</g, "<").replace(/>/g, ">");
        messageElement.innerHTML = `<span>${sanitizedMessage}</span>`; if (isLoading) messageElement.classList.add('loading');
        let imgContainer = null;
        if (imageUrl) { imgContainer = document.createElement('div'); imgContainer.classList.add('holographic-image-container'); const img = document.createElement('img'); img.src = imageUrl; img.alt = "Assistant image"; img.classList.add('holographic-image'); img.onerror = () => { console.error("Img load failed:", imageUrl); imgContainer.innerHTML = '<span>[Image load error]</span>'; }; imgContainer.appendChild(img); messageElement.classList.add('contains-hologram'); }
        const existingLoading = chatbox.querySelector('.message.loading'); if (existingLoading) existingLoading.remove();
        chatbox.appendChild(messageElement); if (imgContainer) chatbox.appendChild(imgContainer);
        scrollToBottom(); return messageElement;
    }

    function createDataVisualization(vizData, anchorElement) {
        if (!vizData || !anchorElement || !Chart) { console.error("Chart.js unavailable, or missing vizData/anchorElement."); return; }
        if (vizData.type !== 'bar') { console.warn("Unhandled viz type:", vizData.type); return; }
        try {
            const canvasId = `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const chartContainer = document.createElement('div'); chartContainer.classList.add('chart-container');
            const canvas = document.createElement('canvas'); canvas.id = canvasId; chartContainer.appendChild(canvas);
            anchorElement.parentNode.insertBefore(chartContainer, anchorElement.nextSibling || null); // Insert after anchor
            const ctx = canvas.getContext('2d');
            new Chart(ctx, {
                type: 'bar', data: { labels: vizData.labels, datasets: vizData.datasets },
                options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: vizData.chart_title || 'Summary', color: '#ccd6f6', font: { size: 14 } }, tooltip: { backgroundColor: '#000' } }, scales: { y: { ticks: { color: '#ccd6f6', font: {size: 11}}, grid: { display: false } }, x: { beginAtZero: true, ticks: { color: '#ccd6f6' }, grid: { color: 'rgba(100, 255, 218, 0.15)' } } } }
            });
            console.log("Chart created:", canvasId); scrollToBottom();
        } catch (error) { console.error("Error creating chart:", error); if(chartContainer) chartContainer.innerHTML = "<span>[Viz Error]</span>"; }
    }

    function showLoadingIndicator() { addMessageToChat('Assistant', 'Processing', { isLoading: true }); updateStatus('Processing...'); if (visualization) visualization.style.animationPlayState = 'running'; if(sendButton) sendButton.disabled = true; if(listenButton) listenButton.disabled = true; if(userInput) userInput.disabled = true; }
    function hideLoadingIndicator() { const loadingIndicator = chatbox.querySelector('.message.loading'); if (loadingIndicator) loadingIndicator.remove(); if (!assistantSpeaking && !isListening && !statusIndicator?.dataset.error) updateStatus('Idle'); if (visualization && !assistantSpeaking && !isListening) visualization.style.animationPlayState = 'paused'; if(sendButton) sendButton.disabled = false; if(listenButton) listenButton.disabled = !supportsRecognition || assistantSpeaking; if(userInput) { userInput.disabled = false; userInput.focus(); }}
    function displayError(message, isPersistent = false) { if(errorMessageDiv) { errorMessageDiv.textContent = message; errorMessageDiv.style.display = 'block'; errorMessageDiv.dataset.persistent = String(isPersistent); if (!isPersistent) setTimeout(clearError, 7000); } else console.error("Error display DOM element missing.");}
    function displayPersistentError(message) { displayError(message, true); }
    function clearError() { if (errorMessageDiv && errorMessageDiv.dataset.persistent !== 'true') { errorMessageDiv.textContent = ''; errorMessageDiv.style.display = 'none'; }}
    function updateStatus(text, isError = false) { if(statusIndicator) { statusIndicator.textContent = text; if (isError) { statusIndicator.style.color = 'var(--error-color)'; statusIndicator.dataset.error = 'true'; } else { statusIndicator.style.color = '#8892b0'; delete statusIndicator.dataset.error; } } }

    async function sendMessage() {
        const question = userInput.value.trim(); if (!question || (sendButton && sendButton.disabled)) return;
        clearError(); addMessageToChat('User', question); userInput.value = ''; showLoadingIndicator();
        try {
            const response = await fetch('/ask', { method: 'POST', headers: {'Content-Type': 'application/json', 'Accept': 'application/json'}, body: JSON.stringify({ question: question }) });
            const data = await response.json().catch(err => ({ error: `Invalid response (Status: ${response.status})` }));
            if (!response.ok || (data && data.error)) { const errorMsg = `Error: ${data.error || response.statusText || 'Unknown'}`; console.error('Server/App Error:', response.status, data); displayError(errorMsg); addMessageToChat('Assistant', `Sorry, error processing.`); }
            else if (data && data.response) {
                currentAssistantMessageElement = addMessageToChat('Assistant', data.response, { imageUrl: data.image_url }); // Store ref to text bubble
                if (data.visualization_data) { createDataVisualization(data.visualization_data, currentAssistantMessageElement); } // Create chart after text
                speakResponse(data.response);
            } else { console.error('Invalid success structure:', data); displayError('Unexpected response structure.'); addMessageToChat('Assistant', 'Sorry, unexpected response.'); }
        } catch (error) { console.error('Network/Fetch Error:', error); const errorMsg = 'Network error reaching assistant.'; displayError(errorMsg); addMessageToChat('Assistant', 'Sorry, trouble connecting.'); }
        finally { if (supportsSynthesis && synth?.pending) setTimeout(hideLoadingIndicator, 200); else hideLoadingIndicator(); }
    }

    function speakResponse(textToSpeak) {
        if (!supportsSynthesis || !synth || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') { console.log("Speech skipped."); if(assistantSpeaking){ assistantSpeaking = false; if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking'); if (!isListening && !statusIndicator?.dataset.error) updateStatus('Idle'); if (visualization && !isListening) visualization.style.animationPlayState = 'paused'; if(listenButton) listenButton.disabled = !supportsRecognition; } return; }
        if (synth.speaking || synth.pending) { console.log("Cancelling previous speech."); synth.cancel(); if(assistantSpeaking){ assistantSpeaking = false; if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking');} }
        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        if (selectedVoice) { utterance.voice = selectedVoice; utterance.lang = selectedVoice.lang; console.log(`Using voice: ${selectedVoice.name} (${utterance.lang})`); }
        else { utterance.lang = 'en-US'; console.log(`Using default voice (Lang: ${utterance.lang}).`); }
        utterance.pitch = 1; utterance.rate = 1;
        utterance.onstart = () => { console.log("Speech started."); assistantSpeaking = true; updateStatus('Speaking...'); if (visualization) visualization.style.animationPlayState = 'running'; if (listenButton) listenButton.disabled = true; if (currentAssistantMessageElement) currentAssistantMessageElement.classList.add('speaking'); };
        utterance.onend = () => { console.log("Speech finished."); assistantSpeaking = false; if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking'); if (!isListening && !statusIndicator?.dataset.error) { updateStatus('Idle'); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; if(userInput) userInput.focus(); currentAssistantMessageElement = null; };
        utterance.onerror = (event) => { console.error('Speech error:', event.error, event); assistantSpeaking = false; if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking'); displayError(`Speech error: ${event.error}`); if (!isListening) { updateStatus('Speech Error', true); if (visualization) visualization.style.animationPlayState = 'paused'; } if (listenButton) listenButton.disabled = !supportsRecognition; currentAssistantMessageElement = null; };
        setTimeout(() => { if (synth) { console.log("Attempting synth.speak..."); synth.speak(utterance); } else console.error("Synth unavailable before speak."); }, 100);
    }

    function scrollToBottom() { if(chatbox) chatbox.scrollTo({ top: chatbox.scrollHeight, behavior: 'smooth' }); }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused';
    if(userInput) userInput.focus();

}); // End DOMContentLoaded