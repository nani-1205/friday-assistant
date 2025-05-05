# app.py
import os
import logging
from datetime import datetime
from flask import Flask, render_template, request, jsonify
import google.generativeai as genai
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError, OperationFailure
from dotenv import load_dotenv
from urllib.parse import quote_plus # <--- IMPORT ADDED HERE

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
    # You might want to exit or raise an error here in a real production scenario
    # exit()
    model = None # Ensure model is None if config fails
else:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        model = genai.GenerativeModel('gemini-pro') # Use a capable model
        logging.info("Google Gemini configured successfully.")
    except Exception as e:
        logging.error(f"Error configuring Google Gemini: {e}")
        model = None # Ensure model is None if config fails

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
        # --- ADDED: Escape username and password ---
        # This handles special characters like '@', ':', '/', etc. in credentials
        escaped_user = quote_plus(MONGO_USER)
        escaped_password = quote_plus(MONGO_PASSWORD)
        # --- END ADDED SECTION ---

        # Construct the connection string (handle potential SRV record usage)
        if MONGO_HOST.startswith("mongodb+srv://"):
             # SRV record format often includes username/password already, adjust if needed
             # For clarity, we'll build it explicitly here. Ensure MONGO_HOST doesn't duplicate creds.
             # --- MODIFIED: Use escaped credentials ---
             connection_string = f"mongodb+srv://{escaped_user}:{escaped_password}@{MONGO_HOST.split('//')[1]}/?retryWrites=true&w=majority&authSource={MONGO_AUTH_DB}"
        else:
            # Standard connection string
             # --- MODIFIED: Use escaped credentials ---
             connection_string = f"mongodb://{escaped_user}:{escaped_password}@{MONGO_HOST}:{MONGO_PORT}/?authSource={MONGO_AUTH_DB}"

        logging.info(f"Attempting to connect to MongoDB at {MONGO_HOST}...")
        # Increased timeout for potentially slow connections or initial setup
        mongo_client = MongoClient(connection_string, serverSelectionTimeoutMS=10000)

        # The ismaster command is cheap and does not require auth. Check server reachability.
        mongo_client.admin.command('ismaster')
        logging.info("MongoDB server is reachable.")

        # Check if database exists, then connect/create
        db = mongo_client[MONGO_DB_NAME]
        logging.info(f"Connected to database: '{MONGO_DB_NAME}'")

        # Check if collection exists, create if not
        if MONGO_COLLECTION_NAME not in db.list_collection_names():
            logging.info(f"Collection '{MONGO_COLLECTION_NAME}' not found, creating it.")
            # You can optionally define schema validation here if needed
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
        # This often indicates authentication failure AFTER connection
        logging.error(f"MongoDB Authentication Error or Operation Failed: Check username/password/authSource ({MONGO_AUTH_DB}). Details: {e.details}")
        mongo_client = db = collection = None
        return False
    except Exception as e:
        # Catch other potential errors during initialization (like the original quote_plus error)
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

        logging.info(f"Received question: {question}")

        # --- Interaction with Google Gemini ---
        # Add a prompt instruction to try and use real-time info if possible
        # Gemini Pro is generally capable of accessing recent information.
        prompt = f"""You are Friday, a helpful and slightly witty AI assistant.
        Answer the following question based on your knowledge. If the question seems
        to require current information (like today's weather, recent news, stock prices),
        explicitly state that you will try to find the latest information.

        Question: {question}
        Answer:"""

        response_text = "Sorry, I couldn't generate a response at this moment." # Default
        try:
            # It's good practice to wrap external API calls
            generation_config = genai.types.GenerationConfig(
                # You can add config here like temperature, top_p, etc. if needed
                # temperature=0.7
                )
            safety_settings = [ # Example: Block fewer things (use with caution)
                 {
                    "category": "HARM_CATEGORY_HARASSMENT",
                    "threshold": "BLOCK_MEDIUM_AND_ABOVE",
                 },
                 {
                    "category": "HARM_CATEGORY_HATE_SPEECH",
                    "threshold": "BLOCK_MEDIUM_AND_ABOVE",
                 },
                 {
                    "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                    "threshold": "BLOCK_MEDIUM_AND_ABOVE",
                 },
                  {
                    "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                    "threshold": "BLOCK_MEDIUM_AND_ABOVE",
                 },
            ]

            response = model.generate_content(
                prompt,
                generation_config=generation_config,
                safety_settings=safety_settings,
                )

            # Robust check for response content
            if response.parts:
                 response_text = "".join(part.text for part in response.parts) # Handle multi-part responses
            elif response.candidates and response.candidates[0].content.parts:
                 # Sometimes the response is nested within candidates
                 response_text = "".join(part.text for part in response.candidates[0].content.parts)
            else:
                 # Check for safety blocks or other issues
                 if response.prompt_feedback.block_reason:
                     safety_reason = response.prompt_feedback.block_reason.name
                     logging.warning(f"Gemini request blocked due to safety reasons: {safety_reason}")
                     return jsonify({"error": f"Request blocked by safety filters ({safety_reason}). Please rephrase."}), 400
                 else:
                     logging.error(f"Gemini API returned an empty response or unexpected structure: {response}")
                     return jsonify({"error": "Received an empty or unexpected response from the AI."}), 500


        except Exception as e:
             # More specific error handling could be added based on google.api_core.exceptions
            logging.exception(f"Error calling Gemini API: {e}") # Log traceback for debugging
            # Try to provide more context if available from the exception or response object (if it exists)
            error_detail = str(e)
            try:
                # Check if the response object exists and has feedback, even on error
                if 'response' in locals() and response.prompt_feedback.block_reason:
                     safety_reason = response.prompt_feedback.block_reason.name
                     logging.warning(f"Gemini request potentially blocked by safety settings during error: {safety_reason}")
                     error_detail = f"Request may have been blocked by safety filters ({safety_reason})."
                     return jsonify({"error": error_detail}), 400
            except AttributeError:
                 pass # Ignore if response or feedback doesn't exist

            return jsonify({"error": f"An error occurred while communicating with the AI: {error_detail}"}), 500


        logging.info(f"Generated response (first 100 chars): {response_text[:100]}...")

        # --- Store Interaction in MongoDB ---
        if mongodb_ready and collection is not None:
            interaction_data = {
                "timestamp": datetime.utcnow(),
                "question": question,
                "response": response_text,
                "model_used": model.model_name, # Get model name dynamically
                "request_ip": request.remote_addr # Store requesting IP
                # Add more metadata if needed (e.g., user_id if you implement authentication)
            }
            try:
                insert_result = collection.insert_one(interaction_data)
                logging.info(f"Interaction stored in MongoDB with id: {insert_result.inserted_id}")
            except Exception as e:
                logging.error(f"Error storing interaction in MongoDB: {e}")
                # Don't fail the whole request if DB write fails, but log it.

        else:
            logging.warning("MongoDB not available. Interaction not stored.")

        return jsonify({"response": response_text})

    except Exception as e:
        logging.exception("An unexpected error occurred in /ask endpoint.") # Log full traceback
        return jsonify({"error": "An internal server error occurred."}), 500

# --- Main Execution ---
if __name__ == '__main__':
    # Determine if running in debug mode (e.g., via environment variable or command line arg)
    # For production, ensure debug=False and use a proper WSGI server like Gunicorn or Waitress
    # Example: FLASK_DEBUG=0 python app.py or gunicorn app:app
    is_debug = os.environ.get('FLASK_DEBUG', '1') == '1' # Default to debug if not set

    # Use host='0.0.0.0' to make it accessible on your network
    app.run(host='0.0.0.0', port=5000, debug=is_debug)