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
    let availableVoices = []; // To store loaded voices
    let selectedVoice = null; // To store the chosen voice object

    // --- Feature Detection ---
    const isSecureContext = window.isSecureContext;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supportsRecognition = !!SpeechRecognition;
    const supportsSynthesis = !!synth;

    // --- Function to Load and Select Voices ---
    function loadAndSelectVoice() {
        if (!supportsSynthesis) {
             console.warn("Speech Synthesis not supported, cannot select voice.");
             return;
        }

        availableVoices = synth.getVoices();
        console.log("Available Voices:", availableVoices.map(v => ({name: v.name, lang: v.lang, default: v.default, local: v.localService }))); // Log structured info

        if (availableVoices.length > 0) {
            // --- Voice Selection Logic (Prioritized) ---
            const targetLang = 'en-US'; // Target language

            // 1. Prioritize specific known high-quality female voices (adjust names based on testing)
            const preferredNames = ['google us english', 'microsoft zira', 'samantha', 'female']; // Lowercase for comparison
            selectedVoice = availableVoices.find(voice =>
                voice.lang === targetLang &&
                preferredNames.some(namePart => voice.name.toLowerCase().includes(namePart)) &&
                !voice.name.toLowerCase().includes('male') // Explicitly exclude male
            );

            // 2. Fallback: Any US English marked explicitly as Female (might catch more)
            if (!selectedVoice) {
                selectedVoice = availableVoices.find(voice =>
                    voice.lang === targetLang &&
                    voice.name.toLowerCase().includes('female') &&
                     !voice.name.toLowerCase().includes('male')
                );
            }

            // 3. Fallback: Any non-local US English (often higher quality cloud voices)
            //    This might select a male voice if no female cloud voice is found.
            if (!selectedVoice) {
                 selectedVoice = availableVoices.find(voice => voice.lang === targetLang && !voice.localService);
            }

            // 4. Fallback: First available US English voice (could be male or female)
            if (!selectedVoice) {
                selectedVoice = availableVoices.find(voice => voice.lang === targetLang);
            }

            // 5. Fallback: Browser's default voice
            if (!selectedVoice) {
                selectedVoice = availableVoices.find(voice => voice.default);
            }

             // 6. Fallback: Absolute first voice in the list
             if (!selectedVoice && availableVoices.length > 0) {
                 selectedVoice = availableVoices[0];
             }


            if (selectedVoice) {
                console.log(`Selected Voice: ${selectedVoice.name} (Lang: ${selectedVoice.lang}, Default: ${selectedVoice.default}, Local: ${selectedVoice.localService})`);
            } else {
                console.warn("Could not find any suitable voice. Using browser default if available.");
            }
        } else {
            console.warn("Voice list is currently empty. Waiting for 'voiceschanged' event or browser load.");
        }
    }

    // --- Initial Checks & Setup ---
    if (!isSecureContext && supportsRecognition) {
        console.warn("Not running in a secure context (HTTPS or localhost). Microphone access may be blocked.");
        displayPersistentError("Warning: Microphone may not work over non-secure connections (HTTP). Use HTTPS or localhost.");
    }
    if (!supportsRecognition) {
        console.warn('Speech Recognition API not supported in this browser.');
        if(listenButton) {
            listenButton.disabled = true;
            listenButton.title = 'Speech Recognition not supported';
        }
        updateStatus('Mic not supported');
    }
    if (!supportsSynthesis) {
        console.warn('Speech Synthesis API not supported in this browser.');
    } else {
        // Crucial: Voices might load async. Listen for the 'voiceschanged' event.
        // Attempt initial load. It might be empty initially.
        loadAndSelectVoice();
        // The 'voiceschanged' event fires when the voice list is populated or updated.
        if (speechSynthesis.onvoiceschanged !== undefined) {
            speechSynthesis.onvoiceschanged = loadAndSelectVoice;
        } else {
            console.warn("'onvoiceschanged' event not supported by this browser. Voice selection might be unreliable.");
            // Might need a timeout fallback here for older browsers, but less ideal
            // setTimeout(loadAndSelectVoice, 500);
        }
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
            if(listenButton) listenButton.classList.add('listening');
            updateStatus('Listening...');
            if (visualization) visualization.style.animationPlayState = 'running';
            clearError(); // Clear errors when listening starts successfully
        };

        recognition.onresult = (event) => {
            const transcript = event.results[event.results.length - 1][0].transcript.trim(); // Get last result
            console.log('Transcript:', transcript);
            if (transcript) {
                userInput.value = transcript;
                sendMessage(); // Automatically send after recognition
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
            else if (event.error === 'service-not-allowed') errorMsg = 'Speech recognition service unavailable/denied.';
            else errorMsg = `Mic error: ${event.message || event.error}`; // More generic

            displayError(errorMsg);
            updateStatus('Mic Error', true); // Mark status as error
        };

        recognition.onend = () => {
            isListening = false;
             if(listenButton) listenButton.classList.remove('listening');
            // Only reset status if not currently processing/speaking or already showing error
            if (!assistantSpeaking && !statusIndicator.dataset.error) {
                updateStatus('Idle');
            }
            // Pause visualization only if not speaking
            if (visualization && !assistantSpeaking) {
                visualization.style.animationPlayState = 'paused';
            }
        };
    } // End if (supportsRecognition)


    // --- Event Listeners ---
    if(sendButton) sendButton.addEventListener('click', sendMessage);

    if(userInput) userInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); // Prevent default form submission/newline
            sendMessage();
        }
    });

    if(listenButton) listenButton.addEventListener('click', () => {
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
                        clearError(); // Clear errors before starting
                        if(synth && synth.speaking) { // Stop assistant speaking if user interrupts with mic
                            console.log("User interrupting speech with microphone.");
                            synth.cancel();
                        }
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
                    if (err.name === 'NotAllowedError') errorMsg = 'Microphone permission denied by user or system.';
                    else if (err.name === 'NotFoundError') errorMsg = 'No microphone found. Ensure one is connected/enabled.';
                    else if (err.name === 'NotReadableError') errorMsg = 'Microphone is busy or hardware error occurred.';
                    else errorMsg = `Mic access error: ${err.message}`;
                    if (!isSecureContext && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
                        errorMsg += ' Access requires HTTPS or localhost.';
                    }
                    displayError(errorMsg);
                    updateStatus('Mic Access Denied', true);
                });
        }
    }); // End listenButton click


    // --- Core Functions ---

    /** Adds a message bubble to the chat interface. */
    function addMessageToChat(sender, message, { isLoading = false, imageUrl = null } = {}) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender.toLowerCase());

        // Basic sanitization to prevent HTML injection
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
            imgElement.alt = "Assistant generated image"; // Consider more descriptive alt text
            imgElement.classList.add('holographic-image');
            // Add error handling for broken images
            imgElement.onerror = () => {
                console.error("Failed to load image:", imageUrl);
                imgContainer.innerHTML = '<span>[Image failed to load]</span>'; // Replace with error text
            };
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
        if(sendButton) sendButton.disabled = true;
        if(listenButton) listenButton.disabled = true;
        if(userInput) userInput.disabled = true;
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
        // Pause visualization only if idle (not speaking or listening)
        if (visualization && !assistantSpeaking && !isListening) {
           visualization.style.animationPlayState = 'paused';
        }
        // Re-enable controls
        if(sendButton) sendButton.disabled = false;
        // Re-enable listen button only if supported and not currently speaking
        if(listenButton) listenButton.disabled = !supportsRecognition || assistantSpeaking;
        if(userInput) {
            userInput.disabled = false;
            userInput.focus();
        }
    }

    /** Displays an error message below the input area */
    function displayError(message, isPersistent = false) {
        if(errorMessageDiv) {
            errorMessageDiv.textContent = message;
            errorMessageDiv.style.display = 'block'; // Ensure visible
            errorMessageDiv.dataset.persistent = isPersistent;
            // Auto-hide non-persistent errors
            if (!isPersistent) {
                setTimeout(clearError, 7000); // Hide after 7 seconds
            }
        } else {
            console.error("Error display element not found in DOM.");
        }
    }

    /** Displays a persistent error that needs manual clearing or page reload */
    function displayPersistentError(message) {
        displayError(message, true);
    }

    /** Clears non-persistent error messages */
    function clearError() {
         if (errorMessageDiv && errorMessageDiv.dataset.persistent !== 'true') {
            errorMessageDiv.textContent = '';
            errorMessageDiv.style.display = 'none'; // Hide completely
        }
    }

    /** Updates the status indicator text and state */
    function updateStatus(text, isError = false) {
        if(statusIndicator) {
            statusIndicator.textContent = text;
            if (isError) {
                statusIndicator.style.color = 'var(--error-color)';
                statusIndicator.dataset.error = 'true'; // Mark as error state
            } else {
                statusIndicator.style.color = '#8892b0'; // Reset color
                delete statusIndicator.dataset.error; // Remove error state marker
            }
        }
    }


    /** Sends the user's question to the backend */
    async function sendMessage() {
        const question = userInput.value.trim();
        if (!question || (sendButton && sendButton.disabled)) return; // Prevent empty/double send

        clearError(); // Clear previous non-persistent errors
        addMessageToChat('User', question);
        userInput.value = ''; // Clear input after sending
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

            // Try to parse JSON, handle network errors or non-JSON responses
            const data = await response.json().catch(err => {
                console.error("Error parsing JSON response:", err, "Status:", response.status);
                return { error: `Server returned non-JSON or invalid response (Status: ${response.status} ${response.statusText})` };
            });

            // Check response status and if data contains an error property
            if (!response.ok || (data && data.error)) {
                const errorMsg = `Error: ${data.error || response.statusText || 'Unknown server error'}`;
                console.error('Server or Application Error:', response.status, data);
                displayError(errorMsg);
                // Add a generic error message to chat, don't speak server/app errors
                addMessageToChat('Assistant', `Sorry, I encountered an error processing that.`);
            } else if (data && data.response) {
                // Success case: Pass potential image URL and text response
                currentAssistantMessageElement = addMessageToChat('Assistant', data.response, { imageUrl: data.image_url }); // Store element ref
                speakResponse(data.response); // Speak the text response
            } else {
                 // Handle case where response is OK but structure is unexpected
                 console.error('Invalid success response structure:', data);
                 displayError('Received an unexpected response structure from the server.');
                 addMessageToChat('Assistant', 'Sorry, I received an unexpected response.');
            }

        } catch (error) {
            // Catch network errors (e.g., server down, CORS issues, DNS lookup failures)
            console.error('Network or Fetch Error:', error);
            const errorMsg = (error instanceof TypeError && error.message.includes('Failed to fetch'))
                           ? 'Network error: Could not reach the assistant server.'
                           : `Network error: ${error.message}`;
            displayError(errorMsg);
            addMessageToChat('Assistant', 'Sorry, I seem to be having trouble connecting to the server.');
        } finally {
            // Hide loading indicator. Use a small delay only if speech is likely starting.
             if (supportsSynthesis && synth && synth.pending) { // Check synth exists
                setTimeout(hideLoadingIndicator, 200);
             } else {
                hideLoadingIndicator();
             }
        }
    }

    /** Uses Speech Synthesis to speak the assistant's response */
    function speakResponse(textToSpeak) {
         // Check if synthesis is supported and text is valid
         if (!supportsSynthesis || !synth || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') {
             console.log("Speech synthesis skipped (not supported, synth unavailable, or empty text).");
             // Ensure UI state like 'speaking' is reset if speech is skipped unexpectedly
             if(assistantSpeaking) {
                 assistantSpeaking = false;
                 if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking');
                 if (!isListening && !statusIndicator.dataset.error) updateStatus('Idle');
                 if (visualization && !isListening) visualization.style.animationPlayState = 'paused';
                 if (listenButton) listenButton.disabled = !supportsRecognition; // Re-enable mic
             }
             return;
         }

        // Cancel previous speech if it's ongoing or pending
        if (synth.speaking || synth.pending) {
            console.log("Cancelling previous/pending speech utterance.");
            synth.cancel();
            // Manually reset visual state related to speaking if cancel() doesn't trigger onend quickly
            if(assistantSpeaking) {
                 assistantSpeaking = false;
                 if (currentAssistantMessageElement) currentAssistantMessageElement.classList.remove('speaking');
                 // Don't reset status/vis yet, as new speech will start immediately
            }
        }

        const utterance = new SpeechSynthesisUtterance(textToSpeak);

        // *** === Apply the Selected Voice === ***
        if (selectedVoice) {
            utterance.voice = selectedVoice;
            utterance.lang = selectedVoice.lang; // Ensure lang matches the voice
             console.log(`Using voice: ${selectedVoice.name} (${utterance.lang})`);
        } else {
            // Attempt to set language even if using default voice
            utterance.lang = 'en-US';
            console.log(`Using default browser voice (Attempting lang: ${utterance.lang}).`);
        }
        // *** ================================ ***

        // Optional: Adjust pitch and rate for effect
        utterance.pitch = 1; // Range: 0 to 2 (default 1)
        utterance.rate = 1; // Range: 0.1 to 10 (default 1)

        utterance.onstart = () => {
            console.log("Speech synthesis started.");
            assistantSpeaking = true;
            updateStatus('Speaking...');
            if (visualization) visualization.style.animationPlayState = 'running';
            if (listenButton) listenButton.disabled = true; // Disable mic while speaking
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
            // Re-enable mic only if supported
            if (listenButton) listenButton.disabled = !supportsRecognition;
            if(userInput) userInput.focus(); // Refocus input after speaking
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
             if (listenButton) listenButton.disabled = !supportsRecognition; // Re-enable mic
            currentAssistantMessageElement = null; // Clear reference
        };

        // Use a small delay before speaking to help avoid browser race conditions/glitches,
        // especially after cancelling previous speech.
        setTimeout(() => {
             if (synth) { // Check if synth still exists
                 console.log("Attempting to speak utterance...");
                 synth.speak(utterance);
             } else {
                 console.error("Speech synthesis object became unavailable before speaking.");
             }
        }, 100); // Increased delay slightly

    } // End speakResponse

    /** Scrolls the chatbox to the bottom */
    function scrollToBottom() {
        if(chatbox) {
            // Use smooth scrolling for better UX
            chatbox.scrollTo({ top: chatbox.scrollHeight, behavior: 'smooth' });
        }
    }

    // --- Initial Page Load Setup ---
    if (visualization) visualization.style.animationPlayState = 'paused'; // Ensure vis starts paused
    if(userInput) userInput.focus();
    // Optional: Initial greeting message
    // addMessageToChat('Assistant', 'Hello! How can I assist you today?');
    // Optional: Speak initial greeting (wait a bit for voices to potentially load)
    // setTimeout(() => speakResponse("Hello! How can I assist you today?"), 750);

}); // End DOMContentLoaded