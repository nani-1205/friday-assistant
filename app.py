# app.py
import os
import logging
from datetime import datetime, timezone
from flask import Flask, render_template, request, jsonify
import google.generativeai as genai
from pymongo import MongoClient, DESCENDING
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError, OperationFailure
from dotenv import load_dotenv
from urllib.parse import quote_plus
import requests # For WeatherAPI calls
import json     # For parsing Gemini's intent response
from duckduckgo_search import DDGS # For Web Search
import traceback # For logging exception details

# --- Configuration ---
load_dotenv() # Load environment variables from .env file

# Logging Configuration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(threadName)s - [%(filename)s:%(lineno)d] - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logging.getLogger("urllib3").setLevel(logging.WARNING) # Quieten library logs
logging.getLogger("duckduckgo_search").setLevel(logging.WARNING) # Optional: Quieten DDGS logs if too verbose

# Flask App Initialization
app = Flask(__name__)

# --- API Keys / Model Configuration ---
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
GEMINI_MODEL_NAME = os.getenv('GEMINI_MODEL_NAME', 'gemini-1.5-pro-latest') # Use 1.5 Pro default, allow override
WEATHER_API_KEY = os.getenv('WEATHER_API_KEY')
model = None # Initialize model variable

# --- Google Gemini Initialization ---
if not GOOGLE_API_KEY:
    logging.critical("FATAL: GOOGLE_API_KEY not found in environment variables. AI functionality disabled.")
else:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        model = genai.GenerativeModel(GEMINI_MODEL_NAME)
        logging.info(f"Google Gemini configured successfully with model: {GEMINI_MODEL_NAME}")
    except Exception as e:
        logging.critical(f"FATAL: Error configuring Google Gemini or accessing model '{GEMINI_MODEL_NAME}'. AI disabled. Error: {e}", exc_info=True)
        model = None

if not WEATHER_API_KEY:
    logging.warning("WEATHER_API_KEY not found. Weather functionality will be disabled.")

# --- MongoDB Configuration ---
MONGO_USER = os.getenv('MONGO_USER')
MONGO_PASSWORD = os.getenv('MONGO_PASSWORD')
MONGO_HOST = os.getenv('MONGO_HOST')
MONGO_PORT = os.getenv('MONGO_PORT', '27017')
MONGO_DB_NAME = os.getenv('MONGO_DB_NAME', 'friday_assistant_db')
MONGO_COLLECTION_NAME = os.getenv('MONGO_COLLECTION_NAME', 'interactions')
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
        logging.error(f"MongoDB env vars incomplete ({', '.join(missing_vars)} missing). DB connection skipped.")
        return False
    try:
        escaped_user = quote_plus(MONGO_USER)
        escaped_password = quote_plus(MONGO_PASSWORD)
        if MONGO_HOST.startswith("mongodb+srv://"):
             # Handle potential credentials in MONGO_HOST URI if copied directly from Atlas
             host_part = MONGO_HOST.split('@')[-1]
             connection_string = f"mongodb+srv://{escaped_user}:{escaped_password}@{host_part}/?retryWrites=true&w=majority&authSource={MONGO_AUTH_DB}"
        else:
             connection_string = f"mongodb://{escaped_user}:{escaped_password}@{MONGO_HOST}:{MONGO_PORT}/?authSource={MONGO_AUTH_DB}"

        logging.info(f"Connecting to MongoDB: {MONGO_HOST.split('@')[-1]} (DB: {MONGO_DB_NAME}, AuthDB: {MONGO_AUTH_DB})...")
        mongo_client = MongoClient(
            connection_string,
            serverSelectionTimeoutMS=15000, # Allow more time for server selection in cluster environments
            connectTimeoutMS=10000,
            socketTimeoutMS=10000,
            appname="FridayAssistant" # Identify application to MongoDB server logs
        )
        # Use modern ping command for connectivity check
        mongo_client.admin.command('ping')
        logging.info("MongoDB server ping successful.")

        db = mongo_client[MONGO_DB_NAME]
        logging.info(f"Using database: '{MONGO_DB_NAME}'")

        # Ensure collection exists and create index if needed
        if MONGO_COLLECTION_NAME not in db.list_collection_names():
            logging.info(f"Collection '{MONGO_COLLECTION_NAME}' not found, creating it.")
            db.create_collection(MONGO_COLLECTION_NAME)
            collection = db[MONGO_COLLECTION_NAME] # Assign after creation
            logging.info("Creating index on 'timestamp'...")
            try:
                 collection.create_index([("timestamp", DESCENDING)])
            except OperationFailure as op_err:
                 logging.warning(f"Could not create index (might already exist or insufficient permissions): {op_err.details}")
        else:
             collection = db[MONGO_COLLECTION_NAME] # Assign existing collection
             logging.info(f"Using existing collection: '{MONGO_COLLECTION_NAME}'")

        logging.info("MongoDB connection and collection setup successful.")
        return True

    except (ConnectionFailure, ServerSelectionTimeoutError) as e:
        logging.error(f"MongoDB Connection Error: Could not connect to {MONGO_HOST.split('@')[-1]}. Check network/firewall/credentials. Details: {e}", exc_info=False)
        mongo_client = db = collection = None; return False
    except OperationFailure as e:
        logging.error(f"MongoDB Authentication/Operation Error: Check credentials/permissions for DB '{MONGO_DB_NAME}'/AuthDB '{MONGO_AUTH_DB}'. Details: {e.details}", exc_info=False)
        mongo_client = db = collection = None; return False
    except Exception as e:
        logging.exception(f"Unexpected error during MongoDB initialization: {e}") # Log full traceback for unexpected
        mongo_client = db = collection = None; return False

mongodb_ready = initialize_mongodb()

# --- Weather API Function ---
def get_weather(location: str):
    """Fetches current weather data from WeatherAPI.com."""
    if not WEATHER_API_KEY: return None, "Weather API key not configured on the server."
    base_url = "http://api.weatherapi.com/v1/current.json"; params = {"key": WEATHER_API_KEY, "q": location, "aqi": "no"}; headers = {"User-Agent": "FridayAssistant/1.0"}
    logging.debug(f"Requesting weather from WeatherAPI for: {location}")
    try:
        response = requests.get(base_url, params=params, timeout=15, headers=headers); response.raise_for_status()
        weather_data = response.json(); logging.info(f"OK fetch weather {location} ({response.status_code})"); return weather_data, None
    except requests.exceptions.Timeout: logging.error(f"Timeout WeatherAPI {location}"); return None, "Weather service timed out."
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code; detail = f"HTTP {status}"; msg = "";
        try: msg = e.response.json().get('error',{}).get('message',''); detail += f": {msg}" if msg else ""
        except: pass
        logging.error(f"HTTP error weather {location}: {detail}")
        if status == 400: return None, f"Cannot find weather for '{location}'. ({msg or 'Check location'})"
        elif status in [401, 403]: return None, "Weather service auth failed."
        else: return None, f"Weather service error ({detail})."
    except requests.exceptions.ConnectionError as e: logging.error(f"Conn error weather {location}: {e}"); return None, "Cannot connect weather service."
    except requests.exceptions.RequestException as e: logging.error(f"Req error weather {location}: {e}"); return None, f"Network error fetching weather: {e}"
    except Exception as e: logging.exception(f"Unexpected error weather {location}: {e}"); return None, "Unexpected internal error fetching weather."

# --- DuckDuckGo Search Function ---
def perform_web_search(query: str, num_results: int = 5):
    """Performs a web search using DuckDuckGo Search library and returns processed results."""
    logging.info(f"DDG search: '{query}' (max={num_results})")
    processed = []; results = []
    try:
        # Using context manager ensures cleanup
        with DDGS(timeout=20) as ddgs:
            results = list(ddgs.text(query, region='wt-wt', safesearch='moderate', max_results=num_results, backend="lite"))
        if not results: logging.warning(f"DDG no results: '{query}'."); return "", None # Empty string for no results, not an error
        for r in results:
            s = r.get("body","").strip(); t = r.get("title","No title").strip(); l = r.get("href","#")
            if not s or not t: continue # Skip if missing essential parts
            processed.append(f"Title: {t}\nLink: {l}\nSnippet: {s[:300]}...") # Limit snippet length
        if not processed: logging.warning(f"DDG no usable results: '{query}'."); return "", None
        out_str = "\n\n---\n\n".join(processed); logging.info(f"DDG OK: '{query}'. Found {len(processed)} usable results."); return out_str, None
    except Exception as e: logging.exception(f"DDG search error: '{query}': {e}"); return None, f"Unexpected error during web search ({type(e).__name__})."

# --- Helper to call Gemini ---
def call_gemini(prompt: str, is_json_output: bool = False):
    """Helper function to call the Gemini API and handle basic errors/response."""
    if not model: logging.error("call_gemini attempted but AI Model is not initialized."); return None, "AI Model is not available."
    mime_type = "application/json" if is_json_output else "text/plain"; log_prompt_sample = prompt.replace('\n', ' ')[:150]
    logging.debug(f"Calling Gemini (Out: {mime_type}). Len: {len(prompt)}. Sample: {log_prompt_sample}...")
    try:
        generation_config = genai.types.GenerationConfig(
            temperature=0.6, # Optimized temperature
            response_mime_type=mime_type
            )
        safety_settings = [ # Default safety settings
            {"category": c, "threshold": "BLOCK_MEDIUM_AND_ABOVE"}
            for c in genai.types.HarmCategory if c != genai.types.HarmCategory.HARM_CATEGORY_UNSPECIFIED
        ]
        response = model.generate_content(
            prompt,
            generation_config=generation_config,
            safety_settings=safety_settings,
            request_options={'timeout': 90} # Generous timeout for API call
            )
        # Robust response text extraction
        response_text = None
        if response.parts: response_text = "".join(p.text for p in response.parts)
        elif response.candidates and response.candidates[0].content and response.candidates[0].content.parts: response_text = "".join(p.text for p in response.candidates[0].content.parts)

        if response_text: logging.debug(f"Gemini OK response sample: {response_text[:150]}..."); return response_text, None
        elif response.prompt_feedback.block_reason:
            reason = response.prompt_feedback.block_reason.name; logging.warning(f"Gemini safety block: {reason}"); return None, f"My safety filters blocked the request ({reason}). Please rephrase."
        else: logging.error(f"Gemini empty/unexpected response structure: {response}"); return None, "The AI returned an empty or unexpected response."
    except Exception as e:
        logging.exception(f"Core error during Gemini API call: {e}"); detail = str(e); reason = None
        try: # Check for safety block within exception context
            if hasattr(e, 'response') and hasattr(e.response, 'prompt_feedback') and e.response.prompt_feedback.block_reason: reason = e.response.prompt_feedback.block_reason.name
        except Exception: pass
        if reason: return None, f"My safety filters may have blocked the request ({reason})."
        # Add more specific error checks here if needed (e.g., DeadlineExceeded from google.api_core.exceptions)
        return None, f"Error communicating with AI ({type(e).__name__}). Check server logs."

# --- Flask Routes ---
@app.route('/')
def index():
    """Renders the main chat interface."""
    return render_template('index.html')

@app.route('/ask', methods=['POST'])
def ask_assistant():
    """Handles user questions, routes to weather/search/general AI, stores data."""
    start = datetime.now(timezone.utc); addr = request.remote_addr
    if not model: logging.error(f"/ask from {addr}: AI unavailable."); return jsonify({"error": "AI Model unavailable."}), 500
    question = "" # Initialize question for use in final exception logging
    try:
        data = request.get_json(); vis_data = None; map_data = None
        if not data or not isinstance(data, dict): logging.warning(f"Invalid format from {addr}."); return jsonify({"error": "Invalid request format."}), 400
        question = data.get('question', '').strip()
        if not question: logging.warning(f"Empty question from {addr}."); return jsonify({"error": "Question empty."}), 400
        logging.info(f"Received from {addr}: \"{question}\"")
        final_text = None; details = {"type": "general", "intent_ok": None, "weather_call": False, "weather_loc": None, "weather_ok": None, "search_check": False, "search_call": False, "search_q": None, "search_ok": None, "final_src": "unknown", "err": None}

        # === Step 1: Weather Intent Analysis ===
        is_weather, weather_loc = False, None
        if WEATHER_API_KEY:
            prompt = f"""Analyze user query: "{question}". Is it asking for current weather/forecast? If yes, identify location. Respond ONLY JSON: {{"is_weather_query": boolean, "location": string_or_null}}."""
            raw, err = call_gemini(prompt, is_json_output=True)
            if err: logging.error(f"Weather intent fail: {err}"); details.update({"intent_ok": False, "err": f"Intent fail: {err}"})
            else:
                try: clean = raw.strip(); # ... (JSON cleaning logic) ...
                    if clean.startswith("```json"): clean=clean[7:-3].strip() elif clean.startswith("```"): clean=clean[3:-3].strip()
                    d = json.loads(clean); is_weather=d.get("is_weather_query") is True; weather_loc=d.get("location");
                    if isinstance(weather_loc,str) and not weather_loc.strip(): weather_loc=None
                    details["intent_ok"]=True; logging.info(f"Weather intent: {is_weather}, loc='{weather_loc}'")
                except Exception as e: logging.exception(f"Weather intent JSON error: {e}. Raw: {raw}"); details.update({"intent_ok": False, "err": f"Intent JSON parse err: {type(e).__name__}"})
        else: details["intent_ok"] = None # Skipped

        # === Step 2: Handle Weather Query ===
        if is_weather and weather_loc and WEATHER_API_KEY:
            details.update({"type": "weather", "weather_loc": weather_loc, "weather_call": True}); logging.info(f"Calling WeatherAPI: '{weather_loc}'")
            w_data, w_err = get_weather(weather_loc)
            if w_err: details.update({"weather_ok": False, "err": w_err}); logging.error(f"WeatherAPI error: {w_err}"); prompt = f"You are Friday. Inform user politely of weather lookup issue for '{weather_loc}'. Problem: '{w_err}'. Suggest check location/try later."; resp, _ = call_gemini(prompt); final_text = resp or f"Sorry, couldn't get weather for '{weather_loc}': {w_err}"; details["final_src"] = "weather_api_err_ai"
            elif w_data:
                details["weather_ok"] = True
                try: # Safely extract data and build summaries/viz
                    curr=w_data.get('current',{}); loc=w_data.get('location',{}); name=loc.get('name',weather_loc); full=", ".join(filter(None,[loc.get(k) for k in ['name','region','country']])) or name; lat,lon=loc.get('lat'),loc.get('lon');
                    t_c,t_f=curr.get('temp_c'),curr.get('temp_f'); f_c,f_f=curr.get('feelslike_c'),curr.get('feelslike_f'); hum=curr.get('humidity'); w_k,w_d=curr.get('wind_kph'),curr.get('wind_dir'); cond=curr.get('condition',{}).get('text','N/A');
                    summary = f"Loc: {full}\nTemp: {t_c}°C ({t_f}°F)\nFeels: {f_c}°C ({f_f}°F)\nCond: {cond}\nHum: {hum}%\nWind: {w_k} kph {w_d}"; logging.info(f"Weather data:\n{summary}")
                    if all(v is not None for v in [t_c,f_c,hum,w_k]): vis_data = {"type":"bar", "chart_title":f"Weather: {full}", "labels":["Temp(C)","Feels(C)","Hum(%)","Wind(kph)"], "datasets":[{"label":"Current","data":[t_c,f_c,hum,w_k], "backgroundColor":['#64FFDA99','#40E0D099','#4682B499','#ADD8E699'], "borderColor":['#64FFDA','#40E0D0','#4682B4','#ADD8E6'],"borderWidth":1}]}; logging.info("Prep chart data.")
                    if lat is not None and lon is not None: map_data = {"latitude":lat, "longitude":lon, "zoom":11, "marker_title":full}; logging.info(f"Prep map data: {lat},{lon}")
                    prompt = f"You are Friday, reporting current weather. Based *only* on this data:\n---\n{summary}\n---\nProvide a clear, friendly summary. State location ({full}). Include temp (C/F), condition, 'feels like' (C/F). Focus on data. Answer:"; resp, err = call_gemini(prompt)
                    if err: logging.error(f"AI weather format fail: {err}"); final_text = f"Got weather for {full}: {cond}, {t_c}°C ({t_f}°F)."; details.update({"err": err, "final_src": "weather_fallback"})
                    else: final_text = resp; details["final_src"] = "weather_ai_gen"
                except Exception as e: logging.exception("Error processing weather data."); final_text = "Found weather data, but trouble processing."; details.update({"weather_ok": False, "err": f"Weather processing error: {type(e).__name__}", "final_src": "weather_proc_err"})

        # === Step 3: If NOT weather, check if search is needed ===
        if final_text is None:
            details["search_check"]=True; needed, query = False, None
            prompt = f"""Does user query "{question}" likely need recent info/web search? ONLY JSON: {{"search_needed": boolean, "search_query": string_or_null (effective query if needed)}}."""
            raw, err = call_gemini(prompt, is_json_output=True)
            if err: logging.error(f"Search check fail: {err}"); details["err"] = f"Search check fail: {err}"
            else:
                try: # Parse JSON
                    clean = raw.strip(); if clean.startswith("```json"): clean=clean[7:-3].strip() elif clean.startswith("```"): clean=clean[3:-3].strip()
                    d = json.loads(clean); needed=d.get("search_needed") is True; query=d.get("search_query");
                    if isinstance(query,str) and not query.strip(): query=None
                    details["search_q"]=query; logging.info(f"Search check: needed={needed}, query='{query}'")
                except Exception as e: logging.exception(f"Search check JSON error: {e}"); details["err"] = f"Search JSON parse err: {type(e).__name__}"

            # === Step 4: Perform Web Search ===
            if needed and query:
                details.update({"type":"search", "search_call":True}); logging.info(f"DDG search: '{query}'")
                s_res, s_err = perform_web_search(query)
                if s_err: details.update({"search_ok":False, "err":s_err}); logging.error(f"Search func error: {s_err}"); prompt=f"Friday: Inform user politely of technical problem searching web regarding '{query}'. Internal error: '{s_err}'. Apologize."; resp,_=call_gemini(prompt); final_text=resp or f"Sorry, tech issue searching: {s_err}"; details["final_src"]="search_func_err_ai"
                else:
                    details["search_ok"]=True
                    # Use Optimized Synthesis Prompt
                    prompt = f"""You are Friday, an AI assistant focused on providing clear and relevant answers. The user asked: "{question}". You performed a web search for "{query}". Key findings:\n---BEGIN SEARCH RESULTS---\n{s_res if s_res else "No specific results were found for this query."}\n---END SEARCH RESULTS---\nBased *strictly* on the provided search results, answer the user's original question directly and concisely. * If the results provide a clear answer, state it. * If multiple relevant items are mentioned (e.g., several matches) and the user asked for a singular item (like '*the* match'), try to identify the most prominent or likely intended item based *only* on info within the results (like times/emphasis). State this is your interpretation. * If multiple items seem equally important or results are ambiguous, list key items briefly. * If no relevant results were found, clearly state that. You may then offer a general knowledge answer if appropriate, distinguishing it clearly. Provide only the answer, without conversational filler like "Based on the results..." unless necessary for clarity. Answer:"""
                    resp, err = call_gemini(prompt)
                    if err: logging.error(f"AI search synthesis fail: {err}"); final_text = f"Looked online for '{query}' but had trouble summarizing."; details.update({"err": err, "final_src": "search_synth_err"})
                    else: final_text=resp; details["final_src"]="search_ai_gen"

        # === Step 5: General Fallback ===
        if final_text is None:
            logging.info("Handling as general query (fallback)..."); details["type"] = "general"
            # Use Optimized General Prompt
            prompt = f"You are Friday, a helpful AI assistant providing clear answers. Answer the following user question concisely based on your general knowledge. If the topic is very recent, you can note your knowledge might have a cutoff date. User Question: {question}. Answer:"
            resp, err = call_gemini(prompt)
            if err: logging.error(f"General AI fail: {err}"); final_text = f"Sorry, issue processing: {err}"; details.update({"err": err, "final_src": "general_ai_err"})
            else: final_text=resp; details["final_src"]="general_ai_gen"

        # --- Final Response & DB ---
        final_text = final_text or "My apologies, I couldn't generate a suitable response." # Ultimate fallback
        end = datetime.now(timezone.utc); time = (end - start).total_seconds()
        logging.info(f"Req from {addr} processed in {time:.2f}s. Source: {details['final_src']}")
        if mongodb_ready and collection is not None:
            doc = {"timestamp":datetime.now(timezone.utc), "request_ip":addr, "question":question, "response":final_text, "model_used":GEMINI_MODEL_NAME, "processing_time_seconds":round(time,2), "details":details}
            try: collection.insert_one(doc); logging.debug("Interaction stored.")
            except Exception as e: logging.exception("DB store error.")
        else: logging.warning("MongoDB unavailable. Interaction not stored.")

        # Assemble final payload for frontend
        payload = {"response": final_text}
        if vis_data: payload["visualization_data"] = vis_data
        if map_data: payload["map_data"] = map_data
        return jsonify(payload)

    except Exception as e: logging.exception(f"CRITICAL UNEXPECTED ERROR in /ask from {addr} for q: '{question}'"); return jsonify({"error": "Critical internal server error."}), 500

# --- Main Execution ---
if __name__ == '__main__':
    is_debug = os.environ.get('FLASK_DEBUG', '1') == '1'
    cert, key, ssl_ctx, s_type = 'cert.pem', 'key.pem', None, "HTTP"
    if os.path.exists(cert) and os.path.exists(key): ssl_ctx=(cert,key); s_type="HTTPS"; logging.info(f"Certs found ('{cert}', '{key}').")
    else: logging.warning(f"Certs ('{cert}', '{key}') not found. Starting {s_type}. Mic may fail on non-localhost.")
    logging.info(f"Starting Flask Assistant server (Debug: {is_debug}) via {s_type}...")
    try: app.run(host='0.0.0.0', port=5000, debug=is_debug, ssl_context=ssl_ctx)
    except Exception as e: logging.exception(f"Failed to start Flask server: {e}")