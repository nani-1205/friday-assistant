// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    const chatbox = document.getElementById('chatbox');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const listenButton = document.getElementById('listen-button');
    const statusIndicator = document.getElementById('status-indicator');
    // Target the pulse-ring div specifically if the outer container doesn't animate
    const visualization = document.getElementById('ai-visualization')?.querySelector('.pulse-ring');
    const errorMessageDiv = document.getElementById('error-message');

    // --- State Variables ---
    let recognition = null;
    let isListening = false;
    let synth = window.speechSynthesis;
    let assistantSpeaking = false;
    let currentAssistantMessageElement = null; // Track the element being spoken

    // --- Feature Detection ---
    const isSecureContext = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecognition = !!SpeechRecognition;
    const supportsSynthesis = !!synth;

    // --- Initial Checks & Setup ---
    if (!isSecureContext && supportsRecognition) {
        console.warn("Not running in a secure context (HTTPS or localhost). Microphone access may be blocked.");
        displayPersistentError("Warning: Microphone may not work over non-secure connections (HTTP). Use HTTPS or localhost.");
    }
    if (!supportsRecognition) {
        console.warn('Speech Recognition API not supported in this browser.');
        listenButton.disabled = true;
        listenButton.title = 'Speech Recognition not supported';
        updateStatus('Mic not supported');
    }
    if (!supportsSynthesis) {
        console.warn('Speech Synthesis API not supported in this browser.');
    }

    // --- Initialize Speech Recognition ---
    if (supportsRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.lang = 'en-US';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
            isListening = true;
            listenButton.classList.add('listening');
            updateStatus('Listening...');
            if (visualization) visualization.style.animationPlayState = 'running';
            clearError();
        };

        recognition.onresult = (event) => {
            const transcript = event.results[event.results.length - 1][0].transcript.trim();
            console.log('Transcript:', transcript);
            if (transcript) {
                userInput.value = transcript;
                sendMessage(); // Send recognized text
            }
        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error, event.message);
            let errorMsg = `Mic error: ${event.error}`;
            if (event.error === 'no-speech') errorMsg = 'No speech detected. Please try again.';
            else if (event.error === 'audio-capture') errorMsg = 'Microphone error (capture failed).';
            else if (event.error === 'not-allowed') {
                errorMsg = 'Microphone access denied.';
                if (!isSecureContext) errorMsg += ' Requires HTTPS/localhost.';
            }
            else if (event.error === 'network') errorMsg = 'Network error during speech recognition.';
            else if (event.error === 'service-not-allowed') errorMsg = 'Speech recognition service unavailable.';
            else errorMsg = `Mic error: ${event.message || event.error}`; // More generic

            displayError(errorMsg);
            updateStatus('Mic Error', true); // Mark status as error
        };

        recognition.onend = () => {
            isListening = false;
            listenButton.classList.remove('listening');
            // Only reset status if not currently processing/speaking or already showing error
            if (!assistantSpeaking && !statusIndicator.dataset.error) {
                updateStatus('Idle');
            }
            if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused';
        };
    }

    // --- Event Listeners ---
    sendButton.addEventListener('click', sendMessage);

    userInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    listenButton.addEventListener('click', () => {
        if (!supportsRecognition) {
            displayError("Speech recognition not supported by this browser.");
            return;
        }

        if (isListening) { // Stop listening
            try {
                recognition.stop();
                 // onend will handle state changes
            } catch (e) { // Handle rare case where stop fails
                 console.error("Error stopping recognition:", e);
                 isListening = false; // Force reset state
                 listenButton.classList.remove('listening');
                 if (!assistantSpeaking && !statusIndicator.dataset.error) updateStatus('Idle');
                 if (visualization && !assistantSpeaking) visualization.style.animationPlayState = 'paused';
            }
        } else { // Start listening
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                console.error('getUserMedia not supported or not available (insecure context?).');
                displayError('Microphone access (getUserMedia) unavailable. Use HTTPS or localhost.');
                updateStatus('Mic Access Error', true);
                return;
            }
            // Check/Request microphone permission
            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(() => {
                    console.log("Microphone access granted/verified.");
                    try {
                        clearError();
                        if(synth && synth.speaking) synth.cancel(); // Stop speaking if user interrupts with mic
                        recognition.start();
                    } catch (e) {
                        console.error("Error starting recognition:", e);
                        displayError(`Error starting microphone: ${e.message}`);
                        updateStatus('Mic Start Error', true);
                        isListening = false; // Ensure state is reset
                    }
                })
                .catch(err => {
                    console.error("Microphone access denied or error:", err.name, err.message);
                    let errorMsg = 'Microphone access denied.';
                    if (err.name === 'NotAllowedError') errorMsg = 'Microphone permission denied.';
                    else if (err.name === 'NotFoundError') errorMsg = 'No microphone found.';
                    else if (err.name === 'NotReadableError') errorMsg = 'Microphone busy or hardware error.';
                    else errorMsg = `Mic access error: ${err.message}`;
                    if (!isSecureContext) errorMsg += ' Requires HTTPS/localhost.';
                    displayError(errorMsg);
                    updateStatus('Mic Access Denied', true);
                });
        }
    });

    // --- Core Functions ---

    /** Adds a message bubble to the chat interface. */
    function addMessageToChat(sender, message, { isLoading = false, imageUrl = null } = {}) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender.toLowerCase());

        const sanitizedMessage = message.replace(/</g, "<").replace(/>/g, ">");

        // Always wrap text in a span for styling consistency and ::after pseudo-elements
        messageElement.innerHTML = `<span>${sanitizedMessage}</span>`;

        if (isLoading) {
            messageElement.classList.add('loading'); // Trigger CSS loading animation
        }

        // Handle image display if URL provided
        let imgContainer = null;
        if (imageUrl) {
            imgContainer = document.createElement('div');
            imgContainer.classList.add('holographic-image-container');
            const imgElement = document.createElement('img');
            imgElement.src = imageUrl;
            imgElement.alt = "Assistant generated image"; // Consider more descriptive alt text if possible
            imgElement.classList.add('holographic-image');
            imgContainer.appendChild(imgElement);
            messageElement.classList.add('contains-hologram'); // Style parent bubble
        }

        // Remove previous loading indicator *before* adding new message/indicator
        const existingLoading = chatbox.querySelector('.message.loading');
        if (existingLoading) {
            existingLoading.remove();
        }

        chatbox.appendChild(messageElement);
        // Append image container *after* the message text bubble if it exists
        if (imgContainer) {
            chatbox.appendChild(imgContainer);
        }

        scrollToBottom();
        return messageElement; // Return the text message element for speaking reference
    }

     /** Displays loading state in UI */
    function showLoadingIndicator() {
        // Use a neutral base text; animation is handled by CSS
        addMessageToChat('Assistant', 'Processing', { isLoading: true });
        updateStatus('Processing...');
        if (visualization) visualization.style.animationPlayState = 'running';
        // Disable controls
        sendButton.disabled = true;
        listenButton.disabled = true;
        userInput.disabled = true;
    }

    /** Hides loading state and re-enables controls */
    function hideLoadingIndicator() {
        const loadingIndicator = chatbox.querySelector('.message.loading');
        if (loadingIndicator) {
            loadingIndicator.remove();
        }
        // Reset status only if not speaking, listening, or showing error
        if (!assistantSpeaking && !isListening && !statusIndicator.dataset.error) {
           updateStatus('Idle');
        }
        if (visualization && !assistantSpeaking && !isListening) { // Pause vis if idle
           visualization.style.animationPlayState = 'paused';
        }
        // Re-enable controls
        sendButton.disabled = false;
        listenButton.disabled = !supportsRecognition || assistantSpeaking; // Also disable if speaking
        userInput.disabled = false;
        userInput.focus();
    }

    /** Displays an error message below the input area */
    function displayError(message, isPersistent = false) {
        errorMessageDiv.textContent = message;
        errorMessageDiv.style.display = 'block'; // Ensure visible
        errorMessageDiv.dataset.persistent = isPersistent;
        // Auto-hide non-persistent errors
        if (!isPersistent) {
            setTimeout(clearError, 7000); // Hide after 7 seconds
        }
    }

    /** Displays a persistent error that needs manual clearing or page reload */
    function displayPersistentError(message) {
        displayError(message, true);
    }

    /** Clears non-persistent error messages */
    function clearError() {
        if (errorMessageDiv.dataset.persistent !== 'true') {
            errorMessageDiv.textContent = '';
            errorMessageDiv.style.display = 'none'; // Hide completely
        }
    }

    /** Updates the status indicator text */
    function updateStatus(text, isError = false) {
        statusIndicator.textContent = text;
        if (isError) {
            statusIndicator.style.color = 'var(--error-color)';
            statusIndicator.dataset.error = 'true'; // Mark as error state
        } else {
            statusIndicator.style.color = '#8892b0'; // Reset color
            delete statusIndicator.dataset.error; // Remove error state marker
        }
    }


    /** Sends the user's question to the backend */
    async function sendMessage() {
        const question = userInput.value.trim();
        if (!question || sendButton.disabled) return; // Prevent empty/double send

        clearError(); // Clear previous non-persistent errors
        addMessageToChat('User', question);
        userInput.value = '';
        showLoadingIndicator();

        try {
            const response = await fetch('/ask', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({ question: question }),
            });

            const data = await response.json().catch(err => {
                console.error("Error parsing JSON response:", err);
                // Network errors or non-JSON responses end up here
                return { error: `Server returned non-JSON response (Status: ${response.status})` };
            });

            if (!response.ok || data.error) {
                const errorMsg = `Error: ${data.error || response.statusText || 'Unknown server error'}`;
                console.error('Server/Application Error:', response.status, data);
                displayError(errorMsg);
                // Add a generic error message to chat, don't speak it
                addMessageToChat('Assistant', `Sorry, I encountered an error processing that.`);
            } else if (data.response) {
                // Pass potential image URL to addMessageToChat
                currentAssistantMessageElement = addMessageToChat('Assistant', data.response, { imageUrl: data.image_url }); // Store element ref
                speakResponse(data.response); // Speak the text response
            } else {
                 console.error('Invalid success response structure:', data);
                 displayError('Received an unexpected response structure.');
                 addMessageToChat('Assistant', 'Sorry, I received an unexpected response.');
            }

        } catch (error) {
            console.error('Network or Fetch Error:', error);
            const errorMsg = (error instanceof TypeError && error.message.includes('Failed to fetch'))
                           ? 'Network error. Could not reach the assistant.'
                           : `Network error: ${error.message}`;
            displayError(errorMsg);
            addMessageToChat('Assistant', 'Sorry, I seem to be having trouble connecting.');
        } finally {
            // Use timeout only if speech is likely starting, otherwise hide immediately
             if (supportsSynthesis && synth.pending) {
                setTimeout(hideLoadingIndicator, 200);
             } else {
                hideLoadingIndicator();
             }
        }
    }

    /** Uses Speech Synthesis to speak the assistant's response */
    function speakResponse(textToSpeak) {
         if (!supportsSynthesis || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') {
             console.log("Speech synthesis skipped (no synth, empty text, or not speaking).");
             // Ensure UI updates correctly even if speech skipped
             if(assistantSpeaking) { // If we thought we were speaking but aren't now
                 assistantSpeaking = false;
                 if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking');
                 if (!isListening && !statusIndicator.dataset.error) updateStatus('Idle');
                 if (visualization && !isListening) visualization.style.animationPlayState = 'paused';
                 listenButton.disabled = !supportsRecognition; // Re-enable mic
             }
             return;
         }

        // Cancel previous speech if any
        if (synth.speaking || synth.pending) {
            console.log("Cancelling previous/pending speech.");
            synth.cancel();
            // Manually reset state if cancel doesn't trigger onend quickly enough
            if(assistantSpeaking) {
                 assistantSpeaking = false;
                 if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking');
                 // Don't reset status/vis yet, new speech starting
            }
        }

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.lang = 'en-US'; // Or detect dynamically if needed

        utterance.onstart = () => {
            console.log("Speech synthesis started.");
            assistantSpeaking = true;
            updateStatus('Speaking...');
            if (visualization) visualization.style.animationPlayState = 'running';
            listenButton.disabled = true; // Disable mic while speaking
            if (currentAssistantMessageElement) currentAssistantMessageElement.classList.add('speaking');
        };

        utterance.onend = () => {
            console.log("Speech synthesis finished.");
            assistantSpeaking = false;
            if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking');
            // Reset status only if not listening or showing error
            if (!isListening && !statusIndicator.dataset.error) {
                 updateStatus('Idle');
                 if (visualization) visualization.style.animationPlayState = 'paused';
            }
            listenButton.disabled = !supportsRecognition; // Re-enable mic
            userInput.focus();
            currentAssistantMessageElement = null; // Clear reference
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event.error, event);
            assistantSpeaking = false;
            if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking');
            displayError(`Speech synthesis error: ${event.error}`);
             // Reset status only if not listening
            if (!isListening) {
                 updateStatus('Speech Error', true);
                 if (visualization) visualization.style.animationPlayState = 'paused';
            }
            listenButton.disabled = !supportsRecognition; // Re-enable mic
            currentAssistantMessageElement = null; // Clear reference
        };

        // Use a small delay before speaking to help avoid browser race conditions/glitches
        setTimeout(() => {
             console.log("Attempting to speak utterance...");
             synth.speak(utterance);
        }, 50);
    }

    /** Scrolls the chatbox to the bottom */
    function scrollToBottom() {
        // Use smooth scrolling for better UX
        chatbox.scrollTo({ top: chatbox.scrollHeight, behavior: 'smooth' });
    }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused'; // Ensure vis starts paused
    userInput.focus();
    // Optional: Initial greeting message
    // addMessageToChat('Assistant', 'Hello! How can I assist you today?');
    // Optional: Speak initial greeting
    // setTimeout(() => speakResponse("Hello! How can I assist you today?"), 500);

}); // End DOMContentLoaded