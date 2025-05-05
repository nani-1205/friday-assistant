# app.py
import os
import logging
from datetime import datetime, timezone
from flask import Flask, render_template, request, jsonify
import google.generativeai as genai
from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError, OperationFailure
from dotenv import load_dotenv
from urllib.parse import quote_plus
import requests # For WeatherAPI calls
import json     # For parsing Gemini's intent response
from duckduckgo_search import DDGS # For Web Search
import traceback # For logging exception details

# --- Configuration ---
load_dotenv() # Load environment variables from .env file

# Logging Configuration (Consider adjusting level and handler for production)
logging.basicConfig(
    level=logging.INFO,  # Use INFO or DEBUG for development, INFO or WARNING for production
    format='%(asctime)s - %(levelname)s - %(threadName)s - [%(filename)s:%(lineno)d] - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logging.getLogger("urllib3").setLevel(logging.WARNING) # Quieter library logging

# Flask App Initialization
app = Flask(__name__)

# --- API Keys / Model Configuration ---
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
GEMINI_MODEL_NAME = os.getenv('GEMINI_MODEL_NAME', 'gemini-1.5-pro-latest') # Allow override via env
WEATHER_API_KEY = os.getenv('WEATHER_API_KEY')
model = None # Initialize model variable

# --- Google Gemini Initialization ---
if not GOOGLE_API_KEY:
    logging.critical("FATAL: GOOGLE_API_KEY not found in environment variables. AI functionality disabled.")
else:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        model = genai.GenerativeModel(GEMINI_MODEL_NAME)
        # Optional quick test call (uncomment carefully - consumes quota)
        # logging.debug(f"Testing Gemini model {GEMINI_MODEL_NAME}...")
        # model.generate_content("test", generation_config=genai.types.GenerationConfig(candidate_count=1))
        logging.info(f"Google Gemini configured successfully with model: {GEMINI_MODEL_NAME}")
    except Exception as e:
        logging.critical(f"FATAL: Error configuring Google Gemini or accessing model '{GEMINI_MODEL_NAME}'. AI functionality disabled. Error: {e}", exc_info=True)
        model = None # Ensure model is None if setup fails

if not WEATHER_API_KEY:
    logging.warning("WEATHER_API_KEY not found. Weather functionality will be disabled.")

# --- MongoDB Configuration ---
MONGO_USER = os.getenv('MONGO_USER')
MONGO_PASSWORD = os.getenv('MONGO_PASSWORD')
MONGO_HOST = os.getenv('MONGO_HOST')
MONGO_PORT = os.getenv('MONGO_PORT', '27017')
MONGO_DB_NAME = os.getenv('MONGO_DB_NAME', 'friday_assistant_db') # Default DB name
MONGO_COLLECTION_NAME = os.getenv('MONGO_COLLECTION_NAME', 'interactions') # Default collection name
MONGO_AUTH_DB = os.getenv('MONGO_AUTH_DB', 'admin')

mongo_client = None
db = None
collection = None

# --- MongoDB Initialization Function ---
def initialize_mongodb():
    """Initializes MongoDB connection and ensures database/collection exist."""
    global mongo_client, db, collection
    required_mongo_vars = [MONGO_USER, MONGO_PASSWORD, MONGO_HOST, MONGO_DB_NAME, MONGO_COLLECTION_NAME]
    if not all(required_mongo_vars):
        missing_vars = [name for name, var in zip(["MONGO_USER", "MONGO_PASSWORD", "MONGO_HOST", "MONGO_DB_NAME", "MONGO_COLLECTION_NAME"], required_mongo_vars) if not var]
        logging.error(f"MongoDB environment variables incomplete ({', '.join(missing_vars)} missing). Database connection skipped.")
        return False
    try:
        escaped_user = quote_plus(MONGO_USER)
        escaped_password = quote_plus(MONGO_PASSWORD)
        if MONGO_HOST.startswith("mongodb+srv://"):
             host_part = MONGO_HOST.split('@')[-1]
             connection_string = f"mongodb+srv://{escaped_user}:{escaped_password}@{host_part}/?retryWrites=true&w=majority&authSource={MONGO_AUTH_DB}"
        else:
             connection_string = f"mongodb://{escaped_user}:{escaped_password}@{MONGO_HOST}:{MONGO_PORT}/?authSource={MONGO_AUTH_DB}"

        logging.info(f"Attempting to connect to MongoDB: {MONGO_HOST.split('@')[-1]} (DB: {MONGO_DB_NAME}, AuthDB: {MONGO_AUTH_DB})...")
        mongo_client = MongoClient(
            connection_string,
            serverSelectionTimeoutMS=15000, # Allow more time for server selection
            connectTimeoutMS=10000,
            socketTimeoutMS=10000,
            appname="FridayAssistant" # Identify application to MongoDB server
        )
        # The ismaster command is cheap and does not require auth. Checks reachability.
        mongo_client.admin.command('ping') # Use ping command for modern check
        logging.info("MongoDB server ping successful.")

        db = mongo_client[MONGO_DB_NAME]
        logging.info(f"Using database: '{MONGO_DB_NAME}'")

        if MONGO_COLLECTION_NAME not in db.list_collection_names():
            logging.info(f"Collection '{MONGO_COLLECTION_NAME}' not found, creating it.")
            db.create_collection(MONGO_COLLECTION_NAME)
            # Create indexes after collection creation for performance
            logging.info("Creating indexes on 'timestamp'...")
            collection = db[MONGO_COLLECTION_NAME] # Assign collection *before* creating index
            collection.create_index([("timestamp", DESCENDING)])
        else:
             collection = db[MONGO_COLLECTION_NAME] # Assign existing collection
             logging.info(f"Using existing collection: '{MONGO_COLLECTION_NAME}'")

        logging.info("MongoDB connection and collection setup successful.")
        return True

    except (ConnectionFailure, ServerSelectionTimeoutError) as e:
        logging.error(f"MongoDB Connection Error: Could not connect to {MONGO_HOST.split('@')[-1]}. Check network/firewall/credentials. Details: {e}", exc_info=False) # No need for full traceback usually
        mongo_client = db = collection = None; return False
    except OperationFailure as e:
        logging.error(f"MongoDB Authentication/Operation Error: Check credentials/permissions for DB '{MONGO_DB_NAME}'/AuthDB '{MONGO_AUTH_DB}'. Details: {e.details}", exc_info=False)
        mongo_client = db = collection = None; return False
    except Exception as e:
        logging.exception(f"An unexpected error occurred during MongoDB initialization: {e}") # Log full traceback for unexpected errors
        mongo_client = db = collection = None; return False

mongodb_ready = initialize_mongodb()

# --- Weather API Function ---
def get_weather(location: str):
    """Fetches current weather data from WeatherAPI.com."""
    if not WEATHER_API_KEY: return None, "Weather API key not configured on the server."
    base_url = "http://api.weatherapi.com/v1/current.json"; params = {"key": WEATHER_API_KEY, "q": location, "aqi": "no"}; headers = {"User-Agent": "FridayAssistant/1.0"}
    logging.debug(f"Requesting weather from WeatherAPI for location: {location}")
    try:
        response = requests.get(base_url, params=params, timeout=15, headers=headers); response.raise_for_status()
        weather_data = response.json(); logging.info(f"Successfully fetched weather for {location} (Status: {response.status_code})"); return weather_data, None
    except requests.exceptions.Timeout: logging.error(f"Timeout connecting to WeatherAPI for location: {location}"); return None, "The weather service timed out. Please try again later."
    except requests.exceptions.HTTPError as http_err:
        status_code = http_err.response.status_code; error_detail = f"HTTP error {status_code}"; error_api_msg = ""
        try: error_api_msg = http_err.response.json().get('error', {}).get('message', ''); error_detail += f": {error_api_msg}" if error_api_msg else ""
        except: pass
        logging.error(f"HTTP error occurred fetching weather for {location}: {error_detail}")
        if status_code == 400: return None, f"Could not find weather data for '{location}'. ({error_api_msg or 'Check location'})"
        elif status_code in [401, 403]: return None, "Weather service authentication/authorization failed."
        else: return None, f"Weather service returned an error ({error_detail})."
    except requests.exceptions.ConnectionError as conn_err: logging.error(f"Connection error fetching weather for {location}: {conn_err}"); return None, "Could not connect to the weather service."
    except requests.exceptions.RequestException as req_err: logging.error(f"Generic request error fetching weather for {location}: {req_err}"); return None, f"Network error fetching weather: {req_err}"
    except Exception as e: logging.exception(f"Unexpected error processing weather fetch for {location}: {e}"); return None, "Unexpected internal error fetching weather data."

# --- DuckDuckGo Search Function ---
def perform_web_search(query: str, num_results: int = 5):
    """Performs a web search using DuckDuckGo Search library and returns processed results."""
    logging.info(f"Performing DDG web search for query: '{query}' (max_results={num_results})")
    processed_results = []; search_results = []
    try:
        with DDGS(timeout=20) as ddgs: # Increased timeout
            search_results = list(ddgs.text(query, region='wt-wt', safesearch='moderate', max_results=num_results, backend="lite")) # Use reliable 'lite' backend
        if not search_results: logging.warning(f"DDG search for '{query}' returned no results."); return "", None # Return empty string for no results
        for result in search_results:
            snippet = result.get("body", "").strip(); title = result.get("title", "No title").strip(); link = result.get("href", "#")
            if not snippet or not title: continue # Skip results without title or body
            max_snippet_len = 300; processed_results.append(f"Title: {title}\nLink: {link}\nSnippet: {snippet[:max_snippet_len]}...") # Slightly longer snippet
        if not processed_results: logging.warning(f"DDG search processing yielded no usable results for '{query}'."); return "", None
        results_string = "\n\n---\n\n".join(processed_results); logging.info(f"DDG Web search successful for '{query}'. Found {len(processed_results)} usable results."); return results_string, None
    except Exception as e: logging.exception(f"Unexpected error during DDG web search for '{query}': {e}"); return None, f"An unexpected error occurred during the web search ({type(e).__name__})."

# --- Helper to call Gemini ---
def call_gemini(prompt: str, is_json_output: bool = False):
    """Helper function to call the Gemini API and handle basic errors/response."""
    if not model: logging.error("call_gemini attempted but AI Model is not initialized."); return None, "AI Model is not available."
    mime_type = "application/json" if is_json_output else "text/plain"; log_prompt_sample = prompt.replace('\n', ' ')[:200]
    logging.debug(f"Calling Gemini (Output: {mime_type}). Prompt length: {len(prompt)}. Sample: {log_prompt_sample}...")
    try:
        generation_config = genai.types.GenerationConfig(
            temperature=0.6, # Slightly lower temp for more factual synthesis
            response_mime_type=mime_type
        )
        # Ensure all categories use default safety unless specifically overridden
        safety_settings = [
            {"category": c, "threshold": "BLOCK_MEDIUM_AND_ABOVE"}
            for c in genai.types.HarmCategory if c != genai.types.HarmCategory.HARM_CATEGORY_UNSPECIFIED
        ]
        response = model.generate_content(
            prompt,
            generation_config=generation_config,
            safety_settings=safety_settings,
            request_options={'timeout': 90} # Increased timeout for potentially complex synthesis
        )
        response_text = None # Handle cases where response might not have expected structure
        if response.parts: response_text = "".join(part.text for part in response.parts)
        elif response.candidates and response.candidates[0].content and response.candidates[0].content.parts: response_text = "".join(part.text for part in response.candidates[0].content.parts)

        if response_text: logging.debug(f"Gemini raw response sample: {response_text[:200]}..."); return response_text, None
        elif response.prompt_feedback.block_reason:
            reason = response.prompt_feedback.block_reason.name; logging.warning(f"Gemini request blocked by safety filter: {reason}"); return None, f"My safety filters blocked the request ({reason}). Please rephrase."
        else: logging.error(f"Gemini returned empty/unexpected response structure: {response}"); return None, "The AI returned an empty or unexpected response."
    except Exception as e:
        logging.exception(f"Core error during Gemini API call: {e}") # Log full traceback
        error_detail = str(e); safety_reason = None
        try:
            if hasattr(e, 'response') and hasattr(e.response, 'prompt_feedback') and e.response.prompt_feedback.block_reason: safety_reason = e.response.prompt_feedback.block_reason.name
        except Exception: pass
        if safety_reason: return None, f"My safety filters may have blocked the request ({safety_reason})."
        # Check for specific common API errors if desired (e.g., DeadlineExceeded)
        # from google.api_core import exceptions as google_exceptions
        # if isinstance(e, google_exceptions.DeadlineExceeded): return None, "The request to the AI timed out."
        return None, f"An error occurred communicating with the AI ({type(e).__name__}). Please check server logs."

# --- Flask Routes ---
@app.route('/')
def index():
    """Renders the main chat interface."""
    return render_template('index.html')

@app.route('/ask', methods=['POST'])
def ask_assistant():
    """Handles user questions, routes to weather/search/general AI, stores data."""
    start_time = datetime.now(timezone.utc) # Use timezone-aware datetime
    remote_addr = request.remote_addr
    if not model: logging.error(f"Received /ask from {remote_addr} but AI model is not available."); return jsonify({"error": "AI Model is not initialized. Cannot process request."}), 500
    try:
        data = request.get_json()
        if not data or not isinstance(data, dict): logging.warning(f"Invalid request format to /ask from {remote_addr}: Not JSON object."); return jsonify({"error": "Invalid request format."}), 400
        question = data.get('question', '').strip()
        if not question: logging.warning(f"Empty question received in /ask request from {remote_addr}."); return jsonify({"error": "Question cannot be empty."}), 400
        logging.info(f"Received question from {remote_addr}: \"{question}\"")
        final_response_text = None
        interaction_details = {"type": "general_query", "intent_analysis_success": None, "weather_api_called": False, "weather_location": None, "weather_api_success": None, "search_needed_check": False, "search_api_called": False, "search_query": None, "search_api_success": None, "final_response_source": "unknown", "error_details": None}

        # === Step 1: Weather Intent Analysis ===
        is_weather_query, weather_location = False, None
        if WEATHER_API_KEY:
            intent_prompt = f"""Analyze the user query: "{question}". Is it asking for current weather or forecast? If yes, identify the location. Respond ONLY in JSON format: {{"is_weather_query": boolean, "location": string_or_null}}."""
            logging.debug("Sending weather intent analysis prompt..."); intent_response_raw, intent_error = call_gemini(intent_prompt, is_json_output=True)
            if intent_error: logging.error(f"Weather intent analysis failed: {intent_error}"); interaction_details.update({"intent_analysis_success": False, "error_details": f"Intent analysis failed: {intent_error}"})
            else:
                try:
                    intent_response_clean = intent_response_raw.strip();
                    if intent_response_clean.startswith("```json"): intent_response_clean = intent_response_clean[7:-3].strip()
                    elif intent_response_clean.startswith("```"): intent_response_clean = intent_response_clean[3:-3].strip()
                    intent_data = json.loads(intent_response_clean); is_weather_query = intent_data.get("is_weather_query") is True; weather_location = intent_data.get("location");
                    if isinstance(weather_location, str) and not weather_location.strip(): weather_location = None
                    interaction_details["intent_analysis_success"] = True; logging.info(f"Weather intent analysis result: is_weather={is_weather_query}, location='{weather_location}'")
                except Exception as e: logging.exception(f"Error processing weather intent JSON: {e}. Raw: {intent_response_raw}"); interaction_details.update({"intent_analysis_success": False, "error_details": f"Intent JSON parse error: {type(e).__name__}"})
        else: interaction_details["intent_analysis_success"] = None

        # === Step 2: Handle Weather Query ===
        if is_weather_query and weather_location and WEATHER_API_KEY:
            interaction_details.update({"type": "weather_query", "weather_location": weather_location, "weather_api_called": True}); logging.info(f"Calling WeatherAPI for: '{weather_location}'")
            weather_data, weather_api_err_msg = get_weather(weather_location)
            if weather_api_err_msg:
                interaction_details.update({"weather_api_success": False, "error_details": weather_api_err_msg}); logging.error(f"WeatherAPI error for '{weather_location}': {weather_api_err_msg}")
                error_format_prompt = f"You are Friday. Inform the user politely but clearly about a weather lookup issue for '{weather_location}'. The specific problem encountered with the weather service was: '{weather_api_err_msg}'. Suggest checking the location name or trying again later."
                ai_err_resp, _ = call_gemini(error_format_prompt); final_response_text = ai_err_resp or f"Sorry, couldn't get weather for '{weather_location}': {weather_api_err_msg}"; interaction_details["final_response_source"] = "weather_api_error_ai"
            elif weather_data:
                interaction_details["weather_api_success"] = True
                try:
                    current = weather_data.get('current', {}); loc = weather_data.get('location', {}); loc_name = loc.get('name', weather_location); full_loc = ", ".join(filter(None, [loc.get(k) for k in ['name', 'region', 'country']])) or loc_name
                    temp_c, temp_f = current.get('temp_c'), current.get('temp_f'); feels_c, feels_f = current.get('feelslike_c'), current.get('feelslike_f'); condition = current.get('condition', {}).get('text', 'N/A'); wind_kph, wind_dir = current.get('wind_kph'), current.get('wind_dir')
                    weather_summary = f"Location: {full_loc}\nTemp: {temp_c}°C ({temp_f}°F)\nFeels Like: {feels_c}°C ({feels_f}°F)\nCondition: {condition}\nWind: {wind_kph} kph {wind_dir}"; logging.info(f"Weather data summary for prompt:\n{weather_summary}")
                    weather_response_prompt = f"You are Friday, reporting the current weather. Based *only* on this data:\n---\n{weather_summary}\n---\nProvide a clear, friendly summary for the user. State the location ({full_loc}). Include the current temperature (C/F), the condition, and the 'feels like' temperature (C/F). Keep the response focused on the provided data. Answer:"
                    ai_weather_resp, format_err = call_gemini(weather_response_prompt)
                    if format_err: logging.error(f"AI failed to format weather data: {format_err}"); final_response_text = f"Got weather for {full_loc}: {condition}, {temp_c}°C ({temp_f}°F)."; interaction_details.update({"error_details": format_err, "final_response_source": "weather_data_fallback"})
                    else: final_response_text = ai_weather_resp; interaction_details["final_response_source"] = "weather_ai_generated"
                except Exception as e: logging.exception("Error processing weather data."); final_response_text = "Found weather data, but had trouble processing it."; interaction_details.update({"weather_api_success": False, "error_details": f"Weather data processing error: {type(e).__name__}", "final_response_source": "weather_processing_error"})

        # === Step 3: If NOT weather, check if search is needed ===
        if final_response_text is None:
            interaction_details["search_needed_check"] = True; search_needed, search_query = False, None
            search_check_prompt = f"""Analyze the user's query. Does answering it likely require searching the internet for current information (today/yesterday), recent events, specific facts (stock prices, scores), or details beyond common knowledge? User Query: "{question}". Respond ONLY with a valid JSON object: {{"search_needed": boolean, "search_query": string_or_null (effective query if needed)}}."""
            logging.debug("Sending search needed prompt..."); search_check_raw, search_check_error = call_gemini(search_check_prompt, is_json_output=True)
            if search_check_error: logging.error(f"Search needed check failed: {search_check_error}"); interaction_details["error_details"] = f"Search check failed: {search_check_error}"
            else:
                try:
                    search_check_clean = search_check_raw.strip();
                    if search_check_clean.startswith("```json"): search_check_clean = search_check_clean[7:-3].strip()
                    elif search_check_clean.startswith("```"): search_check_clean = search_check_clean[3:-3].strip()
                    search_check_data = json.loads(search_check_clean); search_needed = search_check_data.get("search_needed") is True; search_query = search_check_data.get("search_query")
                    if isinstance(search_query, str) and not search_query.strip(): search_query = None
                    interaction_details["search_query"] = search_query; logging.info(f"Search needed check result: needed={search_needed}, query='{search_query}'")
                except Exception as e: logging.exception(f"Error processing search needed JSON: {e}"); interaction_details["error_details"] = f"Search check JSON parse error: {type(e).__name__}"

            # === Step 4: Perform Web Search if Needed ===
            if search_needed and search_query:
                interaction_details.update({"type": "search_query", "search_api_called": True}); logging.info(f"Calling DDG search for: '{search_query}'")
                search_results_str, search_api_err_msg = perform_web_search(search_query)
                if search_api_err_msg:
                    interaction_details.update({"search_api_success": False, "error_details": search_api_err_msg}); logging.error(f"Web search function error for '{search_query}': {search_api_err_msg}")
                    error_formulation_prompt = f"You are Friday. Inform the user politely but clearly about a technical problem encountered while trying to search the web regarding '{search_query}'. The specific internal error was: '{search_api_err_msg}'. Apologize for the inconvenience."
                    ai_err_resp, _ = call_gemini(error_formulation_prompt); final_response_text = ai_err_resp or f"Sorry, technical issue searching web: {search_api_err_msg}"; interaction_details["final_response_source"] = "search_function_error_ai"
                else:
                    interaction_details["search_api_success"] = True
                    # ** USE OPTIMIZED SYNTHESIS PROMPT **
                    synthesis_prompt = f"""You are Friday, an AI assistant focused on providing clear and relevant answers. The user asked: "{question}". You performed a web search for "{search_query}". Key findings:\n---BEGIN SEARCH RESULTS---\n{search_results_str if search_results_str else "No specific results were found for this query."}\n---END SEARCH RESULTS---\nBased *strictly* on the provided search results, answer the user's original question directly and concisely. * If the results provide a clear answer, state it. * If multiple relevant items are mentioned (e.g., several matches) and the user asked for a singular item (like '*the* match'), try to identify the most prominent or likely intended item based *only* on info within the results (like times/emphasis). State this is your interpretation. * If multiple items seem equally important or results are ambiguous, list key items briefly. * If no relevant results were found, clearly state that. You may then offer a general knowledge answer if appropriate, distinguishing it clearly. Provide only the answer, without conversational filler like "Based on the results..." unless necessary for clarity. Answer:"""
                    logging.debug("Sending search results synthesis prompt..."); ai_search_resp, synthesis_error = call_gemini(synthesis_prompt)
                    if synthesis_error: logging.error(f"AI failed to synthesize search results: {synthesis_error}"); final_response_text = f"I looked online for '{search_query}' but had trouble summarizing the findings."; interaction_details.update({"error_details": synthesis_error, "final_response_source": "search_synthesis_error"})
                    else: final_response_text = ai_search_resp; interaction_details["final_response_source"] = "search_ai_generated"

        # === Step 5: Handle General Query (Fallback) ===
        if final_response_text is None:
            logging.info("Handling as a general query (fallback)..."); interaction_details["type"] = "general_query"
            # ** USE OPTIMIZED GENERAL PROMPT **
            general_prompt = f"You are Friday, a helpful AI assistant providing clear answers. Answer the following user question concisely based on your general knowledge. If the topic is very recent, you can note your knowledge might have a cutoff date. User Question: {question}. Answer:"
            ai_general_response, general_error = call_gemini(general_prompt)
            if general_error: logging.error(f"General AI query failed: {general_error}"); final_response_text = f"Sorry, I had an issue processing that: {general_error}"; interaction_details.update({"error_details": general_error, "final_response_source": "general_ai_error"})
            else: final_response_text = ai_general_response; interaction_details["final_response_source"] = "general_ai_generated"

        # --- Final Response & DB Logging ---
        final_response_text = final_response_text or "My apologies, I couldn't generate a suitable response." # Final fallback
        end_time = datetime.now(timezone.utc); processing_time = (end_time - start_time).total_seconds()
        logging.info(f"Request from {remote_addr} processed in {processing_time:.2f} seconds. Source: {interaction_details['final_response_source']}")
        if mongodb_ready and collection is not None:
            interaction_data = {"timestamp": datetime.now(timezone.utc), "request_ip": remote_addr, "question": question, "response": final_response_text, "model_used": GEMINI_MODEL_NAME, "processing_time_seconds": round(processing_time, 2), "details": interaction_details}
            try: collection.insert_one(interaction_data); logging.debug("Interaction stored in MongoDB.")
            except Exception as e: logging.exception("Error storing interaction in MongoDB.") # Log DB errors fully
        else: logging.warning("MongoDB not ready. Interaction not stored.")
        return jsonify({"response": final_response_text})

    except Exception as e:
        # Catch-all for truly unexpected errors in the main request handler
        logging.exception(f"Critical unexpected error occurred processing request from {remote_addr} for question: '{data.get('question', 'N/A') if data else 'N/A'}'")
        return jsonify({"error": "A critical internal server error occurred. Please check server logs for details."}), 500

# --- Main Execution ---
if __name__ == '__main__':
    is_debug = os.environ.get('FLASK_DEBUG', '1') == '1'
    # SSL Configuration (for dev HTTPS / mic access)
    cert_file, key_file, ssl_context_to_use, server_type = 'cert.pem', 'key.pem', None, "HTTP"
    if os.path.exists(cert_file) and os.path.exists(key_file): ssl_context_to_use = (cert_file, key_file); server_type = "HTTPS"; logging.info(f"Found certificates ('{cert_file}', '{key_file}').")
    else: logging.warning(f"Certificates ('{cert_file}', '{key_file}') not found. Starting {server_type} server. Microphone access may fail on non-localhost addresses.")
    logging.info(f"Starting Flask Assistant server (Debug: {is_debug}) via {server_type}...")
    try:
        # Production Note: Use a production WSGI server like Gunicorn or Waitress.
        # Example: waitress-serve --host 0.0.0.0 --port 5000 app:app
        app.run(host='0.0.0.0', port=5000, debug=is_debug, ssl_context=ssl_context_to_use)
    except Exception as e:
        logging.exception(f"Failed to start Flask server: {e}")