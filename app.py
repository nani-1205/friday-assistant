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
from duckduckgo_search import DDGS # For Web Search

# --- Configuration ---
load_dotenv() # Load environment variables from .env file

# Logging Configuration
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(threadName)s - %(message)s')

# Flask App Initialization
app = Flask(__name__)

# --- API Keys / Model Configuration ---
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
GEMINI_MODEL_NAME = 'gemini-1.5-flash-latest' # Or 'gemini-1.0-pro', etc.
WEATHER_API_KEY = os.getenv('WEATHER_API_KEY')
model = None # Initialize model variable

# --- Google Gemini Initialization ---
if not GOOGLE_API_KEY:
    logging.error("FATAL: GOOGLE_API_KEY not found in environment variables. AI functionality disabled.")
else:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        model = genai.GenerativeModel(GEMINI_MODEL_NAME)
        logging.info(f"Google Gemini configured successfully with model: {GEMINI_MODEL_NAME}")
    except Exception as e:
        logging.error(f"FATAL: Error configuring Google Gemini or accessing model '{GEMINI_MODEL_NAME}'. AI functionality disabled. Error: {e}")
        model = None

if not WEATHER_API_KEY:
    logging.warning("WEATHER_API_KEY not found. Weather functionality will be disabled.")

# --- MongoDB Configuration ---
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
        logging.info(f"Attempting to connect to MongoDB at {MONGO_HOST} (DB: {MONGO_DB_NAME}, AuthDB: {MONGO_AUTH_DB})...")
        mongo_client = MongoClient(connection_string, serverSelectionTimeoutMS=15000, connectTimeoutMS=10000, socketTimeoutMS=10000)
        mongo_client.admin.command('ismaster')
        logging.info("MongoDB server is reachable.")
        db = mongo_client[MONGO_DB_NAME]
        logging.info(f"Using database: '{MONGO_DB_NAME}'")
        if MONGO_COLLECTION_NAME not in db.list_collection_names():
            logging.info(f"Collection '{MONGO_COLLECTION_NAME}' not found, creating it.")
            db.create_collection(MONGO_COLLECTION_NAME)
        else:
             logging.info(f"Using existing collection: '{MONGO_COLLECTION_NAME}'")
        collection = db[MONGO_COLLECTION_NAME]
        logging.info("MongoDB connection and collection setup successful.")
        return True
    except (ConnectionFailure, ServerSelectionTimeoutError) as e:
        logging.error(f"MongoDB Connection Error: Could not connect. Check network/firewall/credentials. Details: {e}")
        mongo_client = db = collection = None
        return False
    except OperationFailure as e:
        logging.error(f"MongoDB Authentication/Operation Error: Check credentials/authSource ('{MONGO_AUTH_DB}'). Details: {e.details}")
        mongo_client = db = collection = None
        return False
    except Exception as e:
        logging.exception(f"Unexpected error during MongoDB initialization: {e}")
        mongo_client = db = collection = None
        return False

mongodb_ready = initialize_mongodb()

# --- Weather API Function ---
def get_weather(location: str):
    """Fetches current weather data from WeatherAPI.com."""
    # ... (Keep the get_weather function exactly as in the previous full code example) ...
    if not WEATHER_API_KEY: return None, "Weather API key not configured on the server."
    base_url = "http://api.weatherapi.com/v1/current.json"
    params = {"key": WEATHER_API_KEY, "q": location, "aqi": "no"}
    headers = {"User-Agent": "FridayAssistant/1.0"}
    logging.debug(f"Requesting weather from WeatherAPI for location: {location}")
    try:
        response = requests.get(base_url, params=params, timeout=15, headers=headers)
        response.raise_for_status()
        weather_data = response.json()
        logging.info(f"Successfully fetched weather for {location} (Status: {response.status_code})")
        return weather_data, None
    except requests.exceptions.Timeout:
        logging.error(f"Timeout connecting to WeatherAPI for location: {location}")
        return None, "The weather service timed out. Please try again later."
    except requests.exceptions.HTTPError as http_err:
        status_code = http_err.response.status_code
        error_detail = f"HTTP error {status_code}"
        try:
             error_api_msg = http_err.response.json().get('error', {}).get('message', '')
             if error_api_msg: error_detail += f": {error_api_msg}"
        except: pass
        logging.error(f"HTTP error occurred fetching weather for {location}: {error_detail}")
        if status_code == 400: return None, f"Could not find weather data for '{location}'. ({error_api_msg or 'Check location'})"
        elif status_code in [401, 403]: return None, "Weather service authentication failed."
        else: return None, f"Weather service error ({error_detail})."
    except requests.exceptions.ConnectionError as conn_err:
         logging.error(f"Connection error fetching weather for {location}: {conn_err}")
         return None, "Could not connect to the weather service."
    except requests.exceptions.RequestException as req_err:
        logging.error(f"Generic request error fetching weather for {location}: {req_err}")
        return None, f"Network error fetching weather: {req_err}"
    except Exception as e:
        logging.exception(f"Unexpected error processing weather fetch for {location}: {e}")
        return None, "Unexpected internal error fetching weather data."


# --- DuckDuckGo Search Function ---
def perform_web_search(query: str, num_results: int = 5):
    """Performs a web search using DuckDuckGo Search library and returns processed results."""
    # ... (Keep the perform_web_search function exactly as in the previous full code example) ...
    logging.info(f"Performing DDG web search for query: '{query}' (max_results={num_results})")
    processed_results = []
    try:
        with DDGS(timeout=20) as ddgs:
            search_results = list(ddgs.text(query, region='wt-wt', safesearch='moderate', max_results=num_results, backend="lite"))
            if not search_results:
                logging.warning(f"DDG search for '{query}' returned no results.")
                return "", None
        for result in search_results:
            snippet = result.get("body", "").strip()
            title = result.get("title", "No title").strip()
            link = result.get("href", "#")
            if not snippet: continue
            max_snippet_len = 250
            processed_results.append(f"Title: {title}\nLink: {link}\nSnippet: {snippet[:max_snippet_len]}...")
        if not processed_results:
            logging.warning(f"DDG search processing yielded no usable results for '{query}'.")
            return "", None
        results_string = "\n---\n".join(processed_results)
        logging.info(f"DDG Web search successful for '{query}'. Found {len(processed_results)} usable results.")
        return results_string, None
    except Exception as e:
        logging.exception(f"Unexpected error during DDG web search for '{query}': {e}")
        return None, f"An unexpected error occurred during the web search ({type(e).__name__}). Please try again."


# --- Helper to call Gemini ---
def call_gemini(prompt: str, is_json_output: bool = False):
    """Helper function to call the Gemini API and handle basic errors/response."""
    # ... (Keep the call_gemini function exactly as in the previous full code example) ...
    if not model: return None, "AI Model is not available."
    mime_type = "application/json" if is_json_output else "text/plain"
    log_prompt_sample = prompt.replace('\n', ' ')[:200]
    logging.debug(f"Calling Gemini (Output: {mime_type}). Prompt sample: {log_prompt_sample}...")
    try:
        generation_config = genai.types.GenerationConfig(temperature=0.7, response_mime_type=mime_type)
        safety_settings = [{"category": c, "threshold": "BLOCK_MEDIUM_AND_ABOVE"} for c in genai.types.HarmCategory if c != genai.types.HarmCategory.HARM_CATEGORY_UNSPECIFIED]
        response = model.generate_content(prompt, generation_config=generation_config, safety_settings=safety_settings, request_options={'timeout': 60})
        response_text = None
        if response.parts: response_text = "".join(part.text for part in response.parts)
        elif response.candidates and response.candidates[0].content and response.candidates[0].content.parts: response_text = "".join(part.text for part in response.candidates[0].content.parts)
        if response_text:
            logging.debug(f"Gemini raw response sample: {response_text[:200]}...")
            return response_text, None
        elif response.prompt_feedback.block_reason:
            reason = response.prompt_feedback.block_reason.name
            logging.warning(f"Gemini request blocked by safety filter: {reason}")
            return None, f"My safety filters blocked the request ({reason}). Please rephrase."
        else:
            logging.error(f"Gemini returned empty/unexpected response: {response}")
            return None, "The AI returned an empty or unexpected response."
    except Exception as e:
        logging.exception(f"Core error during Gemini API call: {e}")
        error_detail = str(e)
        safety_reason = None
        try:
            if hasattr(e, 'response') and hasattr(e.response, 'prompt_feedback') and e.response.prompt_feedback.block_reason: safety_reason = e.response.prompt_feedback.block_reason.name
        except Exception: pass
        if safety_reason: return None, f"My safety filters may have blocked the request ({safety_reason})."
        return None, f"An error occurred communicating with the AI ({type(e).__name__})."


# --- Flask Routes ---
@app.route('/')
def index():
    """Renders the main chat interface."""
    return render_template('index.html')

@app.route('/ask', methods=['POST'])
def ask_assistant():
    """Handles user questions, routes to weather/search/general AI, stores data."""
    start_time = datetime.now()
    if not model:
        logging.error("Received /ask request but AI model is not available.")
        return jsonify({"error": "AI Model is not initialized. Cannot process request."}), 500

    try:
        data = request.get_json()
        if not data or not isinstance(data, dict):
            logging.warning(f"Invalid request format to /ask from {request.remote_addr}: Not JSON object.")
            return jsonify({"error": "Invalid request format."}), 400

        question = data.get('question', '').strip()
        if not question:
            logging.warning(f"Empty question received in /ask request from {request.remote_addr}.")
            return jsonify({"error": "Question cannot be empty."}), 400

        logging.info(f"Received question from {request.remote_addr}: \"{question}\"")

        final_response_text = None
        interaction_details = { # Metadata for logging/debugging
             "type": "general_query", "intent_analysis_success": None,
             "weather_api_called": False, "weather_location": None, "weather_api_success": None,
             "search_needed_check": False, "search_api_called": False, "search_query": None,
             "search_api_success": None, "final_response_source": "unknown", "error_details": None
        }

        # === Step 1: Weather Intent Analysis ===
        is_weather_query = False
        weather_location = None
        if WEATHER_API_KEY:
            # Using concise prompt for intent analysis
            intent_prompt = f"""Analyze the user query: "{question}". Is it asking for current weather or forecast? If yes, identify the location. Respond ONLY in JSON format: {{"is_weather_query": boolean, "location": string_or_null}}."""
            logging.debug("Sending weather intent analysis prompt...")
            intent_response_raw, intent_error = call_gemini(intent_prompt, is_json_output=True)
            if intent_error:
                logging.error(f"Weather intent analysis failed: {intent_error}")
                interaction_details["intent_analysis_success"] = False
                interaction_details["error_details"] = f"Intent analysis failed: {intent_error}"
            else:
                try: # Safely parse JSON
                    intent_response_clean = intent_response_raw.strip()
                    if intent_response_clean.startswith("```json"): intent_response_clean = intent_response_clean[7:-3].strip()
                    elif intent_response_clean.startswith("```"): intent_response_clean = intent_response_clean[3:-3].strip()
                    intent_data = json.loads(intent_response_clean)
                    is_weather_query = intent_data.get("is_weather_query") is True
                    weather_location = intent_data.get("location")
                    if isinstance(weather_location, str) and not weather_location.strip(): weather_location = None
                    interaction_details["intent_analysis_success"] = True
                    logging.info(f"Weather intent analysis result: is_weather={is_weather_query}, location='{weather_location}'")
                except Exception as e:
                    logging.exception(f"Error processing weather intent JSON: {e}. Raw: {intent_response_raw}")
                    interaction_details["intent_analysis_success"] = False
                    interaction_details["error_details"] = f"Intent JSON parse error: {type(e).__name__}"
        else:
            interaction_details["intent_analysis_success"] = None # Skipped

        # === Step 2: Handle Weather Query ===
        if is_weather_query and weather_location and WEATHER_API_KEY:
            interaction_details["type"] = "weather_query"
            interaction_details["weather_location"] = weather_location
            interaction_details["weather_api_called"] = True
            logging.info(f"Calling WeatherAPI for: '{weather_location}'")
            weather_data, weather_api_err_msg = get_weather(weather_location)

            if weather_api_err_msg:
                interaction_details["weather_api_success"] = False
                interaction_details["error_details"] = weather_api_err_msg
                logging.error(f"WeatherAPI error for '{weather_location}': {weather_api_err_msg}")
                 # ** USE OPTIMIZED ERROR PROMPT **
                error_format_prompt = f"""You are Friday. Inform the user politely but clearly about a weather lookup issue for '{weather_location}'. The specific problem encountered with the weather service was: '{weather_api_err_msg}'. Suggest checking the location name or trying again later."""
                ai_err_resp, _ = call_gemini(error_format_prompt)
                final_response_text = ai_err_resp or f"Sorry, couldn't get weather for '{weather_location}': {weather_api_err_msg}" # Fallback
                interaction_details["final_response_source"] = "weather_api_error_ai"
            elif weather_data:
                interaction_details["weather_api_success"] = True
                try:
                    current = weather_data.get('current', {})
                    loc = weather_data.get('location', {})
                    loc_name = loc.get('name', weather_location)
                    full_loc = ", ".join(filter(None, [loc.get(k) for k in ['name', 'region', 'country']])) or loc_name
                    temp_c, temp_f = current.get('temp_c'), current.get('temp_f')
                    feels_c, feels_f = current.get('feelslike_c'), current.get('feelslike_f')
                    condition = current.get('condition', {}).get('text', 'N/A')
                    wind_kph, wind_dir = current.get('wind_kph'), current.get('wind_dir')
                    weather_summary = f"Location: {full_loc}\nTemp: {temp_c}°C ({temp_f}°F)\nFeels Like: {feels_c}°C ({feels_f}°F)\nCondition: {condition}\nWind: {wind_kph} kph {wind_dir}"
                    logging.info(f"Weather data summary for prompt:\n{weather_summary}")

                     # ** USE OPTIMIZED WEATHER RESPONSE PROMPT **
                    weather_response_prompt = f"""You are Friday, reporting the current weather.
Based *only* on this data:
---BEGIN WEATHER DATA---
{weather_summary}
---END WEATHER DATA---

Provide a clear, friendly summary for the user. State the location ({full_loc}). Include the current temperature (C/F), the condition, and the 'feels like' temperature (C/F). Keep the response focused on the provided data.
Answer:"""
                    ai_weather_resp, format_err = call_gemini(weather_response_prompt)
                    if format_err:
                        logging.error(f"AI failed to format weather data: {format_err}")
                        final_response_text = f"Got weather for {full_loc}: {condition}, {temp_c}°C ({temp_f}°F)." # Fallback
                        interaction_details["error_details"] = format_err
                        interaction_details["final_response_source"] = "weather_data_fallback"
                    else:
                        final_response_text = ai_weather_resp
                        interaction_details["final_response_source"] = "weather_ai_generated"
                except Exception as e:
                    logging.exception("Error processing weather data.")
                    final_response_text = "Found weather data, but had trouble processing it."
                    interaction_details["weather_api_success"] = False
                    interaction_details["error_details"] = f"Weather data processing error: {type(e).__name__}"
                    interaction_details["final_response_source"] = "weather_processing_error"
            # Else case (None, None) from get_weather handled by outer logic

        # === Step 3: If NOT weather, check if search is needed ===
        if final_response_text is None:
            interaction_details["search_needed_check"] = True
            # Using concise prompt for search check
            search_check_prompt = f"""Does answering user query "{question}" likely require recent info/web search? Respond ONLY JSON: {{"search_needed": boolean, "search_query": string_or_null}}."""
            logging.debug("Sending search needed prompt...")
            search_check_raw, search_check_error = call_gemini(search_check_prompt, is_json_output=True)

            search_needed = False
            search_query = None
            if search_check_error:
                 logging.error(f"Search needed check failed: {search_check_error}")
                 interaction_details["error_details"] = f"Search check failed: {search_check_error}"
            else:
                try: # Parse JSON safely
                    search_check_clean = search_check_raw.strip()
                    if search_check_clean.startswith("```json"): search_check_clean = search_check_clean[7:-3].strip()
                    elif search_check_clean.startswith("```"): search_check_clean = search_check_clean[3:-3].strip()
                    search_check_data = json.loads(search_check_clean)
                    search_needed = search_check_data.get("search_needed") is True
                    search_query = search_check_data.get("search_query")
                    if isinstance(search_query, str) and not search_query.strip(): search_query = None
                    interaction_details["search_query"] = search_query
                    logging.info(f"Search needed check result: needed={search_needed}, query='{search_query}'")
                except Exception as e:
                     logging.exception(f"Error processing search needed JSON: {e}")
                     interaction_details["error_details"] = f"Search check JSON parse error: {type(e).__name__}"

            # === Step 4: Perform Web Search if Needed ===
            if search_needed and search_query:
                interaction_details["type"] = "search_query"
                interaction_details["search_api_called"] = True
                logging.info(f"Calling DDG search for: '{search_query}'")
                search_results_str, search_api_err_msg = perform_web_search(search_query)

                if search_api_err_msg: # Search function itself failed
                    interaction_details["search_api_success"] = False
                    interaction_details["error_details"] = search_api_err_msg
                    logging.error(f"Web search function error for '{search_query}': {search_api_err_msg}")
                     # ** USE OPTIMIZED SEARCH ERROR PROMPT **
                    error_formulation_prompt = f"""You are Friday. Inform the user politely but clearly about a technical problem encountered while trying to search the web regarding '{search_query}'. The specific internal error was: '{search_api_err_msg}'. Apologize for the inconvenience."""
                    ai_err_resp, _ = call_gemini(error_formulation_prompt)
                    final_response_text = ai_err_resp or f"Sorry, technical issue searching web: {search_api_err_msg}" # Fallback
                    interaction_details["final_response_source"] = "search_function_error_ai"
                else: # Search function ran (results could be empty string)
                    interaction_details["search_api_success"] = True
                    # ** USE OPTIMIZED SYNTHESIS PROMPT **
                    synthesis_prompt = f"""You are Friday, an AI assistant focused on providing clear and relevant answers.
The user asked: "{question}"
You performed a web search for "{search_query}". Key findings:
---BEGIN SEARCH RESULTS---
{search_results_str if search_results_str else "No specific results were found for this query."}
---END SEARCH RESULTS---

Based *strictly* on the provided search results, answer the user's original question directly and concisely.
*   If the results provide a clear answer (e.g., one specific match, a direct fact), state it.
*   If the results mention multiple relevant items (e.g., several matches today) and the user asked for a singular item (like '*the* match'), try to identify the most prominent or likely intended item (e.g., the main evening fixture, the next upcoming event) based *only* on information within the results (like times or emphasis). State this is your interpretation based on the search.
*   If multiple items seem equally important or the results are ambiguous, list the key items briefly.
*   If no relevant results were found, clearly state that you couldn't find the specific information via search. You may then offer a general knowledge answer if appropriate, but clearly distinguish it from the search findings.

Provide only the answer, without conversational filler like "Based on the results..." unless necessary for clarity about ambiguity.
Answer:"""
                    logging.debug("Sending search results synthesis prompt...")
                    ai_search_resp, synthesis_error = call_gemini(synthesis_prompt)
                    if synthesis_error:
                        logging.error(f"AI failed to synthesize search results: {synthesis_error}")
                        final_response_text = f"I looked online for '{search_query}' but had trouble summarizing the findings. You might want to try searching directly." # Fallback
                        interaction_details["error_details"] = synthesis_error
                        interaction_details["final_response_source"] = "search_synthesis_error"
                    else:
                        final_response_text = ai_search_resp
                        interaction_details["final_response_source"] = "search_ai_generated"

        # === Step 5: Handle General Query (Fallback) ===
        if final_response_text is None:
            logging.info("Handling as a general query (fallback)...")
            interaction_details["type"] = "general_query"
            # ** USE OPTIMIZED GENERAL PROMPT **
            general_prompt = f"""You are Friday, a helpful AI assistant providing clear answers.
Answer the following user question concisely based on your general knowledge. If the topic is very recent, you can note your knowledge might have a cutoff date.

User Question: {question}
Answer:"""
            ai_general_response, general_error = call_gemini(general_prompt)
            if general_error:
                logging.error(f"General AI query failed: {general_error}")
                final_response_text = f"Sorry, I had an issue processing that: {general_error}"
                interaction_details["error_details"] = general_error
                interaction_details["final_response_source"] = "general_ai_error"
            else:
                final_response_text = ai_general_response
                interaction_details["final_response_source"] = "general_ai_generated"


        # --- Final Response & DB Logging ---
        final_response_text = final_response_text or "My apologies, I couldn't generate a suitable response." # Final fallback
        end_time = datetime.now()
        processing_time = (end_time - start_time).total_seconds()
        logging.info(f"Request processed in {processing_time:.2f} seconds. Source: {interaction_details['final_response_source']}")

        if mongodb_ready and collection is not None:
            interaction_data = {
                "timestamp": datetime.utcnow(), "request_ip": request.remote_addr,
                "question": question, "response": final_response_text,
                "model_used": GEMINI_MODEL_NAME, "processing_time_seconds": round(processing_time, 2),
                "details": interaction_details # Store rich metadata
            }
            try:
                collection.insert_one(interaction_data)
                logging.debug("Interaction stored in MongoDB.")
            except Exception as e:
                logging.exception("Error storing interaction in MongoDB.") # Log traceback
        else:
            logging.warning("MongoDB not ready. Interaction not stored.")

        return jsonify({"response": final_response_text})

    except Exception as e:
        # Catch-all for any unexpected errors in the main try block
        logging.exception("Critical unexpected error occurred in /ask endpoint.")
        return jsonify({"error": "A critical internal server error occurred. Please check server logs."}), 500

# --- Main Execution ---
if __name__ == '__main__':
    is_debug = os.environ.get('FLASK_DEBUG', '1') == '1'
    # SSL Configuration (for dev HTTPS / mic access)
    cert_file = 'cert.pem'
    key_file = 'key.pem'
    ssl_context_to_use = None
    server_type = "HTTP"
    if os.path.exists(cert_file) and os.path.exists(key_file):
        ssl_context_to_use = (cert_file, key_file)
        server_type = "HTTPS"
        logging.info(f"Found certificates ('{cert_file}', '{key_file}').")
    else:
        logging.warning(f"Certificates ('{cert_file}', '{key_file}') not found.")
        logging.warning(f"Starting {server_type} server. Microphone may fail on non-localhost addresses.")

    logging.info(f"Starting Flask Assistant server (Debug: {is_debug}) via {server_type}...")
    try:
        # Production Note: Use waitress or gunicorn instead of app.run()
        # Example: waitress-serve --host 0.0.0.0 --port 5000 app:app
        app.run(host='0.0.0.0', port=5000, debug=is_debug, ssl_context=ssl_context_to_use)
    except Exception as e:
        logging.exception(f"Failed to start Flask server: {e}")