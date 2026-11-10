const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'lc-live-2026';
const VIDEOS_DIR = '/tmp/videos';
const DATA_DIR = fs.existsSync('/data') ? '/data' : VIDEOS_DIR;
const OVERLAY_NAME = process.env.OVERLAY_NAME || '';
const OVERLAY_RAW_PATH = path.join(DATA_DIR, 'overlay_raw.img');
const OVERLAY_SCALED_PATH = path.join(DATA_DIR, 'overlay_scaled.png');
const OVERLAY_TOP_PATH = path.join(DATA_DIR, 'overlay_top.jpg');
const OVERLAY_BOT_PATH = path.join(DATA_DIR, 'overlay_bottom.jpg');
const SUBTITLE_PATH = path.join(VIDEOS_DIR, 'current_subtitles.srt');
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const VIDEO_HISTORY_PATH = path.join(DATA_DIR, 'video_history.json');
const STREAM_DEFAULTS_PATH = path.join(DATA_DIR, 'stream_defaults.json');