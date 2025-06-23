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
from geopy.geocoders import Nominatim # For Routing Geocoding
from geopy.exc import GeocoderTimedOut, GeocoderServiceError # Geopy exceptions
import traceback # For logging exception details

# --- Configuration ---
load_dotenv() # Load environment variables from .env file

# Logging Configuration
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(threadName)s - [%(filename)s:%(lineno)d] - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("duckduckgo_search").setLevel(logging.WARNING)
logging.getLogger("geopy").setLevel(logging.INFO)

# Flask App Initialization
app = Flask(__name__)

# --- API Keys / Model Configuration ---
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
GEMINI_MODEL_NAME = os.getenv('GEMINI_MODEL_NAME', 'gemini-1.5-pro-latest')
WEATHER_API_KEY = os.getenv('WEATHER_API_KEY')
model = None

# --- Google Gemini Initialization ---
if not GOOGLE_API_KEY:
    logging.critical("FATAL: GOOGLE_API_KEY not found. AI functionality disabled.")
else:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        model = genai.GenerativeModel(GEMINI_MODEL_NAME)
        logging.info(f"Google Gemini configured successfully with model: {GEMINI_MODEL_NAME}")
    except Exception as e:
        logging.critical(f"FATAL: Error configuring Google Gemini or accessing model '{GEMINI_MODEL_NAME}'. AI disabled. Error: {e}", exc_info=True)
        model = None

if not WEATHER_API_KEY:
    logging.warning("WEATHER_API_KEY not found. Weather functionality disabled.")

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

# --- Geocoding Initialization ---
geolocator = Nominatim(user_agent="FridayAssistantWebApp/1.0 (your-contact@example.com)")

# --- MongoDB Initialization Function ---
def initialize_mongodb():
    global mongo_client, db, collection
    # ... (Keep this function exactly as in the previous complete app.py) ...
    pass # Placeholder for brevity - use the full working version

mongodb_ready = initialize_mongodb() # Assume full function is used from previous full code

# --- Geocoding Function ---
def get_coordinates(location_name: str):
    # ... (Keep this function exactly as in the previous complete app.py) ...
    pass # Placeholder for brevity - use the full working version

# --- Weather API Function ---
def get_weather(location: str):
    # ... (Keep this function exactly as in the previous complete app.py - WITH THE HTTPError FIX) ...
    pass # Placeholder for brevity - use the full working version

# --- DuckDuckGo Search Function ---
def perform_web_search(query: str, num_results: int = 3):
    # ... (Keep this function exactly as in the previous complete app.py) ...
    pass # Placeholder for brevity - use the full working version

# --- Helper to call Gemini ---
def call_gemini(prompt: str, is_json_output: bool = False):
    # ... (Keep this function exactly as in the previous complete app.py) ...
    pass # Placeholder for brevity - use the full working version

# --- Flask Routes ---
@app.route('/')
def index(): return render_template('index.html')

@app.route('/ask', methods=['POST'])
def ask_assistant():
    start=datetime.now(timezone.utc); addr=request.remote_addr
    if not model: logging.error(f"/ask from {addr}: AI unavailable."); return jsonify({"error": "AI Model unavailable."}), 500
    question=""; vis_data=None; map_data=None
    try:
        data=request.get_json();
        if not data or not isinstance(data, dict): logging.warning(f"Invalid format from {addr}."); return jsonify({"error": "Invalid request format."}), 400
        question=data.get('question', '').strip()
        if not question: logging.warning(f"Empty question from {addr}."); return jsonify({"error": "Question empty."}), 400
        logging.info(f"Received from {addr}: \"{question}\"")
        final_text=None; details={"type":"general", "intent_ok":None, "weather_call":False, "weather_loc":None, "weather_ok":None, "route_intent":False, "route_origin":None, "route_dest":None, "origin_coords":None, "dest_coords":None, "search_check":False, "search_call":False, "search_q":None, "search_ok":None, "final_src":"unknown", "err":None}

        # === Intent Detection Layer ===
        is_weather, weather_loc = False, None
        is_routing, route_origin, route_dest = False, None, None

        # 1a. Check Weather Intent
        if WEATHER_API_KEY:
            prompt=f"""Analyze user query: "{question}". Is it asking for current weather/forecast? If yes, identify location. ONLY JSON: {{"is_weather_query": boolean, "location": string_or_null}}."""
            raw, err=call_gemini(prompt, is_json_output=True)
            if err: logging.error(f"Weather intent fail: {err}"); details.update({"intent_ok": False, "err": f"Intent fail: {err}"})
            else:
                try:
                    weather_intent_clean = raw.strip()
                    # *** CORRECTED MULTI-LINE IF/ELIF ***
                    if weather_intent_clean.startswith("```json"):
                        weather_intent_clean = weather_intent_clean[7:-3].strip()
                    elif weather_intent_clean.startswith("```"):
                        weather_intent_clean = weather_intent_clean[3:-3].strip()
                    # *** END CORRECTION ***
                    weather_intent_data = json.loads(weather_intent_clean); is_weather=weather_intent_data.get("is_weather_query") is True; weather_loc=weather_intent_data.get("location");
                    if isinstance(weather_loc,str) and not weather_loc.strip(): weather_loc=None
                    details["intent_ok"]=True; logging.info(f"Weather intent: {is_weather}, loc='{weather_loc}'")
                except json.JSONDecodeError as json_err: logging.error(f"Weather intent JSON decode error: {json_err}. Raw: {raw}", exc_info=False); details.update({"intent_ok":False, "err":f"Weather JSON parse error: {json_err}"})
                except Exception as e: logging.exception(f"Unexpected error processing weather intent JSON: {e}"); details.update({"intent_ok":False, "err":f"Weather JSON processing error: {type(e).__name__}"})
        else: details["intent_ok"] = None # Skipped

        # 1b. Check Routing Intent (If not weather)
        if not is_weather:
            prompt=f"""Analyze the user query: "{question}". Is the user asking for directions, a route, or travel path between two locations? If yes, identify the Origin and Destination locations. Respond ONLY with a valid JSON object: {{"is_routing_query": boolean, "origin": string_or_null, "destination": string_or_null}}"""
            raw, err=call_gemini(prompt, is_json_output=True)
            if not err:
                try:
                    routing_intent_clean = raw.strip();
                    # *** CORRECTED MULTI-LINE IF/ELIF ***
                    if routing_intent_clean.startswith("```json"):
                        routing_intent_clean = routing_intent_clean[7:-3].strip()
                    elif routing_intent_clean.startswith("```"):
                        routing_intent_clean = routing_intent_clean[3:-3].strip()
                    # *** END CORRECTION ***
                    routing_intent_data = json.loads(routing_intent_clean); is_routing=routing_intent_data.get("is_routing_query") is True; route_origin=routing_intent_data.get("origin"); route_dest=routing_intent_data.get("destination")
                    if isinstance(route_origin,str) and not route_origin.strip(): route_origin=None
                    if isinstance(route_dest,str) and not route_dest.strip(): route_dest=None
                    if is_routing and (not route_origin or not route_dest): is_routing=False; logging.warning("Routing intent but missing origin/dest."); route_origin=None; route_dest=None;
                    details.update({"route_intent":is_routing, "route_origin":route_origin, "route_dest":route_dest}); logging.info(f"Routing intent: {is_routing}, Orig='{route_origin}', Dest='{route_dest}'")
                except json.JSONDecodeError as json_err: logging.error(f"Routing intent JSON decode error: {json_err}. Raw: {raw}", exc_info=False); details.update({"route_intent":False, "err":f"Routing JSON parse error: {json_err}"})
                except Exception as e: logging.exception(f"Unexpected error processing routing intent JSON: {e}"); details.update({"route_intent":False, "err":f"Routing JSON processing error: {type(e).__name__}"})
            else: logging.error(f"Routing intent fail: {err}"); details["err"]=f"Routing intent fail: {err}"

        # === Step 2: Handle Specific Intents ===
        # ... (Keep 2a. Handle Weather and 2b. Handle Routing as they are, they use OPTIMIZED prompts already) ...
        if is_weather and weather_loc and WEATHER_API_KEY:
            # ... (Full weather logic as provided in last complete app.py) ...
            pass
        elif is_routing and route_origin and route_dest:
            # ... (Full routing logic as provided in last complete app.py, using corrected prompt) ...
            pass


        # === Step 3: Fallback to Search or General AI ===
        if final_text is None:
            details["search_check"]=True; needed, search_query=False, None
            search_check_prompt=f"""Analyze the user's query. Does answering it likely require searching the internet for current information (today/yesterday), recent events, specific facts (stock prices, scores), or details beyond common knowledge? If the query specifically mentions "GitHub" and a username, try to formulate a search query that might directly land on their repository listing page or a page likely to list some repositories. User Query: "{question}". Respond ONLY with a valid JSON object: {{"search_needed": boolean, "search_query": string_or_null (Example for GitHub: "site:github.com [username] repositories". Otherwise, null.)}}"""
            raw, err=call_gemini(search_check_prompt, is_json_output=True)
            if err: logging.error(f"Search check fail: {err}"); details["err"]=f"Search check fail: {err}"
            else:
                try: # Parse search intent JSON safely
                    search_check_clean = raw.strip()
                    # *** CORRECTED MULTI-LINE IF/ELIF ***
                    if search_check_clean.startswith("```json"):
                        search_check_clean = search_check_clean[7:-3].strip()
                    elif search_check_clean.startswith("```"):
                        search_check_clean = search_check_clean[3:-3].strip()
                    # *** END CORRECTION ***
                    search_check_data = json.loads(search_check_clean)
                    needed = search_check_data.get("search_needed") is True
                    search_query = search_check_data.get("search_query")
                    if isinstance(search_query, str) and not search_query.strip(): search_query=None
                    details["search_q"]=search_query; logging.info(f"Search check: needed={needed}, query='{search_query}'")
                except json.JSONDecodeError as json_err: logging.error(f"Search check JSON decode error: {json_err}. Raw: {raw}", exc_info=False); details["err"]=f"Search JSON parse error: {json_err}"
                except Exception as e: logging.exception(f"Unexpected error processing search check JSON: {e}"); details["err"]=f"Search JSON processing error: {type(e).__name__}"
            # Perform Search
            if needed and search_query:
                # ... (Keep search and synthesis logic as they are, they use OPTIMIZED prompts) ...
                 details.update({"type":"search", "search_call":True}); logging.info(f"DDG search: '{search_query}'")
                 s_res, s_err=perform_web_search(search_query, num_results=5) # Using 5 results for more context
                 if s_err: details.update({"search_ok":False, "err":s_err}); logging.error(f"Search func error: {s_err}"); prompt=f"Friday: Inform user politely of technical problem searching web regarding '{search_query}'. Internal error: '{s_err}'. Apologize."; resp,_=call_gemini(prompt); final_text=resp or f"Sorry, tech issue searching: {s_err}"; details["final_src"]="search_func_err_ai"
                 else:
                     details["search_ok"]=True;
                     prompt = f"""You are Friday, an AI assistant. The user asked: "{question}" You performed a web search for "{search_query}" and found these results:\n---BEGIN SEARCH RESULTS---\n{s_res if s_res else "No specific results were found for this query via general web search."}\n---END SEARCH RESULTS---\nBased *strictly* on the provided SEARCH RESULTS: 1. Answer the user's original question as directly and accurately as possible. 2. If the query was about finding specific items (like GitHub repository names for a user) and the search results provide *some* names, list the names you found. 3. If the search results mention a *count* of items (e.g., "X repositories") but do not list them all, state the count and mention that the full list wasn't available in the search snippets. 4. If the results are clearly insufficient to answer the specific request (e.g., general GitHub page, but no repo names), state that the search didn't provide the specific details. 5. Prioritize information that appears to be from more official or direct sources within the snippets. 6. Be concise. Avoid conversational filler unless necessary for clarity. Answer:"""
                     resp, err=call_gemini(prompt)
                     if err: logging.error(f"AI search synthesis fail: {err}"); final_text=f"Looked online for '{search_query}' but trouble summarizing."; details.update({"err":err, "final_src":"search_synth_err"})
                     else: final_text=resp; details["final_src"]="search_ai_gen"
            # General Fallback
            if final_text is None:
                # ... (Keep general fallback logic as it is, it uses OPTIMIZED prompt) ...
                 logging.info("Handling as general query (fallback)..."); details["type"]="general"
                 prompt=f"You are Friday, providing clear answers. User question: {question}. Answer concisely from general knowledge. Note if info might be dated."
                 resp, err=call_gemini(prompt)
                 if err: logging.error(f"General AI fail: {err}"); final_text=f"Sorry, issue processing: {err}"; details.update({"err":err, "final_src":"general_ai_err"})
                 else: final_text=resp; details["final_src"]="general_ai_gen"

        # --- Final Response & DB ---
        # ... (Keep this section exactly as in the previous complete app.py) ...
        final_text=final_text or "My apologies, I couldn't generate a suitable response."
        end=datetime.now(timezone.utc); time=(end - start).total_seconds()
        logging.info(f"Req from {addr} processed in {time:.2f}s. Source: {details['final_src']}")
        if mongodb_ready and collection is not None:
            doc={"timestamp":datetime.now(timezone.utc), "request_ip":addr, "question":question, "response":final_text, "model_used":GEMINI_MODEL_NAME, "processing_time_seconds":round(time,2), "details":details}
            try: collection.insert_one(doc); logging.debug("Interaction stored.")
            except Exception as e: logging.exception("DB store error.")
        else: logging.warning("MongoDB unavailable. Interaction not stored.")
        payload={"response":final_text}
        if vis_data: payload["visualization_data"]=vis_data
        if map_data: payload["map_data"]=map_data
        return jsonify(payload)

    except Exception as e: logging.exception(f"CRITICAL UNEXPECTED ERROR in /ask from {addr} for q: '{question}'"); return jsonify({"error": "Critical internal server error."}), 500

# --- Main Execution ---
if __name__ == '__main__':
    # ... (Keep this section exactly as in the previous complete app.py) ...
    is_debug = os.environ.get('FLASK_DEBUG', '1') == '1'
    cert, key, ssl_ctx, s_type = 'cert.pem', 'key.pem', None, "HTTP"
    if os.path.exists(cert) and os.path.exists(key): ssl_ctx=(cert,key); s_type="HTTPS"; logging.info(f"Certs found ('{cert}', '{key}').")
    else: logging.warning(f"Certs ('{cert}', '{key}') not found. Starting {s_type}. Mic may fail on non-localhost.")
    logging.info(f"Starting Flask Assistant server (Debug: {is_debug}) via {s_type}...")
    try: app.run(host='0.0.0.0', port=5000, debug=is_debug, ssl_context=ssl_ctx, threaded=True)
    except Exception as e: logging.exception(f"Failed to start Flask server: {e}")