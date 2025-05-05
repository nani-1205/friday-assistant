# app.py
import os
import logging
from datetime import datetime
from flask import Flask, render_template, request, jsonify
import google.generativeai as genai
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError, OperationFailure
from dotenv import load_dotenv
from urllib.parse import quote_plus
import requests # For WeatherAPI calls
import json     # For parsing Gemini's intent response

# --- Configuration ---
load_dotenv() # Load environment variables from .env file

# Logging Configuration
# Consider logging to a file in production: logging.basicConfig(filename='friday_assistant.log', ...)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(threadName)s - %(message)s')

# Flask App Initialization
app = Flask(__name__)

# Google Gemini Configuration
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
GEMINI_MODEL_NAME = 'gemini-1.5-flash-latest' # Use the desired model
model = None # Initialize model variable

if not GOOGLE_API_KEY:
    logging.error("FATAL: GOOGLE_API_KEY not found in environment variables. AI functionality disabled.")
else:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        model = genai.GenerativeModel(GEMINI_MODEL_NAME)
        # Perform a quick test call to verify API key and model access (optional but recommended)
        # model.generate_content("test", generation_config=genai.types.GenerationConfig(candidate_count=1))
        logging.info(f"Google Gemini configured successfully with model: {GEMINI_MODEL_NAME}")
    except Exception as e:
        logging.error(f"FATAL: Error configuring Google Gemini or accessing model '{GEMINI_MODEL_NAME}'. AI functionality disabled. Error: {e}")
        model = None # Ensure model is None if setup fails

# WeatherAPI Configuration
WEATHER_API_KEY = os.getenv('WEATHER_API_KEY')
if not WEATHER_API_KEY:
    logging.warning("WEATHER_API_KEY not found in environment variables. Weather functionality will be disabled.")

# MongoDB Configuration
MONGO_USER = os.getenv('MONGO_USER')
MONGO_PASSWORD = os.getenv('MONGO_PASSWORD')
MONGO_HOST = os.getenv('MONGO_HOST')
MONGO_PORT = os.getenv('MONGO_PORT', '27017')
MONGO_DB_NAME = os.getenv('MONGO_DB_NAME')
MONGO_COLLECTION_NAME = os.getenv('MONGO_COLLECTION_NAME')
MONGO_AUTH_DB = os.getenv('MONGO_AUTH_DB', 'admin')

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
             # Ensure MONGO_HOST doesn't duplicate credentials if copied from Atlas UI directly
             host_part = MONGO_HOST.split('@')[-1] # Get the part after potential existing creds
             connection_string = f"mongodb+srv://{escaped_user}:{escaped_password}@{host_part}/?retryWrites=true&w=majority&authSource={MONGO_AUTH_DB}"
        else:
             connection_string = f"mongodb://{escaped_user}:{escaped_password}@{MONGO_HOST}:{MONGO_PORT}/?authSource={MONGO_AUTH_DB}"

        logging.info(f"Attempting to connect to MongoDB at {MONGO_HOST}...")
        # Increase timeout slightly for initial connection robustness
        mongo_client = MongoClient(connection_string, serverSelectionTimeoutMS=15000)
        # The ismaster command is cheap and does not require auth. Checks reachability.
        mongo_client.admin.command('ismaster')
        logging.info("MongoDB server is reachable.")

        db = mongo_client[MONGO_DB_NAME]
        logging.info(f"Connected to database: '{MONGO_DB_NAME}'")

        # Check if collection exists, create if not
        if MONGO_COLLECTION_NAME not in db.list_collection_names():
            logging.info(f"Collection '{MONGO_COLLECTION_NAME}' not found, creating it.")
            db.create_collection(MONGO_COLLECTION_NAME)
            # Consider adding indexes for faster queries later, e.g., on timestamp or request_ip
            # collection.create_index([("timestamp", pymongo.DESCENDING)])
        else:
             logging.info(f"Found existing collection: '{MONGO_COLLECTION_NAME}'")

        collection = db[MONGO_COLLECTION_NAME]
        logging.info("MongoDB connection and setup successful.")
        return True

    except (ConnectionFailure, ServerSelectionTimeoutError) as e:
        logging.error(f"MongoDB Connection Error: Could not connect to server at {MONGO_HOST}. Check network/firewall rules and credentials. Details: {e}")
        mongo_client = db = collection = None
        return False
    except OperationFailure as e:
        logging.error(f"MongoDB Authentication Error or Operation Failed: Check username/password/authSource ('{MONGO_AUTH_DB}'). Details: {e.details}")
        mongo_client = db = collection = None
        return False
    except Exception as e:
        logging.exception(f"An unexpected error occurred during MongoDB initialization: {e}") # Log traceback
        mongo_client = db = collection = None
        return False

# Initialize DB on startup - attempt connection
mongodb_ready = initialize_mongodb()

# --- Weather API Function ---
def get_weather(location: str):
    """Fetches current weather data from WeatherAPI.com."""
    if not WEATHER_API_KEY:
        logging.warning("Attempted to get weather, but WEATHER_API_KEY is not set.")
        return None, "Weather API key not configured."

    base_url = "http://api.weatherapi.com/v1/current.json"
    params = {
        "key": WEATHER_API_KEY,
        "q": location,
        "aqi": "no"
    }
    headers = {"User-Agent": "FridayAssistant/1.0"} # Good practice to identify your app
    logging.debug(f"Requesting weather from WeatherAPI for location: {location}")

    try:
        # Increased timeout for potentially slow API responses
        response = requests.get(base_url, params=params, timeout=15, headers=headers)
        response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)

        weather_data = response.json()
        logging.info(f"Successfully fetched weather for {location} (Status: {response.status_code})")
        return weather_data, None # Return data and no error

    except requests.exceptions.Timeout:
        logging.error(f"Timeout connecting to WeatherAPI for location: {location}")
        return None, "The weather service timed out. Please try again later."
    except requests.exceptions.HTTPError as http_err:
        status_code = http_err.response.status_code
        error_detail = f"HTTP error {status_code}"
        try: # Try to get more specific error from API response body
             error_api_msg = http_err.response.json().get('error', {}).get('message', '')
             if error_api_msg:
                 error_detail += f": {error_api_msg}"
        except:
             pass # Ignore if response is not JSON or structure is different
        logging.error(f"HTTP error occurred fetching weather for {location}: {error_detail}")

        if status_code == 400:
            return None, f"Could not find weather data for '{location}'. Please check the location name. ({error_api_msg or 'Bad Request'})"
        elif status_code == 401 or status_code == 403:
            return None, "There's an issue with the weather service configuration (authentication error)."
        else:
            return None, f"An error occurred while contacting the weather service ({error_detail})."
    except requests.exceptions.ConnectionError as conn_err:
         logging.error(f"Connection error fetching weather for {location}: {conn_err}")
         return None, "Could not connect to the weather service. Please check the network."
    except requests.exceptions.RequestException as req_err:
        logging.error(f"Generic request error fetching weather for {location}: {req_err}")
        return None, f"An unexpected network error occurred while fetching weather: {req_err}"
    except Exception as e:
        logging.exception(f"Unexpected error processing weather fetch for {location}: {e}") # Log full traceback
        return None, "An unexpected internal error occurred while fetching weather data."


# --- Helper to call Gemini ---
def call_gemini(prompt: str, is_json_output: bool = False):
    """Helper function to call the Gemini API and handle basic errors/response."""
    if not model:
        logging.error("call_gemini attempted but AI Model is not initialized.")
        return None, "AI Model is not available."

    mime_type = "application/json" if is_json_output else "text/plain"
    logging.debug(f"Calling Gemini (Output Type: {mime_type}). Prompt length: {len(prompt)}")
    logging.debug(f"Prompt Sample: {prompt[:200]}...")

    try:
        generation_config = genai.types.GenerationConfig(
            # Adjust temperature for creativity vs. predictability (0.0-1.0)
            temperature=0.7,
            # Specify response MIME type for structured output if needed
            response_mime_type=mime_type
        )
        # Configure safety settings - BLOCK_MEDIUM_AND_ABOVE is a reasonable default
        safety_settings = [
            {"category": c, "threshold": "BLOCK_MEDIUM_AND_ABOVE"}
            for c in ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH",
                      "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"]
        ]

        response = model.generate_content(
            prompt,
            generation_config=generation_config,
            safety_settings=safety_settings,
            request_options={'timeout': 60} # Add timeout for the API call itself (e.g., 60 seconds)
        )

        # Robustly extract text content
        response_text = None
        if response.parts:
            response_text = "".join(part.text for part in response.parts)
        elif response.candidates and response.candidates[0].content and response.candidates[0].content.parts:
            response_text = "".join(part.text for part in response.candidates[0].content.parts)

        # Check response validity and safety feedback
        if response_text:
            logging.debug(f"Gemini raw response sample: {response_text[:200]}...")
            return response_text, None # Success
        elif response.prompt_feedback.block_reason:
            reason = response.prompt_feedback.block_reason.name
            logging.warning(f"Gemini request blocked by safety filter: {reason}")
            return None, f"My safety filters blocked the request ({reason}). Please rephrase."
        else:
            # This case might indicate an issue with the response structure or an empty generation
            logging.error(f"Gemini returned an empty or unexpected response structure: {response}")
            return None, "The AI returned an empty or unexpected response."

    except Exception as e:
        logging.exception(f"Core error during Gemini API call: {e}") # Log traceback
        # Attempt to extract more specific error info if available (e.g., from google API errors)
        error_detail = str(e)
        # Check for safety block reason within the exception if possible
        safety_reason = None
        try:
            # Accessing response within exception needs care, might not exist
            if hasattr(e, 'response') and hasattr(e.response, 'prompt_feedback') and e.response.prompt_feedback.block_reason:
                safety_reason = e.response.prompt_feedback.block_reason.name
        except Exception: pass # Ignore errors during this check

        if safety_reason:
             return None, f"My safety filters may have blocked the request ({safety_reason})."

        # Add more specific error types if needed (e.g., DeadlineExceeded, ResourceExhausted)
        # from google.api_core import exceptions as google_exceptions
        # if isinstance(e, google_exceptions.DeadlineExceeded):
        #    return None, "The request to the AI timed out."

        return None, f"An error occurred while communicating with the AI ({type(e).__name__})."


# --- Flask Routes ---
@app.route('/')
def index():
    """Renders the main chat interface."""
    return render_template('index.html')

@app.route('/ask', methods=['POST'])
def ask_assistant():
    """Handles user questions, detects weather intent, calls APIs, and stores data."""
    start_time = datetime.now()
    if not model:
        logging.error("Received /ask request but AI model is not available.")
        return jsonify({"error": "AI Model is not initialized. Please check server logs."}), 500

    try:
        data = request.get_json()
        if not data or 'question' not in data:
            logging.warning(f"Invalid request to /ask from {request.remote_addr}: 'question' field missing.")
            return jsonify({"error": "Invalid request format: 'question' field missing."}), 400
        question = data['question'].strip()
        if not question:
            logging.warning(f"Empty question received in /ask request from {request.remote_addr}.")
            return jsonify({"error": "Question cannot be empty."}), 400

        logging.info(f"Received question from {request.remote_addr}: \"{question}\"")

        final_response_text = None
        error_message_for_user = None # Specific error message to show user, if any
        interaction_details = { # Store metadata about how the response was generated
             "type": "general_query", # Default type
             "intent_analysis_success": None,
             "weather_api_called": False,
             "weather_location": None,
             "weather_api_success": None,
             "final_response_source": "unknown", # general_ai, weather_ai, weather_api_error, general_error, etc.
             "error_details": None # Store internal error messages
        }

        # === Step 1: Intent Analysis (Check for Weather Query) ===
        # Only perform if weather API key is available
        is_weather_query = False
        weather_location = None
        if WEATHER_API_KEY:
            intent_prompt = f"""Analyze the user query to determine if it is asking for the current weather or a weather forecast.
If it is a weather query, identify the primary location. Be specific (e.g., "London, UK", "Paris", "90210").
If it's not about weather, or the location is ambiguous or missing, indicate that.

User Query: "{question}"

Respond ONLY with a valid JSON object containing these keys:
- "is_weather_query": boolean (true if asking about weather, false otherwise)
- "location": string (the location identified, or null if not a weather query or location unclear/missing)

Examples:
{{"is_weather_query": true, "location": "New York City"}}
{{"is_weather_query": false, "location": null}}
{{"is_weather_query": true, "location": null}}""" # Example of weather query with unclear location

            logging.debug("Sending intent analysis prompt to Gemini...")
            intent_response_raw, intent_error = call_gemini(intent_prompt, is_json_output=True)

            if intent_error:
                logging.error(f"Error during Gemini intent analysis: {intent_error}")
                interaction_details["intent_analysis_success"] = False
                interaction_details["error_details"] = f"Intent analysis failed: {intent_error}"
                # Don't halt processing, just proceed as general query
            else:
                try:
                    # Clean potential markdown fences and whitespace
                    intent_response_clean = intent_response_raw.strip()
                    if intent_response_clean.startswith("```json"):
                        intent_response_clean = intent_response_clean[7:-3].strip()
                    elif intent_response_clean.startswith("```"):
                        intent_response_clean = intent_response_clean[3:-3].strip()

                    intent_data = json.loads(intent_response_clean)
                    is_weather_query = intent_data.get("is_weather_query") is True # Explicitly check for True
                    weather_location = intent_data.get("location") # Can be string or null

                    if isinstance(weather_location, str) and not weather_location.strip():
                         weather_location = None # Treat empty string location as null

                    interaction_details["intent_analysis_success"] = True
                    logging.info(f"Intent analysis result: is_weather={is_weather_query}, location='{weather_location}'")
                except json.JSONDecodeError:
                    logging.error(f"Failed to decode JSON response from Gemini for intent. Raw: {intent_response_raw}")
                    interaction_details["intent_analysis_success"] = False
                    interaction_details["error_details"] = "Failed to parse AI intent JSON response."
                except Exception as e:
                    logging.exception(f"Unexpected error processing intent JSON response: {e}")
                    interaction_details["intent_analysis_success"] = False
                    interaction_details["error_details"] = f"Error processing intent: {type(e).__name__}"
        else:
            logging.info("Weather API key not set, skipping intent analysis.")
            interaction_details["intent_analysis_success"] = None # Indicate it wasn't attempted

        # === Step 2: Handle Weather Query if Detected & Possible ===
        if is_weather_query and weather_location and WEATHER_API_KEY:
            interaction_details["type"] = "weather_query"
            interaction_details["weather_location"] = weather_location
            interaction_details["weather_api_called"] = True
            logging.info(f"Weather query confirmed for location: '{weather_location}'. Calling WeatherAPI...")

            weather_data, weather_api_err_msg = get_weather(weather_location)

            if weather_api_err_msg:
                # API call failed
                logging.error(f"WeatherAPI error for '{weather_location}': {weather_api_err_msg}")
                interaction_details["weather_api_success"] = False
                interaction_details["error_details"] = weather_api_err_msg
                # Ask AI to formulate a user-friendly message about the *specific* API error
                error_formulation_prompt = f"""You are Friday. The user asked for the weather in '{weather_location}'.
You tried to fetch it, but encountered this problem: '{weather_api_err_msg}'.
Politely inform the user about this specific issue and suggest trying again or checking the location. Do not offer to try again yourself."""
                ai_error_response, formulation_err = call_gemini(error_formulation_prompt)
                if formulation_err:
                    logging.error(f"Failed to get AI to formulate weather API error message: {formulation_err}")
                    final_response_text = f"Sorry, I couldn't get the weather for '{weather_location}'. There was an issue with the weather service: {weather_api_err_msg}" # Fallback to raw error
                else:
                    final_response_text = ai_error_response
                interaction_details["final_response_source"] = "weather_api_error_ai"

            elif weather_data:
                # API call succeeded
                interaction_details["weather_api_success"] = True
                try:
                    # Extract relevant data safely using .get()
                    current = weather_data.get('current', {})
                    location_info = weather_data.get('location', {})
                    loc_name = location_info.get('name', weather_location)
                    region = location_info.get('region', '')
                    country = location_info.get('country', '')
                    localtime = location_info.get('localtime', 'N/A')

                    # Construct a cleaner location string
                    loc_parts = [part for part in [loc_name, region, country] if part]
                    full_loc = ", ".join(loc_parts) if loc_parts else weather_location

                    temp_c = current.get('temp_c')
                    temp_f = current.get('temp_f')
                    condition = current.get('condition', {}).get('text', 'N/A')
                    humidity = current.get('humidity')
                    wind_kph = current.get('wind_kph')
                    wind_dir = current.get('wind_dir')
                    feelslike_c = current.get('feelslike_c')
                    feelslike_f = current.get('feelslike_f')

                    # Build a structured summary for the AI prompt
                    weather_summary = (
                        f"Location Name: {loc_name}\n"
                        f"Region: {region}\n"
                        f"Country: {country}\n"
                        f"Local Time: {localtime}\n"
                        f"Temperature: {temp_c}°C ({temp_f}°F)\n"
                        f"Feels Like: {feelslike_c}°C ({feelslike_f}°F)\n"
                        f"Condition: {condition}\n"
                        f"Humidity: {humidity}%\n"
                        f"Wind: {wind_kph} kph from {wind_dir}"
                    )
                    logging.info(f"Weather data summary for prompt:\n{weather_summary}")

                    # Ask Gemini to create a natural response using ONLY the provided data
                    weather_response_prompt = f"""You are Friday, a helpful AI assistant reporting the current weather.
The user asked about '{weather_location}'. You have retrieved the following data:
---BEGIN WEATHER DATA---
{weather_summary}
---END WEATHER DATA---

Generate a concise, friendly, and informative response for the user based *strictly* on the provided data.
Mention the location name clearly. Include temperature (both C and F), the condition, and perhaps the 'feels like' temperature or wind.
Do not add any information not present in the data (like forecasts, warnings, or suggestions unless derived from the data).
Be conversational. Start naturally (e.g., "Okay, here's the current weather for..." or "Right now in...").
"""
                    ai_weather_response, weather_response_error = call_gemini(weather_response_prompt)

                    if weather_response_error:
                        logging.error(f"AI failed to generate response from weather data: {weather_response_error}")
                        # Provide a structured fallback if AI fails
                        final_response_text = (f"Okay, I found the weather for {full_loc}. "
                                               f"It's currently {condition} at {temp_c}°C ({temp_f}°F), "
                                               f"feeling like {feelslike_c}°C ({feelslike_f}°F).")
                        interaction_details["error_details"] = weather_response_error
                        interaction_details["final_response_source"] = "weather_data_fallback"
                    else:
                        final_response_text = ai_weather_response
                        interaction_details["final_response_source"] = "weather_ai_generated"

                except Exception as e:
                    # Catch errors during data processing/prompt creation
                    logging.exception("Error processing weather data or creating AI prompt.")
                    final_response_text = "I found the weather data, but encountered an internal issue while processing it. Please try again."
                    interaction_details["weather_api_success"] = False # Mark as failure if processing fails
                    interaction_details["error_details"] = f"Weather data processing error: {type(e).__name__}"
                    interaction_details["final_response_source"] = "weather_processing_error"
            else:
                 # This case should ideally not happen if get_weather is correct
                 logging.error("get_weather returned (None, None), which is unexpected.")
                 final_response_text = f"Sorry, an unknown issue occurred while trying to get the weather for '{weather_location}'."
                 interaction_details["weather_api_success"] = False
                 interaction_details["error_details"] = "Unknown weather API return state."
                 interaction_details["final_response_source"] = "weather_unknown_error"

        # === Step 3: Handle General Query (If not weather or weather flow failed) ===
        if final_response_text is None:
            logging.info("Handling as a general query (or fallback from weather)...")
            interaction_details["type"] = "general_query" # Ensure type is correct if falling back
            general_prompt = f"""You are Friday, a helpful and slightly witty AI assistant.
Answer the following user question based on your knowledge.

User Question: {question}
Answer:"""
            ai_general_response, general_error = call_gemini(general_prompt)

            if general_error:
                logging.error(f"Error during general AI query: {general_error}")
                final_response_text = f"Sorry, I encountered an issue answering that: {general_error}" # Inform user about the AI error
                interaction_details["error_details"] = general_error
                interaction_details["final_response_source"] = "general_ai_error"
            else:
                final_response_text = ai_general_response
                interaction_details["final_response_source"] = "general_ai_generated"


        # --- Final Response Generation ---
        # Ensure there's always some response text
        final_response_text = final_response_text or "Sorry, I couldn't generate a response at this moment."

        end_time = datetime.now()
        processing_time = (end_time - start_time).total_seconds()
        logging.info(f"Request processed in {processing_time:.2f} seconds. Response source: {interaction_details['final_response_source']}")

        # --- Store Interaction in MongoDB ---
        if mongodb_ready and collection is not None:
            interaction_data = {
                "timestamp": datetime.utcnow(),
                "request_ip": request.remote_addr,
                "question": question,
                "response": final_response_text,
                "model_used": GEMINI_MODEL_NAME,
                "processing_time_seconds": round(processing_time, 2),
                "details": interaction_details # Store rich metadata
            }
            try:
                insert_result = collection.insert_one(interaction_data)
                logging.info(f"Interaction stored in MongoDB with id: {insert_result.inserted_id}")
            except Exception as e:
                logging.exception("Error storing interaction in MongoDB.") # Log traceback for DB errors
        else:
            logging.warning("MongoDB not available. Interaction not stored.")

        # Return the final response to the frontend
        return jsonify({"response": final_response_text})

    except Exception as e:
        # Catch-all for any unexpected errors in the main try block
        logging.exception("Critical unexpected error occurred in /ask endpoint.")
        return jsonify({"error": "An critical internal server error occurred. Please check server logs."}), 500

# --- Main Execution ---
if __name__ == '__main__':
    # Get debug setting from environment, default to True (1) for development
    is_debug = os.environ.get('FLASK_DEBUG', '1') == '1'

    # SSL Configuration (for development HTTPS to enable microphone)
    cert_file = 'cert.pem'
    key_file = 'key.pem'
    ssl_context_to_use = None
    if os.path.exists(cert_file) and os.path.exists(key_file):
        ssl_context_to_use = (cert_file, key_file)
        server_type = "HTTPS"
    else:
        server_type = "HTTP"
        logging.warning(f"Certificate files ('{cert_file}', '{key_file}') not found.")
        logging.warning(f"Starting {server_type} server. Microphone input will likely fail in browsers on non-localhost addresses.")

    logging.info(f"Starting Flask server (Debug Mode: {is_debug}) using {server_type}...")

    # Run the Flask development server
    # NOTE: For production, use a proper WSGI server like Gunicorn or Waitress
    # Example: gunicorn --bind 0.0.0.0:5000 app:app (for HTTP)
    # Example: gunicorn --bind 0.0.0.0:5000 --certfile=cert.pem --keyfile=key.pem app:app (for HTTPS w/ Gunicorn)
    try:
        app.run(host='0.0.0.0', port=5000, debug=is_debug, ssl_context=ssl_context_to_use)
    except Exception as e:
        logging.exception(f"Failed to start Flask server: {e}")