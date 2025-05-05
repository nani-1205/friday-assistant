# app.py
import os
import logging
from datetime import datetime
from flask import Flask, render_template, request, jsonify
import google.generativeai as genai
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError, OperationFailure
from dotenv import load_dotenv
from urllib.parse import quote_plus # For escaping MongoDB credentials

# --- Configuration ---
load_dotenv()  # Load environment variables from .env file

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Flask App Initialization
app = Flask(__name__)

# Google Gemini Configuration
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
if not GOOGLE_API_KEY:
    logging.error("GOOGLE_API_KEY not found in environment variables.")
    model = None # Ensure model is None if config fails
else:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        # Consider gemini-1.5-flash for potentially faster responses if suitable
        model = genai.GenerativeModel('gemini-1.5-flash-latest')
        logging.info("Google Gemini configured successfully.")
    except Exception as e:
        logging.error(f"Error configuring Google Gemini: {e}")
        model = None

# MongoDB Configuration
MONGO_USER = os.getenv('MONGO_USER')
MONGO_PASSWORD = os.getenv('MONGO_PASSWORD')
MONGO_HOST = os.getenv('MONGO_HOST')
MONGO_PORT = os.getenv('MONGO_PORT', '27017') # Default port if not set
MONGO_DB_NAME = os.getenv('MONGO_DB_NAME')
MONGO_COLLECTION_NAME = os.getenv('MONGO_COLLECTION_NAME')
MONGO_AUTH_DB = os.getenv('MONGO_AUTH_DB', 'admin') # Default auth source

mongo_client = None
db = None
collection = None

def initialize_mongodb():
    """Initializes MongoDB connection and ensures database/collection exist."""
    global mongo_client, db, collection
    if not all([MONGO_USER, MONGO_PASSWORD, MONGO_HOST, MONGO_DB_NAME, MONGO_COLLECTION_NAME]):
        logging.error("MongoDB environment variables incomplete. Database connection skipped.")
        return False

    try:
        # Escape username and password for the connection string
        escaped_user = quote_plus(MONGO_USER)
        escaped_password = quote_plus(MONGO_PASSWORD)

        # Construct the connection string
        if MONGO_HOST.startswith("mongodb+srv://"):
             connection_string = f"mongodb+srv://{escaped_user}:{escaped_password}@{MONGO_HOST.split('//')[1]}/?retryWrites=true&w=majority&authSource={MONGO_AUTH_DB}"
        else:
             connection_string = f"mongodb://{escaped_user}:{escaped_password}@{MONGO_HOST}:{MONGO_PORT}/?authSource={MONGO_AUTH_DB}"

        logging.info(f"Attempting to connect to MongoDB at {MONGO_HOST}...")
        mongo_client = MongoClient(connection_string, serverSelectionTimeoutMS=10000)
        mongo_client.admin.command('ismaster') # Check server reachability & auth basic
        logging.info("MongoDB server is reachable.")

        db = mongo_client[MONGO_DB_NAME]
        logging.info(f"Connected to database: '{MONGO_DB_NAME}'")

        if MONGO_COLLECTION_NAME not in db.list_collection_names():
            logging.info(f"Collection '{MONGO_COLLECTION_NAME}' not found, creating it.")
            db.create_collection(MONGO_COLLECTION_NAME)
        else:
             logging.info(f"Found existing collection: '{MONGO_COLLECTION_NAME}'")

        collection = db[MONGO_COLLECTION_NAME]
        logging.info("MongoDB connection and setup successful.")
        return True

    except (ConnectionFailure, ServerSelectionTimeoutError) as e:
        logging.error(f"MongoDB Connection Error: Could not connect to server at {MONGO_HOST}. Check network/firewall and credentials. Details: {e}")
        mongo_client = db = collection = None
        return False
    except OperationFailure as e:
        logging.error(f"MongoDB Authentication Error or Operation Failed: Check username/password/authSource ({MONGO_AUTH_DB}). Details: {e.details}")
        mongo_client = db = collection = None
        return False
    except Exception as e:
        logging.error(f"An unexpected error occurred during MongoDB initialization: {e}")
        mongo_client = db = collection = None
        return False

# Initialize DB on startup
mongodb_ready = initialize_mongodb()

# --- Flask Routes ---
@app.route('/')
def index():
    """Renders the main chat interface."""
    return render_template('index.html')

@app.route('/ask', methods=['POST'])
def ask_assistant():
    """Handles questions from the user, interacts with Gemini, and stores data."""
    if not model:
        logging.error("Attempted to use '/ask' endpoint but AI Model is not initialized.")
        return jsonify({"error": "AI Model not initialized. Check API Key and configuration."}), 500

    try:
        data = request.get_json()
        if not data or 'question' not in data:
            logging.warning("Received invalid request to /ask: 'question' field missing.")
            return jsonify({"error": "Invalid request. 'question' field is missing."}), 400

        question = data['question'].strip()
        if not question:
            logging.warning("Received empty question in /ask request.")
            return jsonify({"error": "Question cannot be empty."}), 400

        logging.info(f"Received question from {request.remote_addr}: {question}")

        # --- Interaction with Google Gemini ---
        prompt = f"""You are Friday, a helpful and slightly witty AI assistant.
        Answer the following question based on your knowledge. If the question seems
        to require current information (like today's weather, recent news, stock prices),
        explicitly state that you will try to find the latest information.

        Question: {question}
        Answer:"""

        response_text = "Sorry, I encountered an issue generating a response." # Default fail text
        try:
            generation_config = genai.types.GenerationConfig(temperature=0.7) # Example config
            # Adjust safety settings as needed - be aware of implications
            safety_settings = [
                 {"category": c, "threshold": "BLOCK_MEDIUM_AND_ABOVE"}
                 for c in [ "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
                            "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
            ]

            response = model.generate_content(
                prompt,
                generation_config=generation_config,
                safety_settings=safety_settings,
                )

            # Robust check for response content
            if response.parts:
                 response_text = "".join(part.text for part in response.parts)
            elif response.candidates and response.candidates[0].content and response.candidates[0].content.parts:
                 response_text = "".join(part.text for part in response.candidates[0].content.parts)
            else:
                 if response.prompt_feedback.block_reason:
                     safety_reason = response.prompt_feedback.block_reason.name
                     logging.warning(f"Gemini request blocked due to safety reasons: {safety_reason}")
                     # Return specific error for safety blocks
                     return jsonify({"error": f"Request blocked by safety filters ({safety_reason}). Please rephrase."}), 400
                 else:
                     logging.error(f"Gemini API returned an empty response or unexpected structure: {response}")
                     # Return generic AI error
                     return jsonify({"error": "Received an empty or unexpected response from the AI."}), 500

        except Exception as e:
            logging.exception(f"Error calling Gemini API: {e}") # Log full traceback
            error_detail = str(e)
            safety_reason = None
            try: # Check for safety block even within exception context if possible
                if 'response' in locals() and hasattr(response, 'prompt_feedback') and response.prompt_feedback.block_reason:
                     safety_reason = response.prompt_feedback.block_reason.name
            except Exception: pass # Ignore errors during this check

            if safety_reason:
                 error_detail = f"Request may have been blocked by safety filters ({safety_reason})."
                 return jsonify({"error": error_detail}), 400 # Return 400 for safety block
            else:
                 # Return 500 for other API errors
                 return jsonify({"error": f"An error occurred while communicating with the AI."}), 500


        logging.info(f"Generated response (first 100 chars): {response_text[:100]}...")

        # --- Store Interaction in MongoDB ---
        if mongodb_ready and collection is not None:
            interaction_data = {
                "timestamp": datetime.utcnow(),
                "request_ip": request.remote_addr, # Store requesting IP
                "question": question,
                "response": response_text,
                "model_used": model.model_name,
                 # Could add response metadata if needed e.g., response.usage_metadata
            }
            try:
                insert_result = collection.insert_one(interaction_data)
                logging.info(f"Interaction stored in MongoDB with id: {insert_result.inserted_id}")
            except Exception as e:
                logging.error(f"Error storing interaction in MongoDB: {e}") # Log DB error but continue

        else:
            logging.warning("MongoDB not available. Interaction not stored.")

        return jsonify({"response": response_text})

    except Exception as e:
        logging.exception("An critical unexpected error occurred in /ask endpoint.") # Log full traceback
        return jsonify({"error": "An internal server error occurred processing your request."}), 500

# --- Main Execution ---
if __name__ == '__main__':
    # Determine if running in debug mode
    is_debug = os.environ.get('FLASK_DEBUG', '1') == '1' # Default to debug if not set

    # --- HTTPS Configuration for Development ---
    # For microphone access (getUserMedia), the browser requires HTTPS or localhost.
    # This uses a self-signed certificate for development.
    # Generate certs using: openssl req -x509 -newkey rsa:4096 -nodes -out cert.pem -keyout key.pem -days 365
    # In production, use a proper WSGI server (Gunicorn/Waitress) behind a reverse proxy (Nginx/Caddy) handling HTTPS.
    cert_file = 'cert.pem'
    key_file = 'key.pem'
    ssl_context = None
    if os.path.exists(cert_file) and os.path.exists(key_file):
        ssl_context = (cert_file, key_file)
        logging.info(f"Found certificate files ({cert_file}, {key_file}). Starting HTTPS server.")
    else:
        logging.warning(f"Certificate files ({cert_file}, {key_file}) not found. "
                       f"Starting HTTP server. Microphone input will likely fail on non-localhost addresses.")

    # Use host='0.0.0.0' to make it accessible on your network
    try:
        app.run(host='0.0.0.0', port=5000, debug=is_debug, ssl_context=ssl_context)
    except FileNotFoundError:
         logging.error(f"Could not find certificate files specified for SSL context: {cert_file}, {key_file}. "
                       f"Make sure they exist or remove the ssl_context parameter to run via HTTP.")
    except Exception as e:
        logging.exception(f"Failed to start Flask server: {e}")