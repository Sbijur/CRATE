"""
CRATE backend — built entirely on the OFFICIAL YouTube Data API v3, using
Google's standard "Desktop app" OAuth flow (InstalledAppFlow). This retires
the ytmusicapi / browser-auth / curl-capture workflow completely: no more
DevTools, no more curl.txt, no more refresh_auth.py or auto_refresh_auth.py
— "Sign in with Google" in the app is now the ONLY setup step, and it uses
a real, standard, well-supported OAuth flow rather than the TV-device flow
that kept getting blocked.

--------------------------------------------------------------------------
SETUP (one-time)
--------------------------------------------------------------------------
1. pip install fastapi "uvicorn[standard]" google-auth-oauthlib google-api-python-client google-auth

2. Google Cloud Console (console.cloud.google.com):
   - APIs & Services -> Library -> enable "YouTube Data API v3"
   - APIs & Services -> Credentials -> Create Credentials -> OAuth client ID
     -> Application type: "Desktop app"   <-- IMPORTANT: not "TV" this time
   - Copy the client ID and secret.

3. Store them (either works):
     secrets.local.json:  {"client_id": "...", "client_secret": "..."}
   or environment variables:
     YTM_CLIENT_ID / YTM_CLIENT_SECRET   (names kept for continuity)

4. Run:  uvicorn server:app --port 8000
   Open the app -> Connect YouTube Music -> Sign in with Google.
   A real browser window opens with Google's standard consent screen.

What you get vs. lose compared to the old ytmusicapi setup:
  + Playlists: yes, via playlists.list/playlistItems.list (mine=true)
  + Search: yes, via search.list
  + Sign-in: standard, well-supported OAuth — should just work
  - No backfilled watch history (no official endpoint exists) — CRATE's
    recommendation algorithm already doesn't depend on this.
  - No YouTube-Music-specific "radio"/up-next (no official endpoint exists)
    — the corresponding UI section will simply stay empty, which the
    frontend already handles gracefully.
--------------------------------------------------------------------------
"""

import os
import re
import json
import time
import asyncio
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

FOLDER = Path(__file__).parent
TOKEN_PATH = FOLDER / "google_token.json"
CACHE_PATH = FOLDER / "playlist_cache.json"
SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]

app = FastAPI(title="CRATE / YouTube Data API v3 bridge")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------
# API key check — same as before. REQUIRED once this is reachable from the
# open internet. Set as an env var on whatever host you deploy to:
#   CRATE_API_KEY=some-long-random-string
# This is CRATE's own protection layer and has nothing to do with Google
# sign-in — don't confuse the two.
# --------------------------------------------------------------------------
API_KEY = os.environ.get("CRATE_API_KEY")

@app.middleware("http")
async def check_api_key(request: Request, call_next):
    if API_KEY and request.url.path.startswith("/api/"):
        if request.headers.get("x-crate-key") != API_KEY:
            raise HTTPException(status_code=401, detail="Missing or incorrect x-crate-key header.")
    return await call_next(request)


# --------------------------------------------------------------------------
# Credentials: env vars take priority; falls back to a local gitignored
# file so you don't have to retype them every session.
# --------------------------------------------------------------------------
_local_creds = {}
_creds_path = FOLDER / "secrets.local.json"
if _creds_path.exists():
    try:
        _local_creds = json.loads(_creds_path.read_text())
    except Exception as e:
        print(f"[warn] Couldn't read secrets.local.json ({e}) — ignoring it.")

CLIENT_ID = os.environ.get("YTM_CLIENT_ID") or _local_creds.get("client_id")
CLIENT_SECRET = os.environ.get("YTM_CLIENT_SECRET") or _local_creds.get("client_secret")

youtube = None  # the authenticated googleapiclient service, once signed in


def build_service_from_saved_token():
    """Loads and refreshes a previously-saved token, if one exists."""
    global youtube
    if not TOKEN_PATH.exists():
        return
    try:
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(GoogleAuthRequest())
            TOKEN_PATH.write_text(creds.to_json())
        youtube = build("youtube", "v3", credentials=creds)
        print("[info] Loaded saved Google sign-in — ready.")
    except Exception as e:
        print(f"[info] Saved token exists but couldn't be used ({e}) — sign in again via the app.")


build_service_from_saved_token()


def require_auth():
    if youtube is None:
        raise HTTPException(status_code=503, detail="Not signed in yet — use 'Sign in with Google' in the app.")


# --------------------------------------------------------------------------
# OAuth: real "Sign in with Google" — standard Desktop-app flow. Runs in a
# background thread since it blocks until you finish in the browser.
# --------------------------------------------------------------------------
_oauth_status = {"state": "idle"}  # idle | running | done | error

@app.post("/api/oauth/connect")
def oauth_connect():
    global _oauth_status
    if _oauth_status["state"] == "running":
        return {"status": "running"}
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(
            status_code=400,
            detail="Set YTM_CLIENT_ID and YTM_CLIENT_SECRET (a 'Desktop app' type OAuth client) first, then restart.",
        )

    def run():
        global youtube, _oauth_status
        _oauth_status = {"state": "running"}
        try:
            client_config = {
                "installed": {
                    "client_id": CLIENT_ID,
                    "client_secret": CLIENT_SECRET,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": ["http://localhost"],
                }
            }
            flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
            creds = flow.run_local_server(port=0, open_browser=True)
            TOKEN_PATH.write_text(creds.to_json())
            youtube = build("youtube", "v3", credentials=creds)
            _oauth_status = {"state": "done"}
        except Exception as e:
            _oauth_status = {"state": "error", "detail": str(e)}

    threading.Thread(target=run, daemon=True).start()
    return {"status": "started"}


@app.get("/api/oauth/status")
def oauth_status():
    return _oauth_status


@app.get("/api/ping")
def ping():
    return {"ok": True, "authenticated": youtube is not None}


@app.get("/api/whoami")
def whoami():
    require_auth()
    try:
        resp = youtube.channels().list(part="snippet", mine=True).execute()
        items = resp.get("items", [])
        if items:
            return {"channelTitle": items[0]["snippet"]["title"]}
        return {"channelTitle": None}
    except HttpError as e:
        return {"error": str(e)}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def parse_iso_duration(iso: str) -> int:
    if not iso:
        return 0
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso)
    if not m:
        return 0
    h, mn, s = (int(g) if g else 0 for g in m.groups())
    return h * 3600 + mn * 60 + s


def fetch_durations(video_ids):
    """Batch-fetch durations for up to 50 video IDs at a time."""
    durations = {}
    for i in range(0, len(video_ids), 50):
        chunk = video_ids[i:i + 50]
        try:
            resp = youtube.videos().list(part="contentDetails", id=",".join(chunk)).execute()
            for item in resp.get("items", []):
                durations[item["id"]] = parse_iso_duration(item["contentDetails"]["duration"])
        except HttpError:
            pass
    return durations


def clean_artist(channel_title: str) -> str:
    # Official music uploads are usually on a "<Artist> - Topic" channel.
    if channel_title and channel_title.endswith(" - Topic"):
        return channel_title[: -len(" - Topic")]
    return channel_title or "Unknown artist"


BAD_TITLES = {"deleted video", "private video"}


def normalize_search_item(item, durations):
    vid = item["id"]["videoId"]
    sn = item["snippet"]
    title = sn.get("title", "")
    if title.strip().lower() in BAD_TITLES or not title.strip():
        return None
    artist = clean_artist(sn.get("channelTitle"))
    if artist == "Unknown artist":
        return None
    thumbs = sn.get("thumbnails", {})
    return {
        "videoId": vid,
        "title": title,
        "artist": artist,
        "dur": durations.get(vid, 0),
        "thumbnail": (thumbs.get("medium") or thumbs.get("default") or {}).get("url"),
    }


def normalize_playlist_item(item, durations):
    sn = item["snippet"]
    vid = sn.get("resourceId", {}).get("videoId")
    if not vid:
        return None
    title = sn.get("title", "")
    # Deleted/private videos still show up as placeholder entries in
    # playlistItems.list rather than being omitted — filter them out here
    # instead of showing "Deleted video" / "Unknown artist" as if real.
    if title.strip().lower() in BAD_TITLES or not title.strip():
        return None
    artist = clean_artist(sn.get("videoOwnerChannelTitle"))
    if artist == "Unknown artist":
        return None
    dur = durations.get(vid, 0)
    if dur == 0:
        return None  # deleted/private videos also consistently show 0:00 — extra safety net
    thumbs = sn.get("thumbnails", {})
    return {
        "videoId": vid,
        "title": title,
        "artist": artist,
        "dur": dur,
        "thumbnail": (thumbs.get("medium") or thumbs.get("default") or {}).get("url"),
    }


# --------------------------------------------------------------------------
# Search — real official API, no more scraping
# --------------------------------------------------------------------------

@app.get("/api/search")
def search(q: str = Query(...), limit: int = 12):
    require_auth()
    try:
        # Over-fetch a bit so that after prioritizing clean "Topic" channel
        # uploads (YouTube's auto-generated canonical song entries — the
        # closest thing to an actual "song" vs. general music-category
        # video content like concerts or reaction videos), there's still
        # enough left to fill out the requested count.
        resp = youtube.search().list(
            part="snippet", q=q, type="video", videoCategoryId="10", maxResults=max(limit * 2, 20)
        ).execute()
    except HttpError as e:
        raise HTTPException(status_code=502, detail=f"YouTube search failed: {e}")
    items = resp.get("items", [])
    video_ids = [it["id"]["videoId"] for it in items if it.get("id", {}).get("videoId")]
    durations = fetch_durations(video_ids)

    paired = []  # (normalized, raw) — kept together so filtering can't misalign them
    for it in items:
        if not it.get("id", {}).get("videoId"):
            continue
        normalized = normalize_search_item(it, durations)
        if normalized:
            paired.append((normalized, it))

    def is_topic_channel(raw):
        return raw["snippet"].get("channelTitle", "").endswith(" - Topic")

    topic_items = [n for n, raw in paired if is_topic_channel(raw)]
    other_items = [n for n, raw in paired if not is_topic_channel(raw)]
    return (topic_items + other_items)[:limit]


# --------------------------------------------------------------------------
# History / radio — no official equivalent exists for either. Returning
# empty is intentional, not a bug — the frontend already handles this
# gracefully, and CRATE's recommendation algorithm doesn't depend on
# history anyway (it's built primarily from your playlists).
# --------------------------------------------------------------------------

@app.get("/api/history")
def history():
    return []


@app.get("/api/radio/{video_id}")
def radio(video_id: str, limit: int = 10):
    return []


# --------------------------------------------------------------------------
# Playlists — cached to disk on success, falls back to cache whenever the
# live session is unavailable, refreshable via button or the 24h background
# job below.
# --------------------------------------------------------------------------

def load_cache():
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"playlists": None, "tracks": {}, "last_refreshed": None}


def save_cache(cache):
    try:
        CACHE_PATH.write_text(json.dumps(cache), encoding="utf-8")
    except Exception as e:
        print(f"[warn] Couldn't write playlist_cache.json ({e})")


def fetch_playlist_tracks(playlist_id):
    items = []
    page_token = None
    while True:
        resp = youtube.playlistItems().list(
            part="snippet", playlistId=playlist_id, maxResults=50, pageToken=page_token
        ).execute()
        items.extend(resp.get("items", []))
        page_token = resp.get("nextPageToken")
        if not page_token or len(items) >= 200:
            break
    video_ids = [it["snippet"].get("resourceId", {}).get("videoId") for it in items]
    video_ids = [v for v in video_ids if v]
    durations = fetch_durations(video_ids)
    tracks = [normalize_playlist_item(it, durations) for it in items]
    return [t for t in tracks if t]


def refresh_playlist_cache():
    """Force a full live re-fetch of every playlist. Used by both the
    manual refresh button and the 24h background job."""
    if youtube is None:
        return False, "Not signed in."
    cache = load_cache()
    try:
        resp = youtube.playlists().list(part="snippet", mine=True, maxResults=50).execute()
        playlists_raw = resp.get("items", [])
        playlists = [{"playlistId": p["id"], "title": p["snippet"]["title"]} for p in playlists_raw]
        cache["playlists"] = playlists
    except HttpError as e:
        return False, f"Couldn't fetch playlists: {e}"

    for pl in playlists:
        pid = pl["playlistId"]
        try:
            tracks = fetch_playlist_tracks(pid)
            cache["tracks"][pid] = {"title": pl["title"], "tracks": tracks}
        except HttpError as e:
            print(f"[info] refresh: playlist {pid} failed ({e}) — keeping previous cached version if any.")

    cache["last_refreshed"] = time.time()
    save_cache(cache)
    return True, None


@app.post("/api/refresh")
def refresh():
    ok, err = refresh_playlist_cache()
    if not ok:
        raise HTTPException(status_code=503, detail=err)
    cache = load_cache()
    return {"ok": True, "playlists": cache.get("playlists"), "last_refreshed": cache.get("last_refreshed")}


@app.on_event("startup")
async def start_background_refresh():
    async def loop():
        while True:
            await asyncio.sleep(24 * 60 * 60)
            print("[info] Running scheduled 24h playlist refresh...")
            ok, err = refresh_playlist_cache()
            print(f"[info] Scheduled refresh {'succeeded' if ok else f'failed (will retry in 24h): {err}'}")
    asyncio.create_task(loop())


@app.get("/api/playlists")
def playlists():
    cache = load_cache()
    if youtube is not None:
        try:
            resp = youtube.playlists().list(part="snippet", mine=True, maxResults=50).execute()
            result = [{"playlistId": p["id"], "title": p["snippet"]["title"]} for p in resp.get("items", [])]
            cache["playlists"] = result
            save_cache(cache)
            return result
        except HttpError as e:
            print(f"[info] playlists.list failed ({e}) — falling back to cache if available.")
    if cache.get("playlists") is not None:
        return cache["playlists"]
    raise HTTPException(status_code=503, detail="Not signed in and no cached playlists available yet.")


@app.get("/api/playlist/{playlist_id}")
def playlist(playlist_id: str):
    cache = load_cache()
    if youtube is not None:
        try:
            tracks = fetch_playlist_tracks(playlist_id)
            # Look up the title from the last known playlists list, cache or live
            title = None
            for p in (cache.get("playlists") or []):
                if p["playlistId"] == playlist_id:
                    title = p["title"]
                    break
            result = {"title": title, "tracks": tracks}
            cache["tracks"][playlist_id] = result
            save_cache(cache)
            return result
        except HttpError as e:
            print(f"[info] playlist {playlist_id} failed ({e}) — trying cache.")
    if playlist_id in cache["tracks"]:
        return cache["tracks"][playlist_id]
    return {"title": None, "tracks": []}


# --------------------------------------------------------------------------
# Serve the built frontend from this same process — one command, one
# terminal. Build once (npm run build in crate-frontend), copy dist/ here
# as 'frontend'.
# --------------------------------------------------------------------------
from fastapi.staticfiles import StaticFiles

_frontend_dir = FOLDER / "frontend"
if _frontend_dir.is_dir():
    app.mount("/", StaticFiles(directory=str(_frontend_dir), html=True), name="frontend")
else:
    print(f"[info] No built frontend found at {_frontend_dir} — "
          f"run `npm run build` in crate-frontend and copy dist/ here as 'frontend'.")
