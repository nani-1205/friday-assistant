// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    const chatbox = document.getElementById('chatbox');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const listenButton = document.getElementById('listen-button');
    const statusIndicator = document.getElementById('status-indicator');
    const visualization = document.getElementById('ai-visualization').querySelector('.pulse-ring'); // Target pulse ring directly
    const errorMessageDiv = document.getElementById('error-message');

    let recognition = null;
    let isListening = false;
    let synth = window.speechSynthesis;
    let assistantSpeaking = false;

    // --- Check for HTTPS/Secure Context ---
    const isSecureContext = window.isSecureContext; // Check if browser considers context secure (HTTPS or localhost)
    if (!isSecureContext) {
        console.warn("Not running in a secure context (HTTPS or localhost). Microphone access (getUserMedia) will likely be blocked by the browser.");
        // Optionally display a persistent warning to the user on the page
         displayError("Warning: Microphone may not work over non-secure connections (HTTP). Use HTTPS or localhost.", true); // Make it persistent
    }


    // --- Initialize Speech Recognition ---
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.continuous = false; // Process single utterances
        recognition.lang = 'en-US';
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;

        recognition.onstart = () => {
            isListening = true;
            listenButton.classList.add('listening');
            statusIndicator.textContent = 'Listening...';
            visualization.style.animationPlayState = 'running'; // Ensure animation runs
            clearError(); // Clear errors when listening starts
        };

        recognition.onresult = (event) => {
            const transcript = event.results[event.results.length - 1][0].transcript.trim(); // Get last result
            console.log('Transcript:', transcript);
            if (transcript) {
                userInput.value = transcript;
                // Consider adding a small delay or visual cue before sending?
                sendMessage(); // Automatically send after recognition
            }
        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            let errorMsg = `Speech recognition error: ${event.error}`;
            if (event.error === 'no-speech') {
                errorMsg = 'No speech detected. Please try again.';
            } else if (event.error === 'audio-capture') {
                errorMsg = 'Microphone error. Check if another app is using it.';
            } else if (event.error === 'not-allowed') {
                errorMsg = 'Microphone access denied. Please allow access in browser settings.';
                 // Also check secure context again here
                 if (!isSecureContext) {
                    errorMsg += ' Access requires HTTPS or localhost.';
                 }
            } else if (event.error === 'network') {
                 errorMsg = 'Network error during speech recognition.';
            } else if (event.error === 'service-not-allowed') {
                 errorMsg = 'Speech recognition service denied. Check browser/OS settings.';
            }
             displayError(errorMsg);
            statusIndicator.textContent = 'Mic Error';
        };

        recognition.onend = () => {
            isListening = false;
            listenButton.classList.remove('listening');
             // Only reset status if not currently processing/speaking
            if (!assistantSpeaking && statusIndicator.textContent !== 'Mic Error') { // Avoid overwriting error status
                statusIndicator.textContent = 'Idle';
            }
             visualization.style.animationPlayState = 'paused'; // Pause animation
        };

    } else {
        console.warn('Speech Recognition API not supported in this browser.');
        listenButton.disabled = true;
        listenButton.title = 'Speech Recognition not supported';
        statusIndicator.textContent = 'Mic not supported';
    }

    // --- Event Listeners ---
    sendButton.addEventListener('click', sendMessage);

    userInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) { // Allow shift+enter for newlines if needed
            event.preventDefault(); // Prevent default form submission/newline
            sendMessage();
        }
    });

    listenButton.addEventListener('click', () => {
        if (!recognition) {
            displayError("Speech recognition not supported by this browser.");
            return;
        }

        if (isListening) {
            try {
                recognition.stop();
            } catch (e) {
                 console.error("Error stopping recognition:", e);
                 // Force reset state if stop fails unexpectedly
                 isListening = false;
                 listenButton.classList.remove('listening');
                 statusIndicator.textContent = 'Idle';
                 visualization.style.animationPlayState = 'paused';
            }

        } else {
             // --- ADDED CHECK for mediaDevices ---
             if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                 console.error('navigator.mediaDevices.getUserMedia not available.');
                 displayError('Microphone access (getUserMedia) is not available. Ensure you are using HTTPS or localhost.');
                 statusIndicator.textContent = 'Mic Access Error';
                 return; // Stop here if getUserMedia doesn't exist
             }
             // --- END ADDED CHECK ---

             // Request microphone permission explicitly
             navigator.mediaDevices.getUserMedia({ audio: true })
                 .then(() => {
                     console.log("Microphone access granted.");
                     try {
                         clearError(); // Clear previous errors
                         recognition.start();
                     } catch (e) {
                         // Handle edge case where start() fails immediately
                         console.error("Error starting recognition:", e);
                         displayError(`Error starting microphone: ${e.message}`);
                         statusIndicator.textContent = 'Mic Start Error';
                         listenButton.classList.remove('listening');
                         isListening = false;
                          visualization.style.animationPlayState = 'paused';
                     }
                 })
                 .catch(err => {
                     console.error("Microphone access denied or error:", err.name, err.message);
                     let errorMsg = 'Microphone access denied.';
                     if(err.name === 'NotAllowedError') {
                        errorMsg = 'Microphone permission denied. Please allow access in browser settings.';
                     } else if (err.name === 'NotFoundError') {
                         errorMsg = 'No microphone found. Please ensure one is connected and enabled.';
                     } else if (err.name === 'NotReadableError') {
                         errorMsg = 'Microphone is busy or hardware error occurred.';
                     } else {
                        errorMsg = `Error accessing microphone: ${err.message}`;
                     }
                      // Add HTTPS hint if relevant
                     if (!isSecureContext && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
                         errorMsg += ' Access requires HTTPS or localhost.';
                     }
                      displayError(errorMsg);
                     statusIndicator.textContent = 'Mic Access Denied';
                 });
        }
    });


    // --- Core Functions ---

    function addMessageToChat(sender, message, isLoading = false) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender.toLowerCase());

        // Simple sanitization (consider a library like DOMPurify for production)
        const sanitizedMessage = message.replace(/</g, "<").replace(/>/g, ">");

        messageElement.innerHTML = `<span>${sanitizedMessage}</span>`;

        if (isLoading) {
            messageElement.classList.add('loading');
        }

        // Remove previous loading indicator *before* adding new message/indicator
        const existingLoading = chatbox.querySelector('.message.loading');
        if (existingLoading) {
            existingLoading.remove();
        }

        chatbox.appendChild(messageElement);
        scrollToBottom();
        return messageElement;
    }

    function showLoadingIndicator() {
         addMessageToChat('Assistant', 'Thinking', true); // Pass loading flag
         statusIndicator.textContent = 'Processing...';
         visualization.style.animationPlayState = 'running';
         sendButton.disabled = true;
         listenButton.disabled = true; // Disable mic while processing
         userInput.disabled = true;
    }

    function hideLoadingIndicator() {
         const loadingIndicator = chatbox.querySelector('.message.loading');
         if (loadingIndicator) {
             loadingIndicator.remove();
         }
         // Reset status only if not speaking or listening or showing mic error
         if (!assistantSpeaking && !isListening && !statusIndicator.textContent.includes('Error')) {
            statusIndicator.textContent = 'Idle';
         }
         if (!assistantSpeaking && !isListening) { // Pause animation if idle
            visualization.style.animationPlayState = 'paused';
         }
         sendButton.disabled = false;
         // Re-enable listen button only if supported and not currently speaking
         listenButton.disabled = !recognition || assistantSpeaking;
         userInput.disabled = false;
         userInput.focus();
    }

     function displayError(message, persistent = false) {
        errorMessageDiv.textContent = message;
        errorMessageDiv.style.display = 'block';
        errorMessageDiv.dataset.persistent = persistent; // Mark if it should persist
        // Automatically hide non-persistent errors after a delay
        if (!persistent) {
            setTimeout(clearError, 7000); // Hide after 7 seconds
        }
     }

     function clearError() {
         // Only clear if the message is not marked as persistent
        if (errorMessageDiv.dataset.persistent !== 'true') {
            errorMessageDiv.textContent = '';
            errorMessageDiv.style.display = 'none';
            delete errorMessageDiv.dataset.persistent;
        }
     }

    async function sendMessage() {
        const question = userInput.value.trim();
        if (!question || sendButton.disabled) return; // Prevent sending empty or while disabled

        clearError(); // Clear previous non-persistent errors
        addMessageToChat('User', question);
        userInput.value = '';
        showLoadingIndicator();

        try {
            const response = await fetch('/ask', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json', // Good practice to accept JSON
                },
                body: JSON.stringify({ question: question }),
            });

            // Get response data regardless of status for error checking
            const data = await response.json().catch(err => {
                console.error("Error parsing JSON response:", err);
                // Create a synthetic error object if JSON parsing fails
                return { error: `Invalid response format from server (Status: ${response.status})` };
            });


            if (!response.ok) {
                 console.error('Server Error:', response.status, data);
                 const errorMsg = `Error: ${data.error || response.statusText || 'Unknown server error'}`;
                 displayError(errorMsg);
                 addMessageToChat('Assistant', `Sorry, I encountered an error processing that.`);
                 // Don't speak server errors
            } else {
                 if (data.error) { // Handle cases where API returns 200 OK but contains an error field
                     console.error('Application Error:', data.error);
                     displayError(`Assistant Error: ${data.error}`);
                     addMessageToChat('Assistant', `Sorry, there was an issue: ${data.error}`);
                 } else if (data.response) {
                     const assistantMessageElement = addMessageToChat('Assistant', data.response);
                     speakResponse(data.response, assistantMessageElement); // Speak the valid response
                 } else {
                      console.error('Invalid success response structure:', data);
                      displayError('Received an unexpected response structure from the assistant.');
                      addMessageToChat('Assistant', 'Sorry, I received an unexpected response.');
                 }
            }
        } catch (error) {
            console.error('Network or Fetch Error:', error);
            displayError(`Network error: ${error.message}. Could not reach the assistant.`);
            addMessageToChat('Assistant', 'Sorry, I seem to be having trouble connecting.');
            // Don't speak network errors
        } finally {
             // Ensure loading indicator is hidden and input re-enabled
             // Use a small timeout only if speech synthesis might start immediately
             // Otherwise, hide directly for faster UI feedback
             if (synth && synth.pending) { // If speech might start soon
                setTimeout(hideLoadingIndicator, 200);
             } else {
                hideLoadingIndicator();
             }
        }
    }

    function speakResponse(textToSpeak, messageElement) {
         if (!synth || !textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.trim() === '') {
             console.log("Speech synthesis skipped (no synth, empty text, or not speaking).");
             // Ensure UI resets correctly if speech is skipped
             hideLoadingIndicator(); // Call hide again to ensure correct state if speech was expected
             return;
         }

         // Cancel any previous speech
        if (synth.speaking || synth.pending) {
            console.log("Cancelling previous speech utterance.");
            synth.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.lang = 'en-US'; // Or detect language if needed

        // Optional: Try to find a preferred voice
        // let voices = synth.getVoices();
        // if (voices.length > 0) {
        //     utterance.voice = voices.find(v => v.name.includes('Google') && v.lang === 'en-US') || voices.find(v => v.lang === 'en-US') || voices[0];
        // }

        utterance.onstart = () => {
            console.log("Speech synthesis started.");
            assistantSpeaking = true;
             statusIndicator.textContent = 'Speaking...';
             visualization.style.animationPlayState = 'running';
             listenButton.disabled = true; // Disable mic while speaking
            if(messageElement) messageElement.classList.add('speaking');
        };

        utterance.onend = () => {
            console.log("Speech synthesis finished.");
            assistantSpeaking = false;
            if(messageElement) messageElement.classList.remove('speaking');
            // Reset status only if not currently listening
            if (!isListening) {
                 statusIndicator.textContent = 'Idle';
                 visualization.style.animationPlayState = 'paused';
                 listenButton.disabled = !recognition; // Re-enable mic if supported
            }
            userInput.focus(); // Refocus input after speaking
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event.error);
             assistantSpeaking = false;
             if(messageElement) messageElement.classList.remove('speaking');
             displayError(`Speech synthesis error: ${event.error}`);
             // Reset status only if not currently listening
             if (!isListening) {
                 statusIndicator.textContent = 'Speech Error';
                 visualization.style.animationPlayState = 'paused';
                 listenButton.disabled = !recognition; // Re-enable mic if supported
             }
        };

        // Small delay before speaking can sometimes help avoid glitches
        setTimeout(() => {
             console.log("Attempting to speak...");
             synth.speak(utterance);
        }, 50); // 50ms delay
    }


    function scrollToBottom() {
        // Use smooth scrolling for better UX
        chatbox.scrollTo({ top: chatbox.scrollHeight, behavior: 'smooth' });
    }

    // --- Initial Setup ---
    userInput.focus();
    visualization.style.animationPlayState = 'paused'; // Start with animation paused
    // Optional: Greet user via speech if supported
    // setTimeout(() => speakResponse("Hello! How can I assist you today?"), 500);

});