// static/js/script.js
document.addEventListener('DOMContentLoaded', () => {
    const chatbox = document.getElementById('chatbox');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const listenButton = document.getElementById('listen-button');
    const statusIndicator = document.getElementById('status-indicator');
    const visualization = document.getElementById('ai-visualization');
    const errorMessageDiv = document.getElementById('error-message');

    let recognition = null;
    let isListening = false;
    let synth = window.speechSynthesis;
    let assistantSpeaking = false;

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
            visualization.classList.add('active'); // Add class for visual feedback
        };

        recognition.onresult = (event) => {
            const transcript = event.results[0][0].transcript.trim();
            console.log('Transcript:', transcript);
            if (transcript) {
                userInput.value = transcript;
                sendMessage(); // Automatically send after recognition
            }
        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            let errorMsg = 'Speech recognition error';
            if (event.error === 'no-speech') {
                errorMsg = 'No speech detected. Try speaking louder.';
            } else if (event.error === 'audio-capture') {
                errorMsg = 'Microphone error. Check permissions.';
            } else if (event.error === 'not-allowed') {
                errorMsg = 'Microphone access denied. Please allow access.';
            }
             displayError(errorMsg);
            statusIndicator.textContent = 'Error listening';
        };

        recognition.onend = () => {
            isListening = false;
            listenButton.classList.remove('listening');
             // Only reset status if not currently processing/speaking
            if (!assistantSpeaking) {
                statusIndicator.textContent = 'Idle';
            }
            visualization.classList.remove('active');
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
        if (event.key === 'Enter') {
            sendMessage();
        }
    });

    listenButton.addEventListener('click', () => {
        if (!recognition) return;

        if (isListening) {
            recognition.stop();
        } else {
             // Request microphone permission explicitly if needed (good practice)
             navigator.mediaDevices.getUserMedia({ audio: true })
                 .then(() => {
                     try {
                         clearError(); // Clear previous errors
                         recognition.start();
                     } catch (e) {
                         // Handle edge case where start() fails immediately
                         console.error("Error starting recognition:", e);
                         statusIndicator.textContent = 'Mic Error';
                         listenButton.classList.remove('listening');
                         isListening = false;
                     }
                 })
                 .catch(err => {
                     console.error("Microphone access denied:", err);
                      displayError('Microphone access denied. Please enable it in browser settings.');
                     statusIndicator.textContent = 'Mic Access Denied';
                 });
        }
    });


    // --- Core Functions ---

    function addMessageToChat(sender, message) {
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', sender.toLowerCase()); // 'user' or 'assistant'

        // Sanitize message slightly (replace < and > to prevent basic HTML injection)
        // For more robust sanitization, use a library like DOMPurify if needed.
        const sanitizedMessage = message.replace(/</g, "<").replace(/>/g, ">");

        messageElement.innerHTML = `<span>${sanitizedMessage}</span>`; // Wrap text in span

         // Remove any existing loading indicator before adding new message
        const loadingIndicator = chatbox.querySelector('.message.loading');
        if (loadingIndicator && sender !== 'loading') {
            loadingIndicator.remove();
        }

         chatbox.appendChild(messageElement);
        scrollToBottom(); // Keep latest message in view
        return messageElement; // Return the element for potential modification (like speaking)
    }

    function showLoadingIndicator() {
         addMessageToChat('loading', 'Thinking');
         statusIndicator.textContent = 'Processing...';
         visualization.classList.add('active');
         sendButton.disabled = true;
         listenButton.disabled = true;
    }

    function hideLoadingIndicator() {
         const loadingIndicator = chatbox.querySelector('.message.loading');
         if (loadingIndicator) {
             loadingIndicator.remove();
         }
         statusIndicator.textContent = 'Idle'; // Or reflect speaking state
         visualization.classList.remove('active');
         sendButton.disabled = false;
         listenButton.disabled = !recognition ? true : false; // Re-enable based on support
         userInput.disabled = false;
         userInput.focus(); // Set focus back to input
    }

     function displayError(message) {
        errorMessageDiv.textContent = message;
        errorMessageDiv.style.display = 'block';
     }

     function clearError() {
        errorMessageDiv.textContent = '';
        errorMessageDiv.style.display = 'none';
     }

    async function sendMessage() {
        const question = userInput.value.trim();
        if (!question) return;

        clearError(); // Clear previous errors
        addMessageToChat('User', question);
        userInput.value = ''; // Clear input field
        userInput.disabled = true; // Disable input while processing
        showLoadingIndicator();

        try {
            const response = await fetch('/ask', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ question: question }),
            });

            // Always execute hideLoadingIndicator in a finally block
            //hideLoadingIndicator(); // Moved to finally block

            if (!response.ok) {
                 const errorData = await response.json().catch(() => ({ error: "Unknown server error" })); // Gracefully handle non-JSON errors
                 console.error('Server Error:', response.status, errorData);
                 displayError(`Error: ${errorData.error || response.statusText}`);
                 addMessageToChat('Assistant', `Sorry, I encountered an error processing that (${response.status}).`);
                 // Don't speak error messages by default
            } else {
                const data = await response.json();
                const assistantMessageElement = addMessageToChat('Assistant', data.response);
                 speakResponse(data.response, assistantMessageElement); // Speak the response
            }
        } catch (error) {
            console.error('Fetch Error:', error);
            //hideLoadingIndicator(); // Ensure loading is hidden on network error
            displayError('Network error. Could not reach the assistant.');
            addMessageToChat('Assistant', 'Sorry, I seem to be having trouble connecting.');
        } finally {
             // Ensure loading indicator is hidden and input re-enabled regardless of success/failure
             // Use a small timeout to allow potential speech synthesis to start before resetting status fully
             setTimeout(hideLoadingIndicator, 100);
        }
    }

    function speakResponse(textToSpeak, messageElement) {
         if (!synth || !textToSpeak) {
            statusIndicator.textContent = 'Idle'; // Reset if no speech synth
             return;
         }

         // Cancel any previous speech
        if (synth.speaking) {
            synth.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        utterance.lang = 'en-US'; // Ensure consistent language
        // Optional: Choose a specific voice if available
        // const voices = synth.getVoices();
        // utterance.voice = voices.find(voice => voice.name === 'Google UK English Female'); // Example

        utterance.onstart = () => {
            assistantSpeaking = true;
             statusIndicator.textContent = 'Speaking...';
             visualization.classList.add('active'); // Keep visual active while speaking
            if(messageElement) messageElement.classList.add('speaking'); // Highlight speaking message
        };

        utterance.onend = () => {
            assistantSpeaking = false;
             statusIndicator.textContent = 'Idle';
             visualization.classList.remove('active');
            if(messageElement) messageElement.classList.remove('speaking');
             // Re-enable mic button if it was disabled only for speaking
             if (!isListening && recognition) {
                 listenButton.disabled = false;
             }
             userInput.focus(); // Refocus input after speaking
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event.error);
             assistantSpeaking = false;
             statusIndicator.textContent = 'Speech Error';
             visualization.classList.remove('active');
             if(messageElement) messageElement.classList.remove('speaking');
        };

         // Disable mic listening temporarily while speaking to avoid feedback loops
        listenButton.disabled = true;
        synth.speak(utterance);
    }


    function scrollToBottom() {
        chatbox.scrollTop = chatbox.scrollHeight;
    }

    // Initial focus
    userInput.focus();
     // Say initial greeting if desired and supported
     // speakResponse("Hello! How can I assist you today?");
});