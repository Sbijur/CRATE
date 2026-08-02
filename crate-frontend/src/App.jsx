import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Play, Pause, SkipBack, SkipForward, Heart, Plus, Search,
  Disc3, X, Info, Volume2, ListMusic, Radio, ChevronUp, ChevronDown, RefreshCw
} from "lucide-react";

// Recent lucide-react versions dropped brand/logo icons (Youtube, Github,
// etc.) from the package, so this is a small inline stand-in instead of an
// import — avoids depending on exactly which lucide version is installed.
function YoutubeIcon({ size = 14, className, style }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}
    >
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17" />
      <path d="m10 15 5-3-5-3z" />
    </svg>
  );
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function trackFromApi(t) {
  const localId = "yt-" + t.videoId;
  return {
    id: localId,
    videoId: t.videoId,
    title: t.title || "Untitled",
    artist: t.artist || "Unknown artist",
    dur: t.dur || 0,
    thumbnail: t.thumbnail,
    color: "#7A2F26",
    source: "youtube",
  };
}

/* ------------------------------------------------------------------ */
/* RECOMMENDATION ENGINE — artist affinity, diversified so one crate   */
/* full of a single artist can't dominate the whole list.              */
/* ------------------------------------------------------------------ */
function buildRecommendations(history, crates, liked, allTracks) {
  const resolve = (id) => allTracks[id];
  const recentIds = new Set(history.slice(0, 5).map((h) => h.songId));
  const artistW = {};

  history.slice(0, 20).forEach((h, i) => {
    const s = resolve(h.songId);
    if (!s) return;
    artistW[s.artist] = (artistW[s.artist] || 0) + 1 / (i + 1);
  });

  Object.values(crates).forEach((trackIds) => {
    const uniqueArtists = new Set(trackIds.map((id) => resolve(id)?.artist).filter(Boolean));
    uniqueArtists.forEach((artist) => {
      artistW[artist] = (artistW[artist] || 0) + 0.6;
    });
  });

  const likedArtists = new Set([...liked].map((id) => resolve(id)?.artist).filter(Boolean));
  const candidates = Object.values(allTracks).filter((s) => !recentIds.has(s.id));

  const scored = candidates.map((s) => {
    let score = artistW[s.artist] || 0;
    if (likedArtists.has(s.artist)) score += 1.2;
    score += Math.random() * 0.4;
    return { song: s, score };
  }).sort((a, b) => b.score - a.score);

  const perArtistCount = {};
  const MAX_PER_ARTIST = 2;
  const picked = [];
  for (const item of scored) {
    const a = item.song.artist;
    perArtistCount[a] = perArtistCount[a] || 0;
    if (perArtistCount[a] >= MAX_PER_ARTIST) continue;
    perArtistCount[a]++;
    picked.push(item);
    if (picked.length >= 20) break;
  }
  if (picked.length < 12) {
    for (const item of scored) {
      if (picked.includes(item)) continue;
      picked.push(item);
      if (picked.length >= 20) break;
    }
  }

  const max = Math.max(...picked.map((t) => t.score), 0.001);
  const min = Math.min(...picked.map((t) => t.score), 0);
  const range = max - min || 1;
  const topArtists = Object.entries(artistW).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([a]) => a);
  const hasCrateData = Object.keys(crates).length > 0;

  let reason;
  if (topArtists.length) {
    reason = history.length
      ? `Based on your ${topArtists.join(" & ")} plays`
      : `Based on ${topArtists.join(" & ")} from your playlists`;
  } else if (hasCrateData) {
    reason = "Based on your playlists";
  } else {
    reason = "Search or connect YouTube Music to start shaping recommendations";
  }

  return {
    items: picked.map((t) => ({ ...t.song, match: Math.round(45 + ((t.score - min) / range) * 53) })),
    reason,
  };
}

// Deterministic per-day pick, so it doesn't reshuffle on every reload like
// the jittered Fresh Picks list does.
function pickOfTheDay(allTracks) {
  const pool = Object.values(allTracks);
  if (!pool.length) return null;
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  let hash = 0;
  for (let i = 0; i < dayKey.length; i++) hash = (hash * 31 + dayKey.charCodeAt(i)) >>> 0;
  return pool[hash % pool.length];
}

/* ------------------------------------------------------------------ */

export default function CrateApp() {
  const [history, setHistory] = useState([]);
  // Recommendations deliberately use ONLY this — history you generate by
  // actually using CRATE — not backfilled YouTube history (which is shown
  // in the History tab for reference, but isn't reliable enough or
  // "yours in this app" enough to drive the algorithm). Playlists are the
  // real primary signal; this is the secondary one that builds as you go.
  const [sessionHistory, setSessionHistory] = useState([]);
  const [crates, setCrates] = useState({});
  const [liked, setLiked] = useState(new Set());
  const [nowPlaying, setNowPlaying] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const nowPlayingRef = useRef(null);
  const isPlayingRef = useRef(false);
  useEffect(() => { nowPlayingRef.current = nowPlaying; }, [nowPlaying]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(70);
  const [view, setView] = useState({ type: "home" });
  const [query, setQuery] = useState("");
  const [newCrate, setNewCrate] = useState("");
  const [showNewCrate, setShowNewCrate] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  /* ---------------- YouTube Music integration (via ytmusicapi) ---------------- */
  const [ytServer, setYtServer] = useState(() => {
    try { return localStorage.getItem("crate_yt_server") || ""; } catch { return ""; }
  });
  const [ytApiKey, setYtApiKeyState] = useState(() => {
    try { return localStorage.getItem("crate_yt_key") || ""; } catch { return ""; }
  });
  const [ytServerInput, setYtServerInput] = useState("http://localhost:8000");
  const [ytKeyInput, setYtKeyInput] = useState("");
  const [oauthStatus, setOauthStatus] = useState("idle"); // idle | running | done | error
  const [oauthError, setOauthError] = useState(null);

  // Small fetch wrapper so every request automatically carries the API key
  // (only relevant once this is deployed publicly — harmless locally).
  function apiFetch(path, opts = {}) {
    return fetch(`${ytServer}${path}`, {
      ...opts,
      headers: { ...(opts.headers || {}), "x-crate-key": ytApiKey },
    });
  }
  const [showYtModal, setShowYtModal] = useState(false);
  const [ytTracks, setYtTracks] = useState({});
  const [ytResults, setYtResults] = useState([]);
  const [ytLoading, setYtLoading] = useState(false);
  const [ytError, setYtError] = useState(null);
  const [ytImporting, setYtImporting] = useState(false);

  /* ---------------- real YouTube IFrame Player ---------------- */
  const [everPlayed, setEverPlayed] = useState(false);
  const [ytApiReady, setYtApiReady] = useState(false);
  const [playerMinimized, setPlayerMinimized] = useState(true);
  const [queuePanelOpen, setQueuePanelOpen] = useState(false);
  const [queuePos, setQueuePos] = useState(null); // null = default CSS position; {x,y} once dragged
  const dragStateRef = useRef(null);

  function startDrag(e) {
    const panel = e.currentTarget.closest(".queue-float");
    const rect = panel.getBoundingClientRect();
    dragStateRef.current = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    const onMove = (ev) => {
      if (!dragStateRef.current) return;
      setQueuePos({
        x: Math.max(0, Math.min(window.innerWidth - 340, ev.clientX - dragStateRef.current.offsetX)),
        y: Math.max(0, Math.min(window.innerHeight - 100, ev.clientY - dragStateRef.current.offsetY)),
      });
    };
    const onUp = () => {
      dragStateRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  const playerRef = useRef(null);
  const pendingVideoIdRef = useRef(null);
  const advanceRef = useRef(() => {});

  const resolve = (id) => ytTracks[id];

  // Search
  useEffect(() => {
    if (!ytServer || !query.trim()) { setYtResults([]); setYtError(null); return; }
    setYtLoading(true);
    setYtError(null);
    const handle = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/search?q=${encodeURIComponent(query)}&limit=24`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail || `Server responded ${res.status}`);
        }
        const items = await res.json();
        const fresh = {};
        const order = [];
        items.forEach((it) => {
          const track = trackFromApi(it);
          fresh[track.id] = track;
          order.push(track.id);
        });
        setYtTracks((prev) => ({ ...prev, ...fresh }));
        setYtResults(order);
      } catch (err) {
        setYtError(
          err.message?.includes("Failed to fetch")
            ? "Couldn't reach the local server. Make sure server.py is running (uvicorn server:app --port 8000)."
            : err.message || "Something went wrong reaching the server."
        );
        setYtResults([]);
      } finally {
        setYtLoading(false);
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [query, ytServer]);

  // One-time import on connect: real playlists become crates, real history loads in
  async function importLibrary({ forceRefresh } = {}) {
    setYtImporting(true);
    try {
      const histRes = await apiFetch(`/api/history`);
      if (histRes.ok) {
        const items = await histRes.json();
        const tracks = items.map(trackFromApi);
        if (tracks.length) {
          setYtTracks((prev) => {
            const merged = { ...prev };
            tracks.forEach((t) => (merged[t.id] = t));
            return merged;
          });
          setHistory(tracks.map((t, i) => ({ songId: t.id, at: Date.now() - i * 60000 })));
        }
      }
    } catch { /* best-effort */ }

    try {
      if (forceRefresh) {
        await apiFetch(`/api/refresh`, { method: "POST" }); // forces a live re-fetch server-side before we read it back
      }
      const plRes = await apiFetch(`/api/playlists`);
      if (plRes.ok) {
        const playlists = await plRes.json();
        const newCrates = {};
        const newTracks = {};
        for (const pl of playlists.slice(0, 15)) {
          const pid = pl.playlistId;
          if (!pid) continue;
          try {
            const detRes = await apiFetch(`/api/playlist/${pid}`);
            if (!detRes.ok) continue;
            const detail = await detRes.json();
            const tracks = (detail.tracks || []).map(trackFromApi);
            tracks.forEach((t) => (newTracks[t.id] = t));
            newCrates[detail.title || pl.title || `Playlist`] = tracks.map((t) => t.id);
          } catch { /* skip playlists that fail to load */ }
        }
        setYtTracks((prev) => ({ ...prev, ...newTracks }));
        setCrates((prev) => ({ ...prev, ...newCrates }));
      }
    } catch { /* best-effort */ }

    setYtImporting(false);
  }

  // One-time import on connect: real playlists become crates, real history loads in
  useEffect(() => {
    if (!ytServer) return;
    importLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytServer]);

  function connectYoutube() {
    const url = ytServerInput.trim().replace(/\/$/, "");
    if (!url) return;
    setYtServer(url);
    setYtApiKeyState(ytKeyInput.trim());
    try {
      localStorage.setItem("crate_yt_server", url);
      localStorage.setItem("crate_yt_key", ytKeyInput.trim());
    } catch {}
    setShowYtModal(false);
  }

  async function startGoogleSignIn() {
    const url = ytServerInput.trim().replace(/\/$/, "");
    if (!url) return;
    setOauthStatus("running");
    setOauthError(null);
    const headers = { "x-crate-key": ytKeyInput };
    try {
      const res = await fetch(`${url}/api/oauth/connect`, { method: "POST", headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Server responded ${res.status}`);
      }
    } catch (e) {
      setOauthStatus("error");
      setOauthError(e.message?.includes("Failed to fetch") ? "Couldn't reach the server at that URL." : e.message);
      return;
    }
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`${url}/api/oauth/status`, { headers });
        const data = await r.json();
        if (data.state === "done") {
          clearInterval(poll);
          setOauthStatus("done");
          connectYoutube();
        } else if (data.state === "error") {
          clearInterval(poll);
          setOauthStatus("error");
          setOauthError(data.detail || "Sign-in failed.");
        }
      } catch { /* keep polling — a transient network hiccup shouldn't abort this */ }
    }, 2000);
  }

  function disconnectYoutube() {
    setYtServer("");
    setYtApiKeyState("");
    setYtResults([]);
    setYtRadio([]);
    try {
      localStorage.removeItem("crate_yt_server");
      localStorage.removeItem("crate_yt_key");
    } catch {}
  }

  function goHome() { setView({ type: "home" }); setQuery(""); }
  function goHistory() { setView({ type: "history" }); setQuery(""); }
  function goCrate(name) { setView({ type: "crate", name }); setQuery(""); }

  /* ---------------- recommendations + queue ---------------- */

  // Fresh Picks holds up to 20 tracks and stays completely fixed while you
  // listen — it only regenerates once you've actually played through all
  // 20 of them. Playing something outside the list doesn't count toward
  // emptying it, so idly jumping to unrelated songs won't trigger a reset.
  //
  // Important: history, crates, AND the candidate track pool all need to be
  // frozen snapshots, not live state — every play triggers a radio fetch
  // that grows ytTracks, and if rec depended on live ytTracks it would
  // silently regenerate on every single play even with recsTrigger untouched.
  const sessionHistoryRef = useRef(sessionHistory);
  useEffect(() => { sessionHistoryRef.current = sessionHistory; }, [sessionHistory]);
  const recsHistorySnapshot = useRef([]);
  const recsCratesSnapshot = useRef({});
  const recsTracksSnapshot = useRef({});
  const playedFromListRef = useRef(new Set());
  const [recsTrigger, setRecsTrigger] = useState(0);
  const [recsReady, setRecsReady] = useState(false);

  // Populate the initial snapshot once playlists (the primary signal) or
  // the track pool actually arrive — deliberately does NOT wait on
  // sessionHistory, since playlists alone are enough to start generating
  // real recommendations; session history just refines things as you go.
  useEffect(() => {
    if (recsReady) return;
    if (ytImporting) return; // wait for import to actually finish first
    if (!Object.keys(crates).length && !Object.keys(ytTracks).length) return;
    recsHistorySnapshot.current = sessionHistory;
    recsCratesSnapshot.current = crates;
    recsTracksSnapshot.current = ytTracks;
    setRecsReady(true);
  }, [ytImporting, sessionHistory, crates, ytTracks, recsReady]);

  const rec = useMemo(
    () => buildRecommendations(recsHistorySnapshot.current, recsCratesSnapshot.current, liked, recsTracksSnapshot.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recsTrigger, recsReady, liked]
  );
  useEffect(() => {
    playedFromListRef.current = new Set(); // fresh list -> reset what's been played from it
  }, [rec]);

  function dayKey() {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  }
  const [potdId, setPotdId] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("crate_potd") || "null");
      if (saved && saved.dayKey === dayKey()) return saved.id;
    } catch {}
    return null;
  });
  // Only picks once per day and then freezes — otherwise this would reshuffle
  // every time the radio fetch quietly grows the track pool mid-session.
  useEffect(() => {
    if (potdId && ytTracks[potdId]) return;
    const pick = pickOfTheDay(ytTracks);
    if (!pick) return;
    setPotdId(pick.id);
    try { localStorage.setItem("crate_potd", JSON.stringify({ dayKey: dayKey(), id: pick.id })); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytTracks]);
  const pickOfDay = potdId ? ytTracks[potdId] : null;

  // What plays next follows whichever list you actually pressed play from —
  // a search result, a crate, Fresh Picks, etc. A standalone song (clicked
  // with no list context, e.g. Pick of the Day) instead gets its own
  // auto-generated "radio" queue — and once that exists, playing through
  // it doesn't regenerate it, only clicking something genuinely outside it
  // does.
  //
  // This queue is real React state (not a ref) on purpose: it's both the
  // playback authority (advance() reads it) AND the visible "Up Next"
  // list — a single source of truth, so the two can never drift out of
  // sync with each other the way a ref + separate display state can.
  const [queue, setQueue] = useState([]);         // ordered array of song objects
  const [queueLoading, setQueueLoading] = useState(false);
  const queueRef = useRef([]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  const standaloneRef = useRef(false);
  const stallWatchdogRef = useRef(null);
  const pendingAdvanceRef = useRef(null);

  /* ---------------- playback (real YouTube IFrame Player) ---------------- */

  function playSong(id, contextSongs) {
    const song = resolve(id);
    if (!song) return;
    if (contextSongs && contextSongs.length) {
      setQueue(contextSongs);
      standaloneRef.current = false;
    } else if (queueRef.current.some((s) => s.id === id)) {
      standaloneRef.current = false; // already part of the current queue/radio — leave it exactly as-is
    } else {
      setQueue([song]); // placeholder until the fetch below fills it in
      standaloneRef.current = true; // genuinely new standalone song — generate its own queue
      generateRadioFor(song);
    }
    setNowPlaying(id);
    setProgress(0);
    setDuration(song.dur || 0);
    pendingVideoIdRef.current = song.videoId;
    setEverPlayed(true);
    setHistory((h) => [{ songId: id, at: Date.now() }, ...h.filter((entry) => entry.songId !== id)].slice(0, 40));
    setSessionHistory((h) => [{ songId: id, at: Date.now() }, ...h].slice(0, 60));
    if (playerRef.current && playerRef.current.loadVideoById) {
      playerRef.current.loadVideoById(song.videoId);
    }

    // Watchdog: some tracks (age-restricted content is the classic case)
    // don't fire a proper onError — the player just sits there requiring
    // manual confirmation inside the embed instead. If playback hasn't
    // actually started within a few seconds, treat it as unplayable and
    // skip ahead rather than leaving it stuck.
    if (stallWatchdogRef.current) clearTimeout(stallWatchdogRef.current);
    const watchdogId = id;
    stallWatchdogRef.current = setTimeout(() => {
      if (nowPlayingRef.current === watchdogId && !isPlayingRef.current) {
        console.warn(`Track never started (possibly age-restricted or region-locked) — skipping.`);
        advanceRef.current(1);
      }
    }, 10000);

    // Exhaustion check: only counts plays of tracks that are actually IN
    // the current Fresh Picks list.
    if (rec.items.some((s) => s.id === id)) {
      playedFromListRef.current.add(id);
      if (rec.items.length > 0 && playedFromListRef.current.size >= rec.items.length) {
        recsHistorySnapshot.current = [{ songId: id, at: Date.now() }, ...sessionHistoryRef.current];
        recsCratesSnapshot.current = crates;
        recsTracksSnapshot.current = ytTracks;
        setRecsTrigger((t) => t + 1);
      }
    }
  }

  function generateRadioFor(song) {
    if (!ytServer) return;
    setQueueLoading(true);
    apiFetch(`/api/radio/${song.videoId}?limit=8&artist=${encodeURIComponent(song.artist)}&title=${encodeURIComponent(song.title)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((items) => {
        const tracks = items.map(trackFromApi);
        setYtTracks((prev) => {
          const merged = { ...prev };
          tracks.forEach((t) => (merged[t.id] = t));
          return merged;
        });
        setQueue([song, ...tracks]);
        // If "next" was clicked (or the track ended) before this fetch
        // resolved, that request was deferred instead of wrapping back
        // onto the same song — apply it now that the real queue exists.
        if (pendingAdvanceRef.current != null) {
          const dir = pendingAdvanceRef.current;
          pendingAdvanceRef.current = null;
          advanceRef.current(dir);
        }
      })
      .catch(() => setQueue([song]))
      .finally(() => setQueueLoading(false));
  }

  function advance(dir) {
    const ids = (queueRef.current.length ? queueRef.current : rec.items).map((s) => s.id);
    // While a standalone song's radio is still being generated, the queue
    // is just a one-song placeholder — advancing would mathematically
    // wrap back onto that same song and (worse) permanently mark it as
    // "already queued," disabling radio generation for it entirely.
    // Defer the skip instead of doing that.
    if (ids.length <= 1 && standaloneRef.current) {
      pendingAdvanceRef.current = dir;
      return;
    }
    const idx = ids.indexOf(nowPlaying);

    // Reaching the end of an auto-generated radio queue, going forward —
    // extend it with more results instead of looping back to track 1,
    // the way a real continuous radio does. (Finite lists like a saved
    // crate or Fresh Picks are left to loop normally — only the
    // open-ended standalone radio behaves like this.)
    if (dir === 1 && standaloneRef.current && idx === ids.length - 1 && queueRef.current.length > 1) {
      extendQueue();
      return;
    }

    let next;
    if (idx === -1) next = ids[0];
    else next = ids[(idx + dir + ids.length) % ids.length];
    if (next != null) playSong(next, queueRef.current.length ? queueRef.current : rec.items);
  }

  function extendQueue() {
    const currentQueue = queueRef.current;
    const lastSong = currentQueue[currentQueue.length - 1];
    if (!lastSong || !ytServer) return;
    setQueueLoading(true);
    const existingIds = new Set(currentQueue.map((s) => s.id));
    apiFetch(`/api/radio/${lastSong.videoId}?limit=8&artist=${encodeURIComponent(lastSong.artist)}&title=${encodeURIComponent(lastSong.title)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((items) => {
        const tracks = items.map(trackFromApi).filter((t) => !existingIds.has(t.id));
        if (tracks.length === 0) {
          // Nothing new found — fall back to looping rather than getting stuck.
          const ids = currentQueue.map((s) => s.id);
          if (ids.length) playSong(ids[0], currentQueue);
          return;
        }
        setYtTracks((prev) => {
          const merged = { ...prev };
          tracks.forEach((t) => (merged[t.id] = t));
          return merged;
        });
        const newQueue = [...currentQueue, ...tracks];
        setQueue(newQueue);
        playSong(tracks[0].id, newQueue);
      })
      .catch(() => {
        const ids = currentQueue.map((s) => s.id);
        if (ids.length) playSong(ids[0], currentQueue);
      })
      .finally(() => setQueueLoading(false));
  }
  useEffect(() => { advanceRef.current = advance; });

  // Load the IFrame API once a track has ever been played
  useEffect(() => {
    if (!everPlayed || ytApiReady) return;
    if (window.YT && window.YT.Player) { setYtApiReady(true); return; }
    const prevCb = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { setYtApiReady(true); if (prevCb) prevCb(); };
    if (!document.getElementById("yt-iframe-api-script")) {
      const tag = document.createElement("script");
      tag.id = "yt-iframe-api-script";
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
    }
  }, [everPlayed, ytApiReady]);

  // Create the player once, then control it imperatively from then on
  useEffect(() => {
    if (!ytApiReady || !everPlayed || playerRef.current) return;
    playerRef.current = new window.YT.Player("ytplayer-target", {
      height: "180",
      width: "100%",
      videoId: pendingVideoIdRef.current || undefined,
      playerVars: { autoplay: 1, rel: 0 },
      events: {
        onReady: (e) => { e.target.setVolume(volume); e.target.playVideo(); },
        onStateChange: (e) => {
          const S = window.YT.PlayerState;
          // Any state change at all (buffering, paused, whatever) proves
          // the player is actually alive and responding — cancel the
          // stall watchdog so it doesn't yank away a track that was just
          // slow to buffer, not actually broken.
          if (e.data !== S.UNSTARTED && stallWatchdogRef.current) {
            clearTimeout(stallWatchdogRef.current);
            stallWatchdogRef.current = null;
          }
          if (e.data === S.PLAYING) setIsPlaying(true);
          else if (e.data === S.PAUSED) setIsPlaying(false);
          else if (e.data === S.ENDED) advanceRef.current(1);
        },
        onError: (e) => {
          // Error codes: 2=invalid ID, 5=HTML5 player error, 100=not found/
          // removed/private, 101/150=embedding disabled by the owner.
          // Without this, an unplayable video just sits frozen at 0:00
          // forever — this is exactly that bug. Skip to the next track
          // automatically instead.
          console.warn(`Track unplayable (error ${e.data}) — skipping.`);
          setIsPlaying(false);
          advanceRef.current(1);
        },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytApiReady, everPlayed]);

  // Poll real progress while playing
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => {
      const p = playerRef.current;
      if (p && p.getCurrentTime) {
        setProgress(p.getCurrentTime());
        const d = p.getDuration ? p.getDuration() : 0;
        if (d) setDuration(d);
      }
    }, 500);
    return () => clearInterval(id);
  }, [isPlaying]);

  function togglePlayPause() {
    const p = playerRef.current;
    if (!p) return;
    const state = p.getPlayerState ? p.getPlayerState() : null;
    if (state === 1) p.pauseVideo(); else p.playVideo();
  }

  function seek(e) {
    const p = playerRef.current;
    if (!p || !p.seekTo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const dur = p.getDuration ? p.getDuration() : duration;
    p.seekTo(pct * dur, true);
    setProgress(pct * dur);
  }

  function handleVolume(v) {
    setVolume(v);
    playerRef.current?.setVolume?.(v);
  }

  function toggleLike(id) {
    setLiked((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  function addToCrate(crate, id) {
    setCrates((c) => ({
      ...c,
      [crate]: c[crate].includes(id) ? c[crate] : [...c[crate], id],
    }));
  }

  function createCrate() {
    const name = newCrate.trim();
    if (!name || crates[name]) return;
    setCrates((c) => ({ ...c, [name]: [] }));
    setNewCrate("");
    setShowNewCrate(false);
    goCrate(name);
  }

  const current = nowPlaying != null ? resolve(nowPlaying) : null;
  const ytResultSongs = ytResults.map(resolve).filter(Boolean);
  const crateNames = Object.keys(crates).filter((name) => crates[name].length > 0);

  return (
    <div className="crate-app">
      <style>{CSS}</style>

      <aside className="sidebar">
        <button className="logo" onClick={goHome}>
          <Disc3 size={22} strokeWidth={2.2} />
          <span>CRATE</span>
        </button>
        <div className="side-sub">dig your history. find what's next.</div>

        <nav className="crate-nav">
          <button className={"nav-item" + (view.type === "home" && !query ? " active" : "")} onClick={goHome}>
            <Radio size={15} /> Fresh Picks
          </button>
          <button className={"nav-item" + (view.type === "history" && !query ? " active" : "")} onClick={() => (view.type === "history" && !query ? goHome() : goHistory())}>
            <ListMusic size={15} /> History ({history.length})
          </button>
        </nav>

        <div className="side-label">Your Crates</div>
        <div className="crate-list">
          {crateNames.length === 0 && (
            <div className="crate-empty-hint">
              {ytImporting ? "Importing your playlists…" : "Connect YouTube Music to import your playlists"}
            </div>
          )}
          {crateNames.map((name) => {
            const isOpen = view.type === "crate" && view.name === name && !query;
            return (
              <button
                key={name}
                className={"nav-item" + (isOpen ? " active" : "")}
                onClick={() => (isOpen ? goHome() : goCrate(name))}
              >
                <span className="crate-dot" style={{ background: resolve(crates[name][0])?.color || "#555" }} />
                <span className="crate-name">{name}</span>
                <span className="crate-count">{crates[name].length}</span>
              </button>
            );
          })}
        </div>

        {showNewCrate ? (
          <div className="new-crate-row">
            <input
              autoFocus
              value={newCrate}
              placeholder="Crate name…"
              onChange={(e) => setNewCrate(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createCrate()}
            />
            <button onClick={createCrate}>Add</button>
          </div>
        ) : (
          <button className="new-crate-btn" onClick={() => setShowNewCrate(true)}>
            <Plus size={14} /> New crate
          </button>
        )}

        <div className="side-label">Sources</div>
        {ytServer ? (
          <div className="yt-status">
            <YoutubeIcon size={14} /> YouTube Music connected
            <button className="yt-disconnect" onClick={disconnectYoutube}>disconnect</button>
          </div>
        ) : (
          <button className="yt-connect-btn" onClick={() => setShowYtModal(true)}>
            <YoutubeIcon size={14} /> Connect YouTube Music
          </button>
        )}
        {ytServer && (
          <button className="yt-refresh-btn" onClick={() => importLibrary({ forceRefresh: true })} disabled={ytImporting}>
            <RefreshCw size={13} className={ytImporting ? "spin-icon" : ""} />
            {ytImporting ? "Refreshing…" : "Refresh library"}
          </button>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="search-box">
            <Search size={15} />
            <input
              placeholder="Search YouTube Music…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && <button className="clear-btn" onClick={() => setQuery("")}><X size={14} /></button>}
          </div>
          <button className="info-btn" onClick={() => setShowInfo(true)} title="About the data behind this">
            <Info size={17} />
          </button>
        </header>

        <div className="content">

          {query.trim() ? (
            <Section
              title="Search results"
              sub={
                !ytServer ? "Connect YouTube Music in the sidebar to search"
                : ytLoading ? "Searching…"
                : ytError ? ytError
                : `${ytResultSongs.length} results`
              }
            >
              {ytServer && ytResultSongs.length > 0 && (
                <TrackList songs={ytResultSongs} nowPlaying={nowPlaying} isPlaying={isPlaying} liked={liked} crates={crates} onPlay={playSong} onLike={toggleLike} onAdd={addToCrate} />
              )}
              {ytServer && !ytLoading && !ytError && ytResultSongs.length === 0 && <Empty text="No results." />}
            </Section>
          ) : view.type === "crate" ? (
            <Section title={view.name} sub={`${(crates[view.name] || []).length} tracks`}>
              {(crates[view.name] || []).length === 0 ? (
                <Empty text="This crate is empty. Add tracks from search or Fresh Picks." />
              ) : (
                <TrackList songs={crates[view.name].map(resolve).filter(Boolean)} nowPlaying={nowPlaying} isPlaying={isPlaying} liked={liked} crates={crates} onPlay={(id) => playSong(id, crates[view.name].map(resolve).filter(Boolean))} onLike={toggleLike} onAdd={addToCrate} />
              )}
            </Section>
          ) : view.type === "history" ? (
            <Section title="Listening History" sub="Most recent first">
              {history.length === 0 ? (
                <Empty text="No plays yet — search for something or connect YouTube Music to import your real history." />
              ) : (
                <TrackList songs={history.map((h) => resolve(h.songId)).filter(Boolean)} nowPlaying={nowPlaying} isPlaying={isPlaying} liked={liked} crates={crates} onPlay={playSong} onLike={toggleLike} onAdd={addToCrate} />
              )}
            </Section>
          ) : (
            <>
              {pickOfDay && (
                <Section title="Pick of the Day" sub="One a day, same pick until tomorrow">
                  <div className="potd-card">
                    <div
                      className="potd-art"
                      style={pickOfDay.thumbnail ? { backgroundImage: `url(${pickOfDay.thumbnail})` } : { background: pickOfDay.color }}
                      onClick={() => playSong(pickOfDay.id)}
                    >
                      <button className="potd-play" onClick={() => playSong(pickOfDay.id)}>
                        {isPlaying && nowPlaying === pickOfDay.id ? <Pause size={22} /> : <Play size={22} />}
                      </button>
                    </div>
                    <div className="potd-info">
                      <div className="potd-title">{pickOfDay.title}</div>
                      <div className="potd-artist"><YoutubeIcon size={12} /> {pickOfDay.artist}</div>
                      <div className="potd-actions">
                        <button className="icon-btn" onClick={() => toggleLike(pickOfDay.id)}>
                          <Heart size={16} fill={liked.has(pickOfDay.id) ? "var(--rust)" : "none"} color={liked.has(pickOfDay.id) ? "var(--rust)" : "currentColor"} />
                        </button>
                        <TrackAdd crates={crates} onAdd={(crate) => addToCrate(crate, pickOfDay.id)} />
                      </div>
                    </div>
                  </div>
                </Section>
              )}

              <Section title="Fresh from the crate — radio" sub={rec.reason + ` · ${rec.items.length} tracks, refreshes once you've played through the list`}>
                {rec.items.length === 0 ? (
                  <Empty text="Search for a few songs, or connect YouTube Music, to get personalized picks." />
                ) : (
                  <div className="rec-grid">
                    {rec.items.map((s) => (
                      <RecCard key={s.id} song={s} isPlaying={isPlaying && nowPlaying === s.id} liked={liked.has(s.id)} crates={crates} onPlay={() => playSong(s.id, rec.items)} onLike={() => toggleLike(s.id)} onAdd={(crate) => addToCrate(crate, s.id)} />
                    ))}
                  </div>
                )}
              </Section>

              {crateNames.length > 0 && (
                <Section title="Your Playlists">
                  <div className="crate-row">
                    {crateNames.map((name) => {
                      const cover = resolve(crates[name][0])?.thumbnail;
                      return (
                        <button key={name} className="crate-card" onClick={() => goCrate(name)}>
                          <div className="crate-card-art" style={cover ? { backgroundImage: `url(${cover})` } : {}} />
                          <div className="crate-card-name">{name}</div>
                          <div className="crate-card-count">{crates[name].length} tracks</div>
                        </button>
                      );
                    })}
                  </div>
                </Section>
              )}

              {history.length > 0 && (
                <Section title="Recently played">
                  <div className="hist-strip">
                    {history.slice(0, 10).map((h, i) => {
                      const s = resolve(h.songId);
                      if (!s) return null;
                      return (
                        <button className="hist-chip" key={i} onClick={() => playSong(s.id)}>
                          {s.thumbnail ? <img className="hist-swatch" src={s.thumbnail} alt="" /> : <span className="hist-swatch" style={{ background: s.color }} />}
                          <span className="hist-text"><b>{s.title}</b><em>{s.artist}</em></span>
                        </button>
                      );
                    })}
                  </div>
                </Section>
              )}
            </>
          )}
        </div>
      </main>

      {/* NOW PLAYING DOCK — real player controls */}
      <div className="dock">
        {current ? (
          <>
            <div className="dock-left">
              <img className="dock-art" src={current.thumbnail} alt="" onClick={() => setPlayerMinimized((m) => !m)} title="Show/hide video" />
              <div className="dock-meta">
                <div className="dock-title">{current.title}</div>
                <div className="dock-artist"><YoutubeIcon size={11} /> {current.artist}</div>
              </div>
              <button className="icon-btn" onClick={() => setPlayerMinimized((m) => !m)} title="Show/hide video">
                {playerMinimized ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </button>
              <button className="icon-btn" onClick={() => toggleLike(current.id)}>
                <Heart size={16} fill={liked.has(current.id) ? "var(--rust)" : "none"} color={liked.has(current.id) ? "var(--rust)" : "currentColor"} />
              </button>
            </div>
            <div className="dock-center">
              <div className="transport">
                <button className="icon-btn" onClick={() => advance(-1)}><SkipBack size={17} /></button>
                <button className="play-btn" onClick={togglePlayPause}>
                  {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                </button>
                <button className="icon-btn" onClick={() => advance(1)}><SkipForward size={17} /></button>
              </div>
              <div className="progress-row">
                <span>{fmt(progress)}</span>
                <div className="bar" onClick={seek}>
                  <div className="bar-fill" style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }} />
                </div>
                <span>{fmt(duration || current.dur)}</span>
              </div>
            </div>
            <div className="dock-right">
              {queue.length > 1 && (
                <button
                  className={"icon-btn" + (queuePanelOpen ? " active-toggle" : "")}
                  onClick={() => setQueuePanelOpen((o) => !o)}
                  title="Up next"
                >
                  <ListMusic size={16} />
                  <span className="queue-badge">{queue.length}</span>
                </button>
              )}
              <Volume2 size={15} />
              <input type="range" min="0" max="100" value={volume} onChange={(e) => handleVolume(+e.target.value)} />
            </div>
          </>
        ) : (
          <div className="dock-empty">Drop a needle — pick a track to start listening</div>
        )}
      </div>

      {/* Persistent player — never unmounted once created, so minimizing never stops audio */}
      {everPlayed && (
        <div className={"yt-float" + (playerMinimized ? " minimized" : "")}>
          {!playerMinimized && (
            <button className="yt-float-head" onClick={() => setPlayerMinimized(true)}>
              <span><YoutubeIcon size={13} /> {current ? current.title : "YouTube player"}</span>
              <ChevronDown size={14} />
            </button>
          )}
          <div className="yt-target-wrap">
            <div id="ytplayer-target" />
          </div>
        </div>
      )}

      {/* Collapsible "Up Next" panel — a small floating window, not an
          inline section, so it never blocks navigating to other views
          underneath it. Closed by default; opened via the queue button
          in the play bar. */}
      {queuePanelOpen && current && queue.length > 1 && (
        <div
          className="queue-float"
          style={queuePos ? { left: queuePos.x, top: queuePos.y, right: "auto", bottom: "auto" } : undefined}
        >
          <div className="queue-float-head" onMouseDown={startDrag}>
            <span>
              <ListMusic size={13} />
              {queueLoading ? "Finding more like this…"
                : standaloneRef.current ? `Generated for “${current.title}”`
                : "Up next"}
            </span>
            <button onClick={() => setQueuePanelOpen(false)}><X size={14} /></button>
          </div>
          <div className="queue-float-body">
            <TrackList
              songs={queue}
              nowPlaying={nowPlaying}
              isPlaying={isPlaying}
              liked={liked}
              crates={crates}
              onPlay={(id) => playSong(id, queue)}
              onLike={toggleLike}
              onAdd={addToCrate}
            />
          </div>
        </div>
      )}

      {showInfo && (
        <div className="modal-back" onClick={() => setShowInfo(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowInfo(false)}><X size={16} /></button>
            <h3>How this works</h3>
            <p>
              Search and playlists-as-crates come from the official YouTube
              Data API v3, via a real Google sign-in (standard OAuth) —
              no browser cookie tricks, no DevTools. Playback uses the real
              YouTube IFrame Player API, which is what makes auto-advance,
              real progress, and volume control possible.
            </p>
            <p>
              "Fresh from the crate" is CRATE's own radio — ranked by artist
              affinity, built primarily from your real playlists, plus a
              secondary boost from history you generate by actually using
              CRATE itself. Picks are capped per artist so one big playlist
              can't dominate, and it keeps playing automatically, track
              after track. "Pick of the Day" is a stable daily pick from
              everything CRATE knows about, so it doesn't reshuffle every
              time you reload. There's no official equivalent to YouTube
              Music's own "radio" feature, so that layer isn't available —
              recommendations here are entirely CRATE's own.
            </p>
          </div>
        </div>
      )}

      {showYtModal && (
        <div className="modal-back" onClick={() => setShowYtModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowYtModal(false)}><X size={16} /></button>
            <h3><YoutubeIcon size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />Connect YouTube Music</h3>
            <p>Built on the official YouTube Data API — first, point this app at where server.py is running:</p>
            <div className="yt-key-row">
              <input autoFocus placeholder="http://localhost:8000" value={ytServerInput} onChange={(e) => setYtServerInput(e.target.value)} />
            </div>

            <p style={{ marginTop: 18 }}>
              Sign in with a real Google account — standard OAuth, the same kind any normal app uses. Requires the
              server to have <code>YTM_CLIENT_ID</code> / <code>YTM_CLIENT_SECRET</code> set (one-time, from a
              "Desktop app" type OAuth client), and only works when the server runs on this same machine, since it
              opens your browser there.
            </p>
            <button
              className="google-signin-btn"
              onClick={startGoogleSignIn}
              disabled={oauthStatus === "running"}
            >
              <YoutubeIcon size={14} />
              {oauthStatus === "running" ? "Waiting for sign-in to finish…" : "Sign in with Google"}
            </button>
            {oauthStatus === "running" && (
              <p style={{ fontSize: 11.5, color: "var(--sage)" }}>
                A browser window should have opened on the server's machine — finish signing in there. This page will
                connect automatically once you're done.
              </p>
            )}
            {oauthStatus === "error" && (
              <p style={{ fontSize: 11.5, color: "var(--rust)" }}>{oauthError}</p>
            )}
            {oauthStatus === "done" && (
              <p style={{ fontSize: 11.5, color: "var(--sage)" }}>Signed in — connecting…</p>
            )}

            <p style={{ marginTop: 18, fontSize: 11.5, opacity: 0.75 }}>
              Already signed in on the server another way, or deploying this publicly? Enter its app password (set
              via <code>CRATE_API_KEY</code> — unrelated to your Google sign-in) and connect directly:
            </p>
            <div className="yt-key-row">
              <input placeholder="App password (only needed if deployed publicly)" value={ytKeyInput} onChange={(e) => setYtKeyInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connectYoutube()} />
              <button onClick={connectYoutube}>Connect</button>
            </div>
            <p style={{ fontSize: 11.5, opacity: 0.75 }}>
              On connect, your library playlists import as crates automatically —
              this can take a few seconds depending on how many you have. Once
              connected, this stays remembered across page reloads (as long
              as the server is still running).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Section({ title, sub, children }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({ text }) {
  return <div className="empty">{text}</div>;
}

function RecCard({ song, isPlaying, liked, crates, onPlay, onLike, onAdd }) {
  const [openAdd, setOpenAdd] = useState(false);
  const artStyle = song.thumbnail
    ? { backgroundImage: `linear-gradient(0deg, rgba(20,17,13,0.55), rgba(20,17,13,0.05)), url(${song.thumbnail})`, backgroundSize: "cover", backgroundPosition: "center" }
    : { background: `linear-gradient(150deg, ${song.color}, #14110D)` };
  return (
    <div className="rec-card">
      <div className="rec-art" style={artStyle}>
        <div className="match-ring" style={{ "--pct": song.match }}><span>{song.match}%</span></div>
        <button className="rec-play" onClick={onPlay}>{isPlaying ? <Pause size={18} /> : <Play size={18} />}</button>
      </div>
      <div className="rec-info">
        <div className="rec-title">{song.title}</div>
        <div className="rec-artist"><YoutubeIcon size={11} /> {song.artist}</div>
        <div className="rec-tags"><span>{fmt(song.dur)}</span></div>
      </div>
      <div className="rec-actions">
        <button className="icon-btn small" onClick={onLike}>
          <Heart size={14} fill={liked ? "var(--rust)" : "none"} color={liked ? "var(--rust)" : "currentColor"} />
        </button>
        <div className="add-wrap">
          <button className="icon-btn small" onClick={() => setOpenAdd((o) => !o)}><Plus size={14} /></button>
          {openAdd && (
            <div className="add-menu">
              {Object.keys(crates).filter((n) => crates[n].length > 0).length === 0 && <div className="add-menu-empty">No crates yet</div>}
              {Object.keys(crates).filter((n) => crates[n].length > 0).map((name) => <button key={name} onClick={() => { onAdd(name); setOpenAdd(false); }}>{name}</button>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TrackList({ songs, nowPlaying, isPlaying, liked, crates, onPlay, onLike, onAdd }) {
  return (
    <div className="track-list">
      {songs.map((s, i) => (
        <div className={"track-row" + (nowPlaying === s.id ? " active" : "")} key={s.id + "-" + i}>
          <button className="track-play" onClick={() => onPlay(s.id)}>
            {nowPlaying === s.id && isPlaying ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <span className="track-swatch" style={{ background: s.color }}>{s.thumbnail && <img src={s.thumbnail} alt="" />}</span>
          <div className="track-meta">
            <div className="track-title">{s.title} <YoutubeIcon size={11} className="yt-badge" /></div>
            <div className="track-artist">{s.artist}</div>
          </div>
          <span className="track-dur">{s.dur ? fmt(s.dur) : "—"}</span>
          <button className="icon-btn small" onClick={() => onLike(s.id)}>
            <Heart size={14} fill={liked.has(s.id) ? "var(--rust)" : "none"} color={liked.has(s.id) ? "var(--rust)" : "currentColor"} />
          </button>
          <TrackAdd crates={crates} onAdd={(crate) => onAdd(crate, s.id)} />
        </div>
      ))}
    </div>
  );
}

function TrackAdd({ crates, onAdd }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="add-wrap">
      <button className="icon-btn small" onClick={() => setOpen((o) => !o)}><Plus size={14} /></button>
      {open && (
        <div className="add-menu">
          {Object.keys(crates).filter((n) => crates[n].length > 0).length === 0 && <div className="add-menu-empty">No crates yet</div>}
          {Object.keys(crates).filter((n) => crates[n].length > 0).map((name) => <button key={name} onClick={() => { onAdd(name); setOpen(false); }}>{name}</button>)}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
const CSS = `
html, body, #root { margin: 0 !important; padding: 0 !important; width: 100% !important; max-width: none !important; height: 100% !important; }
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600&display=swap');

.crate-app {
  --bg: #17130F; --surface: #1F1A15; --surface2: #291F19; --border: #3A2E23;
  --text: #F2E9DC; --text-dim: #A8998A;
  --gold: #E3A63E; --sage: #7A9B7E; --rust: #BD5B3A; --ytred: #E1483C;
  font-family: 'Inter', sans-serif;
  background: var(--bg); color: var(--text);
  display: grid; grid-template-columns: 240px 1fr; grid-template-rows: 1fr auto;
  height: 100vh; width: 100%; min-height: 640px; overflow: hidden; position: relative;
}
.crate-app * { box-sizing: border-box; }
.crate-app button { font-family: inherit; cursor: pointer; background: none; border: none; color: inherit; }
.crate-app input { font-family: inherit; }

.sidebar { grid-row: 1/2; background: var(--surface); border-right: 1px solid var(--border); padding: 20px 14px; display: flex; flex-direction: column; overflow-y: auto; }
.logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 21px; letter-spacing: 0.5px; }
.crate-app .logo { font-family: 'Fraunces', serif; color: var(--gold); }
.logo:hover { opacity: 0.85; }
.side-sub { font-size: 11px; color: var(--text-dim); margin: 4px 0 22px 30px; font-style: italic; }
.crate-nav, .crate-list { display: flex; flex-direction: column; gap: 2px; }
.side-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); margin: 20px 10px 6px; }
.nav-item { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: 7px; font-size: 13.5px; text-align: left; }
.nav-item:hover { background: var(--surface2); }
.nav-item.active { background: var(--surface2); color: var(--gold); }
.crate-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.crate-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crate-count { margin-left: auto; font-family: 'Space Mono', monospace; font-size: 11px; color: var(--text-dim); flex-shrink: 0; }
.crate-empty-hint { font-size: 11.5px; color: var(--text-dim); padding: 6px 10px; line-height: 1.4; }
.new-crate-btn { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-dim); padding: 9px 10px; margin-top: 8px; border: 1px dashed var(--border); border-radius: 7px; }
.new-crate-btn:hover { color: var(--gold); border-color: var(--gold); }
.new-crate-row { display: flex; gap: 6px; margin-top: 8px; }
.new-crate-row input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 7px 8px; color: var(--text); font-size: 12.5px; }
.new-crate-row button { background: var(--gold); color: #17130F; font-weight: 600; font-size: 12px; padding: 0 10px; border-radius: 6px; }

.yt-connect-btn { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--text-dim); padding: 9px 10px; border: 1px dashed var(--border); border-radius: 7px; }
.yt-connect-btn:hover { color: var(--ytred); border-color: var(--ytred); }
.yt-status { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--sage); padding: 9px 10px; flex-wrap: wrap; }
.yt-disconnect { margin-left: auto; font-size: 10.5px; color: var(--text-dim); text-decoration: underline; }
.yt-disconnect:hover { color: var(--rust); }
.yt-refresh-btn { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-dim); padding: 7px 10px; }
.yt-refresh-btn:hover:not(:disabled) { color: var(--gold); }
.yt-refresh-btn:disabled { opacity: 0.6; cursor: default; }
.spin-icon { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.main { display: flex; flex-direction: column; overflow: hidden; }
.topbar { display: flex; align-items: center; gap: 12px; padding: 16px 28px; border-bottom: 1px solid var(--border); }
.search-box { display: flex; align-items: center; gap: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; flex: 1; max-width: 420px; color: var(--text-dim); }
.search-box input { background: none; border: none; outline: none; color: var(--text); font-size: 13.5px; width: 100%; }
.clear-btn { color: var(--text-dim); flex-shrink: 0; }
.clear-btn:hover { color: var(--text); }
.info-btn { margin-left: auto; color: var(--text-dim); padding: 6px; border-radius: 6px; }
.info-btn:hover { color: var(--gold); background: var(--surface); }

.content { overflow-y: auto; padding: 24px 28px 40px; flex: 1; }
.section { margin-bottom: 34px; }
.section-head h2 { font-family: 'Fraunces', serif; font-size: 20px; font-weight: 700; margin: 0 0 2px; }
.section-head p { font-size: 12.5px; color: var(--text-dim); margin: 0 0 14px; }
.empty { color: var(--text-dim); font-size: 13px; padding: 30px 0; text-align: center; border: 1px dashed var(--border); border-radius: 10px; }

.potd-card { display: flex; gap: 18px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 16px; align-items: center; }
.potd-art { position: relative; width: 110px; height: 110px; border-radius: 10px; background-size: cover; background-position: center; flex-shrink: 0; cursor: pointer; }
.potd-play { position: absolute; inset: 0; margin: auto; width: 44px; height: 44px; background: rgba(23,19,15,0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
.potd-art:hover .potd-play { opacity: 1; }
.potd-title { font-family: 'Fraunces', serif; font-size: 19px; font-weight: 700; }
.potd-artist { font-size: 13px; color: var(--text-dim); display: flex; align-items: center; gap: 5px; margin-top: 4px; }
.potd-artist svg { color: var(--ytred); }
.potd-actions { display: flex; gap: 4px; margin-top: 10px; }

.rec-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 16px; }
.rec-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; transition: transform .15s ease, border-color .15s ease; }
.rec-card:hover { transform: translateY(-2px); border-color: var(--gold); }
.rec-art { position: relative; aspect-ratio: 1; display: flex; align-items: flex-end; justify-content: flex-start; padding: 10px; }
.rec-play { position: absolute; inset: 0; margin: auto; width: 40px; height: 40px; background: rgba(23,19,15,0.55); backdrop-filter: blur(2px); border-radius: 50%; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity .15s; }
.rec-art:hover .rec-play { opacity: 1; }
.match-ring { width: 40px; height: 40px; border-radius: 50%; background: conic-gradient(var(--sage) calc(var(--pct) * 1%), rgba(0,0,0,0.35) 0); display: flex; align-items: center; justify-content: center; }
.match-ring span { background: #17130F; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-family: 'Space Mono', monospace; font-size: 10px; color: var(--sage); }
.rec-info { padding: 10px 12px 4px; }
.rec-title { font-size: 13.5px; font-weight: 600; line-height: 1.25; }
.rec-artist { font-size: 12px; color: var(--text-dim); margin-top: 1px; display: flex; align-items: center; gap: 4px; }
.rec-artist svg { color: var(--ytred); flex-shrink: 0; }
.rec-tags { font-size: 10.5px; color: var(--text-dim); margin-top: 6px; font-family: 'Space Mono', monospace; }
.rec-actions { display: flex; align-items: center; gap: 4px; padding: 6px 8px 10px; margin-top: auto; }

.crate-row { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 4px; }
.crate-card { flex-shrink: 0; width: 150px; text-align: left; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px; transition: border-color .15s; }
.crate-card:hover { border-color: var(--gold); }
.crate-card-art { width: 100%; aspect-ratio: 1; border-radius: 7px; background: linear-gradient(150deg, var(--surface2), var(--bg)); background-size: cover; background-position: center; margin-bottom: 8px; }
.crate-card-name { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crate-card-count { font-size: 11px; color: var(--text-dim); font-family: 'Space Mono', monospace; margin-top: 2px; }

.hist-strip { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; }
.hist-chip { display: flex; align-items: center; gap: 9px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px; min-width: 190px; flex-shrink: 0; text-align: left; }
.hist-chip:hover { border-color: var(--gold); }
.hist-swatch { width: 30px; height: 30px; border-radius: 6px; flex-shrink: 0; object-fit: cover; }
.hist-text { display: flex; flex-direction: column; overflow: hidden; }
.hist-text b { font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hist-text em { font-size: 11px; color: var(--text-dim); font-style: normal; }

.track-list { display: flex; flex-direction: column; border-top: 1px solid var(--border); }
.track-row { display: flex; align-items: center; gap: 12px; padding: 9px 6px; border-bottom: 1px solid var(--border); }
.track-row.active .track-title { color: var(--gold); }
.track-play { width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.track-row:hover .track-play { border-color: var(--gold); color: var(--gold); }
.track-swatch { width: 34px; height: 34px; border-radius: 6px; flex-shrink: 0; position: relative; overflow: hidden; }
.track-swatch img { width: 100%; height: 100%; object-fit: cover; }
.track-meta { min-width: 0; flex: 1; }
.track-title { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 5px; }
.yt-badge { color: var(--ytred); flex-shrink: 0; }
.track-artist { font-size: 11.5px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.track-dur { font-family: 'Space Mono', monospace; font-size: 11.5px; color: var(--text-dim); flex-shrink: 0; }

.icon-btn { padding: 6px; border-radius: 50%; color: var(--text-dim); display: flex; }
.icon-btn:hover { color: var(--text); background: var(--surface2); }
.icon-btn.small { padding: 5px; }

.add-wrap { position: relative; }
.add-menu { position: absolute; right: 0; top: 100%; margin-top: 4px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; padding: 4px; z-index: 10; min-width: 150px; box-shadow: 0 8px 20px rgba(0,0,0,0.4); }
.add-menu button { display: block; width: 100%; text-align: left; padding: 7px 9px; font-size: 12px; border-radius: 5px; }
.add-menu button:hover { background: var(--bg); color: var(--gold); }
.add-menu-empty { font-size: 11.5px; color: var(--text-dim); padding: 6px 9px; }

.dock { grid-column: 1/3; grid-row: 2/3; background: var(--surface); border-top: 1px solid var(--border); display: flex; align-items: center; padding: 10px 22px; gap: 26px; min-height: 74px; }
.dock-empty { color: var(--text-dim); font-size: 12.5px; margin: auto; }
.dock-left { display: flex; align-items: center; gap: 12px; width: 260px; flex-shrink: 0; }
.dock-art { width: 46px; height: 46px; border-radius: 8px; object-fit: cover; flex-shrink: 0; cursor: pointer; }
.dock-meta { min-width: 0; }
.dock-title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dock-artist { font-size: 11.5px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 4px; }
.dock-artist svg { color: var(--ytred); }
.dock-center { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; max-width: 480px; margin: 0 auto; }
.transport { display: flex; align-items: center; gap: 14px; }
.play-btn { width: 34px; height: 34px; border-radius: 50%; background: var(--gold); color: #17130F; display: flex; align-items: center; justify-content: center; }
.play-btn:hover { transform: scale(1.05); }
.progress-row { display: flex; align-items: center; gap: 8px; width: 100%; font-family: 'Space Mono', monospace; font-size: 10.5px; color: var(--text-dim); }
.bar { flex: 1; height: 4px; background: var(--border); border-radius: 2px; cursor: pointer; }
.bar-fill { height: 100%; background: var(--gold); border-radius: 2px; }
.dock-right { display: flex; align-items: center; gap: 8px; width: 140px; flex-shrink: 0; justify-content: flex-end; color: var(--text-dim); }
.dock-right input { accent-color: var(--gold); }

.yt-float { position: fixed; right: 24px; bottom: 92px; width: 320px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 12px 30px rgba(0,0,0,0.5); z-index: 40; transition: opacity .15s ease; }
.yt-float.minimized { opacity: 0; pointer-events: none; width: 0; height: 0; border: none; box-shadow: none; }
.yt-float-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; font-size: 11.5px; gap: 8px; width: 100%; text-align: left; }
.yt-float-head span { display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.yt-float-head svg:first-child { color: var(--ytred); flex-shrink: 0; }
.yt-target-wrap { height: 180px; overflow: hidden; }
.yt-float.minimized .yt-target-wrap { height: 0; }

.queue-float { position: fixed; left: 24px; bottom: 92px; width: 340px; max-height: 70vh; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; box-shadow: 0 12px 30px rgba(0,0,0,0.5); z-index: 40; display: flex; flex-direction: column; }
.queue-float-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; font-size: 12px; font-weight: 600; gap: 8px; border-bottom: 1px solid var(--border); flex-shrink: 0; cursor: move; user-select: none; }
.queue-float-head span { display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; color: var(--gold); }
.queue-float-head button { color: var(--text-dim); flex-shrink: 0; }
.queue-float-head button:hover { color: var(--text); }
.queue-float-body { overflow-y: auto; padding: 4px 10px; }
.queue-badge { position: absolute; top: 2px; right: 2px; background: var(--gold); color: #17130F; font-size: 9px; font-weight: 700; border-radius: 8px; min-width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; padding: 0 3px; font-family: 'Space Mono', monospace; }
.icon-btn { position: relative; }
.icon-btn.active-toggle { color: var(--gold); background: var(--surface2); }

.modal-back { position: fixed; inset: 0; background: rgba(10,8,6,0.6); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 26px 26px 22px; max-width: 440px; position: relative; }
.modal h3 { font-family: 'Fraunces', serif; margin: 0 0 12px; font-size: 18px; color: var(--gold); display: flex; align-items: center; }
.modal p { font-size: 13px; line-height: 1.55; color: var(--text-dim); margin: 0 0 12px; }
.modal code { background: var(--bg); padding: 1px 5px; border-radius: 4px; font-family: 'Space Mono', monospace; font-size: 12px; color: var(--sage); }
.modal-close { position: absolute; top: 14px; right: 14px; color: var(--text-dim); }
.modal-close:hover { color: var(--text); }
.yt-key-row { display: flex; gap: 8px; margin-bottom: 12px; }
.yt-key-row input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; color: var(--text); font-size: 12.5px; font-family: 'Space Mono', monospace; }
.yt-key-row button { background: var(--ytred); color: #fff; font-weight: 600; font-size: 12px; padding: 0 14px; border-radius: 6px; }
.google-signin-btn { display: flex; align-items: center; gap: 8px; justify-content: center; width: 100%; background: var(--gold); color: #17130F; font-weight: 700; font-size: 13px; padding: 10px 0; border-radius: 8px; margin: 8px 0 6px; }
.google-signin-btn:hover { opacity: 0.9; }
.google-signin-btn:disabled { opacity: 0.6; cursor: default; }
`;
