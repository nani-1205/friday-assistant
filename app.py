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
import requests # For WeatherAPI and SearchApi.io calls
import json     # For parsing Gemini's intent response
from duckduckgo_search import DDGS # Fallback Web Search
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
logging.getLogger("requests").setLevel(logging.WARNING)
logging.getLogger("duckduckgo_search").setLevel(logging.WARNING)
logging.getLogger("geopy").setLevel(logging.INFO)

# Flask App Initialization
app = Flask(__name__)

# --- API Keys / Model Configuration ---
GOOGLE_API_KEY = os.getenv('GOOGLE_API_KEY')
GEMINI_MODEL_NAME = os.getenv('GEMINI_MODEL_NAME', 'gemini-1.5-pro-latest')
WEATHER_API_KEY = os.getenv('WEATHER_API_KEY')
SEARCHAPI_IO_KEY = os.getenv('SEARCHAPI_IO_KEY') # Primary Search API
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

if not WEATHER_API_KEY: logging.warning("WEATHER_API_KEY not found. Weather functionality disabled.")
if not SEARCHAPI_IO_KEY: logging.warning("SEARCHAPI_IO_KEY not found. Will use DuckDuckGo search as fallback if needed.")

# --- MongoDB Configuration ---
MONGO_USER = os.getenv('MONGO_USER'); MONGO_PASSWORD = os.getenv('MONGO_PASSWORD'); MONGO_HOST = os.getenv('MONGO_HOST'); MONGO_PORT = os.getenv('MONGO_PORT', '27017'); MONGO_DB_NAME = os.getenv('MONGO_DB_NAME', 'friday_assistant_db'); MONGO_COLLECTION_NAME = os.getenv('MONGO_COLLECTION_NAME', 'interactions'); MONGO_AUTH_DB = os.getenv('MONGO_AUTH_DB', 'admin');
mongo_client = None; db = None; collection = None

# --- Geocoding Initialization ---
geolocator = Nominatim(user_agent="FridayAssistantWebApp/1.0 (your.email@example.com)") # PLEASE REPLACE with your app's info

# --- MongoDB Initialization Function ---
def initialize_mongodb():
    global mongo_client, db, collection
    required_mongo_vars = [MONGO_USER, MONGO_PASSWORD, MONGO_HOST, MONGO_DB_NAME, MONGO_COLLECTION_NAME]
    if not all(required_mongo_vars):
        missing_vars = [name for name, var in zip(["MONGO_USER", "MONGO_PASSWORD", "MONGO_HOST", "MONGO_DB_NAME", "MONGO_COLLECTION_NAME"], required_mongo_vars) if not var]
        logging.error(f"MongoDB env vars incomplete ({', '.join(missing_vars)} missing). DB connection skipped.")
        return False
    try:
        escaped_user = quote_plus(MONGO_USER); escaped_password = quote_plus(MONGO_PASSWORD)
        if MONGO_HOST.startswith("mongodb+srv://"): host_part = MONGO_HOST.split('@')[-1]; connection_string = f"mongodb+srv://{escaped_user}:{escaped_password}@{host_part}/?retryWrites=true&w=majority&authSource={MONGO_AUTH_DB}"
        else: connection_string = f"mongodb://{escaped_user}:{escaped_password}@{MONGO_HOST}:{MONGO_PORT}/?authSource={MONGO_AUTH_DB}"
        logging.info(f"Connecting to MongoDB: {MONGO_HOST.split('@')[-1]} (DB: {MONGO_DB_NAME}, AuthDB: {MONGO_AUTH_DB})...")
        mongo_client = MongoClient(connection_string, serverSelectionTimeoutMS=15000, connectTimeoutMS=10000, socketTimeoutMS=10000, appname="FridayAssistant")
        mongo_client.admin.command('ping'); logging.info("MongoDB server ping successful.")
        db = mongo_client[MONGO_DB_NAME]; logging.info(f"Using database: '{MONGO_DB_NAME}'")
        if MONGO_COLLECTION_NAME not in db.list_collection_names():
            logging.info(f"Collection '{MONGO_COLLECTION_NAME}' not found, creating it."); db.create_collection(MONGO_COLLECTION_NAME)
            collection = db[MONGO_COLLECTION_NAME]; logging.info("Creating index on 'timestamp'...");
            try: collection.create_index([("timestamp", DESCENDING)])
            except OperationFailure as op_err: logging.warning(f"Could not create index (might exist/perms issue): {op_err.details}")
        else: collection = db[MONGO_COLLECTION_NAME]; logging.info(f"Using existing collection: '{MONGO_COLLECTION_NAME}'")
        logging.info("MongoDB connection and collection setup successful."); return True
    except (ConnectionFailure, ServerSelectionTimeoutError) as e: logging.error(f"MongoDB Connection Error. Details: {e}", exc_info=False); mongo_client=db=collection=None; return False
    except OperationFailure as e: logging.error(f"MongoDB Auth/Op Error. Details: {e.details}", exc_info=False); mongo_client=db=collection=None; return False
    except Exception as e: logging.exception(f"Unexpected error during MongoDB init: {e}"); mongo_client=db=collection=None; return False

mongodb_ready = initialize_mongodb()

# --- Geocoding Function ---
def get_coordinates(location_name: str):
    if not location_name: return None, "Location name cannot be empty."
    logging.info(f"Geocoding: '{location_name}'")
    try:
        location = geolocator.geocode(location_name, timeout=10)
        if location: coords = (location.latitude, location.longitude); logging.info(f"Geocoded '{location_name}': {coords}"); return coords, None
        else: logging.warning(f"Geocode fail '{location_name}': No results."); return None, f"Could not find coords for '{location_name}'."
    except GeocoderTimedOut: logging.error(f"Geocode timeout '{location_name}'."); return None, "Geocoding service timed out."
    except GeocoderServiceError as e: logging.error(f"Geocode service error '{location_name}': {e}"); return None, f"Geocoding service error: {e}"
    except Exception as e: logging.exception(f"Unexpected geocode error '{location_name}': {e}"); return None, "Unexpected error geocoding."

# --- Weather API Function ---
def get_weather(location: str):
    if not WEATHER_API_KEY: return None, "Weather API key not configured."
    base_url="http://api.weatherapi.com/v1/current.json"; params={"key":WEATHER_API_KEY,"q":location,"aqi":"no"}; headers={"User-Agent":"FridayAssistant/1.0"}
    logging.debug(f"WeatherAPI request for: {location}")
    try:
        response=requests.get(base_url,params=params,timeout=15,headers=headers); response.raise_for_status()
        data=response.json(); logging.info(f"OK weather fetch {location}({response.status_code})"); return data,None
    except requests.exceptions.Timeout: logging.error(f"Timeout WeatherAPI {location}"); return None,"Weather service timed out."
    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code; detail = f"HTTP error {status_code}"; error_api_msg = "";
        try: error_api_msg = e.response.json().get('error',{}).get('message',''); detail += f": {error_api_msg}" if error_api_msg else ""
        except Exception as json_err: logging.warning(f"Could not parse JSON error from WeatherAPI response (Status: {status_code}): {json_err}"); pass
        logging.error(f"HTTP error occurred fetching weather for {location}: {detail}")
        if status_code == 400: return None,f"Could not find weather data for '{location}'. ({error_api_msg or 'Check location'})"
        elif status_code in [401, 403]: return None,"Weather service auth failed."
        else: return None,f"Weather service error ({detail})."
    except requests.exceptions.ConnectionError as e: logging.error(f"Conn error weather {location}: {e}"); return None,"Cannot connect weather service."
    except requests.exceptions.RequestException as e: logging.error(f"Req error weather {location}: {e}"); return None,f"Network error fetching weather: {e}"
    except Exception as e: logging.exception(f"Unexpected weather error {location}: {e}"); return None,"Unexpected error fetching weather."

# --- Web Search Function (Chooses based on API Key) ---
def perform_web_search(query: str, num_results: int = 5):
    if SEARCHAPI_IO_KEY:
        logging.info(f"Using SearchApi.io for query: '{query}' (num_results hint: {num_results})")
        search_url = "https://www.searchapi.io/api/v1/search"
        params = {"engine": "google", "q": query, "api_key": SEARCHAPI_IO_KEY}
        # Add 'num' if supported by SearchApi.io, their docs vary. Example:
        # if num_results: params["num"] = str(num_results)
        headers = {"User-Agent": "FridayAssistantWebApp/1.0"}
        try:
            response = requests.get(search_url, params=params, headers=headers, timeout=20)
            response.raise_for_status()
            search_data = response.json()
            logging.debug(f"SearchApi.io raw response (first 500 chars): {json.dumps(search_data)[:500]}...")
            processed_results = []
            results_list = search_data.get("organic_results", [])
            if not results_list and "answer_box" in search_data: # Check answer box if no organic
                ab = search_data["answer_box"]; title=ab.get("title","Direct Answer"); snippet=ab.get("snippet") or ab.get("answer"); link=ab.get("link","#")
                if snippet: processed_results.append(f"Title: {title}\nLink: {link}\nSnippet: {snippet[:400]}...")
            for r in results_list[:num_results]:
                t=r.get("title","No title"); l=r.get("link","#"); s=r.get("snippet",r.get("description"))
                if not t or not s: continue
                processed_results.append(f"Title: {t}\nLink: {l}\nSnippet: {s[:400]}...")
            if not processed_results: logging.warning(f"SearchApi.io no usable results: '{query}'."); return "", None
            out_str="\n\n---\n\n".join(processed_results); logging.info(f"SearchApi.io OK: '{query}'. Found {len(processed_results)} results."); return out_str, None
        except requests.exceptions.Timeout: logging.error(f"Timeout SearchApi.io {query}"); return None, "Web search (SearchApi.io) timed out."
        except requests.exceptions.HTTPError as e: status=e.response.status_code; body=e.response.text; logging.error(f"HTTP error SearchApi.io {query}: {e} (Status:{status}), Body:{body[:200]}");
        if status in [401,403]: return None, "SearchApi.io auth failed."
        elif status == 429: return None, "SearchApi.io rate limit exceeded."
        else: return None, f"Error contacting SearchApi.io (HTTP {status})."
        except requests.exceptions.RequestException as e: logging.error(f"Request error SearchApi.io {query}: {e}"); return None, f"Could not connect to SearchApi.io: {e}"
        except Exception as e: logging.exception(f"Unexpected SearchApi.io error {query}: {e}"); return None, "Unexpected error with SearchApi.io."
    else: # Fallback to DuckDuckGo
        logging.info(f"Using DuckDuckGo search for query: '{query}' (max={num_results})")
        processed=[]; results=[]
        try:
            with DDGS(timeout=20) as ddgs: results=list(ddgs.text(query, region='wt-wt', safesearch='moderate', max_results=num_results, backend="lite"))
            if not results: logging.warning(f"DDGS no results: '{query}'."); return "", None
            for r in results:
                s=r.get("body","").strip(); t=r.get("title","No title").strip(); l=r.get("href","#")
                if not s or not t: continue
                processed.append(f"Title: {t}\nLink: {l}\nSnippet: {s[:400]}...")
            if not processed: logging.warning(f"DDGS no usable results: '{query}'."); return "", None
            out_str="\n\n---\n\n".join(processed); logging.info(f"DDGS OK: '{query}'. Found {len(processed)} results."); return out_str, None
        except Exception as e: logging.exception(f"DDGS search error: '{query}': {e}"); return None, f"Unexpected error during DDGS search ({type(e).__name__})."

# --- Helper to call Gemini ---
def call_gemini(prompt: str, is_json_output: bool = False):
    if not model: logging.error("call_gemini: AI Model unavailable."); return None, "AI Model unavailable."
    mime="application/json" if is_json_output else "text/plain"; sample=prompt.replace('\n',' ')[:150]
    logging.debug(f"Calling Gemini (Out: {mime}). Len: {len(prompt)}. Sample: {sample}...")
    try:
        cfg=genai.types.GenerationConfig(temperature=0.6, response_mime_type=mime)
        safety=[{"category":c, "threshold":"BLOCK_MEDIUM_AND_ABOVE"} for c in genai.types.HarmCategory if c!=genai.types.HarmCategory.HARM_CATEGORY_UNSPECIFIED]
        resp=model.generate_content(prompt, generation_config=cfg, safety_settings=safety, request_options={'timeout':90})
        text=None
        if resp.parts: text="".join(p.text for p in resp.parts)
        elif resp.candidates and resp.candidates[0].content and resp.candidates[0].content.parts: text="".join(p.text for p in resp.candidates[0].content.parts)
        if text: logging.debug(f"Gemini OK response sample: {text[:150]}..."); return text, None
        elif resp.prompt_feedback.block_reason: reason=resp.prompt_feedback.block_reason.name; logging.warning(f"Gemini safety block: {reason}"); return None, f"Safety filters blocked ({reason}). Rephrase?"
        else: logging.error(f"Gemini empty/unexpected response: {resp}"); return None, "AI returned empty/unexpected response."
    except Exception as e:
        logging.exception(f"Gemini API call error: {e}"); detail=str(e); reason=None
        try:
            if hasattr(e,'response') and hasattr(e.response,'prompt_feedback') and e.response.prompt_feedback.block_reason: reason=e.response.prompt_feedback.block_reason.name
        except: pass
        if reason: return None, f"Safety filters may have blocked ({reason})."
        return None, f"Error communicating with AI ({type(e).__name__}). Check logs."

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

        is_weather, weather_loc = False, None
        is_routing, route_origin, route_dest = False, None, None

        if WEATHER_API_KEY:
            prompt=f"""Analyze user query: "{question}". Is it asking for current weather/forecast? If yes, identify location. ONLY JSON: {{"is_weather_query": boolean, "location": string_or_null}}."""
            raw, err=call_gemini(prompt, is_json_output=True)
            if err: logging.error(f"Weather intent fail: {err}"); details.update({"intent_ok": False, "err": f"Intent fail: {err}"})
            else:
                try:
                    weather_intent_clean = raw.strip()
                    if weather_intent_clean.startswith("```json"): weather_intent_clean = weather_intent_clean[7:-3].strip()
                    elif weather_intent_clean.startswith("```"): weather_intent_clean = weather_intent_clean[3:-3].strip()
                    weather_intent_data = json.loads(weather_intent_clean); is_weather=weather_intent_data.get("is_weather_query") is True; weather_loc=weather_intent_data.get("location");
                    if isinstance(weather_loc,str) and not weather_loc.strip(): weather_loc=None
                    details["intent_ok"]=True; logging.info(f"Weather intent: {is_weather}, loc='{weather_loc}'")
                except json.JSONDecodeError as json_err: logging.error(f"Weather intent JSON decode error: {json_err}. Raw: {raw}", exc_info=False); details.update({"intent_ok":False, "err":f"Weather JSON parse error: {json_err}"})
                except Exception as e: logging.exception(f"Unexpected error processing weather intent JSON: {e}"); details.update({"intent_ok":False, "err":f"Weather JSON processing error: {type(e).__name__}"})
        else: details["intent_ok"] = None

        if not is_weather:
            prompt=f"""Analyze the user query: "{question}". Is user asking for directions/route between two locations? If yes, identify Origin & Destination. ONLY JSON: {{"is_routing_query": boolean, "origin": string_or_null, "destination": string_or_null}}"""
            raw, err=call_gemini(prompt, is_json_output=True)
            if not err:
                try:
                    routing_intent_clean = raw.strip();
                    if routing_intent_clean.startswith("```json"): routing_intent_clean = routing_intent_clean[7:-3].strip()
                    elif routing_intent_clean.startswith("```"): routing_intent_clean = routing_intent_clean[3:-3].strip()
                    routing_intent_data = json.loads(routing_intent_clean); is_routing=routing_intent_data.get("is_routing_query") is True; route_origin=routing_intent_data.get("origin"); route_dest=routing_intent_data.get("destination")
                    if isinstance(route_origin,str) and not route_origin.strip(): route_origin=None
                    if isinstance(route_dest,str) and not route_dest.strip(): route_dest=None
                    if is_routing and (not route_origin or not route_dest): is_routing=False; logging.warning("Routing intent but missing origin/dest."); route_origin=None; route_dest=None;
                    details.update({"route_intent":is_routing, "route_origin":route_origin, "route_dest":route_dest}); logging.info(f"Routing intent: {is_routing}, Orig='{route_origin}', Dest='{route_dest}'")
                except json.JSONDecodeError as json_err: logging.error(f"Routing intent JSON decode error: {json_err}. Raw: {raw}", exc_info=False); details.update({"route_intent":False, "err":f"Routing JSON parse error: {json_err}"})
                except Exception as e: logging.exception(f"Unexpected error processing routing intent JSON: {e}"); details.update({"route_intent":False, "err":f"Routing JSON processing error: {type(e).__name__}"})
            else: logging.error(f"Routing intent fail: {err}"); details["err"]=f"Routing intent fail: {err}"

        if is_weather and weather_loc and WEATHER_API_KEY:
             details.update({"type":"weather", "weather_loc":weather_loc, "weather_call":True}); logging.info(f"Calling WeatherAPI: '{weather_loc}'")
             w_data, w_err = get_weather(weather_loc)
             if w_err: details.update({"weather_ok":False, "err":w_err}); logging.error(f"WeatherAPI error: {w_err}"); prompt=f"Friday: Inform user politely of weather lookup issue for '{weather_loc}'. Problem: '{w_err}'. Suggest check location/try later."; resp,_=call_gemini(prompt); final_text=resp or f"Sorry, couldn't get weather for '{weather_loc}': {w_err}"; details["final_src"]="weather_api_err_ai"
             elif w_data:
                 details["weather_ok"]=True
                 try:
                     curr=w_data.get('current',{}); loc=w_data.get('location',{}); name=loc.get('name',weather_loc); full=", ".join(filter(None,[loc.get(k) for k in ['name','region','country']])) or name; lat,lon=loc.get('lat'),loc.get('lon');
                     t_c,t_f=curr.get('temp_c'),curr.get('temp_f'); f_c,f_f=curr.get('feelslike_c'),curr.get('feelslike_f'); hum=curr.get('humidity'); w_k,w_d=curr.get('wind_kph'),curr.get('wind_dir'); cond=curr.get('condition',{}).get('text','N/A');
                     summary=f"Loc:{full}\nTemp:{t_c}°C({t_f}°F)\nFeels:{f_c}°C({f_f}°F)\nCond:{cond}\nHum:{hum}%\nWind:{w_k}kph {w_d}"; logging.info(f"Weather data:\n{summary}")
                     if all(v is not None for v in [t_c,f_c,hum,w_k]): vis_data={"type":"bar", "chart_title":f"Weather: {full}", "labels":["Temp(C)","Feels(C)","Hum(%)","Wind(kph)"], "datasets":[{"label":"Current","data":[t_c,f_c,hum,w_k], "backgroundColor":['#64FFDA99','#40E0D099','#4682B499','#ADD8E699'], "borderColor":['#64FFDA','#40E0D0','#4682B4','#ADD8E6'],"borderWidth":1}]}; logging.info("Prep chart data.")
                     if lat is not None and lon is not None: map_data={"type":"point", "latitude":lat, "longitude":lon, "zoom":11, "marker_title":full}; logging.info(f"Prep map data: {lat},{lon}")
                     prompt=f"You are Friday, reporting current weather. Based *only* on this data:\n---\n{summary}\n---\nProvide a clear, friendly summary. State location ({full}). Include temp (C/F), condition, 'feels like' (C/F). Focus on data. Answer:"; resp, err=call_gemini(prompt)
                     if err: logging.error(f"AI weather format fail: {err}"); final_text=f"Got weather for {full}: {cond}, {t_c}°C ({t_f}°F)."; details.update({"err":err, "final_src":"weather_fallback"})
                     else: final_text=resp; details["final_src"]="weather_ai_gen"
                 except Exception as e: logging.exception("Error processing weather data."); final_text="Found weather data, but trouble processing."; details.update({"weather_ok":False, "err":f"Weather processing error: {type(e).__name__}", "final_src":"weather_proc_err"})

        elif is_routing and route_origin and route_dest:
            details.update({"type":"routing", "route_origin":route_origin, "route_dest":route_dest})
            logging.info(f"Handling routing query: {route_origin} -> {route_dest}")
            origin_coords, origin_err=get_coordinates(route_origin)
            dest_coords, dest_err=get_coordinates(route_dest)
            if origin_err or dest_err:
                 err_msg=f"Origin:{origin_err}" if origin_err else f"Destination:{dest_err}"; logging.error(f"Geocoding failed for routing: {err_msg}"); details["err"]=f"Geocoding Fail: {err_msg}"
                 prompt=f"Friday: User asked route {route_origin}->{route_dest}. Couldn't find coords. Problem:'{err_msg}'. Politely inform user."; final_text,_=call_gemini(prompt); final_text=final_text or f"Sorry, couldn't find location for '{route_origin if origin_err else route_dest}'."; details["final_src"]="routing_geocode_err_ai"
            else:
                 details.update({"origin_coords":list(origin_coords), "dest_coords":list(dest_coords)})
                 map_data={"type":"route", "origin":{"name":route_origin, "coords":list(origin_coords)}, "destination":{"name":route_dest, "coords":list(dest_coords)}}
                 logging.info("Prepared map data for routing points.")
                 prompt = f"""You are Friday. User asked for route: {route_origin} -> {route_dest}. A map showing these locations is being displayed separately. Provide ONLY a very brief introductory text confirming the request, like 'Okay, showing the map for the route from {route_origin} to {route_dest}.' or 'Here are the locations for {route_origin} to {route_dest} on the map.' DO NOT mention any inability to display maps. DO NOT suggest using other map applications. Just the brief intro. Intro Text:"""
                 final_text,_=call_gemini(prompt)
                 final_text=final_text or f"Showing map for {route_origin} to {route_dest}."
                 if len(final_text) > 150: logging.warning("AI generated long intro for route map, using fallback."); final_text = f"Showing map for {route_origin} to {route_dest}."
                 details["final_src"]="routing_map_intro_ai"

        if final_text is None: # Fallback to Search or General AI
            details["search_check"]=True; needed, search_query=False, None
            search_check_prompt=f"""Analyze the user's query. Does answering it likely require searching the internet for current information (today/yesterday), recent events, specific facts (stock prices, scores), or details beyond common knowledge? If the query specifically mentions "GitHub" and a username, try to formulate a search query that might directly land on their repository listing page or a page likely to list some repositories. User Query: "{question}". Respond ONLY with a valid JSON object: {{"search_needed": boolean, "search_query": string_or_null (Example for GitHub: "site:github.com [username] repositories". Otherwise, null.)}}"""
            raw, err=call_gemini(search_check_prompt, is_json_output=True)
            if err: logging.error(f"Search check fail: {err}"); details["err"]=f"Search check fail: {err}"
            else:
                try: search_check_clean = raw.strip()
                    if search_check_clean.startswith("```json"): search_check_clean = search_check_clean[7:-3].strip()
                    elif search_check_clean.startswith("```"): search_check_clean = search_check_clean[3:-3].strip()
                    search_check_data = json.loads(search_check_clean)
                    needed = search_check_data.get("search_needed") is True
                    search_query = search_check_data.get("search_query")
                    if isinstance(search_query, str) and not search_query.strip(): search_query=None
                    details["search_q"]=search_query; logging.info(f"Search check: needed={needed}, query='{search_query}'")
                except json.JSONDecodeError as json_err: logging.error(f"Search check JSON decode error: {json_err}. Raw: {raw}", exc_info=False); details["err"]=f"Search JSON parse error: {json_err}"
                except Exception as e: logging.exception(f"Unexpected error processing search check JSON: {e}"); details["err"]=f"Search JSON processing error: {type(e).__name__}"

            if needed and search_query:
                details.update({"type":"search", "search_call":True}); logging.info(f"Search query: '{search_query}'")
                s_res, s_err=perform_web_search(search_query, num_results=5)
                if s_err: details.update({"search_ok":False, "err":s_err}); logging.error(f"Search function error: {s_err}"); prompt=f"Friday: Inform user politely of technical problem searching web regarding '{search_query}'. Internal error: '{s_err}'. Apologize."; resp,_=call_gemini(prompt); final_text=resp or f"Sorry, tech issue searching: {s_err}"; details["final_src"]="search_func_err_ai"
                else:
                    details["search_ok"]=True;
                    prompt = f"""You are Friday, an AI assistant. The user asked: "{question}" You performed a web search for "{search_query}" and found these results:\n---BEGIN SEARCH RESULTS---\n{s_res if s_res else "No specific results were found for this query via general web search."}\n---END SEARCH RESULTS---\nBased *strictly* on the provided SEARCH RESULTS: 1. Answer the user's original question as directly and accurately as possible. 2. If the query was about finding specific items (like GitHub repository names for a user) and the search results provide *some* names, list the names you found. 3. If the search results mention a *count* of items (e.g., "X repositories") but do not list them all, state the count and mention that the full list wasn't available in the search snippets. 4. If the results are clearly insufficient to answer the specific request (e.g., general GitHub page, but no repo names), state that the search didn't provide the specific details. 5. Prioritize information that appears to be from more official or direct sources within the snippets. 6. Be concise. Avoid conversational filler unless necessary for clarity. Answer:"""
                    resp, err=call_gemini(prompt)
                    if err: logging.error(f"AI search synthesis fail: {err}"); final_text=f"Looked online for '{search_query}' but trouble summarizing."; details.update({"err":err, "final_src":"search_synth_err"})
                    else: final_text=resp; details["final_src"]="search_ai_gen"

            if final_text is None: # General Fallback if search wasn't needed or failed
                logging.info("Handling as general query (ultimate fallback)..."); details["type"]="general"
                prompt=f"You are Friday, providing clear answers. User question: {question}. Answer concisely from general knowledge. Note if info might be dated."
                resp, err=call_gemini(prompt)
                if err: logging.error(f"General AI fail: {err}"); final_text=f"Sorry, issue processing: {err}"; details.update({"err":err, "final_src":"general_ai_err"})
                else: final_text=resp; details["final_src"]="general_ai_gen"

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
    is_debug = os.environ.get('FLASK_DEBUG', '1') == '1'
    cert, key, ssl_ctx, s_type = 'cert.pem', 'key.pem', None, "HTTP"
    if os.path.exists(cert) and os.path.exists(key): ssl_ctx=(cert,key); s_type="HTTPS"; logging.info(f"Certs found ('{cert}', '{key}').")
    else: logging.warning(f"Certs ('{cert}', '{key}') not found. Starting {s_type}. Mic may fail on non-localhost.")
    logging.info(f"Starting Flask Assistant server (Debug: {is_debug}) via {s_type}...")
    try: app.run(host='0.0.0.0', port=5000, debug=is_debug, ssl_context=ssl_ctx, threaded=True)
    except Exception as e: logging.exception(f"Failed to start Flask server: {e}")